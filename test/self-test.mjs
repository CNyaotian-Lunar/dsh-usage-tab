/**
 * dsh-usage-tab — 自测（**不依赖宿主**）
 * ============================================================================
 *
 * 怎么做到"不依赖宿主"却又"测的是真产物"：
 *   1. 读 lib/client.js 原文（就是交付的那份，不是副本、不是重写）；
 *   2. 用 `new Function('window', 'require', code)` 在**宿主 realm**里执行它
 *      —— 不用 `node:vm`：vm 会造出一个新 realm，跨 realm 的 Array/Map 原型不同，
 *      `deepStrictEqual` 会因原型不匹配而误报，反而要绕开断言；
 *   3. 给一个假的 `window.__ModuleLoader__` 把工厂**截获**下来，再手动 materialize
 *      它（模拟浏览器侧懒加载）；`require('react')` 用一个够用的 stub 顶上，
 *      其它模块名一律抛错（这就顺带验证了"不许 import 不存在的模块"）；
 *   4. 纯函数经 `module.exports.__test` 取出，逐条断言。
 *   P2 第一步起，**宿主半 `lib/index.mjs` 也直接 import 进来测**（它零依赖，
 *   不需要装包、不需要宿主）—— T20* 全部跑在它身上。
 *
 * 覆盖：外壳契约 / 字典完整性 / 活跃段切分 / 空闲率 / 每小时分桶（两种量纲）/
 *       时长格式化与排序 / 甘特与柱高归一化 / **渲染层绝不上屏 NaN 或 undefined** /
 *       apply 的注册参数与降级路径 / CSS 零硬编码配色 /
 *       **P2 第一步**：宿主 usageDaily 折叠（逐日活跃 / 5 分钟阈值 / fork 切点 /
 *       Object.is 门禁 / stateSchema 适配器 / 日桶封顶 / apply 降级）+
 *       客户端日历真数据通路（日键口径 / 跨会话聚合 / 日历模型 / 两侧空态）+
 *       **P2 第二步**：宿主冷会话回填（T22a~T22d —— 服务缺失不抛 / 跳过口径与折账参数 /
 *       旧日志格式走 debug 不 warn 且不中断 / dispose 的定时器清理与中途 abort）。
 *
 * ⚠️ 回填用例是**异步**的（回填跑在 `setTimeout` + `await` 里）：它们经 `testAsync` 登记，
 *    在同步用例全部跑完、汇总之前统一 await（见文件末尾「异步用例」段）。
 *
 * 运行：node test/self-test.mjs   （退出码 0 = 全绿，1 = 有用例失败）
 */

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
// P2 第一步：宿主半（lib/index.mjs）也**真的被测**——它是零依赖纯 ESM，
// 可以直接 import，不需要宿主、不需要装包（counterfactual 工具会把整个 lib/ 一起拷走）。
import * as HOST from '../lib/index.mjs'

// ---------------------------------------------------------------- 装载真产物

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const reactStub = {
  // 必须用 function 声明：箭头函数没有自己的 arguments（第一版就是这么挂的）。
  createElement: function (type, props) {
    return { type, props, children: Array.prototype.slice.call(arguments, 2) }
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}

let captured = null
let requiredModules = []
const fakeWindow = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
const fakeRequire = (id) => {
  requiredModules.push(id)
  if (id === 'react') return reactStub
  throw new Error('unexpected require: ' + id)
}

// 产物顶层用 window.__ModuleLoader__.load(...)；这里让它在宿主 realm 里跑。
const runner = new Function('window', 'require', code)
runner(fakeWindow, fakeRequire)

const exportsObj = captured.factory(fakeRequire)
const T = exportsObj.__test

// ---------------------------------------------------------------- 迷你测试框架

let passed = 0
const failures = []

/** 登记一条用例结果（同步 / 异步共用同一份计数与失败列表）。 */
function record (name, err) {
  if (err === undefined) {
    passed += 1
    console.log('PASS  ' + name)
  } else {
    failures.push({ name, message: err && err.message ? err.message : String(err) })
    console.log('FAIL  ' + name)
    console.log('      ' + (err && err.message ? err.message.split('\n')[0] : String(err)))
  }
}

function test (name, fn) {
  try {
    fn()
    record(name)
  } catch (err) {
    record(name, err)
  }
}

/**
 * 异步用例：回填（P2 第二步）是 `setTimeout` + `await` 驱动的，同步 `test` 跑不到它的回调。
 * 这里只登记，等同步用例全部跑完、汇总之前统一 await（见文件末尾「异步用例」段）。
 */
const asyncCases = []
function testAsync (name, fn) { asyncCases.push({ name, fn }) }

/** 递归扫描：任何上屏字符串含 NaN/undefined/missing、或任何非有限数字，都算脏。 */
function scanBadValues (value, path, bad) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad.push(path + ' = ' + String(value))
    return
  }
  if (typeof value === 'string') {
    if (/NaN|undefined|\[missing:/.test(value)) bad.push(path + ' = ' + JSON.stringify(value))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanBadValues(item, path + '[' + index + ']', bad))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) scanBadValues(value[key], path + '.' + key, bad)
  }
}

function assertClean (value, label) {
  const bad = []
  scanBadValues(value, label, bad)
  assert.deepEqual(bad, [], '上屏数据里出现脏值：\n' + bad.join('\n'))
}

/** 从 react 桩的树上收集所有会变成文本的东西（children 字符串 + props 里的字符串）。 */
function collectStrings (node, out) {
  if (typeof node === 'string') { out.push(node); return }
  if (typeof node === 'number') { out.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((item) => collectStrings(item, out)); return }
  if (node !== null && typeof node === 'object') {
    if (node.props) {
      for (const key of Object.keys(node.props)) {
        if (typeof node.props[key] === 'string') out.push(node.props[key])
      }
    }
    if (Array.isArray(node.children)) collectStrings(node.children, out)
  }
}

/** 深度遍历 react 桩的树，收集满足 predicate 的节点（用于断言"某个节点真的渲染了"）。 */
function findNodes (node, predicate, out) {
  const acc = out || []
  if (Array.isArray(node)) { node.forEach((item) => findNodes(item, predicate, acc)); return acc }
  if (node === null || typeof node !== 'object') return acc
  if (predicate(node)) acc.push(node)
  if (Array.isArray(node.children)) findNodes(node.children, predicate, acc)
  return acc
}

// ---------------------------------------------------------------- 夹具

const baseTs = new Date(2026, 0, 1, 13, 0, 0).getTime() // 本地 13:00:00

const turnTimings = new Map([
  [0, { startTime: baseTs, endTime: baseTs + 60000 }],
  [1, { startTime: baseTs + 90000, endTime: baseTs + 210000 }],
  [2, { startTime: baseTs + 3600000, endTime: baseTs + 3720000 }]
])

const timeline = {
  turnOrder: [0, 1, 2, 3],
  turns: new Map([
    [0, { turn: 0, steps: [{ step: 0, start: { time: baseTs + 1000, seq: 1 } }, { step: 1, start: { time: baseTs + 2000, seq: 2 } }] }],
    [1, { turn: 1, steps: [{ step: 0, start: { time: baseTs + 91000, seq: 3 } }] }],
    [2, { turn: 2, steps: [{ step: 0, start: { time: baseTs + 7200000, seq: 4 } }] }],
    [3, { turn: 3, steps: null }] // 防御：steps 缺失不许崩
  ])
}

const stats = { turns: 3, steps: 4, llmMs: 1000, toolMs: 500 }

const zh = (key) => T.DICT_ZH[key]

console.log('dsh-usage-tab self-test（P1 + P2 第一步）')
console.log('node ' + process.version + ' · client.js ' + code.length + ' chars')
console.log('----')

// ---------------------------------------------------------------- T1 外壳契约

test('T1 外壳：window.__ModuleLoader__.load 格式 + id 必须是包名', () => {
  assert.match(code, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(code, /id:\s*"dsh-usage-tab"/)
  assert.equal(captured.id, 'dsh-usage-tab', 'loader id 必须是包名本身')
  assert.equal(typeof captured.factory, 'function')
})

test('T1b 外壳：只 require 了 react（不许 import 不存在的模块）', () => {
  const specifiers = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(specifiers)], ['react'], '实际 require 的模块：' + JSON.stringify(specifiers))
  assert.deepEqual([...new Set(requiredModules)], ['react'])
})

test('T1c 导出：name / inject / apply 齐备，宿主半分离', () => {
  assert.equal(exportsObj.name, 'dsh-usage-tab')
  assert.deepEqual(exportsObj.inject, ['slots', 'locale'])
  assert.equal(typeof exportsObj.apply, 'function')
  assert.equal(typeof T.apply, 'function')
})

// ---------------------------------------------------------------- T2 字典

test('T2 字典：zh/en key 集合一致（中文非空；英文允许空串做后缀）', () => {
  const zhKeys = Object.keys(T.DICT_ZH).sort()
  const enKeys = Object.keys(T.DICT_EN).sort()
  assert.deepEqual(enKeys, zhKeys, '中英 key 不一致')
  for (const key of zhKeys) {
    assert.equal(typeof T.DICT_ZH[key], 'string')
    assert.ok(T.DICT_ZH[key].length > 0, '中文空值: ' + key)
    assert.equal(typeof T.DICT_EN[key], 'string', '英文缺 key: ' + key)
  }
  // 空串只允许出现在"纯后缀"位置（英文 "Turn 5" 没有中文的 " 轮" 后缀）。
  // P1-fix：hours.sum 已从白名单移除 —— 英文前缀从 "" 改成 "Loaded window "，
  // 口径标注不许再留空（中文 "已加载窗口 "）。
  const ALLOWED_EMPTY_EN = ['gantt.turnSuffix']
  const emptyEn = enKeys.filter((key) => T.DICT_EN[key] === '')
  assert.deepEqual(emptyEn, ALLOWED_EMPTY_EN.filter((key) => enKeys.includes(key)),
    '英文空值的白名单变了——要么补文案，要么显式改这份白名单')
  assert.ok(zhKeys.length >= 20, '字典条目数偏少: ' + zhKeys.length)
  assert.equal(T.DICT_ZH.tab, '时间统计', 'tab 名必须是「时间统计」')
})

// ---------------------------------------------------------------- T3 时长格式化

test('T3 formatDuration：缺失一律 —，且不出现 60.0s / 60m00s', () => {
  const f = T.formatDuration
  assert.equal(f(undefined), '—')
  assert.equal(f(null), '—')
  assert.equal(f(NaN), '—')
  assert.equal(f(Infinity), '—')
  assert.equal(f(-1), '—')
  assert.equal(f('1000'), '—')
  assert.equal(f(0), '0.0s')
  assert.equal(f(999), '1.0s')
  assert.equal(f(45200), '45.2s')
  assert.equal(f(59949), '59.9s')
  assert.equal(f(59999), '1m00s')
  assert.equal(f(60000), '1m00s')
  assert.equal(f(162000), '2m42s')
  assert.equal(f(3599999), '1h00m')
  assert.equal(f(3600000), '1h00m')
  assert.equal(f(3900000), '1h05m')
  assert.equal(f(86399999), '24h00m')
})

test('T3b formatPercent / formatCount / formatClock', () => {
  assert.equal(T.formatPercent(null), '—')
  assert.equal(T.formatPercent(NaN), '—')
  assert.equal(T.formatPercent(0), '0.0%')
  assert.equal(T.formatPercent(0.5), '50.0%')
  assert.equal(T.formatPercent(1), '100.0%')
  assert.equal(T.formatCount(undefined), '—')
  assert.equal(T.formatCount(NaN), '—')
  assert.equal(T.formatCount(0), '0')
  assert.equal(T.formatCount(12.6), '13')
  assert.equal(T.formatClock(null), '—')
  assert.equal(T.formatClock(NaN), '—')
  assert.equal(T.formatClock(baseTs), '13:00:00')
})

// ---------------------------------------------------------------- T4 活跃段切分

test('T4 mergeSegments：5 分钟阈值（> 阈值才断开）', () => {
  const spans = T.collectTurnSpans(turnTimings, null)
  assert.equal(spans.length, 3)
  const segments = T.mergeSegments(spans, T.IDLE_THRESHOLD_MS)
  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].turns, [0, 1])
  assert.deepEqual(segments[1].turns, [2])
  assert.equal(segments[0].start, baseTs)
  assert.equal(segments[0].end, baseTs + 210000)
})

test('T4b mergeSegments：间隔恰好 5 分钟 ⇒ 同一段；多 1ms ⇒ 断开', () => {
  const exactly = [
    { turn: 0, start: 0, end: 1000 },
    { turn: 1, start: 301000, end: 302000 }
  ]
  assert.equal(T.mergeSegments(exactly, 300000).length, 1, '恰好 5 分钟应合并')
  const over = [
    { turn: 0, start: 0, end: 1000 },
    { turn: 1, start: 301001, end: 302000 }
  ]
  assert.equal(T.mergeSegments(over, 300000).length, 2, '超过 5 分钟应断开')
})

test('T4c mergeSegments：乱序输入排序、重叠区间合并、空输入', () => {
  const messy = [
    { turn: 1, start: 1000, end: 2000 },
    { turn: 0, start: 0, end: 1500 }
  ]
  const segments = T.mergeSegments(messy, 300000)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].end, 2000, '重叠时应取较晚的 end')
  assert.deepEqual(segments[0].turns, [0, 1])
  assert.deepEqual(T.mergeSegments([], 300000), [])
  assert.deepEqual(T.mergeSegments(null, 300000), [])
})

// ---------------------------------------------------------------- T5 汇总 / 空闲率

test('T5 summarizeUsage：挂钟 / 活跃 / 空闲 / 空闲率', () => {
  const spans = T.collectTurnSpans(turnTimings, null)
  const sum = T.summarizeUsage(spans, T.IDLE_THRESHOLD_MS)
  assert.equal(sum.turnCount, 3)
  assert.equal(sum.segmentCount, 2)
  assert.equal(sum.wallMs, 3720000, '挂钟 = 最晚 end − 最早 start')
  assert.equal(sum.activeMs, 330000, '活跃 = 各段之和')
  assert.equal(sum.idleMs, 3390000)
  assert.equal(T.formatDuration(sum.wallMs), '1h02m')
  assert.equal(T.formatDuration(sum.activeMs), '5m30s')
  assert.equal(T.formatPercent(sum.idleRate), '91.1%')
  assert.equal(T.formatClock(sum.firstAt), '13:00:00')
  assert.equal(sum.longestSegmentMs, 210000)
  assert.equal(sum.avgSegmentMs, 165000)
})

test('T5b summarizeUsage：空输入 ⇒ 时长类字段为 null（不是 0）', () => {
  const sum = T.summarizeUsage([], T.IDLE_THRESHOLD_MS)
  assert.equal(sum.wallMs, null)
  assert.equal(sum.activeMs, null)
  assert.equal(sum.idleMs, null)
  assert.equal(sum.idleRate, null)
  assert.equal(sum.firstAt, null)
  assert.equal(sum.segmentCount, 0)
  assert.equal(T.formatDuration(sum.wallMs), '—')
  assert.equal(T.formatPercent(sum.idleRate), '—')
})

test('T5c summarizeUsage：单轮 ⇒ 空闲率 0%（不是 null、也不是 —）', () => {
  const sum = T.summarizeUsage([{ turn: 0, start: 1000, end: 5000 }], T.IDLE_THRESHOLD_MS)
  assert.equal(sum.wallMs, 4000)
  assert.equal(sum.activeMs, 4000)
  assert.equal(sum.idleMs, 0)
  assert.equal(T.formatPercent(sum.idleRate), '0.0%')
})

// ---------------------------------------------------------------- T6 每小时（步数）

test('T6 hourlyStepCounts：24 桶、按本地小时落桶、总和不丢', () => {
  const times = [
    new Date(2026, 0, 1, 13, 30, 0).getTime(),
    new Date(2026, 0, 1, 13, 45, 0).getTime(),
    new Date(2026, 0, 1, 13, 59, 0).getTime(),
    new Date(2026, 0, 1, 4, 0, 0).getTime(),
    new Date(2026, 0, 1, 4, 30, 0).getTime(),
    new Date(2026, 0, 1, 23, 59, 0).getTime()
  ]
  const counts = T.hourlyStepCounts(times)
  assert.equal(counts.length, 24)
  assert.equal(counts[13], 3)
  assert.equal(counts[4], 2)
  assert.equal(counts[23], 1)
  assert.equal(counts[0], 0)
  assert.equal(counts.reduce((a, b) => a + b, 0), 6)
  assert.deepEqual(T.hourlyStepCounts(null).length, 24)
  assert.deepEqual(T.hourlyStepCounts([NaN, 'x', undefined]), new Array(24).fill(0))
})

// ---------------------------------------------------------------- T7 每小时（活跃毫秒）

test('T7 hourlyActiveMs：跨整点切分正确', () => {
  const from = new Date(2026, 0, 1, 13, 30, 0).getTime()
  const to = new Date(2026, 0, 1, 14, 30, 0).getTime()
  const buckets = T.hourlyActiveMs([{ turn: 0, start: from, end: to }])
  assert.equal(buckets[13], 1800000, '13:30→14:00 应是 30 分钟')
  assert.equal(buckets[14], 1800000, '14:00→14:30 应是 30 分钟')
  assert.equal(buckets.reduce((a, b) => a + b, 0), 3600000)
})

test('T7b hourlyActiveMs：跨午夜区间不丢毫秒', () => {
  const from = new Date(2026, 0, 1, 22, 15, 0).getTime()
  const to = new Date(2026, 0, 2, 1, 5, 0).getTime()
  const buckets = T.hourlyActiveMs([{ turn: 0, start: from, end: to }])
  assert.equal(buckets[22], 45 * 60000)
  assert.equal(buckets[23], 60 * 60000)
  assert.equal(buckets[0], 60 * 60000)
  assert.equal(buckets[1], 5 * 60000)
  assert.equal(buckets.reduce((a, b) => a + b, 0), 170 * 60000, '22:15→01:05 共 170 分钟')
})

test('T7c hourlyActiveMs：零长度 / 坏输入不产生 NaN、不死循环', () => {
  const zero = T.hourlyActiveMs([{ turn: 0, start: baseTs, end: baseTs }])
  assert.equal(zero.reduce((a, b) => a + b, 0), 0)
  const broken = T.hourlyActiveMs([{ turn: 1, start: NaN, end: NaN }, null, {}, { start: 5, end: 1 }])
  assert.equal(broken.reduce((a, b) => a + b, 0), 0)
  assert.ok(broken.every((value) => Number.isFinite(value)))
})

// ---------------------------------------------------------------- T8 排序

test('T8 rankTurns：用时降序，同长按轮号升序，limit 生效', () => {
  const spans = [
    { turn: 0, start: 0, end: 1000 },
    { turn: 1, start: 0, end: 5000 },
    { turn: 2, start: 0, end: 5000 },
    { turn: 3, start: 0, end: 3000 }
  ]
  const all = T.rankTurns(spans, null)
  assert.deepEqual(all.map((row) => row.turn), [1, 2, 3, 0])
  assert.deepEqual(all.map((row) => row.durationMs), [5000, 5000, 3000, 1000])
  assert.deepEqual(T.rankTurns(spans, 2).map((row) => row.turn), [1, 2])
  assert.equal(T.rankTurns(spans, 0).length, 4, 'limit=0 视为不限')
  assert.deepEqual(T.rankTurns([], 5), [])
  // 输入数组不许被就地改动
  const copy = spans.slice()
  T.rankTurns(copy, 2)
  assert.deepEqual(copy.map((row) => row.turn), [0, 1, 2, 3])
})

// ---------------------------------------------------------------- T9 甘特

test('T9 ganttRows：相对域的百分比 + 域非法时为空', () => {
  const rows = T.ganttRows([{ turn: 0, start: 0, end: 100 }], 0, 1000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].leftPct, 0)
  assert.equal(rows[0].widthPct, 10)
  assert.deepEqual(T.ganttRows([{ turn: 0, start: 0, end: 100 }], 1000, 1000), [])
  assert.deepEqual(T.ganttRows([{ turn: 0, start: 0, end: 100 }], null, 1000), [])
})

test('T9b ganttRows：零长轮给最小可见宽度、越界被 clamp', () => {
  const zero = T.ganttRows([{ turn: 0, start: 500, end: 500 }], 0, 1000)
  assert.equal(zero[0].widthPct, T.MIN_BAR_PCT, '零长轮也要看得见')
  const over = T.ganttRows([{ turn: 1, start: 500, end: 5000 }], 0, 1000)
  assert.equal(over[0].leftPct, 50)
  assert.equal(over[0].widthPct, 50, '不可越出 100%')
  assert.ok(over[0].leftPct + over[0].widthPct <= 100)
})

test('T9c normalizeHeights：归一化到 0..100，坏输入退化为 0', () => {
  assert.deepEqual(T.normalizeHeights([0, 5, 10]), [0, 50, 100])
  assert.deepEqual(T.normalizeHeights([0, 0]), [0, 0])
  assert.deepEqual(T.normalizeHeights([null, undefined, NaN]), [0, 0, 0])
  assert.deepEqual(T.normalizeHeights([]), [])
})

// ---------------------------------------------------------------- T10 通道读取

test('T10 collectTurnSpans：坏值丢弃、开放轮用兜底、按 start 升序', () => {
  const dirty = new Map([
    [0, { startTime: NaN }],
    [1, {}],
    [2, { startTime: 1000, endTime: NaN }],
    ['x', { startTime: 5 }],
    [3, { startTime: 900, endTime: 500 }], // end < start ⇒ 收成零长
    [4, { startTime: 50, endTime: 60 }] // 乱序
  ])
  const spans = T.collectTurnSpans(dirty, 2000)
  assert.deepEqual(spans.map((span) => span.turn), [4, 3, 2])
  assert.equal(spans[2].open, true, 'endTime 缺失应标 open')
  assert.equal(spans[2].end, 2000, '开放轮用兜底时间')
  assert.equal(spans[1].end, 900, 'end < start 收成零长')
  assert.deepEqual(T.collectTurnSpans(null, 1), [])
  assert.deepEqual(T.collectTurnSpans(undefined, 1), [])
})

test('T10b collectTurnSpans：普通对象形态（非 Map）也能读', () => {
  const spans = T.collectTurnSpans({ 0: { startTime: 10, endTime: 20 } }, null)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].turn, 0)
  assert.equal(spans[0].end, 20)
})

test('T10c stepStartsOf：从 timeline.turns[].steps[].start.time 取值并升序', () => {
  const starts = T.stepStartsOf(timeline)
  assert.equal(starts.length, 4, 'steps 为 null 的轮要跳过')
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  assert.deepEqual(T.stepStartsOf(null), [])
  assert.deepEqual(T.stepStartsOf({}), [])
  assert.deepEqual(T.stepStartsOf({ turns: new Map([['a', { steps: 'nope' }]]) }), [])
})

// ---------------------------------------------------------------- T11 模型：空输入

test('T11 buildModel：空输入 ⇒ 十项 KPI 全是 —、无脏值', () => {
  const model = T.buildModel({}, zh)
  assert.equal(model.hasData, false)
  assert.equal(model.hasTurns, false)
  assert.equal(model.kpis.length, 10)
  assert.deepEqual(model.kpis.map((kpi) => kpi.key),
    ['turns', 'steps', 'wall', 'active', 'idleRate', 'first', 'avgTurn', 'medianTurn', 'maxTurn', 'longestIdle'])
  assert.deepEqual(model.kpis.map((kpi) => kpi.value), ['—', '—', '—', '—', '—', '—', '—', '—', '—', '—'])
  assert.equal(model.gantt.length, 0)
  assert.equal(model.rank.length, 0)
  assert.equal(model.hours.length, 24)
  assert.ok(model.hours.every((bar) => bar.heightPct === 0))
  assertClean(model, 'model(empty)')
})

// ---------------------------------------------------------------- T12 模型：完整输入

test('T12 buildModel：完整输入的关键数值', () => {
  const model = T.buildModel({ stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS }, zh)
  assert.equal(model.hasData, true)
  assert.equal(model.hasTurns, true)
  const byKey = Object.fromEntries(model.kpis.map((kpi) => [kpi.key, kpi.value]))
  assert.deepEqual(
    {
      turns: byKey.turns, steps: byKey.steps, wall: byKey.wall,
      active: byKey.active, idleRate: byKey.idleRate, first: byKey.first
    },
    {
      turns: '3',
      steps: '4',
      wall: '1h02m',
      active: '5m30s',
      idleRate: '91.1%',
      first: '13:00:00'
    }
  )
  // 2026-10-14 追加的 4 项（⚠️ 口径：只覆盖**已加载窗口**的 spans，与上面来自 sessionStats 的全日志 KPI 不同源）
  assert.equal(byKey.avgTurn, '1m40s', '窗口内 3 轮共 300000ms ⇒ 平均 1m40s')
  assert.equal(byKey.medianTurn, '2m00s', '排序后取中位（60000 / 120000 / 120000）')
  assert.equal(byKey.maxTurn, '2m00s')
  assert.equal(byKey.longestIdle, '56m30s', '最长空闲 = 挂钟 1h02m − 活跃 5m30s')
  assert.equal(model.gantt.length, 3)
  assert.ok(Math.abs(model.gantt[0].widthPct - (60000 / 3720000) * 100) < 1e-9)
  assert.deepEqual(model.rank.map((row) => row.turn), [1, 2, 0], '同长按轮号升序')
  assert.equal(model.rank[0].durationText, '2m00s')
  assert.equal(model.rank[0].widthPct, 100)
  assert.equal(model.rank[2].widthPct, 50)
  assert.equal(model.totals.stepCount, 4)
  assert.equal(model.totals.totalSteps, 4)
  assert.equal(model.hours[13].count, 3)
  assert.equal(model.hours[15].count, 1)
  assert.equal(model.hours[13].heightPct, 100)
  assert.ok(Math.abs(model.hours[15].heightPct - 100 / 3) < 1e-9)
  assertClean(model, 'model(full)')
})

test('T12d 时间构成：llmMs vs toolMs 占比 + 首 token 平均 + 生成速度（第 1 批）', () => {
  const m = T.buildModel({
    stats: {
      turns: 3, steps: 4,
      llmMs: 60000, toolMs: 30000,
      ttftMs: 12000, ttftSteps: 4,
      decodeMs: 40000, decodeTokens: 800
    }
  }, zh)
  assert.equal(m.workSplit.llmText, '1m00s')
  assert.equal(m.workSplit.toolText, '30.0s')
  assert.equal(Math.round(m.workSplit.llmPct), 67, '60000 / 90000')
  assert.equal(Math.round(m.workSplit.toolPct), 33)
  assert.equal(m.workSplit.ttftText, '3.0s', '首 token 累计 12000ms / 4 步')
  assert.equal(m.workSplit.tpsText, '20.0 tok/s', '800 tokens / 40s')
  // 拿不到投影 / 缺字段 ⇒ **整块 null**（界面不挂这张卡，绝不用 0 冒充）
  assert.equal(T.buildModel({ stats: { turns: 3 } }, zh).workSplit, null, '只有 turns/steps 时不给占比')
  assert.equal(T.buildModel({}, zh).workSplit, null)
  // 边界：ttftSteps=0 / decodeMs=0 ⇒ "—"，不许产出 NaN / Infinity
  const edge = T.buildModel({
    stats: { turns: 1, llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  }, zh)
  assert.equal(edge.workSplit.ttftText, '—')
  assert.equal(edge.workSplit.tpsText, '—')
  assert.equal(edge.workSplit.llmPct, 100, '工具为 0 ⇒ 模型占满')
  // 🩸 实测发现：投影**存在但全 0**（正是宿主 `init()` 的默认形状）⇒ 整块不挂卡，
  //    否则会印出"模型 0.0s · 0% / 工具 0.0s · 0%"，等于用 0 冒充"没有数据"
  const allZero = T.buildModel({
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  }, zh)
  assert.equal(allZero.workSplit, null, '全 0 投影 = 没有数据 ⇒ 不许挂卡')
  // 但只有 ttft/decode 是真数据（llm/tool 都 0）时**仍要挂卡**（别把"没有模型/工具耗时"当成没数据）
  const onlySpeed = T.buildModel({
    stats: { turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 500, ttftSteps: 1, decodeMs: 1000, decodeTokens: 20 }
  }, zh)
  assert.ok(onlySpeed.workSplit !== null, '有 ttft/decode 真实数据就必须给卡')
  assert.equal(onlySpeed.workSplit.tpsText, '20.0 tok/s')
  // 🩸 实测：负 token ⇒ "—"（不许印 `-800.0 tok/s`）
  const negTok = T.buildModel({
    stats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 40000, decodeTokens: -800 }
  }, zh)
  assert.equal(negTok.workSplit.tpsText, '—', '负数 token 不许上屏')
  // 🩸 实测：单边负数 ⇒ 整块不挂卡（分母会变 0、却仍把"工具 1.0s · 0%"印出来 = 自相矛盾）
  const negOne = T.buildModel({ stats: { turns: 1, steps: 1, llmMs: -1000, toolMs: 1000 } }, zh)
  assert.equal(negOne.workSplit, null, '单边负数必须整块不挂卡')
  assertClean(edge, 'model(workSplit-edge)')
})

test('T12b buildModel：未结束轮用 openEndFallback 兜底', () => {
  const open = new Map([[0, { startTime: baseTs }]])
  const model = T.buildModel({ turnTimings: open, openEndFallback: baseTs + 120000 }, zh)
  const byKey = Object.fromEntries(model.kpis.map((kpi) => [kpi.key, kpi.value]))
  assert.equal(byKey.wall, '2m00s')
  assert.equal(byKey.active, '2m00s')
  assertClean(model, 'model(open)')
})

test('T12c buildModel：limit 之外——排行最多 5 条', () => {
  const many = new Map()
  for (let i = 0; i < 12; i++) many.set(i, { startTime: baseTs + i * 600000, endTime: baseTs + i * 600000 + (i + 1) * 1000 })
  const model = T.buildModel({ turnTimings: many }, zh)
  assert.equal(model.rank.length, T.RANK_LIMIT)
  assert.deepEqual(model.rank.map((row) => row.turn), [11, 10, 9, 8, 7])
  assertClean(model, 'model(rank-limit)')
})

// ---------------------------------------------------------------- T13 脏数据不上屏

test('T13 脏输入不许把 NaN / undefined 印上模型（5 组对照）', () => {
  const dirtyCases = [
    { label: 'stats 全是坏值', input: { stats: { turns: NaN, steps: undefined, llmMs: 'x' } } },
    { label: 'stats 是字符串', input: { stats: 'nope' } },
    { label: 'timeline 形状全错', input: { timeline: { turns: 'nope' } } },
    { label: 'turnTimings 是数组', input: { turnTimings: [null, 42, { startTime: 'x' }] } },
    { label: '全空对象 + idleMs 为 NaN', input: { stats: null, turnTimings: null, timeline: null, idleMs: NaN, openEndFallback: NaN } }
  ]
  for (const item of dirtyCases) {
    assertClean(T.buildModel(item.input, zh), 'model(' + item.label + ')')
  }
})

// ---------------------------------------------------------------- T14 渲染冒烟

test('T14 UsageView 渲染冒烟：树上没有 NaN / undefined', () => {
  const props = {
    sessionId: 'session-test',
    useProjection: (key) => (key === 'sessionStats' ? stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings }, timeline }),
    useSession: {},
    t: zh
  }
  const tree = T.UsageView(props)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'ut-root')
  const texts = []
  collectStrings(tree, texts)
  assert.ok(texts.length > 40, '渲染出的文本节点太少，可能没渲染出卡片：' + texts.length)
  const bad = texts.filter((text) => /NaN|undefined|\[missing:/.test(text))
  assert.deepEqual(bad, [], '上屏文本里有脏值')
  assert.ok(texts.includes('时间统计') === false, 'tab 名不该出现在卡面里')
  assert.ok(texts.some((text) => text === '本会话概览'))
  assert.ok(texts.some((text) => text === '使用时间线'))
  assert.ok(texts.some((text) => text === '每小时分布'))
  assert.ok(texts.some((text) => text === '每轮用时排行'))
  assert.ok(texts.some((text) => text === '第 1 轮'))
})

test('T14b UsageView 空数据冒烟：走空态分支且无脏值', () => {
  const props = {
    sessionId: 'session-empty',
    useProjection: () => undefined,
    useChat: (selector) => selector({ legacy: {}, timeline: {} }),
    useSession: {},
    t: zh
  }
  const tree = T.UsageView(props)
  const texts = []
  collectStrings(tree, texts)
  assert.ok(texts.includes('暂无数据'))
  assert.ok(texts.filter((text) => /NaN|undefined|\[missing:/.test(text)).length === 0)
  assert.ok(!texts.includes('使用时间线'), '没有轮次时不该显示甘特卡')
})

test('T14c 座位缺失 / 座位抛异常都不许崩', () => {
  const noSeat = T.UsageView({ sessionId: 's', t: zh })
  const texts = []
  collectStrings(noSeat, texts)
  assert.ok(texts.includes('暂无数据'))
  const throwy = T.UsageView({
    sessionId: 's',
    t: zh,
    useProjection: () => { throw new Error('boom') },
    useChat: () => { throw new Error('boom') }
  })
  const texts2 = []
  collectStrings(throwy, texts2)
  assert.ok(texts2.includes('暂无数据'))
})

// ---------------------------------------------------------------- T15 apply

test('T15 apply：注册参数正确（id/order/name/locale/label 跟语言）', () => {
  let registered = null
  let injectedName = null
  const ctx = {
    locale: {
      register: (ns, dicts) => {
        assert.equal(ns, 'dsh-usage-tab')
        assert.ok(dicts.zh && dicts.en)
        return () => {}
      },
      bind: (ns) => (key) => 'T:' + key
    },
    slots: {
      inject: (name, factory) => {
        injectedName = name
        factory() // 它内部会调 register；断言看 register 收到的东西，别被返回值覆盖
        return () => {}
      },
      register: (options, component) => {
        registered = { options, component }
        return () => {}
      }
    }
  }
  const dispose = T.apply(ctx)
  assert.equal(injectedName, 'conversation.view')
  assert.equal(registered.options.name, 'conversation.view')
  assert.equal(registered.options.id, 'usage')
  assert.equal(registered.options.order, 30, 'order 必须 > 20 才排在「上下文」右边')
  assert.equal(registered.options.locale, 'dsh-usage-tab')
  assert.equal(typeof registered.options.label, 'function')
  assert.equal(registered.options.label(), 'T:tab', 'label 必须走 locale（跟语言切换）')
  assert.equal(typeof registered.component, 'function')
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('T15b apply 降级：locale 不可用 ⇒ 静态中文 label 且不声明 locale', () => {
  let options = null
  const ctx = {
    slots: {
      inject: (name, factory) => { factory(); return () => {} },
      register: (opts) => { options = opts; return () => {} }
    }
  }
  assert.doesNotThrow(() => T.apply(ctx))
  assert.equal(options.locale, undefined, '字典没注册成功就不该声明 locale 命名空间')
  assert.equal(options.label(), '时间统计')
})

test('T15c apply 降级：slots 缺失 / locale 抛错都不许抛出去', () => {
  assert.doesNotThrow(() => T.apply({}))
  assert.doesNotThrow(() => T.apply(null))
  const ctx = {
    locale: {
      register: () => { throw new Error('locale broken') },
      bind: () => { throw new Error('locale broken') }
    },
    slots: {
      inject: () => () => {},
      register: () => () => {}
    }
  }
  let dispose = null
  assert.doesNotThrow(() => { dispose = T.apply(ctx) })
  assert.equal(typeof dispose, 'function')
})

// ---------------------------------------------------------------- T16 CSS

test('T16 CSS：零硬编码配色，全走宿主 token', () => {
  const css = T.CSS
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 里不许出现十六进制色值')
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(css), 'CSS 里不许出现 rgb()/hsl()')
  // 注意先剔除 `white-space`（布局属性，与颜色同名，是词法碰撞不是违规）。
  const colorScan = css.replace(/white-space/gi, '')
  const named = colorScan.match(/(^|[^-\w])(white|black|red|green|blue|gray|grey|orange|yellow|purple)(?![\w-])/i)
  assert.equal(named, null, 'CSS 里不许出现具名颜色: ' + (named === null ? '' : named[0]))
  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-border-l2', '--dsw-alias-brand-primary']) {
    assert.ok(css.includes(token), '缺少宿主 token: ' + token)
  }
  // P1-fix：口径标签（.ut-card-tag）必须低调——tertiary + 11px，且**不带 margin**：
  // 它放在 .ut-card-title 的 flex 行里，若复用 .ut-card-sub（带 margin-bottom:10px）会把标题行撑歪。
  assert.ok(/\.ut-card-tag\{[^}]*color:var\(--dsw-alias-label-tertiary\)/.test(css), '口径标签必须用 label-tertiary')
  assert.ok(/\.ut-card-tag\{[^}]*font-size:11px/.test(css), '口径标签必须 11px 小字号')
  assert.ok(!/\.ut-card-tag\{[^}]*margin/.test(css), '口径标签不该带 margin（会撑高标题行）')
})

test('T16b CSS：规格要求的骨架数值（13px / 16px 20px 32px / 10px 圆角 / 600 字重）', () => {
  const css = T.CSS
  assert.ok(css.includes('font-size:13px'))
  assert.ok(css.includes('padding:16px 20px 32px'))
  assert.ok(/\.ut-card\{[^}]*border-radius:10px/.test(css), '卡片必须 10px 圆角')
  assert.ok(/\.ut-card\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/.test(css), '卡片底必须是 bg-layer-1')
  assert.ok(/\.ut-card\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(css), '卡片边框必须是 1px solid border-l2')
  assert.ok(/\.ut-card-title\{[^}]*font-weight:600/.test(css), '卡片标题必须 600 字重')
})

// ---------------------------------------------------------------- T17/T18 口径标注

/** T18 用的 props 夹具（三条通道都有数据）。 */
function viewProps (overrides) {
  return Object.assign({
    sessionId: 'session-test',
    useProjection: (key) => (key === 'sessionStats' ? stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings }, timeline }),
    useSession: {},
    t: zh
  }, overrides || {})
}

test('T17 口径标注：KPI 标「全日志」，甘特标「已加载窗口：第 N~M 轮」', () => {
  const model = T.buildModel({ stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS }, zh)
  const labels = Object.fromEntries(model.kpis.map((kpi) => [kpi.key, kpi.label]))
  assert.ok(labels.turns.includes('全日志'), '轮次标签必须写明全日志口径，实际：' + labels.turns)
  assert.ok(labels.steps.includes('全日志'), '步数标签必须写明全日志口径，实际：' + labels.steps)
  // 其余 KPI 是窗口口径（挂钟 / 活跃 / 空闲率 / 首条都来自 turnTimings）⇒ 不许被标成全日志
  for (const key of ['wall', 'active', 'idleRate', 'first']) {
    assert.ok(!labels[key].includes('全日志'), key + ' 是窗口口径，不该标全日志：' + labels[key])
  }
  assert.equal(model.ganttWindowText, '仅显示已加载窗口：第 0~2 轮')
  // 乱序 turn 也要取到正确极值（不是"第一个 / 最后一个"）
  const shuffled = new Map([
    [5, { startTime: baseTs + 10000000, endTime: baseTs + 10001000 }],
    [2, { startTime: baseTs, endTime: baseTs + 1000 }],
    [9, { startTime: baseTs + 1000, endTime: baseTs + 2000 }]
  ])
  assert.equal(T.buildModel({ turnTimings: shuffled }, zh).ganttWindowText, '仅显示已加载窗口：第 2~9 轮')
  // 没有轮次 ⇒ 空串（不是 undefined / NaN / 半截文案）
  assert.equal(T.buildModel({}, zh).ganttWindowText, '')
  assert.equal(T.buildModel({ stats }, zh).ganttWindowText, '', '只有 sessionStats 时窗口范围无意义，必须为空串')
  assertClean(model, 'model(window)')
  assertClean(T.buildModel({}, zh), 'model(empty-window)')
})

test('T17b 两个口径的数各来自各自的源（窗口步数 ≠ 全日志步数）', () => {
  const mismatched = Object.assign({}, stats, { steps: 999, turns: 42 })
  const model = T.buildModel({ stats: mismatched, turnTimings, timeline }, zh)
  // 全日志口径：直接来自 sessionStats
  assert.equal(model.kpis.find((kpi) => kpi.key === 'steps').value, '999')
  assert.equal(model.kpis.find((kpi) => kpi.key === 'turns').value, '42')
  // 窗口口径：来自 timeline / turnTimings，**不**跟着 sessionStats 跑
  assert.equal(model.totals.totalSteps, 4, '汇总步数必须来自 timeline（窗口口径）')
  assert.equal(model.gantt.length, 3)
  assert.equal(model.ganttWindowText, '仅显示已加载窗口：第 0~2 轮')
  assertClean(model, 'model(mismatch)')
})

test('T18 口径脚注真的渲染进卡面（"写了却没显示"的回归断言）', () => {
  const tree = T.UsageView(viewProps())
  const footers = findNodes(tree, (node) => node.props && node.props['data-usage-role'] === 'source-note')
  assert.equal(footers.length, 1, '口径脚注必须渲染，且只渲染一次')
  assert.equal(footers[0].props.className, 'ut-source')
  // 只扫 children（props 里的 className / key / data-* 也是字符串，会污染计数）
  const footerTexts = []
  collectStrings(footers[0].children, footerTexts)
  assert.equal(footerTexts.length, 1, '脚注就一段文字，实际：' + JSON.stringify(footerTexts))
  assert.ok(footerTexts[0].includes('sessionStats'), '脚注必须点出全日志那一侧来源')
  assert.ok(footerTexts[0].includes('已加载窗口'), '脚注必须点出窗口那一侧口径')
  assert.ok(footerTexts[0].includes('不可相加'), '脚注必须明确两个口径不能相加')
  // 位置：必须是卡片列表的**最后一项**（「tab 内容最底部做页脚注」）
  const cards = tree.children[0]
  assert.ok(Array.isArray(cards), 'ut-root 的 children 应是一组卡片')
  assert.equal(cards[cards.length - 1].props['data-usage-role'], 'source-note', '脚注必须在最底部')
})

test('T18b 每小时卡片：写「已加载窗口 N 步」，不再出现「本会话共 N 步」', () => {
  const texts = []
  collectStrings(T.UsageView(viewProps()), texts)
  const sum = texts.find((text) => text.includes('步，累计活跃'))
  assert.ok(sum, '找不到每小时卡片的汇总文案')
  assert.ok(sum.startsWith('已加载窗口 '), '必须以「已加载窗口」开头，实际：' + sum)
  assert.ok(!texts.some((text) => text.includes('本会话共')), '不许再出现与全日志 KPI 打架的「本会话共 N 步」')
  // 甘特标题行的窗口范围也要真的上屏
  assert.ok(texts.includes('仅显示已加载窗口：第 0~2 轮'),
    '甘特卡标题必须带窗口范围，实际含「窗口」的文本：' + JSON.stringify(texts.filter((text) => text.includes('窗口'))))
})

// ---------------------------------------------------------------- T19 二级菜单（P1.1）

/** 假 localStorage：够用的 getItem/setItem；boom=true 时两个方法都抛（模拟隐私模式）。 */
function fakeStorage (seed, boom) {
  const store = Object.assign({}, seed || {})
  return {
    store,
    getItem (key) {
      if (boom) throw new Error('boom')
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    },
    setItem (key, value) {
      if (boom) throw new Error('boom')
      store[key] = String(value)
    }
  }
}

function textsOf (node) { const out = []; collectStrings(node, out); return out }

test('T19 二级分段：导航在内容最顶部、分段齐全、默认选中「概览」', () => {
  const tree = T.UsageView(viewProps())
  const cards = tree.children[0]
  assert.ok(Array.isArray(cards), 'ut-root 的 children 应是一组节点')
  assert.equal(cards[0].props['data-usage-role'], 'subnav', '分段导航必须是内容第一项')
  assert.equal(cards[0].props.className, 'ut-seg ut-seg-main')
  // 实测：容器与被装项语义必须成套（tablist 里装的必须是 role=tab）
  assert.equal(cards[0].props.role, 'tablist', '分段导航容器必须是 role=tablist')
  assert.equal(cards[0].props['aria-label'], '时间统计分段', 'tablist 必须有可访问名')
  const btns = findNodes(cards[0], (n) => n.props && n.props['data-usage-role'] === 'seg-btn')
  assert.deepEqual(btns.map((b) => b.props['data-value']), [...T.SEGMENT_KEYS], '分段顺序')
  // ⚠️ 一律从 SEGMENT_KEYS 派生（写死 4 个的写法已被 A7 加分段坑过一次）
  assert.deepEqual(btns.map((b) => b.props['data-group']), T.SEGMENT_KEYS.map(() => 'subnav'))
  assert.deepEqual(btns.map((b) => b.props.role), T.SEGMENT_KEYS.map(() => 'tab'),
    'tablist 的子项必须是 role=tab（不能是裸 button）')
  assert.deepEqual(btns.map((b) => b.props['aria-selected']),
    T.SEGMENT_KEYS.map((k, i) => (i === 0 ? 'true' : 'false')), '默认选中概览')
  assert.deepEqual(btns.map((b) => b.props['aria-pressed']), T.SEGMENT_KEYS.map(() => undefined),
    'role=tab 不支持 aria-pressed，不许再挂（选中态一律看 aria-selected）')
  assert.ok(btns[0].props.className.includes('ut-seg-on'), '选中态必须挂 ut-seg-on')
  assert.ok(btns.slice(1).every((b) => !b.props.className.includes('ut-seg-on')))
  // 只扫按钮的 children（props 里的 title 也是同一个词，扫整棵树会重复计数）
  assert.deepEqual(btns.map((b) => textsOf(b.children).join('')), ['概览', '日历', '会话', 'K 线', '设置'],
    '分段文案与顺序')
  // 默认分段 = 概览 ⇒ P1 原有四张卡 + 最底部口径脚注都还在（P1 回归不许破）
  assert.equal(cards[cards.length - 1].props['data-usage-role'], 'source-note', '脚注仍在最底部')
  const titles = []
  for (const card of cards) {
    if (!card || !card.props || card.props.className !== 'ut-card') continue
    const texts = findNodes(card, (n) => n.props && n.props.className === 'ut-card-title-text')
      .map((n) => textsOf(n.children).join(''))
    titles.push(texts[0])
  }
  assert.deepEqual(titles,
    ['本会话概览', '使用时间线', '步骤时间线', '每小时分布', '时间构成（全日志）', '时段分布', '每轮用时排行'],
    '概览 = P1 四张卡 + 2026-10-14 追加的「步骤时间线」「时间构成」「时段分布」')
})

test('T19b 分段派发：4 个分段都有正文、未知 key 回退概览、无脏值', () => {
  const model = T.buildModel({ stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS }, zh)
  for (const key of T.SEGMENT_KEYS) {
    const body = T.renderSegment(key, model, zh, () => {})
    assert.ok(Array.isArray(body) && body.length > 0, key + ' 分段没有正文')
    const texts = textsOf(body)
    assert.ok(texts.length > 0, key + ' 分段没有文本')
    assert.deepEqual(texts.filter((x) => /NaN|undefined|\[missing:/.test(x)), [], key + ' 正文里有脏值')
  }
  assert.ok(textsOf(T.renderSegment('nope', model, zh, null)).includes('本会话概览'), '未知 key 必须回退概览')
  assert.ok(textsOf(T.renderSegment(undefined, model, zh, null)).includes('本会话概览'), 'undefined 也要回退概览')
  for (const key of ['calendar', 'sessions', 'settings']) {
    const hits = findNodes(T.renderSegment(key, model, zh, null),
      (n) => n.props && n.props['data-usage-role'] === 'source-note')
    assert.equal(hits.length, 0, key + ' 分段不该出现概览脚注')
  }
})

test('T19c 日历 / 会话 = 骨架 + 空态 + 「P2 接宿主级全历史数据后填充」', () => {
  const model = T.buildModel({ stats, turnTimings, timeline }, zh)
  const cal = T.renderSegment('calendar', model, zh, null)
  const calTexts = textsOf(cal)
  for (const label of ['按天热力图', '每日时长柱状', '今日', '本周', '本月', '最长', '平均', '段数']) {
    assert.ok(calTexts.includes(label), '日历骨架缺行：' + label)
  }
  assert.ok(calTexts.includes('P2 接宿主级全历史数据后填充'), '日历必须标 P2')
  const calSkel = findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton')
  assert.equal(calSkel.length, 1, '日历必须有且只有一个骨架')
  assert.equal(findNodes(calSkel[0], (n) => n.props && n.props.className === 'ut-skel-row').length, 8, '日历骨架 8 行数据')
  assert.equal(findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'p2-tag').length, 1)
  const ses = T.renderSegment('sessions', model, zh, null)
  const sesTexts = textsOf(ses)
  for (const label of ['近期最常用会话', '会话时长排行', '工作区 · 项目时间分布']) {
    assert.ok(sesTexts.includes(label), '会话骨架缺行：' + label)
  }
  assert.ok(sesTexts.includes('P2 接宿主级全历史数据后填充'), '会话必须标 P2')
  const sesVals = findNodes(ses, (n) => n.props && n.props.className === 'ut-skel-val')
  assert.equal(sesVals.length, 3)
  assert.deepEqual(sesVals.map((v) => textsOf(v.children).join('')), ['—', '—', '—'], '空态值必须是 —，不是 0')
})

test('T19d 设置：默认值上屏（5 分钟 / Asia/Shanghai / 本会话）+ 口径说明', () => {
  const model = T.buildModel({ stats, turnTimings, timeline }, zh)
  const body = T.renderSegment('settings', model, zh, null)
  const texts = textsOf(body)
  assert.ok(texts.includes('5 分钟'), '默认空闲阈值必须上屏：' + JSON.stringify(texts.slice(0, 24)))
  assert.ok(texts.includes('Asia/Shanghai'), '默认时区必须上屏')
  assert.ok(texts.includes('本会话') && texts.includes('全历史'), '数据范围两个选项都要在')
  assert.ok(texts.includes('口径说明'), '必须有口径说明卡')
  assert.ok(texts.some((x) => x.includes(T.PREF_KEY)), '必须写清存储键名')
  assert.ok(texts.some((x) => x.includes('静默回退默认值')), '必须写清读取失败的回退口径')
  const note = findNodes(body, (n) => n.props && n.props['data-usage-role'] === 'caliber-note')
  assert.equal(note.length, 1, '口径说明必须复用 source.note 且只渲染一次')
  const noteText = textsOf(note[0].children).join('')
  assert.ok(noteText.includes('sessionStats') && noteText.includes('已加载窗口') && noteText.includes('不可相加'))
  // 三个偏好组：各自恰有一个选中项，且默认值正确
  for (const group of ['pref.idle', 'pref.timezone', 'pref.scope']) {
    const btns = findNodes(body, (n) => n.props && n.props['data-group'] === group)
    assert.ok(btns.length >= 2, group + ' 至少两个候选，实际：' + btns.length)
    assert.equal(btns.filter((b) => b.props['aria-pressed'] === 'true').length, 1, group + ' 必须恰有一个选中')
  }
  const pickOn = (group) => findNodes(body, (n) => n.props && n.props['data-group'] === group)
    .filter((b) => b.props['aria-pressed'] === 'true')[0]
  assert.equal(pickOn('pref.idle').props['data-value'], '5', '默认空闲阈值 5 分钟')
  assert.equal(pickOn('pref.timezone').props['data-value'], 'Asia/Shanghai')
  assert.equal(pickOn('pref.scope').props['data-value'], 'session')
  // 未选「全历史」⇒ 不该有 pending 提示；选了 ⇒ 必须提示
  assert.equal(findNodes(body, (n) => n.props && n.props['data-usage-role'] === 'scope-pending').length, 0)
  const all = T.renderSegment('settings', T.buildModel({ prefs: { scope: 'all' } }, zh), zh, null)
  const pending = findNodes(all, (n) => n.props && n.props['data-usage-role'] === 'scope-pending')
  assert.equal(pending.length, 1, '选「全历史」必须给出 P2 提示')
  assert.ok(textsOf(pending[0].children).join('').includes('全历史'))
})

test('T19e 偏好读写：默认 / 坏值回退 / 落盘读回 / storage 抛错都不崩', () => {
  assert.deepEqual(T.normalizePrefs(null), T.DEFAULT_PREFS)
  assert.deepEqual(T.normalizePrefs(''), T.DEFAULT_PREFS)
  assert.deepEqual(T.normalizePrefs('{oops'), T.DEFAULT_PREFS)
  assert.deepEqual(T.normalizePrefs('42'), T.DEFAULT_PREFS)
  assert.deepEqual(T.normalizePrefs({ idleMinutes: NaN, timezone: 7, scope: 'nope' }), T.DEFAULT_PREFS)
  // ⚠️ 期望值一律从 `DEFAULT_PREFS` 派生（P2 第三步起偏好多了三个「会话」页字段）：
  // 这样"以后再加字段"不会破这条，但"哪个字段的值不对"仍然断言得死。
  assert.deepEqual(T.normalizePrefs({ idleMinutes: '7' }), Object.assign({}, T.DEFAULT_PREFS, { idleMinutes: 5 }))
  assert.deepEqual(T.normalizePrefs({ idleMinutes: 7 }), Object.assign({}, T.DEFAULT_PREFS, { idleMinutes: 7 }))
  // 「会话」页三个偏好：不在白名单 / 类型错 ⇒ 逐字段回退默认；合法值照收（数字串也吃）
  assert.deepEqual(T.normalizePrefs({ sesView: 'z', sesWindow: 99, sesWorkspace: 7 }), T.DEFAULT_PREFS)
  assert.deepEqual(T.normalizePrefs({ sesView: 'b', sesWindow: '30', sesWorkspace: 'D:\\Work\\ws' }),
    Object.assign({}, T.DEFAULT_PREFS, { sesView: 'b', sesWindow: 30, sesWorkspace: 'D:\\Work\\ws' }))
  assert.equal(T.idleMsOf({ idleMinutes: 30 }), 1800000)
  assert.equal(T.idleMsOf({ idleMinutes: NaN }), T.IDLE_THRESHOLD_MS, '坏值必须回退 5 分钟')
  assert.equal(T.PREF_KEY, 'dsh-usage-tab.prefs', '键名必须带插件前缀')
  // 落盘 → 读回
  const box = fakeStorage()
  assert.equal(T.writePrefs(box, { idleMinutes: 15, timezone: 'UTC', scope: 'all' }), true)
  assert.deepEqual(Object.keys(box.store), [T.PREF_KEY], '只许写这一个键')
  assert.deepEqual(T.readPrefs(box), Object.assign({}, T.DEFAULT_PREFS, { idleMinutes: 15, timezone: 'UTC', scope: 'all' }))
  // 被手工改坏 ⇒ 逐字段回退
  box.store[T.PREF_KEY] = '{not json'
  assert.deepEqual(T.readPrefs(box), T.DEFAULT_PREFS)
  box.store[T.PREF_KEY] = JSON.stringify({ idleMinutes: -3, timezone: '', scope: 'all' })
  assert.deepEqual(T.readPrefs(box), Object.assign({}, T.DEFAULT_PREFS, { scope: 'all' }))
  // storage 整个抛错 / 形状不对 ⇒ 静默回退，不抛
  const boom = fakeStorage(null, true)
  assert.deepEqual(T.readPrefs(boom), T.DEFAULT_PREFS)
  assert.equal(T.writePrefs(boom, { idleMinutes: 5 }), false)
  assert.deepEqual(T.readPrefs({}), T.DEFAULT_PREFS)
  assert.deepEqual(T.readPrefs({ getItem: null }), T.DEFAULT_PREFS)
  assert.deepEqual(T.readPrefs(undefined), T.DEFAULT_PREFS)
})

test('T19f 偏好真的进模型：空闲阈值 1 分钟 ⇒ 活跃段跟着变', () => {
  const gap = new Map([
    [0, { startTime: baseTs, endTime: baseTs + 60000 }],
    [1, { startTime: baseTs + 180000, endTime: baseTs + 240000 }] // 与上一轮间隔 2 分钟
  ])
  const wide = T.buildModel({ turnTimings: gap }, zh)                         // 默认 5 分钟
  const tight = T.buildModel({ turnTimings: gap, prefs: { idleMinutes: 1 } }, zh)
  assert.equal(wide.totals.segmentCount, 1, '5 分钟口径：2 分钟间隔不切断')
  assert.equal(tight.totals.segmentCount, 2, '1 分钟口径：2 分钟间隔必须切断')
  // 活跃时长要看 summarizeUsage（= 各段之和）：并成 1 段时把中间的空闲也算了进去
  const wideSum = T.summarizeUsage(T.collectTurnSpans(gap, null), T.idleMsOf({ idleMinutes: 5 }))
  const tightSum = T.summarizeUsage(T.collectTurnSpans(gap, null), T.idleMsOf({ idleMinutes: 1 }))
  assert.equal(wideSum.activeMs, 240000, '并成 1 段 ⇒ 活跃时长含中间空闲')
  assert.equal(tightSum.activeMs, 120000, '断成 2 段 ⇒ 活跃时长只算两段')
  // 注意：model.totals.totalActiveMs 是「各轮时长按小时落桶之和」（与活跃段无关），两种口径都是 2 分钟
  assert.equal(wide.totals.totalActiveMs, 120000)
  // 显式 idleMs 优先（既有调用方 / 自测的入参契约不许被偏好顶掉）
  const explicit = T.buildModel({ turnTimings: gap, idleMs: 60000, prefs: { idleMinutes: 30 } }, zh)
  assert.equal(explicit.totals.segmentCount, 2)
})

test('T19g 端到端：localStorage 里的偏好真的改变 UsageView 的渲染', () => {
  const gap = new Map([
    [0, { startTime: baseTs, endTime: baseTs + 60000 }],
    [1, { startTime: baseTs + 180000, endTime: baseTs + 240000 }]
  ])
  const props = viewProps({ useChat: (selector) => selector({ legacy: { turnTimings: gap }, timeline: {} }) })
  const box = fakeStorage()
  box.store[T.PREF_KEY] = JSON.stringify({ idleMinutes: 1, timezone: 'UTC', scope: 'all' })
  globalThis.localStorage = box
  try {
    const texts = textsOf(T.UsageView(props))
    assert.ok(texts.some((x) => x.includes('活跃段 2')),
      '1 分钟口径 ⇒ 2 段；实际：' + JSON.stringify(texts.filter((x) => x.includes('活跃段'))))
  } finally {
    delete globalThis.localStorage
  }
  // 拔掉 localStorage（= 默认 5 分钟口径）⇒ 1 段
  const texts2 = textsOf(T.UsageView(props))
  assert.ok(texts2.some((x) => x.includes('活跃段 1')),
    '默认 5 分钟口径 ⇒ 1 段；实际：' + JSON.stringify(texts2.filter((x) => x.includes('活跃段'))))
})

// ---------------------------------------------------------------- 独立审查的回归断言

test('T19h 空闲阈值：先归一化再校验，绝不产出 0 分钟 / Infinity', () => {
  const idle = (v) => T.normalizePrefs({ idleMinutes: v }).idleMinutes
  const D = T.DEFAULT_PREFS.idleMinutes
  // ① 合法整数：原样保留（既有契约不许被这次修复改掉）
  for (const n of [1, 2, 3, 5, 7, 60, 1440]) assert.equal(idle(n), n, n + ' 分钟必须保留')
  // ② round **之后**才校验：0.4 → Math.round(0.4) = 0 ⇒ 非法 ⇒ 回退默认 5
  assert.equal(idle(0), D, '0 必须回退')
  assert.equal(idle(0.4), D, '🩸 0.4 分钟 round 后 = 0，必须回退默认值（旧 bug：被接受成 0 分钟 ⇒ idleMs=0）')
  assert.equal(idle(0.49), D, '0.49 同样 round 成 0 ⇒ 回退')
  assert.equal(idle(-1), D, '负数回退')
  assert.equal(idle(NaN), D, 'NaN 回退')
  assert.equal(idle(Infinity), D, 'Infinity 回退')
  // ③ round 后 ≥ 1 的才是合法（0.5 向上取整成 1）
  assert.equal(idle(0.5), 1, '0.5 分钟 round 后 = 1，合法')
  assert.equal(idle(1.5), 2)
  assert.equal(idle(2.4), 2)
  // ④ 字符串不是数字（numOf 只认 number）⇒ 回退，既有契约不变
  assert.equal(idle('7'), D)
  // ⑤ 上界 = 1440（24h）；越界 / 溢出 ⇒ 回退（旧 bug：1e308 * 60000 = Infinity）
  assert.equal(idle(1440), 1440, '1440 分钟（24h）是上界本身，合法')
  assert.equal(idle(1441), D, '越界回退（不是 clamp）')
  assert.equal(idle(1e308), D, '🩸 1e308 必须回退')
  assert.equal(T.idleMsOf({ idleMinutes: 1e308 }), T.IDLE_THRESHOLD_MS, '绝不产出 Infinity，必须回退 5 分钟毫秒数')
  assert.ok(Number.isFinite(T.idleMsOf({ idleMinutes: 1440 })), '上界内的 idleMs 必须有限')
  assert.ok(Number.isFinite(T.idleMsOf({ idleMinutes: 0.4 })), '0.4 归一化后也必须有限')
  // ⑥ 界面自洽：候选里绝不许出现 "0"，显示值绝不许是「0 分钟」（旧 bug 的界面症状）
  for (const raw of [0.4, 0, -1, 1e308]) {
    const model = T.buildModel({ prefs: { idleMinutes: raw } }, zh)
    assert.equal(model.settings.idleOptions.filter((o) => o.value === '0').length, 0,
      raw + '：候选里绝不许出现 "0"（点了会 Number("0")=0 又回退 5，界面自相矛盾）')
    assert.equal(model.settings.idleText, '5 分钟', raw + ' 必须显示成默认「5 分钟」')
    assert.equal(Object.keys(model.settings.prefs).length, Object.keys(T.DEFAULT_PREFS).length,
      'prefs 必须是字段齐全的规范对象（字段增多时这条跟着走，但"缺字段"照样红）')
    assertClean(model.settings, 'settings(' + raw + ')')
  }
  // ⑦ 同一份两轮数据（间隔 2 分钟）：0.4 与默认口径必须给同一个 segmentCount（旧 bug：1 vs 2）
  const gap = new Map([
    [0, { startTime: baseTs, endTime: baseTs + 60000 }],
    [1, { startTime: baseTs + 180000, endTime: baseTs + 240000 }]
  ])
  assert.equal(T.buildModel({ turnTimings: gap, prefs: { idleMinutes: 0.4 } }, zh).totals.segmentCount, 1,
    '🩸 0.4 回退默认 5 分钟 ⇒ 2 分钟间隔不许切断（活跃段/空闲率口径必须与默认一致）')
  assert.equal(T.buildModel({ turnTimings: gap, prefs: { idleMinutes: 1e308 } }, zh).totals.segmentCount, 1,
    '1e308 回退默认 ⇒ 同上')
  // ⑧ buildModel 的显式 idleMs 同样不许溢出（同源通路）
  assert.equal(T.buildModel({ turnTimings: gap, idleMs: 1e308 }, zh).totals.segmentCount, 1,
    '显式 idleMs 溢出必须退回 prefs 口径')
  assert.equal(T.buildModel({ turnTimings: gap, idleMs: 60000 }, zh).totals.segmentCount, 2,
    '显式合法 idleMs 仍然优先（既有契约）')
  // 🩸 独立审查残留：显式 idleMs 之前只挡上界、漏了下界 ⇒ idleMs=0 被接受（每轮都断开），
  // 而设置段仍显示 prefs 的「5 分钟」⇒ 界面与实际口径不一致（同源形态）。
  assert.equal(T.buildModel({ turnTimings: gap, idleMs: 0 }, zh).totals.segmentCount, 1,
    '🩸 显式 idleMs=0 属越界 ⇒ 必须回退 prefs 口径，不许出现"设置说 5 分钟、实际按 0 断开"')
  assert.equal(T.buildModel({ turnTimings: gap, idleMs: -1 }, zh).totals.segmentCount, 1,
    '显式 idleMs 负数同样回退')
})

test('T19i 时区：Intl 真校验 + 限长，非法静默回退 Asia/Shanghai', () => {
  const zone = (v) => T.normalizePrefs({ timezone: v }).timezone
  const D = T.DEFAULT_PREFS.timezone
  // ① 合法 IANA 名 ⇒ 原样保留（含 UTC；Intl 大小写不敏感，但我们不做规范化改写）
  for (const z of ['Asia/Shanghai', 'UTC', 'Europe/London', 'America/New_York', 'Etc/GMT+8', 'utc']) {
    assert.equal(zone(z), z, z + ' 是合法时区，必须保留')
  }
  // ② 非法（不存在的 zone / 控制字符 / 超长 / 空 / 类型错）⇒ 静默回退默认值
  const bad = ['Not/AZone', 'Invalid/Zone', 'Aeroport', 'GMT+999', 'X\n\t\u0000Y', '  ',
    'A'.repeat(65), 'A'.repeat(1e6), '', 7, null, undefined, { zone: 'UTC' }, ['UTC']]
  for (const z of bad) {
    assert.equal(zone(z), D, '🩸 ' + JSON.stringify(String(z).slice(0, 24)) + ' 必须回退默认时区')
  }
  // ③ 界面：非法时区绝不许上屏、绝不许进候选（旧 bug：'Not/AZone' 被选中上屏）
  for (const z of ['Not/AZone', 'A'.repeat(1e6), 'X\n\t\u0000Y']) {
    const model = T.buildModel({ prefs: { timezone: z } }, zh)
    assert.equal(model.settings.timezone, D, '非法时区不许进 settings.timezone')
    assert.ok(!model.settings.tzOptions.some((o) => o.value === z), '非法时区绝不许进候选列表')
    assert.equal(model.settings.tzOptions.filter((o) => o.active === true).length, 1, '必须有且只有一个选中项')
    assertClean(model.settings, 'settings.tz')
  }
  // ④ 合法但罕见的时区仍要能"补进候选并被选中"（既有契约：界面显示值 == 真正生效值）
  const rare = T.buildModel({ prefs: { timezone: 'Etc/GMT+8' } }, zh)
  assert.equal(rare.settings.timezone, 'Etc/GMT+8')
  assert.ok(rare.settings.tzOptions.some((o) => o.value === 'Etc/GMT+8' && o.active === true), '罕见合法时区必须能选中')
  // ⑤ 落盘 → 读回：非法时区不许被写进 localStorage 后又被当成合法值读回
  const box = fakeStorage()
  assert.equal(T.writePrefs(box, { idleMinutes: 5, timezone: 'Not/AZone', scope: 'session' }), true)
  assert.equal(JSON.parse(box.store[T.PREF_KEY]).timezone, D, '写盘前必须已归一化')
  assert.equal(T.readPrefs(box).timezone, D)
})

test('T19j ARIA：subnav=tablist/tab/aria-selected，三个偏好组有可访问名', () => {
  const cards = T.UsageView(viewProps()).children[0]
  const nav = cards[0]
  assert.equal(nav.props.role, 'tablist')
  assert.equal(nav.props['aria-label'], '时间统计分段')
  const btns = findNodes(nav, (n) => n.props && n.props['data-usage-role'] === 'seg-btn')
  assert.equal(btns.length, T.SEGMENT_KEYS.length, '分段数 = SEGMENT_KEYS')
  assert.deepEqual(btns.map((b) => b.props.role), T.SEGMENT_KEYS.map(() => 'tab'), '子项必须是 tab')
  assert.deepEqual(btns.map((b) => b.props['aria-selected']),
    T.SEGMENT_KEYS.map((k, i) => (i === 0 ? 'true' : 'false')), '默认选中第一段')
  assert.deepEqual(btns.map((b) => b.props['aria-pressed']), T.SEGMENT_KEYS.map(() => undefined),
    'role=tab 上不许有 aria-pressed')
  assert.deepEqual(btns.map((b) => b.props['data-value']), [...T.SEGMENT_KEYS], '补齐 ARIA 不许动顺序/取值')
  assert.deepEqual(btns.map((b) => b.props.className.split(' ')[0]), T.SEGMENT_KEYS.map(() => 'ut-seg-btn'),
    '实际 className = ' + JSON.stringify(btns.map((b) => b.props.className)))
  // 设置里的三个偏好组：role=group + aria-label（用现有 i18n 词条），语义仍是按压按钮
  const body = T.renderSegment('settings', T.buildModel({ stats, turnTimings, timeline }, zh), zh, null)
  const isPrefGroup = (n) => n.props && typeof n.props['data-usage-role'] === 'string' &&
    n.props['data-usage-role'].indexOf('pref.') === 0
  const groups = findNodes(body, isPrefGroup)
  assert.deepEqual(groups.map((g) => g.props['data-usage-role']),
    ['pref.idle', 'pref.timezone', 'pref.scope', 'pref.goal'],
    '实际 = ' + JSON.stringify(groups.map((g) => g.props['data-usage-role'])))
  assert.deepEqual(groups.map((g) => g.props.role), ['group', 'group', 'group', 'group'], '偏好组仍是 role=group')
  assert.deepEqual(groups.map((g) => g.props['aria-label']), ['空闲阈值', '时区', '数据范围', '每周目标'],
    '🩸 role=group 必须带 aria-label · 实际 roles=' + JSON.stringify(groups.map((g) => g.props['data-usage-role'])) +
    ' aria=' + JSON.stringify(groups.map((g) => g.props['aria-label'])))
  for (const g of groups) {
    const list = findNodes(g, (n) => n.props && n.props['data-usage-role'] === 'seg-btn')
    assert.ok(list.length >= 2, g.props['data-usage-role'] + ' 至少两个候选')
    assert.equal(list.filter((b) => b.props['aria-pressed'] === 'true').length, 1,
      g.props['data-usage-role'] + ' 恰一个按压选中')
    assert.deepEqual(list.map((b) => b.props.role), list.map(() => undefined), '偏好组里的按钮不挂 role=tab')
  }
  // en 词表也要有名字（词典完整性已由 T1 覆盖，这里只确认取到的是英文）
  const en = (key) => T.DICT_EN[key]
  const enBody = T.renderSegment('settings', T.buildModel({ stats, turnTimings, timeline }, en), en, null)
  const enGroups = findNodes(enBody, isPrefGroup)
  assert.deepEqual(enGroups.map((g) => g.props['aria-label']), ['Idle threshold', 'Time zone', 'Data range', 'Weekly goal'])
})

// ---------------------------------------------------------------- T20 宿主投影（P2 第一步）
// 被测对象：lib/index.mjs（零依赖，直接 import）。这里测的是**折叠语义与防御**，
// 不碰宿主服务；真正的"注册进宿主 / 随列表行下发"属实机确认范围。

const CAL_DAY = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime()
const hostEvent = (type, time, data) => ({ type, time, seq: 0, data: data === undefined ? {} : data })
const foldAll = (events) => {
  let state = HOST.initUsageDailyState()
  for (const event of events) state = HOST.foldUsageDaily(state, event)
  return state
}

test('T20 宿主定义：key/stateVersion/schema/init/wire 齐备（wire 缺了客户端就永远读不到）', () => {
  const def = HOST.usageDailyDefinition
  assert.equal(HOST.PROJECTION_KEY, 'usageDaily')
  assert.equal(HOST.PROJECTION_STATE_VERSION, 1)
  assert.equal(def.key, 'usageDaily', '不许撞官方 sessionStats / 别人家的 contextActivity')
  assert.equal(def.stateVersion, 1)
  assert.equal(typeof def.stateSchema.parse, 'function', '🩸 宿主裸调 stateSchema.parse，没有 .parse 会话第二次加载就 TypeError')
  assert.equal(typeof def.init, 'function')
  assert.equal(typeof def.apply, 'function')
  assert.ok(def.wire, '🩸 dsh-session-projection 里 `if (def.wire === void 0) continue` ⇒ 不写 wire 等于不自带下发')
  assert.equal(typeof def.wire.view, 'function')
  assert.equal(typeof def.wire.viewSchema.parse, 'function', '🩸 wire.viewSchema.parse 也是裸调用')
  assert.equal(typeof def.stateSchema['~standard'].validate, 'function')
  assert.equal(typeof def.wire.viewSchema['~standard'].validate, 'function')
  const state = def.init()
  assert.deepEqual(state, {
    days: {}, hoursByDay: {}, byTool: {}, toolShapes: {},
    byModel: {}, turnOutcomes: {}, compactions: 0, eventShapes: {},
    openToolName: null, openToolStart: null,
    activeMs: 0, turns: 0, segments: 0, longestMs: 0, lastTime: null, openStart: null
  })
  // init 的第二个参数（inheritedEventCount）故意不用：fork 靠 session/end-seed 标记识别。
  assert.deepEqual(def.init({}, 7), state)
})

test('T20b 宿主折叠：逐日活跃毫秒 / 总活跃 / 轮数 / 段数 / 最长段', () => {
  const day = HOST.dayKeyOf(CAL_DAY(2026, 9, 25, 10, 0))
  assert.equal(day, '2026-09-25', '按宿主本地时区分桶')
  const state = foldAll([
    hostEvent('turn/start', CAL_DAY(2026, 9, 25, 10, 0, 0)),
    hostEvent('step/start', CAL_DAY(2026, 9, 25, 10, 0, 30)),
    hostEvent('tool/result', CAL_DAY(2026, 9, 25, 10, 2, 0))
  ])
  assert.deepEqual(state.days, { '2026-09-25': 120000 }, '30s + 90s = 120s 全落今天')
  assert.equal(state.activeMs, 120000)
  assert.equal(state.turns, 1, 'turn/start 计一轮')
  assert.equal(state.segments, 1, '三条都在 5 分钟内 ⇒ 一段')
  assert.equal(state.longestMs, 120000)
  const view = HOST.usageDailyViewOf(state)
  assert.deepEqual(Object.keys(view).sort(),
    ['activeMs', 'byModel', 'byTool', 'compactions', 'days', 'eventShapes', 'hoursByDay', 'longestMs', 'segments', 'toolShapes', 'turnOutcomes', 'turns'])
  assert.equal(view.lastTime, undefined, '内部游标不许下发（列表行要瘦）')
  assert.equal(view.openStart, undefined)
  // A7 二期（2026-10-14 定稿）：日内小时桶 —— 与日桶**同源同切**（10:00:00→10:02:00 全落在 10 点这一小时）
  assert.deepEqual(state.hoursByDay, { '2026-09-25': { '10': 120000 } })
  assert.deepEqual(view.hoursByDay, { '2026-09-25': { '10': 120000 } })
})

test('T20c 宿主折叠：5 分钟阈值边界（恰好不断、多 1ms 断开）+ 跨午夜按本地时区切分', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0)
  const exact = foldAll([hostEvent('user/message', t0), hostEvent('user/message', t0 + 300000)])
  assert.equal(exact.segments, 1, '恰好 5 分钟 ⇒ 同一段')
  assert.equal(exact.days['2026-09-25'], 300000)
  const over = foldAll([hostEvent('user/message', t0), hostEvent('user/message', t0 + 300001)])
  assert.equal(over.segments, 2, '多 1ms ⇒ 断开')
  assert.equal(over.activeMs, 0, '断开的那一段不计毫秒（间隔本身不是活跃时间）')
  // 🩸 跨午夜：按 2026-09-25 定稿「跨午夜的活跃**按照时区算**（该是哪天就哪天）」
  // ⇒ 23:58 → 次日 00:01 的 3 分钟在**本地午夜切开、分别落两天**（旧写法整段记起点日，误差上界 5 分钟）。
  const before = CAL_DAY(2026, 9, 25, 23, 58)
  const after = before + 180000 // 次日 00:01
  const midnight = foldAll([hostEvent('user/message', before), hostEvent('user/message', after)])
  assert.deepEqual(midnight.days, { '2026-09-25': 120000, '2026-09-26': 60000 },
    '跨午夜切开：23:58→24:00 归 09-25（2 分钟）、00:00→00:01 归 09-26（1 分钟）')
  assert.equal(midnight.activeMs, 180000, '总量不变，只是分桶变了（不丢不重）')
  // 时钟回退（time 倒退）不许产出负数毫秒。
  const back = foldAll([hostEvent('user/message', t0 + 60000), hostEvent('user/message', t0)])
  assert.equal(back.activeMs, 0)
  assert.ok(back.activeMs >= 0 && Number.isFinite(back.activeMs))
})

test('T20d 宿主折叠：Object.is 门禁（不关心的事件必须返回同一引用）', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0)
  const state = foldAll([hostEvent('turn/start', t0), hostEvent('step/end', t0 + 10000)])
  const cases = [
    ['白名单外的事件类型（插件事件）', hostEvent('title/update', t0 + 9999999)],
    ['无时间戳', { type: 'turn/start', seq: 1, data: {} }],
    ['时间戳非有限数', hostEvent('turn/start', NaN)],
    ['时间戳是字符串', hostEvent('turn/start', '1790301720000')],
    ['事件不是对象', null],
    ['事件是字符串', 'nope'],
    ['非 inherited 的 resume 标记不算切点', hostEvent('session/end-seed', t0 + 5000, {})]
  ]
  for (const [label, event] of cases) {
    assert.equal(HOST.foldUsageDaily(state, event), state, label + '：必须返回同一引用（否则下游每个事件都被当成账变了）')
  }
  assert.equal(HOST.foldUsageDaily(null, hostEvent('turn/start', t0)), null, '坏状态原样返回，不抛')
})

test('T20e 宿主折叠：fork 继承切点清账重来 + 同毫秒合成 closers 不产生幻影段', () => {
  const parentDay = CAL_DAY(2026, 9, 20, 9, 0)
  const cut = CAL_DAY(2026, 9, 25, 10, 0)
  const parent = [
    hostEvent('turn/start', parentDay),
    hostEvent('assistant/message', parentDay + 240000),
    hostEvent('tool/result', parentDay + 480000)
  ]
  const withParent = foldAll(parent)
  assert.equal(withParent.days['2026-09-20'], 480000, '父会话那一段本来就有账')
  let state = withParent
  // 切点（最后一个继承事件，data.inherited === true）
  state = HOST.foldUsageDaily(state, hostEvent('session/end-seed', cut, { inherited: true }))
  assert.deepEqual(state.days, {}, '🩸 父会话的历史不许记在子会话名下')
  assert.equal(state.activeMs, 0)
  assert.equal(state.turns, 0)
  assert.equal(state.segments, 0)
  assert.equal(state.lastTime, cut, '锚点 = 切点时刻')
  // 合成 closers：复用切点时间戳（同毫秒）⇒ 只锚不记，且必须返回同一引用
  const closer = hostEvent('turn/end', cut, { reason: 'forked' })
  assert.equal(HOST.foldUsageDaily(state, closer), state, '同毫秒合成事件返回同一引用（不产生 0 长幻影段）')
  // 子会话自己的活动照常记账
  const own = HOST.foldUsageDaily(state, hostEvent('user/message', cut + 600000))
  assert.equal(own.segments, 1, '子会话自己从 1 段起算')
  assert.equal(own.activeMs, 0, '切点到第一条自有事件之间的间隔不算活跃')
  assert.equal(own.days['2026-09-25'], undefined, '没有量得出的时长就不落桶')
  const own2 = HOST.foldUsageDaily(own, hostEvent('assistant/message', cut + 660000))
  assert.equal(own2.days['2026-09-25'], 60000)
})

test('T20f 宿主状态 schema：坏字段就地纠正 / 坏形状抛错 / 纯 JSON 往返稳定', () => {
  const bad = HOST.usageDailyStateSchema.parse({
    days: { '2026-09-25': 1000, 'x': 5, '2026-09-24': 'no', '2026-09-23': -3, '2026-13-01': 7 },
    activeMs: NaN, turns: -1, segments: 'x', longestMs: Infinity, lastTime: 'y', openStart: undefined
  })
  assert.deepEqual(bad, {
    days: { '2026-09-25': 1000 }, hoursByDay: {}, byTool: {}, toolShapes: {},
    byModel: {}, turnOutcomes: {}, compactions: 0, eventShapes: {},
    openToolName: null, openToolStart: null,
    activeMs: 0, turns: 0, segments: 0, longestMs: 0, lastTime: null, openStart: null
  })
  for (const value of [null, undefined, 'x', 42, true]) {
    assert.throws(() => HOST.usageDailyStateSchema.parse(value), /non-null object/, String(value) + ' 必须抛（宿主 restore 里不允许静默假状态）')
    assert.throws(() => HOST.usageDailyViewSchema.parse(value), /non-null object/)
  }
  // 🩸 实测（2026-09-25 独立审查）："形状不对就抛"**不是**本层的真实语义 —— 上面那 5 个是
  // "根本不是记录对象"，才抛；`[]` / `[1,2]` / `Date` / `Map` / 无原型对象是"对象但不是状态"，
  // 一律**接受并纠正成全零**（理由写在 lib/index.mjs 的 schema 注释：宿主 restore:297 裸调
  // 无 try/catch，抛会让整个会话永久打不开）。这里把行为钉死，防止日后被"顺手改成抛"。
  const emptyState = {
    days: {}, hoursByDay: {}, byTool: {}, toolShapes: {},
    byModel: {}, turnOutcomes: {}, compactions: 0, eventShapes: {},
    openToolName: null, openToolStart: null,
    activeMs: 0, turns: 0, segments: 0, longestMs: 0, lastTime: null, openStart: null
  }
  const emptyView = {
    days: {}, hoursByDay: {}, byTool: {}, toolShapes: {},
    byModel: {}, turnOutcomes: {}, compactions: 0, eventShapes: {},
    activeMs: 0, turns: 0, segments: 0, longestMs: 0
  }
  for (const value of [[], [1, 2], new Date(0), new Map([['a', 1]]), Object.create(null), {}]) {
    const label = Object.prototype.toString.call(value)
    assert.deepEqual(HOST.usageDailyStateSchema.parse(value), emptyState, label + ' 必须被接受并纠正成全零（不抛）')
    assert.deepEqual(HOST.usageDailyViewSchema.parse(value), emptyView, label + '（view schema 同款）')
  }
  const good = foldAll([hostEvent('turn/start', CAL_DAY(2026, 9, 25, 10, 0)), hostEvent('step/end', CAL_DAY(2026, 9, 25, 10, 1))])
  const roundTrip = HOST.usageDailyStateSchema.parse(JSON.parse(JSON.stringify(good)))
  assert.deepEqual(roundTrip, good, '结构化克隆往返必须一模一样（宿主 checkpoint 就是 structuredClone）')
  assert.deepEqual(HOST.usageDailyViewSchema.parse(HOST.usageDailyViewOf(good)), HOST.usageDailyViewOf(good))
  // Standard Schema 分支：坏值走 issues，好值走 value
  assert.ok(Array.isArray(HOST.usageDailyStateSchema['~standard'].validate(null).issues))
  assert.deepEqual(HOST.usageDailyStateSchema['~standard'].validate(good).value, good)
})

test('T20g 宿主折叠：日桶有界（> MAX_KEPT_DAYS 只裁最旧的日桶，不裁会话总量）', () => {
  assert.equal(HOST.MAX_KEPT_DAYS, 400)
  const events = []
  let cursor = CAL_DAY(2026, 1, 1, 9, 0)
  for (let i = 0; i < HOST.MAX_KEPT_DAYS + 5; i += 1) {
    events.push(hostEvent('user/message', cursor))
    events.push(hostEvent('assistant/message', cursor + 60000))
    cursor += 86400000 // 每天一对事件（中间隔一天 ⇒ 必然断开算新段）
  }
  const state = foldAll(events)
  const kept = Object.keys(state.days).sort()
  assert.equal(kept.length, HOST.MAX_KEPT_DAYS, '日桶必须封顶')
  assert.equal(kept[0], '2026-01-06', '丢掉的是最旧的 5 天')
  assert.equal(kept[kept.length - 1], HOST.dayKeyOf(cursor - 86400000), '最后一天 = 最后一条事件那天')
  assert.equal(state.activeMs, (HOST.MAX_KEPT_DAYS + 5) * 60000, '会话总量不受日桶裁剪影响')
  assert.equal(state.segments, HOST.MAX_KEPT_DAYS + 5)
})

test('T20h 宿主 apply：注册到 sessionProjections；服务缺失 / 注册抛错都不许拖挂启动', () => {
  const registered = []
  const warned = []
  HOST.apply({
    sessionProjections: { register: (def) => { registered.push(def) } },
    logger: { warn: (...args) => warned.push(args) }
  })
  assert.equal(registered.length, 1)
  assert.equal(registered[0], HOST.usageDailyDefinition)
  // 服务缺失：只 warn，不抛
  HOST.apply({ logger: { warn: (...args) => warned.push(args) } })
  HOST.apply({})
  HOST.apply(undefined)
  assert.ok(warned.length >= 1, '缺服务必须留一条 warning（静默降级但可诊断）')
  // register 自己抛：也不许抛出去
  assert.doesNotThrow(() => HOST.apply({
    sessionProjections: { register: () => { throw new Error('boom') } },
    logger: { warn: () => {} }
  }))
  // ctx.get 形态的兜底
  const viaGet = []
  HOST.apply({ get: (key) => (key === 'sessionProjections' ? { register: (def) => viaGet.push(def) } : undefined) })
  assert.equal(viaGet.length, 1)
})

test('T20i 🩸 宿主半必须声明 inject=[sessionProjections]（少了它 cordis 硬抛 ⇒ usageDaily 永不注册）', () => {
  assert.ok(Array.isArray(HOST.inject),
    'inject 必须是数组（cordis 读的是模块级这枚导出）：实际 ' + JSON.stringify(HOST.inject))
  assert.ok(HOST.inject.includes('sessionProjections'),
    '🩸 inject 里必须有 sessionProjections：profile 里 session-projection 与本插件是**兄弟 root 条目**，' +
    '不声明注入时 cordis 读服务直接抛（cordis/lib/index.js:675 `cannot get property "…" without inject`），' +
    '而 apply 的 try/catch 会把这条抛吞成一句 warn ⇒ usageDaily 永不注册，界面上只会显示"正常的空态"（静默复辟）')
})

test('T20j 宿主清洗闸：parse / view 路径的日桶封顶 + viewOf 丢弃非法日键（含尾随空格）', () => {
  // ① `capDays` 不能只活在折叠的续段分支里：`restore` / `viewCheckpoint` 走的是
  //    `stateSchema.parse` / `wire.viewSchema.parse`。磁盘上若存着 400+ 天的桶，
  //    parse 也必须封顶（否则状态无界增长、会话列表行越传越胖）。
  const rawDays = {}
  let cursor = CAL_DAY(2026, 1, 1, 9, 0)
  for (let i = 0; i < HOST.MAX_KEPT_DAYS + 7; i += 1) {
    rawDays[HOST.dayKeyOf(cursor)] = 60000
    cursor += 86400000
  }
  const rawSnap = { days: rawDays, activeMs: 7, turns: 1, segments: 1, longestMs: 60000 }
  const parsed = HOST.usageDailyStateSchema.parse(rawSnap)
  const kept = Object.keys(parsed.days).sort()
  assert.equal(kept.length, HOST.MAX_KEPT_DAYS, 'parse 不许把无界日桶原样放行（只裁最旧）')
  assert.equal(kept[0], HOST.dayKeyOf(CAL_DAY(2026, 1, 1, 9, 0) + 7 * 86400000), '丢的是最旧的 7 天')
  assert.equal(kept[kept.length - 1], HOST.dayKeyOf(cursor - 86400000), '最后一天保留')
  assert.equal(parsed.activeMs, 7, '日桶裁剪不影响会话总量（parse 只裁 days）')
  assert.equal(Object.keys(HOST.usageDailyViewSchema.parse(rawSnap).days).length, HOST.MAX_KEPT_DAYS,
    'wire.viewSchema.parse 也必须封顶（它同样是裸调入口）')
  // ② `viewOf` 的日键闸：形状 / 范围 / 尾随空格 / 负数 / 非有限数一律不许随列表行下发。
  const view = HOST.usageDailyViewOf({
    days: { '2026-09-25': 1000, 'bad': 5, '2026-13-01': 7, '2026-09-26 ': 9, '2026-9-2': 11, '2026-09-24': -1, '2026-09-23': NaN },
    activeMs: 1000, turns: 1, segments: 1, longestMs: 1000
  })
  assert.deepEqual(view.days, { '2026-09-25': 1000 }, '🩸 脏日键一个都不许随列表行下发（客户端才不用吃信任）')
})

// ---------------------------------------------------------------- T21 客户端：日历读真数据

const CAL_NOW = CAL_DAY(2026, 9, 25, 10, 0) // 本地 2026-09-25（周五）
const usageSnapshot = {
  ids: ['s-a', 's-b', 's-c'],
  byId: {
    's-a': {
      projectionValues: {
        usageDaily: {
          days: { '2026-09-25': 3600000, '2026-09-24': 1800000 },
          activeMs: 5400000, turns: 4, segments: 3, longestMs: 3600000
        }
      }
    },
    's-b': {
      projectionValues: {
        usageDaily: {
          days: { '2026-09-25': 600000, '2026-09-21': 1200000, '2026-09-20': 60000, '2026-08-31': 900000, '2026-06-01': 1000 },
          activeMs: 3000000, turns: 2, segments: 4, longestMs: 1200000
        }
      }
    },
    // 没有该投影的会话（宿主还没写过这行的缓存）⇒ 必须被跳过，不许算成 0 会话
    's-c': { projectionValues: { title: 'x' } }
  },
  phase: 'ready'
}

test('T21 客户端：日键工具与宿主同口径（本地时区 / 非法键返回 null）', () => {
  const T21d = T
  assert.equal(T21d.dayKeyOf(CAL_NOW), '2026-09-25')
  assert.equal(T21d.dayKeyOf('x'), null)
  assert.equal(T21d.dayKeyOf(NaN), null)
  assert.equal(T21d.dayKeyOf(new Date(1e15).getTime()), null, '越界年份不许产出怪键')
  assert.equal(T21d.parseDayKey('2026-02-31'), null, '不存在的日期必须是 null（Date 会静默滚到 3 月）')
  assert.equal(T21d.parseDayKey('2026-2-3'), null, '形状必须是零填充的 YYYY-MM-DD')
  assert.equal(T21d.dayKeyAddDays('2026-01-01', -1), '2025-12-31', '跨年')
  assert.equal(T21d.dayKeyAddDays('2026-03-01', -1), '2026-02-28', '跨月')
  assert.equal(T21d.dayKeyAddDays('2024-03-01', -1), '2024-02-29', '闰年')
  assert.equal(T21d.dayKeyAddDays('bad', 1), null)
  assert.equal(T21d.weekStartKeyOf('2026-09-25'), '2026-09-21', '周五所在周 = 周一起算')
  assert.equal(T21d.weekStartKeyOf('2026-09-21'), '2026-09-21', '周一自己就是周首')
  assert.equal(T21d.weekStartKeyOf('2026-09-20'), '2026-09-14', '周日属于上一周（中文习惯）')
  assert.equal(T21d.weekStartKeyOf('nope'), null)
})

test('T21b 客户端：跨会话聚合（逐日相加 / 总量相加 / 最长取最大 / 无投影的会话被跳过）', () => {
  const agg = T.aggregateUsageDaily(usageSnapshot)
  assert.equal(agg.hasData, true)
  assert.equal(agg.sessions, 2, '只有带 usageDaily 的会话参与（s-c 必须被跳过）')
  assert.deepEqual(agg.days, {
    '2026-09-25': 4200000, '2026-09-24': 1800000, '2026-09-21': 1200000,
    '2026-09-20': 60000, '2026-08-31': 900000, '2026-06-01': 1000
  })
  assert.equal(agg.activeMs, 8400000)
  assert.equal(agg.turns, 6)
  assert.equal(agg.segments, 7)
  assert.equal(agg.longestMs, 3600000)
  // 兜底载体：projectionValues 缺失时读 projectionsBySession[id].values
  const viaStore = T.aggregateUsageDaily({
    ids: ['s-x'],
    byId: { 's-x': {} },
    projectionsBySession: { 's-x': { values: { usageDaily: { days: { '2026-09-25': 5000 }, activeMs: 5000, segments: 1 } } } }
  })
  assert.equal(viaStore.sessions, 1)
  assert.equal(viaStore.days['2026-09-25'], 5000)
  // 🩸 2026-09-25 定稿：「**有投影行但零活跃**」的会话不计入「覆盖会话」（只数 `activeMs > 0`）——
  // 宿主会给每个折过账的会话写一行，哪怕这段时间根本没干活；无条件计数只会让数字虚高。
  const zeroActive = T.aggregateUsageDaily({
    ids: ['s-z'],
    byId: { 's-z': { projectionValues: { usageDaily: { days: {}, activeMs: 0, segments: 1 } } } }
  })
  assert.equal(zeroActive.sessions, 0, '零活跃 ⇒ 不计入「覆盖会话」')
  assert.equal(zeroActive.activeMs, 0)
  assert.equal(zeroActive.hasData, true, 'hasData 口径不变：读到过投影且有段 ⇒ 不是空态（别把它也一起改坏）')
  // 坏输入：一律 hasData=false，且绝不抛
  assertClean(T.aggregateUsageDaily(null), 'agg(null)')
  for (const bad of [undefined, 'x', 42, { ids: 'nope' }, { ids: [null, 42], byId: { 's-a': 'x' } },
    { ids: ['a'], byId: { a: { projectionValues: { usageDaily: 'x' } } } },
    { ids: ['a'], byId: { a: { projectionValues: { usageDaily: { days: 'x', activeMs: NaN, segments: -1 } } } } }]) {
    const aggBad = T.aggregateUsageDaily(bad)
    assertClean(aggBad, 'agg(' + JSON.stringify(bad) + ')')
    assert.equal(aggBad.hasData, false, '形状不对 ⇒ 空态，不许画 0 冒充数据')
  }
})

test('T24 日历环比（A3）：上周 / 上月 + 跨年 + 上一期为 0 时不给涨跌', () => {
  const now = Date.parse('2026-01-12T20:00:00+08:00')   // 2026-01-12 是周一
  const mk = (days, at) => T.buildCalendarModel(
    { hasData: true, sessions: 1, days, longestMs: 0, segments: 0, activeMs: 0, turns: 0 },
    at === undefined ? now : at, zh)
  const m = mk({
    '2026-01-12': 7200000,   // 本周（周一当天）
    '2026-01-05': 3600000,   // 上周一
    '2025-12-10': 1800000,   // 上月 10 日 ⇒ 在"等长窗口"内
    '2025-12-20': 900000,    // 上月 20 日 ⇒ 🩸 **本期只过了 12 天，这条不许算进对比期**
    '2025-11-30': 4000000    // 上上月 ⇒ 不许串进来
  })
  const week = m.cumKpis.find((k) => k.key === 'week')
  const month = m.cumKpis.find((k) => k.key === 'month')
  assert.equal(week.value, '2h00m')
  assert.equal(week.delta.text, '▲ 100%', '上周等长窗口（只到上周一）= 1h ⇒ 涨 100%')
  assert.equal(week.delta.dir, 'up')
  assert.ok(week.delta.tip.includes('上周'), 'tip 要写清跟谁比：' + week.delta.tip)
  assert.equal(month.value, '3h00m', '本月 = 01-05 + 01-12')
  assert.equal(month.delta.text, '▲ 500%', '上月等长窗口（12-01~12-12）只有 30m ⇒ 涨 500%')
  assert.ok(month.delta.tip.includes('上月'))
  // 🩸 等长对位：上月 20 日与上上月都不许进对比期（否则就是"12 天 vs 31 天"的失真环比）
  assert.ok(month.delta.tip.indexOf('8h') === -1,
    '对比期不许把上月 20 日 / 上上月算进来：' + month.delta.tip)
  // 跨年：now 在 1 月 ⇒ 上一个月必须是**去年 12 月**（不许算成"今年 0 月"）
  const jan = mk({ '2026-01-12': 3600000, '2025-12-05': 1800000 })
  assert.equal(jan.cumKpis.find((k) => k.key === 'month').delta.dir, 'up', '跨年时上月 = 2025-12')
  // 上月不足该日 ⇒ 取上月最后一天（2026-03-31 的"上月同日"02-31 不存在 ⇒ 02-28）
  const mar = mk({ '2026-03-31': 3600000, '2026-02-28': 7200000, '2026-02-27': 900000 },
    Date.parse('2026-03-31T20:00:00+08:00'))
  assert.equal(mar.cumKpis.find((k) => k.key === 'month').delta.dir, 'down',
    '03-31 一天 vs 02-01~02-28 ⇒ 必然下降')
  // 🩸 实测发现：四舍五入到 0 ⇒ **不许再标方向**（"▲ 0%" 同时表示"涨 0.4%"与"持平" = 方向撒谎）
  const flat = mk({ '2026-01-12': 1004000, '2026-01-05': 1000000 })
  const flatWeek = flat.cumKpis.find((k) => k.key === 'week')
  assert.equal(flatWeek.delta.text, '—', '涨 0.4% 必须显示持平，不许写 ▲ 0%')
  assert.equal(flatWeek.delta.dir, 'flat')
  // 🩸 实测发现：无障碍 —— 必须给屏幕阅读器一句完整的话（不能只有 ▲/▼ 字形）
  assert.ok(week.delta.aria.indexOf('增加') !== -1 && week.delta.aria.indexOf('100%') !== -1,
    'aria 要写全：' + week.delta.aria)
  // 🩸 实测发现：`'1970-01'` 的前一月是 `'1969-12'`（越界）⇒ 宁可不给环比
  const epoch = mk({ '1970-01-05': 3600000, '1969-12-10': 9999999 },
    Date.parse('1970-01-05T20:00:00+08:00'))
  assert.equal(epoch.cumKpis.find((k) => k.key === 'month').delta, null, '越界月份不许对比')
  // 🩸 复审实测：越界修复原先只靠 `daysInMonthOf('1969-12')` 间接兜住（把 1 月分支改回去都没人红）
  // ⇒ 直接钉住 `prevMonthPrefixOf` 本身（为此把它导出）。
  assert.equal(T.prevMonthPrefixOf('1970-01'), null, '不允许越界回到 1969-12')
  assert.equal(T.prevMonthPrefixOf('2026-01'), '2025-12', '正常跨年要能算')
  assert.equal(T.prevMonthPrefixOf('2026-03'), '2026-02')
  assert.equal(T.prevMonthPrefixOf('bad'), null)
  // 🩸 复审实测（月末假涨）：本期 31 天 vs 上月 28 天同样不等长 ⇒ **本期参与环比的部分也要截到 28 天**。
  // 修复之前这条会得到 ▲ 300%（本期全量 4h vs 上月 1h）—— 那正是"匀速习惯却报大涨"的假涨。
  const f10 = mk({
    '2026-03-28': 3600000, '2026-03-29': 3600000, '2026-03-30': 3600000, '2026-03-31': 3600000,
    '2026-02-01': 3600000
  }, Date.parse('2026-03-31T20:00:00+08:00'))
  const f10m = f10.cumKpis.find((k) => k.key === 'month')
  assert.equal(f10m.delta.text, '—',
    '月末两边都要截到 28 天（本期只算 3-01~3-28、上月 2-01~2-28）⇒ 应持平：' + f10m.delta.text)
  assert.equal(f10m.delta.dir, 'flat')
  // 🩸 复审实测（守护缺口）：无障碍必须在**渲染层**也有断言 ——
  // 原先只查数据层 `delta.aria`，把 DOM 上的 `role`/`aria-label` 整行删掉都没人红。
  const calTree = T.renderSegment('calendar', { calendar: m }, zh, null)
  const deltaNodes = findNodes(calTree, (n) => n.props && n.props['data-usage-role'] === 'kpi-delta')
  assert.ok(deltaNodes.length > 0, '这个夹具必须能产出环比，否则本守护是空转')
  for (const node of deltaNodes) {
    assert.equal(node.props.role, 'note', '环比标记要带语义角色')
    assert.ok(String(node.props['aria-label'] || '').length > 0, 'aria-label 不能为空')
  }
  // 上一期为 0 / 不存在 ⇒ **不给 delta**（绝不产出 ∞% / "▲ 9999%"）
  const only = mk({ '2026-01-12': 3600000 })
  assert.equal(only.cumKpis.find((k) => k.key === 'week').delta, null)
  assert.equal(only.cumKpis.find((k) => k.key === 'month').delta, null)
  // 形状非法的键不许影响环比（尾随空格那类脏键，靠 isDayKey 闸挡住）
  const dirty = mk({ '2026-01-12': 3600000, '2026-01-12 ': 99999999, '2025-12-20 ': 88888888 })
  assert.equal(dirty.cumKpis.find((k) => k.key === 'week').value, '1h00m', '脏键不许虚增本周')
  assertClean(m, 'calendar(A3)')
})

test('T21c 客户端：日历模型（今日/本周/本月 + 热力档位 + 柱高 + 段统计）', () => {
  const model = T.buildCalendarModel(T.aggregateUsageDaily(usageSnapshot), CAL_NOW, zh)
  assert.equal(model.hasData, true)
  assert.equal(model.sessions, 2)
  assert.equal(model.sessionsText, '2')
  assert.deepEqual(model.cumKpis.map((k) => k.label), ['今日', '本周', '本月'])
  // 今日 = 4200000ms = 1h10m；本周 = 周一起（09-21/24/25）= 7200000 = 2h00m；本月 = 7260000 = 2h01m
  assert.deepEqual(model.cumKpis.map((k) => k.value), ['1h10m', '2h00m', '2h01m'])
  assert.deepEqual(model.segKpis.map((k) => k.label), ['最长', '平均', '段数'])
  assert.deepEqual(model.segKpis.map((k) => k.value), ['1h00m', '20m00s', '7'], '平均 = 8400000 / 7')
  assert.equal(model.heat.length, T.CALENDAR_HEAT_DAYS)
  assert.equal(model.heat[model.heat.length - 1].key, '2026-09-25', '最后一格是今天')
  assert.equal(model.heat[0].key, '2026-07-04', '往前 83 天')
  assert.equal(model.heatMaxMs, 4200000)
  const today = model.heat[model.heat.length - 1]
  assert.equal(today.level, 4, '最大值 ⇒ 4 档')
  const yest = model.heat[model.heat.length - 2]
  assert.equal(yest.key, '2026-09-24')
  assert.equal(yest.level, 2)
  const empty = model.heat[0]
  assert.equal(empty.level, 0, '没有活动的日子是 0 档（不画色块）')
  assert.equal(empty.ms, 0)
  assert.equal(empty.title, '2026-07-04 · 0.0s')
  assert.equal(model.bars.length, T.CALENDAR_BAR_DAYS)
  assert.equal(model.bars[model.bars.length - 1].ms, 4200000)
  assert.equal(model.bars[model.bars.length - 1].heightPct, 100)
  assert.equal(model.bars[model.bars.length - 1].label, '09-25')
  assertClean(model, 'calendarModel')
  // 空态：没有投影 / 全 0 ⇒ hasData=false，绝不会给渲染层 '0' 冒充数据
  for (const empty of [null, undefined, { hasData: false }]) {
    const m = T.buildCalendarModel(empty, CAL_NOW, zh)
    assert.equal(m.hasData, false)
    assert.deepEqual(m.heat, [])
    assert.deepEqual(m.cumKpis, [])
    assertClean(m, 'emptyCalendarModel')
  }
  const zero = T.buildCalendarModel({ hasData: true, sessions: 3, days: {}, activeMs: 0, turns: 0, segments: 0, longestMs: 0 }, CAL_NOW, zh)
  assert.equal(zero.hasData, true)
  assert.deepEqual(zero.cumKpis.map((k) => k.value), ['0.0s', '0.0s', '0.0s'])
  assert.equal(zero.segKpis[1].value, '—', '段数为 0 时平均时长显示 —（不是 NaN、也不是 0）')
})

test('T21d 客户端：日历 / 会话**都**渲染真数据（不再是骨架）', () => {
  const model = T.buildModel({ stats, turnTimings, timeline, sessions: usageSnapshot, now: CAL_NOW }, zh)
  assert.equal(model.calendar.hasData, true)
  const cal = T.renderSegment('calendar', model, zh, null)
  const texts = textsOf(cal)
  assert.ok(texts.includes('日历视图'), '有数据时还是同一张卡（标题不变）')
  assert.ok(texts.includes('覆盖会话 2'), '卡面标出覆盖会话数：' + JSON.stringify(texts.slice(0, 20)))
  assert.ok(texts.includes('1h10m') && texts.includes('2h00m') && texts.includes('2h01m'), '今日/本周/本月上屏')
  assert.ok(texts.includes('20m00s') && texts.includes('7'), '段统计上屏')
  assert.ok(texts.includes('按天热力图 · 近 12 周') && texts.includes('每日时长柱状 · 近 14 天'), '两个窗口的范围要写在卡面上')
  assert.ok(!texts.includes('P2 接宿主级全历史数据后填充'), '有真数据就不该再挂 P2 占位标签')
  assert.equal(findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton').length, 0, '有数据时不许画骨架')
  assert.equal(findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'cal-heat-cell').length, T.CALENDAR_HEAT_DAYS)
  assert.equal(findNodes(cal, (n) => n.props && n.props.className === 'ut-heat-cell ut-heat-l4').length, 1)
  assert.equal(findNodes(cal, (n) => n.props && n.props.className === 'ut-hour-bar').length, T.CALENDAR_BAR_DAYS)
  const note = findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'cal-note')
  assert.equal(note.length, 1, '口径脚注恰一处')
  assert.ok(textsOf(note[0].children).join('').includes('usageDaily'), '脚注要点出数据源键名')
  assert.deepEqual(texts.filter((x) => /NaN|undefined|\[missing:/.test(x)), [], '有数据时的日历正文不许有脏值')
  // 🩸「会话」页（P2 第三步）现在也读真数据了 ⇒ 同一个模型下**不许再有骨架**
  const ses = T.renderSegment('sessions', model, zh, null)
  assert.equal(findNodes(ses, (n) => n.props && n.props['data-usage-role'] === 'skeleton').length, 0,
    '有 usageDaily 投影 ⇒ 会话页不许再画骨架')
  assert.equal(findNodes(ses, (n) => n.props && n.props['data-usage-role'] === 'ses-tools').length, 1,
    '会话页的工具条（视图 / 时间窗 / 工作区）要在')
})

test('T21e 客户端：读不到投影 ⇒ 日历保持 P1.1 空态（同一个模型翻转）', () => {
  const noData = T.buildModel({ stats, turnTimings, timeline, now: CAL_NOW }, zh)
  assert.equal(noData.calendar.hasData, false, '没传 sessions ⇒ 空态')
  const cal = T.renderSegment('calendar', noData, zh, null)
  const skel = findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton')
  assert.equal(skel.length, 1)
  assert.equal(findNodes(skel[0], (n) => n.props && n.props.className === 'ut-skel-row').length, 8)
  assert.equal(findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'p2-tag').length, 1)
  const vals = findNodes(skel[0], (n) => n.props && n.props.className === 'ut-skel-val')
  assert.equal(vals.length, 8)
  assert.deepEqual(vals.map((v) => textsOf(v.children).join('')), ['—', '—', '—', '—', '—', '—', '—', '—'], '空态值必须是 —，不是 0')
  const note = textsOf(findNodes(cal, (n) => n.props && n.props.className === 'ut-source'))
  assert.ok(note.join('').includes('usageDaily'), '空态说明要点出缺的是哪个宿主投影（不再是"等 P2 开发"）')
  // 脏数：投影值形状全坏 ⇒ 仍然走空态、不崩、不上屏 NaN
  for (const bad of ['x', 42, { ids: 'x' }, { ids: ['a'], byId: { a: { projectionValues: { usageDaily: { days: { '2026-09-25': NaN }, activeMs: Infinity, segments: 'x' } } } } }]) {
    const dirty = T.buildModel({ stats: null, turnTimings: null, timeline: null, sessions: bad, now: CAL_NOW }, zh)
    assertClean(dirty, 'dirtyCalendarModel')
    const dirtyCal = T.renderSegment('calendar', dirty, zh, null)
    assert.deepEqual(textsOf(dirtyCal).filter((x) => /NaN|undefined|\[missing:/.test(x)), [], JSON.stringify(bad))
  }
})

test('T21f 客户端：UsageView 读 useSessions（座位缺失 / 抛错 / 只调一次都不许崩）', () => {
  let calls = 0
  const tree = T.UsageView({
    sessionId: 's',
    t: zh,
    useProjection: (key) => (key === 'sessionStats' ? stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings }, timeline }),
    useSessions: (selector) => { calls += 1; return selector(usageSnapshot) }
  })
  assert.equal(calls, 1, 'hook 必须无条件、固定顺序、只调一次')
  const texts = []
  collectStrings(tree, texts)
  assert.deepEqual(texts.filter((x) => /NaN|undefined|\[missing:/.test(x)), [])
  // 座位缺失 / 抛错：走空态，不崩
  let throwCalls = 0
  const throwy = T.UsageView({
    sessionId: 's', t: zh,
    useSessions: () => { throwCalls += 1; throw new Error('boom') }
  })
  assert.equal(throwCalls, 1)
  const t2 = []
  collectStrings(throwy, t2)
  assert.ok(t2.includes('暂无数据'))
  const noSeat = T.UsageView({ sessionId: 's', t: zh })
  const t3 = []
  collectStrings(noSeat, t3)
  assert.ok(t3.includes('暂无数据'))
  assert.equal(T.sessionsSliceOf({ useSessions: 'nope' }), null)
  assert.equal(T.sessionsSliceOf({ useSessions: () => 'x' }), null, '快照不是对象 ⇒ 当作没有')
})

test('T21g 客户端聚合 / 窗口闸：非法日键（尾随空格等）不许进 agg.days，也不许虚增本周 / 本月', () => {
  // ① 聚合层（`cleanUsageDaily` 的 isDayKey 闸）：宿主给的是 JSON，本插件不吃信任。
  const dirty = T.aggregateUsageDaily({
    ids: ['s-a'],
    byId: {
      's-a': {
        projectionValues: {
          usageDaily: {
            days: {
              '2026-09-25': 1000, '2026-09-22 ': 999999, '2026-9-2': 888888,
              'x': 777777, '2026-13-01': 666666, '2026-09-24': -5, '2026-09-23': NaN
            },
            activeMs: 1000, turns: 1, segments: 1, longestMs: 1000
          }
        }
      }
    }
  })
  assert.deepEqual(Object.keys(dirty.days).sort(), ['2026-09-25'],
    '🩸 非规范日键一个都不许进聚合（尾随空格 / 非零填充 / 月 13 / 负数 / NaN 全都不行）')
  // ② 窗口层（纵深防御）：即便绕过聚合、直接把脏 days 喂给模型，`'2026-09-22 '` 也不许被
  //    **字符串区间比较**算进本周 / 本月 —— 这就是实测指出的"理论虚增"的堵点。
  const model = T.buildCalendarModel({
    hasData: true, sessions: 1, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000,
    days: { '2026-09-25': 1000, '2026-09-22 ': 999999, '2026-9-2': 888888, 'x': 777777 }
  }, CAL_NOW, zh)
  assert.deepEqual(model.cumKpis.map((k) => k.value), ['1.0s', '1.0s', '1.0s'],
    '今日 / 本周 / 本月都只该有今天那 1000ms（字典序落进区间的非法键必须被挡在窗口之外）')
})

// ---------------------------------------------------------------- T23 客户端：「会话」页（P2 第三步，一页三视图）

// 夹具：4 个会话 —— displayTitle 兜底 / 只有 title / 子代理 / 没有投影
const SES_NOW = CAL_DAY(2026, 9, 25, 12, 0)
const SES_SNAP = {
  ids: ['s1', 's2', 's3', 's4'],
  byId: {
    s1: {
      id: 's1',
      displayTitle: '会话页实装',
      cwd: 'D:\\Work\\alpha',
      updatedAt: CAL_DAY(2026, 9, 25, 11, 0),
      running: true,
      projectionValues: {
        usageDaily: {
          days: { '2026-09-25': 3600000, '2026-09-24': 1800000 },
          activeMs: 5400000, turns: 4, segments: 3, longestMs: 3600000
        }
      }
    },
    s2: {
      id: 's2',
      title: '只有 title 的会话',
      cwd: 'D:\\Work\\beta',
      projectionValues: {
        usageDaily: {
          days: { '2026-09-25': 600000, '2026-08-31': 900000 },
          activeMs: 1500000, turns: 2, segments: 2, longestMs: 900000
        }
      }
    },
    s3: {
      id: 's3',
      origin: 'subagent',
      cwd: 'D:\\Work\\alpha',
      projectionValues: {
        usageDaily: { days: { '2026-09-23': 60000 }, activeMs: 60000, turns: 1, segments: 1, longestMs: 60000 }
      }
    },
    s4: { id: 's4', displayTitle: '没有投影的会话' }
  }
}

test('T23a 会话页数据层：逐会话保留身份（displayTitle→title→id）、无投影只计数、坏行不崩', () => {
  const collected = T.collectSessionUsage(SES_SNAP)
  assert.equal(collected.rows.length, 3, '四个会话里三个带 usageDaily')
  assert.equal(collected.uncovered, 1, '缺投影的会话只计数、不进清单')
  const byId = {}
  for (const row of collected.rows) byId[row.id] = row
  assert.equal(byId.s1.title, '会话页实装', 'displayTitle 优先')
  assert.equal(byId.s2.title, '只有 title 的会话', '没有 displayTitle 时回落到 title')
  assert.equal(byId.s3.title, 's3', '两者都没有时回落到 id')
  assert.equal(byId.s3.isSubagent, true, 'origin=subagent 必须标记出来')
  assert.equal(byId.s1.running, true)
  assert.equal(byId.s1.lastDay, '2026-09-25', '最后活动日 = 最大日键')
  assert.equal(byId.s1.cwd, 'D:\\Work\\alpha')
  // 坏输入：不崩、也不产出脏行
  assert.deepEqual(T.collectSessionUsage(null), { rows: [], uncovered: 0 })
  assert.equal(T.collectSessionUsage({ ids: [1, '', 'x'], byId: {} }).uncovered, 1,
    '非字符串 id 跳过；字符串 id 没投影 ⇒ 计 1')
  const dirty = T.collectSessionUsage({
    ids: ['z'],
    byId: { z: { projectionValues: { usageDaily: { days: { bad: 5, '2026-09-25': -3, '2026-09-24': 'x' }, activeMs: NaN, turns: -1 } } } }
  })
  assert.equal(dirty.rows.length, 1)
  assert.deepEqual(dirty.rows[0].days, {}, '脏日键 / 负数 / 字符串一律丢弃')
  assert.equal(dirty.rows[0].activeMs, 0)
  // 实测：宿主只下发 `projectionsBySession`（既没有 ids 也没有 byId）时也要能列出会话 ——
  // 否则日历 / 会话页会一起"干净地"落空态，看不出是宿主换了载体。
  const onlyPer = T.collectSessionUsage({
    projectionsBySession: {
      p1: { values: { usageDaily: { days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000 } } }
    }
  })
  assert.equal(onlyPer.rows.length, 1, '只在 projectionsBySession 里的会话也要能列出来（形状兜底）')
  assert.equal(onlyPer.rows[0].id, 'p1')
})

test('T23b 会话页 A 视图：窗口只筛时长、按工作区分组与排序、条长相对全局最大', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(model.hasData, true)
  assert.equal(model.countText, '3 个会话')
  assert.equal(model.totalText, '1h41m', '7 天窗口内 = 5400000 + 600000 + 60000')
  assert.deepEqual(model.groups.map((g) => g.label), ['alpha', 'beta'], '组按窗口内总量降序')
  assert.deepEqual(model.groups[0].sessions.map((s) => s.id), ['s1', 's3'], '组内按时长降序')
  assert.equal(model.groups[0].sessions[0].activeText, '1h30m')
  assert.equal(model.groups[0].sessions[0].barPct, 100, '最长的那行条长 100%')
  assert.ok(model.groups[0].sessions[1].barPct > 0, '最小可见宽度不许是 0')
  const meta = model.groups[0].sessions[0].metaText
  assert.ok(meta.includes('09-25') && meta.includes('3 段') && meta.includes('4 轮'), '行内口径文案：' + meta)
  // 窗口 = 全部 ⇒ 时长改用全日志总量（s2 的 08-31 那 15 分钟要算进来）
  const all = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'a', windowDays: 0, workspace: '' }, SES_NOW, zh)
  assert.equal(all.totalText, '1h56m', '全部窗口 = 5400000 + 1500000 + 60000')
  // 工作区筛 ⇒ 只剩那一个组
  const wiki = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'a', windowDays: 0, workspace: 'D:\\Work\\beta' }, SES_NOW, zh)
  assert.equal(wiki.groups.length, 1)
  assert.equal(wiki.groups[0].sessions.length, 1)
  assert.equal(wiki.countText, '1 个会话')
  // 窗口内没有任何活动 ⇒ 给提示，但仍算 hasData（清单照显示，不是空态）
  const none = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'a', windowDays: 7, workspace: 'nope' }, SES_NOW, zh)
  assert.equal(none.hasData, true, '工作区筛不中 ≠ 没数据')
  assert.equal(none.countText, '0 个会话')
})

test('T23c 会话页 B 视图：14 列活动带、强度相对全局最大单日、缺天补 0 档', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'b', windowDays: 7 }, SES_NOW, zh)
  assert.equal(model.bandAxis.length, 14, '活动带固定近 14 天')
  assert.equal(model.bandAxis[13].key, '2026-09-25', '最后一列是今天')
  assert.equal(model.bands.length, 3)
  const s1 = model.bands.filter((b) => b.id === 's1')[0]
  assert.equal(s1.cells.length, 14)
  assert.equal(s1.cells[13].level, 4, '3600000 是全局最大单日 ⇒ 4 档')
  assert.equal(s1.cells[12].level, 3, '1800000 / 3600000 = 0.5 ⇒ 3 档')
  const s3 = model.bands.filter((b) => b.id === 's3')[0]
  const day23 = s3.cells.filter((c) => c.key === '2026-09-23')[0]
  assert.equal(day23.level, 1, '60000 / 3600000 很小 ⇒ 1 档（不是 0）')
  assert.equal(s3.cells.filter((c) => c.level === 0).length, 13, '没活动的天一律 0 档')
})

test('T23d 会话页 C 视图：默认选最长会话、可指定选中、选中态只有一个', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'c', windowDays: 7 }, SES_NOW, zh)
  assert.equal(model.listRows.length, 3)
  assert.equal(model.selected.id, 's1', '没指定就选窗口内最长的那个')
  assert.equal(model.listRows.filter((r) => r.active).length, 1, '选中态只能有一个')
  assert.equal(model.selected.dayBars.length, 14)
  assert.equal(model.selected.segText, '3')
  assert.equal(model.selected.turnText, '4')
  assert.equal(model.selected.longestText, '1h00m')
  assert.equal(model.selected.lastText, '09-25')
  const picked = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'c', windowDays: 7, selectedId: 's3' }, SES_NOW, zh)
  assert.equal(picked.selected.id, 's3')
  assert.equal(picked.listRows.filter((r) => r.active)[0].id, 's3')
  const fallback = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'c', windowDays: 7, selectedId: 'nope' }, SES_NOW, zh)
  assert.equal(fallback.selected.id, 's1', '指定了一个不存在的 id ⇒ 回落到最长')
})

test('T23e 会话页渲染冒烟：三视图都不上屏 NaN/undefined，关键节点齐备；无投影则空态', () => {
  const base = { stats, turnTimings, timeline, sessions: SES_SNAP, now: SES_NOW }
  const a = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'a' } }), zh), zh, null)
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-tools').length, 1, '工具条在')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-group').length, 2, '两个工作区分组')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-row').length, 3, '三行会话')
  assert.equal(findNodes(a, (n) => n.props && n.props.className === 'ut-ses-bar').length, 3, '每行一条比例条')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'skeleton').length, 0, '有数据不许画骨架')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-uncovered').length, 1, '缺投影的会话要有一条脚注')
  assertClean(a, 'sessions(a)')
  const b = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'b' } }), zh), zh, null)
  assert.equal(findNodes(b, (n) => n.props && n.props['data-usage-role'] === 'ses-band-cell').length, 42, '3 行 × 14 天')
  assert.equal(findNodes(b, (n) => n.props && n.props['data-usage-role'] === 'ses-hint').length, 1, 'B 视图要写明"只有逐日粒度"')
  // 🩸 2026-10-14 实测翻车实录：往 `.ut-ses-band-row`（**3 列 grid**）里插了个色点却没改列定义 ⇒
  // 4 个元素挤 3 列，名字列被压成一个字、格子全飞到右边（一张截图一句"这页是不是有点问题"就抓出了）。
  // ⇒ 纪律：**grid 行的子元素数必须等于它声明的列数**；这条只能靠机械断言守。
  const bandRows = findNodes(b, (n) => n.props && n.props['data-usage-role'] === 'ses-band-row')
  assert.equal(bandRows.length, 3)
  for (const rowNode of bandRows) {
    assert.equal(rowNode.children.length, 3,
      '.ut-ses-band-row 是 3 列 grid ⇒ 子元素必须恰好 3 个（name / cells / dur）')
  }
  assertClean(b, 'sessions(b)')
  const c = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'c' } }), zh), zh, null)
  assert.equal(findNodes(c, (n) => n.props && n.props['data-usage-role'] === 'ses-item').length, 3)
  assert.equal(findNodes(c, (n) => n.props && n.props.className === 'ut-ses-day').length, 14)
  assertClean(c, 'sessions(c)')
  // 空态：没有 sessions ⇒ 骨架 + —（值不许是 0）
  const empty = T.renderSegment('sessions', T.buildModel({ stats, turnTimings, timeline }, zh), zh, null)
  assert.equal(findNodes(empty, (n) => n.props && n.props['data-usage-role'] === 'skeleton').length, 1)
  assert.deepEqual(findNodes(empty, (n) => n.props && n.props.className === 'ut-skel-val')
    .map((v) => textsOf(v.children).join('')), ['—', '—', '—'])
  assertClean(empty, 'sessions(empty)')
})

test('T23f 会话页偏好真的进模型 + 三段控件的组名与选中态', () => {
  const model = T.buildModel({
    stats, turnTimings, timeline, sessions: SES_SNAP, now: SES_NOW,
    prefs: { sesView: 'c', sesWindow: 30, sesWorkspace: 'D:\\Work\\alpha' }
  }, zh)
  assert.equal(model.sessions.view, 'c')
  assert.equal(model.sessions.windowDays, 30)
  assert.equal(model.sessions.groups.length, 1, '工作区偏好生效（只剩一个组）')
  const body = T.renderSegment('sessions', model, zh, null)
  const buttons = findNodes(body, (n) => n.props && typeof n.props['data-group'] === 'string')
  const groups = buttons.map((b) => b.props['data-group'])
  assert.ok(groups.includes('ses.view') && groups.includes('ses.win'), '视图与时间窗控件都要在')
  const onView = buttons.filter((b) => b.props['data-group'] === 'ses.view' && b.props['aria-pressed'] === 'true')
  assert.equal(onView.length, 1)
  assert.equal(onView[0].props['data-value'], 'c', '选中的视图必须与偏好一致')
  assert.ok(textsOf(body).includes('单会话') && textsOf(body).includes('近 30 天'), '标签来自字典')
  // ⚠️ 不能用 `startsWith('ses.')` 扫 textsOf：它**同时收集 props 里的字符串**，而
  // `data-group="ses.view"` / `data-usage-role="ses-tools"` 本身就长这样 ⇒ 会误报。
  // "有没有把字典 key 原样印上屏"由 assertClean（抓 `[missing:`）与上面的中文标签断言共同守住。
  assertClean(body, 'sessions(prefs)')
})

// ---------------------------------------------------------------- T23g~T23l 会话页的守护补强
// 来源：2026-10-13 独立审查
// 「拆了还不红的盲区」。那些点的根因**不是"变体不够"，而是正断言本身不存在** ——
// 拆掉实现三套检查仍然全绿。所以先在这里把断言补上，反事实变体才有意义。

/**
 * 45 个会话（时长按 id 递减；**最后一个属于另一个工作区** `D:\Work\gamma`）：
 * ① 专测 `SESSION_LIST_LIMIT` 截断（B / C 取前 40）；
 * ② 兼测"A 视图不参与截断" —— 若按全局 40 截断，`D:\Work\gamma` 那一组会**整组消失**（实测发现）。
 */
const SES_MANY_SNAP = (() => {
  const ids = []
  const byId = {}
  for (let i = 0; i < 45; i += 1) {
    const id = 'b' + String(i).padStart(2, '0')
    const ms = 1000000 - i * 1000
    ids.push(id)
    byId[id] = {
      id,
      displayTitle: '会话 ' + i,
      cwd: i === 44 ? 'D:\\Work\\gamma' : 'D:\\Work\\alpha',
      projectionValues: {
        usageDaily: { days: { '2026-09-25': ms }, activeMs: ms, turns: 1, segments: 1, longestMs: ms }
      }
    }
  }
  return { ids, byId }
})()

/**
 * 排序假绿夹具：**可见顺序与"组总量降序"不一致**。
 * 可见顺序（时长降序）= o1(A) → o3(B) → o4(B) → o2(A) ⇒ A 组先出现，但 B 组总量 600000 > A 组 501000。
 * 只按首次出现顺序拼组（不排序）时，这一条就会红。
 */
const SES_ORDER_SNAP = {
  ids: ['o1', 'o2', 'o3', 'o4'],
  byId: {
    o1: { id: 'o1', title: 'A 长', cwd: 'D:\\A', projectionValues: { usageDaily: { days: { '2026-09-25': 500000 }, activeMs: 500000, turns: 1, segments: 1, longestMs: 500000 } } },
    o2: { id: 'o2', title: 'A 短', cwd: 'D:\\A', projectionValues: { usageDaily: { days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000 } } },
    o3: { id: 'o3', title: 'B 长', cwd: 'D:\\B', projectionValues: { usageDaily: { days: { '2026-09-25': 400000 }, activeMs: 400000, turns: 1, segments: 1, longestMs: 400000 } } },
    o4: { id: 'o4', title: 'B 中', cwd: 'D:\\B', projectionValues: { usageDaily: { days: { '2026-09-25': 200000 }, activeMs: 200000, turns: 1, segments: 1, longestMs: 200000 } } }
  }
}

test('T23g 会话页截断：B / C 按 40 截断、A 视图列全部（不抹组）；卡头 / 行数 / 脚注自洽', () => {
  const collected = T.collectSessionUsage(SES_MANY_SNAP)
  assert.equal(collected.rows.length, 45)
  const model = T.buildSessionsModel(collected, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(model.countText, '45 个会话', '卡头数的是筛选后全集')
  assert.equal(model.capped, 5, '被截掉 5 个')
  // 🩸 实测：A 视图不参与截断 ⇒ 列出的行数 = 全集，且**排 40 名之后的组不许消失**
  assert.equal(model.groups.reduce((acc, g) => acc + g.sessions.length, 0), 45,
    'A 视图列全部会话（按全局 40 截断会把整组抹掉）')
  assert.deepEqual(model.groups.map((g) => g.label).sort(), ['alpha', 'gamma'],
    '末尾那个工作区（排在 40 名之外）必须还在')
  // 🩸 实测：卡头合计必须等于**各组组头合计之和** —— 这条此前**零直接断言**，
  // 把任一组的总量 ×2 都抓不出来；而上面的验收点恰恰是"两个合计不打架"。
  assert.equal(model.groups.reduce((sum, g) => sum + g.ms, 0), model.totalMsRaw,
    '卡头合计 = 各组组头合计之和（A 视图不截断才可能成立）')
  // 🩸 实测闭合：断言必须钉在**用户实际看到的那个字段**上 ——
  // 只把 `totalText` 的显示值改掉（`ms` 不动）也必须被抓出来，否则"同一处风险换个马甲就能过"。
  for (const g of model.groups) {
    assert.equal(g.totalText, T.formatDuration(g.ms), '组头显示值必须与它的数值同源')
  }
  assert.equal(model.totalText, T.formatDuration(model.totalMsRaw), '卡头显示值同理')
  const base = { stats, turnTimings, timeline, sessions: SES_MANY_SNAP, now: SES_NOW }
  const a = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'a' } }), zh), zh, null)
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-row').length, 45,
    'A 视图列全部（按 40 截断会抹掉整组）')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-group').length, 2, '两组都要在')
  assert.equal(findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-capped').length, 0,
    'A 视图列全部 ⇒ 不该有"只列出前 N 个"的脚注')
  const b = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'b' } }), zh), zh, null)
  assert.equal(findNodes(b, (n) => n.props && n.props['data-usage-role'] === 'ses-band-row').length, 40)
  const bCap = findNodes(b, (n) => n.props && n.props['data-usage-role'] === 'ses-capped')
  assert.equal(bCap.length, 1, 'B 视图要报截断')
  const capText = textsOf(bCap).join('')
  assert.ok(capText.includes('40') && capText.includes('5'),
    '脚注要同时说清"列出的上限"和"被截掉的数"：' + capText)
  const c = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'c' } }), zh), zh, null)
  assert.equal(findNodes(c, (n) => n.props && n.props['data-usage-role'] === 'ses-item').length, 40)
  assert.equal(findNodes(c, (n) => n.props && n.props['data-usage-role'] === 'ses-capped').length, 1)
  assertClean(a, 'sessions(many-a)')
})

test('T23h 会话页三种"空"分开表述：筛选没中 / 窗口内无活跃 / 真没投影', () => {
  // ① 工作区筛不中：有数据、有投影，只是筛不到 ⇒ 指引必须是"换工作区"
  const miss = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'a', windowDays: 7, workspace: 'nope' }, SES_NOW, zh)
  assert.equal(miss.hasData, true)
  assert.equal(miss.emptyKind, 'workspaceMiss')
  assert.ok(miss.pickHint.length > 0, '筛选没中要给"换工作区"的指引')
  assert.equal(miss.windowHint, '', '筛选没中时不许给"切全部时间窗"的错误指引（切了还是 0）')
  // ② 窗口内无活跃（工作区筛中了、且还在显示范围内）：这时切「全部」才有效
  const stale = T.buildSessionsModel({
    rows: [{
      id: 'old',
      title: '老会话',
      cwd: 'D:\\A',
      days: { '2026-09-15': 5000 },
      activeMs: 5000,
      turns: 1,
      segments: 1,
      longestMs: 5000,
      lastDay: '2026-09-15',
      isSubagent: false,
      running: false
    }],
    uncovered: 0
  }, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(stale.emptyKind, 'windowEmpty')
  assert.ok(stale.windowHint.length > 0)
  assert.equal(stale.pickHint, '')
  // ②b 显示范围（2026-10-14 定稿）：太久没动的会话不进清单，空态要说"放宽显示范围"
  const tooOld = T.buildSessionsModel({
    rows: [{
      id: 'ancient',
      title: '很久没动',
      cwd: 'D:\\A',
      days: { '2026-01-01': 5000 },
      activeMs: 5000,
      turns: 1,
      segments: 1,
      longestMs: 5000,
      lastDay: '2026-01-01',
      isSubagent: false,
      running: false
    }],
    uncovered: 0
  }, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(tooOld.emptyKind, 'rangeEmpty', '超出显示范围的会话不进清单')
  assert.ok(tooOld.rangeHint.length > 0)
  assert.equal(tooOld.windowHint, '', '范围挡下时不许给"切全部时间窗"的指引')
  // ③ 渲染：hint 真挂出来，且 C 视图空右栏不再甩"读不到投影"
  const base = { stats, turnTimings, timeline, sessions: SES_SNAP, now: SES_NOW }
  const a = T.renderSegment('sessions',
    T.buildModel(Object.assign({}, base, { prefs: { sesView: 'a', sesWorkspace: 'nope' } }), zh), zh, null)
  const hint = findNodes(a, (n) => n.props && n.props['data-usage-role'] === 'ses-hint')
  assert.equal(hint.length, 1)
  assert.ok(textsOf(hint).join('').includes('换个工作区'), '空态指引必须指向真正的原因')
  const c = T.renderSegment('sessions',
    T.buildModel(Object.assign({}, base, { prefs: { sesView: 'c', sesWorkspace: 'nope' } }), zh), zh, null)
  const cTexts = textsOf(c).join('')
  assert.ok(cTexts.includes('换个工作区'), 'C 视图右栏也要说清原因：' + cTexts.slice(0, 160))
  assert.ok(!cTexts.includes('读不到宿主'), 'C 视图不许再拿"读不到投影"解释"筛选没中"')
  // ④ 第四种空：「有投影但全零活跃」（实测发现）—— 必须与"窗口内无活跃"分开
  const zeroRows = [{
    id: 'z1',
    title: '零活跃',
    cwd: 'D:\\A',
    days: { '2026-09-25': 0 },
    activeMs: 0,
    turns: 0,
    segments: 0,
    longestMs: 0,
    lastDay: '2026-09-25',
    isSubagent: false,
    running: false
  }]
  const zero7 = T.buildSessionsModel({ rows: zeroRows, uncovered: 0 }, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(zero7.emptyKind, 'zeroActive', '全零活跃要说清"就是没有记录"，不许给"切全部"的指引')
  assert.equal(zero7.windowHint, '')
  assert.ok(zero7.zeroHint.length > 0)
  const zeroAll = T.buildSessionsModel({ rows: zeroRows, uncovered: 0 }, { view: 'a', windowDays: 0, workspace: '' }, SES_NOW, zh)
  assert.equal(zeroAll.emptyKind, 'zeroActive', '全部窗口 + 全零也要有提示（不许静默）')
  assert.ok(zeroAll.zeroHint.length > 0)
  const zBody = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, {
    sessions: {
      ids: ['z1'],
      byId: {
        z1: {
          id: 'z1',
          title: '零活跃',
          cwd: 'D:\\A',
          projectionValues: { usageDaily: { days: { '2026-09-25': 0 }, activeMs: 0, turns: 0, segments: 0, longestMs: 0 } }
        }
      }
    }
  }), zh), zh, null)
  const zHints = textsOf(findNodes(zBody, (n) => n.props && n.props['data-usage-role'] === 'ses-hint')).join('')
  assert.ok(zHints.includes('没有活跃时长记录'), '零活跃要说清原因：' + zHints)
  assert.ok(!zHints.includes('可看全日志总量'), '零活跃不许给"切全部可看全日志总量"的错误指引')
  // ⑤ 实测：B 视图 + 筛选没中时，两条提示都要在（口径提示不许被空态提示顶掉）
  const bMiss = T.renderSegment('sessions',
    T.buildModel(Object.assign({}, base, { prefs: { sesView: 'b', sesWorkspace: 'nope' } }), zh), zh, null)
  assert.equal(findNodes(bMiss, (n) => n.props && n.props['data-usage-role'] === 'ses-hint').length, 2,
    'B 视图的"只有逐日粒度"口径提示不许被"筛选没中"顶掉')
})

test('T23i 会话页条长 / 档位 / 柱高的基准是"全部会话"，不随工作区筛选跳变', () => {
  const all = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  const s1 = all.groups[0].sessions.filter((r) => r.id === 's1')[0]
  const s2 = all.groups[1].sessions.filter((r) => r.id === 's2')[0]
  assert.equal(s1.barPct, 100)
  assert.ok(Math.abs(s2.barPct - 11.111) < 0.01, '次长行 = 600000/5400000 ⇒ 约 11.1%（不是恒 100）：' + s2.barPct)
  // 筛到 wiki 只留 s2 ⇒ 基准仍是全局最大 ⇒ 条长不许跳到 100%
  const wiki = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'a', windowDays: 7, workspace: 'D:\\Work\\beta' }, SES_NOW, zh)
  assert.equal(wiki.groups[0].sessions[0].id, 's2')
  assert.ok(Math.abs(wiki.groups[0].sessions[0].barPct - 11.111) < 0.01,
    '筛选只改可见性、不改深浅的含义：' + wiki.groups[0].sessions[0].barPct)
  // B 视图同理，但**必须筛到"组里没有全局最大会话"的那个工作区** ——
  // 否则基准退回可见集合时该组基准不变、夹具蒙对（实测：筛到 A 组时三套检查仍 85/0 全绿）。
  // wiki 组只有 s2（600000），而全局最大单日是 s1 的 3600000 ⇒ 基准若退化，s2 的 09-25 会 1 档 → 4 档。
  const levelOf = (ws, idu, day) => {
    const m = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'b', windowDays: 7, workspace: ws }, SES_NOW, zh)
    const row = m.bands.filter((r) => r.id === idu)[0]
    return row.cells.filter((c) => c.key === day)[0].level
  }
  assert.equal(levelOf('', 's3', '2026-09-23'), 1)
  assert.equal(levelOf('D:\\Work\\beta', 's2', '2026-09-25'), 1,
    '筛到 wiki 后基准仍是全局最大（3600000）⇒ 600000 只能是 1 档；基准若退回可见集合会变 4 档')
  // C 视图逐日柱高比：s1 的 09-25 : 09-24 = 2 : 1（相对该会话窗口内最大日，不是每根自己 100）
  const c = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'c', windowDays: 7 }, SES_NOW, zh)
  const bars = {}
  for (const bar of c.selected.dayBars) bars[bar.key] = bar.heightPct
  assert.equal(bars['2026-09-25'], 100)
  assert.equal(bars['2026-09-24'], 50)
})

test('T23j 会话页排序：清单按时长降序，组按总量降序（夹具插入顺序与之相反，不许蒙对）', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_ORDER_SNAP), { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  const c = T.buildSessionsModel(T.collectSessionUsage(SES_ORDER_SNAP), { view: 'c', windowDays: 7 }, SES_NOW, zh)
  assert.deepEqual(c.listRows.map((r) => r.id), ['o1', 'o3', 'o4', 'o2'], '清单按时长降序（与夹具插入顺序不同）')
  assert.deepEqual(model.groups.map((g) => g.label), ['B', 'A'], '组按窗口内总量降序，不是按首次出现顺序')
  assert.deepEqual(model.groups[0].sessions.map((s) => s.id), ['o3', 'o4'])
  assert.deepEqual(model.groups[1].sessions.map((s) => s.id), ['o1', 'o2'])
})

test('T23k 会话页口径脚注在屏上；未来日键不进窗口合计', () => {
  const base = { stats, turnTimings, timeline, sessions: SES_SNAP, now: SES_NOW }
  const body = T.renderSegment('sessions', T.buildModel(Object.assign({}, base, { prefs: { sesView: 'a' } }), zh), zh, null)
  const caliber = findNodes(body, (n) => n.props && n.props['data-usage-role'] === 'ses-caliber')
  assert.equal(caliber.length, 1, '口径脚注必须在屏上（时长随窗口变 / 段数轮数不随窗口变）')
  assert.ok(textsOf(caliber).join('').includes('不随窗口变'), '脚注必须写明两类口径的差别')
  const future = T.buildSessionsModel({
    rows: [{
      id: 'f',
      title: 'f',
      cwd: '',
      days: { '2026-09-25': 60000, '2026-09-26': 99000000 },
      activeMs: 99060000,
      turns: 1,
      segments: 1,
      longestMs: 60000,
      lastDay: '2026-09-26',
      isSubagent: false,
      running: false
    }],
    uncovered: 0
  }, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(future.totalText, '1m00s', '未来日键（09-26）不许进窗口合计')
})

test('T23l 会话页 A 行尾是"全日志总量"（不是窗口内量）；荒谬大值被夹住', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  const s2 = model.groups[1].sessions[0]
  assert.equal(s2.activeText, '10m00s', '窗口内 = 600000（7 天）')
  assert.equal(s2.totalText, '25m00s', '全日志 = 1500000（含 08-31 那 15 分钟）—— 两个口径不许混')
  // 实测：MAX_SAFE_INTEGER 这类脏值不许原样上屏（旧版会渲染成 2501999792h59m）
  const huge = Number.MAX_SAFE_INTEGER
  const cleaned = T.collectSessionUsage({
    ids: ['z'],
    byId: { z: { projectionValues: { usageDaily: { days: { '2026-09-25': huge }, activeMs: huge, turns: huge, segments: huge, longestMs: huge } } } }
  })
  assert.equal(cleaned.rows[0].days['2026-09-25'], 86400000 * 3650, '毫秒类夹到 10 年量级上界')
  assert.equal(cleaned.rows[0].turns, 1e9, '计数类夹到上界')
  assert.equal(cleaned.rows[0].longestMs, 86400000 * 3650,
    'longestMs 也要夹 —— C 视图"最长段"会印它（此前零守护）')
  assert.equal(cleaned.rows[0].segments, 1e9,
    'segments 也要夹 —— A/B 行 meta"段数"会印它（此前零守护）')
  const z = T.buildSessionsModel(cleaned, { view: 'a', windowDays: 7, workspace: '' }, SES_NOW, zh)
  assert.equal(z.groups[0].sessions[0].activeText, '87600h00m', '渲染出来是有限值，不是荒谬数字')
})

test('T23m 形状兜底：空载体（ids:[] / byId:{}）+ projectionsBySession 也列得出；日历页同守卫', () => {
  const values = { usageDaily: { days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000 } }
  const shapes = [
    { label: '只有 projectionsBySession', snap: { projectionsBySession: { p1: { values } } } },
    { label: 'ids 是空数组', snap: { ids: [], projectionsBySession: { p1: { values } } } },
    { label: 'byId 是空对象', snap: { byId: {}, projectionsBySession: { p1: { values } } } }
  ]
  for (const s of shapes) {
    const collected = T.collectSessionUsage(s.snap)
    assert.equal(collected.rows.length, 1, s.label + ' ⇒ 会话页要列出来')
    assert.equal(collected.rows[0].id, 'p1')
    assert.equal(T.usageRowsOf(s.snap).length, 1, s.label + ' ⇒ 日历页也要读到（这条此前完全无守护）')
  }
  assert.equal(T.usageRowsOf(null).length, 0)
})

test('T23n C 视图选中态落在截断区时，把它挤进列表（不许静默换会话）', () => {
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_MANY_SNAP),
    { view: 'c', windowDays: 7, selectedId: 'b44' }, SES_NOW, zh)
  assert.equal(model.listRows.length, 40)
  assert.equal(model.selected.id, 'b44', '用户选中的会话必须还是它')
  assert.equal(model.listRows.filter((r) => r.active).length, 1, '而且列表里要有它的选中态')
  assert.equal(model.listRows.filter((r) => r.id === 'b44').length, 1,
    '被截掉时也要挤进列表（不许只在右栏出现 ⇒ 用户以为选错了）')
  assert.equal(model.selectedPinned, true, '发生挤回时要标记出来')
  // 🩸 复审实测：挤回之后"只列出前 40 个"字面不成立 ⇒ 脚注必须追加"你选中的会话已置顶"
  const pinnedBody = T.renderSegment('sessions', { sessions: model }, zh, null)
  const capNodes = findNodes(pinnedBody, (n) => n.props && n.props['data-usage-role'] === 'ses-capped')
  assert.equal(capNodes.length, 1)
  assert.ok(textsOf(capNodes).join('').includes('置顶'),
    '脚注要说清选中的会话被置顶：' + textsOf(capNodes).join(''))
})

test('T23o 「显示范围」偏好：默认 14 天、候选 7/14/30/不限，超范围不进清单（2026-10-14 定稿）', () => {
  assert.equal(T.DEFAULT_SESSION_RANGE, 14, '默认显示范围 14 天')
  assert.deepEqual(T.SESSION_RANGES.map((r) => r.value), ['7', '14', '30', '0'])
  // 夹具：一个 3 天前动过、一个 20 天前动过（SES_NOW = 2026-09-25）
  const snap = {
    ids: ['recent', 'stale'],
    byId: {
      recent: {
        id: 'recent',
        title: '三天前',
        cwd: 'D:\\A',
        projectionValues: { usageDaily: { days: { '2026-09-22': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000 } }
      },
      stale: {
        id: 'stale',
        title: '20 天前',
        cwd: 'D:\\A',
        projectionValues: { usageDaily: { days: { '2026-09-05': 2000 }, activeMs: 2000, turns: 1, segments: 1, longestMs: 2000 } }
      }
    }
  }
  const def = T.buildSessionsModel(T.collectSessionUsage(snap), { view: 'a', windowDays: 0 }, SES_NOW, zh)
  assert.equal(def.rangeDays, 14)
  assert.deepEqual(def.groups[0].sessions.map((s) => s.id), ['recent'], '20 天前那个默认不显示')
  const d7 = T.buildSessionsModel(T.collectSessionUsage(snap), { view: 'a', windowDays: 0, rangeDays: 7 }, SES_NOW, zh)
  assert.equal(d7.groups[0].sessions.length, 1, '7 天内只留 3 天前那个')
  const wide = T.buildSessionsModel(T.collectSessionUsage(snap), { view: 'a', windowDays: 0, rangeDays: 0 }, SES_NOW, zh)
  assert.equal(wide.rangeDays, 0)
  assert.equal(wide.groups[0].sessions.length, 2, '「不限」时两个都显示')
  // 渲染：🩸 2026-10-14 定稿「**合并成一个吧**」⇒ 工具条里**不再**有独立的「显示范围」控件，
  // 只剩一个「时间范围」（它同时决定统计窗口与列出范围）；候选里多了「近 14 天」这一档。
  const body = T.renderSegment('sessions', { sessions: def }, zh, null)
  const groups = findNodes(body, (n) => n.props && typeof n.props['data-group'] === 'string').map((b) => b.props['data-group'])
  assert.ok(groups.includes('ses.win'), '工具条要有时间范围控件：' + JSON.stringify(groups))
  assert.ok(!groups.includes('ses.range'), '合并后不许再有独立的显示范围控件：' + JSON.stringify(groups))
  assert.deepEqual(T.SESSION_WINDOWS.map((x) => x.value), ['7', '14', '30', '0'], '合并后的候选 = 近 7/14/30 天/全部')
  assertClean(body, 'sessions(range)')
})

test('T25 会话页子代理构成（A5）：与清单同口径的占比 + 没有子代理就整卡不挂', () => {
  const full = T.buildModel({
    sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const s = full.sessions.subagentStats
  // 同口径：分母必须是**清单里的会话数**（否则会出现"卡头 531、子代理 400"这种对不上的数）
  assert.equal(s.sessions, full.sessions.countText.replace(/\D/g, '') * 1, '分母 = 卡头的会话数')
  assert.ok(s.subSessions >= 0 && s.subSessions <= s.sessions, '子会话数不可能超过总数')
  assert.ok(s.countPct >= 0 && s.countPct <= 100)
  assert.ok(s.activePct >= 0 && s.activePct <= 100)
  assert.equal(s.countText, T.formatCount(s.subSessions) + ' / ' + T.formatCount(s.sessions))
  assert.equal(s.activeText, T.formatDuration(s.subActiveMs) + ' / ' + T.formatDuration(s.allActiveMs))
  const tree = T.renderSegment('sessions', full, zh, null)
  const cards = findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'ses-subagent-card')
  assert.equal(cards.length, s.subSessions > 0 ? 1 : 0, '有子代理才挂卡')
  if (s.subSessions > 0) {
    // 两条占比条的宽度必须落在 0~100（脏值会被夹住，不许出现 NaN% / 负数）
    const bars = findNodes(cards[0], (n) => n.props && n.props.className === 'ut-sub-bar')
    assert.equal(bars.length, 2, '数量 + 时长两条')
    for (const bar of bars) {
      const w = Number(String(bar.props.style.width).replace('%', ''))
      assert.ok(isFinite(w) && w >= 0 && w <= 100, '条宽必须在 0~100：' + bar.props.style.width)
    }
  }
  assertClean(tree, 'sessions(A5)')
  // 🩸 实测：补"带工作区筛选"的一路 —— 原先只测无筛选，把分母换成别的量都打不红
  const filtered = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP),
    { view: 'a', windowDays: 0, workspace: 'D:\\Work\\beta' }, SES_NOW, zh)
  assert.equal(filtered.subagentStats.sessions, 1, '筛选后清单只剩 1 个会话')
  assert.equal(filtered.subagentStats.subSessions, 0, '该工作区里没有子代理')
  assert.equal(filtered.subagentStats.countText, '0 / 1', '分母必须是**筛选后**的清单长度')
  assert.equal(Number(filtered.countText.replace(/\D/g, '')), filtered.subagentStats.sessions,
    'subagentStats 的分母要与卡头同源（筛选后）')
  // 🩸 反向路径：**清单里没有子代理**时整卡不许出现（否则会挂一张"0 / 4"的空卡；
  //    V88 最初打不红就是因为只测了"有子代理"这一半 —— 记一次教训）
  const noSubSnap = Object.assign({}, SES_SNAP, {
    byId: Object.assign({}, SES_SNAP.byId, { s3: Object.assign({}, SES_SNAP.byId.s3, { origin: undefined }) })
  })
  const noSub = T.buildModel({
    sessions: noSubSnap, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  assert.equal(noSub.sessions.subagentStats.subSessions, 0, '抹掉 origin 后就该是 0 个')
  const noSubTree = T.renderSegment('sessions', noSub, zh, null)
  assert.equal(findNodes(noSubTree, (n) => n.props && n.props['data-usage-role'] === 'ses-subagent-card').length, 0,
    '没有子代理会话 ⇒ 不许挂空卡')
})

test('T34 四条修复的守护：<other> 守恒 / 留痕键长封顶 / 孤儿 call 计数 / 同毫秒真实事件不吞', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0, 0)
  // 🩸 实测：`<other>` 合并不许覆盖旧累计 —— 250 次不同工具调用必须**计数守恒**
  const many = []
  for (let i = 0; i < 250; i += 1) {
    many.push(hostEvent('tool/call', t0 + i * 1000, { toolName: 'tool_' + i }))
    many.push(hostEvent('tool/result', t0 + i * 1000 + 500, {}))
  }
  const st = foldAll(many)
  const sumCalls = Object.keys(st.byTool).reduce((acc, k) => acc + st.byTool[k].calls, 0)
  assert.equal(sumCalls, 250, '250 次调用必须**一次不丢**（含并进 <other> 的）：实际 ' + sumCalls)
  assert.equal(Object.keys(st.byTool).length, HOST.MAX_TOOL_KINDS, '桶数 = 上限')
  assert.ok(st.byTool['<other>'].calls >= 250 - (HOST.MAX_TOOL_KINDS - 1), '<other> 要累计所有被合并的')
  // 🩸 同一条守恒纪律对 `byModel` / `turnOutcomes`（走 `cleanCounts`）也必须成立 ——
  //   V102r 第一版打不红就是因为只断言了 byTool 这一半。
  const modelEvents = []
  for (let i = 0; i < 250; i += 1) {
    modelEvents.push(hostEvent('model/selection', t0 + i * 1000, { modelId: 'm_' + i }))
  }
  const mst = foldAll(modelEvents)
  const modelSum = Object.keys(mst.byModel).reduce((acc, k) => acc + mst.byModel[k], 0)
  assert.equal(modelSum, 250, 'byModel 的计数也必须守恒（<other> 不许覆盖旧累计）：实际 ' + modelSum)
  // 🩸 实测：留痕键长必须封顶（否则单键能到 MiB 级、随列表行下发）
  const hugeKey = 'x'.repeat(5000)
  const hugeData = {}
  hugeData[hugeKey] = 1
  const huge = foldAll([hostEvent('tool/call', t0, hugeData)])
  const hugeShapeKeys = Object.keys(huge.toolShapes)
  assert.equal(hugeShapeKeys.length, 0, '超长字段名不许进留痕：' + hugeShapeKeys.map((k) => k.length).join(','))
  assert.ok(JSON.stringify(huge).length < 5000, '状态不许被单个超长键撑大：' + JSON.stringify(huge).length)
  // 两个清洗函数（toolShapes / eventShapes）都要守 —— 只测一个的话，另一个漏了也不会响（V102s 第一版就这么打不红）
  const hugeEvent = foldAll([hostEvent('model/selection', t0, hugeData)])
  const evtShapeKeys = Object.keys(hugeEvent.eventShapes)
  assert.equal(evtShapeKeys.length, 0,
    '超长字段名同样不许进 eventShapes：长度=' + JSON.stringify(evtShapeKeys.map((k) => k.length)))
  assert.ok(JSON.stringify(hugeEvent).length < 5000,
    'eventShapes 侧也不许被撑大：实际 ' + JSON.stringify(hugeEvent).length + ' 内容=' + JSON.stringify(hugeEvent).slice(0, 400))
  // 🩸 实测：孤儿 `tool/call`（没有 result）**也要计次数**
  const orphan = foldAll([
    hostEvent('tool/call', t0, { toolName: 'a' }),
    hostEvent('tool/call', t0 + 1000, { toolName: 'b' })
  ])
  assert.equal(orphan.byTool.a.calls, 1, '孤儿 call 要有次数（原来连计数都不留）')
  assert.equal(orphan.byTool.b.calls, 1)
  assert.equal(orphan.byTool.a.ms, 0, '没有 result ⇒ 耗时不可知（记 0，不许编）')
  // 🩸 实测：**真实**的同毫秒 `turn/end` 不许被当 fork closer 吞掉
  const sameMs = foldAll([
    hostEvent('turn/start', t0),
    hostEvent('turn/end', t0, { reason: 'completed' })   // 与上一条同毫秒
  ])
  assert.deepEqual(sameMs.turnOutcomes, { completed: 1 },
    '同毫秒的真实 turn/end 必须记上（原来会被 isAnchorSameMs 吞掉）：' + JSON.stringify(sameMs.turnOutcomes))
})

test('T33 实测两处修：工具配对的时间上界 + turn/end 原因的宽探测（含值类型留痕）', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0, 0)
  // 正常配对：3 秒
  const ok = foldAll([
    hostEvent('tool/call', t0, { toolName: 'pwsh' }),
    hostEvent('tool/result', t0 + 3000, {})
  ])
  assert.deepEqual(ok.byTool.pwsh, { calls: 1, ms: 3000 }, '正常配对照常算耗时')
  // 🩸 实测 bug：某次 result 缺失 ⇒ 与 5 小时后的 call 配对 ⇒ 累计出荒谬值（实测 job_output 24h36s/50 次）
  const bad = foldAll([
    hostEvent('tool/call', t0, { toolName: 'job_output' }),
    hostEvent('tool/result', t0 + 5 * 3600000, {})
  ])
  assert.deepEqual(bad.byTool.job_output, { calls: 1, ms: 0 },
    '超过上界 ⇒ **只计次数、耗时记 0**（宁可少算，不许撒谎）')
  // 🩸 实测：`turn/end` 的 reason 是**对象**（留痕 `reason:object,turn:number`）
  const e1 = foldAll([hostEvent('turn/end', t0, { reason: { kind: 'completed' }, turn: 1 })])
  assert.deepEqual(e1.turnOutcomes, { completed: 1 }, 'reason 是对象时取里面的 kind')
  const e2 = foldAll([hostEvent('turn/end', t0, { reason: { a: 1, b: 2 }, turn: 1 })])
  assert.deepEqual(Object.keys(e2.turnOutcomes), ['<reason:a,b>'], '取不到 kind 就把它的字段名记下来')
  // 留痕要带**值的类型**（下次一眼看清"字段在、但类型不对"）
  const e3 = foldAll([hostEvent('model/selection', t0, { weird: { x: 1 } })])
  const sig = Object.keys(e3.eventShapes)[0]
  assert.ok(sig.indexOf('weird:object') !== -1, '留痕要带值的类型：' + sig)
})

test('T32 宿主统计卡：工具 / 模型 / 结束原因 / 压缩 + 形状留痕必须上屏；没数据整卡不挂', () => {
  const snap = {
    sessions: {
      ids: ['s1'],
      byId: {
        s1: {
          id: 's1', title: 't', cwd: 'D:\\A',
          projectionValues: { usageDaily: {
            days: { '2026-09-25': 9000000 },
            activeMs: 9000000, turns: 2, segments: 1, longestMs: 9000000,
            byTool: { pwsh: { calls: 3, ms: 60000 }, browser_click: { calls: 1, ms: 5000 } },
            byModel: { 'deepseek-v3': 2 },
            turnOutcomes: { completed: 1, aborted: 1 },
            compactions: 2,
            toolShapes: { 'shape,totally': 1 }
          } }
        }
      }
    },
    now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }
  const full = T.buildModel(snap, zh)
  assert.equal(full.hostStats.hasData, true, '有宿主统计 ⇒ hasData')
  assert.equal(full.hostStats.tools[0].label, 'pwsh', '工具按耗时降序（60000 > 5000）')
  // 🩸 实测发现：**这里原来是 `indexOf('次')`** —— 它查的就是我自己写的文案 `hs.calls="次"`，
  //    **恒真**（把 `obj.calls` 删掉、上屏变「1m00s 次」，测试照样全绿）⇒ 改成**数据断言**。
  assert.ok(full.hostStats.tools[0].valueText.indexOf('3') !== -1,
    '工具行要带**调用次数**（数据断言，别再查文案字）：' + full.hostStats.tools[0].valueText)
  // 🩸 实测：`compactions` 上屏原先**零断言** ⇒ 聚合漏掉它也全绿
  assert.equal(full.hostStats.compactionText.indexOf('2'), 0,
    '压缩次数要以夹具里的 2 开头：' + full.hostStats.compactionText)
  const tree = T.renderSegment('overview', full, zh, null)
  const cards = findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'host-stats-card')
  assert.equal(cards.length, 1, '统计卡要挂上')
  const texts = textsOf(tree).join(' ')
  assert.ok(texts.indexOf('pwsh') !== -1 && texts.indexOf('deepseek-v3') !== -1, '工具名与模型名都要上屏')
  assert.ok(texts.indexOf('completed') !== -1 || texts.indexOf('aborted') !== -1, '结束原因要上屏')
  // 🩸 形状留痕是"定稿未知字段名"的唯一途径 ⇒ 必须上屏
  const notes = findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'host-shape-notes')
  assert.equal(notes.length, 1, '有未识别形状时必须显示留痕')
  assert.ok(textsOf(notes[0]).join(' ').indexOf('shape,totally') !== -1, '留痕里要能看到字段名')
  // 没有宿主统计 ⇒ 整卡不挂（不挂空壳）
  const plain = T.buildModel({
    sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  assert.equal(findNodes(T.renderSegment('overview', plain, zh, null),
    (n) => n.props && n.props['data-usage-role'] === 'host-stats-card').length, 0, '没有宿主统计 ⇒ 不许挂空卡')
  // 🩸 实测发现：**只有"形状留痕"时卡也必须挂** —— 留痕存在的唯一目的就是定稿字段名，
  //    若因 hasData 不含它而整卡不挂 ⇒ 唯一诊断线索静默消失（已用真 foldUsageDaily 端到端复现过）。
  const onlyShapes = T.buildModel({
    sessions: { ids: ['s1'], byId: { s1: { id: 's1', title: 't', cwd: 'D:\\A',
      projectionValues: { usageDaily: {
        days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000,
        toolShapes: { 'shape,totally': 3 }
      } } } } },
    now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  assert.equal(onlyShapes.hostStats.hasData, true, '只有留痕也必须算"有数据"')
  assert.equal(findNodes(T.renderSegment('overview', onlyShapes, zh, null),
    (n) => n.props && n.props['data-usage-role'] === 'host-shape-notes').length, 1,
    '只有留痕时卡与留痕块都必须上屏')
  // 🩸 实测发现：`ms = 0`（超上界配对归零）的工具**不许整行消失**，次数要照显
  const zeroMs = T.buildModel({
    sessions: { ids: ['s1'], byId: { s1: { id: 's1', title: 't', cwd: 'D:\\A',
      projectionValues: { usageDaily: {
        days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000,
        byTool: { slow_unknown: { calls: 7, ms: 0 } }
      } } } } },
    now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const zeroRow = zeroMs.hostStats.tools.filter((r) => r.label === 'slow_unknown')[0]
  assert.ok(zeroRow, 'ms=0 的工具必须仍在排行里（不能让可信的"次数"一起消失）')
  assert.ok(zeroRow.valueText.indexOf('7') !== -1, '次数要显示：' + zeroRow.valueText)
  // 🩸 实测发现：截断**不许静默** —— 造 15 个工具，必须出现"另有 N 条"
  const manyTools = {}
  for (let i = 0; i < 15; i += 1) manyTools['t' + String(i).padStart(2, '0')] = { calls: 1, ms: (15 - i) * 1000 }
  const manyModel = T.buildModel({
    sessions: { ids: ['s1'], byId: { s1: { id: 's1', title: 't', cwd: 'D:\\A',
      projectionValues: { usageDaily: {
        days: { '2026-09-25': 1000 }, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000,
        byTool: manyTools
      } } } } },
    now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  assert.equal(manyModel.hostStats.tools.length, 12, '榜单最多 12 条')
  assert.ok(manyModel.hostStats.hiddenText.indexOf('3') !== -1,
    '被截掉的 3 条要写出来（不许静默）：' + manyModel.hostStats.hiddenText)
  assert.equal(findNodes(T.renderSegment('overview', manyModel, zh, null),
    (n) => n.props && n.props['data-usage-role'] === 'host-stats-hidden').length, 1, '截断提示要上屏')
  assertClean(tree, 'overview(hostStats)')
})

test('T31 宿主半其它统计：模型轮数 / 轮结束原因 / 压缩次数 / 未知形状留痕 / 同毫秒锚点不记', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0, 0)
  const state = foldAll([
    hostEvent('model/selection', t0, { modelId: 'deepseek-v3' }),
    hostEvent('turn/start', t0 + 1000),
    hostEvent('turn/end', t0 + 60000, { reason: 'completed' }),
    hostEvent('model/selection', t0 + 70000, { modelId: 'deepseek-v3' }),
    hostEvent('turn/start', t0 + 71000),
    hostEvent('turn/end', t0 + 131000, { status: 'aborted' }),
    hostEvent('compaction/start', t0 + 140000),
    hostEvent('compaction/start', t0 + 150000),
    hostEvent('model/selection', t0 + 160000, { weird: 1 })
  ])
  assert.deepEqual(state.byModel, { 'deepseek-v3': 2 }, '按模型累计轮数（宽探测 modelId）')
  assert.deepEqual(state.turnOutcomes, { completed: 1, aborted: 1 }, '按结束原因累计（宽探测 reason / status）')
  assert.equal(state.compactions, 2, '压缩次数')
  assert.ok(Object.keys(state.eventShapes).some((k) => k.indexOf('model/selection|') === 0),
    '认不出的模型形状要留痕：' + JSON.stringify(state.eventShapes))
  assert.ok(state.activeMs > 0, '🩸 turn/end 仍必须是活跃事件（不许被统计分支分流走）')
  const view = HOST.usageDailyViewOf(state)
  assert.equal(view.byModel['deepseek-v3'], 2)
  assert.equal(view.turnOutcomes.completed, 1)
  assert.equal(view.compactions, 2)
  // 🩸 同毫秒锚点：清账后紧跟的合成 closer（turn/end）**什么都不该记**
  const anchor = CAL_DAY(2026, 9, 25, 12, 0, 0)
  let seeded = HOST.foldUsageDaily(HOST.initUsageDailyState(), hostEvent('session/end-seed', anchor, { inherited: true }))
  const before = JSON.stringify(seeded.turnOutcomes)
  seeded = HOST.foldUsageDaily(seeded, hostEvent('turn/end', anchor, { reason: 'forked' }))
  assert.equal(JSON.stringify(seeded.turnOutcomes), before, '同毫秒 closer 不记原因（否则破坏"返回同一引用"口径）')
  // 脏输入
  assert.deepEqual(HOST.usageDailyStateSchema.parse({ byModel: { m: -3 }, compactions: -1 }).byModel, {})
  assert.equal(HOST.usageDailyStateSchema.parse({ compactions: -1 }).compactions, 0)
})

test('T30 按工具名统计（宿主半）：配对算耗时 / 宽探测 / 未知形状留痕 / 不污染活跃口径', () => {
  const t0 = CAL_DAY(2026, 9, 25, 10, 0, 0)
  const state = foldAll([
    hostEvent('turn/start', t0),
    hostEvent('tool/call', t0 + 1000, { toolName: 'pwsh' }),
    hostEvent('tool/result', t0 + 4000, {}),
    hostEvent('tool/call', t0 + 5000, { name: 'browser_click' }),
    hostEvent('tool/result', t0 + 6000, {}),
    hostEvent('tool/call', t0 + 7000, { totally: 'unknown', shape: 1 }),
    hostEvent('tool/result', t0 + 9000, {})
  ])
  assert.deepEqual(state.byTool, {
    pwsh: { calls: 1, ms: 3000 },
    browser_click: { calls: 1, ms: 1000 },
    '<unknown>': { calls: 1, ms: 2000 }
  }, '按名累计调用次数与耗时（宽探测：toolName / name 两档都认）')
  const shapes = Object.keys(state.toolShapes)
  assert.equal(shapes.length, 1, '认不出的形状要留一条诊断：' + JSON.stringify(state.toolShapes))
  // 🩸 该修复后：留痕格式改成 `事件类型|字段:类型,...`（带**值类型**，一眼看清"字段在但类型不对"）
  assert.ok(shapes[0].indexOf('totally') !== -1 && shapes[0].indexOf('shape') !== -1,
    '诊断表要记下字段名（现在是带类型的格式）：' + shapes[0])
  assert.equal(state.activeMs, 9000, '🩸 工具记账**不推进 lastTime** ⇒ 活跃口径不受影响')
  assert.equal(state.days['2026-09-25'], 9000)
  // 内部游标不下发；工具账与诊断表要下发
  const view = HOST.usageDailyViewOf(state)
  assert.equal(view.openToolName, undefined, '内部游标不下发（列表行要瘦）')
  assert.equal(view.byTool.pwsh.calls, 1)
  const shapeKey = Object.keys(view.toolShapes)[0]
  assert.ok(shapeKey !== undefined && shapeKey.indexOf('totally') !== -1,
    'view 里也要能看到留痕（现在是带类型的格式）：' + shapeKey)
  // 脏输入：负计数 / 非法键一律丢
  assert.deepEqual(HOST.usageDailyStateSchema.parse({ byTool: { x: { calls: -1, ms: -5 } } }).byTool, {})
  assert.deepEqual(HOST.usageDailyStateSchema.parse({ toolShapes: { a: -1 } }).toolShapes, {})
  // 🩸 `tool/result` 必须**留在活跃白名单里**（我今晚就把它分流出去过 ⇒ 每个工具调用后的时长全丢）
  assert.ok(foldAll([hostEvent('turn/start', t0), hostEvent('tool/result', t0 + 60000)]).activeMs === 60000,
    'tool/result 仍是活跃事件（不许从活跃口径里拿走）')
})

test('T29 K 线（A7·甲按天）：开=前一天、收=当天 / 纵轴 0~24h / 屏上标明无影线', () => {
  const agg = {
    hasData: true,
    sessions: 2,
    days: { '2026-09-23': 1000000, '2026-09-24': 3000000, '2026-09-25': 2000000 }
  }
  const m = T.buildKlineModel(agg, SES_NOW, zh)
  assert.equal(m.hasData, true)
  assert.equal(m.rows.length, T.KLINE_DAYS, '每天一根蜡烛')
  assert.equal(m.axisMaxMs, T.KLINE_AXIS_MS, '纵轴基准 = 24h')
  const last = m.rows[m.rows.length - 1]
  const prev = m.rows[m.rows.length - 2]
  assert.equal(last.key, '2026-09-25')
  assert.equal(last.ms, 2000000, '收盘 = 当天')
  assert.equal(last.openMs, 3000000, '开盘 = 前一天')
  assert.equal(last.dir, 'down', '收 < 开 ⇒ down')
  assert.equal(prev.openMs, 1000000, '前一根的开盘 = 它的前一天')
  assert.equal(prev.dir, 'up')
  // 实体 = 开~收 的区间（按 24h 刻度换算）
  assert.equal(Math.round(prev.bottomPct), Math.round((1000000 / T.KLINE_AXIS_MS) * 100))
  assert.equal(Math.round(prev.heightPct), Math.round(((3000000 - 1000000) / T.KLINE_AXIS_MS) * 100))
  assert.equal(Math.round(last.heightPct), Math.round(((3000000 - 2000000) / T.KLINE_AXIS_MS) * 100))
  // 第一天：开盘 = 0
  const first = m.rows.find((row) => row.ms === 1000000)
  assert.equal(first.openMs, 0, '第一天以 0 为开盘')
  assert.equal(first.dir, 'up')
  // 纵轴刻度：0 / 6 / 12 / 18 / 24h
  assert.deepEqual(m.ticks.map((t) => t.label), ['0h', '6h', '12h', '18h', '24h'])
  // 日累计 > 24h（多会话并行）⇒ 刻度向上取到整 6h，保证画得下
  const big = T.buildKlineModel({ hasData: true, days: { '2026-09-25': 30 * 3600000 } }, SES_NOW, zh)
  assert.equal(big.axisMaxMs, 30 * 3600000, '超过 24h 的日累计要撑开刻度')
  // 空 / 全零 ⇒ 不给图
  assert.equal(T.buildKlineModel({ hasData: true, days: {} }, SES_NOW, zh).hasData, false)
  assert.equal(T.buildKlineModel(null, SES_NOW, zh).hasData, false)
  // 渲染：蜡烛数 = 行数；网格线 = 刻度数；屏上必须写明无影线 / 涨红跌绿 / 开收语义
  const full = T.buildModel({
    sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const tree = T.renderSegment('kline', full, zh, null)
  assert.equal(findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'kline-candle').length,
    T.KLINE_DAYS, '蜡烛数 = 窗口天数')
  assert.equal(findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'kline-gridline').length,
    5, '纵轴 0/6/12/18/24h 五条网格线')
  const texts = textsOf(tree).join(' ')
  assert.ok(texts.indexOf('无影线') !== -1, '必须写明无影线（2026-10-14 定稿回到无影线版）')
  assert.ok(texts.indexOf('涨红跌绿') !== -1, '必须写明涨红跌绿（2026-10-14 明确要的）')
  // 🩸 2026-10-14 回退：影线版**已作废** —— 小时桶只有重启后的日子才有 ⇒ 两套口径混画 =
  //    需求里的"数据冲突" ⇒ **不许再画出影线**（哪怕该天有小时桶）。
  const spanned = T.buildModel({
    sessions: {
      ids: ['s1'],
      byId: {
        s1: {
          id: 's1', title: 't', cwd: 'D:\\A',
          projectionValues: { usageDaily: {
            days: { '2026-09-25': 9000000 },
            hoursByDay: { '2026-09-25': { '9': 1000000, '10': 2000000, '11': 3000000, '15': 3000000 } },
            activeMs: 9000000, turns: 1, segments: 1, longestMs: 9000000
          } }
        }
      }
    },
    now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const spannedTree = T.renderSegment('kline', spanned, zh, null)
  const wickCount = findNodes(spannedTree, (n) => n.props && n.props['data-usage-role'] === 'kline-wick').length
  assert.equal(wickCount, 0, '无影线版不许画影线（混画两套口径 = "数据冲突"）· 实际影线数=' + wickCount)
  // 🩸 实测发现：**窗口第一天不许给方向** —— `open` 硬编码 0、`close > 0` 会被判成"涨"，
  //    而 60 天窗口滚动 ⇒ **每屏必有一根假涨**。夹具特意让"第一天就有量"，否则天然通过、打不红。
  const firstKey = m.rows[0].key
  const firstDayDays = {}
  firstDayDays[firstKey] = 5000000
  const onlyFirst = T.buildKlineModel({ hasData: true, sessions: 1, days: firstDayDays }, SES_NOW, zh)
  assert.ok(onlyFirst.rows[0].ms > 0, '前提：这个夹具要让窗口第一天确实有量')
  assert.equal(onlyFirst.rows[0].dir, 'flat',
    '窗口第一天没有可比对象 ⇒ 必须 flat（不许无中生有一根涨）：dir=' + onlyFirst.rows[0].dir)
  // 🩸 实测发现：纵轴要有**业务上界**（否则极端输入算出 7301 条网格线、渲染节点爆到 14735）
  const hugeDays = {}
  hugeDays[firstKey] = 3.15e11
  const hugeAxis = T.buildKlineModel({ hasData: true, sessions: 1, days: hugeDays }, SES_NOW, zh)
  assert.ok(hugeAxis.axisMaxMs <= 96 * 3600000, '纵轴要有上界（96h）：' + hugeAxis.axisMaxMs)
  assert.ok(hugeAxis.ticks.length <= 20, '刻度数要可控：' + hugeAxis.ticks.length)
  assertClean(tree, 'kline(A7)')
})

test('T28 每周目标（A4）：白名单归一化 / 只在设了目标时给进度 / tip 写明目标', () => {
  // 白名单：只认表里的值，其余静默回退默认（与 idle / range 同一条口径）
  assert.equal(T.normalizePrefs({ weeklyGoalMinutes: 600 }).weeklyGoalMinutes, 600)
  assert.equal(T.normalizePrefs({ weeklyGoalMinutes: '1200' }).weeklyGoalMinutes, 1200, '数字串也吃')
  assert.equal(T.normalizePrefs({ weeklyGoalMinutes: 601 }).weeklyGoalMinutes, 0, '不在白名单 ⇒ 回退默认')
  assert.equal(T.normalizePrefs({ weeklyGoalMinutes: -600 }).weeklyGoalMinutes, 0)
  assert.equal(T.normalizePrefs({}).weeklyGoalMinutes, 0)
  assert.equal(T.PREF_WEEKLY_GOALS[0].value, 0, '第一项必须含 0（关）')
  const base = { sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS }
  const off = T.buildModel(Object.assign({}, base, { prefs: { weeklyGoalMinutes: 0 } }), zh)
  const weekOff = off.calendar.cumKpis.find((k) => k.key === 'week')
  assert.equal(weekOff.progress, undefined, '目标 = 0 ⇒ 不给进度')
  const on = T.buildModel(Object.assign({}, base, { prefs: { weeklyGoalMinutes: 300 } }), zh)
  const weekOn = on.calendar.cumKpis.find((k) => k.key === 'week')
  assert.ok(typeof weekOn.progress === 'number' && isFinite(weekOn.progress) &&
    weekOn.progress >= 0 && weekOn.progress <= 100, '进度必须在 0~100：' + weekOn.progress)
  assert.ok(weekOn.progressTip.indexOf('每周目标') !== -1, 'tip 要写明目标值：' + weekOn.progressTip)
  // 渲染层：进度条只在设了目标时出现（否则会挂一条恒 0 的空条）
  const treeOff = T.renderSegment('calendar', off, zh, null)
  const treeOn = T.renderSegment('calendar', on, zh, null)
  assert.equal(findNodes(treeOff, (n) => n.props && n.props['data-usage-role'] === 'kpi-progress').length, 0,
    '目标关着时不许挂进度条')
  assert.equal(findNodes(treeOn, (n) => n.props && n.props['data-usage-role'] === 'kpi-progress').length, 1)
  // 设置页必须有这个偏好组（否则设不了目标 ⇒ 功能等于不存在）
  const setTree = T.renderSegment('settings', on, zh, () => {})
  const goalGroup = findNodes(setTree, (n) => n.props && n.props['data-usage-role'] === 'pref.goal')
  assert.equal(goalGroup.length, 1, '设置页要有「每周目标」组')
  assert.equal(findNodes(goalGroup[0], (n) => n.props && n.props['data-usage-role'] === 'seg-btn').length,
    T.PREF_WEEKLY_GOALS.length, '候选 = 白名单长度')
  assertClean(off, 'calendar(A4-off)')
})

test('T27 导出 Markdown（A2）：纯函数 / 表格转义 / 脏模型不崩 / 按钮在设置页', () => {
  const full = T.buildModel({
    sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const md = T.buildMarkdownReport(full, zh, SES_NOW)
  assert.equal(typeof md, 'string')
  assert.ok(md.startsWith('# '), '要以标题开头')
  assert.ok(md.endsWith('\n'), '要以换行结尾')
  assert.ok(!/NaN|undefined|\[missing:/.test(md), '报告里不许出现 NaN / undefined / [missing:]')
  for (const heading of ['## 本会话概览', '## 日历', '## 会话', '## 口径说明']) {
    assert.ok(md.indexOf(heading) !== -1, '缺区块：' + heading)
  }
  // 报告**不许**提 token / 费用（那是别的插件的数据源，本插件拿不到）
  assert.ok(md.indexOf('token') === -1 && md.indexOf('费用') === -1, '不许写拿不到的数据')
  // 表格转义：竖线要转义、单元格里的换行要压平（否则表格被撑破）
  const dirty = T.buildMarkdownReport({ kpis: [{ key: 'k', label: 'a|b', value: 'c\nd' }] }, zh, SES_NOW)
  assert.ok(dirty.indexOf('a\\|b') !== -1, '竖线必须转义')
  assert.ok(dirty.indexOf('c\nd') === -1, '单元格里的换行要压平')
  // 空 / 脏模型一律不许崩、不许印脏值
  for (const bad of [null, undefined, {}, { kpis: null, calendar: null, sessions: null }]) {
    const out = T.buildMarkdownReport(bad, zh, SES_NOW)
    assert.ok(typeof out === 'string' && out.length > 0, '空模型也要出报告')
    assert.ok(!/NaN|undefined|\[missing:/.test(out), '空模型报告里有脏值：' + out.slice(0, 120))
  }
  // 文件名时间戳形状（YYYYMMDD-HHmm）—— 坏输入退回"现在"，不许 NaN
  assert.ok(/^\d{8}-\d{4}$/.test(T.stampOf(SES_NOW)), '文件名时间戳形状：' + T.stampOf(SES_NOW))
  assert.ok(/^\d{8}-\d{4}$/.test(T.stampOf(NaN)), '坏时间戳退回现在：' + T.stampOf(NaN))
  // 渲染层：设置页要有导出按钮
  const tree = T.renderSegment('settings', full, zh, () => {})
  assert.equal(findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'export-btn').length, 1,
    '设置页要有导出按钮')
  // 🩸 实测发现（marked 实测能撑破表格）：反斜杠必须先转、裸 CR 必须压平
  const inj = T.buildMarkdownReport({ kpis: [{ key: 'k', label: 'a\\|b', value: 'x\ry' }] }, zh, SES_NOW)
  assert.ok(inj.indexOf('a\\\\\\|b') !== -1,
    '反斜杠要先转义再转竖线（a\\|b ⇒ a\\\\\\|b）：' + JSON.stringify((inj.match(/a.*b/) || [''])[0]))
  assert.equal(inj.indexOf('\r'), -1, '不许留裸 CR（CommonMark 里它就是行尾）')
  assert.ok(inj.indexOf('\\\\') !== -1 || inj.indexOf('a') !== -1)
  // 🩸 实测：对象形状不许印成 `[object Object]` / `(undefined)`
  const objShape = T.buildMarkdownReport({
    kpis: [{ key: 'k', label: {}, value: {} }],
    calendar: { hasData: true, cumKpis: [{ key: 'week', label: '本周', value: '1h', delta: {} }] }
  }, zh, SES_NOW)
  assert.equal(objShape.indexOf('[object Object]'), -1, '对象不许 String() 上屏')
  assert.equal(objShape.indexOf('(undefined)'), -1, 'delta 形状对但 text 非串时不许印 (undefined)')
  // 🩸 实测：超范围时间戳要退回"现在"，文件名不许 NaN
  assert.ok(/^\d{8}-\d{4}$/.test(T.stampOf(1e15)), '超范围要退回现在：' + T.stampOf(1e15))
  assert.ok(/^\d{8}-\d{4}$/.test(T.stampOf(-1e15)), '负超范围也要退回现在：' + T.stampOf(-1e15))
  assertClean(md, 'export-md')
})

test('T26 日历页工作区趋势（A6）：按周分桶 / 未来与脏键不算 / 卡挂得上', () => {
  const rows = T.collectSessionUsage(SES_SNAP).rows
  const trend = T.buildWorkspaceTrend(rows, SES_NOW, zh)
  assert.equal(trend.hasData, true)
  assert.ok(trend.rows.length <= T.WS_TREND_LIMIT, '最多列前 N 个工作区')
  for (const row of trend.rows) {
    assert.equal(row.bars.length, T.WS_TREND_WEEKS, '每周一根柱')
    for (const bar of row.bars) {
      assert.ok(isFinite(bar.heightPct) && bar.heightPct >= 0 && bar.heightPct <= 100, '柱高必须 0~100：' + bar.heightPct)
    }
    assert.ok(row.label.length > 0)
    assert.ok(row.totalText.length > 0)
  }
  // 未知工作区（cwd 为空）要能列出来、不许炸
  const unknown = T.buildWorkspaceTrend([{ cwd: '', days: { '2026-09-25': 1000 } }], SES_NOW, zh)
  assert.equal(unknown.hasData, true)
  assert.equal(unknown.rows[0].label, '未知工作区')
  // 🩸 实测：原夹具用 `2099-01-01` 是**假守护** —— 它先被"桶下标越界"兜住，拆 `key > today` 也全绿。
  // 换成**同周内的明天**（SES_NOW 2026-09-25 是周五 ⇒ 09-26 在同周窗口内）才真正踩进那条分支。
  const tomorrow = T.buildWorkspaceTrend([{ cwd: 'X', days: { '2026-09-26': 99999999 } }], SES_NOW, zh)
  assert.ok(tomorrow.rows[0].bars.every((b) => b.ms === 0), '同周内的明天也不许算进桶')
  // 未来日键不进桶（与日历页同一口径；这条另有一层"桶下标越界"兜底）
  const future = T.buildWorkspaceTrend([{ cwd: 'X', days: { '2099-01-01': 99999999 } }], SES_NOW, zh)
  assert.ok(future.rows[0].bars.every((b) => b.ms === 0), '未来日键不许算')
  // 🩸 实测：截断与排序原先零守护
  const many = []
  for (let i = 0; i < 8; i += 1) many.push({ cwd: 'ws' + i, days: { '2026-09-25': (i + 1) * 1000 } })
  const manyTrend = T.buildWorkspaceTrend(many, SES_NOW, zh)
  assert.equal(manyTrend.rows.length, T.WS_TREND_LIMIT, '只列前 N 个工作区')
  assert.equal(manyTrend.capped, 8 - T.WS_TREND_LIMIT, '其余要计入 capped')
  assert.equal(manyTrend.rows[0].key, 'ws7', '按窗口内总量降序，最大者在前')
  assert.equal(manyTrend.rows[0].totalText, '8.0s')
  // 🩸 实测：窗口内全零 ⇒ 不挂卡（否则会挂一张全空的趋势卡）
  const allZero = T.buildWorkspaceTrend([{ cwd: 'X', days: { '2026-09-25': 0 } }], SES_NOW, zh)
  assert.equal(allZero.hasData, false, '窗口内全零 = 没有数据')
  const offsetOnly = T.buildWorkspaceTrend([{ cwd: 'X', days: { '2020-01-01': 9999 } }], SES_NOW, zh)
  assert.equal(offsetOnly.hasData, false, '只有窗口外的数据也算没有数据')
  // 脏键（尾随空格）也不许进桶
  const dirty = T.buildWorkspaceTrend([{ cwd: 'X', days: { '2026-09-25 ': 88888888 } }], SES_NOW, zh)
  assert.ok(dirty.rows[0].bars.every((b) => b.ms !== 88888888), '脏键不许进桶')
  // 挂卡：完整模型渲染日历页
  const full = T.buildModel({
    sessions: SES_SNAP, now: SES_NOW, stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS
  }, zh)
  const tree = T.renderSegment('calendar', full, zh, null)
  assert.equal(findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'ws-trend-card').length, 1,
    '日历页要挂出趋势卡')
  assert.equal(findNodes(tree, (n) => n.props && n.props['data-usage-role'] === 'ws-trend-row').length,
    trend.rows.length, '行数 = 工作区数')
  assertClean(tree, 'calendar(A6)')
})

test('T23p 显示范围的边角：边界日 / 无活动日 / 空态优先级 / 偏好链路 / 控件', () => {
  const now = SES_NOW // 2026-09-25
  const mk = (id, lastDay, ms, cwd) => ({
    id,
    title: id,
    cwd: cwd === undefined ? 'D:\\A' : cwd,
    days: lastDay === null ? {} : { [lastDay]: ms },
    activeMs: ms,
    turns: 1,
    segments: 1,
    longestMs: ms,
    lastDay,
    isSubagent: false,
    running: false
  })
  // ① 边界：rangeDays=14（含今天）⇒ 最早可见 = today-13 = 2026-09-12；09-11 就该出局
  const boundary = T.buildSessionsModel({
    rows: [mk('edge-in', '2026-09-12', 1000), mk('edge-out', '2026-09-11', 1000)],
    uncovered: 0
  }, { view: 'a', windowDays: 0, rangeDays: 14 }, now, zh)
  assert.deepEqual(boundary.groups[0].sessions.map((s) => s.id), ['edge-in'],
    '显示范围边界 = today-13（14 天含今天），少一天就是范围外')
  // ② 没有最后活动日（lastDay=null）⇒ 一律不进清单（并归到 rangeEmpty）
  const noDay = T.buildSessionsModel({ rows: [mk('nod', null, 0)], uncovered: 0 },
    { view: 'a', windowDays: 0, rangeDays: 14 }, now, zh)
  assert.equal(noDay.hasData, true)
  assert.equal(noDay.emptyKind, 'rangeEmpty', '没有最后活动日 ⇒ 按"被范围挡下"处理')
  // ③ 空态优先级：范围挡光 **优先于** 工作区筛不中（根因在前）
  const missToo = T.buildSessionsModel({ rows: [mk('x', '2026-01-01', 5000)], uncovered: 0 },
    { view: 'a', windowDays: 7, workspace: 'D:\\Nope', rangeDays: 14 }, now, zh)
  assert.equal(missToo.emptyKind, 'rangeEmpty', '范围挡光时不许报"工作区筛不中"')
  // ④ 偏好链路：sesRange 走白名单（数字串也吃、坏值静默回退默认）
  assert.equal(T.normalizePrefs({ sesRange: '30' }).sesRange, 30, '数字串要认')
  assert.equal(T.normalizePrefs({ sesRange: 999 }).sesRange, T.DEFAULT_SESSION_RANGE, '白名单外的值回退默认')
  assert.equal(T.normalizePrefs({ sesRange: 0 }).sesRange, 0, '0 = 不限，是合法值')
  assert.equal(T.normalizePrefs(null).sesRange, T.DEFAULT_SESSION_RANGE)
  // ⑤ 控件：🩸 2026-10-14 定稿合并 ⇒ 只剩一个「时间范围」（四个候选），旧的「显示范围」控件消失
  const model = T.buildSessionsModel(T.collectSessionUsage(SES_SNAP), { view: 'a', windowDays: 7 }, now, zh)
  assert.equal(model.rangeDays, 14, '模型层的默认显示范围不变（常量仍保留，只是不再有独立控件）')
  const body = T.renderSegment('sessions', { sessions: model }, zh, null)
  const winBtns = findNodes(body, (n) => n.props && n.props['data-group'] === 'ses.win')
  assert.equal(winBtns.length, 4, '四个候选都要在')
  const on = winBtns.filter((b) => b.props['aria-pressed'] === 'true')
  assert.equal(on.length, 1)
  assert.equal(on[0].props['data-value'], '7', '默认选中的是近 7 天')
  assert.equal(findNodes(body, (n) => n.props && n.props['data-group'] === 'ses.range').length, 0,
    '合并后不许再有 ses.range 控件')
  // ⑥ 🩸 工作区筛选一旦生效，控件**必须**在屏上（哪怕候选只剩 2 项）—— 否则用户没法清掉它（实测）
  //    夹具：**当前筛选的那个工作区整个被显示范围挡掉** ⇒ 候选只剩「全部 + D:\New」
  const deadWs = T.buildSessionsModel({
    rows: [mk('old-one', '2026-01-01', 5000, 'D:\\Old'), mk('new-one', '2026-09-25', 1000, 'D:\\New')],
    uncovered: 0
  }, { view: 'a', windowDays: 7, workspace: 'D:\\Old', rangeDays: 14 }, now, zh)
  assert.equal(deadWs.wsOptions.length, 2, '前提：选中的工作区被范围挡光 ⇒ 候选只剩 2 项（旧逻辑会因此不渲染控件）')
  assert.equal(deadWs.emptyKind, 'workspaceMiss')
  const deadBody = T.renderSegment('sessions', { sessions: deadWs }, zh, null)
  const deadCtrlGroups = findNodes(deadBody, (n) => n.props && typeof n.props['data-group'] === 'string')
    .map((b) => b.props['data-group'])
  // 注意：`data-group` 是**每个候选各一个** ⇒ 这里只断言"控件组存在"，不数个数
  assert.ok(deadCtrlGroups.includes('ses.ws'),
    '有生效的工作区筛选 ⇒ 控件必须在屏上（否则筛选清不掉、提示也没出路）；实际控件组 = ' + JSON.stringify(deadCtrlGroups))
})

// ---------------------------------------------------------------- T22 宿主冷会话回填（P2 第二步）
// 被测对象：lib/index.mjs 的 `watchUsageBackfill`（零依赖，直接 import）。
// 回填跑在 `setTimeout` + `await` 里，所以这一节用 `testAsync`（文件末尾统一执行）。
// 自测一律传 `{ startDelayMs: 0, yieldMs: 0 }` 压掉真实延迟（生产用默认 5000 / 100）。

const COLD_TS = CAL_DAY(2026, 9, 20, 9, 0)
const COLD_EVENTS = [
  hostEvent('turn/start', COLD_TS),
  hostEvent('assistant/message', COLD_TS + 60000),
  hostEvent('turn/end', COLD_TS + 90000)
]

/** 等一个条件成立（回填在宏任务里推进，只能轮询等它收敛）。 */
async function waitUntil (predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等不到：' + label)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * 只够回填用的假 ctx：记录 `inject` 收到的服务名、logger 三条输出，
 * 并保留回调返回的 disposer（真实 cordis 里 inject 回调的返回值就是子 fiber 的清理函数
 * ⇒ 假 fiber 照同一语义转发）。
 * `options` 传 `null` = **不覆盖**，走生产默认参数（用于验证"默认 5s 延迟"）。
 */
function backfillHarness (services, options) {
  const logs = { debug: [], info: [], warn: [] }
  const state = { injectArgs: null, cbReturn: undefined, fiberDisposed: 0 }
  const ctx = {
    inject (names, callback) {
      state.injectArgs = names
      state.cbReturn = callback(services === undefined || services === null ? {} : services)
      return {
        dispose: () => {
          state.fiberDisposed += 1
          if (typeof state.cbReturn === 'function') state.cbReturn()
        }
      }
    },
    logger: {
      debug: (message) => logs.debug.push(String(message)),
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message))
    }
  }
  const merged = options === null ? undefined : Object.assign({ startDelayMs: 0, yieldMs: 0 }, options)
  const dispose = HOST.watchUsageBackfill(ctx, merged)
  return { ctx, logs, state, dispose }
}

/**
 * 假宿主服务（列表 / 投影缓存 / 持久化 / live 注册表）+ 调用记录。
 * spec:
 *   records    列表返回的行
 *   cached     Map<id, values>  缓存里已有的投影值（含 usageDaily ⇒ 该被跳过）
 *   live       Set<id>          注册表里存在的 live 会话
 *   plans      Map<id, 打开计划>（throws / readThrows / header / inheritedEventCount / events）
 *   listThrows 列表本身抛错
 *   onCold     coldSnapshot 被调用时的回调（用于"折到一半 dispose"）
 */
function makeBackfillServices (spec) {
  const records = spec.records === undefined ? [] : spec.records
  const cached = spec.cached === undefined ? new Map() : spec.cached
  const live = spec.live === undefined ? new Set() : spec.live
  const plans = spec.plans === undefined ? new Map() : spec.plans
  const calls = { list: 0, listSignal: null, open: [], read: [], close: [], cold: [], cached: [] }
  const services = {
    sessionQuery: {
      listSessions: async (signal) => {
        calls.list += 1
        calls.listSignal = signal
        if (spec.listThrows) throw spec.listThrows
        return records
      }
    },
    sessionProjectionCache: {
      cachedSnapshot: (...args) => {
        calls.cached.push(args)
        const id = args[0] === null || args[0] === undefined ? undefined : args[0].id
        const values = cached.get(id)
        return values === undefined ? null : { values }
      },
      coldSnapshot: (...args) => {
        calls.cold.push(args)
        if (spec.onCold) spec.onCold(args)
      }
    },
    sessionPersistence: {
      open: async (id, mode, opts) => {
        calls.open.push([id, mode, opts])
        const plan = plans.get(id) === undefined ? {} : plans.get(id)
        if (plan.throws) throw plan.throws
        return {
          header: plan.header === undefined ? { id, cwd: 'C:\\work' } : plan.header,
          inheritedEventCount: plan.inheritedEventCount === undefined ? 0 : plan.inheritedEventCount,
          read: async (...readArgs) => {
            calls.read.push([id, readArgs])
            if (plan.readThrows) throw plan.readThrows
            return { events: plan.events === undefined ? COLD_EVENTS : plan.events }
          },
          close: async () => { calls.close.push(id) }
        }
      }
    },
    sessions: { get: (id) => (live.has(id) ? { id } : undefined) }
  }
  return { services, calls }
}

test('T22a 回填：inject 精确声明 4 个服务；服务缺失 / 形状不对一律不抛、不刷 warn', () => {
  const empty = backfillHarness({}, {})
  assert.deepEqual(empty.state.injectArgs, ['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'],
    '🩸 四个服务名与顺序是契约：会话列表 / 投影缓存 / 持久化 / live 注册表（照 dsh-context 的同款注入）')
  assert.equal(empty.logs.warn.length, 0, '服务缺失 = 宿主还没装配好，属正常路径，不许 warn 刷屏')
  // 🩸 实测发现：早退必须留一行 debug 并**点名缺了谁** —— 否则"宿主还没就绪"与"宿主不兼容"
  // 在日志上完全无法区分，而回填会永久不发生（失败伪装成正常态）。
  assert.equal(empty.logs.debug.length, 1, '服务缺失要留一行 debug（不是 warn，也不是静默）：' + JSON.stringify(empty.logs.debug))
  assert.ok(empty.logs.debug[0].includes('sessionQuery.listSessions'), 'debug 要点名缺的服务：' + empty.logs.debug[0])
  assert.equal(typeof empty.dispose, 'function', '必须返回 disposer（apply 要把它挂到 fiber 清理上）')
  assert.doesNotThrow(() => empty.dispose())
  assert.equal(empty.state.fiberDisposed, 1, 'dispose 必须转交给子 fiber')
  // 服务只到一半 / 形状不对：一律早退（留一行 debug），绝不抛
  const partial = [
    { services: { sessionQuery: { listSessions: async () => [] } }, missing: ['sessionProjectionCache', 'sessionPersistence'] },
    {
      services: { sessionQuery: { listSessions: async () => [] }, sessionProjectionCache: { cachedSnapshot: () => null } },
      missing: ['sessionPersistence']
    },
    {
      // 服务齐全（列表为空）⇒ **不该**早退、也不该发"未装配"的 debug；这里只要求能安全 dispose
      services: {
        sessionQuery: { listSessions: async () => [] },
        sessionProjectionCache: { cachedSnapshot: () => null, coldSnapshot: () => {} },
        sessionPersistence: { open: async () => ({}) }
      },
      missing: []
    },
    {
      services: {
        sessionQuery: { listSessions: 'not-a-function' },
        sessionProjectionCache: { cachedSnapshot: () => null, coldSnapshot: () => {} },
        sessionPersistence: { open: async () => ({}) }
      },
      missing: ['sessionQuery']
    }
  ]
  for (let i = 0; i < partial.length; i += 1) {
    const harness = backfillHarness(partial[i].services, {})
    assert.doesNotThrow(() => harness.dispose(), '缺服务的假 ctx #' + i + ' 必须能安全 dispose')
    assert.equal(harness.logs.warn.length, 0, '缺服务不许 warn（假 ctx #' + i + '）')
    if (partial[i].missing.length > 0) {
      assert.equal(harness.logs.debug.length, 1, '早退要留一行 debug（假 ctx #' + i + '）：' + JSON.stringify(harness.logs.debug))
      for (const token of partial[i].missing) {
        assert.ok(harness.logs.debug[0].includes(token), 'debug 要点名缺了 ' + token + '：' + harness.logs.debug[0])
      }
    } else {
      assert.deepEqual(harness.logs.debug, [], '服务齐全时不许发"未装配"的 debug（假 ctx #' + i + '）')
    }
  }
})

testAsync('T22b 回填正常路径：跳过「已有该键 / live / 无 cwd」，但「只有别的键」必须折，折账参数与关句柄都要对', async () => {
  const records = [
    { header: { id: 'has-key', cwd: 'C:\\work' } },
    { header: { id: 'live-one', cwd: 'C:\\work' } },
    { header: { id: 'no-cwd' } },
    { header: null },
    { header: { id: '', cwd: 'C:\\work' } },
    { header: { id: 'other-keys-only', cwd: 'C:\\work' } },
    { header: { id: 'cold-one', cwd: 'C:\\work' } }
  ]
  const cached = new Map([
    ['has-key', { usageDaily: { days: {}, activeMs: 1, turns: 1, segments: 1, longestMs: 1 } }],
    // 🩸 实测发现的夹具：真实 projcache 里"缺 usageDaily 的那批会话**全部**已有别的键"
    // （title / tokenUsage / contextActivity …）⇒ 若把判定写成"有任意投影值就算已服务"，
    // 这批会被**永久漏补**，而且 folded=0 连"完成 N 个"都不发、日志一片空白。
    // 这一条钉死"必须看键名，不能只看 values 非空"。
    ['other-keys-only', { title: 'x', contextActivity: { days: {} }, tokenUsage: 1 }]
  ])
  const live = new Set(['live-one'])
  const plans = new Map([
    ['other-keys-only', { inheritedEventCount: 0, events: COLD_EVENTS }],
    ['cold-one', { inheritedEventCount: 3, events: COLD_EVENTS }]
  ])
  const { services, calls } = makeBackfillServices({ records, cached, live, plans })
  const { logs, dispose } = backfillHarness(services, {})
  await waitUntil(() => logs.info.some((m) => m.includes('冷会话回填完成')), '回填汇总日志')

  assert.equal(calls.list, 1, 'listSessions 只调一次')
  assert.equal(calls.cold.length, 2, '🩸 恰好折 2 个：已有 usageDaily 的 / live / 无 cwd 跳过；「只有别的投影键」不算已服务')
  assert.deepEqual(calls.cold.map((c) => c[0].id), ['other-keys-only', 'cold-one'], '按列表顺序逐个折')
  const coldArgs = calls.cold[1]
  assert.equal(coldArgs[0].id, 'cold-one', 'coldSnapshot 第 1 参 = 冷读回来的 header')
  assert.equal(coldArgs[1], 3, '第 2 参 = inheritedEventCount（fork 继承条数，供宿主折账时定位切点）')
  assert.equal(coldArgs[2], COLD_EVENTS, '第 3 参 = 事件数组（同一引用，不复制）')
  // 冷读契约：只对缺键的冷会话开日志、从偏移 0 全量读、读完关句柄
  assert.deepEqual(calls.open.map((c) => [c[0], c[1]]), [['other-keys-only', 'read'], ['cold-one', 'read']], '只开缺键的那两个')
  assert.ok(calls.open[0][2] && calls.open[0][2].signal instanceof AbortSignal, 'open 必须带 abort 信号')
  assert.equal(calls.read.length, 2)
  assert.equal(calls.read[0][1][0], 0, '从偏移 0 读全量')
  assert.deepEqual(calls.close, ['other-keys-only', 'cold-one'], '🩸 读完必须 close（否则句柄泄漏）')
  assert.ok(logs.info.some((m) => m.includes('冷会话回填完成 2 个会话的 usageDaily 投影')),
    '汇总日志要能被人肉看见：' + JSON.stringify(logs.info))
  assert.ok(logs.debug.some((m) => m.includes('回填忽略 3 条无 cwd')), '跳过的无 cwd 记录要留 debug：' + JSON.stringify(logs.debug))
  assert.deepEqual(logs.warn, [], '正常路径一条 warn 都不许有')
  dispose()
})

testAsync('T22c 回填失败面：格式不支持走 debug 不当 warn、且不中断后续；真错误才 warn', async () => {
  const unsupported = new Error('这份日志读不了')
  unsupported.name = 'SessionFormatUnsupportedError'
  const unsupportedBare = new Error('旧格式')
  unsupportedBare.name = 'SessionFormatUnsupported' // 不带 Error 后缀也要认（按族前缀判）
  const records = [
    { header: { id: 'old-format', cwd: 'C:\\work' } },
    { header: { id: 'old-format-bare', cwd: 'C:\\work' } },
    { header: { id: 'cold-ok', cwd: 'C:\\work' } }
  ]
  const plans = new Map([
    ['old-format', { readThrows: unsupported }],
    ['old-format-bare', { readThrows: unsupportedBare }],
    ['cold-ok', {}]
  ])
  const first = makeBackfillServices({ records, plans })
  const harness = backfillHarness(first.services, {})
  await waitUntil(() => harness.logs.info.some((m) => m.includes('回填跳过')), '跳过汇总日志')

  assert.ok(harness.logs.debug.some((m) => m.includes('old-format') && m.includes('旧日志格式')),
    '格式不支持要留 debug（可诊断但不刷屏）：' + JSON.stringify(harness.logs.debug))
  assert.equal(harness.logs.warn.filter((m) => m.includes('old-format')).length, 0,
    '🩸 旧格式是"源侧永久拒绝"，不是异常，不许 warn')
  assert.equal(first.calls.close.filter((id) => id === 'old-format').length, 1, '🩸 读失败也要 close（错误路径同样不许泄漏句柄）')
  assert.equal(first.calls.cold.length, 1, '🩸 前两个失败不许中断后面的会话')
  assert.equal(first.calls.cold[0][0].id, 'cold-ok', '折的是第三个（跳过两个旧格式）')
  assert.ok(harness.logs.info.some((m) => m.includes('回填跳过 2 个会话（日志格式不支持迁移，源文件未改动）')),
    '要有人肉可见的计数：' + JSON.stringify(harness.logs.info))
  harness.dispose()

  // 非格式错误（磁盘抖动一类）：走 warn
  const second = makeBackfillServices({
    records: [{ header: { id: 'io-bad', cwd: 'C:\\work' } }],
    plans: new Map([['io-bad', { throws: new Error('EIO') }]])
  })
  const harness2 = backfillHarness(second.services, {})
  await waitUntil(() => harness2.logs.warn.length > 0, '真错误 warn')
  assert.ok(harness2.logs.warn.some((m) => m.includes('io-bad')), '真错误必须 warn：' + JSON.stringify(harness2.logs.warn))
  assert.equal(second.calls.close.length, 0, 'open 就失败 ⇒ 没有句柄可关（不许凭空 close）')
  assert.deepEqual(harness2.logs.info, [], '一个都没折成 ⇒ 不发"完成 N 个"的 info')
  harness2.dispose()

  // 列表本身抛错：整趟收敛成一句 warn，绝不许把错误泄给宿主
  const third = makeBackfillServices({ listThrows: new Error('query down') })
  const harness3 = backfillHarness(third.services, {})
  await waitUntil(() => harness3.logs.warn.length > 0, '提前结束 warn')
  assert.ok(harness3.logs.warn.some((m) => m.includes('冷会话回填提前结束')),
    '整趟失败要 warn 一句就收：' + JSON.stringify(harness3.logs.warn))
  assert.equal(third.calls.cold.length, 0)
  harness3.dispose()
})

testAsync('T22d 回填 dispose：启动前清掉定时器（默认 5s 内不碰列表）；折到一半 abort 后不再折后续', async () => {
  // ① 生产默认参数（不传 options = 5s 延迟）：装配后立刻 dispose ⇒ 列表都不该被碰
  const first = makeBackfillServices({ records: [{ header: { id: 'a', cwd: 'C:\\work' } }] })
  const prod = backfillHarness(first.services, null)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(first.calls.list, 0, '🩸 默认 5s 延迟内不许动列表（这里只等 60ms）')
  assert.equal(prod.logs.warn.length, 0, '正常 dispose 不是错误，不许 warn')
  prod.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(first.calls.list, 0, 'dispose 之后也不许"迟到开跑"')

  // ② 折到一半 dispose：第一个会话折完后 abort，后面的会话一个都不许再折
  const records = ['c1', 'c2', 'c3'].map((id) => ({ header: { id, cwd: 'C:\\work' } }))
  let harness = null
  const mid = makeBackfillServices({ records, onCold: () => harness.dispose() })
  harness = backfillHarness(mid.services, {})
  await waitUntil(() => mid.calls.cold.length >= 1, '第一次折账')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mid.calls.list, 1, '列表只问一次（abort 不该重开一趟）')
  assert.equal(mid.calls.cold.length, 1, '🩸 abort 后循环顶部必须退出：后面的会话一个都不许再折')
  assert.equal(mid.calls.open.length, 1, '后续会话连日志都不该打开')
  assert.equal(mid.calls.close.length, 1, '已折的那个仍要正常关句柄')
  assert.deepEqual(harness.logs.info, [], '被 dispose 掐掉的一趟不发"完成"日志')
  assert.equal(harness.state.fiberDisposed, 1)
})

test('T22e 回填装配：apply() 必须真的把回填装起来，且它的 disposer 要能清理到回填子 fiber', () => {
  // 🩸 实测：T22a~T22d 全是**直接调用** `HOST.watchUsageBackfill`，**绕过 apply**。
  // 于是"把 apply 里那三行装配删掉"时三套检查照绿 —— 回填从此永不发生、零日志、覆盖率停在 85%，
  // 看起来就像"老会话本来就这样"。这条用例走 apply 这条**真实入口**，把装配钉死。
  const state = { injectArgs: [], fiberDisposed: 0 }
  const ctx = {
    sessionProjections: { register: () => {} },
    inject (names, callback) {
      state.injectArgs.push(names.slice())
      const inner = callback({}) // 服务为空 ⇒ 回填内部早退（不会真跑一趟）
      return {
        dispose: () => {
          state.fiberDisposed += 1
          if (typeof inner === 'function') inner()
        }
      }
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {} }
  }
  const dispose = HOST.apply(ctx)
  assert.deepEqual(state.injectArgs, [['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions']],
    '🩸 apply() 必须装配回填（服务名与顺序）：删掉那三行 ⇒ 回填永不发生、零日志、界面永远停在 85%')
  assert.equal(typeof dispose, 'function', 'apply 必须返回一个 disposer')
  dispose()
  assert.equal(state.fiberDisposed, 1,
    '🩸 apply 的 disposer 必须清理到**回填子 fiber**（否则插件卸载时在跑的那一趟不会被 abort）')
})

testAsync('T22f 回填只跑一趟：ctx.inject 回调被重复触发时，列表也只问一次', async () => {
  // 🩸 增量复核（2026-10-13）实证：`started` 守卫**修法有效但零守护** ——
  // 把它挪进回调内、或删掉 `if (started) return`，三套检查照绿。
  // 真宿主里"服务重载 / 多提供者"都可能让 `ctx.inject` 回调再触发一次 ⇒ 必须只跑一趟。
  const { services, calls } = makeBackfillServices({ records: [] })
  const logs = { debug: [], info: [], warn: [] }
  let inner = null
  const ctx = {
    inject (names, callback) {
      inner = callback(services)
      inner = callback(services) // 第二次触发：第二次必须收手（顶层 started 已置真）
      return { dispose: () => { if (typeof inner === 'function') inner() } }
    },
    logger: {
      debug: (message) => logs.debug.push(String(message)),
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message))
    }
  }
  const dispose = HOST.watchUsageBackfill(ctx, { startDelayMs: 0, yieldMs: 0 })
  await waitUntil(() => calls.list >= 1, '回填开跑')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls.list, 1, '🩸 回调触发两次也只准跑一趟（否则同一批会话被并发冷读两遍、两个 AbortController）')
  assert.equal(calls.open.length, 0, '列表为空 ⇒ 一个会话日志都不该打开')
  assert.deepEqual(logs.warn, [], '重复触发不是错误路径，不许 warn')
  dispose()
})

// ---------------------------------------------------------------- 异步用例（回填）

for (const item of asyncCases) {
  try {
    await item.fn()
    record(item.name)
  } catch (error) {
    record(item.name, error)
  }
}

// ---------------------------------------------------------------- 汇总

console.log('----')
console.log('passed: ' + passed + '  failed: ' + failures.length)
if (failures.length > 0) {
  console.log('failures:')
  for (const item of failures) console.log('  - ' + item.name + ': ' + item.message.split('\n')[0])
  process.exitCode = 1
} else {
  console.log('ALL GREEN')
}
