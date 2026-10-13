#!/usr/bin/env node
/**
 * dsh-usage-tab · P1.1 二级菜单结构级自检（**纯函数级 / 结构级，完全不碰宿主**）
 * ============================================================================
 *
 * 与 test/self-test.mjs 的分工：
 *   - self-test.mjs = 功能回归（断言数见它自己的末尾汇总，全绿为准）；
 *   - 本脚本        = 结构级自检：静态锚点 + 把"改后的 client.js 会渲染成什么"
 *                     原样打印出来 + **坏值注入**（stats / turnTimings / timeline 全坏）。
 *
 * 关键点：坏值注入不是只喂给 buildModel，而是**喂给全部 4 个分段**、并把
 * 「渲染树文本 + 模型 JSON」一起扫 `NaN / undefined / [missing:` ——
 * 因为 P1.1 新增了偏好、骨架、口径说明三处新的上屏通路，任何一处漏防都会在这里现形。
 *
 * 只读 lib/client.js；不写除 stdout 之外的任何文件；不 require 宿主任何模块。
 * 用法：node tools/struct-check-subnav.mjs   （建议 `> out/struct-check-subnav.txt`）
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

// ── A. 静态结构锚点（源码正则）──────────────────────────────────────────────
console.log('== A. 静态结构锚点（源码正则）==')
const statics = [
  ['A1  分段 key 白名单 + 默认分段', /var SEGMENT_KEYS = \["overview", "calendar", "sessions", "kline", "settings"\]/.test(code) &&
    /var DEFAULT_SEGMENT = "overview"/.test(code)],
  ['A2  localStorage 键名带插件前缀', /var PREF_KEY = NS \+ "\.prefs"/.test(code)],
  ['A3  默认偏好 = 5 分钟 / Asia/Shanghai / 本会话',
    /idleMinutes: Math\.round\(IDLE_THRESHOLD_MS \/ 60000\)/.test(code) &&
    /timezone: "Asia\/Shanghai"/.test(code) && /scope: "session"/.test(code)],
  ['A4  偏好读 / 写 / 归一化 / 解析四个函数齐备',
    /function normalizePrefs \(raw\)/.test(code) && /function parsePrefs \(text\)/.test(code) &&
    /function readPrefs \(storage\)/.test(code) && /function writePrefs \(storage, prefs\)/.test(code)],
  ['A5  读失败静默回退（readPrefs 的 catch 返回默认值）',
    /function readPrefs \([\s\S]{0,600}catch \(err\) \{\n\s*return normalizePrefs\(null\);/.test(code)],
  ['A6  写失败不抛（writePrefs 的 catch 返回 false）',
    /function writePrefs \([\s\S]{0,700}catch \(err\) \{\n\s*return false;/.test(code)],
  ['A7  偏好真的进模型（buildModel 里 idleMs 缺失 / 越界时取 prefs.idleMinutes）',
    /var idleMs = numOf\(source\.idleMs\);[\s\S]{0,260}?if \(idleMs === null\) idleMs = prefs\.idleMinutes \* 60000;/.test(code)],
  ['A8  分段派发点 renderSegment 存在（含四个分支）',
    /function renderSegment \(segment, model, t, onPick\)/.test(code) &&
    /if \(key === "calendar"\) return calendarBody/.test(code) &&
    /if \(key === "sessions"\) return sessionsBody/.test(code) &&
    /if \(key === "settings"\) return settingsBody/.test(code)],
  ['A9  未知分段回退概览', /SEGMENT_KEYS\.indexOf\(segment\) >= 0 \? segment : DEFAULT_SEGMENT/.test(code)],
  ['A10 UsageView 里两个 useState（偏好 / 分段）',
    /var prefState = react\.useState\(function \(\) \{ return readPrefs\(\); \}\);/.test(code) &&
    /var segState = react\.useState\(DEFAULT_SEGMENT\);/.test(code)],
  ['A11 二级导航渲染在卡片数组第一项',
    /var cards = \[subnavNode\(segment, t, pick\)\];/.test(code)],
  ['A12 点击后写回 localStorage',
    /writePrefs\(null, next\);/.test(code)],
  ['A13 概览脚注钩子仍在（P1-fix 回归）', /"data-usage-role": "source-note"/.test(code)],
  ['A14 口径说明卡复用 source.note（caliber-note 钩子）', /"data-usage-role": "caliber-note"/.test(code)],
  ['A15 骨架 / P2 标签 / 偏好按钮钩子齐备',
    /"data-usage-role": "skeleton"/.test(code) && /"data-usage-role": "p2-tag"/.test(code) &&
    /"data-usage-role": "seg-btn"/.test(code)],
  ['A16 分段按钮用工厂函数绑事件（循环闭包坑）', /function pickHandler \(group, value, onPick\)/.test(code)],
  ['A17 硬编码颜色扫描（源码里只允许出现在注释说明中）',
    !/#[0-9a-fA-F]{3,8}\b/.test(code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))],
  // ── 独立审查的静态锚点（修完必须一直在；编号避开 A2 段已占的 A18~A22）──
  ['A23 空闲阈值先 round 再校验（round 之后必须落在 [1, MAX_IDLE_MINUTES]）',
    /var rounded = Math\.round\(idleRaw\);/.test(code) &&
    /if \(rounded >= 1 && rounded <= MAX_IDLE_MINUTES\) idle = rounded;/.test(code)],
  ['A24 回归保护：旧的「round 前校验」坏写法必须已消失',
    !/idle === null \|\| idle <= 0 \? DEFAULT_PREFS\.idleMinutes : Math\.round\(idle\)/.test(code) &&
    !/\bidle <= 0 \? DEFAULT_PREFS\.idleMinutes/.test(code)],
  // P2 第一步复核发现：这条锚点在上一个 commit（`dc111cd`：补显式 idleMs 下界）就已经**过期**——
  // 那次把 `idleMs <= MAX_IDLE_MINUTES * 60000` 重构成 `var maxIdleMs = MAX_IDLE_MINUTES * 60000`
  // + `idleMs <= maxIdleMs`（语义不变，只是给下界一起用），但没人回来更新锚点。
  // 现在按**意图**重写：常量在 + prefs 通路过它 + 显式 idleMs 通路过它。
  ['A25 上界常量存在，且 prefs 与显式 idleMs 两条通路都过它',
    /var MAX_IDLE_MINUTES = 1440;/.test(code) &&
    /rounded <= MAX_IDLE_MINUTES/.test(code) &&
    /var maxIdleMs = MAX_IDLE_MINUTES \* 60000;/.test(code) &&
    /idleMs <= maxIdleMs/.test(code)],
  ['A26 时区走 Intl 真校验 + 长度上界，非法才回退默认值',
    /function isValidTimezone \(value\)/.test(code) &&
    /new Intl\.DateTimeFormat\("en-US", \{ timeZone: value \}\)/.test(code) &&
    /length > MAX_TZ_LEN/.test(code) &&
    /isValidTimezone\(source\.timezone\) \? source\.timezone : DEFAULT_PREFS\.timezone/.test(code)],
  ['A27 回归保护：旧的「只查非空串」坏写法必须已消失',
    !/typeof source\.timezone === "string" && source\.timezone\.length > 0/.test(code)],
  ['A28 tablist 的子项是真 tab（role=tab + aria-selected），subnav 不再挂 aria-pressed',
    /props\.role = "tab";/.test(code) &&
    /props\["aria-selected"\] = active \? "true" : "false";/.test(code) &&
    /if \(group === "subnav"\) \{\n\s*props\.role = "tab";/.test(code) &&
    /props\["aria-pressed"\] = active \? "true" : "false";/.test(code)],
  ['A29 三个偏好组补 aria-label（词表 + hasOwnProperty 判断）',
    /var SEG_GROUP_ARIA = \{/.test(code) &&
    /"pref\.idle": "set\.idle"/.test(code) && /"pref\.timezone": "set\.tz"/.test(code) &&
    /"pref\.scope": "set\.scope"/.test(code) &&
    /Object\.prototype\.hasOwnProperty\.call\(SEG_GROUP_ARIA, group\)/.test(code)]
]
for (const [name, cond] of statics) check(name, cond)

// ── 装载（宿主 realm + 最小 react 桩；与 self-test 同法，不依赖宿主）───────
let captured = null
const reactStub = {
  createElement: function (type, props) { return { type, props, children: Array.prototype.slice.call(arguments, 2) } },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}
const requireStub = (id) => { if (id === 'react') return reactStub; throw new Error('unexpected require: ' + id) }
new Function('window', 'require', code)(
  { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  requireStub
)
const T = captured.factory(requireStub).__test
const zh = (key) => T.DICT_ZH[key]
const en = (key) => T.DICT_EN[key]

function collectTexts (node, out) {
  const acc = out || []
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc }
  if (Array.isArray(node)) { node.forEach((item) => collectTexts(item, acc)); return acc }
  if (node !== null && typeof node === 'object') {
    if (node.props) for (const key of Object.keys(node.props)) if (typeof node.props[key] === 'string') acc.push(node.props[key])
    if (Array.isArray(node.children)) collectTexts(node.children, acc)
  }
  return acc
}
function findNodes (node, predicate, out) {
  const acc = out || []
  if (Array.isArray(node)) { node.forEach((item) => findNodes(item, predicate, acc)); return acc }
  if (node === null || typeof node !== 'object') return acc
  if (predicate(node)) acc.push(node)
  if (Array.isArray(node.children)) findNodes(node.children, predicate, acc)
  return acc
}
const DIRTY = /NaN|undefined|\[missing:/

// ── A2. CSS 常量（装载后才能取到）──────────────────────────────────────────
console.log('')
console.log('== A2. CSS 常量 ==')
check('A18 零硬编码配色：CSS 里无 #hex / rgb() / 具名色',
  !/#[0-9a-fA-F]{3,8}\b/.test(T.CSS) &&
  !/\b(rgb|rgba|hsl|hsla)\(/.test(T.CSS) &&
  T.CSS.replace(/white-space/gi, '').match(/(^|[^-\w])(white|black|red|green|blue|gray|grey|orange|yellow|purple)(?![\w-])/i) === null)
check('A19 分段控件照 .lc-gran 观感：bg-layer-2 + 1px border-l2 + 6px 圆角 + padding:1px',
  /\.ut-seg\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/.test(T.CSS) &&
  /\.ut-seg\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(T.CSS) &&
  /\.ut-seg\{[^}]*border-radius:6px/.test(T.CSS) &&
  /\.ut-seg\{[^}]*padding:1px/.test(T.CSS))
check('A20 分段按钮 13px；选中态走 brand-primary 系 token',
  /\.ut-seg-btn\{[^}]*font-size:13px/.test(T.CSS) &&
  /\.ut-seg-on,\.ut-seg-on:hover\{[^}]*button-primary-fill/.test(T.CSS))
check('A21 卡片骨架数值未被动过（13px / 10px 圆角 / bg-layer-1 / border-l2）',
  T.CSS.includes('font-size:13px') && /\.ut-card\{[^}]*border-radius:10px/.test(T.CSS) &&
  /\.ut-card\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/.test(T.CSS) &&
  /\.ut-card\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(T.CSS))
check('A22 中英字典 key 集合一致（P1.1 新词条两边都补）',
  Object.keys(T.DICT_EN).sort().join('|') === Object.keys(T.DICT_ZH).sort().join('|'))

// ── B. 复刻实机场景的夹具 ──────────────────────────────────────────────────
console.log('')
console.log('== B. 夹具（复刻上级实机场景）==')
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
  for (let k = 0; k < count; k += 1) steps.push({ step: k, start: { time: baseTs + (turn - 8) * 180000 + k * 1000, seq: (seq += 1) } })
  timeline.turns.set(turn, { turn, steps })
}
console.log('   sessionStats（全日志）    : turns=15  steps=135')
console.log('   turnTimings（已加载窗口） : 第 8~15 轮')
console.log('   timeline 步骤（窗口口径）  : 42 步')

function treeOf (input, t) {
  return T.UsageView({
    sessionId: 'struct-check',
    useProjection: (key) => (key === 'sessionStats' ? input.stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings: input.turnTimings }, timeline: input.timeline }),
    t: t || zh
  })
}

const model = T.buildModel({ stats, turnTimings, timeline, openEndFallback: baseTs + 9000000, idleMs: T.IDLE_THRESHOLD_MS }, zh)
const tree = treeOf({ stats, turnTimings, timeline })

// ── C. 层 1：模型 ─────────────────────────────────────────────────────────
console.log('')
console.log('== C. 模型层（纯函数，不渲染）==')
console.log('   hasData / hasTurns            : ' + model.hasData + ' / ' + model.hasTurns)
console.log('   totals.totalSteps（窗口）      : ' + model.totals.totalSteps)
console.log('   ganttWindowText               : ' + JSON.stringify(model.ganttWindowText))
console.log('   settings.idleText             : ' + JSON.stringify(model.settings.idleText))
console.log('   settings.timezone / scopeText : ' + JSON.stringify(model.settings.timezone) + ' / ' + JSON.stringify(model.settings.scopeText))
console.log('   settings.idleOptions.active   : ' + JSON.stringify(model.settings.idleOptions.filter((o) => o.active).map((o) => o.value)))
console.log('   settings.storeKey             : ' + JSON.stringify(model.settings.storeKey))
console.log('   settings.scopePending         : ' + model.settings.scopePending)
check('C1 默认偏好 = 5 分钟 / Asia/Shanghai / 本会话',
  model.settings.idleText === '5 分钟' && model.settings.timezone === 'Asia/Shanghai' && model.settings.scopeText === '本会话')
check('C2 偏好落盘键名 = dsh-usage-tab.prefs', model.settings.storeKey === 'dsh-usage-tab.prefs' && T.PREF_KEY === 'dsh-usage-tab.prefs')
check('C3 模型里无 NaN / undefined / [missing:', !DIRTY.test(JSON.stringify(model)))

// ── D. 层 2：渲染（每个分段分别把文本原样打出来）───────────────────────────
console.log('')
console.log('== D. 渲染层：四个分段各自会上屏的文本（按顺序）==')
const cards = tree.children[0]
console.log('   [subnav 第一项] data-usage-role=' + (cards[0] && cards[0].props['data-usage-role']))
check('D1 二级导航是内容第一项，且分段顺序 = SEGMENT_KEYS（概览/日历/会话/K 线/设置）',
  cards[0] && cards[0].props['data-usage-role'] === 'subnav' &&
  findNodes(cards[0], (n) => n.props && n.props['data-usage-role'] === 'seg-btn').map((b) => b.props['data-value']).join(',') ===
    T.SEGMENT_KEYS.join(','))
check('D2 默认选中「概览」（恰一个 aria-selected=true，且是 overview）',
  (() => {
    const btns = findNodes(cards[0], (n) => n.props && n.props['data-usage-role'] === 'seg-btn')
    const on = btns.filter((b) => b.props['aria-selected'] === 'true')
    return btns.every((b) => b.props.role === 'tab') &&
      btns.every((b) => b.props['aria-pressed'] === undefined) &&
      on.length === 1 && on[0].props['data-value'] === 'overview' && on[0].props.className.includes('ut-seg-on')
  })())
check('D3 概览 = P1 四张卡 + 最底部脚注（P1 回归不许破）',
  ['本会话概览', '使用时间线', '每小时分布', '每轮用时排行'].every((title) => collectTexts(tree, []).includes(title)) &&
  cards[cards.length - 1].props['data-usage-role'] === 'source-note')

for (const key of T.SEGMENT_KEYS) {
  const body = T.renderSegment(key, model, zh, null)
  const texts = collectTexts(body, [])
  console.log('')
  console.log('   ── 【' + key + '】共 ' + body.length + ' 个顶层节点 / ' + texts.length + ' 段文本 ──')
  texts.forEach((text, index) => console.log('      [' + String(index).padStart(2, '0') + '] ' + JSON.stringify(text)))
  check('D4-' + key + ' 分段正文无 NaN/undefined/[missing:', !DIRTY.test(texts.join('\u0000')), texts.filter((x) => DIRTY.test(x)).join(' | '))
}

check('D5 日历 / 会话：骨架 + 空态 + P2 标注，值一律 —',
  (() => {
    const cal = T.renderSegment('calendar', model, zh, null)
    const skel = findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton')
    const ses = T.renderSegment('sessions', model, zh, null)
    const vals = findNodes(ses, (n) => n.props && n.props.className === 'ut-skel-val')
    return skel.length === 1 &&
      findNodes(skel[0], (n) => n.props && n.props.className === 'ut-skel-row').length === 8 &&
      vals.length === 3 && vals.every((v) => collectTexts(v.children, []).join('') === '\u2014') &&
      collectTexts(cal, []).includes('P2 接宿主级全历史数据后填充')
  })())
check('D6 设置分段：口径说明复用 source.note 且恰一处',
  (() => {
    const body = T.renderSegment('settings', model, zh, null)
    const notes = findNodes(body, (n) => n.props && n.props['data-usage-role'] === 'caliber-note')
    if (notes.length !== 1) return false
    const text = collectTexts(notes[0].children, []).join('')
    return text.includes('sessionStats') && text.includes('已加载窗口') && text.includes('不可相加')
  })())
check('D7 未知分段回退概览',
  collectTexts(T.renderSegment('nope', model, zh, null), []).includes('本会话概览') &&
  collectTexts(T.renderSegment(null, model, zh, null), []).includes('本会话概览'))
check('D8 英文词典也能整棵渲染（locale 切到 en 不许出 [missing:）',
  !DIRTY.test(collectTexts(treeOf({ stats, turnTimings, timeline }, en), []).join('\u0000')))
check('D9 四个偏好组 role=group 且 aria-label 非空（en 词典同样有名字）',
  (() => {
    const isPrefGroup = (n) => n.props && typeof n.props['data-usage-role'] === 'string' &&
      n.props['data-usage-role'].indexOf('pref.') === 0
    const zhGroups = findNodes(T.renderSegment('settings', model, zh, null), isPrefGroup)
    const enModel = T.buildModel({ stats, turnTimings, timeline }, en)
    const enGroups = findNodes(T.renderSegment('settings', enModel, en, null), isPrefGroup)
    const good = (g) => g.props.role === 'group' && typeof g.props['aria-label'] === 'string' && g.props['aria-label'].length > 0
    return zhGroups.length === 4 && zhGroups.every(good) &&
      enGroups.length === 4 && enGroups.every(good) &&
      zhGroups.map((g) => g.props['aria-label']).join(',') === '空闲阈值,时区,数据范围,每周目标'
  })())
check('D10 坏空闲阈值归一化后，设置段不出现「0 分钟」、候选里没有 "0"',
  (() => {
    for (const raw of [0.4, 0.49, 0, -1, 1e308, NaN, '7']) {
      const bad = T.buildModel({ prefs: { idleMinutes: raw } }, zh)
      const texts = collectTexts(T.renderSegment('settings', bad, zh, null), [])
      if (texts.includes('0 分钟')) return false
      if (bad.settings.idleOptions.some((o) => o.value === '0')) return false
      if (bad.settings.idleText !== '5 分钟') return false
      if (bad.settings.idleOptions.filter((o) => o.active === true).length !== 1) return false
    }
    return true
  })())
check('D11 非法时区不上屏、不进候选、恰有一个选中项（合法罕见时区仍可选中）',
  (() => {
    for (const z of ['Not/AZone', 'X\n\t\u0000Y', 'A'.repeat(1e6)]) {
      const bad = T.buildModel({ prefs: { timezone: z } }, zh)
      if (bad.settings.timezone !== T.DEFAULT_PREFS.timezone) return false
      if (bad.settings.tzOptions.some((o) => o.value === z)) return false
      if (bad.settings.tzOptions.filter((o) => o.active === true).length !== 1) return false
      if (DIRTY.test(collectTexts(T.renderSegment('settings', bad, zh, null), []).join('\u0000'))) return false
    }
    const rare = T.buildModel({ prefs: { timezone: 'Etc/GMT+8' } }, zh)
    return rare.settings.timezone === 'Etc/GMT+8' &&
      rare.settings.tzOptions.some((o) => o.value === 'Etc/GMT+8' && o.active === true)
  })())

// ── E. 坏值注入：三个通道全坏 ⇒ 四个分段都不得出现 NaN / undefined ─────────
console.log('')
console.log('== E. 坏值注入（stats / turnTimings / timeline 全坏，喂给全部 4 个分段）==')
const dirtyCases = [
  ['E1 三通道全 null', { stats: null, turnTimings: null, timeline: null }],
  ['E2 stats 全坏 + turnTimings 是数组 + timeline.turns 非 Map',
    { stats: { turns: NaN, steps: undefined, llmMs: 'x' }, turnTimings: [null, 42, { startTime: 'x' }], timeline: { turns: 'nope' } }],
  ['E3 stats 是字符串 + 坏时间戳 + steps 非数组',
    { stats: 'nope', turnTimings: new Map([[0, { startTime: NaN }]]), timeline: { turns: new Map([['a', { steps: 'x' }]]) } }],
  ['E4 Infinity / 负数 / end<start / 空对象',
    { stats: { turns: Infinity, steps: -1 }, turnTimings: { 0: {}, 1: { startTime: 100, endTime: 5 } }, timeline: { turns: null } }],
  ['E5 全坏 + 偏好也坏（idleMinutes NaN / 时区非串 / scope 非法）',
    { stats: { turns: 'x' }, turnTimings: [], timeline: {}, prefs: { idleMinutes: NaN, timezone: 7, scope: 'nope' }, idleMs: NaN, openEndFallback: NaN }]
]
for (const [name, input] of dirtyCases) {
  const dirtyModel = T.buildModel(input, zh)
  const dirtyTree = treeOf(input)
  let blob = collectTexts(dirtyTree, []).join('\u0000') + '\u0000' + JSON.stringify(dirtyModel)
  for (const key of T.SEGMENT_KEYS) blob += '\u0000' + collectTexts(T.renderSegment(key, dirtyModel, zh, null), []).join('\u0000')
  const hits = blob.split('\u0000').filter((x) => DIRTY.test(x))
  check(name + ' ⇒ 四个分段 + 模型全无 NaN/undefined/[missing:', hits.length === 0, hits.slice(0, 4).join(' | '))
  check(name + ' ⇒ 缺失值显示 —（不是 0）',
    collectTexts(T.renderSegment('calendar', dirtyModel, zh, null), []).filter((x) => x === '\u2014').length >= 8)
}

// E7：坏时区注入（DIRTY 正则抓不到「合法形状的坏串」，所以必须单独断言内容）
check('E7 非法时区（Not/AZone / 控制字符 / 1e6 长串）注入后不上屏、不进候选、不崩',
  (() => {
    for (const z of ['Not/AZone', 'X\n\t\u0000Y', 'A'.repeat(1e6)]) {
      const injected = T.buildModel({ stats, turnTimings: null, timeline: null, prefs: { timezone: z } }, zh)
      if (injected.settings.timezone !== 'Asia/Shanghai') return false
      if (injected.settings.tzOptions.some((o) => o.value === z)) return false
      const blob = collectTexts(T.renderSegment('settings', injected, zh, null), []).join('\u0000')
      if (DIRTY.test(blob)) return false
      if (blob.indexOf(z) >= 0) return false
    }
    return true
  })())

// ── F. 偏好读写（真落盘 → 读回；坏 storage 不许崩）─────────────────────────
console.log('')
console.log('== F. 偏好读写 ==')
function fakeBox (seed) {
  const store = Object.assign({}, seed || {})
  return {
    store,
    getItem (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null },
    setItem (key, value) { store[key] = String(value) }
  }
}
const box = fakeBox()
check('F1 写回 true 且只写 dsh-usage-tab.prefs 这一个键',
  T.writePrefs(box, { idleMinutes: 15, timezone: 'UTC', scope: 'all' }) === true && Object.keys(box.store).join(',') === 'dsh-usage-tab.prefs')
console.log('   落盘内容 = ' + JSON.stringify(box.store[T.PREF_KEY]))
check('F2 读回与写入一致',
  // ⚠️ 期望值从 `DEFAULT_PREFS` 派生（P2 第三步起偏好多了「会话」页三个字段）——
  // 以后再加字段不会破这条，但"哪个字段的值不对"照样咬得住。
  JSON.stringify(T.readPrefs(box)) === JSON.stringify(Object.assign({}, T.DEFAULT_PREFS, { idleMinutes: 15, timezone: 'UTC', scope: 'all' })))
box.store[T.PREF_KEY] = '{not json'
check('F3 坏 JSON ⇒ 静默回退默认值', JSON.stringify(T.readPrefs(box)) === JSON.stringify(T.DEFAULT_PREFS))
const boom = { getItem () { throw new Error('boom') }, setItem () { throw new Error('boom') } }
check('F4 getItem/setItem 抛错 ⇒ 不崩、读回默认、写回 false',
  JSON.stringify(T.readPrefs(boom)) === JSON.stringify(T.DEFAULT_PREFS) && T.writePrefs(boom, { idleMinutes: 5 }) === false)
check('F5 当前值不在候选里 ⇒ 动态补进候选并升序',
  JSON.stringify(T.withCurrent([1, 3, 5], 7)) === JSON.stringify([1, 3, 5, 7]) &&
  JSON.stringify(T.withCurrent([1, 3, 5], 3)) === JSON.stringify([1, 3, 5]))
check('F6 偏好真的进模型：1 分钟口径把 2 分钟间隔切成两段',
  (() => {
    const gap = new Map([[0, { startTime: 1000, endTime: 61000 }], [1, { startTime: 181000, endTime: 241000 }]])
    return T.buildModel({ turnTimings: gap }, zh).totals.segmentCount === 1 &&
      T.buildModel({ turnTimings: gap, prefs: { idleMinutes: 1 } }, zh).totals.segmentCount === 2
  })())

check('F7 写盘前已归一化（0.4 分钟不许落盘成 0，非法时区不许落盘）',
  (() => {
    const box2 = fakeBox()
    T.writePrefs(box2, { idleMinutes: 0.4, timezone: 'Not/AZone', scope: 'all' })
    const raw = JSON.parse(box2.store[T.PREF_KEY])
    return raw.idleMinutes === 5 && raw.timezone === 'Asia/Shanghai' && raw.scope === 'all' &&
      T.readPrefs(box2).idleMinutes === 5
  })())

// ── G. P2 第一步：宿主 usageDaily 投影 + 日历真数据 ────────────────────────
// 这一段把「宿主半边」也拉进结构自检：静态锚点（零依赖 / 无自建路由 / schema 适配器齐备）
// + 折叠语义（逐日活跃 / 阈值 / fork 切点 / Object.is 门禁 / 日桶封顶）
// + 客户端拿真快照渲染日历（有数据 / 无数据 / 坏数据三条路）。
console.log('')
console.log('== G. P2 第一步：宿主投影 + 日历真数据 ==')
const HOST = await import('../lib/index.mjs')
const hostCode = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
// 静态锚点必须**剥掉注释**再匹配：文件头注释里正好在讲"本步不做 connection.fetch 路由"，
// 不剥就会让"不许出现自建路由"的检查被自己的说明文字判红。
const hostCodeOnly = hostCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

check('G1 宿主半静态锚点：零 import（不装包）/ 不碰 RPC 路由 / schema 适配器自带 .parse',
  !/^\s*import\s/m.test(hostCodeOnly) &&
  !/connection|fetch\s*\(|\.register\(\s*\{/.test(hostCodeOnly) &&
  /parse \(value\) \{/.test(hostCodeOnly) &&
  /PROJECTION_KEY = 'usageDaily'/.test(hostCodeOnly) &&
  /PROJECTION_STATE_VERSION = 1/.test(hostCodeOnly))
check('G2 宿主定义齐备：key / stateVersion / stateSchema.parse / wire.viewSchema.parse / init',
  HOST.usageDailyDefinition.key === 'usageDaily' &&
  HOST.usageDailyDefinition.stateVersion === 1 &&
  typeof HOST.usageDailyDefinition.stateSchema.parse === 'function' &&
  typeof HOST.usageDailyDefinition.wire.viewSchema.parse === 'function' &&
  typeof HOST.usageDailyDefinition.wire.view === 'function' &&
  typeof HOST.usageDailyDefinition.init === 'function')

const G_T0 = new Date(2026, 8, 25, 10, 0, 0).getTime()
const gEv = (type, time, data) => ({ type, time, seq: 0, data: data || {} })
const gFold = (events) => events.reduce((state, event) => HOST.foldUsageDaily(state, event), HOST.initUsageDailyState())
const gState = gFold([
  gEv('turn/start', G_T0),
  gEv('step/start', G_T0 + 30000),
  gEv('tool/result', G_T0 + 120000)
])
console.log('   宿主一次折叠 = ' + JSON.stringify(HOST.usageDailyViewOf(gState)))
console.log('   （内部游标 lastTime/openStart 不下发）')
check('G3 宿主折叠：逐日活跃 120000ms / 1 轮 / 1 段 / 最长 120000ms（+ 小时桶与日桶同源）',
  (() => {
    const view = HOST.usageDailyViewOf(gState)
    if (JSON.stringify(view.days) !== JSON.stringify({ '2026-09-25': 120000 })) return false
    if (view.activeMs !== 120000 || view.turns !== 1 || view.segments !== 1 || view.longestMs !== 120000) return false
    // A7 二期（2026-10-14 定稿）：日内小时桶必须下发，且**与日桶同源**
    // （同一天的 sum(hours) === days[day]；90 天外的老日期只有日总量，属设计而非缺数据）
    if (view.hoursByDay === null || typeof view.hoursByDay !== 'object') return false
    const dayKeys = Object.keys(view.days)
    for (const day of dayKeys) {
      const bucket = view.hoursByDay[day]
      if (bucket === undefined || bucket === null) continue
      let sum = 0
      for (const h of Object.keys(bucket)) sum += bucket[h]
      if (sum !== view.days[day]) return false
    }
    return Object.keys(view.hoursByDay).length > 0
  })())
check('G4 Object.is 门禁：白名单外事件 / 无时间戳 / 坏事件一律返回同一引用',
  (() => {
    const cases = [gEv('title/update', G_T0 + 1e7), { type: 'turn/start', seq: 1, data: {} }, gEv('turn/start', NaN), null, 'x']
    return cases.every((event) => HOST.foldUsageDaily(gState, event) === gState)
  })())
check('G5 fork 继承切点：清账重来，且同毫秒合成 closer 返回同一引用（不造 0 长幻影段）',
  (() => {
    const cut = G_T0 + 60000
    const seed = HOST.foldUsageDaily(gState, gEv('session/end-seed', cut, { inherited: true }))
    if (Object.keys(seed.days).length !== 0 || seed.activeMs !== 0 || seed.segments !== 0 || seed.turns !== 0) return false
    if (HOST.foldUsageDaily(seed, gEv('turn/end', cut, { reason: 'forked' })) !== seed) return false
    const own = HOST.foldUsageDaily(seed, gEv('user/message', cut + 240000))
    return own.segments === 1 && own.activeMs === 0
  })())
check('G6 日桶封顶（MAX_KEPT_DAYS=400）且不裁会话总量',
  (() => {
    const events = []
    let cursor = new Date(2026, 0, 1, 9, 0, 0).getTime()
    for (let i = 0; i < HOST.MAX_KEPT_DAYS + 5; i += 1) {
      events.push(gEv('user/message', cursor), gEv('assistant/message', cursor + 60000))
      cursor += 86400000
    }
    const state = gFold(events)
    return HOST.MAX_KEPT_DAYS === 400 && Object.keys(state.days).length === 400 &&
      state.activeMs === (HOST.MAX_KEPT_DAYS + 5) * 60000
  })())

const gSnap = {
  ids: ['s-a', 's-b', 's-c'],
  byId: {
    's-a': { projectionValues: { usageDaily: { days: { '2026-09-25': 3600000, '2026-09-24': 1800000 }, activeMs: 5400000, turns: 4, segments: 3, longestMs: 3600000 } } },
    's-b': { projectionValues: { usageDaily: { days: { '2026-09-25': 600000, '2026-09-20': 60000 }, activeMs: 3000000, turns: 2, segments: 4, longestMs: 1200000 } } },
    's-c': { projectionValues: {} }
  }
}
const gModel = T.buildModel({
  stats, turnTimings, timeline, sessions: gSnap,
  openEndFallback: new Date(2026, 8, 25, 10, 0, 0).getTime()
}, zh)
console.log('   日历模型 cum KPI = ' + JSON.stringify(gModel.calendar.cumKpis.map((k) => [k.label, k.value])))
console.log('   日历模型 seg KPI = ' + JSON.stringify(gModel.calendar.segKpis.map((k) => [k.label, k.value])))
console.log('   覆盖会话 = ' + gModel.calendar.sessionsText + ' · 热力图 ' + gModel.calendar.heat.length + ' 格 · 柱状 ' + gModel.calendar.bars.length + ' 根')
check('G7 客户端日历：聚合出真数据（今日 1h10m / 段数 7 / 覆盖 2 个会话），模型无脏值',
  gModel.calendar.hasData === true && gModel.calendar.sessions === 2 &&
  gModel.calendar.cumKpis[0].value === '1h10m' && gModel.calendar.segKpis[2].value === '7' &&
  !DIRTY.test(JSON.stringify(gModel.calendar)))
check('G8 客户端日历：有数据 ⇒ 两张真卡（无骨架、无 P2 占位标签、热力 84 格 / 柱 14 根）',
  (() => {
    const cal = T.renderSegment('calendar', gModel, zh, null)
    return findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton').length === 0 &&
      findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'p2-tag').length === 0 &&
      findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'cal-heat-cell').length === T.CALENDAR_HEAT_DAYS &&
      findNodes(cal, (n) => n.props && n.props.className === 'ut-hour-bar').length === T.CALENDAR_BAR_DAYS &&
      findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'cal-note').length === 1
  })())
check('G9 客户端日历：无投影 ⇒ 退回 P1.1 空态（骨架 8 行 + 值全 — + P2 标签）',
  (() => {
    const emptyModel = T.buildModel({ stats, turnTimings, timeline }, zh)
    const cal = T.renderSegment('calendar', emptyModel, zh, null)
    const skel = findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'skeleton')
    const vals = skel.length === 1 ? findNodes(skel[0], (n) => n.props && n.props.className === 'ut-skel-val') : []
    return skel.length === 1 && vals.length === 8 && vals.every((v) => collectTexts(v.children, []).join('') === '\u2014') &&
      findNodes(cal, (n) => n.props && n.props['data-usage-role'] === 'p2-tag').length === 1
  })())
// 坏快照注入：会话列表快照全坏时，四个分段 + 模型都不得出现 NaN / undefined
const gDirtySnaps = [
  ['G10 快照是字符串', 'nope'],
  ['G11 ids 是字符串 + byId 值不是对象', { ids: 'x', byId: { a: 42 } }],
  ['G12 usageDaily 是字符串', { ids: ['a'], byId: { a: { projectionValues: { usageDaily: 'x' } } } }],
  ['G13 日键/数字全坏（NaN / Infinity / 负数 / 坏键）',
    { ids: ['a'], byId: { a: { projectionValues: { usageDaily: { days: { 'bad': 1, '2026-13-01': 2, '2026-09-25': NaN, '2026-09-24': Infinity, '2026-09-23': -5 }, activeMs: 'x', turns: null, segments: {}, longestMs: NaN } } } } }],
  ['G14 projectionsBySession 兜底载体也坏', { ids: ['a'], byId: {}, projectionsBySession: { a: { values: { usageDaily: { days: 'x' } } } } }]
]
for (const [name, snap] of gDirtySnaps) {
  const dirty = T.buildModel({ stats: null, turnTimings: null, timeline: null, sessions: snap, now: 42 }, zh)
  let blob = JSON.stringify(dirty.calendar)
  const dirtyCal = T.renderSegment('calendar', dirty, zh, null)
  blob += '\u0000' + collectTexts(dirtyCal, []).join('\u0000')
  for (const key of T.SEGMENT_KEYS) blob += '\u0000' + collectTexts(T.renderSegment(key, dirty, zh, null), []).join('\u0000')
  const hits = blob.split('\u0000').filter((x) => DIRTY.test(x))
  check(name + ' ⇒ 日历走空态且四个分段无 NaN/undefined/[missing:', hits.length === 0, hits.slice(0, 4).join(' | '))
  check(name + ' ⇒ 拿不到真数据时仍然只画 8 行骨架（值 —）',
    findNodes(dirtyCal, (n) => n.props && n.props.className === 'ut-skel-val').length === 8)
}

// ── G15~G17（2026-09-25 独立审查的覆盖盲区）：清洗闸 / 注入声明也钉在结构级 ──
// 为什么非加不可：实测把这四处的"闸"拆掉后 **self-test 与 struct-check 双双全绿**
// （`stateSchema.cleanDays` 不封顶 / `usageDailyViewOf` 的日键闸 / 客户端
// `cleanUsageDaily` 的日键闸 / `inject` 声明）⇒ 修复会被静默回退。
check('G15 宿主清洗闸：stateSchema / viewSchema 的 parse 也封顶日桶 + viewOf 丢弃非法日键（含尾随空格）',
  (() => {
    const rawDays = {}
    let cursor = new Date(2026, 0, 1, 9, 0, 0).getTime()
    for (let i = 0; i < HOST.MAX_KEPT_DAYS + 7; i += 1) { rawDays[HOST.dayKeyOf(cursor)] = 60000; cursor += 86400000 }
    const rawSnap = { days: rawDays, activeMs: 7, turns: 1, segments: 1, longestMs: 60000 }
    const parsedKeys = Object.keys(HOST.usageDailyStateSchema.parse(rawSnap).days)
    if (parsedKeys.length !== HOST.MAX_KEPT_DAYS) return false
    if (Object.keys(HOST.usageDailyViewSchema.parse(rawSnap).days).length !== HOST.MAX_KEPT_DAYS) return false
    const view = HOST.usageDailyViewOf({
      days: { '2026-09-25': 1000, 'bad': 5, '2026-13-01': 7, '2026-09-26 ': 9, '2026-9-2': 11, '2026-09-24': -1 },
      activeMs: 1000, turns: 1, segments: 1, longestMs: 1000
    })
    return JSON.stringify(view.days) === JSON.stringify({ '2026-09-25': 1000 })
  })())
check('G16 客户端聚合 / 窗口闸：非法日键不进 agg.days，也不虚增本周 / 本月（纵深防御）',
  (() => {
    const dirty = T.aggregateUsageDaily({
      ids: ['s-a'],
      byId: {
        's-a': {
          projectionValues: {
            usageDaily: {
              days: { '2026-09-25': 1000, '2026-09-22 ': 999999, '2026-9-2': 888888, 'x': 777777, '2026-13-01': 666666 },
              activeMs: 1000, turns: 1, segments: 1, longestMs: 1000
            }
          }
        }
      }
    })
    if (Object.keys(dirty.days).sort().join(',') !== '2026-09-25') return false
    const model = T.buildCalendarModel({
      hasData: true, sessions: 1, activeMs: 1000, turns: 1, segments: 1, longestMs: 1000,
      days: { '2026-09-25': 1000, '2026-09-22 ': 999999, '2026-9-2': 888888, 'x': 777777 }
    }, new Date(2026, 8, 25, 10, 0, 0).getTime(), zh)
    return model.cumKpis.map((k) => k.value).join(',') === '1.0s,1.0s,1.0s'
  })())
check('G17 🩸 宿主半 inject：必须导出 inject 且含 sessionProjections（否则 usageDaily 永不注册，界面只显示"正常空态"）',
  Array.isArray(HOST.inject) && HOST.inject.includes('sessionProjections'))

// ── G18（2026-10-14 复审）：A 视图**唯一的高度闸门**必须钉在结构级 ──
// 为什么非加不可：A 视图的 40 条截断已经去掉，改由 `.ut-ses-groups` 的
// `max-height` + 滚动兜住"会话一多就撑爆页面"；实测**删掉这个 max-height 后三套检查照绿**
// （2000 个会话会渲染 12,023 个 vnode / 2000 行）。截断这层保护没了，高度闸门就是最后一根绳。
check('G18 🩸 A 视图的唯一高度闸门：`.ut-ses-groups` 必须**恰好一条**生效的 max-height（≥400px）且有 overflow',
  (() => {
    // ⚠️ 判据不能只查"存在"—— 实测：`max-height:0px` 与"追加一条同名规则覆盖"都能全绿
    //    ⇒ 这里要求**声明恰好一条**、值 ≥ 400px（真能兜住内容），overflow 必须是 auto。
    const decls = code.match(/\.ut-ses-groups\{[^}]*max-height:(\d+)px/g) || []
    if (decls.length !== 1) return false
    const m = /max-height:(\d+)px/.exec(decls[0])
    return m !== null && Number(m[1]) >= 400 && /\.ut-ses-groups\{[^}]*overflow:auto[^}]*\}/.test(code)
  })())

// ── G19（2026-10-14 复审）：分段控件的**回写字段**必须是它自己那一项 ──
// 为什么非加不可：`pick` 分支写错字段（例如 `ses.range` 写进 `sesWindow`）时，控件看上去能点、
// 但改的是别的偏好 ⇒ 行为完全错位，而行为层很难在 self-test 里直接驱动（需要假 onPick）。
check('G19 分段控件回写：`ses.win` 必须落到 `patch.sesWindow`（写错字段 = 控件形同虚设）',
  /else if \(group === "ses\.win"\) patch\.sesWindow = Number\(value\)/.test(code) &&
  // 2026-10-14 定稿「合并成一个吧」⇒ 旧的独立「显示范围」控件与它的回写分支都必须消失
  !/group === "ses\.range"/.test(code) &&
  !/segControl\("ses\.range"/.test(code))

// ── G20（2026-10-14 实测「ui颜色没接」）：**图表色不许用 brand-primary** ──
// 背景：`--dsw-alias-brand-primary` 在任何主题下都等于主文字色（黑 / 白）⇒ 拿它画图表 =
// 看上去"根本没上颜色"（宿主 token 实测结论：见宿主包自带的主题变量定义）。
// 🩸 这种缺陷**任何"零硬编码色"扫描都抓不到**（token 名合法、也没写 hex）⇒ 只能靠**禁止清单**钉住。
// 佐证（2026-10-14 直扫 app.asar）：`--dsw-alias-state-business-success/warn/error/business-primary`
// 宿主都有定义；而 dsh-context 那套 `--color-blue-500` 是**它自己 bundle 带的**，宿主里 NOT FOUND（别抄错）。
// ── G21（2026-10-14 独立审查）：A3 环比必须**等长对位** ──
// 病象：拿"本月 1 日~今天"（12 天）去比"上月整月"（31 天）⇒ **系统性假跌** ——
// 一个每天匀速 1h 的人，1 月 20 日打开会看到「本月 ▼ 35%」，元旦当天 ▼ 50%。
// 这不是用户在少用，是口径产物（有个铁证）。
// ⇒ 结构级钉住：对比期必须是"上周一~上周同日"与"上月 1 日~上月同日（不足取月末）"。
check('G21 🩸 A3 环比必须「等长对位」（不许拿本期到今天去比上一期一整段）',
  /dayKeyAddDays\(prevWeekStart, elapsedDays\)/.test(code) &&
  /Math\.min\(todayDayOfMonth, prevMonthDays\)/.test(code) &&
  /key >= prevMonthStart && key <= prevMonthEnd/.test(code))

check('G20 🩸 图表色必须走 `state-business-primary`，不许用 `brand-primary`（它是黑白）',
  (() => {
    const chartClasses = [
      'ut-gantt-bar', 'ut-hour-bar', 'ut-rank-bar',
      'ut-heat-l1', 'ut-heat-l2', 'ut-heat-l3', 'ut-heat-l4',
      'ut-ses-bar', 'ut-ses-band-l1', 'ut-ses-band-l2', 'ut-ses-band-l3', 'ut-ses-band-l4', 'ut-ses-day-bar'
    ]
    for (const cls of chartClasses) {
      const m = new RegExp('\\.' + cls + '\\{[^}]*\\}').exec(code)
      if (m === null) return false
      if (/brand-primary/.test(m[0])) return false
      // 允许两条路线：宿主彩色语义色，或插件自带数据色 `--ut-c1..c6`
      if (!/state-business-primary|--ut-c/.test(m[0])) return false
    }
    return true
  })())

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
