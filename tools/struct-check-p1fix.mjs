#!/usr/bin/env node
/**
 * dsh-usage-tab · P1-fix 结构级自检（**纯函数级 / 结构级，完全不碰宿主**）
 * ============================================================================
 *
 * 与 test/self-test.mjs 的分工：
 *   - self-test.mjs  = 功能回归（40 例断言，全绿为准）；
 *   - 本脚本         = **结构级自检**：不做完整断言矩阵，而是把"改后的 client.js
 *                      会渲染成什么"原样打印出来，供人工核对口径标注是否到位。
 *
 * 关键点：夹具**直接复刻上层在实测中看到的矛盾场景**——
 *   · sessionStats（全日志）  turns=15 / steps=135
 *   · turnTimings（窗口）     只有第 8~15 轮，timeline 里共 42 步
 * 然后看：这两个数在卡面上是否各自被标了口径、还会不会打架。
 *
 * 只读 lib/client.js；不写任何文件；不 require 宿主任何模块。
 * 用法：node tools/struct-check-p1fix.mjs
 */

import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let okCount = 0
let badCount = 0
const badList = []

function check (name, cond, detail) {
  if (cond) { okCount += 1; console.log('OK   ' + name) } else {
    badCount += 1
    badList.push(name)
    console.log('BAD  ' + name + (detail === undefined ? '' : '  :: ' + detail))
  }
}

// ── A. 静态结构锚点：源码里必须真的存在这些结构 ───────────────────────────
console.log('== A. 静态结构锚点（源码正则）==')
const statics = [
  ['A1  口径标签样式 .ut-card-tag 用 label-tertiary',
    /\.ut-card-tag\{[^}]*color:var\(--dsw-alias-label-tertiary\)/.test(code)],
  ['A2  口径标签样式 .ut-card-tag 是 11px',
    /\.ut-card-tag\{[^}]*font-size:11px/.test(code)],
  ['A3  口径标签不带 margin（不撑高标题行）',
    !/\.ut-card-tag\{[^}]*margin/.test(code)],
  ['A4  窗口范围变量 ganttWindowText 已计算',
    /var ganttWindowText = ""/.test(code)],
  ['A5  窗口范围已进模型（ganttWindowText:）',
    /ganttWindowText: ganttWindowText/.test(code)],
  ['A6  甘特标题行渲染了窗口范围标签',
    /model\.ganttWindowText/.test(code) && /ut-card-tag/.test(code)],
  ['A7  脚注有稳定实机钩子 data-usage-role="source-note"',
    /"data-usage-role": "source-note"/.test(code)],
  ['A8  脚注渲染点仍在（className: "ut-source"）',
    /className: "ut-source"/.test(code)],
  ['A9  中文 KPI 标注「轮次（全日志）」',
    /"kpi\.turns": "轮次（全日志）"/.test(code)],
  ['A10 中文 KPI 标注「步数（全日志）」',
    /"kpi\.steps": "步数（全日志）"/.test(code)],
  ['A11 英文 KPI 标注 "Turns (whole log)"',
    /"kpi\.turns": "Turns \(whole log\)"/.test(code)],
  ['A12 中文窗口步数文案「已加载窗口 」',
    /"hours\.sum": "已加载窗口 "/.test(code)],
  ['A13 英文窗口步数文案 "Loaded window "（不再留空）',
    /"hours\.sum": "Loaded window "/.test(code)],
  ['A14 中文窗口范围文案「仅显示已加载窗口：」',
    /"gantt\.window": "仅显示已加载窗口："/.test(code)],
  ['A15 旧措辞「本会话共 」已彻底消失',
    !code.includes('"hours.sum": "本会话共 ')]
]
for (const [name, cond] of statics) check(name, cond)

// ── 装载（宿主 realm + 最小 react 桩；与 self-test 同法，不依赖宿主）──────
let captured = null
const reactStub = {
  createElement: function (type, props) { return { type, props, children: Array.prototype.slice.call(arguments, 2) } },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}
const runner = new Function('window', 'require', code)
runner(
  { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  (id) => { if (id === 'react') return reactStub; throw new Error('unexpected require: ' + id) }
)
const T = captured.factory((id) => { if (id === 'react') return reactStub; throw new Error('unexpected require: ' + id) }).__test

// A16/A17 必须扫 **CSS 常量**（`T.CSS`），不能扫整份源码：
// 源码注释里为了说明"没有任何 #hex / rgb()"本身就写了 `rgb()` 这个词，
// 扫源码会假阳性（本脚本第一版就是这么误报的）。口径与 self-test T16 一致。
console.log('')
console.log('== A2. 静态锚点（CSS 常量，装载后才能取到）==')
check('A16 零硬编码配色：CSS 里无 #hex / rgb() / 具名色',
  !/#[0-9a-fA-F]{3,8}\b/.test(T.CSS) &&
  !/\b(rgb|rgba|hsl|hsla)\(/.test(T.CSS) &&
  T.CSS.replace(/white-space/gi, '').match(/(^|[^-\w])(white|black|red|green|blue|gray|grey|orange|yellow|purple)(?![\w-])/i) === null)
check('A17 CSS 里 7 个宿主 token 齐备',
  ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
    '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary'].every((token) => T.CSS.includes(token)))
check('A18 卡片骨架数值未被动过（13px / 10px 圆角 / bg-layer-1 / border-l2）',
  T.CSS.includes('font-size:13px') && /\.ut-card\{[^}]*border-radius:10px/.test(T.CSS) &&
  /\.ut-card\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/.test(T.CSS) &&
  /\.ut-card\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(T.CSS))

console.log('')
console.log('== B. 复刻上级实机场景的夹具 ==')
console.log('   sessionStats（全日志）      : turns=15  steps=135')
console.log('   turnTimings（已加载窗口）   : 第 8~15 轮（8 轮）')
console.log('   timeline 步骤（窗口口径）    : 42 步')

const baseTs = new Date(2026, 8, 25, 7, 6, 17).getTime()
const stats = { turns: 15, steps: 135, llmMs: 1000, toolMs: 500 }
const turnTimings = new Map()
for (let turn = 8; turn <= 15; turn += 1) {
  const start = baseTs + (turn - 8) * 180000
  turnTimings.set(turn, { startTime: start, endTime: start + 90000 })
}
const timeline = { turns: new Map() }
let seq = 0
for (let turn = 8; turn <= 15; turn += 1) {
  const steps = []
  const count = turn < 15 ? 5 : 7 // 7×5 + 7 = 42
  for (let k = 0; k < count; k += 1) {
    steps.push({ step: k, start: { time: baseTs + (turn - 8) * 180000 + k * 1000, seq: (seq += 1) } })
  }
  timeline.turns.set(turn, { turn, steps })
}

const tZh = (key) => T.DICT_ZH[key]
const model = T.buildModel({ stats, turnTimings, timeline, openEndFallback: baseTs + 9000000, idleMs: T.IDLE_THRESHOLD_MS }, tZh)

console.log('')
console.log('== C. 模型层（纯函数，不渲染）==')
console.log('   hasData / hasTurns        : ' + model.hasData + ' / ' + model.hasTurns)
console.log('   totals.totalSteps（窗口）  : ' + model.totals.totalSteps)
for (const kpi of model.kpis) {
  console.log('   KPI ' + kpi.key.padEnd(10) + ': label=' + JSON.stringify(kpi.label) + '  value=' + JSON.stringify(kpi.value))
}
console.log('   ganttWindowText           : ' + JSON.stringify(model.ganttWindowText))
console.log('   gantt 条数 / 轮号           : ' + model.gantt.length + ' / ' + JSON.stringify(model.gantt.map((row) => row.turn)))
console.log('   rank 条数                   : ' + model.rank.length)

check('C1 全日志 KPI 标签带「全日志」',
  model.kpis.find((k) => k.key === 'steps').label.includes('全日志') &&
  model.kpis.find((k) => k.key === 'turns').label.includes('全日志'))
check('C2 窗口口径 KPI 未被误标「全日志」',
  ['wall', 'active', 'idleRate', 'first'].every((key) => !model.kpis.find((k) => k.key === key).label.includes('全日志')))
check('C3 窗口范围文案 = 仅显示已加载窗口：第 8~15 轮',
  model.ganttWindowText === '仅显示已加载窗口：第 8~15 轮', model.ganttWindowText)
check('C4 窗口步数（timeline）= 42，与全日志 135 分属两源',
  model.totals.totalSteps === 42 && model.kpis.find((k) => k.key === 'steps').value === '135')
check('C5 模型里无 NaN / undefined / [missing:',
  !/NaN|undefined|\[missing:/.test(JSON.stringify(model)))

// ── D. 渲染层：把"卡面上会出现哪些文本"原样打出来 ────────────────────────
function collectTexts (node, out) {
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((item) => collectTexts(item, out)); return out }
  if (node !== null && typeof node === 'object' && Array.isArray(node.children)) collectTexts(node.children, out)
  return out
}
function findNodes (node, predicate, out) {
  const acc = out || []
  if (Array.isArray(node)) { node.forEach((item) => findNodes(item, predicate, acc)); return acc }
  if (node === null || typeof node !== 'object') return acc
  if (predicate(node)) acc.push(node)
  if (Array.isArray(node.children)) findNodes(node.children, predicate, acc)
  return acc
}

const tree = T.UsageView({
  sessionId: 'struct-check',
  useProjection: (key) => (key === 'sessionStats' ? stats : undefined),
  useChat: (selector) => selector({ legacy: { turnTimings }, timeline }),
  t: tZh
})

const allTexts = collectTexts(tree, [])
console.log('')
console.log('== D. 渲染树里会出现在卡面上的文本（按顺序）==')
allTexts.forEach((text, index) => console.log('   [' + String(index).padStart(2, '0') + '] ' + JSON.stringify(text)))

const cards = tree.children[0]
const footer = findNodes(tree, (node) => node.props && node.props['data-usage-role'] === 'source-note')
const cardTitles = cards.filter((card) => card && card.props && card.props.className === 'ut-card')
check('D1 脚注节点存在且唯一', footer.length === 1, 'count=' + footer.length)
check('D2 脚注是卡片列表最后一项（最底部）',
  cards[cards.length - 1] && cards[cards.length - 1].props['data-usage-role'] === 'source-note')
check('D3 脚注文本讲了两个口径 + 不可相加',
  footer.length === 1 && (() => {
    const text = collectTexts(footer[0].children, []).join('')
    return text.includes('sessionStats') && text.includes('已加载窗口') && text.includes('不可相加')
  })())
check('D4 甘特卡标题行带窗口范围标签',
  (() => {
    const tags = cardTitles.flatMap((card) => findNodes(card, (node) => node.props && node.props.className === 'ut-card-tag'))
    return tags.length === 1 && collectTexts(tags[0].children, []).join('') === '仅显示已加载窗口：第 8~15 轮'
  })())
check('D5 每小时卡片文案是「已加载窗口 42 步…」',
  allTexts.some((text) => text.startsWith('已加载窗口 42 步')), JSON.stringify(allTexts.filter((text) => text.includes('步，累计活跃'))))
check('D6 卡面上不再出现「本会话共」',
  !allTexts.some((text) => text.includes('本会话共')))
check('D7 渲染树里无 NaN / undefined / [missing:',
  !allTexts.some((text) => /NaN|undefined|\[missing:/.test(text)))
check('D8 四张卡齐备（本会话概览 / 使用时间线 / 每小时分布 / 每轮用时排行）',
  ['本会话概览', '使用时间线', '每小时分布', '每轮用时排行'].every((title) => allTexts.includes(title)))

// ── E. 退化输入：绝不许把 NaN / undefined 送上屏 ──────────────────────────
console.log('')
console.log('== E. 退化输入（脏值不得上屏）==')
const dirtyCases = [
  ['E1 空输入', {}],
  ['E2 stats 全是坏值', { stats: { turns: NaN, steps: undefined } }],
  ['E3 turnTimings 形状全错', { turnTimings: [null, 42, { startTime: 'x' }] }],
  ['E4 timeline 形状全错', { timeline: { turns: 'nope' } }],
  ['E5 全 null + idleMs NaN', { stats: null, turnTimings: null, timeline: null, idleMs: NaN }]
]
for (const [name, input] of dirtyCases) {
  const dirtyModel = T.buildModel(input, tZh)
  const dirtyTree = T.UsageView({
    sessionId: 'dirty',
    useProjection: (key) => (key === 'sessionStats' ? input.stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings: input.turnTimings }, timeline: input.timeline }),
    t: tZh
  })
  const text = collectTexts(dirtyTree, []).join('\u0000') + '\u0000' + JSON.stringify(dirtyModel)
  check(name + ' ⇒ 无 NaN/undefined/[missing: 且 ganttWindowText 非脏值',
    !/NaN|undefined|\[missing:/.test(text) && typeof dirtyModel.ganttWindowText === 'string',
    text.slice(0, 120))
}

console.log('')
console.log('----')
console.log('结构级自检： OK=' + okCount + '  BAD=' + badCount)
if (badCount > 0) {
  console.log('未通过：')
  for (const name of badList) console.log('  - ' + name)
  process.exitCode = 1
} else {
  console.log('STRUCT ALL GREEN')
}
