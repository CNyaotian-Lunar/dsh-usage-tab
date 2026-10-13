# dsh-usage-tab

给 DSH Web 会话页签加一个 **「时间统计」** tab（排在 dsh-context 的「上下文」右边），
把**本会话**的时间面貌画出来：挂钟跨度、活跃/空闲、每轮甘特、每小时分布、最慢的几轮。

**English:** Adds a **"Time Stats"** tab to DSH Web session tabs (placed to the right of **"Context"** from dsh-context) that charts the time profile of **the current session**: wall-clock span, active/idle split, a per-turn Gantt chart, an hourly distribution, and the slowest turns.

> **P1 状态**：tab 界面 + 本会话真实数据。数据**全部**来自本会话已有的三条现成通道，
> 不碰宿主日志、不扫盘、不读 `session_projcache`。跨会话 / 全历史是 **P2**。
>
> **English:** **P1 status**: the tab UI plus real data for the current session. **All** the data comes from three channels the session already exposes; it does not touch host logs, scan the disk, or read `session_projcache`. Cross-session / full-history support is **P2**.
>
> **P1.1**：二级菜单（概览 / 日历 / 会话 / 设置）+ 三项偏好（空闲阈值 / 时区 / 数据范围）+ P1 口径止血。
>
> **English:** **P1.1**: a sub-navigation menu (Overview / Calendar / Sessions / Settings), three preferences (idle threshold / time zone / data range), and stop-the-bleeding fixes for the P1 metric semantics.
>
> **P2 第一步**：宿主半边注册自己的会话投影单元 `usageDaily`（把**会话事件时间戳**按宿主本地时区
> 折成逐日活跃毫秒 + 总活跃/轮数/段数/最长段），**「日历」页读真数据** —— 走**会话列表行自带的
> 投影值**（`row.projectionValues.usageDaily`，零额外 I/O），跨会话求和成 今日/本周/本月 +
> 近 12 周热力图 + 近 14 天柱状 + 段统计。**拿不到就保持空态**（值一律 `—`）。
>
> **English:** **P2, step 1**: the host half registers its own session projection unit, `usageDaily` (folding **session event timestamps** into per-day active milliseconds in the host's local time zone, plus total active time / turn count / segment count / longest segment). The **Calendar page now reads real data** — taken from **the projection values carried by each session list row** (`row.projectionValues.usageDaily`, zero extra I/O) — summed across sessions into today / this week / this month totals, a 12-week heatmap, a 14-day bar chart, and segment statistics. **If none of it is available, the view stays empty** (every value shows `—`).
>
> **P2 第二步**：**冷会话回填** —— 启动 5 秒后（`BACKFILL_START_DELAY_MS`），对「从没打开过、
> 也没被写过投影缓存」的老会话逐条冷读日志、交给宿主 `sessionProjectionCache.coldSnapshot`
> 补上 `usageDaily`。三条照跳的口径：**live 会话**（它自己会折）/ **缓存里已有该键的会话** /
> **`header.cwd` 缺失的记录**（含子代理会话）。旧日志被源侧拒读（`SessionFormatUnsupported*`）
> 时只记一条 `debug` + 一条计数 info，**绝不改写源文件**；单个失败不中断后续；卸载时 abort。
> 复验工具：`node tools/projcache-probe.mjs`（只读，回填前后各跑一次对比）。
> **实测复验（2026-10-13，重启后）**：`usageDaily` 覆盖率 **85.0% → 94.2%**，
> 「只有本插件缺」**归零**；剩余那批全为「两键同缺」（源侧拒读，按红线接受并记录）。
>
> **English:** **P2, step 2**: **cold-session backfill** — 5 seconds after startup (`BACKFILL_START_DELAY_MS`), old sessions that have **never been opened and never had a projection cached** are read back one by one from their cold logs and handed to the host's `sessionProjectionCache.coldSnapshot` to fill in `usageDaily`. Three cases are skipped by design: **live sessions** (they fold their own data) / **sessions that already have that key in the cache** / **records missing `header.cwd`** (including subagent sessions). When the source side refuses to read an old log (`SessionFormatUnsupported*`), the plugin records a single `debug` line plus one counter info line and **never rewrites the source file**; a single failure does not abort the rest, and uninstalling triggers an abort. Re-check tool: `node tools/projcache-probe.mjs` (read-only; run it before and after backfill and compare). **On-device re-check (2026-10-13, after a restart):** `usageDaily` coverage went from **85.0% to 94.2%**, and "missing only for this plugin" went to **zero**; the rest are all "both keys missing" (the batch the source side refuses to read, accepted and logged per the hard-line rule).
>
> **P2 第三步**：**「会话」页**（照一份「一页多视图 + 选项卡」的 UI 规范）——
> **A 默认**：按工作区分组的纵向表 + 行内比例条（回答"时间花在哪个项目上"）；**B**：逐日活动带
> （14 列 × 一行一会话，强度相对**全局最大单日**）；**C**：主从双栏（左栏清单、右栏选中会话的逐日条形 + 总量）。
> 数据全部来自**会话列表行自带的** `row.projectionValues.usageDaily`（零请求、零额外 I/O）。
> 🩸 **口径**：时长按所选时间窗（近 7 / 30 天 / 全部）逐日相加；**段数 / 轮数 / 最长段是宿主的全日志总量**，
> 不随窗口变 —— 两类在卡面上分开写、绝不合成一个数。**拿不到任何一行 ⇒ 保持空态骨架（值一律 `—`）**。
> 三个工具条控件各管一摊：**视图**（A / B / C）· **时间窗**（近 7 / 30 天 / 全部，只管**时长怎么统计**）·
> **显示范围**（7 / 14 / 30 天内 / 不限，只管**哪些会话还列出来** —— 按"最后活动日"算，**默认 14 天**）。
> 清单上限 `SESSION_LIST_LIMIT = 40`（**B / C 视图截断**；**A 视图列全部会话**、靠容器滚动 ——
> 按全局 40 条截断会把排在 40 名之后的**整个工作区抹掉**），被截掉的数量写脚注；
> 条长 / 档位 / 柱高的基准取**范围内全部会话**的最大值（筛选只改可见性、不改深浅的含义）。
> 五种"空"分开表述：显示范围挡光 / 工作区筛不中 / 窗口内无活跃 / 全零活跃 / 真的没有投影。
> ⚠️ **宿主半边（`lib/index.mjs`）与客户端半边（`lib/client.js`）的改动都必须重启桌面版 App 才生效** ——
> 本机是 Electron 套壳，**没有「刷新页面」这个动作**。
>
> **English:** **P2, step 3**: the **Sessions page** (following the "one page, multiple views plus a tab strip" pattern in a UI specification document) — **View A (default)**: a vertical table grouped by workspace with in-row proportion bars (answering "which project is the time going to"); **View B**: a daily-activity strip (14 columns by one row per session, intensity relative to the **globally busiest single day**); **View C**: a master-detail two-column layout (a list on the left, per-day bars plus totals for the selected session on the right). All data comes from **the `row.projectionValues.usageDaily` carried by the session list rows** (zero requests, zero extra I/O). 🩸 **Semantics**: durations are summed per day over the selected time window (last 7 / 30 days / all); **segment count / turn count / longest segment are the host's whole-log totals** and do not change with the window — the two kinds are written separately on the card and never blended into a single number. **If no row is available, the skeleton stays empty (every value `—`).** The three toolbar controls each own one thing: **View** (A / B / C) · **Time window** (last 7 / 30 days / all, controlling only **how durations are counted**) · **Display range** (within 7 / 14 / 30 days / unlimited, controlling only **which sessions are still listed**, computed from the "last active day", **default 14 days**; sessions untouched for too long are hidden by default). The list cap is `SESSION_LIST_LIMIT = 40` (**Views B / C truncate**; **View A lists every session** and relies on container scrolling — truncating globally at 40 would **wipe out entire workspaces** ranked past 40), and the number cut off is written in a footnote. The baselines for bar length / shading level / bar height are taken from the maximum across **all sessions in range** (filtering only changes visibility, not what the shading means). The five kinds of "empty" are described separately: cut off by the display range / filtered out by workspace / no activity inside the window / all-zero activity / genuinely no projection. ⚠️ **Changes to either the host half (`lib/index.mjs`) or the client half (`lib/client.js`) only take effect after restarting the desktop app** — this machine runs the Electron shell, so there is **no "refresh the page" action**.

---

## 一眼看懂 / At a Glance

| 卡片 / Card | 画什么 / What it draws | 数据来自 / Data source |
|---|---|---|
| **本会话概览**<br>Current session overview | 轮次 / 步数 / 挂钟跨度 / 活跃时长 / 空闲率 / 首条消息时间<br>Turns / steps / wall-clock span / active time / idle ratio / first-message time | `sessionStats` 投影 + `turnTimings`<br>`sessionStats` projection + `turnTimings` |
| **使用时间线（甘特）**<br>Usage timeline (Gantt) | 每轮一根条；空白就是空闲<br>One bar per turn; gaps are idle time | `legacy.turnTimings` |
| **每小时分布**<br>Hourly distribution | 24 根柱 = 每个步骤开始时间落在哪个小时<br>24 bars = which hour each step's start time falls in | `timeline.turns[].steps[].start.time` |
| **每轮用时排行**<br>Slowest turns | 最久的 5 轮<br>The 5 longest turns | `legacy.turnTimings` |
| **日历**（P2 第一步起）<br>Calendar (from P2 step 1) | 今日/本周/本月累计 · 近 12 周热力图 · 近 14 天柱状 · 连续使用段（最长/平均/段数）<br>Today / this week / this month totals · 12-week heatmap · 14-day bars · continuous-use segments (longest / average / count) | 宿主 `usageDaily` 投影（**随会话列表行下发，零额外 I/O**）—— 跨会话求和<br>Host `usageDaily` projection (**shipped with the session list rows, zero extra I/O**) — summed across sessions |
| **会话**（P2 第三步起）<br>Sessions (from P2 step 3) | A 按工作区分组的纵向表（行内比例条）· B 逐日活动带 · C 主从双栏（逐日条形 + 总量）<br>A: vertical table grouped by workspace (in-row proportion bars) · B: daily-activity strip · C: master-detail two columns (per-day bars + totals) | 同上（`row.projectionValues.usageDaily`，**逐会话**保留身份）<br>Same as above (`row.projectionValues.usageDaily`, keeping each session's identity) |

口径（硬约定）：

**English:** Semantics (hard rules):

- **空闲阈值 5 分钟**：相邻事件间隔 **> 5 分钟**视为断开，算新的一段；恰好 5 分钟仍算同一段。
- **English:** **Idle threshold: 5 minutes** — a gap of **more than 5 minutes** between adjacent events is treated as a break and starts a new segment; exactly 5 minutes still counts as the same segment.
- **挂钟跨度** = 最早一轮开始 → 最晚一轮结束；**活跃时长** = 各活跃段之和；**空闲率** = 空闲 ÷ 挂钟。
- **English:** **Wall-clock span** = from the start of the earliest turn to the end of the latest turn; **active time** = the sum of all active segments; **idle ratio** = idle time ÷ wall-clock span.
- **时区**：界面按本机本地时间（`Date#getHours`），即北京时间。
- **English:** **Time zone**: the UI uses this machine's local time (`Date#getHours`), i.e. Beijing time.
- **缺失一律显示 `—`**，绝不把 `NaN` / `undefined` 印到界面上（自测里有一条专门扫这个）。
- **English:** **Anything missing is always shown as `—`**; `NaN` / `undefined` are never printed to the UI (a dedicated self-test case scans for this).
- ⚠️ `turnTimings` / `timeline` 只覆盖**浏览器已加载的会话窗口**（长会话分页时会缺早期轮次）；
  `sessionStats` 是**全日志累计**。两者口径不同，卡面里分开表述、不混加。
- **English:** ⚠️ `turnTimings` / `timeline` only cover **the session window already loaded by the browser** (early turns are missing when a long session is paginated); `sessionStats` is the **whole-log cumulative total**. The two have different semantics, so they are presented separately on the card and never added together.

---

## 文件 / Files

```
dsh-usage-tab/
├─ package.json         # main=lib/index.mjs；dsh.client.platform="web"；dsh.bundle.patch
├─ cordis.patch.yml     # 官方挂载点（insert 一行）
├─ lib/
│  ├─ index.mjs         # 宿主半边：注册 `usageDaily` 会话投影单元（零依赖；自带 .parse 的 schema 适配器）
│  └─ client.js         # 浏览器半边：手写 ModuleLoader 外壳 + 纯 JS + h()
├─ test/
│  └─ self-test.mjs     # 不依赖宿主的自测（101 例；含回填用例 + T23a~T23p 会话页用例 + 宿主投影与统计用例；同时直接 import 宿主半边）
├─ tools/
│  ├─ struct-check-subnav.mjs    # 结构级自检（静态锚点 + 渲染 + 坏值注入 + 宿主投影段）
│  ├─ struct-check-p1fix.mjs     # 结构级自检（P1 修复批次那一组锚点，同样是静态检查）
│  ├─ counterfactual-subnav.mjs  # 反事实对照（%TEMP% 副本上拆修复点，**双驱动**：真实 self-test + 真实 struct-check）
│  ├─ counterfactual-p1fix.mjs   # 反事实对照（P1 修复批次那一组变体）
│  ├─ projcache-probe.mjs        # 只读探针：usageDaily 覆盖率（含 ver 分布，**上界口径**）/ 仍缺哪些会话 / 解析失败清单（回填前后对比用）
│  └─ install.mjs / uninstall.mjs
```

**零构建**：`lib/client.js` 是**手写产物**，不是 esbuild 输出 ——
本机 profile 环境里 esbuild 解析探测 5 条路径全部 `MODULE_NOT_FOUND`。
所以这里没有 `build.mjs`、没有 `devDependencies`、没有 TS。

**English:** **Zero build**: `lib/client.js` is a **hand-written artifact**, not esbuild output — in this machine's profile environment, esbuild resolution probed five paths and every one came back `MODULE_NOT_FOUND`. So there is no `build.mjs`, no `devDependencies`, and no TypeScript here.

---

## 自测 / Self-test

```powershell
cd <你克隆下来的目录>
node test/self-test.mjs
```

自测**不依赖宿主**，但测的是**真产物**：读 `lib/client.js` 原文 → 用
`new Function('window','require',code)` 在宿主 realm 里执行 → 假 `window.__ModuleLoader__`
截获工厂 → `require('react')` 用桩顶上（**其它模块名一律抛错**，顺带验证"不许 import
不存在的模块"）→ 纯函数从 `module.exports.__test` 取出逐条断言。

**English:** The self-test **does not depend on the host**, but it tests **the real artifact**: it reads the raw text of `lib/client.js`, runs it inside the host realm with `new Function('window','require',code)`, catches the factory with a fake `window.__ModuleLoader__`, stubs out `require('react')` (**every other module name throws**, which also verifies that "importing a module that does not exist is forbidden"), then pulls the pure functions out of `module.exports.__test` and asserts on them one by one.

覆盖：外壳契约 / 字典完整性 / 活跃段切分 / 空闲率 / 每小时分桶（步数与活跃毫秒两种量纲）/
时长格式化与排序 / 甘特与柱高归一化 / **渲染层绝不上屏 NaN 或 undefined** /
`apply` 的注册参数与三条降级路径 / CSS 零硬编码配色 /
**宿主 `usageDaily` 折叠**（逐日活跃 / 5 分钟阈值 / fork 切点清账 / `Object.is` 门禁 /
stateSchema 适配器 / 日桶封顶 / apply 降级）+ **客户端日历真数据通路**（日键口径 / 跨会话聚合 /
日历模型 / 有数据与空态）+ **宿主冷会话回填**（`T22a`~`T22f`：inject 四个服务与缺失不抛（且早退留
一行 `debug`）/ 跳过口径与 `coldSnapshot` 参数（**「只有别的投影键」不算已服务**）/ 旧格式走 `debug`
不 `warn` 且不中断 / dispose 的定时器清理与中途 abort / **`apply()` 必须真的把回填装起来** /
重复触发只跑一趟）+ **客户端「会话」页**（`T23a`~`T23p`：数据层与身份兜底 / A 分组与排序 / B 14 列档位 /
C 主从与默认选中 / 渲染冒烟 / 偏好进模型 / **B·C 按 40 截断、A 视图列全部（不抹组）** /
**五种空态分开表述** / **基准取全部会话（含"组里没有全局最大会话"的夹具）** / 口径脚注 /
全日志总量口径 / 数值上界 / **形状兜底（空载体 ids:[] / byId:{}）** / **选中态挤回列表** /
**「显示范围」默认 14 天与超范围不进清单** / **边界日与无活动日** / **工作区筛选生效时控件必须在屏上**）。
回填用例多为**异步**（回填跑在 `setTimeout` + `await` 里），经 `testAsync` 登记、在同步用例跑完后统一 await。

**English:** Coverage: shell contract / dictionary completeness / active-segment splitting / idle ratio / hourly bucketing (both step count and active milliseconds) / duration formatting and sorting / Gantt and bar-height normalization / **the render layer never puts NaN or undefined on screen** / `apply`'s registration arguments and its three degradation paths / zero hard-coded colors in CSS / **host `usageDaily` folding** (per-day activity / the 5-minute threshold / clearing accounts at fork points / the `Object.is` gate / the stateSchema adapter / daily bucket caps / apply degradation) + **the client's real-data calendar path** (day-key semantics / cross-session aggregation / the calendar model / data vs. empty state) + **host cold-session backfill** (`T22a`-`T22f`: injecting the four services without throwing when they are missing (and bailing out early with one `debug` line) / skip semantics and the `coldSnapshot` arguments (**"only other projection keys present" does not count as already served**) / old formats go to `debug` rather than `warn` and do not abort / timer cleanup on dispose and mid-flight abort / **`apply()` must actually install the backfill** / repeated triggers only run once) + **the client Sessions page** (`T23a`-`T23p`: data layer and identity fallbacks / View A grouping and sorting / View B's 14-column shading / View C master-detail and default selection / render smoke test / preferences feeding the model / **B and C truncate at 40 while View A lists everything (without wiping out a group)** / **the five empty states described separately** / **baselines taken across all sessions (including a fixture where the globally largest session is not inside the group)** / the semantics footnote / whole-log totals semantics / numeric upper bounds / **shape fallbacks (empty carriers `ids:[]` / `byId:{}`)** / **selection squeezed back into the list** / **"display range" defaults to 14 days and out-of-range sessions stay out of the list** / **boundary days and days with no activity** / **when the workspace filter is active, its controls must stay on screen**). Most backfill cases are **asynchronous** (backfill runs inside `setTimeout` + `await`); they are registered through `testAsync` and awaited together after the synchronous cases finish.

另有两条结构/反事实脚本（期望：`OK=91 BAD=0` 与 `OK=121 BAD=0`）：

**English:** There are also two structural / counterfactual scripts (expected: `OK=91 BAD=0` and `OK=121 BAD=0`):

```powershell
node tools/struct-check-subnav.mjs     # 结构自检：静态锚点 + 渲染 + 坏值注入（含 G15~G17 清洗闸 / inject）
node tools/counterfactual-subnav.mjs   # 反事实：拆掉修复点 ⇒ 真实 self-test / struct-check 必须变红（双驱动）
```

---

## 安装 / Install

**本机现状：已装（路 B，多个 profile —— 名字随机器而定）** ——
`tools/install.mjs --apply` 做的事：
① 备份 profile 的 `cordis.patch.yml`；② 把源码（排除内部文档与产物目录）铺到
`~\.dsh\profiles\<profile>\vendor\dsh-usage-tab-src\`；③ 在 `profile\node_modules\` 建 Junction 指过去；
④ 往 profile 的 `cordis.patch.yml` 插一行 `- insert: { id: usage-tab, name: 'dsh-usage-tab' }`。

**English:** **Current state on this machine: installed (route B, several profiles — names vary by machine)** — what `tools/install.mjs --apply` does: (1) backs up the profile's `cordis.patch.yml`; (2) copies the source (excluding internal docs and artifact directories) to `~\.dsh\profiles\<profile>\vendor\dsh-usage-tab-src\`; (3) creates a junction in `profile\node_modules\` pointing there; (4) inserts the line `- insert: { id: usage-tab, name: 'dsh-usage-tab' }` into the profile's `cordis.patch.yml`.

⚠️ **2026-10-13 修正**：旧版把 profile 硬编码成 `web`（而日常实际跑的是 **desktop**）⇒ 改了 `lib/`
跑 `--apply` 只同步 web、**改完不生效且极难查**。现在默认自动枚举 `~\.dsh\profiles\*`、只处理
「已装过本插件」的那些（`--profile <名字>` 可显式指定单个）。

**English:** ⚠️ **Fixed on 2026-10-13**: an earlier version hard-coded the profile to `web` (while what actually runs day to day is **desktop**) ⇒ changes to `lib/` followed by `--apply` only synced web, and **the change silently failed to take effect and was extremely hard to track down**. It now auto-enumerates `~\.dsh\profiles\*` by default and only touches the ones where **this plugin is already installed** (`--profile <name>` can pin a single one explicitly).

```powershell
node tools/install.mjs            # 干跑，看清要动什么
node tools/install.mjs --apply    # 真装
node tools/uninstall.mjs --apply --backup "<安装时的备份目录>"
```

- 🩸 **改了 `lib/` 就要重新 `--apply`**（vendor 是**副本**，不是软链）。
- **English:** 🩸 **After changing anything in `lib/`, run `--apply` again** (vendor is a **copy**, not a symlink).
- 🩸 **改了 `lib/index.mjs` 必须重启桌面版 App**（bundle 列表在启动时读、模块已进 require cache）；
  `lib/client.js` 同样随重启加载（本机是 Electron 套壳，没有"刷新页面"这个动作）。
- **English:** 🩸 **After changing `lib/index.mjs` you must restart the desktop app** (the bundle list is read at startup and the module is already in the require cache); `lib/client.js` is likewise loaded on restart (this machine is the Electron shell, so there is no "refresh the page" action).
- 🔍 **回填复验**：重启后跑 `node tools/projcache-probe.mjs --keys usageDaily,contextActivity`，
  看那批老会话的「缺」是否归零；宿主日志对应一行是
  `dsh-usage-tab: 冷会话回填完成 N 个会话的 usageDaily 投影`。
- **English:** 🔍 **Backfill re-check**: after restarting, run `node tools/projcache-probe.mjs --keys usageDaily,contextActivity` and see whether the "missing" count for that batch of old sessions has dropped to zero; the matching host log line starts with `dsh-usage-tab:` and reports the cold-session backfill result for N sessions.
- 🩸 **绝不跑 `pnpm install`**（会重新解包 `file:vendor/*.tgz`、覆盖本机 vendor 的 0.1.7 补丁）。
- **English:** 🩸 **Never run `pnpm install`** (it unpacks `file:vendor/*.tgz` again and overwrites the local vendored 0.1.7 patch).

官方路（需重启，未采用）：`dependencies` 加 `"dsh-usage-tab": "link:<路径>"` +
`dsh.profile.bundles` 加 `"dsh-usage-tab"`。`cordis.patch.yml` 里的 insert 行两种方式共用。

**English:** Official route (needs a restart, not adopted): add `"dsh-usage-tab": "link:<path>"` to `dependencies` plus `"dsh-usage-tab"` to `dsh.profile.bundles`. The insert line in `cordis.patch.yml` is shared by both approaches.

---

## 权限与依赖 / Permissions & Dependencies

**依赖**：**运行时零依赖** —— 不引入任何第三方包（宿主提供的 `@deepseek-ai/*` 走宿主自身）。
**网络**：**运行时与仓库内工具均不发起网络请求**（全源码内无 `fetch` / `XMLHttpRequest` / `http` / `net` 调用）。
**文件**：宿主半读**插件偏好**与**会话投影缓存**；冷会话回填时只**读**会话日志来补投影，**从不改写会话文件**。
  ⚠️ 仓库里的**开发工具**（`tools/`）**会写文件**：反事实脚本在系统临时目录建副本，并把日志写到 `out/cf-logs/`（`out/` 已在 `.gitignore` 内）。
**命令 / 凭据**：**运行时**不执行外部命令、**不读取任何凭据**。
  ⚠️ 仓库里的**开发工具**会用 `spawnSync` 起子进程（跑自测 / 结构检查）—— **那只在开发时用，不在插件运行时路径上**。
**会话数据**：只用本会话的**事件时间戳**做统计，**全部本机计算、不外传**。

⚠️ 以上是**源码面**的保守自述：**"未发现"不等于"绝对不访问"** —— 请以实际源码为准。
本插件**非官方插件**，与 DeepSeek 官方无隶属关系。

**English:** **Dependencies**: **zero runtime dependencies** — no third-party packages (host-provided `@deepseek-ai/*` come from the host itself). **Network**: **neither the runtime nor the in-repo tools make network requests** (no `fetch` / `XMLHttpRequest` / `http` / `net` calls anywhere in the source). **Files**: the host half reads **plugin preferences** and the **session projection cache**; during cold-session backfill it only **reads** session logs to fill in projections and **never rewrites session files**. ⚠️ The **development tools** under `tools/` **do write files**: the counterfactual script builds a copy in the system temp directory and writes logs to `out/cf-logs/` (`out/` is covered by `.gitignore`). **Commands / credentials**: the **runtime** runs no external commands and **reads no credentials**. ⚠️ The **development tools** use `spawnSync` to launch child processes (running the self-test / struct check) — **that only happens in development, not on the plugin's runtime path**. **Session data**: only the current session's **event timestamps** are used, computed **entirely locally and never sent anywhere**. ⚠️ The above is a conservative statement about the **source surface**: "not found" does not mean "never accesses" — please refer to the actual source. This is **not an official plugin** and is not affiliated with DeepSeek.

---

## 许可 / License

MIT

**English:** Released under the MIT License.
