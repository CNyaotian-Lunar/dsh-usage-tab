#!/usr/bin/env node
/**
 * dsh-usage-tab — projcache 探针（**只读**）
 * ============================================================================
 *
 * 「日历」页的数据全靠会话投影缓存里的 `usageDaily` 行（`session.list` 的每行自带这一列）。
 * 本工具回答两个问题，**只解析 JSON、绝不写盘**：
 *
 *   ① **覆盖率**：有多少会话的缓存里已经有 `usageDaily`？按**会话创建日期**分组看 ——
 *      缺的那批就是"从没打开过、也没被写过投影缓存"的冷会话（宿主半第二步要补的对象）。
 *   ② **回填有没有生效**：重启桌面版 App（让 `watchUsageBackfill` 跑一趟）后再跑本工具，
 *      对比同一批老会话的覆盖率；宿主日志里对应那一行是
 *      `dsh-usage-tab: 冷会话回填完成 N 个会话的 usageDaily 投影`。
 *
 * 用法：
 *   node tools/projcache-probe.mjs                    # 默认读当前用户的 projcache
 *   node tools/projcache-probe.mjs --dir <目录>       # 指定缓存目录（默认 <DSH_HOME>/storages/session_projcache/sessions）
 *   node tools/projcache-probe.mjs --keys usageDaily,contextActivity
 *   node tools/projcache-probe.mjs --missing 40       # 列出最多 40 个仍缺 usageDaily 的会话
 *
 * 背景数据（实测基线）：老会话里 `usageDaily` 覆盖率明显偏低，缺的那批
 * **连 `dsh-context` 自己的 `contextActivity` 也缺** ⇒ 说明那条冷回填从没真正跑过。
 * 本工具就是给这条结论做前后对比用的。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_KEYS = ['usageDaily']
const OTHER_KEY_HINT = 'contextActivity' // 别人家（dsh-context）的键，用来交叉验证"整条冷回填从没跑过"

function parseArgs (argv) {
  const options = { dir: null, keys: DEFAULT_KEYS, missing: 20, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') { options.dir = argv[i + 1]; i += 1 } else if (arg === '--keys') {
      options.keys = String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (options.keys.length === 0) options.keys = DEFAULT_KEYS
      i += 1
    } else if (arg === '--missing') {
      options.missing = Number(argv[i + 1])
      if (!Number.isFinite(options.missing) || options.missing < 0) options.missing = 0
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      console.error('未知参数：' + arg)
      options.help = true
    }
  }
  return options
}

function printHelp () {
  console.log([
    'dsh-usage-tab — projcache 探针（只读）',
    '',
    '  node tools/projcache-probe.mjs [--dir <目录>] [--keys <k1,k2>] [--missing <N>]',
    '',
    '  --dir      缓存目录，默认 <DSH_HOME>/storages/session_projcache/sessions',
    '  --keys     要探的投影键，默认 usageDaily（可加 contextActivity 做交叉对照）',
    '  --missing  列出最多 N 个仍缺第一个键的会话（按会话创建时间升序），默认 20；0 = 不列',
    '  --help     打印这段'
  ].join('\n'))
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 毫秒 → 本地日历日期（人看的，与插件逐日分桶的口径同源）。 */
function dayOf (ms) {
  if (!Number.isFinite(ms)) return '(无 createdAt)'
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return }

  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
  const dir = options.dir || join(dshHome, 'storages', 'session_projcache', 'sessions')

  let names
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch (error) {
    console.error('读不到缓存目录：' + dir)
    console.error('  ' + (error && error.message ? error.message : String(error)))
    console.error('提示：用 --dir 指定实际目录，或确认这台机器上 DSH 的 storages 位置。')
    process.exitCode = 1
    return
  }

  const items = []
  const unreadableFiles = []
  let totalBytes = 0
  for (const name of names) {
    const full = join(dir, name)
    let record
    try {
      record = JSON.parse(readFileSync(full, 'utf8'))
    } catch {
      unreadableFiles.push(name)
      continue
    }
    let size = 0
    let mtime = NaN
    try { const stat = statSync(full); size = stat.size; mtime = stat.mtimeMs } catch {}
    totalBytes += size
    const inner = record && typeof record === 'object' && record.record !== undefined && record.record !== null
      ? record.record
      : {}
    const rows = inner.rows !== undefined && inner.rows !== null && typeof inner.rows === 'object' ? inner.rows : {}
    const identity = inner.identity !== undefined && inner.identity !== null && typeof inner.identity === 'object' ? inner.identity : {}
    const has = {}
    const ver = {}
    for (const key of options.keys) {
      const row = rows[key]
      has[key] = row !== undefined && row !== null
      ver[key] = has[key] && typeof row === 'object' && Number.isFinite(row.ver) ? row.ver : null
    }
    items.push({
      file: name,
      id: basename(name, '.json'),
      createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : NaN,
      cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
      size,
      mtime,
      has,
      ver
    })
  }

  console.log('projcache 目录：' + dir)
  console.log('会话缓存 ' + items.length + ' 个（解析失败 ' + unreadableFiles.length + ' 个，已跳过）· 合计 ' + (totalBytes / 1048576).toFixed(1) + ' MB')
  if (unreadableFiles.length > 0) {
    console.log('  ⚠️ 解析失败的文件既不在覆盖率分母、也不进"仍缺"清单 —— 别把"覆盖率 100%"当成读全了：')
    console.log('     ' + unreadableFiles.slice(0, 10).join(' , ') +
      (unreadableFiles.length > 10 ? ' …（共 ' + unreadableFiles.length + ' 个）' : ''))
  }
  console.log('')

  console.log('=== 键覆盖率（**上界**口径：只看键在不在，不看 `ver` 与 `val` 能否过 parse）===')
  for (const key of options.keys) {
    const hit = items.filter((item) => item.has[key]).length
    const rate = items.length === 0 ? 0 : (hit / items.length) * 100
    const vers = new Map()
    for (const item of items) {
      if (!item.has[key]) continue
      const label = item.ver[key] === null ? '(无 ver)' : 'ver=' + item.ver[key]
      vers.set(label, (vers.get(label) || 0) + 1)
    }
    const verText = vers.size === 0 ? '' : '  ' + [...vers.entries()].map(([label, n]) => label + '×' + n).join(' · ')
    console.log('  ' + key.padEnd(18) + hit + ' / ' + items.length + '  (' + rate.toFixed(1) + '%)' + verText)
  }
  console.log('  ⚠️ 宿主还要 `row.ver === stateVersion` 且 `stateSchema.parse(row.val)` 通过，才算真"服务得了"')
  console.log('     ⇒ 把上面的 ver 分布与 `lib/index.mjs` 的 `PROJECTION_STATE_VERSION` 对一眼；对不上 = "有行但服务不了"。')
  if (items.length === 0) { console.log('（没有可统计的缓存）'); return }

  // 按会话创建日期分组：最能看出"缺的是哪一批"
  const byDay = new Map()
  for (const item of items) {
    const day = dayOf(item.createdAt)
    let bucket = byDay.get(day)
    if (bucket === undefined) {
      bucket = { total: 0, hit: 0, missing: 0 }
      for (const key of options.keys) bucket['key:' + key] = 0
      byDay.set(day, bucket)
    }
    bucket.total += 1
    if (item.has[options.keys[0]]) { bucket.hit += 1 } else { bucket.missing += 1 }
    for (const key of options.keys) if (item.has[key]) bucket['key:' + key] += 1
  }
  const days = [...byDay.keys()].sort()

  console.log('')
  console.log('=== 按会话创建日期（全部 ' + days.length + ' 天）===')
  const HEAD = 12
  const TAIL = 6
  const shown = days.length <= HEAD + TAIL ? days : [...days.slice(0, HEAD), '…', ...days.slice(-TAIL)]
  for (const day of shown) {
    if (day === '…') { console.log('  …'); continue }
    const bucket = byDay.get(day)
    const extra = options.keys.length > 1
      ? '  [' + options.keys.map((k) => k + ' ' + bucket['key:' + k] + '/' + bucket.total).join(' · ') + ']'
      : ''
    console.log('  ' + day + '  ' + String(bucket.total).padStart(4) + ' 个 · 有 ' + options.keys[0] + ' ' +
      String(bucket.hit).padStart(4) + ' · 缺 ' + String(bucket.missing).padStart(4) + extra)
  }

  const missingItems = items
    .filter((item) => !item.has[options.keys[0]])
    .sort((a, b) => (Number.isFinite(a.createdAt) ? a.createdAt : Infinity) - (Number.isFinite(b.createdAt) ? b.createdAt : Infinity))
  console.log('')
  console.log('=== 仍缺 ' + options.keys[0] + ' 的会话：' + missingItems.length + ' 个' +
    (missingItems.length > options.missing ? '（只列最旧的 ' + options.missing + ' 个）' : '') + ' ===')
  for (const item of missingItems.slice(0, options.missing)) {
    console.log('  ' + dayOf(item.createdAt) + '  ' + item.id.slice(0, 20).padEnd(22) +
      (item.cwd === '' ? '(无 cwd)' : item.cwd) + '  ' + String(item.size).padStart(8) + 'B')
  }
  if (options.missing === 0) console.log('  （--missing 0：不列清单）')

  if (options.keys.includes(OTHER_KEY_HINT)) {
    const first = options.keys[0]
    const bothMissing = items.filter((item) => !item.has[first] && !item.has[OTHER_KEY_HINT]).length
    const onlyOursMissing = items.filter((item) => !item.has[first] && item.has[OTHER_KEY_HINT]).length
    console.log('')
    console.log('交叉对照（' + first + ' vs ' + OTHER_KEY_HINT + '）：')
    console.log('  · 两个键同时缺 ' + bothMissing + ' 个 ⇒ 两边都没折过（连 dsh-context 的回填也没覆盖到）')
    console.log('  · 只有本插件缺 ' + onlyOursMissing + ' 个 ⇒ 别人家跑过、只有我们没跑（**本步回填最该补上的一批**）')
  }
  console.log('')
  console.log('提示：本工具只读。回填后复验 = 重启桌面版 App 后再跑一次本命令，看上面那批日期的"缺"是否归零；')
  console.log('      宿主日志里对应一行是「dsh-usage-tab: 冷会话回填完成 N 个会话的 usageDaily 投影」。')
}

main()
