#!/usr/bin/env node
/**
 * dsh-usage-tab · 安装器（默认干跑；幂等；只增不删）
 *
 * 用法：
 *   node tools/install.mjs                          # 干跑：自动找出「已装本插件的 profile」并打印将要做什么
 *   node tools/install.mjs --apply                  # 真正执行（每个 profile 各自备份 cordis.patch.yml）
 *   node tools/install.mjs --profile desktop        # 只处理指定 profile（允许该 profile 尚未装过）
 *   node tools/install.mjs --profile desktop --apply
 *   node tools/install.mjs --backups <dir>          # 覆盖备份根目录
 *
 * 🩸 修正：一台机器上可能存在多个 profile（如桌面版与 web 版各一个）。
 *    旧版把 profile 硬编码成 `profiles\web` ⇒ 改了 lib/ 跑 --apply 只同步 web，**改完不生效且极难查**。
 *    现在：默认枚举 `~/.dsh/profiles/*`，只挑「已装过本插件的」逐个处理（判据见 looksInstalled()）；
 *    显式 `--profile <名字>` 时只处理它，且允许它尚未装过（用于首次安装）。
 *
 * 对每个 profile 做四件事（全部可回滚，见 tools/uninstall.mjs）：
 *   ① 备份该 profile 的 cordis.patch.yml
 *   ② 把插件源码铺到 <profile>\vendor\dsh-usage-tab-src\
 *   ③ 在 <profile>\node_modules\ 建 Junction → 上述 vendor 目录
 *   ④ 在 profile 的 cordis.patch.yml 末尾追加一行 insert（已有则跳过）
 *
 * ⚠️ 本脚本**不碰 profile 的 package.json**。桌面迁移时那边额外写过
 *    `"dsh-usage-tab": "link:vendor/dsh-usage-tab-src"`（官方路），本脚本只**检测并报告**它的存在与否。
 *
 * 🩸 绝不跑 `pnpm install`：它会重新解包 `file:vendor/*.tgz` 型依赖，可能覆盖你在本地的改动。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件源 = 本脚本所在目录的上一级（不写死盘符，便于移植）。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = homedir()
const PROFILES_ROOT = join(HOME, '.dsh', 'profiles')
const PLUGIN = 'dsh-usage-tab'
const VENDOR_NAME = 'dsh-usage-tab-src'
const PLUGIN_ID = 'usage-tab'
const LINK_DEP = `"${PLUGIN}": "link:vendor/${VENDOR_NAME}"`

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const backupArg = argv.indexOf('--backups')
const BACKUPS_ROOT = backupArg >= 0 ? resolve(argv[backupArg + 1]) : join(HOME, '.dsh-plugin-backups')
const profileArgIdx = argv.indexOf('--profile')
const PROFILE_ARG = profileArgIdx >= 0 ? argv[profileArgIdx + 1] : null
if (profileArgIdx >= 0 && !PROFILE_ARG) { console.error('[FAIL] --profile 后面要跟 profile 名'); process.exit(1) }

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const BACKUP_DIR = join(BACKUPS_ROOT, `dsh-usage-tab-install-${STAMP}`)

const say = (msg) => console.log(msg)
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(1) }

// ── 铁律④：覆盖 / 删除类操作前，先就地断言目标 ─────────────────────────
function assertUnder(child, parent, label) {
  const c = resolve(child)
  const p = resolve(parent)
  if (child.includes('..')) fail(`${label} 路径含 ..（拒绝）：${child}`)
  if (!c.toLowerCase().startsWith(p.toLowerCase() + '\\')) fail(`${label} 不在预期根之下（拒绝）：${child}`)
  if (c.toLowerCase() === p.toLowerCase()) fail(`${label} 等于根自身（拒绝）：${child}`)
}

/** Junction 的 readlink 可能带 \\?\ 前缀 ⇒ 规范化后比较。 */
function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return resolve(readlinkSync(path).replace(/^\\\\\?\\/, ''))
  } catch {
    return null
  }
}

function pathsOf(name) {
  const root = join(PROFILES_ROOT, name)
  return {
    name,
    root,
    vendor: join(root, 'vendor', VENDOR_NAME),
    junction: join(root, 'node_modules', PLUGIN),
    patch: join(root, 'cordis.patch.yml'),
    pkg: join(root, 'package.json'),
  }
}

/** 「已装过本插件」的判据：有 vendor 副本 / 或 patch 已含 insert 行 / 或 package.json 有 link 依赖。 */
function looksInstalled(p) {
  if (existsSync(p.vendor)) return true
  if (existsSync(p.patch) && readFileSync(p.patch, 'utf8').includes(`id: ${PLUGIN_ID}`)) return true
  if (existsSync(p.pkg) && readFileSync(p.pkg, 'utf8').includes(LINK_DEP)) return true
  return false
}

// ── 选目标 profile ──────────────────────────────────────────────────────
say('== dsh-usage-tab 安装器 ==')
say(`模式：${APPLY ? 'APPLY（真改）' : 'DRY-RUN（只打印）'}`)
say(`插件源：${SRC}`)

let targets
if (PROFILE_ARG) {
  const p = pathsOf(PROFILE_ARG)
  if (!existsSync(p.root)) fail(`指定的 profile 不存在：${p.root}`)
  targets = [p]
  say(`目标 profile：显式指定 ⇒ ${p.name}`)
} else {
  if (!existsSync(PROFILES_ROOT)) fail(`profiles 根目录不存在：${PROFILES_ROOT}`)
  const names = readdirSync(PROFILES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.'))
    .map((d) => d.name)
  const installed = names.map(pathsOf).filter(looksInstalled)
  const skipped = names.filter((n) => !installed.some((p) => p.name === n))
  say(`目标 profile：自动探测 ⇒ ${installed.length ? installed.map((p) => p.name).join(' , ') : '（无）'}`)
  if (skipped.length) say(`  （未装本插件、已跳过：${skipped.join(' , ')}；要给它们装请显式加 --profile <名字>）`)
  if (!installed.length) fail('没有找到任何已装本插件的 profile。首次安装请显式指定：--profile <名字>')
  targets = installed
}
say('')

// ── 预检 ────────────────────────────────────────────────────────────────
if (!existsSync(join(SRC, 'package.json'))) fail(`插件源不完整：${SRC}\\package.json 不存在`)
if (!existsSync(join(SRC, 'lib', 'index.mjs'))) fail(`插件源不完整：${SRC}\\lib\\index.mjs 不存在`)
if (!existsSync(join(SRC, 'cordis.patch.yml'))) fail(`插件源不完整：${SRC}\\cordis.patch.yml 不存在`)

const plan = []
for (const p of targets) {
  assertUnder(p.vendor, p.root, `VENDOR(${p.name})`)
  assertUnder(p.junction, join(p.root, 'node_modules'), `JUNCTION(${p.name})`)
  if (!existsSync(p.root)) fail(`profile 不存在：${p.root}`)
  if (!existsSync(p.patch)) fail(`profile patch 不存在：${p.patch}`)

  const patchText = readFileSync(p.patch, 'utf8')
  const junctionNow = existsSync(p.junction) ? linkTarget(p.junction) : null
  const junctionOk = junctionNow !== null && junctionNow.toLowerCase() === resolve(p.vendor).toLowerCase()

  if (existsSync(p.junction) && junctionNow !== null && !junctionOk) {
    fail(`已存在指向别处的链接：${p.junction} → ${junctionNow}（拒绝覆盖；请人工确认后先处理）`)
  }
  if (existsSync(p.junction) && junctionNow === null) {
    fail(`${p.junction} 已存在且不是 Junction（拒绝覆盖）`)
  }

  plan.push({
    p,
    patchHasRow: patchText.includes(`id: ${PLUGIN_ID}`),
    vendorExists: existsSync(p.vendor),
    junctionOk,
    hasLinkDep: existsSync(p.pkg) && readFileSync(p.pkg, 'utf8').includes(LINK_DEP),
  })
}

say('现状与将要做的事：')
for (const it of plan) {
  const { p } = it
  say(`  ── ${p.name} ─────────────────────────────`)
  say(`     patch       ：${p.patch}`)
  say(`     vendor      ：${it.vendorExists ? '已存在（将覆盖源码）' : '不存在（将新建）'}`)
  say(`     node_modules：${it.junctionOk ? 'Junction 已指向本插件 vendor（跳过）' : existsSync(p.junction) ? '存在但需处理' : '不存在（将新建 Junction）'}`)
  say(`     ${PLUGIN_ID} 行   ：${it.patchHasRow ? '已存在（跳过）' : '不存在（将追加）'}`)
  say(`     package.json：${it.hasLinkDep ? `已有 ${LINK_DEP}（本脚本不动它）` : '⚠️ 没有 link 依赖行（本脚本不自动加；若宿主不加载需手工补）'}`)
}
say('')
say(`备份：${BACKUP_DIR}\\<profile>\\cordis.patch.yml`)

if (!APPLY) {
  say('')
  say('不会做：跑 pnpm install / 改 package.json / 改动其它插件 / 删任何既有文件。')
  say('这是干跑。确认无误后执行：node tools/install.mjs --apply' + (PROFILE_ARG ? ` --profile ${PROFILE_ARG}` : ''))
  process.exit(0)
}

// ── 执行 ────────────────────────────────────────────────────────────────
const PATCH_BLOCK = (stamp) => `
# ── dsh-usage-tab（时间统计 tab）· 由 tools/install.mjs 于 ${stamp} 追加 ──
# 在会话页签「上下文」右边新增「时间统计」tab（本会话用时卡片）。回滚见 tools/uninstall.mjs。
- insert:
    - id: ${PLUGIN_ID}
      name: '${PLUGIN}'
`
const EXCLUDE = new Set(['.git', 'notes', 'out', 'tools', 'node_modules', 'backups'])

for (const it of plan) {
  const { p } = it
  say('')
  say(`══ ${p.name} ══`)

  say('  [1/4] 备份 profile patch …')
  const bakDir = join(BACKUP_DIR, p.name)
  mkdirSync(bakDir, { recursive: true })
  cpSync(p.patch, join(bakDir, 'cordis.patch.yml'))
  say(`        → ${join(bakDir, 'cordis.patch.yml')}`)

  say('  [2/4] 铺插件源码 …')
  mkdirSync(p.vendor, { recursive: true })
  cpSync(SRC, p.vendor, { recursive: true, filter: (s) => !EXCLUDE.has(basename(s)) })
  say(`        → ${p.vendor}`)

  say('  [3/4] 建 Junction …')
  if (it.junctionOk) {
    say('        已存在且指向正确，跳过')
  } else {
    symlinkSync(p.vendor, p.junction, 'junction')
    say(`        → ${p.junction}`)
  }

  say('  [4/4] 追加 profile patch …')
  if (it.patchHasRow) {
    say('        patch 已含该行，跳过')
  } else {
    writeFileSync(p.patch, readFileSync(p.patch, 'utf8').replace(/\n*$/, '\n') + PATCH_BLOCK(STAMP), 'utf8')
    say(`        → ${p.patch}`)
  }
}

say('')
say('完成。接下来（需要你手动）：')
say('  1) 🩸 **重启桌面版 App**（宿主半 lib/index.mjs 与客户端半 lib/client.js **都在启动时加载**；本机是 Electron 套壳，**没有「刷新页面」这个动作**）')
say('  2) 验证：重启后打开会话，看页签行是否在「上下文」右边多出「时间统计」')
say('  3) 回归：宿主 stderr 应为 0 B；其它自研插件的自测应仍全绿')
say(`  4) 回滚：node tools/uninstall.mjs --apply --profile <名字> --backup "${join(BACKUP_DIR, '<名字>')}"`)
