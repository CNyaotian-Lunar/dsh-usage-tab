#!/usr/bin/env node
/**
 * dsh-usage-tab · 卸载 / 回滚器（默认干跑）
 *
 * 用法：
 *   node tools/uninstall.mjs                                   # 干跑：自动找出「已装本插件的 profile」
 *   node tools/uninstall.mjs --apply                           # 删 Junction（源码与备份都保留）
 *   node tools/uninstall.mjs --apply --backup <某 profile 的备份目录>   # 额外从备份还原 cordis.patch.yml
 *   node tools/uninstall.mjs --profile desktop --apply         # 只处理指定 profile
 *
 * 🩸 2026-10-13 修正：与 install.mjs 同步 —— profile 不再硬编码 `profiles\web`，
 *    默认枚举 `~/.dsh/profiles/*` 里**已装本插件的**逐个处理。
 *    ⚠️ `--backup <dir>` 是**单个 profile 的备份目录**（形如 …\<stamp>\<profile>）；
 *       多 profile 场景下 patch 还原请**每个 profile 各跑一次**。
 *
 * 安全约束（铁律④）：
 *   · 只删 **Junction**，且必须确认它指向该 profile 的 vendor\dsh-usage-tab-src
 *   · 不删 vendor 源码目录、不删备份
 *   · 还原 patch 前先把当前 patch 另存一份到同一备份目录（.before-restore）
 */
import { copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const PROFILES_ROOT = join(HOME, '.dsh', 'profiles')
const PLUGIN = 'dsh-usage-tab'
const VENDOR_NAME = 'dsh-usage-tab-src'
const PLUGIN_ID = 'usage-tab'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const backupIdx = argv.indexOf('--backup')
const BACKUP_DIR = backupIdx >= 0 ? argv[backupIdx + 1] : null
const profileArgIdx = argv.indexOf('--profile')
const PROFILE_ARG = profileArgIdx >= 0 ? argv[profileArgIdx + 1] : null
if (profileArgIdx >= 0 && !PROFILE_ARG) { console.error('[FAIL] --profile 后面要跟 profile 名'); process.exit(1) }

const say = (msg) => console.log(msg)
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(1) }

function assertUnder(child, parent, label) {
  const c = resolve(child)
  const p = resolve(parent)
  if (child.includes('..')) fail(`${label} 路径含 ..（拒绝）：${child}`)
  if (!c.toLowerCase().startsWith(p.toLowerCase() + '\\')) fail(`${label} 不在预期根之下（拒绝）：${child}`)
}

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

function looksInstalled(p) {
  if (existsSync(p.vendor)) return true
  if (existsSync(p.patch) && readFileSync(p.patch, 'utf8').includes(`id: ${PLUGIN_ID}`)) return true
  if (existsSync(p.pkg) && readFileSync(p.pkg, 'utf8').includes(`"${PLUGIN}": "link:vendor/${VENDOR_NAME}"`)) return true
  return false
}

say('== dsh-usage-tab 回滚器 ==')
say(`模式：${APPLY ? 'APPLY（真改）' : 'DRY-RUN（只打印）'}`)

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
  targets = names.map(pathsOf).filter(looksInstalled)
  if (!targets.length) fail('没有找到任何已装本插件的 profile。要针对某个 profile 请显式加：--profile <名字>')
  say(`目标 profile：自动探测 ⇒ ${targets.map((p) => p.name).join(' , ')}`)
}

if (BACKUP_DIR && targets.length > 1) {
  fail(`--backup 只能用于单个 profile（现在匹配到 ${targets.length} 个：${targets.map((p) => p.name).join(', ')}）⇒ 请加 --profile <名字> 逐个还原`)
}

for (const p of targets) {
  assertUnder(p.junction, join(p.root, 'node_modules'), `JUNCTION(${p.name})`)
}
say('')

const plan = targets.map((p) => {
  const junctionExists = existsSync(p.junction)
  const target = junctionExists ? linkTarget(p.junction) : null
  const isOurs = target !== null && target.toLowerCase() === resolve(p.vendor).toLowerCase()
  return { p, junctionExists, target, isOurs }
})

say('现状：')
for (const it of plan) {
  const { p } = it
  say(`  ── ${p.name} ─────────────────────────────`)
  say(`     Junction：${it.junctionExists ? (it.target === null ? '存在但不是 Junction（不会删）' : `→ ${it.target}${it.isOurs ? '' : '  ⚠️ 不指向本插件 vendor，将跳过'}`) : '不存在'}`)
  say(`     vendor  ：${existsSync(p.vendor) ? '保留（不动）' : '不存在'}`)
}
if (BACKUP_DIR) {
  const bak = join(BACKUP_DIR, 'cordis.patch.yml')
  say(`  待还原 patch：${bak} ${existsSync(bak) ? '(存在)' : '(缺失！)'}`)
} else {
  say('  patch：未指定 --backup ⇒ 只删 Junction，patch 里的 insert 行保留')
}
say('')

if (!APPLY) {
  say('将要执行（对每个 profile）：')
  for (const it of plan) {
    if (it.junctionExists && it.isOurs) say(`  · 删除 Junction：${it.p.junction}`)
    else if (it.junctionExists) say(`  · 跳过删除：${it.p.junction} 不是我们装的`)
    else say(`  · 跳过删除：${it.p.junction} 不存在`)
  }
  if (BACKUP_DIR) say('  · 还原 cordis.patch.yml（先把当前文件另存为 .before-restore）')
  say('')
  say('这是干跑。确认无误后加 --apply。')
  process.exit(0)
}

// ── 执行 ────────────────────────────────────────────────────────────────
for (const it of plan) {
  const { p } = it
  say(`══ ${p.name} ══`)
  if (it.junctionExists && it.isOurs) {
    rmSync(p.junction, { recursive: true, force: true })
    say(`  [1/2] 已删 Junction：${p.junction}`)
  } else if (it.junctionExists) {
    say('  [1/2] 跳过：不是我们装的 Junction（拒绝删）')
  } else {
    say('  [1/2] 跳过：Junction 不存在')
  }

  if (BACKUP_DIR) {
    const bak = join(BACKUP_DIR, 'cordis.patch.yml')
    if (!existsSync(bak)) fail(`备份里没有 cordis.patch.yml：${bak}`)
    if (existsSync(p.patch)) copyFileSync(p.patch, join(BACKUP_DIR, 'cordis.patch.yml.before-restore'))
    copyFileSync(bak, p.patch)
    const nowText = readFileSync(p.patch, 'utf8')
    const bakText = readFileSync(bak, 'utf8')
    if (nowText.includes(`id: ${PLUGIN_ID}`) && !bakText.includes(`id: ${PLUGIN_ID}`)) {
      fail(`还原后 patch 里仍有该行（备份本身可能已含）：${p.patch} —— 请人工检查`)
    }
    say(`  [2/2] 已还原 ${p.patch}（原文件另存 .before-restore）`)
  } else {
    say('  [2/2] 跳过 patch 还原（未指定 --backup）')
  }
}

say('')
say('完成。重启桌面版 App 使改动生效。')
say('若要连 patch 一起回滚（单 profile）：node tools/uninstall.mjs --apply --profile <名字> --backup <该 profile 的备份目录>')
