#!/usr/bin/env node
/**
 * dsh-usage-tab · 二级菜单 + 独立审查的反事实对照（**双驱动**：真 self-test + 真 struct-check）
 * ============================================================================
 *
 * 🩸 为什么要重写（补齐上一版的覆盖缺口）：
 *   旧版跑的是**脚本里自写的同义断言**（`ASSERTIONS` 表），不是 `test/self-test.mjs`
 *   的真断言 —— 断言与实现可能一起写错，"拆掉修复点就变红"于是证明不了任何东西。
 *   现在改成：**在临时副本上拆掉修复点，跑真实的 `test/self-test.mjs`，看它是否变红**。
 *
 * 做法（全程不写工作区里的 lib/ 与 test/）：
 *   ① 把 `test/self-test.mjs`、`tools/struct-check-subnav.mjs` 与**整个 `lib/`**
 *      （client.js + index.mjs）复制到 `%TEMP%\dsh-usage-cf-xxxx\`（保持相对结构，
 *      self-test 读的是 `../lib/client.js` 并 import `../lib/index.mjs`）；
 *   ② **基线**：在副本上跑真 self-test 与真 struct-check，两者都必须全绿
 *      （否则副本机制/环境本身有问题）；
 *   ③ 每个**变体**：把"缺功能"的源码写进副本的 `lib/<file>`，再按该变体声明的
 *      `drivers`（默认 `['self-test']`）跑真检查器，要求 ① 至少一条 FAIL / BAD；
 *      ② 每条"目标用例/目标检查"（子串匹配）都出现在失败列表里；
 *   ④ 复核工作区源文件 sha256 未变；默认删掉临时目录（`--keep` 可保留）。
 *
 * 🩸 2026-09-25 独立审查的**结构性缺口修复**：
 *   本工具原先只驱动 self-test，而 G10~G17 那套"坏快照注入 / 清洗闸 / inject 声明"
 *   **只存在于 struct-check** ⇒ 那部分断言从未被反事实验证过（这里就漏过一处）。
 *   现在变体可以声明 `drivers: ['self-test', 'struct-check']`，两段都真跑、都真判定。
 *
 * 覆盖（至少）：空闲阈值归一化 / 上界、ARIA（role/aria-selected 与 aria-label）、
 *              Intl 校验，既有的三项（二级导航渲染 / 分段派发 / 偏好落盘），
 *              **P2 第一步**的 8 项（宿主注册 / stateSchema.parse 适配器 / wire /
 *              fork 切点清账 / Object.is 门禁 / 日历真数据渲染 / 空态闸门 / 无投影会话跳过），
 *              结构缺口补的 5 项（V18~V22），**P2 第二步回填**的 6 项（V30~V34），
 *              **P2 第三步「会话」页**：会话页本体（V35~V42）+ 相关修复（V43~V56）+
 *              相关回归守护（V57~V65）。
 *
 * 用法：node tools/counterfactual-subnav.mjs [--keep]
 *   --keep  保留临时副本目录（便于人工复核变体源码）
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, openSync, closeSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const HOST = join(ROOT, 'lib', 'index.mjs')
const SELF_TEST = join(ROOT, 'test', 'self-test.mjs')
const STRUCT_CHECK = join(ROOT, 'tools', 'struct-check-subnav.mjs')
const KEEP = process.argv.includes('--keep')

const original = readFileSync(CLIENT, 'utf8')
const originalHost = readFileSync(HOST, 'utf8')
const shaBefore = createHash('sha256').update(original).digest('hex')
const shaBeforeHost = createHash('sha256').update(originalHost).digest('hex')
/** 变体可以改的源文件（相对 lib/）：原件的卷影，用于「锚点唯一」判定与复原。 */
const SOURCES = { 'client.js': original, 'index.mjs': originalHost }

// ── 临时副本 ──────────────────────────────────────────────────────────────
const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-usage-cf-'))
/**
 * 🩸 **每个实例一个日志目录**（2026-10-14 实测抓到）。
 *
 * 病象：同一份代码连跑三次得到 `BAD=1` / `BAD=1` / `BAD=0` 三种结果、退出码恒为 1。
 * 根因**不是**临时副本（那个本来就是 `mkdtempSync` 唯一的），而是**日志目录是固定路径**：
 *   `out\cf-logs\<label>.txt` —— 子进程 stdout 用 fd **直接写这个文件**，
 *   于是**两个实例同时在跑**时互相覆盖/截断，
 *   解析出来的 `passed/failed` 是**别人的**（甚至半截的）⇒ 数字错乱、结论不可信。
 * ⇒ 修法：日志目录带上实例标识（`basename(tmpRoot)`）。
 * ⚠️ 纪律：这个工具**同一时间只允许一个实例**（虽然现在隔离了，但没有全局锁）。
 */
const LOG_DIR = join(ROOT, 'out', 'cf-logs', basename(tmpRoot))
mkdirSync(join(tmpRoot, 'test'), { recursive: true })
mkdirSync(join(tmpRoot, 'lib'), { recursive: true })
mkdirSync(join(tmpRoot, 'tools'), { recursive: true })
cpSync(SELF_TEST, join(tmpRoot, 'test', 'self-test.mjs'))
// 🩸 P2 第一步起 self-test 会 **import ../lib/index.mjs**（宿主半）⇒ 副本必须带上整个 lib/
cpSync(join(ROOT, 'lib'), join(tmpRoot, 'lib'), { recursive: true })
// 🩸 2026-09-25 独立审查的**结构性缺口**：这个工具原先只驱动 self-test，
// 而 G10~G17 那套"坏快照注入 / 清洗闸 / inject 声明"**只存在于 struct-check**
// ⇒ 那部分断言从未被反事实验证过（这里就漏过一处）。现在第二段也驱动它（同样是纯读脚本）。
cpSync(STRUCT_CHECK, join(tmpRoot, 'tools', 'struct-check-subnav.mjs'))
writeFileSync(join(tmpRoot, 'lib', 'client.js'), original, 'utf8')
writeFileSync(join(tmpRoot, 'lib', 'index.mjs'), originalHost, 'utf8')

// ── 跑真 self-test（输出走 fd 落盘，不用管道：沙箱下管道可能 EPERM）────────
function runSelfTest (label) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  const outFile = join(LOG_DIR, label + '.txt')
  const fd = openSync(outFile, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [join(tmpRoot, 'test', 'self-test.mjs')], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 120000
    })
  } finally {
    closeSync(fd)
  }
  const text = readFileSync(outFile, 'utf8')
  const failed = [...text.matchAll(/^FAIL {2}(.+?)\s*$/gm)].map((m) => m[1])
  const summary = text.match(/^passed: (\d+)\s+failed: (\d+)$/m)
  return {
    file: outFile,
    text,
    failed,
    passed: summary ? Number(summary[1]) : NaN,
    failedCount: summary ? Number(summary[2]) : NaN,
    allGreen: /ALL GREEN/.test(text),
    timedOut: result && (result.error && result.error.code === 'ETIMEDOUT')
  }
}

/**
 * 第二驱动器：在**同一份副本**上跑真实的 `tools/struct-check-subnav.mjs`。
 * 它同样是纯读脚本（只 readFileSync lib/ + 相对 import ../lib/index.mjs）⇒ 副本里可用。
 */
function runStructCheck (label) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
  const outFile = join(LOG_DIR, label + '.txt')
  const fd = openSync(outFile, 'w')
  let result
  try {
    result = spawnSync(process.execPath, [join(tmpRoot, 'tools', 'struct-check-subnav.mjs')], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 120000
    })
  } finally {
    closeSync(fd)
  }
  const text = readFileSync(outFile, 'utf8')
  // BAD 行格式：`BAD  <name>` 或 `BAD  <name>  :: <detail>` ⇒ 只取名字。
  const badNames = [...text.matchAll(/^BAD {2}(.+)$/gm)].map((m) => m[1].split('  :: ')[0].trim())
  const summary = text.match(/^结构级自检： OK=(\d+)\s+BAD=(\d+)$/m)
  return {
    file: outFile,
    text,
    badNames,
    okCount: summary ? Number(summary[1]) : NaN,
    badCount: summary ? Number(summary[2]) : NaN,
    allGreen: /STRUCT ALL GREEN/.test(text),
    timedOut: result && (result.error && result.error.code === 'ETIMEDOUT')
  }
}

// ── 变体表：拆掉"修复点"，真断言必须变红 ──────────────────────────────────
// anchor 必须在原件里恰好出现 1 次；expect 用失败用例名的**子串**匹配。
const VARIANTS = [
  {
    label: 'V1 拆掉二级导航渲染',
    why: 'P1.1 结构性回归（既有反事实，保留）',
    anchor: '      var cards = [subnavNode(segment, t, pick)];',
    to: '      var cards = []; /* counterfactual: 二级导航被拆掉 */',
    expect: ['T19 二级分段']
  },
  {
    label: 'V2 拆掉分段派发（calendar / sessions 分支）',
    why: '分段正文派发（既有反事实，保留）',
    anchor: '      if (key === "calendar") return calendarBody(model, t);\n      if (key === "kline") return klineBody(model, t);\n      if (key === "sessions") return sessionsBody(model, t, onPick);',
    to: '      /* counterfactual: 分段派发被拆掉 */',
    expect: ['T19b 分段派发', 'T19c 日历 / 会话']
  },
  {
    label: 'V3 拆掉偏好落盘（writePrefs 不再 setItem）',
    why: '偏好持久化（既有反事实，保留）',
    anchor: '        box.setItem(PREF_KEY, JSON.stringify(clean));',
    to: '        /* counterfactual: 没落盘 */;',
    expect: ['T19e 偏好读写']
  },
  {
    label: 'V4 拆掉空闲阈值的归一化（恢复"round 前校验"旧写法）',
    why: '0.4 分钟必须被 round 后复查 ⇒ 回退默认 5',
    anchor: [
      '      var idle = DEFAULT_PREFS.idleMinutes;',
      '      var idleRaw = numOf(source.idleMinutes);',
      '      if (idleRaw !== null) {',
      '        var rounded = Math.round(idleRaw);',
      '        if (rounded >= 1 && rounded <= MAX_IDLE_MINUTES) idle = rounded;',
      '      }'
    ].join('\n'),
    to: [
      '      var idle = numOf(source.idleMinutes);',
      '      idle = idle === null || idle <= 0 ? DEFAULT_PREFS.idleMinutes : Math.round(idle);',
      '      /* counterfactual: 归一化被拆掉（旧的 round 前校验） */'
    ].join('\n'),
    expect: ['T19h 空闲阈值']
  },
  {
    label: 'V5 只拆上界（保留"先 round 再校验"）',
    why: '1e308 越界必须回退默认值，不许产出 Infinity',
    anchor: '        if (rounded >= 1 && rounded <= MAX_IDLE_MINUTES) idle = rounded;',
    to: '        if (rounded >= 1) idle = rounded; /* counterfactual: 上界被拆掉 */',
    expect: ['T19h 空闲阈值']
  },
  {
    label: 'V6 拆掉 tab 语义（退回只有 aria-pressed）',
    why: 'tablist 的子项必须是 role=tab + aria-selected',
    anchor: [
      '      if (group === "subnav") {',
      '        props.role = "tab";',
      '        props["aria-selected"] = active ? "true" : "false";',
      '      } else {',
      '        props["aria-pressed"] = active ? "true" : "false";',
      '      }'
    ].join('\n'),
    to: '      props["aria-pressed"] = active ? "true" : "false"; /* counterfactual: tab 语义被拆掉 */',
    expect: ['T19 二级分段', 'T19j ARIA']
  },
  {
    label: 'V7 拆掉 group aria-label',
    why: 'role=group 必须带可访问名（tablist 的名字也走同一行）',
    anchor: '        props["aria-label"] = t(SEG_GROUP_ARIA[group]);',
    to: '        /* counterfactual: aria-label 被拆掉 */;',
    expect: ['T19 二级分段', 'T19j ARIA']
  },
  {
    label: 'V8 拆掉 Intl 真校验（只留长度判断）',
    why: 'Not/AZone / 控制字符必须被 Intl 拒掉',
    anchor: '        new Intl.DateTimeFormat("en-US", { timeZone: value });',
    to: '        /* counterfactual: Intl 校验被拆掉 */;',
    expect: ['T19i 时区']
  },
  {
    label: 'V9 拆掉整条时区校验（恢复"只查非空串"）',
    why: '整体回归 —— 校验行退回旧写法',
    anchor: '      var zone = isValidTimezone(source.timezone) ? source.timezone : DEFAULT_PREFS.timezone;',
    to: '      var zone = typeof source.timezone === "string" && source.timezone.length > 0 ? source.timezone : DEFAULT_PREFS.timezone; /* counterfactual */',
    expect: ['T19i 时区']
  },
  // ── P2 第一步（2026-09-25）：宿主投影 + 日历真数据 ──────────────────────────
  {
    label: 'V10 宿主半不注册 usageDaily 投影',
    file: 'index.mjs',
    why: 'P2：不注册 ⇒ 会话列表行永远不会带这个投影值，日历只能是空态',
    anchor: '    registry.register(usageDailyDefinition)',
    to: '    /* counterfactual: 投影没注册 */;',
    expect: ['T20h 宿主 apply']
  },
  {
    label: 'V11 拆掉 stateSchema 的 .parse 适配器（换成 schemastery 式无 parse 的 schema）',
    file: 'index.mjs',
    why: '🩸 前车之鉴：宿主 restore 裸调 stateSchema.parse ⇒ 没有 .parse 会让会话第二次加载 TypeError',
    anchor: 'export const usageDailyStateSchema = {\n  parse (value) {',
    to: 'export const usageDailyStateSchema = {\n  /* counterfactual: 没有 .parse（schemastery 的 Schema 就是这个形状） */\n  parseIsMissing (value) {',
    expect: ['T20 宿主定义', 'T20f 宿主状态 schema']
  },
  {
    label: 'V12 拆掉 wire（viewSchema/view）',
    file: 'index.mjs',
    why: '🩸 dsh-session-projection 里 `if (def.wire === void 0) continue` ⇒ 不写 wire，客户端一个字节都收不到',
    anchor: '  wire: {\n    viewSchema: usageDailyViewSchema,\n    view: (state) => usageDailyViewOf(state),\n  },',
    to: '  /* counterfactual: 没有 wire ⇒ 这个键不下发 */',
    expect: ['T20 宿主定义']
  },
  {
    label: 'V13 拆掉 fork 继承切点的清账（父会话历史留在子会话账上）',
    file: 'index.mjs',
    why: 'P2：fork 子会话必须从切点重新起账，否则父会话那一段被重复计入',
    anchor: "  if (type === 'session/end-seed' && event.data !== null && typeof event.data === 'object' && event.data.inherited === true) {\n    if (time === null) return state\n    return freshStateAt(time)\n  }",
    to: '  /* counterfactual: fork 切点不再清账 */',
    expect: ['T20e 宿主折叠']
  },
  {
    label: 'V14 拆掉 Object.is 门禁（白名单外的事件也照样折）',
    file: 'index.mjs',
    why: 'P2：不关心的事件必须返回同一引用，否则每个事件都被当成账变了（下游白跑 + 通知风暴）',
    anchor: '  if (!ACTIVITY_SET.has(type)) return state',
    to: '  if (false && !ACTIVITY_SET.has(type)) return state /* counterfactual: 门禁被拆掉 */',
    expect: ['T20d 宿主折叠']
  },
  {
    label: 'V15 拆掉日历的真数据渲染（永远走骨架）',
    why: 'P2：日历页必须读真数据，而不是永远空态',
    anchor: '      if (cal === null || typeof cal !== "object" || cal.hasData !== true) {',
    to: '      if (true) { /* counterfactual: 日历永远走骨架 */',
    expect: ['T21d 客户端']
  },
  {
    label: 'V16 拆掉「拿不到就空态」的判定（零数据也照画）',
    why: 'P2：hasData 是"有没有真数据"的唯一闸门；拆掉就会拿一屏 0 冒充数据',
    anchor: '        note: tr("cal.note")\n      };\n      var agg = aggregated !== null && typeof aggregated === "object" ? aggregated : null;\n      if (agg === null || agg.hasData !== true) return empty;',
    to: '        note: tr("cal.note")\n      };\n      var agg = aggregated !== null && typeof aggregated === "object" ? aggregated : null;\n      if (agg === null) return empty; /* counterfactual: 空态闸门被拆掉 */',
    expect: ['T21c 客户端', 'T21e 客户端']
  },
  {
    // 2026-09-25 改写：旧版拆的是 `cleanUsageDaily` 对 null 的返回（想让"无投影会话"被算进来），
    // 但定稿的新口径「只数 `activeMs > 0`」**顺带**挡住了那种情况 ⇒ 旧拆点不再影响
    // 「覆盖会话」计数、变体失效（实测拆掉后 self-test 仍 67/0）。改成守**新口径**本身。
    label: 'V17 拆掉「零活跃会话不计入覆盖数」（2026-09-25 定稿的口径）',
    why: 'P2 口径：有投影行但 `activeMs === 0` 的会话不该计入「覆盖会话」（宿主给每个折过账的会话都写一行，无条件计数会让数字虚高）',
    anchor: '        if (ledger.activeMs > 0) agg.sessions += 1;',
    to: '        agg.sessions += 1; /* counterfactual */',
    expect: ['T21b 客户端']
  },
  // ── 2026-09-25 独立审查补的覆盖盲区 ──────────────
  // 这些变体一律**双驱动**：self-test（功能断言）+ struct-check（结构级坏值/闸门断言）。
  // `drivers` 不写时默认只跑 self-test（保持既有 17 条的口径不变）。
  {
    label: 'V18 删掉宿主半的 inject 声明',
    file: 'index.mjs',
    why: '🩸 没有 inject，cordis 对"未声明注入的服务读取"直接抛（lib/index.js:675）⇒ usageDaily 永不注册，而界面只显示"正常的空态"',
    anchor: "export const inject = ['sessionProjections']",
    to: "export const inject = [] /* counterfactual: inject 声明被删掉 */",
    drivers: ['self-test', 'struct-check'],
    expect: ['T20i'],
    structExpect: ['G17']
  },
  {
    label: 'V19 拆掉 parse 路径的日桶封顶',
    file: 'index.mjs',
    why: '`stateSchema.cleanDays` 不 capDays ⇒ 磁盘上的无界日桶被 parse/viewSchema 原样放行（状态无界增长、列表行越传越胖）',
    anchor: '  return capDays(days)\n}',
    to: '  return days /* counterfactual: parse 路径日桶不封顶 */\n}',
    drivers: ['self-test', 'struct-check'],
    expect: ['T20j'],
    structExpect: ['G15']
  },
  {
    label: 'V20 拆掉客户端 cleanUsageDaily 的日键闸',
    why: '`cleanUsageDaily` 不挡非法日键 ⇒ 垃圾键（含尾随空格）进 agg.days；本插件对宿主 JSON 是"不吃信任"的',
    anchor: '          if (!isDayKey(key)) continue;\n          var ms = numOf(raw[key]);',
    to: '          var ms = numOf(raw[key]); /* counterfactual: 客户端日键闸被拆掉 */',
    drivers: ['self-test', 'struct-check'],
    expect: ['T21g'],
    structExpect: ['G16']
  },
  {
    label: 'V21 拆掉宿主 usageDailyViewOf 的日键闸',
    file: 'index.mjs',
    why: '`usageDailyViewOf` 不挡脏键 ⇒ 形状/范围非法的日键直接随**会话列表行**下发（每个会话一行，代价最大）',
    anchor: [
      '  const raw = state !== null && typeof state === \'object\' && state.days !== null && typeof state.days === \'object\'',
      '    ? state.days',
      '    : {}',
      '  const keys = Object.keys(raw)',
      '  for (let i = 0; i < keys.length; i++) {',
      '    const key = keys[i]',
      '    if (!isDayKey(key)) continue'
    ].join('\n'),
    to: [
      '  const raw = state !== null && typeof state === \'object\' && state.days !== null && typeof state.days === \'object\'',
      '    ? state.days',
      '    : {}',
      '  const keys = Object.keys(raw)',
      '  for (let i = 0; i < keys.length; i++) {',
      '    const key = keys[i]',
      '    /* counterfactual: viewOf 日键闸被拆掉 */'
    ].join('\n'),
    drivers: ['self-test', 'struct-check'],
    expect: ['T20j'],
    structExpect: ['G15']
  },
  {
    label: 'V22 拆掉窗口求和的日键纵深防御（尾随空格虚增）',
    why: '`buildCalendarModel` 用**字符串区间**筛本周/本月，`\'2026-09-22 \'`（尾随空格）字典序落进区间 ⇒ 本周/本月虚增',
    anchor: '        if (!isDayKey(key)) continue;\n        if (weekStart !== null && key >= weekStart && key <= today) weekMs += nonNegOf(days[key]);',
    to: '        if (weekStart !== null && key >= weekStart && key <= today) weekMs += nonNegOf(days[key]); /* counterfactual: 窗口日键闸被拆掉 */',
    drivers: ['self-test', 'struct-check'],
    expect: ['T21g'],
    structExpect: ['G16']
  },
  // ── 2026-10-13 独立审查挖出的
  //    「静默失效」盲区：拆掉它们，三套检查**全绿**。这三条变体就是补守护。
  {
    label: 'V30 删掉 apply() 里的回填装配',
    file: 'index.mjs',
    why: '🩸 装配零守护 ⇒ 删掉后回填永不发生、**零日志**、覆盖率永远停在 85%（T22a~T22d 全是直接调 watchUsageBackfill，绕过 apply）；修法 = 新增 T22e 走 apply 真实入口',
    anchor: '    disposeBackfill = watchUsageBackfill(ctx)',
    to: '    disposeBackfill = undefined /* counterfactual: 回填装配被删掉 */',
    expect: ['T22e 回填装配']
  },
  {
    label: 'V31 servesRows 只看「values 非空」、不查键名',
    file: 'index.mjs',
    why: '🩸 真实 projcache 里"缺 usageDaily 的那批会话**全部**已有别的键"（title/tokenUsage/contextActivity）⇒ 这么写会让它们永久漏补，且 folded=0 连"完成 N 个"都不发、日志一片空白',
    anchor: '  return values !== null && values[PROJECTION_KEY] !== undefined',
    to: '  return values !== null /* counterfactual: 只看 values 非空、不查键名 */',
    expect: ['T22b 回填正常路径']
  },
  {
    label: 'V32 早退不再留 debug',
    file: 'index.mjs',
    why: '宿主服务缺失/形状不对时静默早退 ⇒ "还没装配好"与"宿主不兼容"在日志上无法区分，回填永久不发生却看不出',
    anchor: "        ctx.logger?.debug?.(`dsh-usage-tab: 冷会话回填未装配（宿主服务的 ${missing.join(' / ')} 不可用；刚启动完的话可忽略）`)",
    to: '        /* counterfactual: 早退不再留痕 */',
    expect: ['T22a 回填']
  },
  // ── 增量复核（2026-10-13）指出的零守护：修法有效，但拆坏没人报警 ──
  {
    label: 'V33 删掉 started 守卫（重复触发会跑两趟）',
    file: 'index.mjs',
    why: '🩸 增量复核实证：删掉 `if (started) return` 后三套检查全绿，而假 ctx 触发两次回调时会真的并发跑两趟冷读（listCalls=1 → 2）',
    anchor: '        if (started) return\n        started = true',
    to: '        /* counterfactual: 不再收手 —— 重复触发会跑两趟 */',
    expect: ['T22f 回填只跑一趟']
  },
  {
    label: 'V34 把 started 挪进 inject 回调内（另一种拆法：每次触发各一份）',
    file: 'index.mjs',
    why: '🩸 `started` 必须放**回调外**才有意义 —— 放回调里等于每个闭包各一份，第二次触发照样跑（这是"看着有守卫、其实没守"的隐蔽形态）',
    anchor: '      const sessions = asRecord(raw.sessions)\n      const abort = new AbortController()',
    to: '      const sessions = asRecord(raw.sessions)\n      let started = false /* counterfactual: 守卫被挪进回调（每次触发各一份 ⇒ 防不住） */\n      const abort = new AbortController()',
    expect: ['T22f 回填只跑一趟']
  },
  // ── 2026-10-13 P2 第三步「会话」页（T23a~T23f）的**专属反事实** ─────────────────
  // 上一会话只给回填补了 V33/V34；会话页本体「只有正断言、没有反事实」——
  // 拆掉下列任一点，三套检查都不会报警（拆了还不红 = 盲区）。这 8 条就是补守护。
  {
    label: 'V35 拆掉会话页的窗口下界（窗口外的历史时长也算进来）',
    why: '口径：**时长按所选窗口**逐日相加 ⇒ 拆掉下界后「近 7 天」会把 08-31 的历史算进来（虚高，且与卡面写的口径不符）',
    anchor: '          if (windowStart !== null && key < windowStart) continue;\n          if (today !== null && key > today) continue;',
    to: '          if (today !== null && key > today) continue; /* counterfactual: 窗口下界被拆掉 */',
    expect: ['T23b 会话页 A 视图']
  },
  {
    label: 'V36 拆掉会话页的工作区筛',
    why: '工作区筛选是 A/B/C 三视图共用的可见集合闸门 ⇒ 拆掉后"选了某个项目"仍显示全部会话（C 的选中也会跟着跑偏）',
    anchor: '        if (workspace !== "" && prepared[q].cwd !== workspace) continue;',
    to: '        /* counterfactual: 工作区筛选被拆掉 */;',
    expect: ['T23b 会话页 A 视图', 'T23f 会话页偏好']
  },
  {
    label: 'V37 拆掉 A 视图的工作区分组渲染',
    why: 'A 视图的主轴就是"按工作区分组"（三个视图主轴不同，不是配色变体）⇒ 不画分组 = A 退化成空壳',
    anchor: '      var bodyNode = sessionsGroupNode(ses, t);',
    to: '      var bodyNode = h("div", null); /* counterfactual: A 视图不画分组 */',
    expect: ['T23e 会话页渲染冒烟']
  },
  {
    label: 'V38 拆掉 B 视图的档位细分（有活动一律 1 档）',
    why: '活动带的深浅 = 相对**全局最大单日**归一的 4 档 ⇒ 拆掉档位后整条带子一个颜色，"哪几天动得多"直接读不出来',
    anchor: [
      '      var ratio = ms / maxMs;',
      '      if (ratio >= 0.75) return 4;',
      '      if (ratio >= 0.5) return 3;',
      '      if (ratio >= 0.25) return 2;',
      '      return 1;'
    ].join('\n'),
    to: '      return 1; /* counterfactual: 档位细分被拆掉（有活动就 1 档） */',
    expect: ['T23c 会话页 B 视图']
  },
  {
    label: 'V39 拆掉 C 视图的默认选中回落',
    why: 'C 视图进页必须已经锁定一个会话（否则右栏空白）⇒ 拆掉回落后"没点过"就是空右栏，且 listRows 的选中态一个都不亮',
    anchor: '      if (selectedRow === null && shown.length > 0) selectedRow = shown[0];',
    to: '      /* counterfactual: 不回落 ⇒ 不指定就没有选中（右栏空白） */',
    expect: ['T23d 会话页 C 视图', 'T23e 会话页渲染冒烟']
  },
  {
    label: 'V40 拆掉 uncovered 计数（缺投影的会话不再记账）',
    why: '🩸 口径：没有 `usageDaily` 的会话**不进清单但必须计数**（界面脚注写"另有 N 个"）⇒ 不计数 = 覆盖率的缺口在界面上彻底消失（信息丢失）',
    anchor: '        if (ledger === null) { result.uncovered += 1; continue }',
    to: '        if (ledger === null) { continue } /* counterfactual: 缺投影的会话不再计数 */',
    expect: ['T23a 会话页数据层', 'T23e 会话页渲染冒烟']
  },
  {
    label: 'V41 拆掉会话页的空态闸门（`hasData !== true` 也照画真数据）',
    why: '🩸 拿不到任何一行 ⇒ 必须保持 P1.1 空态骨架（值一律 `—`）⇒ 拆掉闸门后无数据时画的是"空白的真数据卡"，连 `—` 都没了（既不诚实、也让人误以为"这个项目真没用量"）',
    anchor: '      if (ses === null || ses.hasData !== true) {',
    to: '      if (ses === null) { /* counterfactual: 空态闸门被拆掉（无数据也照画真数据） */',
    expect: ['T19c 日历', 'T23e 会话页渲染冒烟']
  },
  {
    label: 'V42 拆掉会话页的三视图派发（b/c 永远画 A）',
    why: '一页三视图靠 `ses.view` 派发 ⇒ 拆掉后切到 B/C 看到的还是 A（选项卡成了摆设，而工具条的选中态仍然会变 ⇒ 界面自相矛盾）',
    anchor: '      if (ses.view === "b") bodyNode = sessionsBandNode(ses, t);\n      else if (ses.view === "c") bodyNode = sessionsMasterNode(ses, t, onPick);',
    to: '      /* counterfactual: 三视图派发被拆掉（永远画 A） */',
    expect: ['T23e 会话页渲染冒烟']
  },
  // ── 2026-10-13 独立审查 ──
  //    「拆了还不红的盲区」：那 11 处的根因**不是变体不够，而是正断言不存在** ⇒
  //    本批先补 T23g~T23l 的断言（+ T23a 的形状兜底），再用这些变体证明"断言真能被打红"。
  {
    label: 'V43 capped 恒 0（截断数永远不报）',
    why: '🩸 卡头「45 个会话」+ 列表 40 行 + 脚注「另有 5 个未列出」三个数字必须互相印证；capped 恒 0 时脚注整条消失（信息丢失）',
    anchor: '      var capped = visible.length - shown.length;',
    to: '      var capped = 0; /* counterfactual: 截断数永远不报 */',
    expect: ['T23g 会话页截断']
  },
  {
    label: 'V44 B / C 视图不再截断（shown = visible，各画 45 行）',
    why: '🩸 `SESSION_LIST_LIMIT` 对 **B / C** 必须截断（A 视图是"列全部 + 容器滚动"，见 V60）—— B 不截断时 45 行全画、脚注却说"另有 5 个未列出"',
    anchor: '      var shown = visible.length > SESSION_LIST_LIMIT ? visible.slice(0, SESSION_LIST_LIMIT) : visible;',
    to: '      var shown = visible; /* counterfactual: 不截断 */',
    expect: ['T23g 会话页截断']
  },
  {
    label: 'V45 条长基准退回「筛选后可见集合」（旧行为）',
    why: '🩸 基准必须取**全部会话** ⇒ 否则同一个会话在筛不筛工作区时条长从 11% 跳到 100%（视觉基准跳变）',
    anchor: [
      '      var baseMaxMs = 0;',
      '      for (var pm = 0; pm < prepared.length; pm += 1) {',
      '        if (prepared[pm].activeMs > baseMaxMs) baseMaxMs = prepared[pm].activeMs;',
      '      }'
    ].join('\n'),
    to: [
      '      var baseMaxMs = 0;',
      '      for (var pm = 0; pm < visible.length; pm += 1) {',
      '        if (visible[pm].activeMs > baseMaxMs) baseMaxMs = visible[pm].activeMs;',
      '      }',
      '      /* counterfactual: 基准退回可见集合 */'
    ].join('\n'),
    expect: ['T23i 会话页条长']
  },
  {
    label: 'V46 pickHint 恒空（「筛选没中」不再说明原因）',
    why: '🩸 工作区筛不中时必须说「换个工作区」（切时间窗没用）⇒ 不给就等于把用户丢在没有任何出口提示的空白里',
    anchor: '        pickHint: emptyKind === "workspaceMiss" ? tr("ses.emptyPick") : "",',
    to: '        pickHint: "", /* counterfactual: 筛选没中不再说明原因 */',
    expect: ['T23h 会话页三种']
  },
  {
    label: 'V47 windowHint 恒空（「窗口内无活跃」不再给指引）',
    why: '🩸 这个场景里切「全部」是**有效**指引（与 workspaceMiss 相反）⇒ 删掉等于把用户丢在没有出口的空态里',
    anchor: '        windowHint: emptyKind === "windowEmpty" ? tr("ses.windowEmpty") : "",',
    to: '        windowHint: "", /* counterfactual: 窗口内无活跃不再给指引 */',
    expect: ['T23h 会话页三种']
  },
  {
    label: 'V48 C 视图逐日柱「每根自己 100%」（基准被拆）',
    why: '🩸 柱高必须相对**该会话窗口内最大日** ⇒ 每根自己归一后 14 根柱子一样高，"哪天忙"直接读不出来',
    anchor: '          heightPct: maxDay > 0 ? clampPct((value / maxDay) * 100) : 0,',
    to: '          heightPct: value > 0 ? 100 : 0, /* counterfactual: 每根柱自己归一 */',
    expect: ['T23i 会话页条长']
  },
  {
    label: 'V49 删掉会话页的口径脚注（ses.caliber）',
    why: '🩸 口径脚注是「时长随窗口变、段数 / 轮数不随窗口变」的唯一书面说明 ⇒ 删掉后用户会把两类数字当成同一口径相加',
    anchor: '        h("div", { className: "ut-source", key: "caliber", "data-usage-role": "ses-caliber" }, ses.caliber)',
    to: '        /* counterfactual: 口径脚注被删掉 */',
    expect: ['T23k 会话页口径脚注']
  },
  {
    label: 'V50 窗口求和不再挡「未来日」（今天之后的日键也算进来）',
    why: '🩸 未来日键只可能来自脏数据 / 时区错乱 ⇒ 不挡会把"明天"的量算进今天（数字凭空变大）',
    anchor: '          if (today !== null && key > today) continue;',
    to: '          /* counterfactual: 未来日不再跳过 */',
    expect: ['T23k 会话页口径脚注']
  },
  {
    label: 'V51 会话清单不再按时长排序（保留宿主下发顺序）',
    why: '🩸 排序是清单的全部价值（"时间花在哪个项目上"）⇒ 不排 = 顺序随宿主下发顺序乱跳，"最长会话在第一条"不再成立',
    anchor: [
      '      visible.sort(function (left, right) {',
      '        if (right.activeMs !== left.activeMs) return right.activeMs - left.activeMs;',
      '        return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);',
      '      });'
    ].join('\n'),
    to: '      /* counterfactual: 清单不再排序（夹具插入顺序与时长顺序不同 ⇒ 必须变红） */',
    expect: ['T23j 会话页排序']
  },
  {
    label: 'V52 A 视图分组不再按总量降序（按首次出现顺序）',
    why: '🩸 "时间花在哪个项目上"要求组按总量降序；T23j 的夹具刻意让"先出现的组总量更小" ⇒ 不排序就会被抓出来',
    anchor: '      groupKeys.sort(function (left, right) { return groupOf[right].sessionTotal - groupOf[left].sessionTotal });',
    to: '      /* counterfactual: 组不再按总量排序（T23j 的反序夹具会抓） */',
    expect: ['T23j 会话页排序']
  },
  {
    label: 'V53 A 行尾「全日志总量」换成窗口内量（口径混称）',
    why: '🩸 行尾必须是全日志总量（与窗口内时长是两套口径）⇒ 混称后同一行两个数字同源，用户看不出"这段历史有多长"',
    anchor: [
      '        totalText: formatDuration(row.totalMs),',
      '        metaText: metaTextOf(row, tr),'
    ].join('\n'),
    to: [
      '        totalText: formatDuration(row.activeMs), /* counterfactual: 全日志总量被换成窗口内量 */',
      '        metaText: metaTextOf(row, tr),'
    ].join('\n'),
    expect: ['T23l 会话页 A 行尾']
  },
  {
    label: 'V54 拆掉日桶的毫秒上界（MAX_SAFE_INTEGER 原样上屏）',
    why: '🩸 宿主 JSON 是脏数据的来源 ⇒ 不设上界会把 `2501999792h59m` 这种荒谬数字印在卡面上',
    anchor: '          days[key] = ms > MAX_SPAN_MS ? MAX_SPAN_MS : ms;',
    to: '          days[key] = ms; /* counterfactual: 日桶上界被拆掉 */',
    expect: ['T23l 会话页 A 行尾']
  },
  {
    label: 'V55 拆掉计数类上界（轮数 / 段数不设界）',
    why: '🩸 上一条的另一半：turns / segments 同样来自宿主 JSON，不设界会印出天文数字',
    anchor: '      return n > MAX_COUNT_VALUE ? MAX_COUNT_VALUE : n;',
    to: '      return n; /* counterfactual: 计数上界被拆掉 */',
    expect: ['T23l 会话页 A 行尾']
  },
  {
    label: 'V56 拆掉 `usageRowsOf`（日历页侧）的 id 来源兜底',
    why: '🩸 宿主只下发 `projectionsBySession` 时日历页一条都列不出 ⇒ `aggregateUsageDaily.hasData=false`、整页落空态；实测**这一侧此前完全无守护**（拆掉后三套检查全绿）',
    anchor: '      // id 来源取并集（空载体 `[] / {}` 也兜住，见 `idListOf` 的注释）\n      var ids = idListOf(snapshot, byId, perSession);',
    to: [
      '      var ids = [];',
      '      if (Array.isArray(snapshot.ids)) ids = snapshot.ids;',
      '      else if (byId !== null) ids = Object.keys(byId); /* counterfactual: 日历页侧兜底被拆掉 */'
    ].join('\n'),
    expect: ['T23m 形状兜底']
  },
  // ── 2026-10-14 独立审查 ──
  //    独立发现的 10 处"拆了还不红" + 若干回归守护。
  {
    label: 'V57 拆掉 `longestMs` 的上界（C 视图"最长段"会印荒谬值）',
    why: '🩸 `longestMs` 与 `segments` 同样来自宿主 JSON，实测拆掉后 `2501999792h59m` 重新上屏而三套检查全绿',
    anchor: '        longestMs: spanMsOf(value.longestMs)',
    to: '        longestMs: nonNegOf(value.longestMs) /* counterfactual: longestMs 不夹上界 */',
    expect: ['T23l 会话页 A 行尾']
  },
  {
    label: 'V58 拆掉 `segments` 的上界（上一条的另一半）',
    why: '🩸 A/B 行 meta"段数"会印 `9007199254740991`',
    anchor: '        segments: countOf(value.segments),',
    to: '        segments: nonNegOf(value.segments), /* counterfactual: segments 不夹上界 */',
    expect: ['T23l 会话页 A 行尾']
  },
  {
    label: 'V59 B 视图档位基准退回「可见集合」（T23i 曾假绿的那一条）',
    why: '🩸 实测：把基准退回可见集合时**三套检查仍 85/0 全绿**，而同一格档位真跳 1→4。现在的 T23i 用"组里没有全局最大会话"的 wiki 场景，必须能抓住',
    anchor: [
      '      var bandMax = 0;',
      '      for (var b = 0; b < prepared.length; b += 1) {',
      '        for (var bd = 0; bd < bandDays.length; bd += 1) {',
      '          var dayMs = bandDays[bd] !== null ? nonNegOf(prepared[b].days[bandDays[bd]]) : 0;',
      '          if (dayMs > bandMax) bandMax = dayMs;',
      '        }',
      '      }'
    ].join('\n'),
    to: [
      '      var bandMax = 0;',
      '      for (var b = 0; b < visible.length; b += 1) {',
      '        for (var bd = 0; bd < bandDays.length; bd += 1) {',
      '          var dayMs = bandDays[bd] !== null ? nonNegOf(visible[b].days[bandDays[bd]]) : 0;',
      '          if (dayMs > bandMax) bandMax = dayMs;',
      '        }',
      '      }',
      '      /* counterfactual: 档位基准退回可见集合 */'
    ].join('\n'),
    expect: ['T23i 会话页条长']
  },
  {
    label: 'V60 A 视图分组退回 `shown`（回归：排 40 名外的整组消失）',
    why: '🩸 A 视图按全局 40 条截断 ⇒ ① 卡头合计与组头合计打架；② 排在 40 名之后的工作区**整组消失**（下拉里却还列着它）',
    anchor: [
      '      for (var g = 0; g < visible.length; g += 1) {',
      '        var gk = visible[g].cwd;'
    ].join('\n'),
    to: [
      '      for (var g = 0; g < shown.length; g += 1) {',
      '        var gk = shown[g].cwd; /* counterfactual: A 视图退回按 40 截断 */'
    ].join('\n'),
    expect: ['T23g 会话页截断']
  },
  {
    label: 'V61 拆掉第四种空 `zeroActive`（全零活跃又给"切全部"的错误指引）',
    why: '🩸 全零活跃时切「全部」也没用；`windowDays=0` 时更是完全静默（`hintNodes=0`）',
    anchor: [
      '      } else if (totalMs === 0) {',
      '        // 有会话行、但所选时间窗内一点活跃都没有：还在范围内 ⇒ 切「全部」有效；连全日志都是 0 ⇒ 说清没用',
      '        if (windowDays > 0 && visibleTotalMs > 0) emptyKind = "windowEmpty";',
      '        else emptyKind = "zeroActive";',
      '      }'
    ].join('\n'),
    to: [
      '      } else if (totalMs === 0) {',
      '        emptyKind = "windowEmpty"; /* counterfactual: 拆掉 zeroActive */',
      '      }'
    ].join('\n'),
    expect: ['T23h 会话页三种']
  },
  {
    label: 'V62 `idListOf` 在会话页侧退回 `else-if` 链（空载体列不出）',
    why: '🩸 `ids: []` / `byId: {}` 这类空载体 + 数据在 `projectionsBySession` 时两条通路都列不出；日历页侧此前**完全无守护**',
    anchor: '      // id 来源取并集（不是 else-if 链）：空载体 + 数据在 `projectionsBySession` 时也列得出\n      var ids = idListOf(snapshot, byId, perSession);',
    to: [
      '      var ids = [];',
      '      if (Array.isArray(snapshot.ids)) ids = snapshot.ids;',
      '      else if (byId !== null) ids = Object.keys(byId);',
      '      else if (perSession !== null) ids = Object.keys(perSession); /* counterfactual: 退回 else-if 链 */'
    ].join('\n'),
    expect: ['T23m 形状兜底']
  },
  {
    label: 'V63 C 视图选中态不再挤回列表（回归：只在右栏出现）',
    why: '🩸 用户上次选中的会话若被截到 40 名外，左栏 40 项里一项都不是它（"静默换会话"）',
    anchor: '        shown = shown.slice(0, SESSION_LIST_LIMIT - 1).concat([selectedRow]);',
    to: '        /* counterfactual: 选中态不再挤回列表 */;',
    expect: ['T23n C 视图选中态']
  },
  {
    label: 'V64 B 视图口径提示被空态提示顶掉（回归）',
    why: '🩸 "只有逐日粒度"与"筛选没中"是两件事，不该互相顶掉（第二条提示会消失）',
    anchor: '      if (ses.view === "b") hints.push(t("ses.band.note"));',
    to: '      if (ses.view === "b" && hints.length === 0) hints.push(t("ses.band.note")); /* counterfactual: 提示互相顶掉 */',
    expect: ['T23h 会话页三种']
  },
  {
    label: 'V65 A 视图也挂截断脚注（文案面：列全部却说"只列出前 40 个"）',
    why: '🩸 A 视图不参与截断 ⇒ 它不该出现"只列出前 40 个"的脚注；挂上去就是旧问题的翻版',
    anchor: '      if (ses.capped > 0 && ses.view !== "a") {',
    to: '      if (ses.capped > 0) { /* counterfactual: A 视图也挂截断脚注 */',
    expect: ['T23g 会话页截断']
  },
  // ── 2026-10-14 复审 + 新需求「显示范围」──
  {
    label: 'V66 拆掉「显示范围」过滤（太久没动的会话又开始占位）',
    why: '⭐ 2026-10-14 定稿：「太久没动的对话就不用显示了吧 比如大于14天没对话的」⇒ 按最后活动日过滤是**新功能**，必须有守护',
    anchor: [
      '        if (rangeStart !== null && (row.lastDay === null || row.lastDay < rangeStart)) {',
      '          outsideRange += 1;',
      '          continue;',
      '        }'
    ].join('\n'),
    to: '        /* counterfactual: 显示范围过滤被拆掉 */',
    expect: ['T23o 「显示范围」偏好']
  },
  {
    label: 'V67 默认显示范围退回「不限」（DEFAULT_SESSION_RANGE = 0）',
    why: '⭐ 默认必须是 14 天，否则"太久没动的不显示"这条默认行为消失',
    anchor: '    var DEFAULT_SESSION_RANGE = 14;',
    to: '    var DEFAULT_SESSION_RANGE = 0; /* counterfactual: 默认不限 */',
    expect: ['T23o 「显示范围」偏好']
  },
  {
    label: 'V68 A 视图组头合计算两遍（实测仍全绿）',
    why: '🩸 `groups[].totalText` 此前**零直接断言** —— 整组 ×2 也抓不出来，而上面的验收点恰是"卡头合计 = 组头合计之和"',
    anchor: '        groupOf[gk].sessionTotal += visible[g].activeMs;',
    to: '        groupOf[gk].sessionTotal += visible[g].activeMs * 2; /* counterfactual: 组头合计算两遍 */',
    expect: ['T23g 会话页截断']
  },
  {
    label: 'V69 删掉 A 视图的唯一高度闸门（`max-height`）',
    why: '🩸 A 视图不参与截断后，`.ut-ses-groups` 的 `max-height` 是**最后一道**防撑爆的绳（2000 会话 = 12,023 vnode）—— 删掉此前三套检查全绿',
    anchor: '      ".ut-ses-groups{display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:520px}",',
    to: '      ".ut-ses-groups{display:flex;flex-direction:column;gap:10px;overflow:auto}",',
    drivers: ['struct-check'],
    structExpect: ['G18']
  },
  {
    label: 'V70 C 视图挤回后不再说明"选中的已置顶"（复审）',
    why: '🩸 复审：挤回之后"只列出前 40 个"字面不成立 ⇒ 脚注必须追加"你选中的会话已置顶"',
    anchor: '        if (ses.selectedPinned === true) capText += " " + t("ses.cappedPinned");',
    to: '        /* counterfactual: 选中置顶不再说明（复审） */',
    expect: ['T23n C 视图选中态']
  },
  // ── 2026-10-14 复审（9 处"拆了还不红" + 组头显示值的马甲）──
  {
    label: 'V71 生效的工作区筛选也不再渲染控件（用户被卡死）',
    why: '🩸 复审的中级发现：显示范围一收窄、候选掉到 2 项以下，控件不渲染而筛选**仍然生效** —— 界面提示"换个工作区试试"，屏上却没有可换的控件',
    anchor: '      if (ses.wsOptions.length > 2 || ses.workspace !== "") {',
    to: '      if (ses.wsOptions.length > 2) { /* counterfactual: 生效的筛选也不渲染控件 ⇒ 用户被卡死 */',
    expect: ['T23p 显示范围的边角']
  },
  {
    label: 'V72 组头**显示值** ×2（只改 totalText、ms 不动）',
    why: '🩸 实测：本批原先只断言了 `groups[].ms`，把用户看的 `totalText` 改掉照样全绿 —— 同一处风险换了件马甲',
    anchor: '          totalText: formatDuration(group.sessionTotal),',
    to: '          totalText: formatDuration(group.sessionTotal * 2), /* counterfactual: 组头显示值 ×2 */',
    expect: ['T23g 会话页截断']
  },
  {
    label: 'V73 显示范围的起点少算一天（`-rangeDays` 而不是 `-(rangeDays-1)`）',
    why: '🩸 复审：边界日行为对但零守护（14 天含今天 ⇒ 最早可见 = today-13）',
    anchor: '      var rangeStart = rangeDays > 0 && today !== null ? dayKeyAddDays(today, -(rangeDays - 1)) : null;',
    to: '      var rangeStart = rangeDays > 0 && today !== null ? dayKeyAddDays(today, -rangeDays) : null; /* counterfactual: 边界少一天 */',
    expect: ['T23p 显示范围的边角']
  },
  {
    label: 'V74 `lastDay === null` 不再被显示范围挡下',
    why: '🩸 没有"最后活动日"的会话（投影里没有 days）本该按范围外处理；漏了它会让空表行混进清单',
    anchor: '        if (rangeStart !== null && (row.lastDay === null || row.lastDay < rangeStart)) {',
    to: '        if (rangeStart !== null && row.lastDay !== null && row.lastDay < rangeStart) { /* counterfactual: null 不再挡 */',
    expect: ['T23p 显示范围的边角']
  },
  {
    label: 'V75 `sesRange` 的白名单校验失效',
    why: '🩸 复审：偏好层 `sesRange` 不做白名单 ⇒ 磁盘上的坏值会被原样放行（渲染层虽能兜，但口径已经脏了）',
    anchor: '        if (Number(SESSION_RANGES[rg].value) === sesRangeRaw) sesRange = Number(SESSION_RANGES[rg].value);',
    to: '        if (true) sesRange = Number(SESSION_RANGES[rg].value); /* counterfactual: 白名单失效 */',
    expect: ['T23p 显示范围的边角']
  },
  {
    label: 'V101b 时间范围控件的默认选中态恒 false（合并控件后的等价变体）',
    why: '🩸 合并控件后仍要保证「当前选中的那档是亮的」—— 否则用户看不出当前范围（旧的独立 range 控件已随 ses.range 一起作废）',
    anchor: '          active: Number(SESSION_WINDOWS[wo].value) === windowDays',
    to: '          active: false /* counterfactual: 默认选中态失效 */',
    expect: ['T23p 显示范围的边角']
  },
  {
    label: 'V101c `ses.win` 控件回写进错误的偏好字段（合并控件后的等价变体）',
    why: '🩸 点「时间范围」却写进别的字段 ⇒ 控件看上去能动、改的却是别的口径（由 struct-check G19 钉住）',
    anchor: '        else if (group === "ses.win") patch.sesWindow = Number(value);',
    to: '        else if (group === "ses.win") patch.sesRange = Number(value); /* counterfactual: 回写错字段 */',
    drivers: ['struct-check'],
    structExpect: ['G19']
  },
  {
    label: 'V102c 工具记账不累计（拆掉 tool/call 时的次数累加）',
    why: '🩸 按工具名统计的核心：`tool/call` 当场计 1 次（相关修复后），结果只补耗时',
    anchor: '    byTool[key] = { calls: countOf(prev.calls) + 1, ms: nonNegOf(prev.ms) }',
    to: '    /* counterfactual: 不累计次数 */',
    file: 'index.mjs',
    expect: ['T30 按工具名统计', 'T34 四条修复的守护']
  },
  {
    label: 'V102r `<other>` 合并不累加旧值（复现计数不守恒）',
    why: '🩸 每次 fold 都覆盖旧累计 ⇒ 实测 250 次调用只剩 200（丢 20%）',
    anchor: "    let other = out['<other>'] !== undefined ? out['<other>'] : 0",
    to: '    let other = 0 /* counterfactual: 丢掉旧累计 */',
    file: 'index.mjs',
    expect: ['T34 四条修复的守护']
  },
  {
    label: 'V102s 留痕键长不封顶（复现单键能到 MiB 级）',
    why: '🩸 形状留痕的键来自事件字段名全量拼接 ⇒ 不封顶会随会话列表行下发几十 MB',
    anchor: "    const key = keys[i]\n    if (typeof key !== 'string' || key.length === 0 || key.length > 200) continue\n    if (isUnsafeKey(key)) continue\n    const c = countOf(raw[key])\n    if (c > 0) out[key] = c\n  }\n  return out\n}\n\n/**\n * 🩸 实测发现",
    to: "    const key = keys[i]\n    if (isUnsafeKey(key)) continue\n    const c = countOf(raw[key])\n    if (c > 0) out[key] = c\n  }\n  return out\n}\n\n/**\n * 🩸 实测发现",
    file: 'index.mjs',
    expect: ['T34 四条修复的守护']
  },
  {
    label: 'V102u 同毫秒判据回到"纯时间相等"（复现真实事件被吞）',
    why: '🩸 真实事件与上一条同毫秒是常见情况 ⇒ 纯时间相等会把真实的 turn/end 当 fork closer 吞掉',
    anchor: '  return lastTime !== null && time !== null && time === lastTime && numOf(state.openStart) === null',
    to: '  return lastTime !== null && time !== null && time === lastTime /* counterfactual: 只看时间 */',
    file: 'index.mjs',
    expect: ['T34 四条修复的守护']
  },
  {
    label: 'V102m K 线第一天又给方向（复现"假涨"）',
    why: '🩸 窗口第一天没有可比对象 ⇒ 不许编一根涨出来（每屏一根 = 系统性撒谎）',
    anchor: '          dir: r === 0 ? "flat" : (close > open ? "up" : (close < open ? "down" : "flat")),',
    to: '          dir: close > open ? "up" : (close < open ? "down" : "flat"), /* counterfactual: 第一天也给方向 */',
    expect: ['T29 K 线']
  },
  {
    label: 'V102n 统计卡 hasData 不含 shapes（复现留痕静默消失）',
    why: '🩸 留痕是"定稿未知字段名"的唯一线索 ⇒ 它不该被 hasData 判成"没数据"而整卡不挂',
    anchor: '        hasData: tools.length > 0 || models.length > 0 || outcomes.length > 0 || a.compactions > 0 ||\n          shapeRows.length > 0,',
    to: '        hasData: tools.length > 0 || models.length > 0 || outcomes.length > 0 || a.compactions > 0,',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102o 工具排行门槛回到 metric<=0（复现 ms=0 的整行消失）',
    why: '🩸 ms=0 是"超上界配对"的诚实标记，不该连可信的"次数"一起吞掉',
    anchor: '          if (calls <= 0 && metric <= 0) continue;',
    to: '          if (metric <= 0) continue; /* counterfactual: 只看耗时 */',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102p 工具行不带上调用次数（复现假断言场景）',
    why: '🩸 原来的断言 `indexOf("次")` 只守文案字 ⇒ 这里把次数换成常量 0，数据断言必须打红',
    anchor: '          return (ms > 0 ? formatDuration(ms) : EM_DASH) + " \\u00b7 " + obj.calls + tr("hs.calls");',
    to: '          return (ms > 0 ? formatDuration(ms) : EM_DASH) + " \\u00b7 " + 0 + tr("hs.calls"); /* counterfactual: 次数恒 0 */',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102q 压缩次数恒显示破折号（复现上屏零断言）',
    why: '🩸 compactions 上屏原先没有断言 ⇒ 现在必须守住',
    anchor: '        compactionText: countOf(a.compactions) > 0 ? countOf(a.compactions) + tr("hs.times") : EM_DASH,',
    to: '        compactionText: EM_DASH, /* counterfactual: 压缩次数不显示 */',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102d 把工具事件从活跃口径里吃掉（复现今晚踩过的坑）',
    why: '🩸 `tool/result` 本身就是活跃事件 ⇒ 工具记账后**必须继续走原路径**；一 return 就少算时长',
    anchor: "  if (type === 'tool/call' || type === 'tool/result') {\n    if (time !== null) state = foldToolEvent(state, event, type, time)\n  }",
    to: "  if (type === 'tool/call' || type === 'tool/result') {\n    if (time !== null) state = foldToolEvent(state, event, type, time)\n    return state /* counterfactual: 吃掉活跃口径 */\n  }",
    file: 'index.mjs',
    expect: ['T20b 宿主折叠', 'T30 按工具名统计']
  },
  {
    label: 'V102i 不挂宿主统计卡（拆掉挂载点）',
    why: '🩸 宿主半只负责记账 ⇒ 界面不显示 = 功能等于不存在（这正是"按工具名统计"的最后一环）',
    anchor: '      var hostCard = hostStatsCard(model, t);\n      if (hostCard !== null) cards.push(hostCard);',
    to: '      /* counterfactual: 不挂宿主统计卡 */',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102j 不显示形状留痕（拆掉诊断块）',
    why: '🩸 留痕是"定稿未知字段名"的唯一途径 ⇒ 不显示就等于永远在猜（没有它连作者都看不到真相）',
    anchor: '      if (Array.isArray(hs.shapeRows) && hs.shapeRows.length > 0) {',
    to: '      if (false) {',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102e 拆掉「同毫秒锚点不记」的闸（破坏 fork closer 口径）',
    why: '🩸 P1 硬口径：清账锚点后同毫秒的合成 closer 必须返回同一引用 ⇒ 任何新统计分支都要先过这道闸',
    anchor: '  if (isAnchorSameMs(state, event)) return state\n  const reason = reasonOf(event.data)',
    to: '  const reason = reasonOf(event.data)',
    file: 'index.mjs',
    expect: ['T20e 宿主折叠', 'T31 宿主半其它统计']
  },
  {
    label: 'V102f 轮结束原因不累计（拆掉 turnOutcomes 的累加）',
    why: '🩸 失败/中断统计的核心：`turn/end` 要按 reason 累计',
    anchor: '  out[reason] = countOf(out[reason]) + 1',
    to: '  /* counterfactual: 不累计 turnOutcomes */',
    file: 'index.mjs',
    expect: ['T31 宿主半其它统计']
  },
  {
    label: 'V102g 客户端清洗层不带上 byTool（复现"漏中转层"那个坑）',
    why: '🩸 `cleanUsageDaily` 是"新增字段最容易漏的一处" ⇒ 漏了它，聚合拿不到数据、**统计卡整张不挂且不报错**',
    anchor: '        days: days,\n        hoursByDay: hoursByDay,\n        byTool: byTool,',
    to: '        days: days,\n        hoursByDay: hoursByDay,',
    expect: ['T32 宿主统计卡']
  },
  {
    label: 'V102h K 线又画起影线（复现"两套口径混画"）',
    why: '🩸 2026-10-14 定稿回到无影线版：小时桶只有重启后的日子有 ⇒ 混画 = 所谓的"数据冲突"',
    anchor: '        var span = KLINE_USE_WICKS ? klineSpanOf(hb[keys[r]]) : null;',
    to: '        var span = klineSpanOf(hb[keys[r]]); /* counterfactual: 又画影线 */',
    expect: ['T29 K 线']
  },
  {
    label: 'V102k 拆掉工具配对的耗时上界（实测 bug：job_output 累计成 24h36s）',
    why: '🩸 某次 `tool/result` 缺失时会与很久之后 call 配对上 ⇒ 累计出荒谬耗时；上界是唯一的兜底',
    anchor: '  const validSpent = spent > 0 && spent <= MAX_TOOL_SPAN_MS ? spent : 0',
    to: '  const validSpent = spent > 0 ? spent : 0 /* counterfactual: 不设上界 */',
    file: 'index.mjs',
    expect: ['T33 实测两处修']
  },
  {
    label: 'V102l 拆掉 reason 的"对象分支"（实测 reason 是对象）',
    why: '🩸 实测 `turn/end|reason:object,turn:number` ⇒ 只收字符串的实现会全部落空（本轮就是这么发现的）',
    anchor: "  if (reason !== null && typeof reason === 'object') {",
    to: '  if (false) {',
    file: 'index.mjs',
    expect: ['T33 实测两处修']
  },
  {
    label: 'V78 高度闸门改成 `max-height:0px`（绕过写法）',
    why: '🩸 复审：G18 原先只查"存在"⇒ `0px` 也能过（内容其实全被压没）',
    anchor: '      ".ut-ses-groups{display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:520px}",',
    to: '      ".ut-ses-groups{display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:0px}",',
    drivers: ['struct-check'],
    structExpect: ['G18']
  },
  {
    label: 'V79 拆掉「拿不到投影就不给占比」守卫（永远返回 workSplit 对象）',
    why: '实测：缺 llmMs/toolMs 时必须整块 null（界面不挂卡，绝不用 0 冒充）',
    anchor: '      if (llmMs !== null && toolMs !== null && llmMs >= 0 && toolMs >= 0 &&\n        (llmMs > 0 || toolMs > 0 || (ttftSteps !== null && ttftSteps > 0) || (decodeMs !== null && decodeMs > 0))) {',
    to: '      if (true) { /* counterfactual: 缺字段也给对象 */',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V80 拆掉生成速度的 `decodeMs > 0` 守卫（改成 >=）',
    why: '实测：decodeMs=0 时必须给 —，不许产出 NaN tok/s',
    anchor: '          tpsText: decodeMs !== null && decodeMs > 0 && decodeTokens !== null',
    to: '          tpsText: decodeMs !== null && decodeMs >= 0 && decodeTokens !== null',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V81 首 token 平均的除数写错（拿固定 60 除）',
    why: '实测：ttftMs / ttftSteps 必须用真实步数',
    anchor: '            ? formatDuration(ttftMs / ttftSteps)',
    to: '            ? formatDuration(ttftMs / 60)',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V82 上月跨年算错（1 月时取 "YYYY-00"）',
    why: 'A3：`prevMonthPrefixOf` 的 1 月分支必须回到去年 12 月',
    anchor: '      if (month === 1) return year <= 1970 ? null : String(year - 1) + "-12";',
    to: '      if (month === 1) return monthPrefix.slice(0, 4) + "-00"; /* counterfactual: 跨年算错 */',
    expect: ['T24 日历环比']
  },
  {
    label: 'V83 拆掉「上一期为 0 就不给涨跌」的守卫（改成 prev < 0）',
    why: 'A3：上周 0 分钟时必须 delta=null，绝不产出 ∞%',
    anchor: '      if (cur === null || prev === null || prev <= 0) return null;',
    to: '      if (cur === null || prev === null || prev < 0) return null; /* counterfactual: 允许 prev=0 */',
    expect: ['T24 日历环比']
  },
  {
    label: 'V84 拆掉「全 0 投影不挂卡」守卫',
    why: '独立审查：宿主 init() 默认形状是全 0 ⇒ 必须整块不挂卡，不许印"模型 0.0s · 0%"',
    anchor: '        (llmMs > 0 || toolMs > 0 || (ttftSteps !== null && ttftSteps > 0) || (decodeMs !== null && decodeMs > 0))) {',
    to: '        true) { /* counterfactual: 全 0 也挂卡 */',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V85 拆掉生成速度的「token 非负」守卫',
    why: '独立审查：负 decodeTokens 不许上屏成 -800.0 tok/s',
    anchor: '          tpsText: decodeMs !== null && decodeMs > 0 && decodeTokens !== null && decodeTokens >= 0',
    to: '          tpsText: decodeMs !== null && decodeMs > 0 && decodeTokens !== null',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V86 拆掉「单边负数不挂卡」守卫',
    why: '独立审查：llmMs 与 toolMs 必须都非负，否则分母变 0 却仍印数',
    anchor: '      if (llmMs !== null && toolMs !== null && llmMs >= 0 && toolMs >= 0 &&',
    to: '      if (llmMs !== null && toolMs !== null &&',
    expect: ['T12d 时间构成']
  },
  {
    label: 'V87 上月对比期改回「整月」（拆掉等长对位）',
    why: '🩸 A3 自己踩过的坑：本月只过 12 天却去比上月 31 天 ⇒ 环比天然偏低（看着像"用户在少用"）',
    anchor: '        if (prevMonthStart !== null && prevMonthEnd !== null && key >= prevMonthStart && key <= prevMonthEnd) {',
    to: '        if (prevMonthPrefix !== null && key.slice(0, 7) === prevMonthPrefix) { /* counterfactual: 整月 */',
    expect: ['T24 日历环比']
  },
  {
    label: 'V88 子代理卡不再看「有没有子代理」（无条件挂卡）',
    why: 'A5：没有子代理会话时整卡不该出现',
    anchor: '      )].concat(ses.subagentStats.subSessions > 0 ? [subagentCard(ses, t)] : []);',
    to: '      )].concat([subagentCard(ses, t)]);',
    expect: ['T25 会话页子代理构成']
  },
  {
    label: 'V89 子代理占比的分母写错（不再用清单长度）',
    why: 'A5：分母必须是清单里的会话数，否则与卡头对不上',
    anchor: '        sessions: visible.length,\n        subSessions: subSessions,',
    to: '        sessions: 0, /* counterfactual: 分母写错 */\n        subSessions: subSessions,',
    expect: ['T25 会话页子代理构成']
  },
  {
    label: 'V90 本期不截断（月末 31 天 vs 上月 28 天 ⇒ 假涨）',
    why: '🩸 复审：本期参与环比的部分必须与对比期等长，否则匀速习惯也会报大涨',
    anchor: '        if (curMonthEnd !== null && key >= monthStart && key <= curMonthEnd) curMonthSameMs += nonNegOf(days[key]);',
    to: '        if (key >= monthStart && key <= monthPrefix + "-31") curMonthSameMs += nonNegOf(days[key]); /* counterfactual: 本期不截断 */',
    expect: ['T24 日历环比']
  },
  {
    label: 'V91 环比标记不留可访问名（删 aria-label）',
    why: '🩸 复审：这条原先**零守护** —— 把 DOM 上的 aria-label 删掉，self-test 与 struct-check 全绿',
    anchor: '              "aria-label": delta.aria,',
    to: '              "aria-label": "", /* counterfactual: 去掉可访问名 */',
    expect: ['T24 日历环比']
  },
  {
    label: 'V93 忘了取 `.rows`（把 {rows,uncovered} 整个传给趋势函数）',
    why: 'A6：作者真踩过的坑 —— `Array.isArray({rows})` 为假 ⇒ 卡永远不挂',
    anchor: '      calendar.wsTrend = buildWorkspaceTrend(sessionRows.rows, calendarNow, tr);',
    to: '      calendar.wsTrend = buildWorkspaceTrend(sessionRows, calendarNow, tr); /* counterfactual: 忘了 .rows */',
    expect: ['T26 日历页工作区趋势']
  },
  {
    label: 'V98 完全不转义（拆掉 mdCellOf 的全部转义）',
    why: 'A2：转义一旦全拆，反斜杠 / 竖线 / 裸 CR 三条注入路径同时打开',
    anchor: '      if (typeof text === "object") return "";',
    to: '      if (typeof text === "object") return "";\n      return String(text); /* counterfactual: 完全不转义 */',
    expect: ['T27 导出 Markdown']
  },
  {
    label: 'V99 裸 CR 不压平（只处理 \\r\\n）',
    why: '🩸 实测：CommonMark 里裸 CR 也是行尾 ⇒ 表格行会腰斩、后几列清空',
    anchor: '        .replace(/\\r?\\n|\\r/g, " ")',
    to: '        .replace(/\\r?\\n/g, " ") /* counterfactual: 漏掉裸 CR */',
    expect: ['T27 导出 Markdown']
  },
  {
    label: 'V100 stampOf 对超范围时间戳不回退（文件名出 NaN）',
    why: '🩸 实测：非有限 / 超范围一律退回"现在"',
    anchor: '      if (!isFinite(d.getTime()) || !isFinite(year) || year < 1970 || year > 9999) d = new Date();',
    to: '      /* counterfactual: 不回退 */',
    expect: ['T27 导出 Markdown']
  },
  {
    label: 'V95 设置页不挂导出按钮',
    why: 'A2：导出入口必须在界面上（否则功能等于不存在）',
    anchor: '      return [prefsCard, metricCard, exportCard];',
    to: '      return [prefsCard, metricCard]; /* counterfactual: 不挂导出入口 */',
    expect: ['T27 导出 Markdown']
  },
  {
    label: 'V101 工作区趋势把「未来日键」也算进桶（夹具已换成同周内的明天）',
    why: '🩸 实测：原先用 2099 的夹具是假守护（被越界检查兜住），换同周内的明天才测得出来',
    anchor: '          if (!isDayKey(key) || key > today) continue;',
    to: '          if (!isDayKey(key)) continue; /* counterfactual: 未来日键也算 */',
    expect: ['T26 日历页工作区趋势']
  },
  {
    label: 'V102 窗口内全零也挂趋势卡（拆掉守卫）',
    why: '🩸 实测：全零时挂一张全空的卡 = 用空壳冒充数据',
    anchor: '        hasData: out.length > 0 && anyNonZero,',
    to: '        hasData: out.length > 0, /* counterfactual: 全零也挂卡 */',
    expect: ['T26 日历页工作区趋势']
  },
  {
    label: 'V103 工作区趋势不截断（拆掉 WS_TREND_LIMIT）',
    why: '🩸 实测：截断原先零守护',
    anchor: '      var shown = all.slice(0, WS_TREND_LIMIT);',
    to: '      var shown = all; /* counterfactual: 不截断 */',
    expect: ['T26 日历页工作区趋势']
  },
  {
    label: 'V104 K 线涨跌算错（恒判为涨）',
    why: 'A7：方向必须由「开盘（前一天）vs 收盘（当天）」决定（不是恒涨）；⚠️ 与 V102m 测的侧面不同 —— 那个是"第一天给方向"，这个是"完全不看开收、恒判涨"',
    anchor: '          dir: r === 0 ? "flat" : (close > open ? "up" : (close < open ? "down" : "flat")),',
    to: '          dir: "up", /* counterfactual: 恒判为涨 */',
    expect: ['T29 K 线']
  },
  {
    label: 'V105 K 线全零也挂图（拆掉 hasData 的非零要求）',
    why: 'A7：窗口内全零 ⇒ 不该挂一张全空的 K 线',
    anchor: '      return { hasData: maxMs > 0, rows: rows, axisMaxMs: axisMax, ticks: ticks, note: tr("kline.note") };',
    to: '      return { hasData: rows.length > 0, rows: rows, axisMaxMs: axisMax, ticks: ticks, note: tr("kline.note") }; /* counterfactual: 全零也挂 */',
    expect: ['T29 K 线']
  },
  {
    label: 'V96 目标 = 0 时也挂进度条（拆掉"关着就不给"守卫）',
    why: 'A4：目标关着时不该出现恒 0 的空进度条',
    anchor: '      if (goalMinutes !== null && goalMinutes > 0 &&',
    to: '      if (goalMinutes !== null && goalMinutes >= 0 && /* counterfactual: 关着也挂 */',
    expect: ['T28 每周目标']
  },
  {
    label: 'V97 每周目标不做白名单校验（任意数字都放行）',
    why: 'A4：非法值必须静默回退默认（与 idle / range 同一条口径）',
    anchor: '      for (var gl = 0; gl < PREF_WEEKLY_GOALS.length; gl += 1) {\n        if (PREF_WEEKLY_GOALS[gl].value === goalRaw) weeklyGoalMinutes = PREF_WEEKLY_GOALS[gl].value;\n      }',
    to: '      weeklyGoalMinutes = goalRaw === null ? DEFAULT_PREFS.weeklyGoalMinutes : goalRaw; /* counterfactual: 不校验白名单 */',
    expect: ['T28 每周目标']
  }
  // ⚠️ 这里**故意没有**"未来日键"的变体（2026-10-14 实测两个写法都打不红）：
  //    `if (!isDayKey(key) || key > today) continue;` 与 `if (idx < 0 || idx >= starts.length) continue;`
  //    是**互相兜底的双保险** —— 单拆任一层，另一层都会把未来日键挡掉，而本工具的变体一次只能拆一处。
  //    ⇒ T26 里那条"未来日键不许算"守的是**最终行为**（不是某一行代码），这是可接受的口径；
  //      真要弄坏这个行为得**同时**改两处 —— 属于"两处一起坏"的场景，单点变异测不出来。
]

// ── 执行 ─────────────────────────────────────────────────────────────────
let ok = 0
let bad = 0

console.log('dsh-usage-tab 反事实对照（驱动真实 test/self-test.mjs + tools/struct-check-subnav.mjs，临时副本拆修复点）')
console.log('工作区 client.js sha256(before) = ' + shaBefore.slice(0, 16) + '…')
console.log('临时副本根 = ' + tmpRoot)
console.log('自测日志目录 = ' + LOG_DIR)
console.log('----')

// ── 基线：两个驱动器都必须先绿（否则副本机制/环境本身有问题）─────────────────
const baseline = runSelfTest('baseline')
console.log('[baseline] 真 self-test： passed=' + baseline.passed + '  failed=' + baseline.failedCount +
  '  allGreen=' + baseline.allGreen + '  → ' + baseline.file)
if (baseline.failedCount === 0 && baseline.allGreen) {
  ok += 1
} else {
  bad += 1
  console.log('BAD   基线就不绿（副本机制/环境有问题），后续对照无意义')
}
const baselineStruct = runStructCheck('baseline-struct')
console.log('[baseline] 真 struct-check： OK=' + baselineStruct.okCount + '  BAD=' + baselineStruct.badCount +
  '  allGreen=' + baselineStruct.allGreen + '  → ' + baselineStruct.file)
if (baselineStruct.badCount === 0 && baselineStruct.allGreen) {
  ok += 1
} else {
  bad += 1
  console.log('BAD   struct-check 基线就不绿（副本机制/环境有问题），后续对照无意义')
}

for (const variant of VARIANTS) {
  const file = variant.file === undefined ? 'client.js' : variant.file
  const source = SOURCES[file]
  const hits = source.split(variant.anchor).length - 1
  if (hits !== 1) {
    bad += 1
    console.log('BAD   ' + variant.label + '：锚点在 lib/' + file + ' 里出现 ' + hits + ' 次（应为 1）')
    continue
  }
  const drivers = variant.drivers === undefined ? ['self-test'] : variant.drivers
  const tag = variant.label.split(' ')[0].toLowerCase()
  writeFileSync(join(tmpRoot, 'lib', file), source.replace(variant.anchor, variant.to), 'utf8')
  const lines = []
  let variantBad = 0
  if (drivers.includes('self-test')) {
    const run = runSelfTest(tag + '-mutated')
    const missed = variant.expect.filter((needle) => !run.failed.some((name) => name.includes(needle)))
    const wentRed = run.failedCount > 0 && !run.allGreen
    if (wentRed && missed.length === 0) {
      ok += 1
      lines.push('      [self-test]   ⇒ 变红：failed=' + run.failedCount + '，命中目标用例 ' +
        JSON.stringify(variant.expect) + '；实际失败 ' + JSON.stringify(run.failed))
    } else {
      bad += 1
      variantBad += 1
      lines.push('      [self-test]   ⇒ 🩸 没变红：passed=' + run.passed + ' failed=' + run.failedCount +
        ' allGreen=' + run.allGreen + ' 超时=' + run.timedOut +
        '；期望命中（子串）' + JSON.stringify(variant.expect) + '，未命中 ' + JSON.stringify(missed) +
        '；实际失败 ' + JSON.stringify(run.failed) + ' → ' + run.file)
    }
  }
  if (drivers.includes('struct-check')) {
    const run = runStructCheck(tag + '-struct')
    const missed = variant.structExpect.filter((needle) => !run.badNames.some((name) => name.includes(needle)))
    const wentRed = run.badCount > 0 && !run.allGreen
    if (wentRed && missed.length === 0) {
      ok += 1
      lines.push('      [struct-check] ⇒ 变红：BAD=' + run.badCount + '，命中目标检查 ' +
        JSON.stringify(variant.structExpect) + '；实际 BAD ' + JSON.stringify(run.badNames))
    } else {
      bad += 1
      variantBad += 1
      lines.push('      [struct-check] ⇒ 🩸 没变红：OK=' + run.okCount + ' BAD=' + run.badCount +
        ' allGreen=' + run.allGreen + ' 超时=' + run.timedOut +
        '；期望命中（子串）' + JSON.stringify(variant.structExpect) + '，未命中 ' + JSON.stringify(missed) +
        '；实际 BAD ' + JSON.stringify(run.badNames) + ' → ' + run.file)
    }
  }
  // 每个变体跑完立刻复原（下一个变体必须从原件出发）
  writeFileSync(join(tmpRoot, 'lib', file), source, 'utf8')
  console.log((variantBad === 0 ? 'OK    ' : 'BAD   ') + variant.label + '  [' + variant.why + ']')
  for (const line of lines) console.log(line)
}

// 复原副本 + 复核工作区源文件字节
writeFileSync(join(tmpRoot, 'lib', 'client.js'), original, 'utf8')
writeFileSync(join(tmpRoot, 'lib', 'index.mjs'), originalHost, 'utf8')
const shaAfter = createHash('sha256').update(readFileSync(CLIENT, 'utf8')).digest('hex')
const shaAfterHost = createHash('sha256').update(readFileSync(HOST, 'utf8')).digest('hex')
const selfTestSha = createHash('sha256').update(readFileSync(SELF_TEST, 'utf8')).digest('hex')
const structCheckSha = createHash('sha256').update(readFileSync(STRUCT_CHECK, 'utf8')).digest('hex')

console.log('----')
console.log('源文件 sha256(after)  = ' + shaAfter.slice(0, 16) + '  （client.js 未改动：' + (shaBefore === shaAfter) + '）')
console.log('源文件 sha256(after)  = ' + shaAfterHost.slice(0, 16) + '  （index.mjs 未改动：' + (shaBeforeHost === shaAfterHost) + '）')
console.log('self-test.mjs sha256  = ' + selfTestSha.slice(0, 16) + '（仅记录，用于人工核对）')
console.log('struct-check sha256   = ' + structCheckSha.slice(0, 16) + '（仅记录，用于人工核对）')
console.log('反事实对照： OK=' + ok + '  BAD=' + bad)

let cleanupRefused = false
if (!KEEP) {
  // 🩸 删除前就地断言目标：必须在系统临时目录之下、且目录名前缀是我们自己造的
  const tmpBase = resolve(tmpdir()).toLowerCase()
  const target = resolve(tmpRoot)
  const safeName = basename(target).startsWith('dsh-usage-cf-')
  if (target.toLowerCase().startsWith(tmpBase + '\\') && safeName && target.toLowerCase() !== tmpBase) {
    rmSync(target, { recursive: true, force: true })
    console.log('临时副本已清理：' + target)
  } else {
    cleanupRefused = true
    console.log('拒绝清理临时副本（路径断言失败，请人工处理）：' + target)
  }
} else {
  console.log('--keep：临时副本保留在 ' + tmpRoot)
}

if (bad > 0 || shaBefore !== shaAfter || shaBeforeHost !== shaAfterHost || cleanupRefused) {
  console.log('COUNTERFACTUAL FAILED')
  process.exitCode = 1
} else {
  console.log('COUNTERFACTUAL ALL GREEN')
}
