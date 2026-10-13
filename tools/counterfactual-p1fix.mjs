#!/usr/bin/env node
/**
 * dsh-usage-tab · P1-fix 反事实对照（**纯内存替换，不动磁盘上的 lib/client.js**）
 * ============================================================================
 *
 * 目的：证明 test/self-test.mjs 里 T18 / T17 / T18b 那几条新断言**不是假绿**——
 *      把修复拆掉之后，它们必须真的变红。
 *
 * 做法：读 lib/client.js 原文 → 在**内存里**做定点字符串替换造出"修复缺失"的变体 →
 *      new Function 装载变体 → 跑对应断言 → 期望断言**失败**。
 *      全程不写 client.js（源文件字节不变，脚本末尾会复核 sha256）。
 *
 * 用法：node tools/counterfactual-p1fix.mjs
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const url = new URL('../lib/client.js', import.meta.url)
const original = readFileSync(url, 'utf8')
const before = createHash('sha256').update(original).digest('hex')

const reactStub = {
  createElement: function (type, props) { return { type, props, children: Array.prototype.slice.call(arguments, 2) } },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
}

function load (source) {
  let captured = null
  const requireStub = (id) => { if (id === 'react') return reactStub; throw new Error('unexpected require: ' + id) }
  new Function('window', 'require', source)({ __ModuleLoader__: { load: (spec) => { captured = spec } } }, requireStub)
  return captured.factory(requireStub).__test
}

/** 与 struct-check 相同的夹具：全日志 15 轮 / 135 步；窗口第 8~15 轮 / 42 步。 */
function modelAndTree (T) {
  const baseTs = new Date(2026, 8, 25, 7, 6, 17).getTime()
  const stats = { turns: 15, steps: 135 }
  const turnTimings = new Map()
  for (let turn = 8; turn <= 15; turn += 1) {
    const start = baseTs + (turn - 8) * 180000
    turnTimings.set(turn, { startTime: start, endTime: start + 90000 })
  }
  const timeline = { turns: new Map() }
  let seq = 0
  for (let turn = 8; turn <= 15; turn += 1) {
    const steps = []
    for (let k = 0; k < (turn < 15 ? 5 : 7); k += 1) {
      steps.push({ step: k, start: { time: baseTs + (turn - 8) * 180000 + k * 1000, seq: (seq += 1) } })
    }
    timeline.turns.set(turn, { turn, steps })
  }
  const t = (key) => T.DICT_ZH[key]
  const model = T.buildModel({ stats, turnTimings, timeline, idleMs: T.IDLE_THRESHOLD_MS }, t)
  const tree = T.UsageView({
    sessionId: 'counterfactual',
    useProjection: (key) => (key === 'sessionStats' ? stats : undefined),
    useChat: (selector) => selector({ legacy: { turnTimings }, timeline }),
    t
  })
  return { model, tree }
}

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

// 三条"修复点"各自的正向断言（与 self-test T17 / T18 / T18b 同义）
const ASSERTIONS = {
  'T18 脚注渲染进卡面': (T) => findNodes(modelAndTree(T).tree, (n) => n.props && n.props['data-usage-role'] === 'source-note').length === 1,
  'T17 甘特窗口范围标注': (T) => {
    const { model, tree } = modelAndTree(T)
    const tags = findNodes(tree, (n) => n.props && n.props.className === 'ut-card-tag')
    return model.ganttWindowText === '仅显示已加载窗口：第 8~15 轮' &&
      tags.length === 1 && collectTexts(tags[0].children, []).join('') === '仅显示已加载窗口：第 8~15 轮'
  },
  'T18b 窗口步数文案': (T) => collectTexts(modelAndTree(T).tree, []).some((text) => text.startsWith('已加载窗口 42 步'))
}

// 变体 = [说明, 内存替换的 [old, new], 期望变红的断言]
const VARIANTS = [
  ['拆掉脚注渲染（.ut-source 那一行）',
    ['      cards.push(h("div", {\n        className: "ut-source",\n        key: "source",\n        "data-usage-role": "source-note"\n      }, model.sourceNote));',
      '      /* counterfactual: 脚注渲染被拆掉 */'],
    'T18 脚注渲染进卡面'],
  ['把窗口范围写死成空串（ganttWindowText: ""）',
    ['        ganttWindowText: ganttWindowText,', '        ganttWindowText: "",'],
    'T17 甘特窗口范围标注'],
  ['把「已加载窗口 」改回旧措辞「本会话共 」',
    ['      "hours.sum": "已加载窗口 ",', '      "hours.sum": "本会话共 ",'],
    'T18b 窗口步数文案']
]

let ok = 0
let bad = 0
console.log('dsh-usage-tab P1-fix 反事实对照（内存变体，不动源文件）')
console.log('client.js sha256(before) = ' + before.slice(0, 16) + '…')
console.log('----')

for (const [label, [from, to], assertionName] of VARIANTS) {
  // ① 基线：原文必须在
  const hits = original.split(from).length - 1
  if (hits !== 1) {
    bad += 1
    console.log('BAD   基线失配：替换锚点在原文里出现 ' + hits + ' 次（应为 1）→ ' + label)
    continue
  }
  // ② 变体：断言必须变红
  const mutated = original.replace(from, to)
  let variantResult
  try {
    variantResult = ASSERTIONS[assertionName](load(mutated))
  } catch (err) {
    variantResult = 'throw: ' + (err && err.message ? err.message : String(err))
  }
  const wentRed = variantResult === false
  // ③ 对照：原文必须变绿（否则不是"反事实"，是断言本身写坏了）
  const baselineGreen = ASSERTIONS[assertionName](load(original)) === true
  if (wentRed && baselineGreen) {
    ok += 1
    console.log('OK    ' + label)
    console.log('      ⇒ 「' + assertionName + '」拆掉后变红、原文下变绿（反事实成立）')
  } else {
    bad += 1
    console.log('BAD    ' + label)
    console.log('      ⇒ 变体结果=' + JSON.stringify(variantResult) + '（应 false）；原文结果绿=' + baselineGreen + '（应 true）')
  }
}

// ④ 源文件字节必须没被动过
const after = createHash('sha256').update(readFileSync(url, 'utf8')).digest('hex')
console.log('----')
console.log('源文件 sha256(after)  = ' + after.slice(0, 16) + '  （未改动：' + (before === after) + '）')
console.log('反事实对照： OK=' + ok + '  BAD=' + bad)
if (bad > 0 || before !== after) {
  console.log('COUNTERFACTUAL FAILED')
  process.exitCode = 1
} else {
  console.log('COUNTERFACTUAL ALL GREEN')
}
