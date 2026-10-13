/**
 * dsh-usage-tab — 浏览器半边（P1：tab 界面 + 本会话真实数据）
 * ============================================================================
 *
 * ⚠️ 本文件是**手写产物**，不是 esbuild 输出（零构建路线）。
 *    判定依据：本机 profile 环境里 esbuild 解析探测
 *    5 条路径全部 MODULE_NOT_FOUND，且 profile/node_modules/.pnpm、PATH、
 *    npm 全局都没有 esbuild ⇒ 不走 bundles/TS 构建，直接手写 ModuleLoader 外壳。
 *
 * 外壳契约（逐字对照 dsh-context/lib/client.js:1-5 与
 * 同类插件客户端的写法）：
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} })
 *   - `id` **必须是包名本身** —— 浏览器侧按 `this.graphRows.get(id)` 找依赖行；
 *     写成别的字符串 ⇒ 解析不到、加载失败。
 *   - 惰性 CJS：执行 bundle 只注册工厂，factory 的函数体（含 CSS 注入）在
 *     materialization 时才跑（dsh-client-modules/lib/index.js:16-23）。
 *   - react 必须走 shell 单例（require("react") 由 seed 表解析），不能内联第二份
 *     React 实例，否则 slots 渲染会崩。
 *
 * 数据只来自本会话三条现成通道（**不碰宿主日志、不扫盘、不读 session_projcache**）：
 *   A) props.useProjection("sessionStats")        → 全日志累计 turns/steps/llmMs/...
 *   B) props.useChat(s => s.legacy.turnTimings)   → Map<turn, {startTime, endTime?}>
 *   C) props.useChat(s => s.timeline)             → turns[].steps[].start.time
 * 字段出处以宿主包的类型声明为准。
 *
 * 分区：
 *   §1 常量与字典   §2 样式与注入   §3 纯函数核心（可自测）
 *   §4 模型构建     §5 渲染         §6 apply / 导出（含 __test 出口）
 *
 * ── 二级菜单（P1.1，2026-09-25）─────────────────────────────────────────────
 *   tab 内容顶部一条 4 分段导航（概览 / 日历 / 会话 / 设置），下面是**当前分段的正文**：
 *   · 概览 = P1 原有四张卡（**默认选中**，渲染逻辑一字未动）；
 *   · 日历 / 会话 = **骨架 + 空态**，卡面明标「P2 接宿主级全历史数据后填充」，值一律 `—`；
 *   · 设置 = 三项可改偏好（空闲阈值 / 时区 / 数据范围）+ 口径说明（复用 source.note）。
 *   偏好落 `localStorage["dsh-usage-tab.prefs"]`；**读 / 解析 / 写任一失败都静默回退默认值**
 *   （5 分钟 / Asia/Shanghai / 本会话），绝不把异常抛进渲染 —— 见 §3 的
 *   normalizePrefs / parsePrefs / readPrefs / writePrefs。
 *   空闲阈值**真的进模型**（`idleMsOf(prefs)` → buildModel 的 idleMs）：改它，概览的
 *   活跃段 / 空闲率立刻跟着变。时区与「全历史」范围要宿主级数据，属 P2。
 */

window.__ModuleLoader__.load({
  id: "dsh-usage-tab",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var react = require("react");

    //#region §1 常量与字典

    var NS = "dsh-usage-tab";

    /** 空闲阈值：相邻事件间隔 > 5 分钟 ⇒ 视为断开，算新的一段。（规格硬要求） */
    var IDLE_THRESHOLD_MS = 5 * 60 * 1000;

    /** 每轮用时排行的展示条数。 */
    var RANK_LIMIT = 5;
    /** 步骤级甘特最多画多少步（2026-10-14 按需求加的"每步一根"）—— 步数动辄几百，全画会撑爆。 */
    var STEP_GANTT_LIMIT = 60;

    /** 甘特条 / 排行条的最小可见宽度（百分比）。 */
    var MIN_BAR_PCT = 0.6;

    /** 数据缺失的占位符：界面上一律显示这个，绝不许印 NaN / undefined。 */
    var EM_DASH = "\u2014";

    // —— P2 第一步：宿主投影（会话列表行自带）——
    /**
     * 宿主侧投影键。宿主折「逐日活跃毫秒 + 会话总量」，
     * 随 `session.list` 每一行的 `projectionValues` 下发（零额外 I/O）。
     * 数据通路：会话列表行自带的投影值。
     */
    var USAGE_DAILY_KEY = "usageDaily";
    /** 日历热力图窗口：近 12 周（84 天，含今天）。 */
    var CALENDAR_HEAT_DAYS = 84;
    /** A6 工作区趋势：近多少周（12 周 ≈ 一个季度）；最多列几个工作区（其余截断并在卡面写明）。 */
    var WS_TREND_WEEKS = 12;
    var WS_TREND_LIMIT = 6;
    /** 日历柱状窗口：近 14 天（含今天）。 */
    var CALENDAR_BAR_DAYS = 14;

    // —— P2 第三步：「会话」页（跨会话清单的首个样板）——
    /**
     * 三个视图：**主轴不同**，不是同一张图的配色变体。
     *   a = 按工作区分组的纵向表 + 行内比例条（默认）—— 回答"时间花在哪个项目上"
     *   b = 逐日活动带 —— 回答"哪几天在动、动得多不多"
     *   c = 主从双栏 —— 锁定一个会话，看它的逐日结构与总量
     * ⚠️ 宿主 `usageDaily` **只下发逐日粒度**（没有逐段起止时刻）⇒ b 不是"逐段甘特"，
     *    只能画"逐日活动带"；这一点必须写在卡面上（口径诚实，不许假装）。
     */
    var SESSION_VIEWS = [
      { key: "a", label: "ses.view.a" },
      { key: "b", label: "ses.view.b" },
      { key: "c", label: "ses.view.c" }
    ];
    var DEFAULT_SESSION_VIEW = "a";
    /** 会话页时间窗候选（天；`0` = 全部）。 */
    var SESSION_WINDOWS = [
      { value: "7", label: "ses.win.7" },
      { value: "14", label: "ses.win.14" },
      { value: "30", label: "ses.win.30" },
      { value: "0", label: "ses.win.all" }
    ];
    var DEFAULT_SESSION_WINDOW = 7;
    /**
     * 「显示范围」候选（天；`0` = 不限）—— **与时间窗是两个概念**（2026-10-14 定稿）：
     *   · 时间窗（`SESSION_WINDOWS`）只管**时长怎么统计**（窗口内逐日相加）；
     *   · 显示范围只管**哪些会话还值得列出来**（按"最后活动日"距今算）。
     * 默认 14 天。
     */
    var SESSION_RANGES = [
      { value: "7", label: "ses.range.7" },
      { value: "14", label: "ses.range.14" },
      { value: "30", label: "ses.range.30" },
      { value: "0", label: "ses.range.all" }
    ];
    var DEFAULT_SESSION_RANGE = 14;
    /** b 视图活动带的列数（近 N 天，含今天）。 */
    var SESSION_BAND_DAYS = 14;
    /** 清单最多列出的会话行数（防一屏几千行；被截掉的数目在脚注里说清）。 */
    var SESSION_LIST_LIMIT = 40;
    /** 工作区标签的最大长度（超长 cwd 不许撑爆界面）。 */
    var MAX_WORKSPACE_LEN = 260;
    /**
     * 毫秒类数值的**上界**（10 年量级）：只用来挡明显荒谬的脏值（`MAX_SAFE_INTEGER` 会渲染成
     * `2501999792h59m`）。正常用量（连开 24 小时也只有 8.64e7）离它远得很。
     */
    var MAX_SPAN_MS = 86400000 * 3650;
    /** 计数类（轮 / 段）的上界：同一条口径，只挡荒谬值。 */
    var MAX_COUNT_VALUE = 1e9;

    // —— P1.1 二级菜单 ——
    /** 分段 key 白名单（顺序 = 界面顺序）。**第一项 = 默认选中**（概览 = P1 原有四张卡）。 */
    var SEGMENT_KEYS = ["overview", "calendar", "sessions", "kline", "settings"];
    var DEFAULT_SEGMENT = "overview";

    // —— P1.1 偏好（设置分段）——
    /** localStorage 键名：**必须带插件前缀**，避免与其它插件撞车。 */
    var PREF_KEY = NS + ".prefs";
    /** 默认偏好。空闲阈值与 IDLE_THRESHOLD_MS 同源（5 分钟）⇒ 改一处必须核对另一处。 */
    var DEFAULT_PREFS = {
      idleMinutes: Math.round(IDLE_THRESHOLD_MS / 60000),
      timezone: "Asia/Shanghai",
      scope: "session",
      sesView: DEFAULT_SESSION_VIEW,
      sesWindow: DEFAULT_SESSION_WINDOW,
      sesRange: DEFAULT_SESSION_RANGE,
      sesWorkspace: "",
      weeklyGoalMinutes: 0
    };
    /**
     * A4：**每周目标**（分钟；0 = 关）。
     * 口径与 `idleMinutes` / `sesRange` 一致：**只认白名单里的值**，非法（缺 / 类型错 / 不在表里）静默回退默认。
     * ⚠️ 目标不是"预算"（超了也不是坏事）⇒ 超支**不用红绿**，只有文字 + 中性色（见 kpi 进度条）。
     */
    var PREF_WEEKLY_GOALS = [
      { value: 0, label: "goal.off" },
      { value: 300, label: "goal.5h" },
      { value: 600, label: "goal.10h" },
      { value: 1200, label: "goal.20h" },
      { value: 1800, label: "goal.30h" },
      { value: 3000, label: "goal.50h" }
    ];
    /** 空闲阈值的候选值（分钟）。当前值不在候选里时会被动态补进下拉框。 */
    var PREF_IDLE_CHOICES = [1, 2, 3, 5, 10, 15, 30, 60];
    /** 时区候选（IANA 名）。当前值不在候选里时会被动态补进下拉框。 */
    var PREF_TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Europe/London", "America/New_York", "UTC"];
    /** 数据范围：session = 本会话（P1 唯一真实可用的口径）；all = 全历史（等 P2）。 */
    var PREF_SCOPES = [
      { key: "session", label: "set.scope.session" },
      { key: "all", label: "set.scope.all" }
    ];

    var DICT_ZH = {
      "tab": "时间统计",
      "card.kpi": "本会话概览",
      "card.gantt": "使用时间线",
      "card.hours": "每小时分布",
      "card.rank": "每轮用时排行",
      "card.hostStats": "宿主统计",
      "hs.sub": "来自宿主半 usageDaily 的新投影（工具 / 模型 / 回合）· ⚠️ 重启后才开始记账",
      "hs.tools": "工具耗时排行",
      "hs.models": "按模型",
      "hs.outcomes": "回合结束原因",
      "hs.compactions": "上下文压缩",
      "hs.shapes": "⚠️ 未识别的形状（宿主宽探测没命中；列在这里用于定稿字段名）",
      "hs.calls": " 次",
      "hs.turns": " 轮",
      "hs.times": " 次",
      "hs.more": "另有 ",
      "hs.moreUnit": " 条未列出",
      // P1-fix：这两个数来自 sessionStats 投影 = **全日志**累计，标签必须把它写出来，
      // 否则会和下方甘特/每小时卡片（只覆盖已加载窗口）的数字打架（实机 135 vs 42）。
      "kpi.turns": "轮次（全日志）",
      "kpi.turns.sub": "至少含一个已完成步骤的轮次（sessionStats 全日志累计）",
      "kpi.steps": "步数（全日志）",
      "kpi.steps.sub": "已关闭的步骤（sessionStats 全日志累计）",
      "kpi.wall": "挂钟跨度",
      "kpi.wall.sub": "最早一轮开始 → 最晚一轮结束",
      "kpi.active": "活跃时长",
      "kpi.active.sub": "各活跃段之和（相邻间隔 > 5 分钟即断开）",
      "kpi.idleRate": "空闲率",
      "kpi.idleRate.sub": "空闲 ÷ 挂钟跨度",
      "kpi.first": "首条消息时间",
      "kpi.first.sub": "**已加载窗口**内最早一轮的开始时刻（本地时间；不是全日志）",
      "kpi.avgTurn": "平均轮时长",
      "kpi.avgTurn.sub": "已加载窗口内每轮平均（与上面的全日志口径不同源）",
      "kpi.medianTurn": "中位轮时长",
      "kpi.medianTurn.sub": "一半的轮比它快 —— 比平均值更抗长尾",
      "kpi.maxTurn": "最长轮",
      "kpi.maxTurn.sub": "已加载窗口内最慢的一轮",
      "kpi.longestIdle": "最长空闲",
      "kpi.longestIdle.sub": "轮与轮之间最长的那段间隔（按当前空闲阈值切段）",
      "gantt.sub": "每轮一段；空白 = 空闲（间隔 > 5 分钟断开计新段）",
      "card.steps": "步骤时间线",
      "steps.step": "步 ",
      "steps.sub": "每步一段（最多 60 步）；优先用宿主给的 step/end，缺 end 时才用下一步开始兜；空白 = 间隔",
      "steps.capped": "只显示最近 60 步",
      "card.dow": "时段分布",
      "card.work": "时间构成（全日志）",
      "export.title": "时间统计报告",
      "goal.off": "关",
      "goal.5h": "5 小时",
      "goal.10h": "10 小时",
      "goal.20h": "20 小时",
      "goal.30h": "30 小时",
      "goal.50h": "50 小时",
      "goal.tip": "每周目标",
      "goal.over": "已超 ",
      "goal.left": "还剩 ",
      "set.goal": "每周目标",
      "set.goal.sub": "给「本周」加一条进度；0 = 关闭。⚠️ 超了不算「坏」（时长没有好坏），所以只用文字提示、不用红绿",
      "export.generatedAt": "生成于",
      "export.localZone": "本地时区",
      "export.metric": "指标",
      "export.value": "值",
      "export.session": "会话",
      "export.workspace": "工作区",
      "export.activeInWindow": "窗口内活跃",
      "export.allTimeTotal": "近 12 周累计",
      "export.caliber": "口径说明",
      "export.footer": "由 dsh-usage-tab 在本地生成；零网络请求；只包含本插件数据源里的数据",
      "export.btn": "导出 Markdown",
      "export.hint": "在浏览器内生成并下载、零网络请求；只包含本插件拿得到的数据",
      "card.wsTrend": "工作区趋势",
      "card.kline": "K 线（按天）",
      "kline.sub": "每根蜡烛 = 一天：**开盘 = 前一天的量、收盘 = 当天的量**（实体长度就是涨跌幅），纵轴 0~24h（极端日累计会抬轴，上限 96h），**涨红跌绿**。🩸 **无影线**（宿主只给逐日粒度，拿不到日内最高 / 最低）",
      "kline.core": "高频段 ",
      "kline.open": "开 ",
      "kline.close": "收 ",
      "kline.note": "数据源：宿主 usageDaily 投影（与「日历」页同源）",
      "kline.emptyRange": "近 60 天",
      "kline.prevDay": "前一天 ",
      "kline.legendUp": "较前一天上升（红）",
      "kline.legendDown": "较前一天下降（绿）",
      "kline.legendFlat": "持平（无前一日数据也归此档）",
      "wsTrend.sub": "近 12 周（周一起算），一周一根柱；柱高是**各周之间的相对值**（不是绝对时长），右列是该工作区**在这 12 周窗口内**的累计（不是全期总量）",
      "wsTrend.cappedPre": "只列前 6 个；另有 ",
      "wsTrend.cappedSuf": " 个工作区未列出",
      "card.subagent": "子代理构成",
      "subagent.sub": "按**当前筛选 / 显示范围**统计（与上面的会话数同口径）；子代理会话目前各算各的",
      "subagent.count": "会话数",
      "subagent.active": "活跃时长",
      "work.sub": "模型耗时 vs 工具执行耗时 —— 互斥两段，**占比分母 = 两者之和**（不是会话总时长），来自 sessionStats 全日志累计；首 token / 生成速度是**模型段内部**的拆分、不计入这两段；拿不到该投影或全为 0 就整块不显示",
      "work.llm": "模型",
      "work.tool": "工具",
      "work.ttft": "首 token 平均",
      "work.tps": "生成速度",
      "dow.sub": "周一~周日 × 0~23 时；格子越深 = 该时段开始的步数越多",
      "dow.rows": "周一,周二,周三,周四,周五,周六,周日",
      "gantt.turnPrefix": "第 ",
      "gantt.turnSuffix": " 轮",
      "gantt.tip": "用时",
      // P1-fix：甘特只画 turnTimings 里有的轮次 ⇒ 卡面必须标出「已加载窗口」范围。
      "gantt.window": "仅显示已加载窗口：",
      "hours.sub": "按每个步骤的开始时间落桶（本地时区 0–23 时）",
      "hours.steps": "步",
      "hours.axis": "时",
      "hours.sum": "已加载窗口 ",
      "hours.sumMid": " 步，累计活跃 ",
      "rank.sub": "最久的 5 轮",
      "rank.dur": "用时",
      "empty.title": "暂无数据",
      "empty.hint": "本会话还没有可用的轮次/步骤时间戳。发一条消息或让它跑完一轮后回到这里。",
      "segments": "活跃段",
      // —— P1.1 二级菜单 ——
      "seg.aria": "时间统计分段",
      "seg.overview": "概览",
      "seg.calendar": "日历",
      "seg.kline": "K 线",
      "seg.sessions": "会话",
      "seg.settings": "设置",
      // —— P1.1 日历 / 会话骨架（P2 才填数）——
      "p2.tag": "P2 接宿主级全历史数据后填充",
      "p2.note": "本分段要等 P2 接入宿主级全历史数据后才能填数；现在只画骨架，所有数值一律显示 —，不猜、不造占位数。",
      // —— P2 第一步：日历读真数据（宿主 usageDaily 投影）——
      "cal.emptyNote": "暂时读不到 usageDaily 投影值：它由宿主折好后随会话列表行零 I/O 下发，需要宿主侧新版插件先生效（宿主半改动要重启 dsh web）并写入投影缓存。骨架只是占位，所有数值一律显示 —，不猜、不造占位数。",
      "cal.note": "数据源：宿主 usageDaily 投影。每个会话把事件时间戳按宿主本地时区折成逐日活跃毫秒（相邻活动事件间隔 > 5 分钟即断开算新段），随会话列表行零 I/O 下发，由本页跨会话求和。它只覆盖宿主已写过投影缓存的会话：从未打开过的冷会话要等 P2 第二步回填；子代理会话目前各算各的。",
      "cal.sessions": "覆盖会话",
      "cal.range12w": "近 12 周",
      "cal.range14d": "近 14 天",
      "cal.segSub": "按活跃段统计（相邻活动事件间隔 > 5 分钟断开），跨会话求和",
      "cal.todaySub": "今天（本地日历日）的活跃时长合计",
      "cal.weekSub": "本周一 0 点至今；环比取**上周一 ~ 上周同日**（等长对位）",
      "cal.prevWeek": "上周",
      "cal.prevMonth": "上月",
      "cal.monthSub": "本月 1 日至今；环比取**上月 1 日 ~ 上月同日**（等长对位）",
      "cal.longestSub": "全部会话里最长的一段",
      "cal.avgSub": "活跃总时长 ÷ 段数",
      "cal.countSub": "全部会话的活跃段总数",
      "cal.cum": "今日 · 本周 · 本月累计",
      "cal.segs": "连续使用段",
      "cal.heat": "按天热力图",
      "cal.bars": "每日时长柱状",
      "cal.today": "今日",
      "cal.week": "本周",
      "cal.month": "本月",
      "cal.longest": "最长",
      "cal.avg": "平均",
      "cal.count": "段数",
      "ses.recent": "近期最常用会话",
      "ses.durRank": "会话时长排行",
      "ses.workspace": "工作区 · 项目时间分布",
      "ses.sub": "跨会话用时清单（数据来自宿主 usageDaily 逐日投影，随会话列表行下发，零额外 I/O）",
      "ses.view.aria": "会话页视图",
      "ses.view.a": "按工作区",
      "ses.view.a.hint": "按工作区分组；行内比例条 = 所选窗口内的活跃时长（条长相对全部会话里最长的那条）",
      "ses.view.b": "活动带",
      "ses.view.b.hint": "每个会话一行 × 近 14 天；格子深浅 = 当天的活跃量（相对全部会话里最忙的一天）",
      "ses.view.c": "单会话",
      "ses.view.c.hint": "左栏列表、右栏选中会话的逐日结构（柱高相对这个会话自己最忙的一天）",
      "ses.win.aria": "时间范围",
      "ses.win.7": "近 7 天",
      "ses.win.14": "近 14 天",
      "ses.win.30": "近 30 天",
      "ses.win.all": "全部",
      "ses.range.aria": "显示范围",
      "ses.range.7": "7 天内",
      "ses.range.14": "14 天内",
      "ses.range.30": "30 天内",
      "ses.range.all": "不限",
      "ses.range.title": "只列出最近有活动的会话（太久没动的自动隐藏）",
      "ses.ws.aria": "工作区筛选",
      "ses.ws.all": "全部工作区",
      "ses.ws.unknown": "未知工作区",
      "ses.sessions": " 个会话",
      "ses.total": "合计",
      "ses.winTotal": "窗口内",
      "ses.allTotal": "全日志",
      "ses.segUnit": " 段",
      "ses.turnUnit": " 轮",
      "ses.segs": "活跃段（全日志）",
      "ses.turns": "轮数（全日志）",
      "ses.longest": "最长段（全日志）",
      "ses.last": "最后活动",
      "ses.uncoveredPre": "另有 ",
      "ses.uncoveredSuf": " 个会话没有该投影（老会话等回填 / 或被跳过），未计入上方统计。⚠️ 这一项是**全量口径**，不受「显示范围」影响（没有投影的会话连「最后活动日」都没有，无从判断新旧）。",
      "ses.cappedPre": "只列出前 ",
      "ses.cappedMid": " 个会话（按时长降序），另有 ",
      "ses.cappedSuf": " 个未列出。",
      "ses.cappedPinned": "（你当前选中的会话已置顶显示。）",
      "ses.windowEmpty": "所选时间窗内没有活跃记录 —— 切「全部」可看全日志总量。",
      "ses.emptyPick": "当前工作区筛选下没有会话 —— 换个工作区，或把上面的「时间范围」放宽试试。",
      "ses.zeroActive": "当前没有活跃时长记录（所选时间窗与「全部」都是 0）。",
      "ses.rangeEmpty": "当前范围内没有会话 —— 把上面的「时间范围」放宽（近 30 天 / 全部）试试。",
      "ses.band.note": "活动带只有逐日粒度：宿主 usageDaily 只下发逐日毫秒，没有逐段的起止时刻，所以这不是逐段甘特。",
      "ses.detail.aria": "选中会话详情",
      "ses.detail.daily": "近 14 天逐日活跃",
      "ses.subagent": "子代理",
      "ses.running": "运行中",
      "ses.note": "数据来自宿主 usageDaily 投影（随会话列表行下发，零额外 I/O）。",
      "ses.caliber": "口径：时长按所选时间窗逐日相加；段数 / 轮数 / 最长段是宿主折的全日志总量，不随窗口变。",
      "ses.emptyNote": "读不到宿主 usageDaily 投影 ⇒ 保持空态（值一律 —）。从没打开过的老会话要等冷回填跑完才会出现。",
      "cal.sub": "按天聚合的用时视图（数据来自宿主 usageDaily 投影）",
      "card.calendar": "日历视图",
      "card.sessions": "会话视图",
      // —— P1.1 设置 ——
      "set.title": "偏好设置",
      "set.sub": "改动即时保存到浏览器本地，刷新后仍生效。",
      "set.idle": "空闲阈值",
      "set.idle.sub": "相邻事件间隔超过该值 ⇒ 视为断开、算新的一段（恰好等于仍算同一段）。改它，概览的活跃段 / 空闲率立刻跟着变。",
      "set.idleUnit": " 分钟",
      "set.tz": "时区",
      "set.tz.sub": "按天 / 每小时的落桶口径。P1 渲染仍按浏览器本地时区，P2 接入该口径后才真正生效。",
      "set.custom": "（自定义）",
      "set.scope": "数据范围",
      "set.scope.sub": "「全历史」需要宿主级数据，P2 之前仍按本会话渲染。",
      "set.scope.session": "本会话",
      "set.scope.all": "全历史",
      "set.scopePending": "已选「全历史」：宿主级全历史数据待 P2 接入，当前仍按本会话显示。",
      "set.metric": "口径说明",
      "set.store": "存储位置：localStorage，键名 ",
      "set.fallback": "读取 / 解析 / 写入失败（隐私模式、禁用本地存储、被手工改坏）一律静默回退默认值：5 分钟 / Asia/Shanghai / 本会话，不影响渲染。",
      // P1-fix：这条脚注以前只写在字典里、卡面没渲染出来。现在由 UsageView 渲染到最底部
      // （.ut-source，11px / label-tertiary），并且把**两个口径**一次讲清，避免数字打架。
      "source.note": "数据源：sessionStats 投影（全日志累计）+ 本会话 turnTimings / timeline（仅覆盖浏览器已加载的会话窗口）。标「全日志」的 KPI 是全日志累计；其余数字（挂钟 / 活跃 / 空闲率 / 首条时间、甘特、每小时分布、排行）都只看已加载窗口，两者不可相加。"
    };

    var DICT_EN = {
      "tab": "Usage",
      "card.kpi": "This session",
      "card.gantt": "Usage timeline",
      "card.hours": "Hourly distribution",
      "card.rank": "Slowest turns",
      "card.hostStats": "Host stats",
      "hs.sub": "New projections from the host half (tools / models / turns) \u00b7 \u26a0\ufe0f recording starts after a restart",
      "hs.tools": "Tool time",
      "hs.models": "By model",
      "hs.outcomes": "Turn outcomes",
      "hs.compactions": "Compactions",
      "hs.shapes": "\u26a0\ufe0f Unrecognised shapes (the host's wide probe missed; listed here to pin the real field names)",
      "hs.calls": " calls",
      "hs.turns": " turns",
      "hs.times": " times",
      "hs.more": "and ",
      "hs.moreUnit": " more not shown",
      "kpi.turns": "Turns (whole log)",
      "kpi.turns.sub": "Turns with at least one closed step (whole-log sessionStats)",
      "kpi.steps": "Steps (whole log)",
      "kpi.steps.sub": "Closed steps (whole-log sessionStats)",
      "kpi.wall": "Wall clock",
      "kpi.wall.sub": "Earliest turn start → latest turn end",
      "kpi.active": "Active",
      "kpi.active.sub": "Sum of active segments (gaps over 5 min split segments)",
      "kpi.idleRate": "Idle share",
      "kpi.idleRate.sub": "Idle ÷ wall clock",
      "kpi.first": "First message",
      "kpi.first.sub": "Start of the earliest turn **inside the loaded window** (local time; not all-time)",
      "kpi.avgTurn": "Avg turn",
      "kpi.avgTurn.sub": "Mean turn duration in the loaded window (different source than the whole-log KPIs above)",
      "kpi.medianTurn": "Median turn",
      "kpi.medianTurn.sub": "Half the turns are faster than this \u2014 more robust than the mean",
      "kpi.maxTurn": "Longest turn",
      "kpi.maxTurn.sub": "Slowest turn in the loaded window",
      "kpi.longestIdle": "Longest idle",
      "kpi.longestIdle.sub": "Longest gap between turns (segmented by the current idle threshold)",
      "gantt.sub": "One bar per turn; gaps are idle (over 5 min starts a new segment)",
      "card.steps": "Step timeline",
      "steps.step": "step ",
      "steps.sub": "One bar per step (max 60); uses the host's step/end, falls back to the next step's start only when end is missing",
      "steps.capped": "last 60 steps only",
      "card.dow": "Hour \u00d7 weekday",
      "export.title": "Usage report",
      "goal.off": "Off",
      "goal.5h": "5 hours",
      "goal.10h": "10 hours",
      "goal.20h": "20 hours",
      "goal.30h": "30 hours",
      "goal.50h": "50 hours",
      "goal.tip": "Weekly goal",
      "goal.over": "over by ",
      "goal.left": "left ",
      "set.goal": "Weekly goal",
      "set.goal.sub": "Adds a progress bar to \u201cthis week\u201d; 0 = off. \u26a0\ufe0f Going over is not \u201cbad\u201d (duration has no valence), so it is text-only \u2014 no red/green",
      "export.generatedAt": "Generated at",
      "export.localZone": "local zone",
      "export.metric": "Metric",
      "export.value": "Value",
      "export.session": "Session",
      "export.workspace": "Workspace",
      "export.activeInWindow": "Active in window",
      "export.allTimeTotal": "Last-12-week total",
      "export.caliber": "Caliber",
      "export.footer": "Generated locally by dsh-usage-tab; zero network requests; only includes data from this plugin's own sources",
      "export.btn": "Export Markdown",
      "export.hint": "Built and downloaded in the browser, zero network requests; only includes data this plugin actually has",
      "card.wsTrend": "Workspace trend",
      "card.kline": "K-line (daily)",
      "kline.sub": "One candle per day: **open = the previous day's total, close = this day's total** (the body length is the day-over-day change). Y-axis 0\u201324h (an extreme daily total raises the axis; capped at 96h), **red up / green down**. \ud83e\ude78 **No wicks** (the host only exposes daily granularity, so intraday high/low are unavailable)",
      "kline.core": "peak ",
      "kline.open": "open ",
      "kline.close": "close ",
      "kline.note": "Source: the host's usageDaily projection (same as the Calendar tab)",
      "kline.emptyRange": "last 60 days",
      "kline.prevDay": "prev day ",
      "kline.legendUp": "up vs previous day (red)",
      "kline.legendDown": "down vs previous day (green)",
      "kline.legendFlat": "flat (also covers days with no previous data)",
      "wsTrend.sub": "Last 12 weeks (Monday-based), one bar per week; bar height is **relative across weeks** (not an absolute duration), and the right column is that workspace's total **within this 12-week window** (not all time)",
      "wsTrend.cappedPre": "top 6 only; ",
      "wsTrend.cappedSuf": " more workspaces not shown",
      "card.subagent": "Subagent share",
      "subagent.sub": "Counted over the current filter / display range (same basis as the session count above); subagent sessions currently count on their own",
      "subagent.count": "Sessions",
      "subagent.active": "Active time",
      "card.work": "Work split (whole log)",
      "work.sub": "LLM time vs tool time \u2014 mutually exclusive segments; the percentage denominator is **their sum** (not the session wall time). From the whole-log sessionStats projection. First-token and decode speed are splits *inside* the LLM segment and are not added to the bar. The card is hidden when the projection is unavailable or all-zero",
      "work.llm": "LLM",
      "work.tool": "Tool",
      "work.ttft": "Avg first token",
      "work.tps": "Decode speed",
      "dow.sub": "Mon\u2013Sun \u00d7 0\u201323h; deeper cell = more steps started in that slot",
      "dow.rows": "Mon,Tue,Wed,Thu,Fri,Sat,Sun",
      "gantt.turnPrefix": "Turn ",
      // 故意为空串：英文 "Turn 5" 没有后缀（中文是 "第 5 轮"）。自测里有显式白名单。
      "gantt.turnSuffix": "",
      "gantt.tip": "Duration",
      // P1-fix：与中文对应，标出甘特只覆盖已加载窗口。
      "gantt.window": "Loaded window only: ",
      "hours.sub": "Steps bucketed by their start time (local 0–23h)",
      "hours.steps": "steps",
      "hours.axis": "h",
      // P1-fix：不再留空 —— 必须和中文一样标出「已加载窗口」口径。
      // （自测 T2 的空白串白名单已同步移除 hours.sum，见 test/self-test.mjs。）
      "hours.sum": "Loaded window ",
      "hours.sumMid": " steps, ",
      "rank.sub": "The 5 longest turns",
      "rank.dur": "Duration",
      "empty.title": "No data yet",
      "empty.hint": "This session has no usable turn/step timestamps yet. Send a message or finish one turn, then come back.",
      "segments": "Segments",
      // —— P1.1 二级菜单（与中文 key 集合逐字对应，自测 T2 把关）——
      "seg.aria": "Usage tab sections",
      "seg.overview": "Overview",
      "seg.calendar": "Calendar",
      "seg.kline": "K-line",
      "seg.sessions": "Sessions",
      "seg.settings": "Settings",
      // —— P1.1 日历 / 会话骨架（P2 才填数）——
      "p2.tag": "Filled in P2 with host-level whole-history data",
      "p2.note": "This section needs host-level whole-history data (P2); for now only the skeleton is drawn and every value shows \u2014 \u2014 nothing is guessed.",
      // —— P2 第一步：日历读真数据（宿主 usageDaily 投影）——
      "cal.emptyNote": "No usageDaily projection values are readable yet: the host folds them and ships them inside every session-list row (zero extra I/O), so the new host half must be live (a host-half change needs a dsh web restart) and must have written a projection checkpoint. The skeleton is a placeholder \u2014 every value shows \u2014 \u2014 nothing is guessed.",
      "cal.note": "Source: the host's usageDaily projection. Each session folds event timestamps into per-day active milliseconds in the host's local zone (a gap over 5 minutes starts a new segment); every session-list row carries that row, and this page sums it across sessions at zero extra I/O. It only covers sessions the host has already checkpointed: never-opened cold sessions wait for P2 step 2, and subagent sessions currently count on their own.",
      "cal.sessions": "Sessions covered",
      "cal.range12w": "last 12 weeks",
      "cal.range14d": "last 14 days",
      "cal.segSub": "Per active segment (a gap over 5 minutes starts a new one), summed across sessions",
      "cal.todaySub": "Total active time today (local calendar day)",
      "cal.weekSub": "This Monday 00:00 to now; the comparison window is **last Monday through the same weekday** (equal length)",
      "cal.prevWeek": "last week",
      "cal.prevMonth": "last month",
      "cal.monthSub": "The 1st of this month to now; the comparison window is **the 1st through the same day of last month** (equal length)",
      "cal.longestSub": "The longest single segment across every session",
      "cal.avgSub": "Total active time \u00f7 segments",
      "cal.countSub": "Active segments across every session",
      "cal.cum": "Today \u00b7 week \u00b7 month",
      "cal.segs": "Continuous segments",
      "cal.heat": "Daily heatmap",
      "cal.bars": "Daily duration bars",
      "cal.today": "Today",
      "cal.week": "This week",
      "cal.month": "This month",
      "cal.longest": "Longest",
      "cal.avg": "Average",
      "cal.count": "Count",
      "ses.recent": "Recent top sessions",
      "ses.durRank": "Session duration ranking",
      "ses.workspace": "Workspace \u00b7 project time split",
      "ses.sub": "Cross-session usage list (host usageDaily projection, delivered on session list rows, zero extra I/O)",
      "ses.view.aria": "Sessions view",
      "ses.view.a": "By workspace",
      "ses.view.a.hint": "Grouped by workspace; inline bar = active time inside the selected window (length is relative to the longest session overall)",
      "ses.view.b": "Activity band",
      "ses.view.b.hint": "One row per session \u00d7 last 14 days; cell depth = that day's activity (relative to the busiest day overall)",
      "ses.view.c": "Single session",
      "ses.view.c.hint": "List on the left, daily structure of the selected session on the right (bars are relative to that session's busiest day)",
      "ses.win.aria": "Time range",
      "ses.win.7": "Last 7 days",
      "ses.win.14": "Last 14 days",
      "ses.win.30": "Last 30 days",
      "ses.win.all": "All time",
      "ses.range.aria": "Display range",
      "ses.range.7": "within 7 days",
      "ses.range.14": "within 14 days",
      "ses.range.30": "within 30 days",
      "ses.range.all": "unlimited",
      "ses.range.title": "Only list sessions active recently (stale ones are hidden)",
      "ses.ws.aria": "Workspace filter",
      "ses.ws.all": "All workspaces",
      "ses.ws.unknown": "Unknown workspace",
      "ses.sessions": " sessions",
      "ses.total": "total",
      "ses.winTotal": "in window",
      "ses.allTotal": "all-time",
      "ses.segUnit": " seg",
      "ses.turnUnit": " turns",
      "ses.segs": "Active segments (all-time)",
      "ses.turns": "Turns (all-time)",
      "ses.longest": "Longest segment (all-time)",
      "ses.last": "Last active",
      "ses.uncoveredPre": "Another ",
      "ses.uncoveredSuf": " session(s) have no such projection (old sessions awaiting backfill / skipped) and are not counted above. Note: this count is overall and is not affected by the display range (sessions without the projection have no last-active day at all).",
      "ses.cappedPre": "Showing the first ",
      "ses.cappedMid": " sessions (longest first); ",
      "ses.cappedSuf": " more are not listed.",
      "ses.cappedPinned": "(Your currently selected session is pinned to the top.)",
      "ses.windowEmpty": "No activity inside the selected window \u2014 switch to \u201cAll time\u201d for all-time totals.",
      "ses.emptyPick": "No sessions under the current workspace filter \u2014 try another workspace, or widen the \u201ctime range\u201d above.",
      "ses.zeroActive": "No active time recorded here (zero in the selected window and in \u201cAll time\u201d as well).",
      "ses.rangeEmpty": "No sessions inside the current range \u2014 widen the \u201ctime range\u201d above (last 30 days / all time).",
      "ses.band.note": "The activity band is daily-granularity only: the host usageDaily projection carries per-day milliseconds, not per-segment start/end times, so this is not a segment gantt.",
      "ses.detail.aria": "Selected session detail",
      "ses.detail.daily": "Daily activity, last 14 days",
      "ses.subagent": "subagent",
      "ses.running": "running",
      "ses.note": "Data comes from the host usageDaily projection (delivered on session list rows, zero extra I/O).",
      "ses.caliber": "Caliber: durations are summed per day inside the selected window; segments / turns / longest segment are the host's all-time totals and do not change with the window.",
      "ses.emptyNote": "The host usageDaily projection is unavailable \u21d2 the page stays empty (\u2014 everywhere). Sessions never opened before appear only after the cold backfill runs.",
      "cal.sub": "Per-day usage view (values come from the host's usageDaily projection)",
      "card.calendar": "Calendar view",
      "card.sessions": "Sessions view",
      // —— P1.1 设置 ——
      "set.title": "Preferences",
      "set.sub": "Changes are saved in this browser right away and survive a refresh.",
      "set.idle": "Idle threshold",
      "set.idle.sub": "A gap longer than this starts a new segment (an exact match still counts as one segment). Changing it updates the overview's active / idle numbers right away.",
      "set.idleUnit": " min",
      "set.tz": "Time zone",
      "set.tz.sub": "Bucketing caliber for day / hour grouping. P1 still renders in the browser's local zone; this takes effect once P2 lands.",
      "set.custom": " (custom)",
      "set.scope": "Data range",
      "set.scope.sub": "\"Whole history\" needs host-level data; until P2 it still renders this session.",
      "set.scope.session": "This session",
      "set.scope.all": "Whole history",
      "set.scopePending": "Whole history selected: host-level data arrives in P2, so this session is still rendered.",
      "set.metric": "Caliber notes",
      "set.store": "Stored in localStorage, key ",
      "set.fallback": "Any read / parse / write failure (private mode, storage disabled, hand-edited value) falls back silently to the defaults: 5 min / Asia/Shanghai / this session. Rendering is never affected.",
      "source.note": "Sources: sessionStats projection (whole log) + this session's turnTimings / timeline (loaded conversation window only). KPIs marked \"whole log\" are whole-log; every other number (wall / active / idle / first time, gantt, hourly, rank) covers the loaded window only — do not add the two bases together."
    };

    //#endregion

    //#region §2 样式与注入

    /**
     * 全部走宿主 token（--dsw-*），**零硬编码配色**：没有任何 #hex / rgb() /
     * 具名颜色，颜色只来自 var(--dsw-alias-*)，缺失时由宿主主题兜底。
     * 结构与着色对照 dsh-context 的 base.css / stats.css。
     */
    var CSS = [
      // 🎨 **自带数据色**：宿主里**没有** `--color-*`（那是 dsh-context 自带 bundle
      //    注入的，直扫 app.asar 为 NOT FOUND）⇒ 零依赖插件要"多彩分类色"就得自己带一套。
      //    oklch 常量 = 不随主题变 ⇒ 正好当数据色（深浅主题下都能看）；界面语义色仍一律走 `--dsw-alias-*`。
      // ⚠️ **chroma 取 ~.08~.14，不要照搬 Tailwind 500（.19~.27）** —— 2026-10-14 实测反馈
      //    饱和度偏高：深色底上高 chroma 会"发艳"，且大面积铺开时更明显。要更艳再往上调。
      ".ut-root{box-sizing:border-box;height:100%;overflow-y:auto;color:var(--dsw-alias-label-primary);font-size:13px;padding:16px 20px 32px;--ut-c1:oklch(62% .12 259);--ut-c2:oklch(70% .12 150);--ut-c3:oklch(76% .11 80);--ut-c4:oklch(63% .14 300);--ut-c5:oklch(70% .08 190);--ut-c6:oklch(66% .13 355)}",
      ".ut-card{box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin-bottom:14px;padding:14px 16px}",
      ".ut-card-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:10px;font-weight:600}",
      ".ut-card-title-text{white-space:nowrap;flex:none}",
      ".ut-card-sub{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400;margin-bottom:10px}",
      // P1-fix：标题行里的「口径标签」（如「仅显示已加载窗口：第 8~15 轮」）。
      // 低调：tertiary + 11px；无 margin，不会把标题行撑高（.ut-card-sub 带 margin-bottom，不适合放标题行）。
      ".ut-card-tag{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}",
      ".ut-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:8px}",
      ".ut-kpi{display:flex;flex-direction:column;gap:2px;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}",
      ".ut-kpi-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-kpi-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-kpi-sub{color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      // A7 K 线：只有 body（无影线，宿主拿不到日内高低）；颜色按**股市惯例：涨红跌绿**（2026-10-14 明确要的，这块是实验性功能）
      ".ut-kchart{position:relative;display:flex;align-items:flex-end;gap:6px;height:200px;padding:6px 0 6px 34px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".ut-k-col{position:relative;flex:1;min-width:0;height:100%}",
      ".ut-k-body{position:absolute;left:0;right:0;border-radius:1px;min-height:3px}",
      // A7 三期：影线**跟实体同色**（真 K 线的画法）—— 1px 淡色几乎看不见、整张图变成一堆孤立方块（2026-10-14 实测「这边咋是脱节的」）
      ".ut-k-wick{position:absolute;left:50%;width:2px;transform:translateX(-50%);min-height:2px;opacity:.85}",
      ".ut-k-wick.ut-k-up{background:var(--dsw-alias-state-error-primary)}",
      ".ut-k-wick.ut-k-down{background:var(--dsw-alias-state-success-primary)}",
      ".ut-k-wick.ut-k-flat{background:var(--dsw-alias-label-dimmed)}",
      ".ut-k-gridline{position:absolute;left:0;right:0;height:0;border-top:1px dashed var(--dsw-alias-border-l1);pointer-events:none}",
      ".ut-k-ticklabel{position:absolute;left:-30px;top:-7px;color:var(--dsw-alias-label-tertiary);font-size:9px;font-variant-numeric:tabular-nums}",
      ".ut-k-up{background:var(--dsw-alias-state-error-primary)}",
      ".ut-k-down{background:var(--dsw-alias-state-success-primary)}",
      ".ut-k-flat{background:var(--dsw-alias-label-dimmed)}",
      ".ut-k-legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:8px}",
      // 宿主统计卡（复用 .ut-rank-* 的行样式）
      ".ut-hs-block{margin-top:10px}",
      ".ut-hs-title{color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:6px}",
      ".ut-hs-line{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:10px}",
      ".ut-hs-shapes{margin-top:10px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1)}",
      ".ut-hs-shape{color:var(--dsw-alias-label-tertiary);font-size:10px;word-break:break-all}",
      ".ut-k-legend>span{display:inline-flex;align-items:center;gap:4px}",
      ".ut-k-dot{width:8px;height:8px;border-radius:1px;display:inline-block}",
      // A3 环比：颜色**只承担"这是个环比标记"**，方向一律由箭头形状表达
      // （🩸 实测发现：原先注释声称"颜色中性"，但 down 用了另一个色相 ⇒ 声称与实现不符，这里统一成一个色）
      ".ut-kpi-delta{color:var(--ut-c1);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
      // A4 每周目标进度条：**中性色**（时长没有好坏，超目标不是"坏事"，所以不用红绿）
      ".ut-kpi-prog{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:4px}",
      ".ut-kpi-prog-bar{height:100%;background:var(--ut-c1);border-radius:2px}",
      ".ut-gantt{display:flex;flex-direction:column;gap:4px}",
      ".ut-gantt-row{display:flex;align-items:center;gap:8px}",
      ".ut-gantt-turn{flex:none;width:64px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-gantt-track{position:relative;flex:auto;min-width:0;height:12px;background:var(--dsw-alias-bg-layer-2);border-radius:6px}",
      ".ut-gantt-bar{position:absolute;top:0;bottom:0;background:var(--ut-c1);border-radius:4px}",
      ".ut-hours{display:flex;align-items:flex-end;gap:2px;height:84px}",
      ".ut-hour-col{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end}",
      ".ut-hour-bar{width:100%;background:var(--ut-c1);border-radius:2px 2px 0 0}",
      ".ut-hours-axis{display:flex;gap:2px;margin-top:4px}",
      ".ut-hours-axis span{flex:1;min-width:0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:9px;font-variant-numeric:tabular-nums}",
      ".ut-hours-sum{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:8px;font-variant-numeric:tabular-nums}",
      ".ut-rank{display:flex;flex-direction:column;gap:4px}",
      ".ut-rank-row{display:flex;align-items:center;gap:8px}",
      ".ut-rank-turn{flex:none;width:64px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-rank-track{position:relative;flex:auto;min-width:0;height:14px;background:var(--dsw-alias-bg-layer-2);border-radius:7px}",
      ".ut-rank-bar{position:absolute;top:0;bottom:0;left:0;background:var(--ut-c1);border-radius:7px}",
      ".ut-rank-dur{flex:none;min-width:56px;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}",
      ".ut-empty{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:20px 16px;margin-bottom:14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
      ".ut-empty b{color:var(--dsw-alias-label-primary);font-weight:600}",
      ".ut-source{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}",
      // —— P1.1 二级分段导航：观感逐条对照 dsh-context 的 .lc-gran ——
      //   bg-layer-2 底 + 1px solid border-l2 + 6px 圆角 + padding:1px。
      // 选中态用 brand-primary 系 token（button-primary-fill 缺失时退到 brand-primary），
      // 依旧**零硬编码配色**；字号按规格 13px（dsh-context 用 11px，这里听规格的）。
      ".ut-seg{display:flex;flex-wrap:wrap;gap:2px;padding:1px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}",
      ".ut-seg-main{margin-bottom:14px}",
      ".ut-seg-sm{margin-top:2px}",
      ".ut-seg-btn{font-family:inherit;font-size:13px;line-height:1.25;color:var(--dsw-alias-label-secondary);background:0 0;border:0;border-radius:5px;padding:4px 12px;cursor:pointer;transition:color var(--ds-transition-duration,.2s) var(--ds-ease-in-out,ease-in-out)}",
      ".ut-seg-btn:hover{color:var(--dsw-alias-label-primary)}",
      ".ut-seg-on,.ut-seg-on:hover{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-1))}",
      ".ut-seg-sm .ut-seg-btn{font-size:12px;padding:3px 10px}",
      // —— P1.1 设置分段 ——
      ".ut-set{display:flex;flex-direction:column;gap:2px}",
      ".ut-set-item{display:flex;flex-direction:column;gap:4px;padding-top:12px}",
      ".ut-set-item:first-child{padding-top:0}",
      ".ut-set-name{font-weight:600;font-size:12px}",
      ".ut-set-value{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}",
      ".ut-set-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}",
      ".ut-set-pending{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:1.5;margin-top:10px}",
      // —— P1.1 日历 / 会话骨架：虚线占位 + —，**不画 0 冒充数据** ——
      ".ut-skel{display:flex;flex-direction:column;gap:6px}",
      ".ut-skel-sec{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;margin-top:8px}",
      ".ut-skel-sec:first-child{margin-top:0}",
      ".ut-skel-row{display:flex;align-items:center;gap:8px}",
      ".ut-skel-name{flex:none;width:152px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-skel-block{flex:auto;min-width:0;height:14px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l2);border-radius:6px}",
      ".ut-skel-val{flex:none;min-width:56px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}",
      // —— P2 第一步：日历热力图 ——
      // 强度只用 `state-business-primary` + opacity 表达 ⇒ 依旧**零硬编码配色**（没有 hex/rgb/具名色）；
      // 🩸 **不能用 `brand-primary` 画图表**：它在任何主题下都等于主文字色（黑 / 白）⇒ 看上去"根本没上颜色"。
      //    宿主 token 实测结论：见宿主包自带的主题变量定义。
      // 0 档就是宿主 bg-layer-2 底（与骨架占位同底，观感连续）。
      ".ut-heat{display:grid;grid-template-columns:repeat(auto-fill,minmax(11px,1fr));gap:3px}",
      ".ut-heat-cell{height:11px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}",
      // 🎨 4 档 = **4 个色相递进**（蓝 → 青 → 绿 → 黄）+ 不透明度递增 ⇒ 既多彩、"深浅=强度"也还读得出来。
      ".ut-heat-l1{background:var(--ut-c1);border-color:transparent;opacity:.45}",
      ".ut-heat-l2{background:var(--ut-c5);border-color:transparent;opacity:.7}",
      ".ut-heat-l3{background:var(--ut-c2);border-color:transparent;opacity:.85}",
      ".ut-heat-l4{background:var(--ut-c3);border-color:transparent;opacity:1}",
      // —— P2 第三步：「会话」页（A 分组表 / B 活动带 / C 主从）——
      // 依旧**零硬编码配色**：颜色只来自 var(--dsw-*)，强度只用 opacity（与热力图同款）；
      // 数字一律 tabular-nums。
      // ⚠️ **栅格写法的偏离 = 有意取舍（在此报备）**：
      //    规格要求"栅格一律 `minmax(0,1fr)` + 容器查询 380/320/240 降级"，这里改成
      //    **给名字列设 px 下限 + 外层 `overflow-x:auto`**（B 视图最小宽 241→364px、A 行 88→288px、
      //    C split 14→174px）。理由：容器 <241px 时 `minmax(0,1fr)` 会把会话名与「子代理 / 运行中」
      //    标记压到 0 宽（**完全不可见**）；而容器查询的三档布局要实机量过面板宽度才好定。
      //    横滚至少不丢信息。⏭ 待办：实机量宽后若确认会窄到 364px 以下，再补 `@container` 三档。
      ".ut-ses-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:12px}",
      ".ut-ses-tools .ut-seg{margin:0}",
      ".ut-ses-sum{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".ut-ses-groups{display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:520px}",
      ".ut-ses-group{display:flex;flex-direction:column;gap:5px}",
      ".ut-ses-group-head{display:flex;align-items:baseline;gap:8px;font-weight:600;font-size:12px;min-width:0}",
      ".ut-ses-group-path{min-width:0;flex:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ut-ses-group-total{flex:none;font-size:12px;font-variant-numeric:tabular-nums}",
      ".ut-ses-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(80px,1.4fr) minmax(0,auto) 64px;align-items:center;gap:8px}",
      ".ut-ses-name{min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ut-ses-flag{color:var(--dsw-alias-label-secondary);font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px;margin-left:4px}",
      ".ut-ses-track{position:relative;min-width:0;height:12px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;overflow:hidden}",
      ".ut-ses-bar{position:absolute;top:0;bottom:0;left:0;background:var(--ut-ses-c,var(--ut-c1));border-radius:6px}",
      ".ut-ses-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ut-ses-c,var(--ut-c1))}",
      ".ut-ses-meta{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-ses-dur{text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".ut-ses-band-wrap{min-width:0;overflow-x:auto}",
      ".ut-ses-band{display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".ut-ses-band-axis,.ut-ses-band-row{display:grid;grid-template-columns:minmax(120px,1fr) repeat(14,10px) 56px;align-items:center;gap:3px}",
      ".ut-ses-band-axis{color:var(--dsw-alias-label-tertiary);font-size:9px;font-variant-numeric:tabular-nums;margin-bottom:3px}",
      ".ut-ses-band-axis span{text-align:center}",
      ".ut-ses-band-cell{height:12px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}",
      ".ut-ses-band-l1{background:var(--ut-c1);border-color:transparent;opacity:.22}",
      ".ut-ses-band-l2{background:var(--ut-c1);border-color:transparent;opacity:.45}",
      ".ut-ses-band-l3{background:var(--ut-c1);border-color:transparent;opacity:.7}",
      ".ut-ses-band-l4{background:var(--ut-c1);border-color:transparent;opacity:1}",
      ".ut-ses-split{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:14px;align-items:start;overflow-x:auto}",
      ".ut-ses-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto}",
      ".ut-ses-item{display:flex;align-items:center;gap:6px;text-align:left;background:0 0;border:0;border-radius:5px;padding:4px 6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px}",
      ".ut-ses-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ut-ses-item-on,.ut-ses-item-on:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".ut-ses-item-name{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ut-ses-item-dur{flex:none;font-variant-numeric:tabular-nums;font-weight:600}",
      ".ut-ses-detail{min-width:0;display:flex;flex-direction:column;gap:8px}",
      ".ut-ses-detail-title{font-weight:600;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".ut-ses-days{display:flex;align-items:flex-end;gap:3px;height:70px}",
      ".ut-ses-day{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:2px}",
      ".ut-ses-day-bar{width:100%;background:var(--ut-ses-c,var(--ut-c1));border-radius:2px 2px 0 0;min-height:1px}",
      ".ut-ses-day-label{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:9px;font-variant-numeric:tabular-nums}",
      ".ut-dow{display:flex;flex-direction:column;gap:3px}",
      // ⚠️ 列数（1 + 24）= 子元素数（label + 24 个格子）—— 2026-10-14 B 视图就是在这上面翻的车
      ".ut-dow-row{display:grid;grid-template-columns:32px repeat(24,minmax(6px,1fr));align-items:center;gap:2px}",
      ".ut-dow-label{color:var(--dsw-alias-label-tertiary);font-size:9px;white-space:nowrap}",
      ".ut-dow-cell{height:12px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}",
      ".ut-dow-l1{background:var(--ut-c1);border-color:transparent;opacity:.35}",
      ".ut-dow-l2{background:var(--ut-c5);border-color:transparent;opacity:.6}",
      ".ut-dow-l3{background:var(--ut-c2);border-color:transparent;opacity:.8}",
      ".ut-dow-l4{background:var(--ut-c3);border-color:transparent;opacity:1}",
      // 第 1 批：时间构成（模型 vs 工具）—— 两段互斥，颜色与"模型/工具"语义绑定
      ".ut-split{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);margin-bottom:10px}",
      ".ut-split-llm{background:var(--ut-c1)}",
      ".ut-split-tool{background:var(--ut-c3)}",
      ".ut-split-legend{display:flex;flex-wrap:wrap;gap:12px;color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".ut-split-legend>span{display:inline-flex;align-items:center;gap:4px}",
      ".ut-split-dot{width:8px;height:8px;border-radius:2px;display:inline-block}",
      ".ut-ses-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6;margin-top:8px}",
      // A5 子代理构成：3 列 grid（label / track / value）—— 列数必须等于子元素数
      // A6 工作区趋势：3 列 grid（label / 迷你柱组 / 总量）—— 列数必须等于子元素数
      ".ut-btn{font-family:inherit;font-size:13px;line-height:1.25;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 14px;cursor:pointer}",
      ".ut-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".ut-ws-row{display:grid;grid-template-columns:110px minmax(0,1fr) 64px;align-items:center;gap:8px;margin-top:6px}",
      ".ut-ws-label{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".ut-ws-bars{display:flex;align-items:flex-end;gap:2px;height:22px}",
      ".ut-ws-col{flex:1;min-width:0;height:100%;display:flex;align-items:flex-end}",
      ".ut-ws-bar{width:100%;background:var(--ut-c1);border-radius:1px;min-height:1px}",
      ".ut-ws-total{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}",
      ".ut-sub-row{display:grid;grid-template-columns:64px minmax(0,1fr) 120px;align-items:center;gap:8px;margin-top:6px}",
      ".ut-sub-label{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}",
      ".ut-sub-track{position:relative;height:10px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;overflow:hidden}",
      ".ut-sub-bar{position:absolute;top:0;bottom:0;left:0;background:var(--ut-c4)}",
      ".ut-sub-val{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}"
    ].join("");

    var CSS_TAG = NS + "/usage.css";

    /**
     * CSS 常驻全局，且**注入前先删本插件旧 style**（照同类插件客户端的做法
     * 的防堆积写法）：只靠 querySelector 去重的话，HMR / 重复 materialize 换了内容
     * 也不会替换旧规则，会出现"新旧规则同时命中"的错版。
     */
    function injectCss () {
      if (typeof document === "undefined" || document === null || !document.head) return false;
      var stale = document.querySelectorAll("style[data-plugin-css=\"" + CSS_TAG + "\"]");
      for (var i = 0; i < stale.length; i++) {
        if (stale[i] && stale[i].parentNode) stale[i].parentNode.removeChild(stale[i]);
      }
      var tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return true;
    }

    //#endregion

    //#region §3 纯函数核心（全部经 __test 暴露，可脱离宿主自测）

    /** 有限数 → 数字；其余（undefined/null/NaN/Infinity/字符串）→ null。 */
    function numOf (value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /**
     * 任意输入 → **非负有限数**（非法一律 0）。
     * 与 `numOf` 的分工：`numOf` 用于"缺失 ⇒ 显示 —"，本函数用于"必须能直接进算术"
     * （求和 / 比值）的场合 —— 一旦让 null 混进加法，界面上就会出现 NaN。
     */
    function nonNegOf (value) {
      var n = numOf(value);
      return n === null || n < 0 ? 0 : n;
    }

    function pad2 (value) {
      var n = numOf(value);
      if (n === null) return "00";
      var s = String(Math.floor(Math.abs(n)));
      return s.length >= 2 ? s : "0" + s;
    }

    /**
     * 清洗区间数组：丢掉非对象、start/end 非有限数的元素，turn 缺失补 0。
     * 所有吃 `spans` 的函数都先过这一道 —— 上游（useChat 快照）在会话切换、
     * 分页、热重载的瞬间完全可能给出半成品，宁可少画一根条也不能让异常穿透渲染。
     */
    function cleanSpans (spans) {
      var out = [];
      if (!Array.isArray(spans)) return out;
      for (var i = 0; i < spans.length; i++) {
        var span = spans[i];
        if (span === null || typeof span !== "object") continue;
        var start = numOf(span.start);
        var end = numOf(span.end);
        if (start === null || end === null) continue;
        var turn = numOf(span.turn);
        out.push({ turn: turn === null ? 0 : turn, start: start, end: end });
      }
      return out;
    }

    /** 鸭子类型判 Map：跨 realm（vm / iframe）时 instanceof 会误判，故不用。 */
    function isMapLike (value) {
      return value !== null && typeof value === "object" &&
        typeof value.get === "function" &&
        typeof value.entries === "function" &&
        typeof value.forEach === "function";
    }

    function valuesOfMapLike (container) {
      var out = [];
      if (container === null || container === undefined) return out;
      if (isMapLike(container)) {
        container.forEach(function (value) { out.push(value); });
      } else if (Array.isArray(container)) {
        for (var i = 0; i < container.length; i++) out.push(container[i]);
      } else if (typeof container === "object") {
        var keys = Object.keys(container);
        for (var j = 0; j < keys.length; j++) out.push(container[keys[j]]);
      }
      return out;
    }

    function entriesOfMapLike (container) {
      var out = [];
      if (container === null || container === undefined) return out;
      if (isMapLike(container)) {
        container.forEach(function (value, key) { out.push([key, value]); });
      } else if (Array.isArray(container)) {
        for (var i = 0; i < container.length; i++) out.push([i, container[i]]);
      } else if (typeof container === "object") {
        var keys = Object.keys(container);
        for (var j = 0; j < keys.length; j++) out.push([keys[j], container[keys[j]]]);
      }
      return out;
    }

    /**
     * 通道 B：`useChat(s => s.legacy.turnTimings)` → 规范化的每轮区间。
     *
     * 输入 Map 的 value 形状（宿主实际下发的形状）：
     *   { startTime: number, endTime?: number }
     * 输出 `[{ turn, start, end, open }]`，按 start 升序（同 start 按 turn 升序）。
     * - `startTime` 不是有限数 ⇒ 丢弃该轮（无法定位）；
     * - `endTime` 缺失（轮还在跑）⇒ 用 `openEndFallback`（调用方传 Date.now()），
     *   仍无则退化成零长度，并标 `open: true`。
     */
    function collectTurnSpans (turnTimings, openEndFallback) {
      var out = [];
      var pairs = entriesOfMapLike(turnTimings);
      var fallback = numOf(openEndFallback);
      for (var i = 0; i < pairs.length; i++) {
        var key = pairs[i][0];
        var rec = pairs[i][1];
        if (rec === null || typeof rec !== "object") continue;
        var turn = numOf(Number(key));
        if (turn === null) continue;
        var start = numOf(rec.startTime);
        if (start === null) continue;
        var end = numOf(rec.endTime);
        var open = false;
        if (end === null) {
          open = true;
          end = fallback === null ? start : Math.max(fallback, start);
        }
        if (end < start) end = start;
        out.push({ turn: turn, start: start, end: end, open: open });
      }
      out.sort(function (a, b) { return (a.start - b.start) || (a.turn - b.turn); });
      return out;
    }

    /**
     * 通道 C：`useChat(s => s.timeline)` → 每个**步骤**的开始时间戳（升序）。
     *
     * 形状：
     *   timeline.turns: Map<number, TurnLocation>
     *   TurnLocation.steps: StepLocation[]；StepLocation.start: SessionEvent<'step/start'>
     *   SessionEvent.time = Unix epoch ms
     */
    function stepStartsOf (timeline) {
      var out = [];
      if (timeline === null || typeof timeline !== "object") return out;
      var turns = valuesOfMapLike(timeline.turns);
      for (var i = 0; i < turns.length; i++) {
        var turn = turns[i];
        var steps = turn !== null && typeof turn === "object" ? turn.steps : null;
        if (!Array.isArray(steps)) continue;
        for (var j = 0; j < steps.length; j++) {
          var step = steps[j];
          var startEvent = step !== null && typeof step === "object" ? step.start : null;
          var time = startEvent !== null && typeof startEvent === "object" ? numOf(startEvent.time) : null;
          if (time !== null) out.push(time);
        }
      }
      out.sort(function (a, b) { return a - b; });
      return out;
    }

    /**
     * 活跃段切分：把有序的每轮区间按**空闲阈值**合并成段。
     * 相邻间隔 `next.start - last.end <= idleMs` ⇒ 同一段；`>` 阈值 ⇒ 断开算新段。
     * 注意用的是 `<=`：间隔**恰好** 5 分钟仍算同一段（"超过 5 分钟"才断开）。
     */
    function mergeSegments (spans, idleMs) {
      var limit = numOf(idleMs);
      // 只挡非有限值与负数：`0` 在这里是**合法语义**（任何间隔都断开）。面向界面的口径由
      // `buildModel` 的归一化保证（显式 idleMs 必须落在 [60000, 1440*60000]），别在这里改语义。
      if (limit === null || limit < 0) limit = IDLE_THRESHOLD_MS;
      var ordered = cleanSpans(spans);
      ordered.sort(function (a, b) { return (a.start - b.start) || (a.turn - b.turn); });
      var segments = [];
      for (var i = 0; i < ordered.length; i++) {
        var span = ordered[i];
        var last = segments.length > 0 ? segments[segments.length - 1] : null;
        if (last !== null && (span.start - last.end) <= limit) {
          if (span.end > last.end) last.end = span.end;
          last.turns.push(span.turn);
          last.count = last.count + 1;
        } else {
          segments.push({ start: span.start, end: span.end, turns: [span.turn], count: 1 });
        }
      }
      return segments;
    }

    /**
     * 汇总：挂钟跨度 / 活跃时长 / 空闲时长 / 空闲率 / 首末时刻 / 段统计。
     * 空输入时所有时长类字段为 `null`（界面显示 —），不是 0。
     */
    function summarizeUsage (spans, idleMs) {
      var list = cleanSpans(spans);
      var segments = mergeSegments(list, idleMs);
      var first = null;
      var last = null;
      var activeMs = 0;
      var longest = null;
      for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        var dur = Math.max(0, seg.end - seg.start);
        activeMs += dur;
        if (first === null || seg.start < first) first = seg.start;
        if (last === null || seg.end > last) last = seg.end;
        if (longest === null || dur > longest) longest = dur;
      }
      var hasData = list.length > 0;
      var wallMs = hasData && first !== null && last !== null ? Math.max(0, last - first) : null;
      var idleTotal = wallMs === null ? null : Math.max(0, wallMs - activeMs);
      var idleRate = wallMs !== null && wallMs > 0 ? idleTotal / wallMs : null;
      return {
        turnCount: list.length,
        segmentCount: segments.length,
        firstAt: hasData ? first : null,
        lastAt: hasData ? last : null,
        wallMs: wallMs,
        activeMs: hasData ? activeMs : null,
        idleMs: idleTotal,
        idleRate: idleRate,
        longestSegmentMs: longest,
        avgSegmentMs: hasData && segments.length > 0 ? activeMs / segments.length : null,
        segments: segments
      };
    }

    /** 每小时柱状（量纲 = 步数）：按**本地时区**落桶，返回长度 24 的数组。 */
    function hourlyStepCounts (times) {
      var counts = [];
      for (var i = 0; i < 24; i++) counts.push(0);
      var list = Array.isArray(times) ? times : [];
      for (var j = 0; j < list.length; j++) {
        var value = numOf(list[j]);
        if (value === null) continue;
        var hour = new Date(value).getHours();
        if (hour >= 0 && hour < 24) counts[hour] = counts[hour] + 1;
      }
      return counts;
    }

    /**
     * 每小时柱状（量纲 = 活跃毫秒）：把每个 `[start, end)` 区间按整点边界切开累加。
     * 跨小时的长轮会被正确拆到两个桶里；零长度轮不计入。
     */
    function hourlyActiveMs (spans) {
      var out = [];
      for (var i = 0; i < 24; i++) out.push(0);
      var list = cleanSpans(spans);
      for (var j = 0; j < list.length; j++) {
        var span = list[j];
        var cursor = span.start;
        var end = span.end;
        while (cursor < end) {
          var at = new Date(cursor);
          var nextHour = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1, 0, 0, 0).getTime();
          if (!(nextHour > cursor)) break; // 防御：时钟回退 / DST 造成的不前进
          var cut = Math.min(end, nextHour);
          var hour = at.getHours();
          if (hour >= 0 && hour < 24) out[hour] = out[hour] + (cut - cursor);
          cursor = cut;
        }
      }
      return out;
    }

    /**
     * 紧凑时长格式（照官方 dsh-client-ui-chat 的 formatDuration 口径：
     * "45.2s under a minute, 2m42s from there on"）。
     * 缺失 / 负数 ⇒ "—"（**绝不放 NaN 上屏**）。
     */
    function formatDuration (ms) {
      var value = numOf(ms);
      if (value === null || value < 0) return EM_DASH;
      if (value < 60000) {
        var secs = value / 1000;
        // 59.95s 起四舍五入会变成 "60.0s"，进位成 "1m00s" 更稳。
        if (secs >= 59.95) return "1m00s";
        return secs.toFixed(1) + "s";
      }
      if (value < 3600000) {
        var minutes = Math.floor(value / 60000);
        var seconds = Math.round((value % 60000) / 1000);
        if (seconds === 60) { minutes = minutes + 1; seconds = 0; }
        // 同理：59m60s → "1h00m"。
        if (minutes >= 60) return "1h00m";
        return minutes + "m" + pad2(seconds) + "s";
      }
      // 同理：23h60m → "24h00m"（不截断，超长会话如实显示）。
      var hours = Math.floor(value / 3600000);
      var mins = Math.round((value % 3600000) / 60000);
      if (mins === 60) { hours = hours + 1; mins = 0; }
      return hours + "h" + pad2(mins) + "m";
    }

    /** 0..1 的比率 → "63.2%"；非有限数 ⇒ "—"。 */
    function formatPercent (rate) {
      var value = numOf(rate);
      if (value === null) return EM_DASH;
      return (value * 100).toFixed(1) + "%";
    }

    /** 计数 → 整数字符串；缺失 ⇒ "—"。 */
    function formatCount (count) {
      var value = numOf(count);
      if (value === null) return EM_DASH;
      return String(Math.round(value));
    }

    /** Unix epoch ms → 本地 "HH:MM:SS"；缺失 ⇒ "—"。 */
    function formatClock (timestamp) {
      var value = numOf(timestamp);
      if (value === null) return EM_DASH;
      var date = new Date(value);
      if (isNaN(date.getTime())) return EM_DASH;
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    }

    /**
     * 通道 B：每轮用时排序（**用时降序，同时长按轮号升序**，便于自测稳定）。
     * 返回 `[{ turn, start, end, durationMs }]`，`limit > 0` 时截断。
     */
    function rankTurns (spans, limit) {
      var list = cleanSpans(spans);
      var rows = [];
      for (var i = 0; i < list.length; i++) {
        var span = list[i];
        rows.push({
          turn: span.turn,
          start: span.start,
          end: span.end,
          durationMs: Math.max(0, span.end - span.start)
        });
      }
      rows.sort(function (a, b) { return (b.durationMs - a.durationMs) || (a.turn - b.turn); });
      var cap = numOf(limit);
      if (cap !== null && cap > 0 && rows.length > cap) return rows.slice(0, cap);
      return rows;
    }

    function clampPct (value) {
      var n = numOf(value);
      if (n === null) return 0;
      if (n < 0) return 0;
      if (n > 100) return 100;
      return n;
    }

    /**
     * 🎨 **24×7 时段计数**（周一~周日 × 0~23 时）—— 2026-10-14 按需求加的"作息画像"。
     * 桶值 = 该时段**开始的步数**。`getDay()` 里 0=周日 ⇒ 这里重排成**周一开头**（与中文习惯一致）。
     */
    function dowHourCounts (times) {
      var grid = [];
      for (var d = 0; d < 7; d++) {
        var row = [];
        for (var h = 0; h < 24; h++) row.push(0);
        grid.push(row);
      }
      var list = Array.isArray(times) ? times : [];
      for (var i = 0; i < list.length; i++) {
        var value = numOf(list[i]);
        if (value === null) continue;
        var date = new Date(value);
        var dow = (date.getDay() + 6) % 7;   // 0 = 周一 … 6 = 周日
        var hour = date.getHours();
        if (dow >= 0 && dow < 7 && hour >= 0 && hour < 24) grid[dow][hour] += 1;
      }
      return grid;
    }

    /**
     * 每步的**精确区间**：`StepLocation.start` / `end` **都有**（
     * `start: SessionEvent<'step/start'> | undefined`、`end: SessionEvent<'step/end'> | undefined`、
     * `status: 'open' | 'closed' | 'unknown'`）—— 所以步时长**不需要**"拿下一步的开始去假装"。
     * `end` 缺失（步还开着 / 事件没记）⇒ 这里给 `null`，由调用方决定怎么兜。
     */
    function stepSpansOf (timeline) {
      var out = [];
      if (timeline === null || typeof timeline !== "object") return out;
      var turns = valuesOfMapLike(timeline.turns);
      for (var i = 0; i < turns.length; i++) {
        var turn = turns[i];
        var steps = turn !== null && typeof turn === "object" ? turn.steps : null;
        if (!Array.isArray(steps)) continue;
        for (var j = 0; j < steps.length; j++) {
          var step = steps[j];
          if (step === null || typeof step !== "object") continue;
          var startEvent = step.start !== null && typeof step.start === "object" ? step.start : null;
          var endEvent = step.end !== null && typeof step.end === "object" ? step.end : null;
          var start = startEvent !== null ? numOf(startEvent.time) : null;
          if (start === null) continue;
          var end = endEvent !== null ? numOf(endEvent.time) : null;
          out.push({
            start: start,
            end: end !== null && end >= start ? end : null,
            turn: turn !== null && typeof turn === "object" ? numOf(turn.turn) : null
          });
        }
      }
      out.sort(function (left, right) { return left.start - right.start });
      return out;
    }

    /**
     * **步骤级甘特**的数据：取最近 `limit` 步。
     * 步时长**优先用宿主给的 `end`**；只有 `end` 缺失时才退回"下一步开始"（下下策），
     * 连下一步都没有就**不画这一条**（不拿假数据凑数）。
     */
    function recentStepSpans (steps, windowEnd, limit) {
      var list = Array.isArray(steps) ? steps : [];
      var clean = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item === null || typeof item !== "object") continue;
        var s = numOf(item.start);
        if (s === null) continue;
        var e = numOf(item.end);
        clean.push({ start: s, end: e !== null && e >= s ? e : null });
      }
      clean.sort(function (left, right) { return left.start - right.start });
      var cap = numOf(limit);
      var from = cap !== null && clean.length > cap ? clean.length - cap : 0;
      var tail = numOf(windowEnd);
      var out = [];
      for (var j = from; j < clean.length; j += 1) {
        var span = clean[j];
        var end = span.end;
        if (end === null || end <= span.start) {
          var nextStart = j + 1 < clean.length ? clean[j + 1].start : null;
          if (nextStart !== null && nextStart > span.start) end = nextStart;
          else if (tail !== null && tail > span.start) end = tail;
          else continue;
        }
        out.push({ start: span.start, end: end, turn: j + 1 });
      }
      return out;
    }

    /** 甘特：把每轮映射成相对域 `[domainStart, domainEnd]` 的 left/width 百分比。 */
    function ganttRows (spans, domainStart, domainEnd) {      var from = numOf(domainStart);
      var to = numOf(domainEnd);
      if (from === null || to === null || !(to > from)) return [];
      var width = to - from;
      var list = cleanSpans(spans);
      var rows = [];
      for (var i = 0; i < list.length; i++) {
        var span = list[i];
        var leftPct = clampPct(((span.start - from) / width) * 100);
        var widthPct = clampPct(((span.end - span.start) / width) * 100);
        if (widthPct < MIN_BAR_PCT) widthPct = MIN_BAR_PCT;
        var maxWidth = 100 - leftPct;
        if (widthPct > maxWidth) widthPct = maxWidth;
        rows.push({
          turn: span.turn,
          start: span.start,
          end: span.end,
          leftPct: leftPct,
          widthPct: widthPct
        });
      }
      return rows;
    }

    /** 归一化成 0..100 的高度百分比；全 0 / 有非有限值时按 0 处理（不产生 NaN）。 */
    function normalizeHeights (values) {
      var list = Array.isArray(values) ? values : [];
      var max = 0;
      for (var i = 0; i < list.length; i++) {
        var value = numOf(list[i]);
        if (value !== null && value > max) max = value;
      }
      var out = [];
      for (var j = 0; j < list.length; j++) {
        var current = numOf(list[j]);
        out.push(max > 0 && current !== null ? (current / max) * 100 : 0);
      }
      return out;
    }

    //#region §3b P2 第一步：宿主 `usageDaily` 投影（会话列表行自带）的读取与聚合
    // 数据通路：宿主 fold（lib/index.mjs）→ 投影检查点 → `session.list` 每行的
    // `projectionValues.usageDaily` → 客户端 `props.useSessions` 快照。
    // 这里只做「校验 + 跨会话求和」，**不发任何请求、不读任何会话日志**。

    /** 日键形状（与宿主同款：本地日历日）。 */
    var DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

    /**
     * 日键的**形状 + 范围**校验（月 1–12、日 1–31）—— 与宿主 `lib/index.mjs` 的
     * `isDayKey` 逐条同款，保证两边"哪些日键算数"完全一致（不然宿主给了一个键、
     * 客户端却把它算进总值，界面就会出现对不上窗口的数字）。
     */
    function isDayKey (key) {
      if (typeof key !== "string" || !DAY_KEY_RE.test(key)) return false;
      var month = Number(key.slice(5, 7));
      var day = Number(key.slice(8, 10));
      return month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }

    /**
     * Unix epoch ms → **本地时区**日历日键 `YYYY-MM-DD`；非法 ⇒ `null`。
     * 与宿主 `lib/index.mjs` 的 `dayKeyOf` 同款（用 `Date` 的本地日历字段，
     * 不用 UTC 的 `toISOString`）—— 两边时区一致，日键才对得上。
     */
    function dayKeyOf (time) {
      var value = numOf(time);
      if (value === null) return null;
      try {
        var date = new Date(value);
        if (isNaN(date.getTime())) return null;
        var year = date.getFullYear();
        if (!Number.isFinite(year) || year < 1970 || year > 9999) return null;
        return String(year) + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
      } catch (err) {
        return null;
      }
    }

    /** `YYYY-MM-DD` → 本地 0 点 Date；形状非法 / 日期不存在（如 2 月 31 日）⇒ null。 */
    function parseDayKey (key) {
      if (typeof key !== "string" || !DAY_KEY_RE.test(key)) return null;
      var year = Number(key.slice(0, 4));
      var month = Number(key.slice(5, 7));
      var day = Number(key.slice(8, 10));
      var date = new Date(year, month - 1, day, 0, 0, 0, 0);
      if (isNaN(date.getTime())) return null;
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
      return date;
    }

    /** 日键 ± N 天（跨月/跨年/闰年交给 `Date` 自己算）。 */
    function dayKeyAddDays (key, delta) {
      var date = parseDayKey(key);
      var shift = numOf(delta);
      if (date === null || shift === null) return null;
      var moved = new Date(date.getFullYear(), date.getMonth(), date.getDate() + Math.round(shift), 0, 0, 0, 0);
      return dayKeyOf(moved.getTime());
    }

    /** 日键所在周的**周一**（中文习惯：一周从周一开始）。 */
    function weekStartKeyOf (key) {
      var date = parseDayKey(key);
      if (date === null) return null;
      var dow = date.getDay(); // 0 = 周日
      return dayKeyAddDays(key, dow === 0 ? -6 : -(dow - 1));
    }

    /**
     * 宿主投影值 → 规范化账本；形状不对 ⇒ `null`（= 这个会话没有该投影）。
     *
     * 上游是**宿主的 JSON**，本插件不吃信任：坏键丢弃、负数丢弃、非有限数归零，
     * 保证返回的对象只含非负有限数 ⇒ 后面的求和/比值不可能产出 NaN。
     */
    /** 毫秒值规范化：非有限 / 负数 ⇒ `0`；超过 `MAX_SPAN_MS` ⇒ 夹到上界（挡 `MAX_SAFE_INTEGER` 这类脏值）。 */
    function spanMsOf (value) {
      var n = numOf(value);
      if (n === null || n < 0) return 0;
      return n > MAX_SPAN_MS ? MAX_SPAN_MS : n;
    }

    /** 计数值规范化：非有限 / 负数 ⇒ `0`；超过 `MAX_COUNT_VALUE` ⇒ 夹到上界。 */
    function countOf (value) {
      var n = numOf(value);
      if (n === null || n < 0) return 0;
      return n > MAX_COUNT_VALUE ? MAX_COUNT_VALUE : n;
    }

    function cleanUsageDaily (value) {
      if (value === null || typeof value !== "object") return null;
      var days = {};
      var raw = value.days;
      if (raw !== null && typeof raw === "object") {
        var keys = Object.keys(raw);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (!isDayKey(key)) continue;
          var ms = numOf(raw[key]);
          if (ms === null || ms < 0) continue;
          days[key] = ms > MAX_SPAN_MS ? MAX_SPAN_MS : ms;
        }
      }
      // A7 三期：日内外**小时桶**也要带上（K 线影线的数据源）。
      // 🩸 这里就是"新增字段要同步的地方"里最容易漏的一处：它是**客户端侧的清洗/收窄层**，
      //    漏了它 ⇒ 上面的聚合拿不到 hoursByDay ⇒ 影线永远画不出来（而**不报错**）。
      var hoursByDay = {};
      var rawHours = value.hoursByDay;
      if (rawHours !== null && typeof rawHours === "object") {
        var hDays = Object.keys(rawHours);
        for (var hd = 0; hd < hDays.length; hd += 1) {
          var hDayKey = hDays[hd];
          if (!isDayKey(hDayKey)) continue;
          var srcBucket = rawHours[hDayKey];
          if (srcBucket === null || typeof srcBucket !== "object") continue;
          var dstBucket = {};
          var hHours = Object.keys(srcBucket);
          for (var hh2 = 0; hh2 < hHours.length; hh2 += 1) {
            var hourNum = Number(hHours[hh2]);
            var hourMs = numOf(srcBucket[hHours[hh2]]);
            if (!Number.isInteger(hourNum) || hourNum < 0 || hourNum > 23) continue;
            if (hourMs === null || hourMs <= 0) continue;
            dstBucket[String(hourNum)] = hourMs > MAX_SPAN_MS ? MAX_SPAN_MS : hourMs;
          }
          if (Object.keys(dstBucket).length > 0) hoursByDay[hDayKey] = dstBucket;
        }
      }
      // A7 三期 / 宿主统计（2026-10-14）：宿主半新加的那批字段也要收窄进来 ——
      // 🩸 这一层是"最容易漏的中转层"（今晚踩过：漏了 hoursByDay 导致影线永远画不出来且不报错）。
      var byTool = {};
      var rawByTool = value.byTool;
      if (rawByTool !== null && typeof rawByTool === "object") {
        var btKeys = Object.keys(rawByTool);
        for (var bt = 0; bt < btKeys.length; bt += 1) {
          var btName = btKeys[bt];
          if (typeof btName !== "string" || btName.length === 0 || btName.length > 120) continue;
          var btBucket = rawByTool[btName];
          if (btBucket === null || typeof btBucket !== "object") continue;
          var btCalls = countOf(btBucket.calls);
          var btMs = numOf(btBucket.ms);
          if (btCalls <= 0 && (btMs === null || btMs <= 0)) continue;
          byTool[btName] = {
            calls: btCalls,
            ms: spanMsOf(btMs === null ? 0 : btMs)
          };
        }
      }
      var byModel = {};
      var turnOutcomes = {};
      var rawModel = value.byModel;
      if (rawModel !== null && typeof rawModel === "object") {
        var bmKeys = Object.keys(rawModel);
        for (var bm = 0; bm < bmKeys.length; bm += 1) {
          // 🩸 实测发现：客户端接收层也要有**键长上限**（宿主有 120，这里原来没有 ⇒ 两边口径不齐）
          if (typeof bmKeys[bm] !== "string" || bmKeys[bm].length === 0 || bmKeys[bm].length > 120) continue;
          var bmCount = countOf(rawModel[bmKeys[bm]]);
          if (bmCount > 0) byModel[bmKeys[bm]] = bmCount;
        }
      }
      var rawOutcomes = value.turnOutcomes;
      if (rawOutcomes !== null && typeof rawOutcomes === "object") {
        var toKeys = Object.keys(rawOutcomes);
        for (var to = 0; to < toKeys.length; to += 1) {
          if (typeof toKeys[to] !== "string" || toKeys[to].length === 0 || toKeys[to].length > 120) continue;
          var toCount = countOf(rawOutcomes[toKeys[to]]);
          if (toCount > 0) turnOutcomes[toKeys[to]] = toCount;
        }
      }
      // 形状留痕（诊断用）：把宿主的"我没认出来"如实带上来
      var shapes = {};
      var shapeSources = [["toolShapes", value.toolShapes], ["eventShapes", value.eventShapes]];
      for (var ss = 0; ss < shapeSources.length; ss += 1) {
        var srcShapes = shapeSources[ss][1];
        if (srcShapes === null || typeof srcShapes !== "object") continue;
        var shKeys = Object.keys(srcShapes);
        for (var sh = 0; sh < shKeys.length; sh += 1) {
          var shSig = shapeSources[ss][0] + ":" + shKeys[sh];
          var shCount = countOf(srcShapes[shKeys[sh]]);
          if (shCount > 0) shapes[shSig] = shCount;
        }
      }
      return {
        days: days,
        hoursByDay: hoursByDay,
        byTool: byTool,
        byModel: byModel,
        turnOutcomes: turnOutcomes,
        compactions: countOf(value.compactions),
        shapes: shapes,
        activeMs: spanMsOf(value.activeMs),
        turns: countOf(value.turns),
        segments: countOf(value.segments),
        longestMs: spanMsOf(value.longestMs)
      };
    }

    /**
     * 从 `useSessions` 快照里取出每个会话的账本（无该投影的会话直接跳过）。
     * 主路 = 列表行的 `row.projectionValues`；兜底 = `snapshot.projectionsBySession[id].values`
     * （同一份数据的另一处载体，宿主换了载体也能读到）。
     */
    function usageRowsOf (snapshot) {
      var out = [];
      if (snapshot === null || typeof snapshot !== "object") return out;
      var byId = snapshot.byId !== null && typeof snapshot.byId === "object" ? snapshot.byId : null;
      var perSession = snapshot.projectionsBySession !== null && typeof snapshot.projectionsBySession === "object"
        ? snapshot.projectionsBySession
        : null;
      // id 来源取并集（空载体 `[] / {}` 也兜住，见 `idListOf` 的注释）
      var ids = idListOf(snapshot, byId, perSession);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var ledger = null;
        var row = byId === null ? null : byId[id];
        if (row !== null && typeof row === "object" &&
            row.projectionValues !== null && typeof row.projectionValues === "object") {
          ledger = cleanUsageDaily(row.projectionValues[USAGE_DAILY_KEY]);
        }
        if (ledger === null && perSession !== null) {
          var entry = perSession[id];
          if (entry !== null && typeof entry === "object" &&
              entry.values !== null && typeof entry.values === "object") {
            ledger = cleanUsageDaily(entry.values[USAGE_DAILY_KEY]);
          }
        }
        if (ledger !== null) out.push(ledger);
      }
      return out;
    }

    /**
     * 跨会话求和：逐日毫秒相加、总量相加、最长取最大。
     * `hasData` 的口径：**至少有一个会话带该投影**，且它里面真有活跃段或活跃毫秒 ——
     * 这样"投影还没上线 / 老会话没缓存"就干净地落到空态，而不是画一屏 0 冒充数据。
     */
    function aggregateUsageDaily (snapshot) {
      var ledgers = usageRowsOf(snapshot);
      var agg = {
        hasData: false, sessions: 0, days: {}, hoursByDay: {},
        byTool: {}, byModel: {}, turnOutcomes: {}, compactions: 0, shapes: {},
        activeMs: 0, turns: 0, segments: 0, longestMs: 0
      };
      for (var i = 0; i < ledgers.length; i++) {
        var ledger = ledgers[i];
        // 🩸 2026-09-25 定稿：「有投影行但零活跃」的会话**不计入「覆盖会话」**。
        // 宿主会给每个**已折过账**的会话写一行（哪怕这段时间根本没干活），
        // 无条件计数只会让这个数字虚高（实测 17 个里含零活跃项）。
        if (ledger.activeMs > 0) agg.sessions += 1;
        agg.activeMs += ledger.activeMs;
        agg.turns += ledger.turns;
        agg.segments += ledger.segments;
        if (ledger.longestMs > agg.longestMs) agg.longestMs = ledger.longestMs;
        var keys = Object.keys(ledger.days);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          // 🩸 实测发现：单会话的日值钳过 `MAX_SPAN_MS`，**聚合层原来没钳** ⇒ 多会话累加会溢出
          agg.days[key] = spanMsOf(nonNegOf(agg.days[key]) + ledger.days[key]);
        }
        // A7 三期（2026-10-14）：日内外**小时桶**也要聚合 —— 它是"高频使用时段"（实体）与
        // "该时段之外"（影线）的唯一数据源。⚠️ 只对**近 90 天**有（宿主侧上限），更老的日期没有。
        var hb = ledger.hoursByDay;
        if (hb !== null && typeof hb === "object") {
          var hkeys = Object.keys(hb);
          for (var h = 0; h < hkeys.length; h += 1) {
            var hday = hkeys[h];
            if (!isDayKey(hday)) continue;
            var srcBucket = hb[hday];
            if (srcBucket === null || typeof srcBucket !== "object") continue;
            var dstBucket = agg.hoursByDay[hday];
            if (dstBucket === undefined || dstBucket === null) {
              dstBucket = {};
              agg.hoursByDay[hday] = dstBucket;
            }
            var bkeys = Object.keys(srcBucket);
            for (var b = 0; b < bkeys.length; b += 1) {
              var hourKey = bkeys[b];
              dstBucket[hourKey] = nonNegOf(dstBucket[hourKey]) + nonNegOf(srcBucket[hourKey]);
            }
          }
        }
        // A7 三期 + 宿主统计：跨会话聚合工具 / 模型 / 结束原因 / 压缩次数 / 形状留痕
        var btNames = Object.keys(ledger.byTool || {});
        for (var bt2 = 0; bt2 < btNames.length; bt2 += 1) {
          var btName2 = btNames[bt2];
          var prevTool = agg.byTool[btName2];
          if (prevTool === undefined || prevTool === null) prevTool = { calls: 0, ms: 0 };
          agg.byTool[btName2] = {
            calls: prevTool.calls + ledger.byTool[btName2].calls,
            ms: prevTool.ms + ledger.byTool[btName2].ms
          };
        }
        var bmNames = Object.keys(ledger.byModel || {});
        for (var bm2 = 0; bm2 < bmNames.length; bm2 += 1) {
          agg.byModel[bmNames[bm2]] = nonNegOf(agg.byModel[bmNames[bm2]]) + ledger.byModel[bmNames[bm2]];
        }
        var toNames = Object.keys(ledger.turnOutcomes || {});
        for (var to2 = 0; to2 < toNames.length; to2 += 1) {
          agg.turnOutcomes[toNames[to2]] = nonNegOf(agg.turnOutcomes[toNames[to2]]) + ledger.turnOutcomes[toNames[to2]];
        }
        agg.compactions += nonNegOf(ledger.compactions);
        var shNames = Object.keys(ledger.shapes || {});
        for (var sh2 = 0; sh2 < shNames.length; sh2 += 1) {
          agg.shapes[shNames[sh2]] = nonNegOf(agg.shapes[shNames[sh2]]) + ledger.shapes[shNames[sh2]];
        }
      }
      agg.hasData = ledgers.length > 0 && (agg.segments > 0 || agg.activeMs > 0);
      return agg;
    }

    /** 宿主统计卡每个榜单最多列几条（超出的要写"另有 N 条"，不许静默截断）。 */
    var HOST_RANK_LIMIT = 12;

    /**
     * **宿主统计**（A7 四项 + 工具：按工具名 / 模型 / 结束原因 / 压缩次数 + 形状留痕）→ 可直接画的行。
     *
     * ⚠️ **这张卡才是"按工具名统计"真正落地的地方** —— 宿主半只负责记账，界面不显示 = 功能等于不存在。
     */
    function buildHostStatsModel (agg, tr) {
      var empty = { hasData: false, tools: [], models: [], outcomes: [], compactionText: "", shapeRows: [], hiddenText: "", sub: "" };
      var a = agg !== null && typeof agg === "object" ? agg : null;
      if (a === null || a.hasData !== true) return empty;
      function rankOf (src, opts) {
        var out = [];
        var keys = Object.keys(src === null || typeof src !== "object" ? {} : src);
        for (var i = 0; i < keys.length; i += 1) {
          var obj = src[keys[i]];
          // 🩸 实测发现：`ms = 0` 的工具**不许整行消失** —— 0 是"超上界配对"的**诚实标记**，
          //   而"次数"本来是完全可信的。入选门槛看「耗时或次数任一 > 0」。
          var calls = typeof obj === "number" ? obj : countOf(obj.calls);
          var metric = typeof obj === "number" ? obj : (opts.msField ? nonNegOf(obj.ms) : calls);
          if (calls <= 0 && metric <= 0) continue;
          out.push({ key: keys[i], metric: metric, obj: obj });
        }
        out.sort(function (x, y) {
          if (y.metric !== x.metric) return y.metric - x.metric;
          return x.key < y.key ? -1 : (x.key > y.key ? 1 : 0);
        });
        // 🩸 实测发现：截断前**先排序**（否则同数据可能因为插入序不同而显示不同形状）
        // 🩸 实测发现：**不许静默截断** —— 另有 N 条要写出来（本项目其它截断处都有提示）
        var limit = out.length > HOST_RANK_LIMIT ? HOST_RANK_LIMIT : out.length;
        var rows = [];
        var max = out.length > 0 ? out[0].metric : 0;
        for (var j = 0; j < limit; j += 1) {
          rows.push({
            key: out[j].key,
            label: out[j].key,
            widthPct: max > 0 ? clampPct((out[j].metric / max) * 100) : 0,
            valueText: opts.format(out[j].metric, out[j].obj),
            title: opts.tip === undefined ? out[j].key : opts.tip(out[j].key, out[j].obj)
          });
        }
        return { rows: rows, more: out.length > limit ? out.length - limit : 0 };
      }
      var toolRank = rankOf(a.byTool, {
        msField: true,
        format: function (ms, obj) {
          // 耗时为 0（被配对上界归零）⇒ 显示破折号，但**次数照显**（别把可信数据一起吞掉）
          return (ms > 0 ? formatDuration(ms) : EM_DASH) + " \u00b7 " + obj.calls + tr("hs.calls");
        },
        tip: function (name, obj) { return name + " \u00b7 " + obj.calls + tr("hs.calls") + " \u00b7 " + formatDuration(obj.ms); }
      });
      var modelRank = rankOf(a.byModel, { format: function (n) { return n + tr("hs.turns"); } });
      var outcomeRank = rankOf(a.turnOutcomes, { format: function (n) { return n + tr("hs.turns"); } });
      var tools = toolRank.rows;
      var models = modelRank.rows;
      var outcomes = outcomeRank.rows;
      var hiddenTotal = toolRank.more + modelRank.more + outcomeRank.more;
      var hiddenText = hiddenTotal > 0 ? tr("hs.more") + hiddenTotal + tr("hs.moreUnit") : "";
      var shapeRows = [];
      var shapeKeys = Object.keys(a.shapes === null || typeof a.shapes !== "object" ? {} : a.shapes);
      for (var s = 0; s < shapeKeys.length && s < 8; s += 1) {
        shapeRows.push({ key: shapeKeys[s], text: shapeKeys[s] + " \u00d7 " + a.shapes[shapeKeys[s]] });
      }
      return {
        // 🩸 实测发现：**形状留痕也算数据** —— 它存在的唯一目的就是"定稿未知字段名"；
        //   若因 hasData=false 整卡不挂 ⇒ **唯一的诊断线索静默消失**（已用真 foldUsageDaily 端到端复现过）。
        hasData: tools.length > 0 || models.length > 0 || outcomes.length > 0 || a.compactions > 0 ||
          shapeRows.length > 0,
        tools: tools,
        models: models,
        outcomes: outcomes,
        compactionText: countOf(a.compactions) > 0 ? countOf(a.compactions) + tr("hs.times") : EM_DASH,
        shapeRows: shapeRows,
        hiddenText: hiddenText,
        sub: tr("hs.sub")
      };
    }

    /**
     * 聚合结果 → 日历分段**直接能画**的模型（含 KPI 文案/格式/热力档位/柱高）。
     *
     * `now` 必须是有限数（调用方传 `Date.now()` 或测试夹具的固定时刻）——
     * 「今日 / 本周 / 本月」按**浏览器本地时区**取自同一套日键，
     * 与宿主折账用的本地时区是同一条口径（host 与浏览器同机时完全一致）。
     */
    /** `'YYYY-MM'` 的前一个月（跨年正确：`'2026-01'` ⇒ `'2025-12'`）；形状不对 ⇒ null。 */
    function prevMonthPrefixOf (monthPrefix) {
      if (typeof monthPrefix !== "string" || monthPrefix.length !== 7) return null;
      var year = Number(monthPrefix.slice(0, 4));
      var month = Number(monthPrefix.slice(5, 7));
      if (!(year >= 1970 && year <= 9999) || !(month >= 1 && month <= 12)) return null;
      // 🩸 实测发现：`'1970-01'` 的前一个月是 `'1969-12'` —— 越出下界 ⇒ 宁可返回 null（不给对比）
      if (month === 1) return year <= 1970 ? null : String(year - 1) + "-12";
      return monthPrefix.slice(0, 4) + "-" + pad2(month - 1);
    }

    /**
     * 周 / 月的**环比**（A3）：和"上一整周 / 上一整个自然月"比，给箭头 + 百分比。
     * ⚠️ 上一期为 0 或不存在 ⇒ `null`（**不给涨跌**，也绝不产出 ∞% / NaN + 无意义的 "▲ 9999%"）。
     * ⚠️ 方向**只在箭头形状**上表达、颜色是中性的 —— "用时涨了"不等于"变好了"，别用红绿褒贬用户。
     */
    function deltaOf (currentMs, prevMs, prevLabel) {
      var cur = numOf(currentMs);
      var prev = numOf(prevMs);
      if (cur === null || prev === null || prev <= 0) return null;
      var ratio = (cur - prev) / prev;
      var pct = Math.round(Math.abs(ratio) * 100);
      // 🩸 实测发现：四舍五入到 0 时**不许再标方向** —— 否则「▲ 0%」同时表示"涨 0.4%"与"持平"（方向在撒谎）
      if (pct === 0) {
        return {
          text: EM_DASH,
          dir: "flat",
          aria: prevLabel + "基本持平",
          tip: prevLabel + " " + formatDuration(prev) + " \u00b7 基本持平（<0.5%）"
        };
      }
      var up = ratio >= 0;
      return {
        text: (up ? "\u25b2 " : "\u25bc ") + pct + "%",
        dir: up ? "up" : "down",
        // 🩸 实测发现：无障碍 —— 屏幕阅读器要拿到完整句子，不能只给 ▲/▼ 字形
        aria: prevLabel + (up ? "增加" : "减少") + pct + "%",
        tip: prevLabel + " " + formatDuration(prev) + " \u00b7 " + (up ? "+" : "\u2212") + pct + "%"
      };
    }

    /** `'YYYY-MM'` 这个月的天数（闰年交给 Date）；形状不对 ⇒ 0。 */
    function daysInMonthOf (monthPrefix) {
      if (typeof monthPrefix !== "string" || monthPrefix.length !== 7) return 0;
      var year = Number(monthPrefix.slice(0, 4));
      var month = Number(monthPrefix.slice(5, 7));
      if (!(year >= 1970 && year <= 9999) || !(month >= 1 && month <= 12)) return 0;
      return new Date(Date.UTC(year, month, 0)).getUTCDate();
    }

    /** 两个日键的整数天数差（`to − from`）；形状不对 ⇒ null。**按 UTC 解析** ⇒ 不受本地时区影响。 */
    function daysBetweenKeys (fromKey, toKey) {
      if (!isDayKey(fromKey) || !isDayKey(toKey)) return null;
      var from = Date.parse(fromKey + "T00:00:00Z");
      var to = Date.parse(toKey + "T00:00:00Z");
      if (!isFinite(from) || !isFinite(to)) return null;
      return Math.round((to - from) / 86400000);
    }

    /**
     * A6：**工作区趋势**（每个工作区近 `WS_TREND_WEEKS` 周的活跃，一周一根**迷你柱**）。
     * 🩸 规格明确反对折线（"会暗示插值，让人误读中间值"）⇒ 这里用柱子。
     * 口径：按 `cwd` 分组 ⇒ 把组内会话的逐日活跃按**自然周（周一起）**分桶；`> today` 的日键不算；
     * 桶下标用 `floor(daysBetweenKeys(本周起点, 日键) / 7)`（`starts[0]` 必是周一 ⇒ 对齐成立）。
     * 只列总量前 `WS_TREND_LIMIT` 个（**其余不合并**，在卡面写明还有几个）。
     */
    function buildWorkspaceTrend (rows, now, tr) {
      var list = Array.isArray(rows) ? rows : [];
      var today = dayKeyOf(now);
      var thisWeekStart = today === null ? null : weekStartKeyOf(today);
      if (today === null || thisWeekStart === null || list.length === 0) {
        return { hasData: false, rows: [], capped: 0, weeksText: "" };
      }
      var starts = [];
      for (var w = WS_TREND_WEEKS - 1; w >= 0; w -= 1) {
        var start = dayKeyAddDays(thisWeekStart, -7 * w);
        if (start !== null) starts.push(start);
      }
      if (starts.length === 0) return { hasData: false, rows: [], capped: 0, weeksText: "" };

      var byWs = {};
      var order = [];
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i];
        if (row === null || typeof row !== "object") continue;
        var cwd = typeof row.cwd === "string" ? row.cwd : "";
        var wsKey = cwd.length > 0 ? cwd : "\u0000unknown";
        var bucket = byWs[wsKey];
        if (bucket === undefined) {
          bucket = {
            key: wsKey,
            label: workspaceLabelOf(cwd, tr),
            full: cwd.length > 0 ? cwd : tr("ses.ws.unknown"),
            buckets: [],
            total: 0
          };
          for (var z = 0; z < starts.length; z += 1) bucket.buckets.push(0);
          byWs[wsKey] = bucket;
          order.push(wsKey);
        }
        var dayKeys = row.days !== null && typeof row.days === "object" ? Object.keys(row.days) : [];
        for (var k = 0; k < dayKeys.length; k += 1) {
          var key = dayKeys[k];
          if (!isDayKey(key) || key > today) continue;
          var off = daysBetweenKeys(starts[0], key);
          if (off === null || off < 0) continue;
          var idx = Math.floor(off / 7);
          if (idx < 0 || idx >= starts.length) continue;
          var amount = nonNegOf(row.days[key]);
          bucket.buckets[idx] += amount;
          bucket.total += amount;
        }
      }

      var all = [];
      for (var o = 0; o < order.length; o += 1) all.push(byWs[order[o]]);
      all.sort(function (left, right) { return right.total - left.total });
      var shown = all.slice(0, WS_TREND_LIMIT);
      var maxBucket = 0;
      for (var m = 0; m < shown.length; m += 1) {
        for (var q = 0; q < shown[m].buckets.length; q += 1) {
          if (shown[m].buckets[q] > maxBucket) maxBucket = shown[m].buckets[q];
        }
      }
      var out = [];
      for (var r = 0; r < shown.length; r += 1) {
        var item = shown[r];
        var bars = [];
        for (var b = 0; b < item.buckets.length; b += 1) {
          bars.push({
            key: "w" + b,
            ms: item.buckets[b],
            heightPct: maxBucket > 0 ? clampPct((item.buckets[b] / maxBucket) * 100) : 0,
            title: starts[b] + " \u00b7 " + formatDuration(item.buckets[b])
          });
        }
        out.push({
          key: item.key,
          label: item.label,
          full: item.full,
          totalText: formatDuration(item.total),
          bars: bars
        });
      }
      // 🩸 实测发现：**窗口内全零就不挂卡** —— 原先按"有没有建桶"判（只要有会话就给 true），
      //    于是 12 周里一点活动都没有时，界面会挂一张**全空的趋势卡**。
      var anyNonZero = false;
      for (var nz = 0; nz < out.length && !anyNonZero; nz += 1) {
        for (var nzb = 0; nzb < out[nz].bars.length; nzb += 1) {
          if (out[nz].bars[nzb].ms > 0) { anyNonZero = true; break }
        }
      }
      return {
        hasData: out.length > 0 && anyNonZero,
        rows: out,
        capped: all.length - out.length,
        weeksText: starts[0] + " \u2192 " + today
      };
    }

    /**
     * 从**小时桶**里算出当天的「**高频使用时段**」与「最早 / 最晚活动」（A7 三期，载体 = `hoursByDay`）。
     *
     * 核心段 = **最长连续非零小时段**（相邻小时都非零 ⇒ 连续）⇒ 这就是需求里的**实体**；
     * 最早 / 最晚非零小时 ⇒ 影线的两端。返回 `null` 表示这天没有小时数据（老日期或宿主未重启）。
     */
    function klineSpanOf (bucket) {
      if (bucket === null || typeof bucket !== "object") return null;
      var hours = [];
      var keys = Object.keys(bucket);
      for (var i = 0; i < keys.length; i += 1) {
        var h = Number(keys[i]);
        var ms = nonNegOf(bucket[keys[i]]);
        if (Number.isInteger(h) && h >= 0 && h <= 23 && ms > 0) hours.push(h);
      }
      if (hours.length === 0) return null;
      hours.sort(function (a, b) { return a - b; });
      var bestStart = hours[0];
      var bestEnd = hours[0];
      var curStart = hours[0];
      var curEnd = hours[0];
      for (var j = 1; j < hours.length; j += 1) {
        if (hours[j] === curEnd + 1) {
          curEnd = hours[j];
        } else {
          if (curEnd - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = curEnd; }
          curStart = hours[j];
          curEnd = hours[j];
        }
      }
      if (curEnd - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = curEnd; }
      return {
        firstHour: hours[0],
        lastHour: hours[hours.length - 1],
        coreStartHour: bestStart,
        coreEndHour: bestEnd,
        // 毫秒刻度：小时的**结束**时刻用 `(h + 1) * 3600000`
        firstMs: hours[0] * 3600000,
        lastMs: (hours[hours.length - 1] + 1) * 3600000,
        coreStartMs: bestStart * 3600000,
        coreEndMs: (bestEnd + 1) * 3600000
      };
    }

    /**
     * 🩸 **K 线画不画影线 = 一个显式开关**（实测发现：原来这里是硬编码 `var span = null;` 的死代码，
     * `hb` 变量还留着 ⇒ 日后"顺手启用"就会**重新混画两套口径**，而那正是 2026-10-14 回退的原因）。
     *
     * 启用前必须先解决"新旧数据口径不一"：日内小时桶**只有重启之后的日子才有**（且只覆盖近 90 天），
     * 所以要么**全有**（等数据齐 / 补回填）、要么**全不用** —— 绝不能混着画。
     */
    var KLINE_USE_WICKS = false;

    /** A7：K 线窗口（天）—— 每根蜡烛 = 一天。 */
    var KLINE_DAYS = 60;
    /** A7：K 线**纵轴基准 = 一天 24 小时**（2026-10-14 需求：「从低到高应该是 0-24h」）。 */
    var KLINE_AXIS_MS = 24 * 3600000;
    /**
     * 纵轴**业务上界**（实测发现：原来只有"向上取整"、没有上界 —— 单日 3.15e11 时
     * `ticks` 会算出 **7301 条**网格线，渲染节点从 143 涨到 14735）。
     * 96h = 4 天，够容纳"多会话并行"的极端日累计，同时把刻度数锁在 17 条以内。
     */
    var KLINE_AXIS_MAX_MS = 96 * 3600000;

    /**
     * A7：**K 线模型**（2026-10-14 选定 = 甲·按天；同日二改：要**真正的 K 线**而不是柱状图）。
     * 语义（本插件口径）：**开盘 = 前一天的量、收盘 = 当天的量** ⇒ **body 的长度就是"涨跌幅"**；第一天以 0 为开盘。
     * 🩸 **硬约束（必须在卡面写明）**：宿主只给**逐日**粒度 ⇒ **没有影线**（拿不到日内最高 / 最低）。
     * 纵轴 = **固定 0~24h**（一天最多就这么多）；真有超出的（多会话并行导致的日累计）刻度向上取到整 6h。
     * ⚠️ 颜色按**股市惯例：涨红跌绿**（2026-10-14 明确要的，这块是实验性功能）。
     */
    function buildKlineModel (aggregated, now, tr) {
      var empty = { hasData: false, rows: [], axisMaxMs: KLINE_AXIS_MS, ticks: [], note: tr("kline.note") };
      var agg = aggregated !== null && typeof aggregated === "object" ? aggregated : null;
      if (agg === null || agg.hasData !== true) return empty;
      var today = dayKeyOf(now);
      if (today === null) return empty;
      var days = agg.days !== null && typeof agg.days === "object" ? agg.days : {};
      var keys = [];
      for (var back = KLINE_DAYS - 1; back >= 0; back -= 1) {
        var dayKey = dayKeyAddDays(today, -back);
        if (dayKey !== null) keys.push(dayKey);
      }
      if (keys.length === 0) return empty;
      var values = [];
      var maxMs = 0;
      for (var i = 0; i < keys.length; i += 1) {
        var value = isDayKey(keys[i]) ? nonNegOf(days[keys[i]]) : 0;
        values.push(value);
        if (value > maxMs) maxMs = value;
      }
      // 纵轴：默认 0~24h；真有超出（多会话并行导致的日累计 > 24h）就向上取到整 6h，保证画得下
      var axisMax = KLINE_AXIS_MS;
      if (maxMs > axisMax) axisMax = Math.ceil(maxMs / (6 * 3600000)) * 6 * 3600000;
      // 实测发现：**再加业务上界**（否则极端输入会把 DOM 撑爆；柱子由 clampPct 夹在 100% 内）
      if (axisMax > KLINE_AXIS_MAX_MS) axisMax = KLINE_AXIS_MAX_MS;
      var ticks = [];
      var stepHours = axisMax > KLINE_AXIS_MS * 2 ? 12 : 6;
      for (var hh = 0; hh * 3600000 <= axisMax; hh += stepHours) {
        ticks.push({ key: "t" + hh, hours: hh, label: hh + "h", bottomPct: clampPct(((hh * 3600000) / axisMax) * 100) });
      }
      var rows = [];
      var hb = agg.hoursByDay !== null && typeof agg.hoursByDay === "object" ? agg.hoursByDay : {};
      for (var r = 0; r < keys.length; r += 1) {
        var close = values[r];
        var open = r > 0 ? values[r - 1] : 0;   // 开盘 = 前一天；第一天以 0 起
        var top = Math.max(open, close);
        var bottom = Math.min(open, close);
        // A7 三期（2026-10-14 需求原文：「高频使用时段长度是实线 影线是这个时段之外」）：
        //   有小时桶 ⇒ **实体 = 当天最长连续高频段**、**影线 = 该段之外的活动**（最早 / 最晚非零小时）；
        //   没有小时桶（老日期 / 宿主未重启）⇒ 退回"开 = 前一天、收 = 当天"，且**不画影线**。
        // 🩸 2026-10-14 定稿**回到无影线版**（需求原文：「还是怪怪的 要不还是改成无影线版本吧 感觉是数据冲突」）——
        //   原因说得很准：小时桶只有**重启之后**的日子才有 ⇒ 同一张图里混了两套口径
        //   （有桶的 = 实体悬在"高频段"、没桶的 = 实体从底起）⇒ 视觉上就是冲突。
        //   ⇒ 改成**显式开关** `KLINE_USE_WICKS`（默认 false）；数据链（`hoursByDay` / `klineSpanOf` / 聚合层）保留。
        var span = KLINE_USE_WICKS ? klineSpanOf(hb[keys[r]]) : null;
        var bodyTop = span === null ? top : span.coreEndMs;
        var bodyBottom = span === null ? bottom : span.coreStartMs;
        var bodyTopPct = clampPct((bodyTop / axisMax) * 100);
        var bodyBottomPct = clampPct((bodyBottom / axisMax) * 100);
        rows.push({
          key: keys[r],
          ms: close,
          openMs: open,
          // 🩸 实测发现：**第一天不许给方向** —— `open` 是硬编码 0，`close > 0` 就会被判成"涨"
          //   ⇒ 窗口 60 天滚动时**每屏必有一根假涨**。这与同项目 `deltaOf` 的「上一期为 0 / 不存在 ⇒ 不给涨跌」
          //   是同一条纪律：**没有可比对象就不许编一个方向出来**。
          dir: r === 0 ? "flat" : (close > open ? "up" : (close < open ? "down" : "flat")),
          hasSpan: span !== null,
          bottomPct: bodyBottomPct,
          heightPct: clampPct(((bodyTop - bodyBottom) / axisMax) * 100),
          wickTopPct: span === null ? null : clampPct((span.lastMs / axisMax) * 100),
          wickBottomPct: span === null ? null : clampPct((span.firstMs / axisMax) * 100),
          title: keys[r] + " \u00b7 " + tr("kline.open") + formatDuration(open) +
            " \u2192 " + tr("kline.close") + formatDuration(close) +
            (span === null ? "" : " \u00b7 " + tr("kline.core") + span.coreStartHour + ":00\u2013" + (span.coreEndHour + 1) + ":00")
        });
      }
      return { hasData: maxMs > 0, rows: rows, axisMaxMs: axisMax, ticks: ticks, note: tr("kline.note") };
    }

    function buildCalendarModel (aggregated, now, tr) {
      var empty = {
        hasData: false,
        sessions: 0,
        sessionsText: EM_DASH,
        cumKpis: [],
        segKpis: [],
        heat: [],
        bars: [],
        heatMaxMs: 0,
        note: tr("cal.note")
      };
      var agg = aggregated !== null && typeof aggregated === "object" ? aggregated : null;
      if (agg === null || agg.hasData !== true) return empty;

      var today = dayKeyOf(now);
      if (today === null) return empty;
      var weekStart = weekStartKeyOf(today);
      var monthPrefix = today.slice(0, 7);
      var days = agg.days !== null && typeof agg.days === "object" ? agg.days : {};

      var todayMs = nonNegOf(days[today]);
      var weekMs = 0;
      var monthMs = 0;
      // A3 环比：🩸 **对比期必须与本期"等长对位"** —— 否则"本月 12 天 vs 上月 31 天"会天然偏低，
      //    看着像"用户在少用"，其实是口径不等长（这是本批自己踩到并修掉的坑）。
      //    · 上周 = 上周一 ~ **上周的同一天**（本周过了 N 天 ⇒ 上周也只取 N 天）
      //    · 上月 = 上月的 1 日 ~ **本月的同一天**（上月没有该日 ⇒ 取上月最后一天）
      var prevWeekStart = weekStart !== null ? dayKeyAddDays(weekStart, -7) : null;
      var elapsedDays = weekStart !== null ? daysBetweenKeys(weekStart, today) : null;
      var prevWeekEnd = prevWeekStart !== null && elapsedDays !== null
        ? dayKeyAddDays(prevWeekStart, elapsedDays)
        : null;
      var prevWeekMs = 0;
      var prevMonthPrefix = prevMonthPrefixOf(monthPrefix);
      var todayDayOfMonth = Number(today.slice(8, 10));
      var prevMonthDays = daysInMonthOf(prevMonthPrefix);
      // 🩸 复审实测（月末假涨）：本期 31 天 vs 上月 28 天**同样**不等长 ⇒ **两边都取 `compareDays`**，
      //    否则一个每天匀速的习惯会在 3-31 那天给出「▲ 11%」的假涨。
      //    （上周天然等长：本周一~同日 vs 上周一~上周同日，不需要截断。）
      var compareDays = prevMonthPrefix !== null && prevMonthDays > 0 && isFinite(todayDayOfMonth)
        ? Math.min(todayDayOfMonth, prevMonthDays)
        : null;
      var monthStart = monthPrefix + "-01";
      var curMonthEnd = compareDays !== null && compareDays > 0 ? monthPrefix + "-" + pad2(compareDays) : null;
      var curMonthSameMs = 0;
      var prevMonthEnd = prevMonthPrefix !== null && compareDays !== null
        ? prevMonthPrefix + "-" + pad2(compareDays)
        : null;
      var prevMonthStart = prevMonthPrefix !== null ? prevMonthPrefix + "-01" : null;
      var prevMonthMs = 0;
      var keys = Object.keys(days);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        // 🩸 纵深防御（2026-09-25 实测）：下面是**字符串区间**比较，形状非法但
        // 字典序落进区间的键会被算进来 —— 最小反例 `'2026-09-22 '`（尾随空格）：
        // `'2026-09-21' <= '2026-09-22 ' <= '2026-09-25'` 为真，`slice(0,7) === '2026-09'`
        // 也为真 ⇒ 本周 / 本月双双虚增。`cleanUsageDaily` 已挡了一道，但 `agg.days` 可能
        // 不经它（手造模型 / 未来换载体）⇒ 这一层不依赖上游，自己把形状闸补上。
        if (!isDayKey(key)) continue;
        if (weekStart !== null && key >= weekStart && key <= today) weekMs += nonNegOf(days[key]);
        if (key.slice(0, 7) === monthPrefix && key <= today) monthMs += nonNegOf(days[key]);
        // A3 环比（同样受上面的 `isDayKey` 形状闸保护）
        if (prevWeekStart !== null && prevWeekEnd !== null && key >= prevWeekStart && key <= prevWeekEnd) {
          prevWeekMs += nonNegOf(days[key]);
        }
        if (prevMonthStart !== null && prevMonthEnd !== null && key >= prevMonthStart && key <= prevMonthEnd) {
          prevMonthMs += nonNegOf(days[key]);
        }
        // 本期"等长那段"（只给环比用；「本月」卡的显示值仍是 1 日至今全量）
        if (curMonthEnd !== null && key >= monthStart && key <= curMonthEnd) curMonthSameMs += nonNegOf(days[key]);
      }

      // 热力图窗口：近 12 周（含今天），档位 = 窗口内最大值分 4 档（0 = 无活动）。
      var heatKeys = [];
      for (var back = CALENDAR_HEAT_DAYS - 1; back >= 0; back--) {
        var heatKey = dayKeyAddDays(today, -back);
        if (heatKey !== null) heatKeys.push(heatKey);
      }
      var heatMaxMs = 0;
      for (var s = 0; s < heatKeys.length; s++) {
        var value = nonNegOf(days[heatKeys[s]]);
        if (value > heatMaxMs) heatMaxMs = value;
      }
      var heat = [];
      for (var h = 0; h < heatKeys.length; h++) {
        var hKey = heatKeys[h];
        var hMs = nonNegOf(days[hKey]);
        var level = 0;
        if (hMs > 0 && heatMaxMs > 0) {
          level = Math.ceil((hMs / heatMaxMs) * 4);
          if (level < 1) level = 1;
          if (level > 4) level = 4;
        }
        heat.push({
          key: hKey,
          ms: hMs,
          level: level,
          title: hKey + " · " + formatDuration(hMs)
        });
      }

      // 柱状窗口：近 14 天（热力图窗口的尾巴），高度按窗口内最大值归一化。
      var barKeys = heatKeys.slice(Math.max(0, heatKeys.length - CALENDAR_BAR_DAYS));
      var barValues = [];
      for (var b = 0; b < barKeys.length; b++) barValues.push(nonNegOf(days[barKeys[b]]));
      var barHeights = normalizeHeights(barValues);
      var bars = [];
      for (var c = 0; c < barKeys.length; c++) {
        bars.push({
          key: barKeys[c],
          label: barKeys[c].slice(5),
          ms: barValues[c],
          heightPct: barHeights[c],
          title: barKeys[c] + " · " + formatDuration(barValues[c])
        });
      }

      var segments = nonNegOf(agg.segments);
      var avgMs = segments > 0 ? nonNegOf(agg.activeMs) / segments : null;
      return {
        hasData: true,
        sessions: agg.sessions,
        sessionsText: formatCount(agg.sessions),
        cumKpis: [
          { key: "today", label: tr("cal.today"), sub: tr("cal.todaySub"), value: formatDuration(todayMs) },
          {
            key: "week",
            label: tr("cal.week"),
            sub: tr("cal.weekSub"),
            value: formatDuration(weekMs),
            delta: deltaOf(weekMs, prevWeekMs, tr("cal.prevWeek"))
          },
          {
            key: "month",
            label: tr("cal.month"),
            sub: tr("cal.monthSub"),
            value: formatDuration(monthMs),
            delta: deltaOf(curMonthSameMs, prevMonthMs, tr("cal.prevMonth"))
          }
        ],
        segKpis: [
          { key: "longest", label: tr("cal.longest"), sub: tr("cal.longestSub"), value: formatDuration(nonNegOf(agg.longestMs)) },
          { key: "avg", label: tr("cal.avg"), sub: tr("cal.avgSub"), value: formatDuration(avgMs) },
          { key: "count", label: tr("cal.count"), sub: tr("cal.countSub"), value: formatCount(segments) }
        ],
        heat: heat,
        bars: bars,
        heatMaxMs: heatMaxMs,
        // A4：数值版的本周 / 本月（进度与环比都要算，别去解析展示文本）
        weekMsRaw: weekMs,
        monthMsRaw: monthMs,
        note: tr("cal.note")
      };
    }

    // —— P2 第三步：「会话」页的数据层（**逐会话**保留身份，不求总和）——

    /**
     * 取某个会话的账本（没有该投影 ⇒ `null`）。主路 = 列表行的 `projectionValues`；
     * 兜底 = `snapshot.projectionsBySession[id].values`（宿主换了载体也能读到）。
     * `usageRowsOf` 与 `collectSessionUsage` **共用这一处取数逻辑**，两侧口径才一致。
     */
    function ledgerAt (snapshot, id, byId, perSession) {
      var row = byId === null ? null : byId[id];
      if (row !== null && typeof row === "object" &&
          row.projectionValues !== null && typeof row.projectionValues === "object") {
        var direct = cleanUsageDaily(row.projectionValues[USAGE_DAILY_KEY]);
        if (direct !== null) return direct;
      }
      if (perSession !== null) {
        var entry = perSession[id];
        if (entry !== null && typeof entry === "object" &&
            entry.values !== null && typeof entry.values === "object") {
          return cleanUsageDaily(entry.values[USAGE_DAILY_KEY]);
        }
      }
      return null;
    }

    /**
     * 快照里的会话 id 列表 = `ids` / `byId` 的键 / `projectionsBySession` 的键的**并集**。
     *
     * 🩸 为什么是并集、而不是 `else if` 链：宿主可能下发 `ids: []` 或 `byId: {}` 这类**空载体**，
     * 而数据其实在 `projectionsBySession` 里 —— 链式兜底会把"存在但为空"当成"已经有来源"，
     * 于是两条通路都一条会话都列不出来，页面"干净地"落空态却看不出是形状变了（实测发现）。
     * 并集还顺带保证：`ids` 是权威列表时不丢、是空壳时也不挡路。
     */
    function idListOf (snapshot, byId, perSession) {
      // ⚠️ **按长度逐级兜底**（不是"把三个来源并起来"）：`ids` 是权威列表时**只信它** ——
      // 并集会把 `byId` / `projectionsBySession` 里**不在 `ids` 上**的键也列出来（还会虚增 `uncovered`），
      // 那是我们无权自作主张的语义扩张（实测确认）。只有上一级**为空**（含 `[]` / `{}` 这类空载体）时
      // 才降到下一级 —— 既保住上面的兜底，又不动"权威列表说了算"的旧语义。
      var ids = Array.isArray(snapshot.ids) ? snapshot.ids : [];
      if (ids.length === 0 && byId !== null) ids = Object.keys(byId);
      if (ids.length === 0 && perSession !== null) ids = Object.keys(perSession);
      return ids;
    }

    /** 会话行的人类可读名，照宿主 `SessionSummary` 的口径：`displayTitle` → `title` → `id`。 */
    function sessionTitleOf (row, id) {
      if (row !== null && typeof row === "object") {
        if (typeof row.displayTitle === "string" && row.displayTitle.length > 0) return row.displayTitle;
        if (typeof row.title === "string" && row.title.length > 0) return row.title;
      }
      return id;
    }

    /**
     * 会话列表快照 → **逐会话**的清单（会话页的数据层）。
     *
     * 与 `aggregateUsageDaily` 的区别：那个把所有人的账加成一个数（日历页要总和），
     * 这个**保留每个会话的身份与归属**（会话页要排名、分组、按天铺开）。
     *
     * 口径：**没有 `usageDaily` 投影的会话不进清单**，只计进 `uncovered` ——
     * 界面把"还有多少个没覆盖"写在脚注里（信息不丢，但不铺一屏空行）。
     */
    function collectSessionUsage (snapshot) {
      var result = { rows: [], uncovered: 0 };
      if (snapshot === null || typeof snapshot !== "object") return result;
      var byId = snapshot.byId !== null && typeof snapshot.byId === "object" ? snapshot.byId : null;
      var perSession = snapshot.projectionsBySession !== null && typeof snapshot.projectionsBySession === "object"
        ? snapshot.projectionsBySession
        : null;
      // id 来源取并集（不是 else-if 链）：空载体 + 数据在 `projectionsBySession` 时也列得出
      var ids = idListOf(snapshot, byId, perSession);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (typeof id !== "string" || id.length === 0) continue;
        var row = byId === null ? null : byId[id];
        var ledger = ledgerAt(snapshot, id, byId, perSession);
        if (ledger === null) { result.uncovered += 1; continue }
        var record = row !== null && typeof row === "object" ? row : null;
        var cwd = record !== null && typeof record.cwd === "string" && record.cwd.length > 0
          ? record.cwd.slice(0, MAX_WORKSPACE_LEN)
          : "";
        var lastDay = null;
        var keys = Object.keys(ledger.days);
        for (var k = 0; k < keys.length; k++) {
          if (lastDay === null || keys[k] > lastDay) lastDay = keys[k];
        }
        result.rows.push({
          id: id,
          title: sessionTitleOf(record, id),
          cwd: cwd,
          isSubagent: record !== null && record.origin === "subagent",
          running: record !== null && record.running === true,
          updatedAt: record !== null ? numOf(record.updatedAt) : null,
          days: ledger.days,
          activeMs: ledger.activeMs,
          turns: ledger.turns,
          segments: ledger.segments,
          longestMs: ledger.longestMs,
          lastDay: lastDay
        });
      }
      return result;
    }

    /** 工作区短名：取路径最后一段（`D:\a\b` ⇒ `b`）；空 ⇒ 「未知工作区」。 */
    function workspaceLabelOf (cwd, tr) {
      if (typeof cwd !== "string" || cwd.length === 0) return tr("ses.ws.unknown");
      var parts = cwd.split(/[\\/]+/);
      var last = "";
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) last = parts[i];
      }
      return last.length > 0 ? last : cwd;
    }

    /** 日键 → `MM-DD`（清单里要短）；形状不对 ⇒ `—`。 */
    function shortDayOf (key) {
      return typeof key === "string" && key.length === 10 ? key.slice(5) : EM_DASH;
    }

    /**
     * 🎨 **强度色阶**（2026-10-14 按需求加：「会话可以按照每天多长给分段标颜色」）：
     * 1~4 档 → 蓝 → 青 → 绿 → 黄（与日历热力图同一套色相，三处一致）。
     * ⚠️ 这是**颜色 = 量级**的编码，和 A 视图的"工作区组色"是两个不同维度 ——
     *    格子里是"这天多长"，行首色点是"这是哪个工作区"，别混。
     */
    function heatVarOf (level) {
      var slots = ["--ut-c1", "--ut-c5", "--ut-c2", "--ut-c3"];
      var lv = Math.round(nonNegOf(level));
      if (lv < 1) return "";
      if (lv > 4) lv = 4;
      return slots[lv - 1];
    }

    /** 活动量 → 0..4 档。相对**全局最大单日**归一（跨会话可比，不是各比各的）。 */
    function heatLevelOf (ms, maxMs) {
      if (!(ms > 0) || !(maxMs > 0)) return 0;
      var ratio = ms / maxMs;
      if (ratio >= 0.75) return 4;
      if (ratio >= 0.5) return 3;
      if (ratio >= 0.25) return 2;
      return 1;
    }

    /** 会话行的时间文案（段数 / 轮数是**全日志总量**，与窗口无关 —— 口径必须说清）。 */
    function metaTextOf (row, tr) {
      return shortDayOf(row.lastDay) + " · " + formatCount(row.segments) + tr("ses.segUnit") +
        " · " + formatCount(row.turns) + tr("ses.turnUnit");
    }

    /**
     * A 视图的一行（含比例条长度，相对全局最大会话）。
     * `colorIndex` = **该行所属工作区**的分组序号 ⇒ 行内用 `--ut-ses-c` 拿到自己的数据色
     * （🎨 多彩只用在"分类"这个维度上：一个工作区一个色，不是乱上色）。
     */
    function sessionRowModel (row, maxMs, tr, colorIndex) {
      var pct = maxMs > 0 ? clampPct((row.activeMs / maxMs) * 100) : 0;
      if (row.activeMs > 0 && pct < MIN_BAR_PCT) pct = MIN_BAR_PCT;
      return {
        id: row.id,
        title: row.title,
        activeText: formatDuration(row.activeMs),
        totalText: formatDuration(row.totalMs),
        metaText: metaTextOf(row, tr),
        barPct: pct,
        isSubagent: row.isSubagent,
        running: row.running,
        colorVar: "--ut-c" + ((nonNegOf(colorIndex) % 6) + 1),
        tip: row.title + " · " + tr("ses.winTotal") + " " + formatDuration(row.activeMs) +
          " · " + tr("ses.allTotal") + " " + formatDuration(row.totalMs) + " · " + metaTextOf(row, tr) +
          (row.cwd.length > 0 ? " · " + row.cwd : "")
      };
    }

    /** C 视图右栏：选中会话的逐日结构（宿主只给逐日 ⇒ 这里也只有逐日，不许假装逐段）。 */
    function detailModelOf (row, bandDays, tr, colorIndex) {
      var maxDay = 0;
      for (var i = 0; i < bandDays.length; i += 1) {
        var ms = bandDays[i] !== null ? nonNegOf(row.days[bandDays[i]]) : 0;
        if (ms > maxDay) maxDay = ms;
      }
      var dayBars = [];
      for (var b = 0; b < bandDays.length; b += 1) {
        var key = bandDays[b];
        var value = key !== null ? nonNegOf(row.days[key]) : 0;
        dayBars.push({
          key: key === null ? "d" + b : key,
          label: key === null ? EM_DASH : shortDayOf(key),
          heightPct: maxDay > 0 ? clampPct((value / maxDay) * 100) : 0,
          level: heatLevelOf(value, maxDay),   // 🎨 颜色 = 这天多长（强度色阶）
          title: (key === null ? EM_DASH : key) + " · " + formatDuration(value)
        });
      }
      return {
        id: row.id,
        title: row.title,
        fullPath: row.cwd.length > 0 ? row.cwd : tr("ses.ws.unknown"),
        isSubagent: row.isSubagent,
        running: row.running,
        activeText: formatDuration(row.activeMs),
        totalText: formatDuration(row.totalMs),
        segText: formatCount(row.segments),
        turnText: formatCount(row.turns),
        longestText: formatDuration(row.longestMs),
        lastText: shortDayOf(row.lastDay),
        colorVar: "--ut-c" + ((nonNegOf(colorIndex) % 6) + 1),
        dayBars: dayBars
      };
    }

    /**
     * 会话清单 → 三个视图**直接能画**的模型。
     *
     * 口径（必须与界面上写的一致）：
     *   · **时长按所选窗口**（近 7 / 30 天 / 全部）逐日相加；
     *   · **段数 / 轮数 / 最长段是宿主的全日志总量**（投影只给总量，没有逐日分解）⇒ 不随窗口变；
     *   · 三者混在一起会自相矛盾 ⇒ 界面上把两类口径分开写，别合成一个数。
     * 拿不到任何一行（投影没上线 / 老会话没缓存）⇒ `hasData=false`，界面保持空态（值一律 `—`）。
     */
    function buildSessionsModel (collected, options, now, tr) {
      var input = collected !== null && typeof collected === "object" ? collected : null;
      var rows = input !== null && Array.isArray(input.rows) ? input.rows : [];
      var uncovered = input !== null ? nonNegOf(input.uncovered) : 0;
      var opts = options !== null && typeof options === "object" ? options : {};

      var view = DEFAULT_SESSION_VIEW;
      for (var v = 0; v < SESSION_VIEWS.length; v++) {
        if (SESSION_VIEWS[v].key === opts.view) view = SESSION_VIEWS[v].key;
      }
      var windowDays = DEFAULT_SESSION_WINDOW;
      var askedWindow = typeof opts.windowDays === "number" && isFinite(opts.windowDays) ? opts.windowDays : null;
      if (askedWindow !== null) {
        for (var w = 0; w < SESSION_WINDOWS.length; w++) {
          if (Number(SESSION_WINDOWS[w].value) === askedWindow) windowDays = Number(SESSION_WINDOWS[w].value);
        }
      }
      var workspace = typeof opts.workspace === "string" ? opts.workspace.slice(0, MAX_WORKSPACE_LEN) : "";

      var viewOptions = [];
      for (var vo = 0; vo < SESSION_VIEWS.length; vo++) {
        viewOptions.push({
          value: SESSION_VIEWS[vo].key,
          label: tr(SESSION_VIEWS[vo].label),
          title: tr(SESSION_VIEWS[vo].label + ".hint"),
          active: SESSION_VIEWS[vo].key === view
        });
      }
      var windowOptions = [];
      for (var wo = 0; wo < SESSION_WINDOWS.length; wo++) {
        windowOptions.push({
          value: SESSION_WINDOWS[wo].value,
          label: tr(SESSION_WINDOWS[wo].label),
          active: Number(SESSION_WINDOWS[wo].value) === windowDays
        });
      }
      // 显示范围：与时间窗同一条解析口径（只认白名单），但**语义独立**（见 SESSION_RANGES 的注释）
      var rangeDays = DEFAULT_SESSION_RANGE;
      var askedRange = typeof opts.rangeDays === "number" && isFinite(opts.rangeDays) ? opts.rangeDays : null;
      if (askedRange !== null) {
        for (var rr = 0; rr < SESSION_RANGES.length; rr += 1) {
          if (Number(SESSION_RANGES[rr].value) === askedRange) rangeDays = Number(SESSION_RANGES[rr].value);
        }
      }
      var rangeOptions = [];
      for (var ro = 0; ro < SESSION_RANGES.length; ro += 1) {
        rangeOptions.push({
          value: SESSION_RANGES[ro].value,
          label: tr(SESSION_RANGES[ro].label),
          title: tr("ses.range.title"),
          active: Number(SESSION_RANGES[ro].value) === rangeDays
        });
      }

      var empty = {
        hasData: false,
        uncovered: uncovered,
        capped: 0,
        view: view,
        viewOptions: viewOptions,
        windowOptions: windowOptions,
        rangeOptions: rangeOptions,
        wsOptions: [{ value: "", label: tr("ses.ws.all"), active: workspace === "" }],
        windowDays: windowDays,
        rangeDays: rangeDays,
        workspace: workspace,
        countText: EM_DASH,
        totalText: EM_DASH,
        windowHint: "",
        groups: [],
        bands: [],
        bandAxis: [],
        listRows: [],
        selected: null,
        note: tr("ses.emptyNote"),
        caliber: tr("ses.caliber")
      };
      if (rows.length === 0) return empty;

      var today = dayKeyOf(now);
      var windowStart = windowDays > 0 && today !== null ? dayKeyAddDays(today, -(windowDays - 1)) : null;
      // 🩸 显示范围按**最后活动日**过滤（2026-10-14 定稿）：太久没动的会话**不进清单** ——
      //    注意是在 ① 这一步就过滤掉，所以它连"全局基准"与工作区候选都不参与
      //    （否则用户看不到的会话却在决定条长，又是一种"界面说谎"）。
      var rangeStart = rangeDays > 0 && today !== null ? dayKeyAddDays(today, -(rangeDays - 1)) : null;
      var outsideRange = 0;

      // ① 先算「窗口内毫秒」（时长口径）；段数 / 轮数 / 最长段保持全日志总量
      var prepared = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (rangeStart !== null && (row.lastDay === null || row.lastDay < rangeStart)) {
          outsideRange += 1;
          continue;
        }
        var ms = 0;
        var keys = Object.keys(row.days);
        for (var k = 0; k < keys.length; k += 1) {
          var key = keys[k];
          if (windowStart !== null && key < windowStart) continue;
          if (today !== null && key > today) continue;
          ms += nonNegOf(row.days[key]);
        }
        prepared.push({
          id: row.id,
          title: row.title,
          cwd: row.cwd,
          isSubagent: row.isSubagent,
          running: row.running,
          days: row.days,
          activeMs: ms,
          totalMs: nonNegOf(row.activeMs),
          turns: nonNegOf(row.turns),
          segments: nonNegOf(row.segments),
          longestMs: nonNegOf(row.longestMs),
          lastDay: row.lastDay
        });
      }

      // ② 工作区候选（按窗口内总量降序）；「全部」永远排第一
      var wsTotals = {};
      var wsOrder = [];
      for (var p = 0; p < prepared.length; p += 1) {
        var cwdKey = prepared[p].cwd;
        if (!Object.prototype.hasOwnProperty.call(wsTotals, cwdKey)) { wsTotals[cwdKey] = 0; wsOrder.push(cwdKey) }
        wsTotals[cwdKey] += prepared[p].activeMs;
      }
      wsOrder.sort(function (left, right) { return wsTotals[right] - wsTotals[left] });
      var wsOptions = [{ value: "", label: tr("ses.ws.all"), active: workspace === "" }];
      for (var wsI = 0; wsI < wsOrder.length; wsI += 1) {
        var wsKey = wsOrder[wsI];
        wsOptions.push({
          value: wsKey,
          label: workspaceLabelOf(wsKey, tr) + " " + formatDuration(wsTotals[wsKey]),
          title: wsKey.length > 0 ? wsKey : tr("ses.ws.unknown"),
          active: workspace === wsKey
        });
      }

      // ③ 工作区筛 + 排序（窗口内时长降序，同长按 id 升序 ⇒ 稳定，不会每次刷新乱跳）
      var visible = [];
      for (var q = 0; q < prepared.length; q += 1) {
        if (workspace !== "" && prepared[q].cwd !== workspace) continue;
        visible.push(prepared[q]);
      }
      visible.sort(function (left, right) {
        if (right.activeMs !== left.activeMs) return right.activeMs - left.activeMs;
        return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
      });

      // ③b 汇总 / 截断 / 全局基准
      //
      // 🩸 三个数字（卡头计数 / 卡头合计 / 列表行数）必须自洽：
      //    · 卡头合计 = `visible`（筛选后全集）的合计；
      //    · **A 视图不参与截断**：按全局 40 条截断会**把排在 40 名之后的整个工作区抹掉**
      //      （工作区下拉里却还列着它），而且组头合计会与卡头合计当面打架（实测发现）
      //      ⇒ A 视图列全部会话（容器加 `max-height` + 滚动，见 `.ut-ses-groups`）；
      //    · **B / C 视图按 `SESSION_LIST_LIMIT` 截断**（`shown`），脚注写清"前 40 / 另有 N"。
      // 🩸 条长 / 档位的基准取**全部会话**（`prepared`）的最大值，而不是"筛选后可见集合"的 ——
      //    筛选只改"看得到谁"，不改"深浅的含义"；否则同一个会话在筛不筛工作区时条长会从 1% 跳到 100%。
      var totalMs = 0;
      for (var tv = 0; tv < visible.length; tv += 1) totalMs += visible[tv].activeMs;
      var visibleTotalMs = 0;
      for (var vt = 0; vt < visible.length; vt += 1) visibleTotalMs += visible[vt].totalMs;
      var baseMaxMs = 0;
      for (var pm = 0; pm < prepared.length; pm += 1) {
        if (prepared[pm].activeMs > baseMaxMs) baseMaxMs = prepared[pm].activeMs;
      }
      var shown = visible.length > SESSION_LIST_LIMIT ? visible.slice(0, SESSION_LIST_LIMIT) : visible;
      var capped = visible.length - shown.length;

      // ③c 四种"空"必须分开表述（口径不同，不能拿"读不到投影"去解释"筛选没中"）：
      //    `workspaceMiss` = 有数据、但工作区筛不中 ⇒ 切「全部」时间窗没用，要换工作区；
      //    `windowEmpty`   = 工作区筛中了、窗口内没有活跃、但**账上还有历史** ⇒ 切「全部」有效；
      //    `zeroActive`    = 窗口内 0、且**连全日志总量都是 0**（宿主投影里就是全零）⇒ 切「全部」也没用，
      //                      必须直说"就是没有活跃记录"，不许再给"切全部"的错误指引（实测发现）。
      var emptyKind = "ok";
      if (visible.length === 0) {
        // 一条都没进来：根因优先级 = 显示范围挡光 > 工作区筛不中 > 其余（理论上到不了这里）
        if (prepared.length === 0 && outsideRange > 0) emptyKind = "rangeEmpty";
        else if (workspace !== "") emptyKind = "workspaceMiss";
        else emptyKind = "zeroActive";
      } else if (totalMs === 0) {
        // 有会话行、但所选时间窗内一点活跃都没有：还在范围内 ⇒ 切「全部」有效；连全日志都是 0 ⇒ 说清没用
        if (windowDays > 0 && visibleTotalMs > 0) emptyKind = "windowEmpty";
        else emptyKind = "zeroActive";
      }

      // ④ A 视图：按工作区分组（组按总量降序、组内按时长降序）—— **不参与截断**（见 ③b）
      var groupOf = {};
      var groupKeys = [];
      for (var g = 0; g < visible.length; g += 1) {
        var gk = visible[g].cwd;
        if (!Object.prototype.hasOwnProperty.call(groupOf, gk)) {
          groupOf[gk] = {
            key: gk,
            label: workspaceLabelOf(gk, tr),
            fullPath: gk.length > 0 ? gk : tr("ses.ws.unknown"),
            sessionTotal: 0,
            sessions: []
          };
          groupKeys.push(gk);
        }
        groupOf[gk].sessionTotal += visible[g].activeMs;
        groupOf[gk].sessions.push(visible[g]);
      }
      groupKeys.sort(function (left, right) { return groupOf[right].sessionTotal - groupOf[left].sessionTotal });
      var groups = [];
      var cwdColor = {};   // 🎨 cwd → 分组色号（B / C 视图要与 A 视图**同色**，一眼能对上）
      for (var gi = 0; gi < groupKeys.length; gi += 1) {
        var group = groupOf[groupKeys[gi]];
        var groupColor = gi % 6;   // 🎨 分组配色：6 色循环（工作区 = 天然的分类维度）
        cwdColor[group.key] = groupColor;
        var groupSessions = [];
        for (var si = 0; si < group.sessions.length; si += 1) {
          groupSessions.push(sessionRowModel(group.sessions[si], baseMaxMs, tr, groupColor));
        }
        groups.push({
          key: group.key,
          label: group.label,
          fullPath: group.fullPath,
          totalText: formatDuration(group.sessionTotal),
          ms: group.sessionTotal,
          colorVar: "--ut-c" + (groupColor + 1),
          sessions: groupSessions
        });
      }

      // ⑤ B 视图：逐日活动带（列 = 近 SESSION_BAND_DAYS 天；强度相对**全局最大单日**归一）
      var bandDays = [];
      var bandAxis = [];
      for (var d = SESSION_BAND_DAYS - 1; d >= 0; d -= 1) {
        var dayKey = today !== null ? dayKeyAddDays(today, -d) : null;
        bandDays.push(dayKey);
        if (dayKey !== null) bandAxis.push({ key: dayKey, label: shortDayOf(dayKey) });
      }
      // 基准同样取**全部会话**（不是筛选后的可见集合）—— 与 A 视图同一条口径
      var bandMax = 0;
      for (var b = 0; b < prepared.length; b += 1) {
        for (var bd = 0; bd < bandDays.length; bd += 1) {
          var dayMs = bandDays[bd] !== null ? nonNegOf(prepared[b].days[bandDays[bd]]) : 0;
          if (dayMs > bandMax) bandMax = dayMs;
        }
      }
      var bands = [];
      for (var bi = 0; bi < shown.length; bi += 1) {
        var bandRow = shown[bi];
        var cells = [];
        for (var ci = 0; ci < bandDays.length; ci += 1) {
          var cellKey = bandDays[ci];
          var cellMs = cellKey !== null ? nonNegOf(bandRow.days[cellKey]) : 0;
          cells.push({
            key: cellKey === null ? "d" + ci : cellKey,
            level: heatLevelOf(cellMs, bandMax),
            title: (cellKey === null ? EM_DASH : cellKey) + " · " + formatDuration(cellMs)
          });
        }
        bands.push({
          id: bandRow.id,
          title: bandRow.title,
          isSubagent: bandRow.isSubagent,
          totalText: formatDuration(bandRow.activeMs),
          metaText: metaTextOf(bandRow, tr),
          colorVar: "--ut-c" + ((cwdColor[bandRow.cwd] === undefined ? 0 : cwdColor[bandRow.cwd]) + 1),
          cells: cells
        });
      }

      // ⑥ C 视图：左栏列表 + 右栏选中会话的逐日结构
      var selectedId = typeof opts.selectedId === "string" ? opts.selectedId : "";
      var selectedRow = null;
      for (var sr = 0; sr < visible.length; sr += 1) {
        if (visible[sr].id === selectedId) { selectedRow = visible[sr]; break }
      }
      if (selectedRow === null && shown.length > 0) selectedRow = shown[0];
      // 🩸 选中的会话若落在截断区（40 名之外）⇒ **把它挤进列表**：
      //    否则左栏 40 项里一项都不是它、右栏却显示它 ⇒ 用户看到的是"自己选的会话不见了"（实测发现）。
      var selectedPinned = false;
      if (selectedRow !== null && shown !== visible && shown.indexOf(selectedRow) === -1) {
        shown = shown.slice(0, SESSION_LIST_LIMIT - 1).concat([selectedRow]);
        selectedPinned = true;   // ⇒ 脚注要追加"你选中的已置顶"，否则"只列出前 40 个"字面不成立（复审 D）
      }
      var listRows = [];
      for (var li = 0; li < shown.length; li += 1) {
        listRows.push({
          id: shown[li].id,
          title: shown[li].title,
          activeText: formatDuration(shown[li].activeMs),
          isSubagent: shown[li].isSubagent,
          colorVar: "--ut-c" + ((cwdColor[shown[li].cwd] === undefined ? 0 : cwdColor[shown[li].cwd]) + 1),
          active: selectedRow !== null && shown[li].id === selectedRow.id
        });
      }

      // —— ⑦b A5 子代理构成 ——
      // 口径：**按当前筛选 / 显示范围之后的清单**算（与卡头"531 个会话"同源），
      // 否则会出现"卡头 531、子代理 400"这种对不上的数。宿主判定 = `record.origin === "subagent"`。
      var subSessions = 0;
      var subActiveMs = 0;
      var allActiveMs = 0;
      for (var sa = 0; sa < visible.length; sa += 1) {
        var saActive = nonNegOf(visible[sa].activeMs);
        allActiveMs += saActive;
        if (visible[sa].isSubagent === true) {
          subSessions += 1;
          subActiveMs += saActive;
        }
      }
      var subagentStats = {
        sessions: visible.length,
        subSessions: subSessions,
        countPct: visible.length > 0 ? clampPct((subSessions / visible.length) * 100) : 0,
        subActiveMs: subActiveMs,
        allActiveMs: allActiveMs,
        activePct: allActiveMs > 0 ? clampPct((subActiveMs / allActiveMs) * 100) : 0,
        countText: formatCount(subSessions) + " / " + formatCount(visible.length),
        activeText: formatDuration(subActiveMs) + " / " + formatDuration(allActiveMs)
      };

      return {
        hasData: true,
        uncovered: uncovered,
        capped: capped,
        subagentStats: subagentStats,
        emptyKind: emptyKind,
        selectedPinned: selectedPinned,
        view: view,
        viewOptions: viewOptions,
        windowOptions: windowOptions,
        rangeOptions: rangeOptions,
        wsOptions: wsOptions,
        windowDays: windowDays,
        rangeDays: rangeDays,
        workspace: workspace,
        countText: String(visible.length) + tr("ses.sessions"),
        totalText: formatDuration(totalMs),
        totalMsRaw: totalMs,
        windowHint: emptyKind === "windowEmpty" ? tr("ses.windowEmpty") : "",
        pickHint: emptyKind === "workspaceMiss" ? tr("ses.emptyPick") : "",
        zeroHint: emptyKind === "zeroActive" ? tr("ses.zeroActive") : "",
        rangeHint: emptyKind === "rangeEmpty" ? tr("ses.rangeEmpty") : "",
        groups: groups,
        bands: bands,
        bandAxis: bandAxis,
        listRows: listRows,
        subagentStats: subagentStats,
        selected: selectedRow !== null ? detailModelOf(selectedRow, bandDays, tr, cwdColor[selectedRow.cwd]) : null,
        note: tr("ses.note"),
        caliber: tr("ses.caliber")
      };
    }

    //#endregion

    // —— P1.1 偏好（设置分段）——
    // 全程**零异常外溢**：隐私模式 / 沙箱 / 无 DOM 环境下 localStorage 连"读属性"都可能抛，
    // 所以每个入口都包 try/catch，失败一律静默回退默认值（规格硬要求）。

    /**
     * 空闲阈值的**上界**（分钟）：1440 = 24 小时。
     * 为什么必须有：`numOf` 只挡 NaN/Infinity，`1e308` 是有限数 ⇒ `1e308 * 60000` 溢出成
     * `Infinity`，违反"绝不产出非有限数"。越界一律**静默回退默认值**（不是 clamp）——
     * 与其它坏值（NaN / 负数 / 字符串）同一条口径：坏输入 = 用默认口径，界面显示的值
     * 与真正生效的值永远一致。
     */
    var MAX_IDLE_MINUTES = 1440;
    /** 时区名长度上界（合法 IANA 名最长不过 ~32 字符）。 */
    var MAX_TZ_LEN = 64;
    /** 已判定合法的时区名缓存（`Intl.DateTimeFormat` 构造不便宜，而校验会被反复调用）。 */
    var TZ_OK_CACHE = Object.create(null);

    /**
     * **真校验**时区名：`new Intl.DateTimeFormat(..., { timeZone })` 构造不抛 = 合法
     * （`Not/AZone` / 控制字符 / 超长串一律抛 ⇒ 回退默认值）。限长先于构造，
     * 避免拿 1e6 字符的串去喂 Intl。没有 `Intl`（极老环境 / 无 ICU）时降级为
     * "非空 + 限长"的宽松校验 —— **校验本身不许把渲染打崩**。
     */
    function isValidTimezone (value) {
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_TZ_LEN) return false;
      if (TZ_OK_CACHE[value] === true) return true;
      try {
        if (typeof Intl === "undefined" || Intl === null ||
            typeof Intl.DateTimeFormat !== "function") return true;
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        TZ_OK_CACHE[value] = true;
        return true;
      } catch (err) {
        return false;
      }
    }

    /** 取全局 localStorage；拿不到（无 DOM / SSR / 被禁）⇒ null。 */
    function storageOf () {
      try {
        if (typeof localStorage === "undefined" || localStorage === null) return null;
        return localStorage;
      } catch (err) {
        return null;
      }
    }

    /** JSON 文本 → 对象；空串 / 半截 JSON / 非对象 ⇒ null（绝不抛）。 */
    function parsePrefs (text) {
      if (typeof text !== "string" || text.length === 0) return null;
      try {
        var value = JSON.parse(text);
        return value !== null && typeof value === "object" ? value : null;
      } catch (err) {
        return null;
      }
    }

    /**
     * 把任意来路的值收成**字段齐全、类型正确**的偏好对象（对象或 JSON 串都能吃）。
     * 每个字段独立校验：非法（缺 / 类型错 / NaN / Infinity / 非正数 / 越界 / 非法时区 /
     * 非白名单 scope）⇒ 该字段回退默认值。**绝不产出 undefined / NaN / Infinity / 0 分钟** ——
     * 界面直接绑它的值。
     */
    function normalizePrefs (raw) {
      var source = typeof raw === "string" ? parsePrefs(raw) : raw;
      if (source === null || typeof source !== "object") source = {};

      // 🩸 实测：**先归一化（round）再校验**，并且带上下界。
      // 旧写法把 `> 0` 放在 Math.round **之前**：`{idleMinutes: 0.4}` 通过 `> 0`、
      // 被 round 成 0，round 之后无人复查 ⇒ idleMs=0 ⇒ 同一份两轮数据 segmentCount 1→2、
      // 概览口径全变，界面还印「0 分钟（自定义）」并把 "0" 塞进候选（点它 Number("0")=0
      // 又回退 5）⇒ **界面自相矛盾**。现在 round 之后必须落在 [1, MAX_IDLE_MINUTES] 内。
      var idle = DEFAULT_PREFS.idleMinutes;
      var idleRaw = numOf(source.idleMinutes);
      if (idleRaw !== null) {
        var rounded = Math.round(idleRaw);
        if (rounded >= 1 && rounded <= MAX_IDLE_MINUTES) idle = rounded;
      }

      // 实测：只查"非空串"会把 `Not/AZone` / 控制字符 / 超长串放行并上屏（P2 一用 Intl 就炸）。
      var zone = isValidTimezone(source.timezone) ? source.timezone : DEFAULT_PREFS.timezone;

      var scope = DEFAULT_PREFS.scope;
      for (var i = 0; i < PREF_SCOPES.length; i++) {
        if (PREF_SCOPES[i].key === source.scope) scope = PREF_SCOPES[i].key;
      }

      // 「会话」页三个偏好：视图 / 时间窗 / 工作区筛。与前三个**同一条口径** ——
      // 非法（缺 / 类型错 / 不在白名单）一律静默回退默认值，绝不产出 undefined。
      var sesView = DEFAULT_PREFS.sesView;
      for (var v = 0; v < SESSION_VIEWS.length; v++) {
        if (SESSION_VIEWS[v].key === source.sesView) sesView = SESSION_VIEWS[v].key;
      }
      // 时间窗：数字或数字串都吃（分段控件的 `value` 是字符串），但只认白名单里的值。
      var sesWindowRaw = typeof source.sesWindow === "number"
        ? source.sesWindow
        : (typeof source.sesWindow === "string" && source.sesWindow.length > 0 ? Number(source.sesWindow) : null);
      var sesWindow = DEFAULT_PREFS.sesWindow;
      for (var w = 0; w < SESSION_WINDOWS.length; w++) {
        if (Number(SESSION_WINDOWS[w].value) === sesWindowRaw) sesWindow = Number(SESSION_WINDOWS[w].value);
      }
      // 显示范围：同一条口径（数字 / 数字串都吃，只认白名单）
      var sesRangeRaw = typeof source.sesRange === "number"
        ? source.sesRange
        : (typeof source.sesRange === "string" && source.sesRange.length > 0 ? Number(source.sesRange) : null);
      var sesRange = DEFAULT_PREFS.sesRange;
      for (var rg = 0; rg < SESSION_RANGES.length; rg += 1) {
        if (Number(SESSION_RANGES[rg].value) === sesRangeRaw) sesRange = Number(SESSION_RANGES[rg].value);
      }
      // 工作区筛：空串 = 全部；其余截断到 MAX_WORKSPACE_LEN（超长 cwd 不许撑爆界面）。
      var sesWorkspace = DEFAULT_PREFS.sesWorkspace;
      if (typeof source.sesWorkspace === "string" && source.sesWorkspace.length > 0) {
        sesWorkspace = source.sesWorkspace.slice(0, MAX_WORKSPACE_LEN);
      }
      // A4 每周目标：同一条白名单口径（数字 / 数字串都吃，只认表里的值）
      var goalRaw = typeof source.weeklyGoalMinutes === "number"
        ? source.weeklyGoalMinutes
        : (typeof source.weeklyGoalMinutes === "string" && source.weeklyGoalMinutes.length > 0
          ? Number(source.weeklyGoalMinutes)
          : null);
      var weeklyGoalMinutes = DEFAULT_PREFS.weeklyGoalMinutes;
      for (var gl = 0; gl < PREF_WEEKLY_GOALS.length; gl += 1) {
        if (PREF_WEEKLY_GOALS[gl].value === goalRaw) weeklyGoalMinutes = PREF_WEEKLY_GOALS[gl].value;
      }

      return {
        idleMinutes: idle,
        timezone: zone,
        scope: scope,
        sesView: sesView,
        sesWindow: sesWindow,
        sesRange: sesRange,
        sesWorkspace: sesWorkspace,
        weeklyGoalMinutes: weeklyGoalMinutes
      };
    }

    /** 读偏好：没有 storage / getItem 抛 / 内容坏 ⇒ 静默回退默认值（不写日志、不阻断渲染）。 */
    function readPrefs (storage) {
      var box = storage === undefined || storage === null ? storageOf() : storage;
      try {
        if (box === null || typeof box === "undefined" || typeof box.getItem !== "function") {
          return normalizePrefs(null);
        }
        return normalizePrefs(box.getItem(PREF_KEY));
      } catch (err) {
        return normalizePrefs(null);
      }
    }

    /** 写偏好：成功 true / 失败 false（配额满、隐私模式、没有 storage），**不抛**。 */
    function writePrefs (storage, prefs) {
      var clean = normalizePrefs(prefs);
      var box = storage === undefined || storage === null ? storageOf() : storage;
      try {
        if (box === null || typeof box === "undefined" || typeof box.setItem !== "function") return false;
        box.setItem(PREF_KEY, JSON.stringify(clean));
        return true;
      } catch (err) {
        return false;
      }
    }

    /** 偏好 → 空闲阈值毫秒（进 buildModel 的唯一通路）。 */
    function idleMsOf (prefs) {
      return normalizePrefs(prefs).idleMinutes * 60000;
    }

    /** 把当前值补进候选列表并升序（当前值不在候选里时，也要能在界面上选中它）。 */
    function withCurrent (choices, current) {
      var list = Array.isArray(choices) ? choices : [];
      var out = [];
      var seen = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i] === current) seen = true;
        out.push(list[i]);
      }
      if (!seen) out.push(current);
      out.sort(function (a, b) { return a - b; });
      return out;
    }

    //#endregion

    //#region §4 模型构建（把三条通道折叠成"界面直接能画"的纯数据）

    /**
     * 唯一的模型入口。**渲染层只负责摆 DOM，不做任何数值/格式化** ——
     * 所有格式化都收敛在这里与 §3 的纯函数里，因此可以脱离宿主整体自测
     * （见 test/self-test.mjs）。
     *
     * @param {object} input
     *   - stats：sessionStats 投影值（通道 A），可空
     *   - turnTimings：通道 B，可空
     *   - timeline：通道 C，可空
     *   - openEndFallback：未结束轮的兜底结束时间（调用方传 Date.now()）
     *   - idleMs：空闲阈值，默认 5 分钟
     *   - prefs：P1.1 偏好 `{idleMinutes, timezone, scope}`（可空/可脏）；非法字段回退默认值。
     *     `idleMs` 显式给出时优先用它，否则用 `prefs.idleMinutes` —— 设置里改阈值，
     *     概览的活跃段 / 空闲率立刻跟着变。
     *   - sessions：P2 第一步 —— `props.useSessions` 快照（可空/可脏）。日历分段只用它，
     *     里面的 `usageDaily` 投影值由宿主折好、随会话列表行下发；拿不到 ⇒ 日历走空态。
     *   - now：P2 第一步 —— 判定「今日 / 本周 / 本月」的时刻（可空，回退 openEndFallback / Date.now()）。
     * @param {function} t：字典取词函数，缺省用中文
     */
    function buildModel (input, t) {
      var tr = typeof t === "function" ? t : function (key) {
        return DICT_ZH[key] !== undefined ? DICT_ZH[key] : "[missing:" + key + "]";
      };
      var source = input !== null && typeof input === "object" ? input : {};
      var stats = source.stats !== null && typeof source.stats === "object" ? source.stats : null;
      var prefs = normalizePrefs(source.prefs);
      // 同源加固：显式 `idleMs` 也要过一遍**上下界**（`numOf` 只挡 NaN/Infinity，`1e308` 是有限数，
      // 传进去会让 `summarizeUsage` 拿到 Infinity；而 `0` 会被当成"每轮都断开"⇒ 口径与设置段显示的
      // prefs 值不一致，属同一处风险的另一种形态）。合法区间与 `normalizePrefs` 对齐：[1 分钟, 1440 分钟]。
      var idleMs = numOf(source.idleMs);
      var minIdleMs = 60000;
      var maxIdleMs = MAX_IDLE_MINUTES * 60000;
      if (idleMs !== null && !(idleMs >= minIdleMs && idleMs <= maxIdleMs)) idleMs = null;
      if (idleMs === null) idleMs = prefs.idleMinutes * 60000;

      var spans = collectTurnSpans(source.turnTimings, source.openEndFallback);
      var stepStarts = stepStartsOf(source.timeline);
      var stepSpanList = stepSpansOf(source.timeline);
      var summary = summarizeUsage(spans, idleMs);

      // —— ①a 追加统计（2026-10-14 需求：「概览信息是不是不够多」）——
      // 全部来自 `spans`（每轮起止）与 `stepStarts`（每步时刻），**不引新数据源**。
      // ⚠️ 口径：`spans` 只覆盖**浏览器已加载窗口**（卡面已注明），与 KPI 里来自 sessionStats 的"全日志"数不同源。
      var spanDurSum = 0;
      var spanDurMax = 0;
      var spanDurList = [];
      var idleSegments = 0;
      var longestIdle = 0;
      for (var sp = 0; sp < spans.length; sp += 1) {
        var spDur = spans[sp].end - spans[sp].start;
        if (spDur > 0) {
          spanDurSum += spDur;
          spanDurList.push(spDur);
          if (spDur > spanDurMax) spanDurMax = spDur;
        }
        if (sp > 0) {
          var gapMs = spans[sp].start - spans[sp - 1].end;
          if (gapMs > idleMs) {
            idleSegments += 1;
            if (gapMs > longestIdle) longestIdle = gapMs;
          }
        }
      }
      spanDurList.sort(function (left, right) { return left - right });
      var spanAvg = spanDurList.length > 0 ? spanDurSum / spanDurList.length : null;
      var spanMedian = spanDurList.length > 0 ? spanDurList[Math.floor(spanDurList.length / 2)] : null;

      // 步骤级甘特（最近 STEP_GANTT_LIMIT 步；步时长优先用宿主给的 step/end，缺 end 才退回"下一步开始"）
      var stepSpans = recentStepSpans(stepSpanList, summary.lastAt, STEP_GANTT_LIMIT);
      var stepBarRows = ganttRows(stepSpans, summary.firstAt, summary.lastAt);
      var stepGantt = [];
      for (var sg = 0; sg < stepBarRows.length; sg += 1) {
        var sbar = stepBarRows[sg];
        var stepLabel = tr("steps.step") + sbar.turn;
        stepGantt.push({
          turn: sbar.turn,
          label: stepLabel,
          leftPct: sbar.leftPct,
          widthPct: sbar.widthPct,
          title: stepLabel + " · " + formatClock(sbar.start) + " → " + formatClock(sbar.end)
        });
      }
      var stepCapped = stepStarts.length > stepSpans.length;

      // —— ①b 时间构成（**全日志** · `sessionStats`）——
      // 字段名**已核实**（`@deepseek-ai/dsh-session-stats` 的源码 + README 都在 app.asar 里）：
      //   `{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`
      // ⚠️ 口径：这是**全日志累计**（durable log），与上面"已加载窗口"的 KPI 不同源 ⇒ 卡面必须写清。
      // ⚠️ 只做 `llmMs` vs `toolMs` 两段（互斥）；`ttftMs`/`decodeMs` 是模型段内部的拆分，**不能**再加进堆叠条。
      var llmMs = stats !== null ? numOf(stats.llmMs) : null;
      var toolMs = stats !== null ? numOf(stats.toolMs) : null;
      var ttftMs = stats !== null ? numOf(stats.ttftMs) : null;
      var ttftSteps = stats !== null ? numOf(stats.ttftSteps) : null;
      var decodeMs = stats !== null ? numOf(stats.decodeMs) : null;
      var decodeTokens = stats !== null ? numOf(stats.decodeTokens) : null;
      var workSplit = null;
      // 🩸 实测发现（2026-10-14）：**投影存在但全 0** 时必须**不挂卡** ——
      //    那正是宿主 `init()` 的默认形状（`{turns:0,steps:0,llmMs:0,toolMs:0,…}`），
      //    挂上去会变成"模型 0.0s · 0% / 工具 0.0s · 0%"，等于用 0 冒充"没有数据"
      //    （官方同一投影在 all-zero 时给的是空态，见 app.asar 里 contextConversation 的用法）。
      // 🩸 实测：单边负数（如 llmMs=-1000, toolMs=1000）会让分母变 0 却仍把"工具 1.0s · 0%"印出来 ⇒
      //    要求**两边都非负**，否则整块不挂卡（宿主 schema 保证非负，这里是纵深防御）。
      if (llmMs !== null && toolMs !== null && llmMs >= 0 && toolMs >= 0 &&
        (llmMs > 0 || toolMs > 0 || (ttftSteps !== null && ttftSteps > 0) || (decodeMs !== null && decodeMs > 0))) {
        var workTotal = llmMs + toolMs;
        workSplit = {
          llmText: formatDuration(llmMs),
          toolText: formatDuration(toolMs),
          llmPct: workTotal > 0 ? clampPct((llmMs / workTotal) * 100) : 0,
          toolPct: workTotal > 0 ? clampPct((toolMs / workTotal) * 100) : 0,
          ttftText: ttftMs !== null && ttftSteps !== null && ttftSteps > 0
            ? formatDuration(ttftMs / ttftSteps)
            : EM_DASH,
          // 🩸 实测发现：`decodeTokens` 也要非负（否则会印出 `-800.0 tok/s`；宿主 schema 保证非负，这里是纵深防御）
          tpsText: decodeMs !== null && decodeMs > 0 && decodeTokens !== null && decodeTokens >= 0
            ? (decodeTokens / (decodeMs / 1000)).toFixed(1) + " tok/s"
            : EM_DASH
        };
      }

      // 24×7 时段分布（周一~周日 × 0~23 时，桶值 = 步数）
      var dowGrid = dowHourCounts(stepStarts);
      var dowMax = 0;
      for (var dg = 0; dg < 7; dg += 1) {
        for (var dh = 0; dh < 24; dh += 1) {
          if (dowGrid[dg][dh] > dowMax) dowMax = dowGrid[dg][dh];
        }
      }
      var dowNames = tr("dow.rows").split(",");
      var dowRows = [];
      for (var dr = 0; dr < 7; dr += 1) {
        var dowCells = [];
        for (var dc = 0; dc < 24; dc += 1) {
          var dcCount = dowGrid[dr][dc];
          dowCells.push({
            key: "d" + dr + "h" + dc,
            count: dcCount,
            level: heatLevelOf(dcCount, dowMax),
            title: dowNames[dr] + " " + pad2(dc) + ":00 · " + dcCount + " " + tr("hours.steps")
          });
        }
        dowRows.push({ key: "d" + dr, label: dowNames[dr], cells: dowCells });
      }

      // —— ① KPI 带 ——
      var kpis = [
        {
          key: "turns",
          label: tr("kpi.turns"),
          sub: tr("kpi.turns.sub"),
          value: formatCount(stats !== null ? stats.turns : null)
        },
        {
          key: "steps",
          label: tr("kpi.steps"),
          sub: tr("kpi.steps.sub"),
          value: formatCount(stats !== null ? stats.steps : null)
        },
        {
          key: "wall",
          label: tr("kpi.wall"),
          sub: tr("kpi.wall.sub"),
          value: formatDuration(summary.wallMs)
        },
        {
          key: "active",
          label: tr("kpi.active"),
          sub: tr("kpi.active.sub"),
          value: formatDuration(summary.activeMs)
        },
        {
          key: "idleRate",
          label: tr("kpi.idleRate"),
          sub: tr("kpi.idleRate.sub"),
          value: formatPercent(summary.idleRate)
        },
        {
          key: "first",
          label: tr("kpi.first"),
          sub: tr("kpi.first.sub"),
          value: formatClock(summary.firstAt)
        },
        // —— 追加 4 项（2026-10-14「信息不够多」）——
        {
          key: "avgTurn",
          label: tr("kpi.avgTurn"),
          sub: tr("kpi.avgTurn.sub"),
          value: formatDuration(spanAvg)
        },
        {
          key: "medianTurn",
          label: tr("kpi.medianTurn"),
          sub: tr("kpi.medianTurn.sub"),
          value: formatDuration(spanMedian)
        },
        {
          key: "maxTurn",
          label: tr("kpi.maxTurn"),
          sub: tr("kpi.maxTurn.sub"),
          value: formatDuration(spanDurMax > 0 ? spanDurMax : null)
        },
        {
          key: "longestIdle",
          label: tr("kpi.longestIdle"),
          sub: tr("kpi.longestIdle.sub"),
          value: formatDuration(idleSegments > 0 ? longestIdle : null)
        }
      ];

      // —— ② 使用时间线（甘特）——
      // P1-fix 口径标注：甘特 / 每小时 / 排行都来自 `turnTimings` / `timeline`，
      // 也就是**只有浏览器已加载窗口**那一截；而 KPI 的轮次/步数来自 sessionStats
      // = **全日志**。两个口径必须各自写在卡面上，否则同屏会出现互相矛盾的数
      //（实机：KPI 步数 135 vs hours 卡「42 步」）。
      // `spans[].turn` 已由 collectTurnSpans 清洗为有限数 ⇒ 这里不可能产出 NaN/undefined。
      var ganttWindowText = "";
      if (spans.length > 0) {
        var minTurn = spans[0].turn;
        var maxTurn = spans[0].turn;
        for (var w = 1; w < spans.length; w++) {
          if (spans[w].turn < minTurn) minTurn = spans[w].turn;
          if (spans[w].turn > maxTurn) maxTurn = spans[w].turn;
        }
        ganttWindowText = tr("gantt.window") +
          tr("gantt.turnPrefix") + minTurn + "~" + maxTurn + tr("gantt.turnSuffix");
      }

      var ganttBars = ganttRows(spans, summary.firstAt, summary.lastAt);
      var gantt = [];
      for (var g = 0; g < ganttBars.length; g++) {
        var bar = ganttBars[g];
        var turnLabel = tr("gantt.turnPrefix") + bar.turn + tr("gantt.turnSuffix");
        gantt.push({
          turn: bar.turn,
          label: turnLabel,
          leftPct: bar.leftPct,
          widthPct: bar.widthPct,
          title: turnLabel + " · " + tr("gantt.tip") + " " + formatDuration(bar.end - bar.start) +
            " · " + formatClock(bar.start) + " → " + formatClock(bar.end)
        });
      }

      // —— ③ 每小时分布 ——
      var counts = hourlyStepCounts(stepStarts);
      var activeByHour = hourlyActiveMs(spans);
      var countHeights = normalizeHeights(counts);
      var activeHeights = normalizeHeights(activeByHour);
      var hours = [];
      var totalSteps = 0;
      var totalActiveMs = 0;
      for (var hh = 0; hh < 24; hh++) {
        totalSteps += counts[hh];
        totalActiveMs += activeByHour[hh];
        hours.push({
          hour: hh,
          label: pad2(hh),
          count: counts[hh],
          activeMs: activeByHour[hh],
          heightPct: countHeights[hh],
          activeHeightPct: activeHeights[hh],
          title: pad2(hh) + ":00 " + tr("hours.axis") + " · " + counts[hh] + " " + tr("hours.steps") +
            " · " + formatDuration(activeByHour[hh])
        });
      }

      // —— ④ 每轮用时排行 ——
      var ranked = rankTurns(spans, RANK_LIMIT);
      var maxDuration = ranked.length > 0 ? ranked[0].durationMs : 0;
      var rank = [];
      for (var r = 0; r < ranked.length; r++) {
        var row = ranked[r];
        var rowLabel = tr("gantt.turnPrefix") + row.turn + tr("gantt.turnSuffix");
        rank.push({
          turn: row.turn,
          label: rowLabel,
          durationMs: row.durationMs,
          durationText: formatDuration(row.durationMs),
          widthPct: maxDuration > 0 ? clampPct((row.durationMs / maxDuration) * 100) : 0,
          title: rowLabel + " · " + tr("rank.dur") + " " + formatDuration(row.durationMs) +
            " · " + formatClock(row.start) + " → " + formatClock(row.end)
        });
      }

      var hasSessionStats = stats !== null && (numOf(stats.turns) !== null || numOf(stats.steps) !== null);

      // —— ⑥ 日历分段（P2 第一步）——
      // 数据来自**会话列表行自带**的宿主投影（`source.sessions` = useSessions 快照）：
      // 纯求和，零请求、零 I/O。`now` 决定「今日 / 本周 / 本月」的边界，
      // 优先级：显式 now → openEndFallback（UsageView 传的就是 Date.now()）→ 真 Date.now()。
      // 拿不到投影（`hasData=false`）时日历分段**保持空态**，绝不画 0 冒充数据。
      var calendarNow = numOf(source.now);
      if (calendarNow === null) calendarNow = numOf(source.openEndFallback);
      if (calendarNow === null) calendarNow = Date.now();
      var sessionRows = collectSessionUsage(source.sessions);
      var aggUsage = aggregateUsageDaily(source.sessions);
      var calendar = buildCalendarModel(aggUsage, calendarNow, tr);
      // A7：K 线（同源、同一个"今天"）
      var kline = buildKlineModel(aggUsage, calendarNow, tr);
      var hostStats = buildHostStatsModel(aggUsage, tr);
      // A6：工作区趋势（同源、同一个"今天"）
      // ⚠️ `collectSessionUsage` 返回的是 `{ rows, uncovered }`，取 `.rows` 才是数组
      calendar.wsTrend = buildWorkspaceTrend(sessionRows.rows, calendarNow, tr);

      // A4：**每周目标进度**（挂在「本周」那张 KPI 上；目标 = 0 表示关，不给进度）
      var goalMinutes = numOf(prefs.weeklyGoalMinutes);
      if (goalMinutes !== null && goalMinutes > 0 &&
        Array.isArray(calendar.cumKpis) && numOf(calendar.weekMsRaw) !== null) {
        var goalMs = goalMinutes * 60000;
        var weekRaw = nonNegOf(calendar.weekMsRaw);
        var goalPct = goalMs > 0 ? clampPct((weekRaw / goalMs) * 100) : 0;
        var overPct = goalMs > 0 ? Math.round(((weekRaw - goalMs) / goalMs) * 100) : 0;
        for (var gk = 0; gk < calendar.cumKpis.length; gk += 1) {
          if (calendar.cumKpis[gk].key !== "week") continue;
          calendar.cumKpis[gk].progress = goalPct;
          // ⚠️ 超了也不是"坏事"（时长没有好坏）⇒ 只用文字说清，不给红绿
          calendar.cumKpis[gk].progressTip = tr("goal.tip") + formatDuration(goalMs) +
            (overPct > 0 ? " \u00b7 " + tr("goal.over") + overPct + "%" : " \u00b7 " + tr("goal.left") + (100 - Math.round(goalPct)) + "%");
        }
      }

      // —— ⑦「会话」页（P2 第三步）：**逐会话**清单 ——
      // 与日历同一份快照、同一份投影值，区别只在「保留身份」（日历只求和）。
      // 用同一个 `calendarNow` 当"今天" ⇒ 两页的窗口边界不会错开一天。
      var sessions = buildSessionsModel(
        sessionRows,
        {
          view: prefs.sesView,
          windowDays: prefs.sesWindow,
          rangeDays: prefs.sesWindow,
          workspace: prefs.sesWorkspace,
          selectedId: typeof source.sesSelectedId === "string" ? source.sesSelectedId : ""
        },
        calendarNow,
        tr
      );

      // —— ⑤ 设置分段（P1.1）：把偏好收成"渲染层直接能摆"的选项表 ——
      // 当前值不在候选里（被手工改成 7 分钟 / 罕见时区）时动态补进候选，
      // 保证「界面显示的值 == 真正生效的值」，绝不出现"一项都选不中"。
      var idleChoices = withCurrent(PREF_IDLE_CHOICES, prefs.idleMinutes);
      var idleCustom = PREF_IDLE_CHOICES.indexOf(prefs.idleMinutes) < 0;
      var idleOptions = [];
      for (var io = 0; io < idleChoices.length; io++) {
        var minutes = idleChoices[io];
        idleOptions.push({
          value: String(minutes),
          label: String(minutes) + tr("set.idleUnit") +
            (idleCustom && minutes === prefs.idleMinutes ? tr("set.custom") : ""),
          active: minutes === prefs.idleMinutes
        });
      }
      var tzChoices = [];
      for (var tz = 0; tz < PREF_TIMEZONES.length; tz++) tzChoices.push(PREF_TIMEZONES[tz]);
      if (tzChoices.indexOf(prefs.timezone) < 0) tzChoices.push(prefs.timezone);
      var tzOptions = [];
      for (var zo = 0; zo < tzChoices.length; zo++) {
        tzOptions.push({ value: tzChoices[zo], label: tzChoices[zo], active: tzChoices[zo] === prefs.timezone });
      }
      var scopeOptions = [];
      var scopeText = tr("set.scope.session");
      for (var so = 0; so < PREF_SCOPES.length; so++) {
        var scopeLabel = tr(PREF_SCOPES[so].label);
        if (PREF_SCOPES[so].key === prefs.scope) scopeText = scopeLabel;
        scopeOptions.push({ value: PREF_SCOPES[so].key, label: scopeLabel, active: PREF_SCOPES[so].key === prefs.scope });
      }
      // A4：每周目标候选（白名单 ⇒ 当前值一定在表里，不会出现"一项都选不中"）
      var goalOptions = [];
      var goalText = tr("goal.off");
      for (var go = 0; go < PREF_WEEKLY_GOALS.length; go += 1) {
        var goalLabel = tr(PREF_WEEKLY_GOALS[go].label);
        if (PREF_WEEKLY_GOALS[go].value === prefs.weeklyGoalMinutes) goalText = goalLabel;
        goalOptions.push({
          value: String(PREF_WEEKLY_GOALS[go].value),
          label: goalLabel,
          active: PREF_WEEKLY_GOALS[go].value === prefs.weeklyGoalMinutes
        });
      }
      var settings = {
        prefs: prefs,
        idleText: String(prefs.idleMinutes) + tr("set.idleUnit") + (idleCustom ? tr("set.custom") : ""),
        idleOptions: idleOptions,
        goalOptions: goalOptions,
        goalText: goalText,
        timezone: prefs.timezone,
        tzOptions: tzOptions,
        scope: prefs.scope,
        scopeText: scopeText,
        scopeOptions: scopeOptions,
        scopePending: prefs.scope !== DEFAULT_PREFS.scope,
        storeKey: PREF_KEY
      };

      return {
        hasData: spans.length > 0 || stepStarts.length > 0 || hasSessionStats,
        hasTurns: spans.length > 0,
        kpis: kpis,
        gantt: gantt,
        workSplit: workSplit,
        stepGantt: stepGantt,
        stepCapped: stepCapped,
        dowRows: dowRows,
        hours: hours,
        rank: rank,
        totals: {
          stepCount: stepStarts.length,
          totalSteps: totalSteps,
          totalActiveMs: totalActiveMs,
          segmentCount: summary.segmentCount
        },
        ganttWindowText: ganttWindowText,
        sourceNote: tr("source.note"),
        calendar: calendar,
        kline: kline,
        hostStats: hostStats,
        sessions: sessions,
        settings: settings
      };
    }

    //#endregion

    //#region §5 渲染（只摆 DOM；数值/格式化全部来自 §4 的模型）

    function h (type, props) {
      var children = [];
      for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
      return react.createElement.apply(react, [type, props].concat(children));
    }

    function defaultT (key) {
      return DICT_ZH[key] !== undefined ? DICT_ZH[key] : "[missing:" + key + "]";
    }

    /**
     * 安全读投影：投影座位可能不存在（装配里没有该投影单元），
     * 读不到就返回 null（界面显示 —），绝不让异常穿透渲染
     * （照 dsh-context 的 conversationNodesOf 的 try/catch 风格）。
     */
    function projectionOf (props, key) {
      var useProjection = props !== null && typeof props === "object" ? props.useProjection : null;
      if (typeof useProjection !== "function") return null;
      try {
        var value = useProjection(key);
        return value !== null && typeof value === "object" ? value : null;
      } catch (err) {
        return null;
      }
    }

    /**
     * 安全读 Chat 快照切片。
     *
     * ⚠️ 标准座位是**真 hook**：必须"无条件、固定顺序、每个 key 一次"地调用。
     * 本文件的调用点恰好三个（两次 useChat + 一次 useProjection），顺序固定，
     * 不随分支变化。
     */
    function chatSliceOf (props, selector) {
      var useChat = props !== null && typeof props === "object" ? props.useChat : null;
      if (typeof useChat !== "function") return undefined;
      try {
        return useChat(selector);
      } catch (err) {
        return undefined;
      }
    }

    /**
     * KPI 网格（概览与日历共用同一套观感）：`cells = [{key, label, sub, value}]`。
     * `sub` 同时作为 `title`（悬停口径说明），不占版面。
     */
    function kpiGrid (cells) {
      var list = Array.isArray(cells) ? cells : [];
      var nodes = [];
      for (var i = 0; i < list.length; i++) {
        var cell = list[i];
        var delta = cell !== null && typeof cell === "object" ? cell.delta : null;
        nodes.push(h("div", { className: "ut-kpi", key: cell.key, title: cell.sub },
          h("div", { className: "ut-kpi-label", title: cell.sub }, cell.label),
          h("div", { className: "ut-kpi-value", title: cell.sub }, cell.value),
          // A3 环比：箭头 + 百分比（方向靠**箭头形状**，颜色中性 —— 用时涨了不代表变好）
          delta !== null && typeof delta === "object"
            ? h("div", {
              className: "ut-kpi-delta ut-kpi-delta-" + delta.dir,
              title: delta.tip,
              role: "note",
              // 🩸 实测：方向不能只靠 ▲/▼ 字形（屏幕阅读器读不到）⇒ 给完整的可访问名
              "aria-label": delta.aria,
              "data-usage-role": "kpi-delta"
            }, delta.text)
            : null,
          // A4 每周目标进度（目标 = 0 时根本不挂）
          cell.progress !== undefined && cell.progress !== null
            ? h("div", {
              className: "ut-kpi-prog",
              title: cell.progressTip,
              "data-usage-role": "kpi-progress"
            }, h("div", { className: "ut-kpi-prog-bar", style: { width: clampPct(cell.progress) + "%" } }))
            : null
        ));
      }
      return h("div", { className: "ut-kpis" }, nodes);
    }

    /**
     * 安全读会话列表快照（`props.useSessions`）。
     *
     * 与 `useChat` / `useProjection` 一样是**真 hook**：无条件、固定顺序、只调一次。
     * 座位缺失 / 抛异常一律返回 null（日历走空态），绝不把异常带进渲染。
     * 快照形状（`SessionListState`）：`{ ids, byId, phase, projectionsBySession }`；
     * 每行的 `projectionValues` 里就是宿主折好的投影值（含我们的 `usageDaily`）。
     */
    function sessionsSliceOf (props) {
      var useSessions = props !== null && typeof props === "object" ? props.useSessions : null;
      if (typeof useSessions !== "function") return null;
      try {
        var snapshot = useSessions(function (state) { return state; });
        return snapshot !== null && typeof snapshot === "object" ? snapshot : null;
      } catch (err) {
        return null;
      }
    }

    function kpiCard (model, t) {
      var cells = [];
      for (var i = 0; i < model.kpis.length; i++) {
        var kpi = model.kpis[i];
        cells.push({ key: kpi.key, label: kpi.label, sub: kpi.sub, value: kpi.value });
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.kpi"))
        ),
        kpiGrid(cells)
      );
    }

    /** 步骤级甘特（2026-10-14 需求）：每步一段；空白 = 步与步之间的间隔。 */
    function stepsCard (model, t) {
      var rows = [];
      for (var i = 0; i < model.stepGantt.length; i++) {
        var row = model.stepGantt[i];
        rows.push(h("div", { className: "ut-gantt-row", key: "st" + row.turn },
          h("div", { className: "ut-gantt-turn", title: row.title }, row.label),
          h("div", { className: "ut-gantt-track", title: row.title },
            h("div", { className: "ut-gantt-bar", style: { left: row.leftPct + "%", width: row.widthPct + "%" } })
          )
        ));
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.steps")),
          model.stepCapped === true ? h("span", { className: "ut-card-tag" }, t("steps.capped")) : null
        ),
        h("div", { className: "ut-card-sub" }, t("steps.sub")),
        h("div", { className: "ut-gantt" }, rows)
      );
    }

    /**
     * 时间构成卡（第 1 批）：**模型耗时 vs 工具执行耗时**（全日志，互斥两段）+ 首 token 平均 + 生成速度。
     * ⚠️ 按工具名分类**做不了**（工具名明细在 dsh-context 的 `contextTimeline.timing.tools` 里，读它=耦合他人）
     * ⇒ 这就是那个"降级方案"，卡面上不假装能给出工具明细。
     */
    function workSplitCard (model, t) {
      var w = model.workSplit;
      var bar = h("div", { className: "ut-split", "data-usage-role": "work-split-bar" },
        h("div", { className: "ut-split-llm", style: { width: w.llmPct + "%" } }),
        h("div", { className: "ut-split-tool", style: { width: w.toolPct + "%" } })
      );
      var legend = h("div", { className: "ut-split-legend" },
        h("span", { key: "llm" },
          h("span", { className: "ut-split-dot ut-split-llm" }),
          t("work.llm") + " " + w.llmText + " · " + Math.round(w.llmPct) + "%"),
        h("span", { key: "tool" },
          h("span", { className: "ut-split-dot ut-split-tool" }),
          t("work.tool") + " " + w.toolText + " · " + Math.round(w.toolPct) + "%"),
        h("span", { key: "ttft" }, t("work.ttft") + " " + w.ttftText),
        h("span", { key: "tps" }, t("work.tps") + " " + w.tpsText)
      );
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.work"))
        ),
        h("div", { className: "ut-card-sub" }, t("work.sub")),
        bar,
        legend
      );
    }

    /** 24×7 时段分布：周一~周日 × 0~23 时；格子越深 = 该时段开始的步数越多。 */
    function dowCard (model, t) {
      var body = [];
      for (var r = 0; r < model.dowRows.length; r++) {
        var row = model.dowRows[r];
        var cells = [];
        for (var c = 0; c < row.cells.length; c++) {
          var cell = row.cells[c];
          cells.push(h("div", {
            key: cell.key,
            className: "ut-dow-cell" + (cell.level > 0 ? " ut-dow-l" + cell.level : ""),
            title: cell.title,
            "data-usage-role": "dow-cell"
          }));
        }
        body.push(h("div", { className: "ut-dow-row", key: row.key },
          h("span", { className: "ut-dow-label" }, row.label),
          cells
        ));
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.dow"))
        ),
        h("div", { className: "ut-card-sub" }, t("dow.sub")),
        h("div", { className: "ut-dow" }, body)
      );
    }

    function ganttCard (model, t) {
      var rows = [];
      for (var i = 0; i < model.gantt.length; i++) {
        var row = model.gantt[i];
        rows.push(h("div", { className: "ut-gantt-row", key: row.turn },
          h("div", { className: "ut-gantt-turn", title: row.title }, row.label),
          h("div", { className: "ut-gantt-track", title: row.title },
            h("div", { className: "ut-gantt-bar", style: { left: row.leftPct + "%", width: row.widthPct + "%" } })
          )
        ));
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.gantt")),
          // P1-fix：窗口口径标签（缺数据时为 ""，走 null 不渲染空节点）。
          model.ganttWindowText
            ? h("span", { className: "ut-card-tag" }, model.ganttWindowText)
            : null
        ),
        h("div", { className: "ut-card-sub" }, t("gantt.sub")),
        h("div", { className: "ut-gantt" }, rows)
      );
    }

    function hoursCard (model, t) {
      var bars = [];
      for (var i = 0; i < model.hours.length; i++) {
        var bar = model.hours[i];
        bars.push(h("div", { className: "ut-hour-col", key: bar.hour, title: bar.title },
          h("div", { className: "ut-hour-bar", style: { height: bar.heightPct + "%" } })
        ));
      }
      var axis = [];
      for (var j = 0; j < model.hours.length; j++) {
        var tick = model.hours[j];
        axis.push(h("span", { key: tick.hour }, tick.hour % 3 === 0 ? tick.label : ""));
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.hours"))
        ),
        h("div", { className: "ut-card-sub" }, t("hours.sub")),
        h("div", { className: "ut-hours" }, bars),
        h("div", { className: "ut-hours-axis" }, axis),
        h("div", { className: "ut-hours-sum" },
          t("hours.sum") + model.totals.totalSteps + t("hours.sumMid") + formatDuration(model.totals.totalActiveMs) +
          " · " + t("segments") + " " + model.totals.segmentCount
        )
      );
    }

    /** 宿主统计卡（工具 / 模型 / 结束原因 / 压缩 + 形状留痕）—— 本身没数据时整卡不挂。 */
    function hostStatsCard (model, t) {
      var hs = model !== null && typeof model === "object" ? model.hostStats : null;
      if (hs === null || typeof hs !== "object" || hs.hasData !== true) return null;
      function block (titleKey, rows, role) {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        var items = [];
        for (var i = 0; i < rows.length; i += 1) {
          items.push(h("div", { className: "ut-rank-row", key: role + rows[i].key, title: rows[i].title },
            h("div", { className: "ut-rank-turn" }, rows[i].label),
            h("div", { className: "ut-rank-track" },
              h("div", { className: "ut-rank-bar", style: { width: rows[i].widthPct + "%" } })),
            h("div", { className: "ut-rank-dur" }, rows[i].valueText)
          ));
        }
        return h("div", { className: "ut-hs-block", key: role },
          h("div", { className: "ut-hs-title" }, t(titleKey)),
          h("div", { className: "ut-rank" }, items)
        );
      }
      var children = [h("div", { className: "ut-card-title" },
        h("span", { className: "ut-card-title-text" }, t("card.hostStats")),
        h("span", { className: "ut-card-sub" }, hs.sub)
      )];
      var toolBlock = block("hs.tools", hs.tools, "tool");
      if (toolBlock !== null) children.push(toolBlock);
      var modelBlock = block("hs.models", hs.models, "model");
      if (modelBlock !== null) children.push(modelBlock);
      var outcomeBlock = block("hs.outcomes", hs.outcomes, "outcome");
      if (outcomeBlock !== null) children.push(outcomeBlock);
      children.push(h("div", { className: "ut-hs-line" }, t("hs.compactions") + " " + hs.compactionText));
      if (hs.hiddenText !== "") {
        // 实测发现：截断必须有交代（本项目其它截断处都写了"只列出前 N"）
        children.push(h("div", { className: "ut-hs-line", "data-usage-role": "host-stats-hidden" }, hs.hiddenText));
      }
      if (Array.isArray(hs.shapeRows) && hs.shapeRows.length > 0) {
        var shapeNodes = [];
        for (var s = 0; s < hs.shapeRows.length; s += 1) {
          shapeNodes.push(h("div", { key: hs.shapeRows[s].key, className: "ut-hs-shape" }, hs.shapeRows[s].text));
        }
        children.push(h("div", { className: "ut-hs-shapes", "data-usage-role": "host-shape-notes" },
          h("div", { className: "ut-hs-title" }, t("hs.shapes")), shapeNodes));
      }
      return h("div", { className: "ut-card", "data-usage-role": "host-stats-card" }, children);
    }

    function rankCard (model, t) {
      var rows = [];
      for (var i = 0; i < model.rank.length; i++) {
        var row = model.rank[i];
        rows.push(h("div", { className: "ut-rank-row", key: row.turn },
          h("div", { className: "ut-rank-turn", title: row.title }, row.label),
          h("div", { className: "ut-rank-track", title: row.title },
            h("div", { className: "ut-rank-bar", style: { width: row.widthPct + "%" } })
          ),
          h("div", { className: "ut-rank-dur" }, row.durationText)
        ));
      }
      return h("div", { className: "ut-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.rank")),
          h("span", { className: "ut-card-sub" }, t("rank.sub"))
        ),
        h("div", { className: "ut-rank" }, rows)
      );
    }

    function emptyCard (t) {
      return h("div", { className: "ut-empty" },
        h("b", {}, t("empty.title")),
        h("div", {}, t("empty.hint"))
      );
    }

    // —— P1.1 二级分段导航 + 分段正文（观感照 dsh-context 的 .lc-gran）——

    /**
     * 分段按钮的点击处理器。**必须用工厂函数返回**：`var` 只有函数作用域，
     * 若在 for 循环里直接写闭包，所有按钮会一起指向最后一次迭代的值（经典坑）。
     */
    function pickHandler (group, value, onPick) {
      return function onSegPick () {
        if (typeof onPick === "function") onPick(group, value);
      };
    }

    /**
     * 单个分段按钮。选中态 = 加 `.ut-seg-on`（背景走 brand-primary 系 token）。
     *
     * 🩸 实测：语义按容器分两种，**不许混用** ——
     *   · `subnav` 在 `role="tablist"` 里 ⇒ 必须是真 `role="tab"` + `aria-selected`
     *     （旧写法只有 `aria-pressed`，屏幕阅读器会认为"tablist 里没有 tab"）；
     *   · 设置里的三组在 `role="group"` 里 ⇒ 保持按压按钮语义（`aria-pressed`）。
     * 不加 `aria-controls` / `tabpanel`：正文是同级散装卡片，包容器会改 DOM 结构
     * （P1 回归断言依赖 cards 平铺），收益不抵风险。
     */
    function segButton (group, option, onPick) {
      var active = option.active === true;
      var props = {
        type: "button",
        key: option.value,
        className: "ut-seg-btn" + (active ? " ut-seg-on" : ""),
        "data-usage-role": "seg-btn",
        "data-group": group,
        "data-value": option.value,
        title: typeof option.title === "string" ? option.title : option.label,
        onClick: pickHandler(group, option.value, onPick)
      };
      if (group === "subnav") {
        props.role = "tab";
        props["aria-selected"] = active ? "true" : "false";
      } else {
        props["aria-pressed"] = active ? "true" : "false";
      }
      return h("button", props, option.label);
    }

    /** 分段组的 `aria-label` 取词表（组名 → i18n key）。缺项的组不挂 aria-label。 */
    var SEG_GROUP_ARIA = {
      subnav: "seg.aria",
      "pref.idle": "set.idle",
      "pref.goal": "set.goal",
      "pref.timezone": "set.tz",
      "pref.scope": "set.scope",
      // P2 第三步：「会话」页的三段控件（视图 / 时间窗 / 工作区）也各自要有可访问名。
      "ses.view": "ses.view.aria",
      "ses.win": "ses.win.aria",
      "ses.range": "ses.range.aria",
      "ses.ws": "ses.ws.aria"
    };

    /** 分段控件容器：二级导航（tablist）与设置里的三个单选组（group）共用同一套观感。 */
    function segControl (group, options, onPick, t, extraClass) {
      var list = Array.isArray(options) ? options : [];
      var buttons = [];
      for (var i = 0; i < list.length; i++) buttons.push(segButton(group, list[i], onPick));
      var props = {
        className: "ut-seg" + (extraClass ? " " + extraClass : ""),
        key: group,
        "data-usage-role": group,
        role: "group"
      };
      if (group === "subnav") props.role = "tablist";
      // 🩸 实测：三个偏好组原来只有 role="group" 没有名字 ⇒ 补上 aria-label（用现有 i18n 词条）。
      if (Object.prototype.hasOwnProperty.call(SEG_GROUP_ARIA, group)) {
        props["aria-label"] = t(SEG_GROUP_ARIA[group]);
      }
      return h("div", props, buttons);
    }

    /** 二级导航：4 个分段，第一项（概览）默认选中。 */
    function subnavNode (segment, t, onPick) {
      var options = [];
      for (var i = 0; i < SEGMENT_KEYS.length; i++) {
        var key = SEGMENT_KEYS[i];
        options.push({ value: key, label: t("seg." + key), active: key === segment });
      }
      return segControl("subnav", options, onPick, t, "ut-seg-main");
    }

    /** 概览分段 = P1 原有四张卡（逻辑一字未动）+ 最底部的口径脚注。 */
    function overviewBody (model, t) {
      var cards = [];
      if (!model.hasData) cards.push(emptyCard(t));
      cards.push(kpiCard(model, t));
      if (model.hasTurns) cards.push(ganttCard(model, t));
      if (Array.isArray(model.stepGantt) && model.stepGantt.length > 0) cards.push(stepsCard(model, t));
      cards.push(hoursCard(model, t));
      if (model.workSplit !== null && typeof model.workSplit === "object") cards.push(workSplitCard(model, t));
      if (Array.isArray(model.dowRows) && model.dowRows.length > 0) cards.push(dowCard(model, t));
      if (model.rank.length > 0) cards.push(rankCard(model, t));
      var hostCard = hostStatsCard(model, t);
      if (hostCard !== null) cards.push(hostCard);
      // P1-fix：口径脚注真正渲染到 tab 内容**最底部**（样式 .ut-source：11px / label-tertiary）。
      // data-usage-role 只给实机核对一个稳定钩子：
      //   document.querySelector('[data-usage-role="source-note"]')
      cards.push(h("div", {
        className: "ut-source",
        key: "source",
        "data-usage-role": "source-note"
      }, model.sourceNote));
      return cards;
    }

    /**
     * 骨架行：标签 + 虚线占位 + 值。值一律 `—`（**不是 0**）——
     * 没有数据就不许冒充有数据。`{section:true}` 的行是分组小标题（不画占位条）。
     */
    function skeletonRows (rows, t) {
      var list = Array.isArray(rows) ? rows : [];
      var nodes = [];
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (row.section === true) {
          nodes.push(h("div", { className: "ut-skel-sec", key: "sec" + i }, row.label));
          continue;
        }
        nodes.push(h("div", { className: "ut-skel-row", key: "skel" + i },
          h("div", { className: "ut-skel-name", title: row.label }, row.label),
          h("div", { className: "ut-skel-block" }),
          h("div", { className: "ut-skel-val" }, typeof row.value === "string" ? row.value : EM_DASH)
        ));
      }
      return h("div", { className: "ut-skel", "data-usage-role": "skeleton" }, nodes);
    }

    /**
     * 骨架卡片：标题 + 「P2 接宿主级全历史数据后填充」标签 + 副标题 + 骨架 + 说明。
     * `noteKey` 缺省 `p2.note`；日历分段用 `cal.emptyNote`（它讲的是"读不到宿主投影值"，
     * 而不是"等 P2 开发"——P2 第一步已经落地，说法必须换）。
     */
    function skeletonCard (key, titleKey, subKey, rows, t, noteKey) {
      return h("div", { className: "ut-card", key: key },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t(titleKey)),
          h("span", { className: "ut-card-tag", "data-usage-role": "p2-tag" }, t("p2.tag"))
        ),
        h("div", { className: "ut-card-sub" }, t(subKey)),
        skeletonRows(rows, t),
        h("div", { className: "ut-source" }, t(typeof noteKey === "string" ? noteKey : "p2.note"))
      );
    }

    /** 日历空态骨架的行表（读不到宿主 usageDaily 投影时用；与 P1.1 逐字一致）。 */
    function calendarSkeletonRows (t) {
      return [
        { label: t("cal.heat") },
        { label: t("cal.bars") },
        { section: true, label: t("cal.cum") },
        { label: t("cal.today") },
        { label: t("cal.week") },
        { label: t("cal.month") },
        { section: true, label: t("cal.segs") },
        { label: t("cal.longest") },
        { label: t("cal.avg") },
        { label: t("cal.count") }
      ];
    }

    /**
     * 日历分段（P2 第一步）：**读真数据**。
     *
     * 有数据 ⇒ 两张卡：
     *   ①「日历视图」= 今日/本周/本月 KPI + 近 12 周热力图 + 近 14 天柱状 + 口径脚注；
     *   ②「连续使用段」= 最长 / 平均 / 段数。
     * 拿不到数据（宿主半还没生效 / 该会话没有投影缓存）⇒ **保持 P1.1 的空态骨架**，
     * 一个数字都不猜（值一律 `—`）。
     */
    /**
     * A6：工作区趋势卡（每个工作区一行 + 12 根迷你柱）。
     * 🩸 用**柱子**不用折线（折线会暗示插值，让人误读中间值）。
     */
    function wsTrendCard (trend, t) {
      var rows = [];
      for (var i = 0; i < trend.rows.length; i += 1) {
        var row = trend.rows[i];
        var cols = [];
        for (var b = 0; b < row.bars.length; b += 1) {
          var bar = row.bars[b];
          cols.push(h("div", { className: "ut-ws-col", key: bar.key, title: bar.title },
            h("div", { className: "ut-ws-bar", style: { height: clampPct(bar.heightPct) + "%" } })
          ));
        }
        rows.push(h("div", { className: "ut-ws-row", key: row.key, "data-usage-role": "ws-trend-row" },
          h("span", { className: "ut-ws-label", title: row.full }, row.label),
          h("div", { className: "ut-ws-bars" }, cols),
          h("span", { className: "ut-ws-total" }, row.totalText)
        ));
      }
      return h("div", { className: "ut-card", key: "ws-trend", "data-usage-role": "ws-trend-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.wsTrend")),
          trend.capped > 0
            ? h("span", { className: "ut-card-tag" }, t("wsTrend.cappedPre") + trend.capped + t("wsTrend.cappedSuf"))
            : null
        ),
        h("div", { className: "ut-card-sub" }, t("wsTrend.sub")),
        rows
      );
    }

    /**
     * A7：K 线页正文（蜡烛图）。
     * ⚠️ **没有影线**（宿主只给逐日粒度）⇒ 只画 body；`dir` **只决定颜色**（中性蓝/紫），
     *    图例里把"涨不是好事"这层写明（时长没有好坏）。
     */
    function klineBody (model, t) {
      var k = model !== null && typeof model === "object" ? model.kline : null;
      if (k === null || typeof k !== "object" || k.hasData !== true) {
        // 实测发现：骨架标签原来借的是"近 12 周"（那是工作区趋势的窗口），K 线窗口是 60 天 ⇒ 用自己的
        return [skeletonCard("kline", "card.kline", "kline.sub",
          [{ label: t("kline.emptyRange") }], t, "kline.note")];
      }
      var cols = [];
      var rows = Array.isArray(k.rows) ? k.rows : [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var body = h("div", {
          className: "ut-k-body ut-k-" + row.dir,
          style: { bottom: clampPct(row.bottomPct) + "%", height: clampPct(row.heightPct) + "%" },
          "data-usage-role": "kline-candle"
        });
        var wicks = [];
        if (row.wickTopPct !== null && typeof row.wickTopPct === "number") {
          wicks.push(h("div", {
            className: "ut-k-wick ut-k-" + row.dir,
            key: "w-top",
            style: {
              bottom: clampPct(row.bottomPct + row.heightPct) + "%",
              height: clampPct(Math.max(0, row.wickTopPct - (row.bottomPct + row.heightPct))) + "%"
            },
            "data-usage-role": "kline-wick"
          }));
        }
        if (row.wickBottomPct !== null && typeof row.wickBottomPct === "number") {
          wicks.push(h("div", {
            className: "ut-k-wick ut-k-" + row.dir,
            key: "w-bottom",
            style: {
              bottom: clampPct(row.wickBottomPct) + "%",
              height: clampPct(Math.max(0, row.bottomPct - row.wickBottomPct)) + "%"
            },
            "data-usage-role": "kline-wick"
          }));
        }
        cols.push(h("div", { className: "ut-k-col", key: row.key, title: row.title },
          body, wicks
        ));
      }
      // 纵轴刻度（0 / 6 / 12 / 18 / 24h）—— 虚线网格 + 左侧标签，按需求「从低到高 0-24h」
      var grid = [];
      var tickList = Array.isArray(k.ticks) ? k.ticks : [];
      for (var ti = 0; ti < tickList.length; ti += 1) {
        grid.push(h("div", {
          className: "ut-k-gridline",
          key: tickList[ti].key,
          style: { bottom: clampPct(tickList[ti].bottomPct) + "%" },
          "data-usage-role": "kline-gridline"
        }, h("span", { className: "ut-k-ticklabel" }, tickList[ti].label)));
      }
      var legend = h("div", { className: "ut-k-legend" },
        h("span", { key: "up" }, h("span", { className: "ut-k-dot ut-k-up" }), t("kline.legendUp")),
        h("span", { key: "down" }, h("span", { className: "ut-k-dot ut-k-down" }), t("kline.legendDown")),
        h("span", { key: "flat" }, h("span", { className: "ut-k-dot ut-k-flat" }), t("kline.legendFlat"))
      );
      return [h("div", { className: "ut-card", key: "kline" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.kline"))
        ),
        h("div", { className: "ut-card-sub" }, t("kline.sub")),
        h("div", { className: "ut-kchart", "data-usage-role": "kline-chart" }, grid.concat(cols)),
        legend,
        h("div", { className: "ut-source", "data-usage-role": "kline-note" }, k.note)
      )];
    }

    function calendarBody (model, t) {
      var cal = model !== null && typeof model === "object" ? model.calendar : null;
      if (cal === null || typeof cal !== "object" || cal.hasData !== true) {
        return [skeletonCard("calendar", "card.calendar", "cal.sub", calendarSkeletonRows(t), t, "cal.emptyNote")];
      }

      // 热力图：一格一天，档位来自模型（0 档 = bg-layer-2 底，与骨架同底）。
      var heatCells = [];
      var heat = Array.isArray(cal.heat) ? cal.heat : [];
      for (var i = 0; i < heat.length; i++) {
        var cell = heat[i];
        var level = numOf(cell.level);
        var cls = "ut-heat-cell" + (level !== null && level > 0 ? " ut-heat-l" + Math.min(4, Math.round(level)) : "");
        heatCells.push(h("div", {
          key: cell.key,
          className: cls,
          "data-usage-role": "cal-heat-cell",
          title: cell.title
        }));
      }

      // 柱状：复用每小时分布那套 .ut-hours 观感（同一份宿主 token、同一个高度归一化口径）。
      var bars = [];
      var barList = Array.isArray(cal.bars) ? cal.bars : [];
      for (var b = 0; b < barList.length; b++) {
        var bar = barList[b];
        bars.push(h("div", { className: "ut-hour-col", key: bar.key, title: bar.title },
          h("div", { className: "ut-hour-bar", style: { height: clampPct(bar.heightPct) + "%" } })
        ));
      }
      var axis = [];
      for (var a = 0; a < barList.length; a++) {
        axis.push(h("span", { key: barList[a].key }, a % 3 === 0 ? barList[a].label : ""));
      }

      var viewCard = h("div", { className: "ut-card", key: "calendar" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.calendar")),
          h("span", { className: "ut-card-tag", "data-usage-role": "cal-sessions" },
            t("cal.sessions") + " " + cal.sessionsText)
        ),
        h("div", { className: "ut-card-sub" }, t("cal.sub")),
        h("div", { className: "ut-skel-sec" }, t("cal.cum")),
        kpiGrid(cal.cumKpis),
        h("div", { className: "ut-skel-sec" }, t("cal.heat") + " · " + t("cal.range12w")),
        h("div", { className: "ut-heat", "data-usage-role": "cal-heat" }, heatCells),
        h("div", { className: "ut-skel-sec" }, t("cal.bars") + " · " + t("cal.range14d")),
        h("div", { className: "ut-hours" }, bars),
        h("div", { className: "ut-hours-axis" }, axis),
        h("div", { className: "ut-source", "data-usage-role": "cal-note" }, cal.note)
      );

      var segmentCard = h("div", { className: "ut-card", key: "cal-segments" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("cal.segs"))
        ),
        h("div", { className: "ut-card-sub" }, t("cal.segSub")),
        kpiGrid(cal.segKpis)
      );

      return cal.wsTrend !== undefined && cal.wsTrend !== null && cal.wsTrend.hasData === true
        ? [viewCard, wsTrendCard(cal.wsTrend, t), segmentCard]
        : [viewCard, segmentCard];
    }

    /**
     * 「会话」页（P2 第三步）：**读真数据**。
     *
     * 三视图同属**一张卡**（卡头下方是工具条）：A 分组表 / B 活动带 / C 主从；
     * 拿不到任何一行（宿主投影没上线 / 老会话都没缓存）⇒ **保持 P1.1 空态骨架**，
     * 一个数字都不猜（值一律 `—`）。
     */
    function sessionsToolsNode (ses, t, onPick) {
      var controls = [
        segControl("ses.view", ses.viewOptions, onPick, t, "ut-seg-sm"),
        segControl("ses.win", ses.windowOptions, onPick, t, "ut-seg-sm")
      ];
      // 工作区候选到 3 个以上才给筛选条（只有「全部」或「全部 + 1 个」时它没有信息量）
      // 🩸 只要**有生效的工作区筛选**就必须渲染控件（哪怕候选只剩 1 项）——
      //    否则显示范围一收窄、候选掉到 2 项以下，控件消失，而筛选**仍然生效**：
      //    界面提示"换个工作区试试"、屏上却没有可换的控件 ⇒ 用户被卡死（实测）。
      if (ses.wsOptions.length > 2 || ses.workspace !== "") {
        controls.push(segControl("ses.ws", ses.wsOptions, onPick, t, "ut-seg-sm"));
      }
      controls.push(h("div", { className: "ut-ses-sum", "data-usage-role": "ses-sum" },
        ses.countText + " · " + t("ses.total") + " " + ses.totalText));
      return h("div", { className: "ut-ses-tools", "data-usage-role": "ses-tools" }, controls);
    }

    /** 会话名 + 「子代理 / 运行中」标记（三视图共用）。 */
    function sessionNameNode (row, t) {
      var flags = [];
      if (row.isSubagent === true) flags.push(h("span", { className: "ut-ses-flag", key: "sub" }, t("ses.subagent")));
      if (row.running === true) flags.push(h("span", { className: "ut-ses-flag", key: "run" }, t("ses.running")));
      return h("div", { className: "ut-ses-name", title: row.title }, row.title, flags);
    }

    /**
     * A5：**子代理构成**（会话数 + 活跃时长两条占比条）。
     * 口径 = 当前筛选 / 显示范围之后的清单（与卡头会话数同源）；**没有子代理会话就整卡不挂**。
     * 宿主判定见 `record.origin === "subagent"`。
     */
    function subagentCard (ses, t) {
      var s = ses.subagentStats;
      var rows = [
        { key: "count", label: t("subagent.count"), pct: s.countPct, text: s.countText },
        { key: "active", label: t("subagent.active"), pct: s.activePct, text: s.activeText }
      ];
      var nodes = [];
      for (var i = 0; i < rows.length; i += 1) {
        nodes.push(h("div", { className: "ut-sub-row", key: rows[i].key },
          h("span", { className: "ut-sub-label" }, rows[i].label),
          h("div", { className: "ut-sub-track", title: Math.round(rows[i].pct) + "%" },
            h("div", { className: "ut-sub-bar", style: { width: clampPct(rows[i].pct) + "%" } })),
          h("span", { className: "ut-sub-val" }, rows[i].text)
        ));
      }
      return h("div", { className: "ut-card", key: "subagent", "data-usage-role": "ses-subagent-card" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.subagent"))
        ),
        h("div", { className: "ut-card-sub" }, t("subagent.sub")),
        nodes
      );
    }

    /** A 视图正文：按工作区分组的纵向表 + 行内比例条（长度 = 窗口内活跃时长）。 */
    function sessionsGroupNode (ses, t) {
      var groups = [];
      for (var g = 0; g < ses.groups.length; g += 1) {
        var group = ses.groups[g];
        var rows = [];
        for (var r = 0; r < group.sessions.length; r += 1) {
          var row = group.sessions[r];
          rows.push(h("div", { className: "ut-ses-row", key: row.id, "data-usage-role": "ses-row", title: row.tip },
            sessionNameNode(row, t),
            h("div", { className: "ut-ses-track" },
              h("div", {
                className: "ut-ses-bar",
                style: { width: clampPct(row.barPct) + "%", background: "var(" + row.colorVar + ")" }
              })),
            h("div", { className: "ut-ses-meta" }, row.metaText),
            h("div", { className: "ut-ses-dur" }, row.activeText)
          ));
        }
        groups.push(h("div", { className: "ut-ses-group", key: group.key, "data-usage-role": "ses-group" },
          h("div", { className: "ut-ses-group-head" },
            h("span", { className: "ut-ses-dot", style: { background: "var(" + group.colorVar + ")" } }),
            h("span", null, group.label),
            h("span", { className: "ut-ses-group-path" }, group.fullPath),
            h("span", { className: "ut-ses-group-total" }, group.totalText)),
          rows
        ));
      }
      return h("div", { className: "ut-ses-groups", "data-usage-role": "ses-groups" }, groups);
    }

    /** B 视图正文：逐日活动带（一行一个会话 × 近 14 天；强度相对**全局最大单日**）。 */
    function sessionsBandNode (ses, t) {
      var axisChildren = [h("div", { key: "label" }, "")];
      for (var a = 0; a < ses.bandAxis.length; a += 1) {
        axisChildren.push(h("span", { key: ses.bandAxis[a].key }, ses.bandAxis[a].label.slice(3)));
      }
      axisChildren.push(h("div", { key: "total" }, ""));
      var rows = [];
      for (var r = 0; r < ses.bands.length; r += 1) {
        var band = ses.bands[r];
        var cells = [];
        for (var c = 0; c < band.cells.length; c += 1) {
          var cell = band.cells[c];
          cells.push(h("div", {
            key: cell.key,
            className: "ut-ses-band-cell" + (cell.level > 0 ? " ut-ses-band-l" + cell.level : ""),
            title: cell.title,
            // 🎨 **颜色 = 这天多长**（强度色阶，1~4 档蓝→青→绿→黄）；`ut-ses-band-lN` 的 opacity 仍叠加，
            // 所以"同档不同行"也能靠不透明度区分一点点。0 档不上色（保持宿主底）。
            style: cell.level > 0 ? { background: "var(" + heatVarOf(cell.level) + ")" } : undefined,
            "data-usage-role": "ses-band-cell"
          }));
        }
        rows.push(h("div", {
          className: "ut-ses-band-row",
          key: band.id,
          "data-usage-role": "ses-band-row",
          title: band.title + " · " + band.metaText
        },
          sessionNameNode(band, t),
          cells,
          h("div", { className: "ut-ses-dur" }, band.totalText)
        ));
      }
      // 轴与行必须**一起**横向滚动（分两个容器滚会错位）⇒ 统一包一层滚动容器
      return h("div", { className: "ut-ses-band-wrap", "data-usage-role": "ses-band-wrap" },
        h("div", { className: "ut-ses-band-axis" }, axisChildren),
        h("div", { className: "ut-ses-band", "data-usage-role": "ses-band" }, rows)
      );
    }

    /** C 视图正文：左栏列表（名字 + 时长）+ 右栏选中会话的逐日结构。 */
    function sessionsMasterNode (ses, t, onPick) {
      var items = [];
      for (var i = 0; i < ses.listRows.length; i += 1) {
        var row = ses.listRows[i];
        items.push(h("button", {
          type: "button",
          key: row.id,
          className: "ut-ses-item" + (row.active === true ? " ut-ses-item-on" : ""),
          "data-usage-role": "ses-item",
          "data-id": row.id,
          "aria-pressed": row.active === true ? "true" : "false",
          title: row.title,
          onClick: pickHandler("ses.pick", row.id, onPick)
        },
          h("span", { className: "ut-ses-dot", style: { background: "var(" + row.colorVar + ")" } }),
          h("span", { className: "ut-ses-item-name" }, row.title),
          h("span", { className: "ut-ses-item-dur" }, row.activeText)
        ));
      }
      var detail = ses.selected !== null && typeof ses.selected === "object" ? ses.selected : null;
      var bars = [];
      var kpis = [];
      if (detail !== null) {
        for (var b = 0; b < detail.dayBars.length; b += 1) {
          var bar = detail.dayBars[b];
          bars.push(h("div", { className: "ut-ses-day", key: bar.key, title: bar.title },
            h("div", {
              className: "ut-ses-day-bar",
              style: {
                height: clampPct(bar.heightPct) + "%",
                background: bar.level > 0 ? "var(" + heatVarOf(bar.level) + ")" : "var(--ut-c1)"
              }
            }),
            h("span", { className: "ut-ses-day-label" }, bar.label.slice(3))
          ));
        }
        kpis = [
          { key: "win", label: t("ses.winTotal"), sub: "", value: detail.activeText },
          { key: "all", label: t("ses.allTotal"), sub: "", value: detail.totalText },
          { key: "seg", label: t("ses.segs"), sub: "", value: detail.segText },
          { key: "turn", label: t("ses.turns"), sub: "", value: detail.turnText },
          { key: "long", label: t("ses.longest"), sub: "", value: detail.longestText },
          { key: "last", label: t("ses.last"), sub: "", value: detail.lastText }
        ];
      }
      return h("div", { className: "ut-ses-split", "data-usage-role": "ses-split" },
        h("div", {
          className: "ut-ses-list",
          role: "group",
          "aria-label": t("ses.detail.aria")
        }, items),
        h("div", { className: "ut-ses-detail", "data-usage-role": "ses-detail" },
          detail === null
            ? h("div", { className: "ut-ses-note" }, t("ses.emptyPick"))
            : h("div", null,
              h("div", { className: "ut-ses-detail-title", title: detail.fullPath }, detail.title),
              kpiGrid(kpis),
              h("div", { className: "ut-skel-sec" }, t("ses.detail.daily")),
              h("div", { className: "ut-ses-days", "data-usage-role": "ses-days" }, bars)
            )
        )
      );
    }

    /** `YYYYMMDD-HHmm`（本地时区）—— 给导出文件名用。 */
    function stampOf (ms) {
      var value = numOf(ms);
      // 实测：非有限 / **越出可写的 4 位年份**（如 1e15 是"合法日期"但年份 336580927）一律退回"现在"
      var d = new Date(value === null ? Date.now() : value);
      var year = d.getFullYear();
      if (!isFinite(d.getTime()) || !isFinite(year) || year < 1970 || year > 9999) d = new Date();
      return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
        "-" + pad2(d.getHours()) + pad2(d.getMinutes());
    }

    /**
     * Markdown 表格单元格转义。
     * 🩸 实测发现（2026-10-14，用 marked 15 实测复现）：
     *   ① **必须先转反斜杠再转竖线**（顺序反了会把刚加的 `\|` 再转一遍）；
     *     漏了反斜杠时，标题写 `a\|b` 会让表格**列整体左移、末列丢失**；
     *   ② **裸 CR 也是行尾**（CommonMark）—— `\r?\n` 匹配不到单独的 `\r`，会让表格行腰斩、后面几列全空。
     * 逆序或漏项都会"看起来像转义了，其实被下游渲染器拆表"。
     */
    function mdCellOf (text) {
      if (text === null || text === undefined) return "";
      // 对象不许被 String() 成 `[object Object]`（实测）；数组也不适合直接进单元格
      if (typeof text === "object") return "";
      return String(text)
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\r?\n|\r/g, " ")
        .replace(/`/g, "\\`");
    }

    /**
     * A2：把当前模型导出成一份 **Markdown 报告**（**纯函数、零副作用** ⇒ 可以被断言）。
     * ⚠️ 只写**本插件真拿得到的数据**：本会话概览 / 日历累计 / 会话清单 / 子代理构成 / 工作区趋势 / 口径说明。
     *    **token 与费用不在本插件的数据源里 ⇒ 报告里一个字都不提**（不假装有）。
     * ⚠️ 生成与下载都在客户端完成（**零网络请求**）；"定时发邮件"那半留给后续决策（会在桌面留痕）。
     */
    function buildMarkdownReport (model, t, nowMs) {
      var lines = [];
      var at = numOf(nowMs);
      lines.push("# " + t("export.title"));
      lines.push("");
      lines.push("> " + t("export.generatedAt") + " " + (at !== null ? formatClock(at) : EM_DASH) + " · " + t("export.localZone"));
      lines.push("");

      var md = model !== null && typeof model === "object" ? model : {};

      // ① 本会话概览
      if (Array.isArray(md.kpis) && md.kpis.length > 0) {
        lines.push("## " + t("card.kpi"));
        lines.push("");
        lines.push("| " + t("export.metric") + " | " + t("export.value") + " |");
        lines.push("|---|---|");
        for (var i = 0; i < md.kpis.length; i += 1) {
          var kpi = md.kpis[i] === null || typeof md.kpis[i] !== "object" ? {} : md.kpis[i];
          lines.push("| " + mdCellOf(kpi.label) + " | " + mdCellOf(kpi.value) + " |");
        }
        lines.push("");
      }

      // ② 日历累计（今日 / 本周 / 本月）
      var cal = md.calendar !== null && typeof md.calendar === "object" ? md.calendar : null;
      if (cal !== null && cal.hasData === true && Array.isArray(cal.cumKpis)) {
        lines.push("## " + t("card.calendar"));
        lines.push("");
        lines.push("| " + t("export.metric") + " | " + t("export.value") + " |");
        lines.push("|---|---|");
        for (var c = 0; c < cal.cumKpis.length; c += 1) {
          var cum = cal.cumKpis[c] === null || typeof cal.cumKpis[c] !== "object" ? {} : cal.cumKpis[c];
          // 实测：`delta` 形状对但 `text` 不是字符串时，不许印出 `(undefined)`
          var deltaText = cum.delta !== null && typeof cum.delta === "object" && typeof cum.delta.text === "string"
            ? " (" + cum.delta.text + ")"
            : "";
          lines.push("| " + mdCellOf(cum.label) + " | " + mdCellOf(cum.value) + mdCellOf(deltaText) + " |");
        }
        lines.push("");
      }

      // ③ 会话清单（按工作区分组；只写**身份 + 窗口内活跃 + 全日志总量**）
      var ses = md.sessions !== null && typeof md.sessions === "object" ? md.sessions : null;
      if (ses !== null && ses.hasData === true && Array.isArray(ses.groups)) {
        lines.push("## " + t("card.sessions"));
        lines.push("");
        lines.push("| " + t("export.session") + " | " + t("export.workspace") + " | " + t("export.activeInWindow") + " | " + t("export.allTimeTotal") + " |");
        lines.push("|---|---|---|---|");
        for (var g = 0; g < ses.groups.length; g += 1) {
          var group = ses.groups[g] === null || typeof ses.groups[g] !== "object" ? null : ses.groups[g];
          if (group === null || !Array.isArray(group.sessions)) continue;
          for (var s = 0; s < group.sessions.length; s += 1) {
            var row = group.sessions[s] === null || typeof group.sessions[s] !== "object" ? {} : group.sessions[s];
            lines.push("| " + mdCellOf(row.title) + " | " + mdCellOf(group.label) + " | " +
              mdCellOf(row.activeText) + " | " + mdCellOf(row.totalText) + " |");
          }
        }
        lines.push("");
      }

      // ④ 子代理构成
      if (ses !== null && ses.subagentStats !== null && typeof ses.subagentStats === "object") {
        var sub = ses.subagentStats;
        lines.push("## " + t("card.subagent"));
        lines.push("");
        lines.push("- " + t("subagent.count") + "：" + mdCellOf(sub.countText));
        lines.push("- " + t("subagent.active") + "：" + mdCellOf(sub.activeText));
        lines.push("");
      }

      // ⑤ 工作区趋势（只写总量，柱子是图，报告里没有）
      if (cal !== null && cal.wsTrend !== null && typeof cal.wsTrend === "object" &&
        cal.wsTrend.hasData === true && Array.isArray(cal.wsTrend.rows)) {
        lines.push("## " + t("card.wsTrend"));
        lines.push("");
        lines.push("| " + t("export.workspace") + " | " + t("export.allTimeTotal") + " |");
        lines.push("|---|---|");
        for (var w = 0; w < cal.wsTrend.rows.length; w += 1) {
          var tr = cal.wsTrend.rows[w] === null || typeof cal.wsTrend.rows[w] !== "object" ? {} : cal.wsTrend.rows[w];
          lines.push("| " + mdCellOf(tr.label) + " | " + mdCellOf(tr.totalText) + " |");
        }
        lines.push("");
      }

      // ⑥ 口径说明（把三处口径原样带上，报告离开界面也讲得清）
      lines.push("## " + t("export.caliber"));
      lines.push("");
      if (ses !== null && typeof ses.caliber === "string" && ses.caliber.length > 0) lines.push("- " + ses.caliber);
      if (cal !== null && typeof cal.note === "string" && cal.note.length > 0) lines.push("- " + cal.note);
      if (typeof md.sourceNote === "string" && md.sourceNote.length > 0) lines.push("- " + md.sourceNote);
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push("*" + t("export.footer") + "*");
      return lines.join("\n") + "\n";
    }

    /**
     * A2：在客户端触发一次下载（**零网络请求**）。
     * ⚠️ 座位缺失 / 抛异常一律**静默返回 false**（由调用方决定是否提示），绝不把异常带进渲染。
     */
    function downloadText (fileName, text) {
      try {
        if (typeof document === "undefined" || document === null) return false;
        var blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return true;
      } catch (err) {
        return false;
      }
    }

    /** 会话分段入口：空态骨架 ⇒ 或真数据主卡（工具条 + 当前视图 + 口径脚注）。 */
    function sessionsBody (model, t, onPick) {
      var ses = model !== null && typeof model === "object" &&
        model.sessions !== null && typeof model.sessions === "object"
        ? model.sessions
        : null;
      if (ses === null || ses.hasData !== true) {
        var rows = [
          { label: t("ses.recent") },
          { label: t("ses.durRank") },
          { label: t("ses.workspace") }
        ];
        return [skeletonCard("sessions", "card.sessions", "ses.sub", rows, t, "ses.emptyNote")];
      }
      var bodyNode = sessionsGroupNode(ses, t);
      if (ses.view === "b") bodyNode = sessionsBandNode(ses, t);
      else if (ses.view === "c") bodyNode = sessionsMasterNode(ses, t, onPick);
      var notes = [
        h("div", { className: "ut-source", key: "note", "data-usage-role": "ses-note" }, ses.note),
        h("div", { className: "ut-source", key: "caliber", "data-usage-role": "ses-caliber" }, ses.caliber)
      ];
      if (ses.uncovered > 0) {
        notes.push(h("div", { className: "ut-source", key: "unc", "data-usage-role": "ses-uncovered" },
          t("ses.uncoveredPre") + ses.uncovered + t("ses.uncoveredSuf")));
      }
      // A 视图不参与截断（列全部会话）⇒ 截断脚注只对 B / C 有意义（实测发现）
      if (ses.capped > 0 && ses.view !== "a") {
        var capText = t("ses.cappedPre") + SESSION_LIST_LIMIT + t("ses.cappedMid") + ses.capped + t("ses.cappedSuf");
        if (ses.selectedPinned === true) capText += " " + t("ses.cappedPinned");
        notes.push(h("div", { className: "ut-source", key: "cap", "data-usage-role": "ses-capped" }, capText));
      }
      // 提示可以**同时有两条**（例如 B 视图 + 筛选没中）：空的原因与"只有逐日粒度"的口径互不冲突，
      // 不该互相顶掉（实测发现）
      var hints = [];
      if (ses.emptyKind === "rangeEmpty" && ses.rangeHint !== "") hints.push(ses.rangeHint);
      if (ses.emptyKind === "zeroActive" && ses.zeroHint !== "") hints.push(ses.zeroHint);
      if (ses.emptyKind === "workspaceMiss" && ses.pickHint !== "") hints.push(ses.pickHint);
      if (ses.emptyKind === "windowEmpty" && ses.windowHint !== "") hints.push(ses.windowHint);
      if (ses.view === "b") hints.push(t("ses.band.note"));
      var hintNodes = [];
      for (var hi = 0; hi < hints.length; hi += 1) {
        if (hints[hi] === "") continue;
        hintNodes.push(h("div", { className: "ut-ses-note", key: "hint" + hi, "data-usage-role": "ses-hint" }, hints[hi]));
      }
      notes = hintNodes.concat(notes);
      return [h("div", { className: "ut-card", key: "sessions" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("card.sessions")),
          h("span", { className: "ut-card-tag", "data-usage-role": "ses-count" }, ses.countText)),
        h("div", { className: "ut-card-sub" }, t("ses.sub")),
        sessionsToolsNode(ses, t, onPick),
        bodyNode,
        notes
      )].concat(ses.subagentStats.subSessions > 0 ? [subagentCard(ses, t)] : []);
    }

    /** 设置里的一个偏好项：名字 + 说明 + 分段单选 + 当前值。 */
    function settingItem (key, nameKey, subKey, control, valueText, t) {
      return h("div", { className: "ut-set-item", key: key },
        h("div", { className: "ut-set-name" }, t(nameKey)),
        h("div", { className: "ut-set-hint" }, t(subKey)),
        control,
        h("div", { className: "ut-set-value" }, valueText)
      );
    }

    /** 设置分段：三项偏好（空闲阈值 / 时区 / 数据范围）+ 口径说明（含 source.note 那段话）。 */
    function settingsBody (model, t, onPick) {
      var s = model.settings;
      var items = [
        settingItem("idle", "set.idle", "set.idle.sub",
          segControl("pref.idle", s.idleOptions, onPick, t, "ut-seg-sm"), s.idleText, t),
        settingItem("tz", "set.tz", "set.tz.sub",
          segControl("pref.timezone", s.tzOptions, onPick, t, "ut-seg-sm"), s.timezone, t),
        settingItem("scope", "set.scope", "set.scope.sub",
          segControl("pref.scope", s.scopeOptions, onPick, t, "ut-seg-sm"), s.scopeText, t),
        settingItem("goal", "set.goal", "set.goal.sub",
          segControl("pref.goal", s.goalOptions, onPick, t, "ut-seg-sm"), s.goalText, t)
      ];
      var prefsCard = h("div", { className: "ut-card", key: "prefs" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("set.title"))
        ),
        h("div", { className: "ut-card-sub" }, t("set.sub")),
        h("div", { className: "ut-set" }, items),
        s.scopePending
          ? h("div", { className: "ut-set-pending", "data-usage-role": "scope-pending" }, t("set.scopePending"))
          : null
      );
      var metricCard = h("div", { className: "ut-card", key: "metric" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("set.metric"))
        ),
        h("div", { className: "ut-source", "data-usage-role": "caliber-note" }, model.sourceNote),
        h("div", { className: "ut-set-hint" }, t("set.store") + s.storeKey + "。"),
        h("div", { className: "ut-set-hint" }, t("set.fallback"))
      );
      // A2：导出卡（**纯本地**：在客户端生成 Markdown 并下载，零网络请求）
      var exportCard = h("div", { className: "ut-card", key: "export" },
        h("div", { className: "ut-card-title" },
          h("span", { className: "ut-card-title-text" }, t("export.title"))
        ),
        h("div", { className: "ut-card-sub" }, t("export.hint")),
        h("button", {
          type: "button",
          className: "ut-btn",
          "data-usage-role": "export-btn",
          onClick: function () {
            // ⚠️ 导出失败**不许影响界面**（下载被拦 / Blob 不可用等）⇒ 静默返回
            try {
              var text = buildMarkdownReport(model, t, Date.now());
              downloadText("dsh-usage-" + stampOf(Date.now()) + ".md", text);
            } catch (err) { /* 故意吞掉：这是用户手势里的最后一步，崩界面比不下载更糟 */ }
          }
        }, t("export.btn"))
      );
      return [prefsCard, metricCard, exportCard];
    }

    /**
     * 分段 → 正文节点数组。**唯一派发点**：UsageView 只管状态，正文全部在这里。
     * 未知 key 一律回退概览（绝不渲染空屏）。
     */
    function renderSegment (segment, model, t, onPick) {
      var key = SEGMENT_KEYS.indexOf(segment) >= 0 ? segment : DEFAULT_SEGMENT;
      if (key === "calendar") return calendarBody(model, t);
      if (key === "kline") return klineBody(model, t);
      if (key === "sessions") return sessionsBody(model, t, onPick);
      if (key === "settings") return settingsBody(model, t, onPick);
      return overviewBody(model, t);
    }

    /**
     * tab 根组件。props 契约：
     *   sessionId / useProjection / useSession（ui-session）
     *   useChat（ui-chat）    t（locale: NS 声明后框架合成）
     *
     * P1.1：hook 调用点从 3 个增到 5 个（两次 useChat + 一次 useProjection +
     * 两个 useState），顺序固定、无条件，不随分支变化（hook 规则）。
     * P2 第一步：再增 1 个（`useSessions`）⇒ 共 6 个，顺序固定为
     * useProjection → useChat → useChat → useSessions → useState → useState。
     */
    function UsageView (props) {
      var t = typeof props.t === "function" ? props.t : defaultT;

      // 三条通道，固定顺序、无条件各调一次（hook 规则）。
      var stats = projectionOf(props, "sessionStats");                                   // 通道 A
      var turnTimings = chatSliceOf(props, function (s) {                                // 通道 B
        return s !== null && typeof s === "object" && s.legacy !== undefined ? s.legacy.turnTimings : undefined;
      });
      var timeline = chatSliceOf(props, function (s) {                                   // 通道 C
        return s !== null && typeof s === "object" ? s.timeline : undefined;
      });
      // P2 第一步：会话列表快照（通道 D）。日历分段从每行的投影值里读宿主 usageDaily，
      // **零 I/O**。它同样必须无条件、固定顺序地调用（hook 规则），顺序：A / B / C / D。
      var sessionsSnap = sessionsSliceOf(props);

      // P1.1：偏好（惰性初值 = 挂载时读一次 localStorage，读失败静默回退默认值）
      // 与当前分段。**两个 useState 无条件、固定顺序**，不许放进任何分支。
      var prefState = react.useState(function () { return readPrefs(); });
      var prefs = normalizePrefs(prefState[0]);
      var setPrefs = prefState[1];
      var segState = react.useState(DEFAULT_SEGMENT);
      var segment = SEGMENT_KEYS.indexOf(segState[0]) >= 0 ? segState[0] : DEFAULT_SEGMENT;
      var setSegment = segState[1];
      // P2 第三步：「会话」页 C 视图**选中的会话 id**（**临时状态**，不落 localStorage ——
      // 会话可能被删，持久化一个已不存在的 id 没有意义）。
      // hook 数量 6 → 7，顺序固定：useProjection → useChat ×2 → useSessions → useState ×3。
      var sesPickState = react.useState("");
      var sesPick = typeof sesPickState[0] === "string" ? sesPickState[0] : "";
      var setSesPick = sesPickState[1];

      var model = buildModel({
        stats: stats,
        turnTimings: turnTimings,
        timeline: timeline,
        sessions: sessionsSnap,
        sesSelectedId: sesPick,
        openEndFallback: Date.now(),
        idleMs: idleMsOf(prefs),
        prefs: prefs
      }, t);

      /**
       * 分段 / 偏好点击的统一入口（**唯一改状态的地方**）：
       * 先归一化出新偏好 → 落状态 → 写回 localStorage。
       * 写失败（隐私模式 / 配额满）静默忽略，界面照常切（规格硬要求）。
       */
      function pick (group, value) {
        if (group === "subnav") {
          if (typeof setSegment === "function") setSegment(value);
          return;
        }
        // C 视图的「选中会话」是**临时状态**，不落 localStorage（会话可能被删，持久化一个
        // 已经不存在的 id 没有意义）⇒ 它走独立的 useState，不进 prefs。
        if (group === "ses.pick") {
          if (typeof setSesPick === "function") setSesPick(String(value));
          return;
        }
        var patch = {};
        if (group === "pref.idle") patch.idleMinutes = Number(value);
        else if (group === "pref.timezone") patch.timezone = value;
        else if (group === "pref.scope") patch.scope = value;
        else if (group === "pref.goal") patch.weeklyGoalMinutes = Number(value);
        else if (group === "ses.view") patch.sesView = value;
        else if (group === "ses.win") patch.sesWindow = Number(value);
        else if (group === "ses.ws") patch.sesWorkspace = value === undefined || value === null ? "" : String(value);
        else return;
        var next = normalizePrefs(Object.assign({}, prefs, patch));
        if (typeof setPrefs === "function") setPrefs(next);
        writePrefs(null, next);
      }

      // 顶部：二级分段导航；其下：当前分段的正文。脚注在概览分段里仍是最后一项。
      var cards = [subnavNode(segment, t, pick)];
      var body = renderSegment(segment, model, t, pick);
      for (var i = 0; i < body.length; i++) cards.push(body[i]);

      return h("div", { className: "ut-root" }, cards);
    }

    //#endregion

    //#region §6 apply / 导出

    function warn (message, err) {
      if (typeof console !== "undefined" && console && typeof console.warn === "function") {
        console.warn("[dsh-usage-tab] " + message, err === undefined ? "" : err);
      }
    }

    function disposerOf (disposers) {
      return function dispose () {
        for (var i = disposers.length - 1; i >= 0; i--) {
          try {
            disposers[i]();
          } catch (err) {
            warn("清理时出错", err);
          }
        }
      };
    }

    /**
     * 注册「时间统计」tab。
     *
     * 逐字对照 dsh-context 的注册：
     *   ctx.slots.inject("conversation.view", () => ctx.slots.register({...}, Comp))
     * `order: 30` ⇒ 排在 chat(0) / trajectory(10) / context(20) 右边 ——
     * list 槽位是**升序**（先 priority 再 order）。
     */
    function apply (ctx) {
      var disposers = [];
      var t = defaultT;
      var localeOk = false;

      try {
        if (ctx && ctx.locale && typeof ctx.locale.register === "function") {
          var localeDisposer = ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
          if (typeof localeDisposer === "function") disposers.push(localeDisposer);
          if (typeof ctx.locale.bind === "function") {
            var bound = ctx.locale.bind(NS);
            if (typeof bound === "function") {
              t = bound;
              localeOk = true;
            }
          }
        }
      } catch (err) {
        warn("locale 注册失败，回退内置中文字典", err);
      }

      var slots = ctx ? ctx.slots : null;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
        warn("slots 服务不可用，未注册 tab", null);
        return disposerOf(disposers);
      }

      try {
        var options = {
          name: "conversation.view",
          id: "usage",
          order: 30,
          label: function () { return localeOk ? t("tab") : DICT_ZH.tab; }
        };
        // 只有字典真的注册成功才声明 locale 命名空间：框架对声明了 locale
        // 却没装字典的条目是 fail-loud（SLOTS-D:604-610），这里主动降级更安全。
        if (localeOk) options.locale = NS;

        var slotDisposer = slots.inject("conversation.view", function () {
          return slots.register(options, function (props) {
            return h(UsageView, props);
          });
        });
        if (typeof slotDisposer === "function") disposers.push(slotDisposer);
      } catch (err) {
        warn("tab 注册失败", err);
      }

      return disposerOf(disposers);
    }

    // 模块一旦 materialize 就注入样式（与 dsh-context 同：CSS 常驻全局）。
    injectCss();

    module.exports = {
      name: NS,
      inject: ["slots", "locale"],
      apply: apply,
      /**
       * 自测出口（**唯一为测试存在的字段**）：给 test/self-test.mjs 直接
       * require 本 bundle 后取纯函数，避免"测试重复实现一份"。
       */
      __test: {
        NS: NS,
        IDLE_THRESHOLD_MS: IDLE_THRESHOLD_MS,
        RANK_LIMIT: RANK_LIMIT,
        MIN_BAR_PCT: MIN_BAR_PCT,
        EM_DASH: EM_DASH,
        // —— P1.1 二级菜单 / 偏好 ——
        SEGMENT_KEYS: SEGMENT_KEYS,
        DEFAULT_SEGMENT: DEFAULT_SEGMENT,
        PREF_KEY: PREF_KEY,
        DEFAULT_PREFS: DEFAULT_PREFS,
        PREF_IDLE_CHOICES: PREF_IDLE_CHOICES,
        PREF_TIMEZONES: PREF_TIMEZONES,
        PREF_SCOPES: PREF_SCOPES,
        DICT_ZH: DICT_ZH,
        DICT_EN: DICT_EN,
        CSS: CSS,
        numOf: numOf,
        pad2: pad2,
        isMapLike: isMapLike,
        collectTurnSpans: collectTurnSpans,
        stepStartsOf: stepStartsOf,
        mergeSegments: mergeSegments,
        summarizeUsage: summarizeUsage,
        hourlyStepCounts: hourlyStepCounts,
        hourlyActiveMs: hourlyActiveMs,
        formatDuration: formatDuration,
        formatPercent: formatPercent,
        formatCount: formatCount,
        formatClock: formatClock,
        rankTurns: rankTurns,
        clampPct: clampPct,
        ganttRows: ganttRows,
        normalizeHeights: normalizeHeights,
        storageOf: storageOf,
        parsePrefs: parsePrefs,
        normalizePrefs: normalizePrefs,
        readPrefs: readPrefs,
        writePrefs: writePrefs,
        idleMsOf: idleMsOf,
        withCurrent: withCurrent,
        // —— P2 第一步：宿主 usageDaily 投影 ——
        USAGE_DAILY_KEY: USAGE_DAILY_KEY,
        CALENDAR_HEAT_DAYS: CALENDAR_HEAT_DAYS,
        CALENDAR_BAR_DAYS: CALENDAR_BAR_DAYS,
        nonNegOf: nonNegOf,
        isDayKey: isDayKey,
        dayKeyOf: dayKeyOf,
        parseDayKey: parseDayKey,
        dayKeyAddDays: dayKeyAddDays,
        weekStartKeyOf: weekStartKeyOf,
        cleanUsageDaily: cleanUsageDaily,
        usageRowsOf: usageRowsOf,
        aggregateUsageDaily: aggregateUsageDaily,
        buildCalendarModel: buildCalendarModel,
        // 🩸 复审实测：导出来让断言能**直接**钉住越界行为（原先只能靠 daysInMonthOf 间接兜住）
        prevMonthPrefixOf: prevMonthPrefixOf,
        daysInMonthOf: daysInMonthOf,
        daysBetweenKeys: daysBetweenKeys,
        buildWorkspaceTrend: buildWorkspaceTrend,
        buildKlineModel: buildKlineModel,
        KLINE_DAYS: KLINE_DAYS,
        KLINE_AXIS_MS: KLINE_AXIS_MS,
        buildMarkdownReport: buildMarkdownReport,
        stampOf: stampOf,
        normalizePrefs: normalizePrefs,
        PREF_WEEKLY_GOALS: PREF_WEEKLY_GOALS,
        collectSessionUsage: collectSessionUsage,
        WS_TREND_WEEKS: WS_TREND_WEEKS,
        WS_TREND_LIMIT: WS_TREND_LIMIT,
        buildSessionsModel: buildSessionsModel,
        sessionRowModel: sessionRowModel,
        workspaceLabelOf: workspaceLabelOf,
        SESSION_VIEWS: SESSION_VIEWS,
        SESSION_WINDOWS: SESSION_WINDOWS,
        SESSION_RANGES: SESSION_RANGES,
        DEFAULT_SESSION_RANGE: DEFAULT_SESSION_RANGE,
        DEFAULT_SESSION_VIEW: DEFAULT_SESSION_VIEW,
        DEFAULT_SESSION_WINDOW: DEFAULT_SESSION_WINDOW,
        SESSION_BAND_DAYS: SESSION_BAND_DAYS,
        SESSION_LIST_LIMIT: SESSION_LIST_LIMIT,
        buildModel: buildModel,
        apply: apply,
        UsageView: UsageView,
        renderSegment: renderSegment,
        subnavNode: subnavNode,
        segControl: segControl,
        skeletonRows: skeletonRows,
        kpiGrid: kpiGrid,
        sessionsSliceOf: sessionsSliceOf,
        overviewBody: overviewBody,
        calendarBody: calendarBody,
        sessionsBody: sessionsBody,
        settingsBody: settingsBody
      }
    };

    //#endregion

    return module.exports;
  }
});
