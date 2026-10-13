/**
 * dsh-usage-tab — 宿主半边（P2 第一步：`usageDaily` 会话投影单元 · 第二步：冷会话回填）
 * ============================================================================
 *
 * 本文件在 P1 只为了「让 loader 有一条可加载的入口，从而让 dsh-client-modules
 * 扫到本包的 `dsh.client` 声明」而存在（见 P1 注释与
 * 同款宿主插件的写法）。P2 第一步起它**真的有活干**：
 * 注册一个自己的会话投影单元，把**会话事件时间戳**折成「按本地时区逐日的活跃毫秒」
 * + 「本会话总活跃 / 轮数 / 段数 / 最长段」。客户端从**会话列表行自带的投影值**
 * 零 I/O 读它（`row.projectionValues.usageDaily`），不需要任何 RPC。
 *
 * ── 为什么这一件事就够（数据通路）──
 *   ① 注册单元 ⇒ 宿主为每个会话持久折账（`dsh-session-projection`）；
 *   ② 落盘的检查点行由 `session_projection_cache` 写进
 *      `~/.dsh/storages/session_projcache/sessions/<id>.json`（`{ver,seq,val}`）；
 *   ③ `session.list` 的每一行**自带**这一列的投影值：
 *      `dsh-api-session-controller/lib/index.js:2008-2016`
 *        · live 会话 → `sessionProjections.cachedSnapshot(session)`
 *        · 冷会话   → `sessionProjectionCache.cachedSnapshot(header)`（同步零 I/O）
 *   ④ 客户端把它落到 `row.projectionValues`
 *      （`dsh-api-session-controller/lib/client.js:2633 → buildListSnapshot`），
 *      于是「日历」页聚合全部会话行即可，**一个字节的会话日志都不用读**。
 *
 * ── 🩸 三条必须照做的宿主事实（每条都有源码行号，别凭直觉改）──
 *
 *   1. **`wire` 不是可选的**。`dsh-session-projection/lib/index.js`（行号于 2026-09-25
 *      按独立审查**自查更正**）里共有 **5 处"没有 wire 就跳过"的守卫**：
 *        · 4 处 `if (def.wire === void 0) continue` —— `:147`（snapshot）、
 *          `:170`（cachedSnapshot）、`:249`（viewCheckpoint ← **冷会话列表行走的就是这条**）、
 *          `:340`（hydrate 的 complete 分支）；
 *        · 1 处条件式 —— `:305`（restore：`if (def.wire !== void 0) values[def.key] = …`）；
 *      另有 `:432` 是显式 `throw new Error('… has no wire view')`（第 6 道护栏）。
 *      ⇒ **不写 `wire`，这个键永远不会出现在 `values` 里**（客户端永远读不到）。
 *      所以下面必须给 `viewSchema + view`。
 *      （旧口径"三处 `:147 / :305 / :430-433`"是错的：计数低报了 2 处，且 `:430-433`
 *        混进了 `viewCell` 的**裸调用点**。`:422` / `:433` 是 `wire.viewSchema.parse(...)`
 *        的裸调 —— 所以本包的 `viewSchema` 必须自带 `.parse`，且 `view` 恒返回对象。）
 *
 *   2. **`stateSchema` 必须自带 `.parse`，绝不能用 schemastery 的 schema**。
 *      `dsh-session-projection/lib/index.js:297`（restore）是**裸调用、没有 try/catch**：
 *          let state = usable ? def.stateSchema.parse(row.val) : def.init(...)
 *      而 schemastery 的 `Schema` 没有 `.parse` 方法（只有可调用 + `~standard`）
 *      ⇒ 一旦存在持久 checkpoint 行，**会话第二次加载时 TypeError、会话打不开**。
 *      前车之鉴与同款适配器：`dsh-time-inject/lib/index.mjs:94-117`。
 *
 *   3. **`apply` 必须同步、状态必须纯 JSON、不关心的事件必须返回同一引用**
 *      （`dsh-session-projection/lib/types/index.d.ts:33-36`、`:50-58`：
 *      `Object.is` 相同 ⇒ 下游零工作）。本文件的 `foldUsageDaily`：
 *        · 非白名单事件类型 → 原样返回入参（**同一引用**）
 *        · 时间戳非有限数   → 原样返回入参（**同一引用**，且避免污染 lastTime）
 *      这两条就是 `test/self-test.mjs` 里 T20* 的 `Object.is` 门禁断言。
 *
 * ── 口径（与界面一致，改语义必须 bump `stateVersion`）──
 *   · 活跃 = 相邻两条**活动事件**的时间差，`> 5 分钟`（`IDLE_THRESHOLD_MS`）即断开算新段；
 *     恰好等于阈值仍算同一段（与客户端 `mergeSegments` 的 `<=` 同源）。
 *   · 逐日分桶用**宿主进程本地时区**（`dayKeyOf` 走 `Date` 的本地日历字段，
 *     与 `dsh-context` 的 `contextActivity` 同款；本机 host 与浏览器同一台机器）。
 *   · 一段跨午夜时，那一小段毫秒记在**间隔起点所在日**（因为间隔本身 ≤ 5 分钟，
 *     误差上界就是 5 分钟，属可接受口径）。
 *   · 日桶有界：最多保留 `MAX_KEPT_DAYS`（400）天，**只裁日桶、不裁会话总量**。
 *   · fork 子会话：`session/end-seed` 且 `data.inherited === true` 是继承切点
 *     （`dsh-session/lib/types/fork.js:15-26`：它是**最后一个**继承事件，其后紧跟
 *     复用同一切点时间戳的合成 closers）⇒ 遇到它**清账重来**，父会话的历史不记在子会话名下。
 *
 * ── P2 第二步：冷会话回填（2026-10-13 已实现，见 `watchUsageBackfill`）──
 *   · 从未打开过、也没被写过投影缓存的老会话：启动 `BACKFILL_START_DELAY_MS`（5 秒）后
 *     `sessionQuery.listSessions → 逐条冷读 → sessionProjectionCache.coldSnapshot` 补上，
 *     由宿主对**所有已注册投影**统一折一遍（本包不自己折账）；
 *   · 三条**照跳**的口径：live 会话（它自己会折，冷写只会和它自己的检查点竞态）、缓存里
 *     已有 `usageDaily` 的会话（没必要重折）、`header.cwd` 缺失的记录
 *     （含子代理会话 —— 那是口径，不是 bug）；
 *   · 老日志被源侧拒读（`SessionFormatUnsupported*`）⇒ 只留 `debug` 一行 + 一条计数 info，
 *     **接受并记录**，绝不改写源文件；单个失败不中断后续；逐会话让路 `BACKFILL_YIELD_MS`
 *     （100ms）；插件卸载（dispose）时 abort 在跑的那一趟。
 *
 * ── 仍未做（后续步骤）──
 *   · 自建 RPC / 路由做跨会话聚合（现在靠客户端聚合列表行）；
 *   · 子代理会话与父会话的去重（`SessionHeader.origin === 'subagent'`），现在照实各算各的。
 */

/** Cordis 插件名（loader 诊断用；**不是**模块名，也不是 `source.kind`）。 */
export const name = 'dsh-usage-tab'

/**
 * 本插件自己的会话投影键。
 * ⚠️ **不要**撞官方的 `sessionStats`（口径是模型/工具耗时）与 `dsh-context` 的
 * `contextActivity`（那是别人家的键）。
 */
export const PROJECTION_KEY = 'usageDaily'

/**
 * 折叠语义版本。改动 `init` / `fold`（折叠口径）或状态字段形状时**必须 +1**，
 * 否则旧的持久 checkpoint 行会被前向应用成垃圾
 * （`dsh-session-projection/lib/types/index.d.ts:73-79`：`ver` 不匹配才丢弃，绝不迁移）。
 */
export const PROJECTION_STATE_VERSION = 1

/** 空闲阈值：相邻活动事件间隔 **> 5 分钟** 视为断开、算新的活跃段（规格硬要求）。 */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000

/**
 * 日桶保留上限（照 `dsh-context` 的 `MAX_KEPT_DAYS = 400`）。
 * 全历史必须有界，否则状态无上限增长、列表行越传越胖。
 */
export const MAX_KEPT_DAYS = 400

/**
 * **小时桶**保留上限（天）—— 2026-10-14 本插件口径：给 K 线算「高频使用时段」（实体）与「该时段之外的活动」（影线）。
 *
 * 🩸 为什么比日桶短得多：小时桶是**稀疏**的（只存非零小时），但仍是日桶体积的数倍，
 * 而它**要随会话列表行逐行下发**（每次刷新都传）⇒ 给一个硬上限，别让它随时间无限长。
 * 更老的日期仍保留**日总量**（`days`），只是没有日内分布。
 */
export const MAX_KEPT_HOUR_DAYS = 90

/**
 * 参与「活跃」折算的事件类型白名单。
 *
 * 为什么用白名单而不是"所有事件都算"：
 *   ① `apply` 每命中一次就要复制一次日桶（不可变更新）⇒ 全事件参与会把
 *      「每个 committed event 都过一遍」的热路径变成 O(天数)；
 *   ② 更要紧的是**门禁**：`dsh-session-projection` 用 `Object.is` 判单元有没有变，
 *      白名单之外的事件（标题 / 目标 / 待办 / 压缩 … 这些插件事件）必须返回**同一引用**，
 *      否则每个事件都会被当成"账变了"，白白驱动一遍下游 + 一遍 wire 视图。
 *   覆盖范围：一轮里的 turn/step 边界、消息、尝试、请求头、工具调用与结果
 *   —— 真实"在做事的时刻"一个不漏；纯状态类事件不参与。
 */
export const ACTIVITY_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/attempt',
  'assistant/message',
  'request/header',
  'tool/call',
  'tool/result',
])

/** 白名单的 Set 形式（`apply` 热路径用；Set 判存在比数组 `indexOf` 稳定更快）。 */
const ACTIVITY_SET = new Set(ACTIVITY_EVENT_TYPES)

/** 日键形状：本地日历日 `YYYY-MM-DD`。 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 日键的**形状 + 范围**校验（月 1–12、日 1–31）。
 * 为什么要有范围这一手：`^\d{4}-\d{2}-\d{2}$` 会放行 `2026-13-01` 这种形状合法、
 * 语义荒谬的键（它会在日桶里永远错位，还会让客户端聚合出一堆对不上窗口的垃圾）。
 * 不做完整日历校验（`2026-02-31` 仍放行）—— 那是客户端 `parseDayKey` 的活，
 * 这里只挡"一眼假"的键，保持 `parse`/`view` 的 O(键数) 成本。
 */
function isDayKey (key) {
  if (typeof key !== 'string' || !DAY_KEY_RE.test(key)) return false
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** 任意输入 → 有限数字或 `null`（投影状态必须能 JSON 往返）。 */
function numOf (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 任意输入 → 非负有限数字，其余一律 `0`（**渲染层绝不出现 NaN**）。 */
function nonNegOf (value) {
  const n = numOf(value)
  return n === null || n < 0 ? 0 : n
}

/** 任意输入 → 非负安全整数，其余一律 `0`。 */
function countOf (value) {
  const n = numOf(value)
  if (n === null || n < 0) return 0
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
}

function pad2 (value) {
  return value < 10 ? '0' + String(value) : String(value)
}

/**
 * Unix epoch ms → **本地时区**日历日键 `YYYY-MM-DD`；非法时间戳 → `null`。
 * 与 `dsh-context/lib/index.js:1733-1739` 的 `dayKeyOf` 逐字同款
 * （用 `Date` 的本地日历字段，而不是 UTC 的 `toISOString`）。
 *
 * @param {unknown} time - Unix epoch 毫秒。
 * @returns {string|null} `YYYY-MM-DD`，或 `null`（不可分桶）。
 */
export function dayKeyOf (time) {
  const value = numOf(time)
  if (value === null) return null
  try {
    const date = new Date(value)
    const ms = date.getTime()
    if (!Number.isFinite(ms)) return null
    const year = date.getFullYear()
    if (!Number.isFinite(year) || year < 1970 || year > 9999) return null
    return String(year).padStart(4, '0') + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
  } catch {
    return null
  }
}

/**
 * 某个时刻之后的**本地午夜**（下一天 00:00:00.000 的 epoch 毫秒）。
 *
 * `Date#setHours(24, 0, 0, 0)` 会自然进位到次日，与 {@link dayKeyOf} 的本地日历口径一致
 * （两者都走宿主进程的本地时区）⇒ 跨午夜的切分点与日键边界严丝合缝。
 *
 * @param {unknown} time - Unix epoch 毫秒。
 * @returns {number|null} 本地午夜时刻；`time` 非法时返回 `null`。
 */
export function localMidnightAfter (time) {
  const value = numOf(time)
  if (value === null) return null
  try {
    const date = new Date(value)
    date.setHours(24, 0, 0, 0)
    const ms = date.getTime()
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

/**
 * **小时桶对象** → 只留合法日键 + 合法小时（0~23）+ 非负有限数，并按 `MAX_KEPT_HOUR_DAYS` 保留**最新**的若干天。
 *
 * 形状：`{ 'YYYY-MM-DD': { '0'..'23': 活跃毫秒 } }` —— **稀疏**（没有活动的小时根本不建键）。
 * ⚠️ 与 `days` 的关系：同一天里 `sum(hoursByDay[day]) === days[day]`（同一份账的两种切法），
 * 但 `days` 覆盖 400 天、`hoursByDay` 只覆盖近 90 天 ⇒ **老日期只有 `days` 没有 `hoursByDay`**（这是设计，不是缺数据）。
 */
function cleanHoursByDay (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const dayKeys = Object.keys(raw)
  for (let i = 0; i < dayKeys.length; i++) {
    const dayKey = dayKeys[i]
    if (!isDayKey(dayKey)) continue
    const bucket = raw[dayKey]
    if (bucket === null || typeof bucket !== 'object') continue
    const hourKeys = Object.keys(bucket)
    const cleanBucket = {}
    for (let j = 0; j < hourKeys.length; j++) {
      const hourKey = hourKeys[j]
      const hour = Number(hourKey)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
      const ms = numOf(bucket[hourKey])
      if (ms === null || ms <= 0) continue
      cleanBucket[String(hour)] = ms
    }
    if (Object.keys(cleanBucket).length > 0) out[dayKey] = cleanBucket
  }
  return capHoursByDay(out)
}

/** 超过 `MAX_KEPT_HOUR_DAYS` 时按日键字典序（= 时间序）丢弃最旧的。 */
function capHoursByDay (hoursByDay) {
  const keys = Object.keys(hoursByDay)
  if (keys.length <= MAX_KEPT_HOUR_DAYS) return hoursByDay
  keys.sort()
  const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_HOUR_DAYS))
  const out = {}
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!drop.has(key)) out[key] = hoursByDay[key]
  }
  return out
}

/**
 * 把 `[from, to)` 这段毫秒按**本地整点**切开，分别累加进 `hoursByDay[day][hour]`（**写时复制**：只复制被碰到的那一天）。
 *
 * ⚠️ 为什么必须按小时切（而不是把整段记到起点小时）：一个 gap 可能跨整点（13:58 → 14:03），
 * 整段记起点会让"高频时段"整体偏移。`remaining` 只在 `added > 0` 时调用，且单段 gap 受
 * `IDLE_THRESHOLD_MS`（5 分钟）约束 ⇒ 实际最多跨 2 个小时；`guard` 只是防病态输入的保险丝。
 */
function addHoursRange (hoursByDay, from, to) {
  let cursor = from
  let guard = 0
  while (cursor < to && guard < 200) {
    guard += 1
    const dayKey = dayKeyOf(cursor)
    if (dayKey === null) break
    const d = new Date(cursor)
    const hour = d.getHours()
    const nextHour = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour + 1, 0, 0, 0).getTime()
    const slice = Math.min(to, nextHour)
    const amount = slice - cursor
    if (amount > 0) {
      const prevDay = hoursByDay[dayKey]
      const dayBucket = {}
      if (prevDay !== undefined && prevDay !== null && typeof prevDay === 'object') {
        const pKeys = Object.keys(prevDay)
        for (let k = 0; k < pKeys.length; k++) dayBucket[pKeys[k]] = prevDay[pKeys[k]]
      }
      const hk = String(hour)
      dayBucket[hk] = nonNegOf(dayBucket[hk]) + amount
      hoursByDay[dayKey] = dayBucket
    }
    cursor = slice
  }
  return hoursByDay
}

/** 浅复制小时桶外层（内层按需写时复制，见 `addHoursRange`）。 */
function copyHoursByDay (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) out[keys[i]] = raw[keys[i]]
  return out
}

/** 日桶对象 → 只留合法键 + 非负有限数，并按 `MAX_KEPT_DAYS` 保留**最新**的若干天。 */
function cleanDays (raw) {
  const days = {}
  if (raw === null || typeof raw !== 'object') return days
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!isDayKey(key)) continue
    const ms = numOf(raw[key])
    if (ms === null || ms < 0) continue
    days[key] = ms
  }
  return capDays(days)
}

/** 超过 `MAX_KEPT_DAYS` 时按日键字典序（= 时间序）丢弃最旧的，返回新对象。 */
function capDays (days) {
  const keys = Object.keys(days)
  if (keys.length <= MAX_KEPT_DAYS) return days
  keys.sort()
  const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
  const out = {}
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!drop.has(key)) out[key] = days[key]
  }
  return out
}

/**
 * **工具名宽探测**（2026-10-14）。
 *
 * 🩸 为什么是"宽探测"：`tool/call` **不在** `dsh-session/lib/types/index.js` 里（它由各个工具包自己注册），
 * 所以"工具名到底在 data 的哪个字段"**我没能证实**。与其猜一个字段名做死，不如挨个试；
 * **全都不中时把 `data` 的字段名列表记下来**（见 `toolShapeOf`）—— 让**数据自己暴露真相**，
 * 下次看投影就知道真实形状，不用猜、不用翻日志。
 */
function toolNameOf (data) {
  if (typeof data === 'string') return data.length > 0 ? data : null
  if (data === null || typeof data !== 'object') return null
  const tool = data.tool
  const candidates = [
    data.toolName,
    data.name,
    typeof tool === 'string' ? tool : null,
    tool !== null && typeof tool === 'object' ? tool.name : null,
  ]
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    // 🩸 实测发现：`name` 这类候选**可能取到描述文字**（实测 "Read the file and return its contents"
    //   直接成了工具名）⇒ 加**形态约束**：无空白字符、长度 ≤ 64。不满足就继续试下一个候选。
    if (typeof c === 'string' && c.length > 0 && c.length <= 64 && !/\s/.test(c)) return c
  }
  return null
}

/** 识别不出工具名时，返回 `data` 的**字段名列表**（诊断用；排序保证稳定、可去重）。 */
function toolShapeOf (data) {
  if (data === null || typeof data !== 'object') return '<' + typeof data + '>'
  const keys = Object.keys(data).sort()
  return keys.length === 0 ? '<empty>' : keys.join(',')
}

/** 工具名种类上限（防"名字爆炸"撑大投影；超了统一归到 `<other>`）。 */
export const MAX_TOOL_KINDS = 200

/** **模型名**种类上限（同一条口径）。 */
export const MAX_MODEL_KINDS = 50

/**
 * **单次工具调用的耗时上界**（用于识别"配错对"）。
 *
 * 🩸 2026-10-14 实测：`job_output` 累计出 **24h36s / 50 次**（平均半小时一次）——
 * 明显不可能。根因 = 配对策略是"认最近一次 `tool/call`"，一旦某次 `tool/result` 缺失或被跳过，
 * 它就跟**很久之后**的 call 配上了。超过这个上界的配对 ⇒ **只计次数、不计耗时**（不撒谎）。
 */
export const MAX_TOOL_SPAN_MS = 2 * 3600000

/**
 * 通用**形状诊断**：`'<事件类型>|<字段名列表>' → 次数`（限额 20 条）。
 *
 * 🩸 用途：`model/selection` / `turn/end` 这些事件的 `data` 形状我**没有权威定义**
 * （`tool/call` 也不在核心类型里）⇒ 一律**宽探测**，探测不到就把字段名列表记下来，
 * **让数据自己暴露真相**（下次看投影就知道真实字段，不用猜、不用翻日志）。
 */
function noteShape (shapes, eventType, data) {
  const out = Object.assign({}, shapes !== null && typeof shapes === 'object' ? shapes : {})
  let sig = ''
  if (data === null || typeof data !== 'object') {
    sig = eventType + '|<' + typeof data + '>'
  } else {
    // 🩸 带上**值的类型**（不只是字段名）—— 2026-10-14 实测：`turn/end` 的 `reason` 字段**存在但不是字符串**，
    //    只记字段名的话看不出"是字段名错还是类型错"，还得再猜一轮。记成 `reason:object` 就一眼命中。
    const keys = Object.keys(data).sort()
    sig = eventType + '|' + (keys.length === 0 ? '<empty>' : keys.map(function (k) {
      return k + ':' + (data[k] === null ? 'null' : typeof data[k])
    }).join(','))
  }
  if (Object.prototype.hasOwnProperty.call(out, sig) || Object.keys(out).length < 20) {
    out[sig] = countOf(out[sig]) + 1
  }
  return out
}

/** 形状诊断表的清洗（键长限制 + 只留正计数）。 */
function cleanEventShapes (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length && Object.keys(out).length < 20; i++) {
    // 🩸 实测发现：**键长必须封顶** —— 形状留痕的键是"字段名:类型"拼出来的，
    //   而 `noteShape` 是对 `Object.keys(data)` 全量的拼接 ⇒ 恶意/异常事件能造出 **1.68 MiB 的单个键**，
    //   20 条 ≈ **37 MiB 随会话列表行下发**、客户端还会原样穿透。
    //   同文件的 `cleanCounts` / `cleanByTool` 早有 120 字符上限，这里补齐同一条口径。
    const key = keys[i]
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue
    if (isUnsafeKey(key)) continue
    const c = countOf(raw[key])
    if (c > 0) out[key] = c
  }
  return out
}

/**
 * 🩸 实测发现：**危险键必须跳过** —— `out['__proto__'] = ...` 在普通对象字面量上**不建自己的属性**，
 * 而是**改写原型**（实测：桶静默消失，好在不污染全局）。`constructor` / `prototype` 同理。
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function isUnsafeKey (key) {
  return typeof key !== 'string' || UNSAFE_KEYS.has(key)
}

/** `{ 名称: 次数 }` 型计数的清洗（模型 / 失败原因共用；上限 `MAX_MODEL_KINDS`，超出并入 `<other>`）。 */
function cleanCounts (raw, maxKinds) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (typeof key !== 'string' || key.length === 0 || key.length > 120) continue
    if (isUnsafeKey(key)) continue
    const c = countOf(raw[key])
    if (c <= 0) continue
    out[key] = c
  }
  const ok = Object.keys(out)
  if (ok.length > maxKinds) {
    ok.sort()
    const keep = {}
    // 🩸 实测发现：**先把已有的 `<other>` 取出来累加** ——
    //   否则每次 fold 都用"本轮新并进来的"**覆盖**旧累计 ⇒ **计数不守恒**
    //   （实测：250 次不同工具调用最终只剩 200，丢 20%；byModel 60→50）。
    let other = out['<other>'] !== undefined ? out['<other>'] : 0
    let kept = 0
    for (let i = 0; i < ok.length; i++) {
      const k = ok[i]
      if (k === '<other>') continue
      if (kept < maxKinds - 1) { keep[k] = out[k]; kept += 1 }
      else other += out[k]
    }
    keep['<other>'] = other
    return keep
  }
  return out
}

/** 工具桶对象 → 只留合法字符串键 + 非负整数计数/毫秒，超过 `MAX_TOOL_KINDS` 的并入 `<other>`。 */
function cleanByTool (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (typeof key !== 'string' || key.length === 0 || key.length > 120) continue
    if (isUnsafeKey(key)) continue
    const bucket = raw[key]
    if (bucket === null || typeof bucket !== 'object') continue
    const calls = countOf(bucket.calls)
    const ms = nonNegOf(bucket.ms)
    if (calls <= 0 && ms <= 0) continue
    out[key] = { calls, ms }
  }
  const ok = Object.keys(out)
  if (ok.length > MAX_TOOL_KINDS) {
    ok.sort()
    const keep = {}
    // 🩸 同前：已有的 `<other>` 桶**必须先取出来累加**（否则每次 fold 覆盖旧累计 ⇒ 不守恒）
    const prevOther = out['<other>']
    let otherCalls = prevOther !== undefined && prevOther !== null ? countOf(prevOther.calls) : 0
    let otherMs = prevOther !== undefined && prevOther !== null ? nonNegOf(prevOther.ms) : 0
    let kept = 0
    for (let i = 0; i < ok.length; i++) {
      const k = ok[i]
      if (k === '<other>') continue
      if (kept < MAX_TOOL_KINDS - 1) { keep[k] = out[k]; kept += 1 }
      else { otherCalls += out[k].calls; otherMs += out[k].ms }
    }
    keep['<other>'] = { calls: otherCalls, ms: otherMs }
    return keep
  }
  return out
}

/** 形状诊断表：字段名列表 → 出现次数（限额 20 种 + 键长封顶）。 */
function cleanToolShapes (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length && Object.keys(out).length < 20; i++) {
    // 🩸 实测发现：**键长也要封顶** —— 这跟 `cleanEventShapes` 是同一条口径，
    //   我上一轮只补了那个、漏了这个（"新增字段要点清所有复述点"的又一例）。
    const key = keys[i]
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue
    const c = countOf(raw[key])
    if (c > 0) out[key] = c
  }
  return out
}

/**
 * 空状态工厂。
 *
 * `init(header, inheritedEventCount)` 的两个参数本单元用不到：
 * fork 的继承切点我们用 `session/end-seed` 标记事件识别（见 `foldUsageDaily`），
 * 它比 `inheritedEventCount` 更晚也更能自证（`restore` 从 checkpoint 续折时看不到标记，
 * 但那时状态里已经清过账了）。
 *
 * @returns {{days: object, hoursByDay: object, byTool: object, toolShapes: object, openToolName: string|null, openToolStart: number|null, activeMs: number, turns: number, segments: number, longestMs: number, lastTime: number|null, openStart: number|null}}
 */
export function initUsageDailyState () {
  return {
    days: {},
    hoursByDay: {},
    byTool: {},
    toolShapes: {},
    byModel: {},
    turnOutcomes: {},
    compactions: 0,
    eventShapes: {},
    openToolName: null,
    openToolStart: null,
    activeMs: 0,
    turns: 0,
    segments: 0,
    longestMs: 0,
    lastTime: null,
    openStart: null,
  }
}

/** 在外部某条事件时刻上重开账本（fork 切点用）：锚点 = 切点时刻，但**不计段、不计活跃**。 */
function freshStateAt (time) {
  const state = initUsageDailyState()
  // 把 lastTime 锚在切点时刻：紧随其后的合成 closers 复用同一切点时间戳
  // （`dsh-session/lib/types/repair.js`：closers 的时间戳复用最后一条真实事件）
  // ⇒ 它们的 gap = 0，既不产生毫秒、也不会被误判成一段的开头。
  state.lastTime = time
  return state
}

/**
 * 投影状态 schema —— **自己写的最小适配器**（见文件头第 2 条）。
 *
 * 行为（**宽进严出**；2026-09-25 独立审查后的澄清 —— 原注释写"形状不对就抛"，
 * 与实测不符：`[]` / `[1,2]` / `Date` / `Map` / `Object.create(null)` 都不抛、静默归零）：
 *   · 只有"根本不是记录对象"的输入才 **throw**：`null` / `undefined` / 数字 / 字符串 /
 *     布尔 / 函数（`T20f` 钉住，`/non-null object/`）；
 *   · 其余任何非 null 对象（含 `[]` / `[1,2]` / `Date` / `Map` / `Object.create(null)` /
 *     纯 `{}`）一律**接受**，再按字段逐项纠正 ⇒ 落到「全零 + 空日桶」的合法状态；
 *   · 日桶：非 `isDayKey`（形状 / 范围 / 尾随空格）的键与非法数值一律丢弃，
 *     并按 `MAX_KEPT_DAYS` **封顶**（`cleanDays → capDays`，parse 路径也封顶，`T20j` 钉住）。
 *
 * 🩸 **为什么不把 `[]` / `Date` / `Map` 也改成抛**（审查给的另一个选择，这里明确否决；
 * 理由留档，免得日后被"顺手改成抛"）：
 *   宿主的 `restore`（`dsh-session-projection/lib/index.js:297`）是**裸调**
 *   `def.stateSchema.parse(row.val)`、**没有 try/catch**（对比 `:254` 的 `viewCheckpoint`
 *   是包了 `catch { continue }` 的）⇒ 我们这里抛一次，`hydrate` 就抛，**整个会话打不开**。
 *   而框架自己 `:296` 主动抛的语义是"行不可用 ⇒ 调用方重读 seq 0"（**可自愈**）；
 *   我们对同一份坏磁盘数据是**幂等抛**（重读还是读到同一行、还是抛）⇒ 会话**永久锁死**。
 *   拿一个**纯派生、可重放**字段（`usageDaily`）的形状洁癖去换"会话永久打不开"，不成比例。
 *   ⇒ 形状闸只留在"是不是记录对象"这一层；"字段级纠正 + 键级过滤"才是这层该做的防线。
 */
export const usageDailyStateSchema = {
  parse (value) {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('dsh-usage-tab: usageDaily projection state must be a non-null object')
    }
    return {
      days: cleanDays(value.days),
      hoursByDay: cleanHoursByDay(value.hoursByDay),
      byTool: cleanByTool(value.byTool),
      toolShapes: cleanToolShapes(value.toolShapes),
      byModel: cleanCounts(value.byModel, MAX_MODEL_KINDS),
      turnOutcomes: cleanCounts(value.turnOutcomes, MAX_MODEL_KINDS),
      compactions: countOf(value.compactions),
      eventShapes: cleanEventShapes(value.eventShapes),
      openToolName: typeof value.openToolName === 'string' ? value.openToolName : null,
      openToolStart: numOf(value.openToolStart),
      activeMs: nonNegOf(value.activeMs),
      turns: countOf(value.turns),
      segments: countOf(value.segments),
      longestMs: nonNegOf(value.longestMs),
      lastTime: numOf(value.lastTime),
      openStart: numOf(value.openStart),
    }
  },
  /** 顺带满足 Standard Schema（宿主目前不读，留着不亏，与 dsh-time-inject 同款）。 */
  '~standard': {
    version: 1,
    vendor: 'dsh-usage-tab',
    validate (value) {
      try {
        return { value: usageDailyStateSchema.parse(value) }
      } catch (error) {
        return { issues: [{ message: error?.message ?? String(error) }] }
      }
    },
  },
}

/**
 * wire 视图 schema —— **同样必须自带 `.parse`**：
 * `dsh-session-projection/lib/index.js:422 / :433` 也是裸调用
 * `wire.viewSchema.parse(wire.view(state))`。
 */
export const usageDailyViewSchema = {
  parse (value) {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('dsh-usage-tab: usageDaily wire view must be a non-null object')
    }
    return {
      days: cleanDays(value.days),
      hoursByDay: cleanHoursByDay(value.hoursByDay),
      byTool: cleanByTool(value.byTool),
      toolShapes: cleanToolShapes(value.toolShapes),
      byModel: cleanCounts(value.byModel, MAX_MODEL_KINDS),
      turnOutcomes: cleanCounts(value.turnOutcomes, MAX_MODEL_KINDS),
      compactions: countOf(value.compactions),
      eventShapes: cleanEventShapes(value.eventShapes),
      activeMs: nonNegOf(value.activeMs),
      turns: countOf(value.turns),
      segments: countOf(value.segments),
      longestMs: nonNegOf(value.longestMs),
    }
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-usage-tab',
    validate (value) {
      try {
        return { value: usageDailyViewSchema.parse(value) }
      } catch (error) {
        return { issues: [{ message: error?.message ?? String(error) }] }
      }
    },
  },
}

/**
 * 状态 → 下发给客户端的 slim 视图。
 *
 * 刻意**丢掉** `lastTime` / `openStart`：它们是折叠内部游标，客户端一个都用不上，
 * 而每一个 key 都会按会话列表行逐行下发（"别让列表行变胖"）。
 * 日桶是 `{ 'YYYY-MM-DD': 活跃毫秒 }` —— 每天一个数字，是能表达该口径的最小形状。
 */
export function usageDailyViewOf (state) {
  const days = {}
  const raw = state !== null && typeof state === 'object' && state.days !== null && typeof state.days === 'object'
    ? state.days
    : {}
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!isDayKey(key)) continue
    const ms = numOf(raw[key])
    if (ms === null || ms < 0) continue
    days[key] = ms
  }
  return {
    days,
    hoursByDay: cleanHoursByDay(state?.hoursByDay),
    byTool: cleanByTool(state?.byTool),
    toolShapes: cleanToolShapes(state?.toolShapes),
    byModel: cleanCounts(state?.byModel, MAX_MODEL_KINDS),
    turnOutcomes: cleanCounts(state?.turnOutcomes, MAX_MODEL_KINDS),
    compactions: countOf(state?.compactions),
    eventShapes: cleanEventShapes(state?.eventShapes),
    activeMs: nonNegOf(state?.activeMs),
    turns: countOf(state?.turns),
    segments: countOf(state?.segments),
    longestMs: nonNegOf(state?.longestMs),
  }
}

/** 浅复制工具桶外层（内层写时复制）。 */
function copyByTool (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  const keys = Object.keys(raw)
  for (let i = 0; i < keys.length; i++) out[keys[i]] = raw[keys[i]]
  return out
}

/**
 * **按工具名统计**（2026-10-14，按需求加入）：`tool/call` 开一条，`tool/result` 收一条。
 *
 * ⚠️ 配对策略：**认最近一次 `tool/call`**（DSH 的工具调用是串行的），不依赖任何 id 字段
 * （`tool/call` 的 data 形状未证实，见 `toolNameOf` 的注释）。
 */
function foldToolEvent (state, event, type, time) {
  if (type === 'tool/call') {
    const name = toolNameOf(event.data)
    const key = name === null ? '<unknown>' : name
    // 🩸 实测发现：**`tool/call` 当场计 1 次** —— 原来的实现要等 `tool/result` 才计数，
    //   于是"孤儿 call"（没有配对的 result）**连计数都不留**（实测 10 次真实调用 ⇒ 0 个桶）。
    //   ⇒ 次数在 call 那一刻就是确定的；耗时等 result 再补。
    const byTool = copyByTool(state.byTool)
    const prev = byTool[key] !== undefined && byTool[key] !== null ? byTool[key] : { calls: 0, ms: 0 }
    byTool[key] = { calls: countOf(prev.calls) + 1, ms: nonNegOf(prev.ms) }
    let toolShapes = state.toolShapes !== null && typeof state.toolShapes === 'object' ? state.toolShapes : {}
    if (name === null) {
      // 识别不出 ⇒ 把字段名 + 值类型记下来（让数据自己暴露真相）
      toolShapes = noteShape(toolShapes, 'tool/call', event.data)
    }
    return Object.assign({}, state, {
      byTool: cleanByTool(byTool),
      // **开段路径也要按条数封顶**（原来只有续段路径过 cleanToolShapes）
      toolShapes: cleanToolShapes(toolShapes),
      openToolName: key,
      openToolStart: time,
    })
  }
  const openName = typeof state.openToolName === 'string' ? state.openToolName : null
  const openStart = numOf(state.openToolStart)
  if (openName === null || openStart === null) return state
  const spent = time > openStart ? time - openStart : 0
  const byTool = copyByTool(state.byTool)
  const prev = byTool[openName] !== undefined && byTool[openName] !== null ? byTool[openName] : { calls: 0, ms: 0 }
  // 🩸 **配对上界**（2026-10-14 实测发现：`job_output` 累计出 24h36s / 50 次 ⇒ 明显配错对）：
  //    工具调用不可能超过这个量级；一旦超过，说明**某次 `tool/result` 缺失**、它跟很久之后的 `tool/call` 配上了。
  //    处置：**次数已在 call 时记过（不重复计），耗时记 0** —— 宁可少算，绝不给一个撒谎的数字。
  const validSpent = spent > 0 && spent <= MAX_TOOL_SPAN_MS ? spent : 0
  byTool[openName] = { calls: countOf(prev.calls), ms: nonNegOf(prev.ms) + validSpent }
  return Object.assign({}, state, {
    byTool: cleanByTool(byTool),
    openToolName: null,
    openToolStart: null,
  })
}

/** 模型名宽探测（字段名未证实 ⇒ 挨个试；全不中返回 `null`，由调用方记形状）。 */
function modelNameOf (data) {
  if (typeof data === 'string') return data.length > 0 ? data : null
  if (data === null || typeof data !== 'object') return null
  const model = data.model
  const candidates = [
    data.modelId,
    data.modelName,
    data.id,
    data.name,
    typeof model === 'string' ? model : null,
    model !== null && typeof model === 'object' ? model.id : null,
  ]
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (typeof c === 'string' && c.length > 0) return c
  }
  return null
}

/** `turn/end` 的结束原因宽探测（`reason` / `status` / `outcome` / `kind`）。
 *
 * 🩸 2026-10-14 实测修正：真实字段是 `reason`（留痕显示 `turn/end|reason:object,turn:number × 53`），
 * 但它的值是**对象**不是字符串 ⇒ 原来只收字符串的实现全部落空。现在多退两步：
 * 先取 `reason` 里的 kind/type/status/name，再不行就把它的字段名记成 `<reason:...>`（可读、可检索）。
 */
function reasonOf (data) {
  if (typeof data === 'string') return data.length > 0 ? data : null
  if (data === null || typeof data !== 'object') return null
  const candidates = [data.reason, data.status, data.outcome, data.kind]
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    if (typeof c === 'string' && c.length > 0) return c
  }
  const reason = data.reason
  if (reason !== null && typeof reason === 'object') {
    const inner = [reason.kind, reason.type, reason.status, reason.name, reason.reason]
    for (let j = 0; j < inner.length; j++) {
      const d = inner[j]
      if (typeof d === 'string' && d.length > 0) return d
    }
    const rk = Object.keys(reason).sort()
    return '<reason:' + (rk.length === 0 ? 'empty' : rk.join(',')) + '>'
  }
  if (reason !== undefined && reason !== null) return '<reason:' + typeof reason + '>'
  if (data.error !== undefined && data.error !== null) return '<error>'
  return null
}

/**
 * 🩸 fork 的合成 closer 与"清账锚点"**同毫秒** ⇒ 这类事件**什么都不该记**
 * （P1 硬口径：同毫秒合成事件必须返回**同一引用**、不产生 0 长幻影段）。
 * 新加的任何统计分支都要先过这道闸。
 */
function isAnchorSameMs (state, event) {
  const lastTime = numOf(state.lastTime)
  const time = numOf(event.time)
  // 🩸 实测发现：**判据不能只有"时间相等"** —— 真实事件与上一条**同毫秒**是常见情况
  //   （同一批工具调用/同一 tick 的多条事件），原来那样会把**真实**的 `turn/end` 当 fork closer 吞掉
  //   （实测：`turnOutcomes` 恒为 `{}`，把时间 +1ms 就正常记上）。
  //   ✅ 正确语义 = "**清账锚点还没被消费**"：`freshStateAt` 之后 `openStart` 为 null，
  //   而任何一条真实活跃事件都会把 `openStart` 设上 ⇒ "同毫秒 + 还没开段"才可能是合成 closer。
  return lastTime !== null && time !== null && time === lastTime && numOf(state.openStart) === null
}

/** 模型选择：按模型名累计轮数（认不出就记形状，让数据自己暴露真相）。 */
function foldModelEvent (state, event) {
  if (isAnchorSameMs(state, event)) return state
  const name = modelNameOf(event.data)
  if (name === null) {
    // 🩸 记完留痕要**收口**（`noteShape` 是"原样拼字段名"，键长可能很大 ⇒ 必须过 clean）
    const shapes = noteShape(state.eventShapes, 'model/selection', event.data)
    return Object.assign({}, state, { eventShapes: cleanEventShapes(shapes) })
  }
  const byModel = Object.assign({}, state.byModel !== null && typeof state.byModel === 'object' ? state.byModel : {})
  byModel[name] = countOf(byModel[name]) + 1
  return Object.assign({}, state, { byModel: cleanCounts(byModel, MAX_MODEL_KINDS) })
}

/** 轮结束：按原因累计（认不出就记形状）。 */
function foldTurnEnd (state, event) {
  if (isAnchorSameMs(state, event)) return state
  const reason = reasonOf(event.data)
  if (reason === null) {
    const shapes = noteShape(state.eventShapes, 'turn/end', event.data)
    return Object.assign({}, state, { eventShapes: cleanEventShapes(shapes) })
  }
  const out = Object.assign({}, state.turnOutcomes !== null && typeof state.turnOutcomes === 'object' ? state.turnOutcomes : {})
  out[reason] = countOf(out[reason]) + 1
  return Object.assign({}, state, { turnOutcomes: cleanCounts(out, MAX_MODEL_KINDS) })
}

/**
 * 折一条 committed 会话事件。
 *
 * 纯同步、纯 JSON、**不关心的事件返回同一引用**
 * （`dsh-session-projection/lib/types/index.d.ts:50-58`：`Object.is` 相同 ⇒ 下游零工作）。
 *
 * 三种"不关心"：
 *   ① `event` 不是对象 / 没有可读时间戳 → 返回入参（未知形状）；
 *   ② 事件类型不在 `ACTIVITY_EVENT_TYPES` 白名单 → 返回入参；
 *   ③ fork 切点后紧跟的合成 closers（与切点同毫秒）→ 返回入参（只锚不记）。
 *
 * @param {object} state - 折叠前状态（可能是 `stateSchema.parse` 纠正过的，也可能是 init 产物）。
 * @param {object} event - 一条 committed session 事件（信封级 `time` 是关键字段）。
 * @returns {object} 新状态；不关心该事件时**原样返回入参**。
 */
export function foldUsageDaily (state, event) {
  if (state === null || typeof state !== 'object') return state
  if (event === null || typeof event !== 'object') return state

  const type = typeof event.type === 'string' ? event.type : ''
  const time = numOf(event.time)

  // —— fork 继承切点：此前的一切都是父会话的账，清空重来 ——
  // `dsh-session/lib/types/fork.js:15-26`：切点事件是最后一个继承事件，
  // 且 `data.inherited === true`（普通 resume 标记没有这个字段，不许清账）。
  if (type === 'session/end-seed' && event.data !== null && typeof event.data === 'object' && event.data.inherited === true) {
    if (time === null) return state
    return freshStateAt(time)
  }

  // —— 按工具名统计（2026-10-14）：`tool/call` / `tool/result` 要单独记账 ——
  // 🩸 关键：**`tool/result` 本身就是活跃事件**（它在 `ACTIVITY_SET` 里）⇒ 这里**只能"顺带记账"，
  //    绝对不能 `return`**，否则把它从活跃口径里吃掉 —— 实测后果：每个工具调用之后的那段时间
  //    全都不计入活跃（`days` 空、`activeMs` 少一大截）。工具记账**不推进 `lastTime`**，所以不会篡改段口径。
  if (type === 'tool/call' || type === 'tool/result') {
    if (time !== null) state = foldToolEvent(state, event, type, time)
  }

  // —— 其它统计口径（2026-10-14）：模型 / 轮结束原因 / 压缩次数 ——
  // 🩸 同一条铁律：**`turn/end` 本身就在活跃白名单里** ⇒ 一律"顺带记账"，**绝不 return**
  //    （`model/selection` 与 `compaction/start` 不在白名单，多记一次也无害）。
  if (time !== null) {
    if (type === 'model/selection') state = foldModelEvent(state, event)
    else if (type === 'turn/end') state = foldTurnEnd(state, event)
    else if (type === 'compaction/start') {
      if (!isAnchorSameMs(state, event)) {
        state = Object.assign({}, state, { compactions: countOf(state.compactions) + 1 })
      }
    }
  }

  if (!ACTIVITY_SET.has(type)) return state
  if (time === null) return state

  const day = dayKeyOf(time)
  if (day === null) return state

  const lastTime = numOf(state.lastTime)
  const openStart = numOf(state.openStart)
  const gap = lastTime === null ? null : time - lastTime

  // 新段判定：还没开段（会话第一条 / 刚清过账），或距上一条活动事件已断开。
  let isNewSegment = openStart === null
  if (!isNewSegment && gap !== null && (gap > IDLE_THRESHOLD_MS || gap < 0)) isNewSegment = true

  if (isNewSegment) {
    // 清账锚点后的同毫秒合成事件（fork closers）：只推进锚点，不开段、不计时。
    if (openStart === null && lastTime !== null && gap === 0) return state
    // 开新段本身**不产生毫秒** ⇒ 日桶不新增键（只有量得出来的时长才落桶），
    // 因此这里可以原样带着旧日桶对象，不必复制。
    return {
      days: state.days,
      hoursByDay: state.hoursByDay,
      // 🩸 工具记账的四个字段也要带上：这里是**对象字面量返回**，
      //    落一个字段就会让状态在"开新段"时把工具账/诊断表丢掉（实测踩过）。
      byTool: state.byTool,
      toolShapes: state.toolShapes,
      byModel: state.byModel,
      turnOutcomes: state.turnOutcomes,
      compactions: state.compactions,
      eventShapes: state.eventShapes,
      openToolName: state.openToolName,
      openToolStart: state.openToolStart,
      activeMs: nonNegOf(state.activeMs),
      turns: countOf(state.turns) + (type === 'turn/start' ? 1 : 0),
      segments: countOf(state.segments) + 1,
      longestMs: nonNegOf(state.longestMs),
      lastTime: time,
      openStart: time,
    }
  }

  // 续段：把 gap 记进日桶。
  // 🩸 2026-09-25 定稿：「跨午夜的活跃**按照时区算**（该是哪天就哪天）」⇒ gap 跨本地午夜时
  // **在午夜处切开、分别落两天**（旧写法整段记在间隔起点日，误差上界 = 阈值 5 分钟；现在误差上界 0）。
  // 口径 A（同日定稿保持现状）：事件本身是 **0 毫秒**的瞬时时点，只有量得出来的 gap 落桶 ——
  // 别"顺手优化"成"每个事件加固定开销"。
  const added = gap !== null && gap > 0 ? gap : 0
  const days = copyDays(state.days)
  // 🩸 日内小时桶（2026-10-14 定稿）：与日桶**同源同切**，只是多切一刀「本地整点」
  //    用途：K 线的「高频使用时段」（实体）与「该时段之外的活动」（影线）。
  //    ⚠️ 只在 `added > 0` 时落桶，与日桶口径完全一致（事件本身是 0 毫秒瞬时时点）。
  const hoursByDay = copyHoursByDay(state.hoursByDay)
  if (added > 0) {
    const startDay = dayKeyOf(lastTime)
    const split = startDay !== null && startDay !== day ? localMidnightAfter(lastTime) : null
    if (split !== null) {
      // 跨午夜：前半段归起点日、后半段归终点日（`before + after === added`，不丢不重）。
      const before = Math.max(0, Math.min(added, split - lastTime))
      const after = added - before
      if (before > 0) days[startDay] = nonNegOf(days[startDay]) + before
      if (after > 0) days[day] = nonNegOf(days[day]) + after
      addHoursRange(hoursByDay, lastTime, split)
      addHoursRange(hoursByDay, split, time)
    } else {
      const bucket = startDay === null ? day : startDay
      days[bucket] = nonNegOf(days[bucket]) + added
      addHoursRange(hoursByDay, lastTime, time)
    }
  }
  const open = openStart === null ? time : openStart
  const longest = Math.max(nonNegOf(state.longestMs), time - open)
  return {
    days: capDays(days),
    hoursByDay: capHoursByDay(hoursByDay),
    // 🩸 同上：**每个返回点都要带上工具记账的字段**（字面量返回最容易漏）
    byTool: cleanByTool(state.byTool),
    toolShapes: cleanToolShapes(state.toolShapes),
    byModel: cleanCounts(state.byModel, MAX_MODEL_KINDS),
    turnOutcomes: cleanCounts(state.turnOutcomes, MAX_MODEL_KINDS),
    compactions: countOf(state.compactions),
    eventShapes: cleanEventShapes(state.eventShapes),
    openToolName: typeof state.openToolName === 'string' ? state.openToolName : null,
    openToolStart: numOf(state.openToolStart),
    activeMs: nonNegOf(state.activeMs) + added,
    turns: countOf(state.turns) + (type === 'turn/start' ? 1 : 0),
    segments: Math.max(1, countOf(state.segments)),
    longestMs: longest,
    lastTime: time,
    openStart: open,
  }
}

/** 日桶浅拷贝（只改命中那一个键，其余条目**共享引用**，避免 O(天数) 深拷贝）。 */
function copyDays (days) {
  const out = {}
  if (days === null || typeof days !== 'object') return out
  const keys = Object.keys(days)
  for (let i = 0; i < keys.length; i++) out[keys[i]] = days[keys[i]]
  return out
}

/**
 * 投影单元定义（照 `dsh-session-stats` 的 `sessionStatsProjectionDefinition` 骨架）。
 * 单独导出是为了让自测**不依赖宿主**也能验证 key / stateVersion / wire 齐备。
 */
export const usageDailyDefinition = {
  key: PROJECTION_KEY,
  stateVersion: PROJECTION_STATE_VERSION,
  stateSchema: usageDailyStateSchema,
  init: () => initUsageDailyState(),
  apply: (state, event) => foldUsageDaily(state, event),
  wire: {
    viewSchema: usageDailyViewSchema,
    view: (state) => usageDailyViewOf(state),
  },
}

/**
 * 🩸 **必须声明 `inject`**（2026-09-25 独立审查中途预警，纠正了早先"刻意不写"的判断）：
 * cordis 对**未经声明注入**的服务读取会直接 throw ——
 * `@deepseek-ai/cordis/lib/index.js:675`：`cannot get property "..." without inject`。
 * 而 profile 里 `session-projection` 与本插件是**兄弟 root 条目**（不是祖先），
 * 所以不声明的话 `apply` 里那次读取拿不到（或抛错）⇒ `usageDaily` **永不注册**，
 * 客户端的 `hasData` 闸门还会把这种失败伪装成"老会话还没缓存"（从界面上看不出是 bug）。
 *
 * 官方契约（`@deepseek-ai/dsh-session-projection/lib/index.js:36-39`）：
 * "A host reader **either declares `sessionProjections` in its plugin `inject`
 * or fails explicitly** … Contributors may preserve optional registration through
 * `ctx.inject(['sessionProjections'], …)`"。
 *
 * 同机反例证明早先的顾虑（"写 inject 会弄坏浏览器半边"）是**误判**：
 * `dsh-context` 与 `dsh-session-stats` **同时**具备 `dsh.client` 与
 * `inject = ['sessionProjections']`，它们的投影在本机 projcache 里照常落盘。
 */
export const inject = ['sessionProjections']

// ─────────────────────────────────────────────────────────────────────────────
// P2 第二步：冷会话回填（2026-10-13）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 回填启动延迟：宿主装配就绪后**再等一会儿**才开跑。
 *
 * 为什么要有这一段（照 `dsh-context` 的同源理由）：冷读 = 整份 durable log 的完整解码，
 * 几十上百个会话连续读会持续压着宿主 IO，而启动瞬间的握手（工作区侧栏也骑在这条通路上）
 * 最经不起抢。给启动让出几秒，之后再慢慢补。
 */
export const BACKFILL_START_DELAY_MS = 5000

/** 每个会话之间的让路时间（照 `dsh-context` 的 `YIELD_MS = 100`，逐字同值）。 */
export const BACKFILL_YIELD_MS = 100

/**
 * 探针键：缓存里**已经有这个键**才认为"无需回填"。
 *
 * 只探我们自己的键（不像 `dsh-context` 那样探它自己的两个）——
 * 回填的目的是把**我们**的账补齐，别的键在不在与我们无关。
 */
export const BACKFILL_PROBE_KEYS = Object.freeze([PROJECTION_KEY])

/** 任意输入 → 记录对象或 `null`（宿主服务的形状一律先过这一道）。 */
function asRecord (value) {
  return value !== null && typeof value === 'object' ? value : null
}

/** 从列表记录里取出 header，并复核 `id`（空串不算）。 */
function headerOf (record) {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header
}

/**
 * 读缓存行里已有的投影值。
 *
 * 🩸 两种调用形式都要试：新版是 3 参 `(header, offset, keys)`、旧版是 2 参 `(header, keys)`。
 * 这里**不 import `SessionLogOffset`**（本包零依赖），改传裸 `0` ——
 * 若那一版把第二参当 keys 用，`new Set(0)` 会**抛**，于是落进下面的 2 参重试；
 * 两次都失败就返回 `null`（= 判为"未服务"⇒ 照折一遍，**安全侧**）。
 */
function cachedViewValues (cache, header) {
  const read = (args) => {
    try {
      const snapshot = asRecord(cache.cachedSnapshot(...args))
      return asRecord(snapshot?.values)
    } catch {
      return null
    }
  }
  return read([header, 0, BACKFILL_PROBE_KEYS]) ?? read([header, BACKFILL_PROBE_KEYS])
}

/** 缓存里是否**已经有我们的行**（有就跳过，别白重折一遍）。 */
function servesRows (cache, header) {
  const values = cachedViewValues(cache, header)
  return values !== null && values[PROJECTION_KEY] !== undefined
}

/**
 * 冷读一份会话日志（镜像 `dsh-session-query` 的 `readColdSessionLog`）。
 *
 * ⚠️ 与 `dsh-context` 的差别：**不追加 `interruptedTurnClosers`**
 * （那要 import `@deepseek-ai/dsh-session`，与本包"零依赖"冲突）。
 * 后果 = 未正常闭合的最后一个 turn 少一条合成结束事件 ⇒ 该会话**最后一段**可能少算一点毫秒；
 * 口径上可接受（我们量的是"相邻活动事件的间隔之和"，不是"turn 的完整生命周期"）。
 */
async function readColdLog (persistence, id, signal) {
  const handle = await persistence.open(id, 'read', { signal })
  let events
  try {
    const result = asRecord(await handle.read(0, undefined, { signal }))?.events
    events = Array.isArray(result) ? result : []
  } catch (error) {
    try { await handle.close() } catch {}
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events,
  }
}

/**
 * 该会话是不是 live（live 的自己会折，冷写只会和它自己的检查点竞态）。
 * 注册表读抛错时**保守跳过**：宁可少补一行，也不覆盖可能 live 的会话。
 */
function isLive (sessions, id) {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return sessions.get(id) !== undefined
  } catch {
    return true
  }
}

/**
 * 冷读失败是不是"这版宿主根本读不了这份日志"（永久性、源侧拒绝 ⇒ 重试也不会成功）。
 * 按错误 `name` 的族前缀判（`SessionFormatUnsupported*`），不必 import 宿主的错误类。
 */
function isUnsupportedFormat (error) {
  try {
    return String(asRecord(error)?.name).startsWith('SessionFormatUnsupported')
  } catch {
    return false
  }
}

/** 错误的安全字符串化（恶意 error 可能在自身 toString 上抛）。 */
function messageOf (error) {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/**
 * 装配冷会话回填。返回 disposer（卸载时 abort 在跑的那一趟）。
 *
 * 🩸 **为什么不用自己折账**：`sessionProjectionCache.coldSnapshot()` 是宿主服务，
 * 它会对**所有已注册的投影单元**统一折一遍 —— 我们的 `usageDaily` 会被顺带折出来。
 * 我们只负责"把冷会话的日志喂进去"。
 *
 * 数据依据（实测探针）：老会话里 `usageDaily` 覆盖率明显偏低，缺的那批**连 `dsh-context` 自己的键也缺**
 * ⇒ 说明这条回填从没真正跑过。参考实现：`dsh-context\lib\index.js:2371-2449`。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @returns {(() => void)|undefined} disposer。
 */
export function watchUsageBackfill (ctx, options = {}) {
  // 可测性：自测传 `{ startDelayMs: 0, yieldMs: 0 }` 把启动延迟与会话间让路都压掉；
  // 生产不传 ⇒ 用上面两个默认常量。
  const startDelayMs = Number.isFinite(options.startDelayMs) ? options.startDelayMs : BACKFILL_START_DELAY_MS
  const yieldMs = Number.isFinite(options.yieldMs) ? options.yieldMs : BACKFILL_YIELD_MS
  // 🩸 只准跑一趟（2026-10-13 独立审查，照参考实现 `dsh-context\lib\index.js:2372-2379` 的三态防重）：
  // 万一 `ctx.inject` 回调被重复触发（服务重载 / 多提供者），第二趟会在定时器里看到 `started` 直接收手，
  // 否则同一批会话会被并发冷读两遍（重复 `coldSnapshot` + 多一个 AbortController）。
  // ⚠️ `started` 必须在**回调外**：放回调里等于每个闭包各有一份，防不住重复触发。
  let started = false
  const fiber = ctx.inject(
    ['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'],
    (raw) => {
      const query = asRecord(raw.sessionQuery)
      const cache = asRecord(raw.sessionProjectionCache)
      const persistence = asRecord(raw.sessionPersistence)
      // 🩸 早退必须留痕（2026-10-13 独立审查）：下面三条都是"宿主不兼容"，
      // 但"宿主还没装配好"是**同一个形状** —— 不留一行，两者在日志上完全不可区分，
      // 而回填会永久不发生（先例：本文件 `:516` 点名的"失败伪装成正常空态"）。
      // 只发 debug、不 warn：这不是错误，是"还没轮到 / 不支持"。
      const missing = []
      if (query === null || typeof query.listSessions !== 'function') missing.push('sessionQuery.listSessions')
      if (cache === null || typeof cache.cachedSnapshot !== 'function' || typeof cache.coldSnapshot !== 'function') {
        missing.push('sessionProjectionCache.cachedSnapshot/coldSnapshot')
      }
      if (persistence === null || typeof persistence.open !== 'function') missing.push('sessionPersistence.open')
      if (missing.length > 0) {
        ctx.logger?.debug?.(`dsh-usage-tab: 冷会话回填未装配（宿主服务的 ${missing.join(' / ')} 不可用；刚启动完的话可忽略）`)
        return
      }

      const sessions = asRecord(raw.sessions)
      const abort = new AbortController()
      let done = false

      const run = async () => {
        if (done || abort.signal.aborted) return
        const listed = await query.listSessions(abort.signal)
        if (!Array.isArray(listed)) return
        let folded = 0
        let refused = 0
        let skipped = 0
        for (const record of listed) {
          if (abort.signal.aborted) return
          const header = headerOf(record)
          // 没有 cwd 的（含子代理会话）不补：本步口径是"主会话的账"，去重留待后续。
          if (header === null || typeof header.cwd !== 'string') { skipped++; continue }
          if (isLive(sessions, header.id)) continue
          if (servesRows(cache, header)) continue
          try {
            const log = await readColdLog(persistence, header.id, abort.signal)
            cache.coldSnapshot(log.header, log.inheritedEventCount, log.events)
            folded++
          } catch (error) {
            if (isUnsupportedFormat(error)) {
              refused++
              ctx.logger?.debug?.(`dsh-usage-tab: 回填跳过 "${header.id}"（旧日志格式，源文件未改动）`)
            } else {
              ctx.logger?.warn?.(`dsh-usage-tab: 回填跳过 "${header.id}"（${messageOf(error)}）`)
            }
          }
          if (yieldMs > 0) await new Promise((resolve) => setTimeout(resolve, yieldMs))
        }
        if (folded > 0) ctx.logger?.info?.(`dsh-usage-tab: 冷会话回填完成 ${folded} 个会话的 usageDaily 投影`)
        if (refused > 0) ctx.logger?.info?.(`dsh-usage-tab: 回填跳过 ${refused} 个会话（日志格式不支持迁移，源文件未改动）`)
        if (skipped > 0) ctx.logger?.debug?.(`dsh-usage-tab: 回填忽略 ${skipped} 条无 cwd 的记录`)
      }

      // 延迟启动：给宿主装配与首屏握手让路（理由见 BACKFILL_START_DELAY_MS）。
      const timer = setTimeout(() => {
        if (started) return
        started = true
        run().catch((error) => {
          if (!abort.signal.aborted) {
            ctx.logger?.warn?.(`dsh-usage-tab: 冷会话回填提前结束（${messageOf(error)}）`)
          }
        })
      }, startDelayMs)

      return () => {
        done = true
        clearTimeout(timer)
        abort.abort()
      }
    },
  )
  return () => { try { fiber?.dispose?.() } catch {} }
}

/**
 * 装配插件。
 *
 * 下面仍保留 `ctx.get` 兜底 + try/catch（双保险：万一某些装配下服务改名或缺失，
 * 也绝不拖挂 DSH 启动，只是退化成"只有浏览器半边"）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 */
export function apply (ctx) {
  try {
    const registry = ctx?.sessionProjections ?? (typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined)
    if (registry === undefined || registry === null || typeof registry.register !== 'function') {
      // 投影不可用不算致命：本插件退化成"只有浏览器半边"，界面走空态（绝不抛）。
      ctx?.logger?.warn?.('dsh-usage-tab: sessionProjections 不可用，usageDaily 投影未注册（界面保持空态）。')
    } else {
      registry.register(usageDailyDefinition)
    }
  } catch (error) {
    // 装配期绝不抛：宁可这插件不生效，也不能拖挂 DSH 启动。
    ctx?.logger?.warn?.('dsh-usage-tab: usageDaily 投影注册失败（DSH 启动不受影响）：%s', error?.message ?? String(error))
  }

  // P2 第二步：冷会话回填。与投影注册**相互独立** —— 投影没注册上也照样尝试回填
  // （回填走宿主服务，不依赖我们自己注册成功）。装配失败同样绝不拖挂启动。
  let disposeBackfill
  try {
    disposeBackfill = watchUsageBackfill(ctx)
  } catch (error) {
    ctx?.logger?.warn?.('dsh-usage-tab: 冷会话回填装配失败（DSH 启动不受影响）：%s', error?.message ?? String(error))
  }

  return () => {
    try { disposeBackfill?.() } catch {}
  }
}
