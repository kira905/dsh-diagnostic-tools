#!/usr/bin/env node
// scripts/test-fixtures.mjs —— 干净夹具验证（**不碰任何真实 DSH 安装**）
//
// 目的：证明这套工具在「别人的环境」里也能判对 —— 所有输入都是本脚本现造的假闭包树，
//       不读生产 home、不读生产 profile、不碰真链接。
//
// 夹具根（固定路径 + **幂等复用**，避免反复重建触发安全软件弹窗）：
//   <系统临时目录>/dsh-closure-tools-fixture/
//     prod-closure/            假「期望闭包根」（= 全局 npm 主包自带 node_modules）
//       pkg-a/  @scope/pkg-b/
//     other-install/           假「另一个 DSH 安装的依赖目录」
//       dsh-pkg/node_modules/pkg-c/
//     link-layer-clean/        干净链接层（全部指向 prod-closure）
//     link-layer-dirty/        混合层（1 干净 + 1 指向另一个安装 + 1 断链）
//     link-layer-broken/       只含断链
//
// 覆盖的判定（与 README §3/§5 对应）：
//   ① 干净 🟢      → level=ok，CLI 退出码 0
//   ② 有污染 🔴    → level=danger，CLI 退出码 1（污染优先级高于断链）
//   ③ 只有断链 🟡  → level=warn，CLI 退出码 2
//   ④ 链接层不可用 → reason=link-root-missing，CLI 退出码 3
//   ⑤ dry-run 不回退：`repair-closure-links`（默认模式）跑完，整个夹具根逐项指纹不变、且未新建任何文件
//   ⑥ 污染特征可注入：换成不匹配的特征 → 污染归零；换成匹配的特征 → 重新判红
//
// 用法：
//   node scripts/test-fixtures.mjs            # 跑一遍（夹具不存在则创建）
//   node scripts/test-fixtures.mjs --clean    # 先清掉旧夹具再重建（会重新创建链接）
//   node scripts/test-fixtures.mjs --keep     # 跑完保留夹具（默认就是保留）
//
// 退出码：0 = 全部断言通过（允许有 SKIP，SKIP 会打印原因）；1 = 有断言失败。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const CLI_CHECK = path.join(PKG, 'closure-check.mjs')
const CLI_REPAIR = path.join(PKG, 'repair-closure-links.mjs')

const FIX = path.join(os.tmpdir(), 'dsh-closure-tools-fixture')
const PROD = path.join(FIX, 'prod-closure')
const OTHER = path.join(FIX, 'other-install-canary', 'dsh-pkg', 'node_modules')
const LCLEAN = path.join(FIX, 'link-layer-clean')
const LDIRTY = path.join(FIX, 'link-layer-dirty')
const LBROKEN = path.join(FIX, 'link-layer-broken')
const GONE_TARGET = path.join(FIX, 'gone-target-not-created')

let fail = 0
let skip = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
  if (!ok) fail += 1
}
const skipped = (name, why) => {
  console.log('[SKIP] ' + name + ' :: ' + why)
  skip += 1
}

// ---------------------------------------------------------------- 夹具

const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
const LINK_CREATE_ERRORS = new Set(['EPERM', 'EACCES', 'UNKNOWN'])

/** 幂等建链接：形态正确就复用（零创建）。被安全软件拦下时返回 false（不连锁失败）。 */
function ensureLink(linkPath, target) {
  try { fs.mkdirSync(path.dirname(linkPath), { recursive: true }) } catch { /* ignore */ }
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) {
      const cur = fs.readlinkSync(linkPath)
      if (path.resolve(cur).toLowerCase() === path.resolve(target).toLowerCase()) return { ok: true, reused: true }
      fs.unlinkSync(linkPath)
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true })
    }
  } catch { /* 不存在 → 继续创建 */ }
  try {
    fs.symlinkSync(target, linkPath, 'junction')
    return { ok: true, reused: false }
  } catch (e) {
    return { ok: false, reused: false, error: e }
  }
}

/** 清理夹具：先逐个摘掉链接本体（绝不递归删含链接的父目录），再删剩下的树。 */
function cleanFixture() {
  const layers = [LCLEAN, LDIRTY, LBROKEN]
  for (const layer of layers) {
    let entries = []
    try { entries = fs.readdirSync(layer, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(layer, e.name)
      try {
        if (fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full)
      } catch { /* ignore */ }
    }
    try { fs.rmSync(layer, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  for (const dir of [PROD, path.join(FIX, 'other-install-canary')]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

function buildFixture() {
  mkdir(PROD); mkdir(OTHER); mkdir(LCLEAN); mkdir(LDIRTY); mkdir(LBROKEN)
  for (const rel of ['pkg-a', path.join('@scope', 'pkg-b')]) {
    const dir = path.join(PROD, rel)
    mkdir(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: rel.replace(/\\/g, '/'), version: '1.0.0' }) + '\n', 'utf8')
  }
  const otherPkg = path.join(OTHER, 'pkg-c')
  mkdir(otherPkg)
  fs.writeFileSync(path.join(otherPkg, 'package.json'), JSON.stringify({ name: 'pkg-c', version: '9.9.9' }) + '\n', 'utf8')

  const created = { ok: 0, reused: 0, blocked: [] }
  const link = (from, to) => {
    const r = ensureLink(from, to)
    if (r.ok) { if (r.reused) created.reused += 1; else created.ok += 1 }
    else created.blocked.push(`${path.relative(FIX, from)} (${r.error?.code ?? r.error?.message ?? 'error'})`)
    return r.ok
  }
  link(path.join(LCLEAN, 'pkg-a'), path.join(PROD, 'pkg-a'))
  link(path.join(LCLEAN, '@scope', 'pkg-b'), path.join(PROD, '@scope', 'pkg-b'))
  link(path.join(LDIRTY, 'pkg-a'), path.join(PROD, 'pkg-a'))
  link(path.join(LDIRTY, 'pkg-c'), path.join(OTHER, 'pkg-c'))
  link(path.join(LDIRTY, 'pkg-gone'), GONE_TARGET)
  link(path.join(LBROKEN, 'pkg-gone'), GONE_TARGET)
  return created
}

/** 整个夹具根的指纹（相对路径 + 类型 + 链接目标 + 大小 + mtime），用于「dry-run 不写盘」断言。 */
function fingerprint(root) {
  const rows = []
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full).replace(/\\/g, '/')
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      if (st.isSymbolicLink()) {
        let t = ''
        try { t = fs.readlinkSync(full) } catch { /* ignore */ }
        rows.push(`${rel}|link|${t}`)
      } else if (st.isDirectory()) {
        rows.push(`${rel}|dir|${st.mtimeMs}`)
        walk(full)
      } else {
        rows.push(`${rel}|file|${st.size}|${st.mtimeMs}`)
      }
    }
  }
  walk(root)
  return { rows, sha: createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex') }
}

// ---------------------------------------------------------------- CLI 调用

function runCli(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout ?? ''), err: (r.stderr ?? '') }
}
const jsonCli = (script, args) => {
  const r = runCli(script, [...args, '--json'])
  let data = null
  try { data = JSON.parse(r.out) } catch { /* ignore */ }
  return { ...r, data }
}

// ---------------------------------------------------------------- 主流程

const argv = process.argv.slice(2)
if (argv.includes('--clean')) cleanFixture()
mkdir(FIX)
const created = buildFixture()
if (created.blocked.length) {
  console.log('[i] 链接创建受阻（安全软件可能弹窗拦截；夹具带链接的部分将记为 SKIP）：')
  for (const b of created.blocked) console.log('    - ' + b)
}
console.log(`[i] 夹具根: ${FIX}`)
console.log(`[i] 链接：新建 ${created.ok} / 复用 ${created.reused} / 受阻 ${created.blocked.length}`)
console.log('')

// ① 干净
const cleanScan = jsonCli(CLI_CHECK, ['--link-root', LCLEAN, '--source-root', PROD])
if (created.blocked.length === 0) {
  check('① 干净夹具：CLI 退出码 0', cleanScan.code === 0, `exit=${cleanScan.code}`)
  check('① 干净夹具：level=ok', cleanScan.data?.level === 'ok', `level=${cleanScan.data?.level}`)
  check('① 干净夹具：链接总数 2 且全部指向期望闭包', cleanScan.data?.total === 2 && cleanScan.data?.matched === 2,
    `total=${cleanScan.data?.total} matched=${cleanScan.data?.matched}`)
  check('① 干净夹具：污染 0 / 断链 0', cleanScan.data?.polluted?.length === 0 && cleanScan.data?.broken?.length === 0,
    `polluted=${cleanScan.data?.polluted?.length} broken=${cleanScan.data?.broken?.length}`)
} else {
  skipped('① 干净夹具判定', '链接创建被拦，无法构造带链接的夹具')
}

// ② 有污染（🔴 优先于断链）
const dirtyScan = jsonCli(CLI_CHECK, ['--link-root', LDIRTY, '--source-root', PROD])
if (created.blocked.length === 0) {
  check('② 混合夹具：CLI 退出码 1（有污染）', dirtyScan.code === 1, `exit=${dirtyScan.code}`)
  check('② 混合夹具：level=danger', dirtyScan.data?.level === 'danger', `level=${dirtyScan.data?.level}`)
  check('② 混合夹具：污染 1 / 干净 1 / 断链 1',
    dirtyScan.data?.polluted?.length === 1 && dirtyScan.data?.matched === 1 && dirtyScan.data?.broken?.length === 1,
    `polluted=${dirtyScan.data?.polluted?.length} matched=${dirtyScan.data?.matched} broken=${dirtyScan.data?.broken?.length}`)
  check('② 归因：污染条目标出命中的特征 id',
    Array.isArray(dirtyScan.data?.polluted?.[0]?.pollutionIds) && dirtyScan.data.polluted[0].pollutionIds.length >= 1,
    JSON.stringify(dirtyScan.data?.polluted?.[0]?.pollutionIds ?? null))
  // 修法计划（只读）：应规划 1 条 remove（期望闭包内无同名包 → 不造物）
  const planRun = runCli(CLI_REPAIR, ['--link-root', LDIRTY, '--source-root', PROD, '--json'])
  let plan = null
  try { plan = JSON.parse(planRun.out) } catch { /* ignore */ }
  check('② 修法计划（dry-run）：污染项规划为 remove（不造物）',
    plan?.mode === 'dry-run' && plan?.items?.length === 1 && plan.items[0].action === 'remove',
    `items=${JSON.stringify(plan?.items ?? null)}`)
} else {
  skipped('② 污染判定 / 修法计划', '链接创建被拦')
}

// ③ 只有断链（🟡）
const brokenScan = jsonCli(CLI_CHECK, ['--link-root', LBROKEN, '--source-root', PROD])
if (created.blocked.length === 0) {
  check('③ 断链夹具：CLI 退出码 2', brokenScan.code === 2, `exit=${brokenScan.code}`)
  check('③ 断链夹具：level=warn 且 broken=1', brokenScan.data?.level === 'warn' && brokenScan.data?.broken?.length === 1,
    `level=${brokenScan.data?.level} broken=${brokenScan.data?.broken?.length}`)
} else {
  skipped('③ 断链判定', '链接创建被拦')
}

// ④ 链接层不可用（exit 3）
const missingScan = jsonCli(CLI_CHECK, ['--link-root', path.join(FIX, 'no-such-layer'), '--source-root', PROD])
check('④ 链接层不存在：CLI 退出码 3', missingScan.code === 3, `exit=${missingScan.code}`)
check('④ 链接层不存在：reason=link-root-missing', missingScan.data?.reason === 'link-root-missing', `reason=${missingScan.data?.reason}`)

// ⑤ dry-run 不回退（整个夹具根逐项指纹不变 + 未新建文件）
{
  const before = fingerprint(FIX)
  const dry = runCli(CLI_REPAIR, ['--link-root', LDIRTY, '--source-root', PROD])
  const after = fingerprint(FIX)
  check('⑤ dry-run：退出码 0 且提示 DRY-RUN', dry.code === 0 && /DRY-RUN/.test(dry.out), `exit=${dry.code}`)
  check('⑤ dry-run 未改动夹具任何一项（含链接目标）', before.sha === after.sha,
    `before=${before.sha.slice(0, 12)} after=${after.sha.slice(0, 12)}`)
  check('⑤ dry-run 未新建备份/回滚目录（.backups 不存在）', !fs.existsSync(path.join(PKG, '.backups')))
}

// ⑥ 污染特征可注入
{
  const noMatch = jsonCli(CLI_CHECK, ['--link-root', LDIRTY, '--source-root', PROD, '--pollution-pattern', 'zzz-no-such-pattern'])
  const yesMatch = jsonCli(CLI_CHECK, ['--link-root', LDIRTY, '--source-root', PROD, '--pollution-pattern', 'other-install'])
  const cfg = jsonCli(CLI_CHECK, ['--link-root', LDIRTY, '--source-root', PROD, '--print-config'])
  if (created.blocked.length === 0) {
    check('⑥ 注入不匹配的特征 → 污染归零、退化为 warn(2)',
      noMatch.data?.polluted?.length === 0 && noMatch.code === 2,
      `polluted=${noMatch.data?.polluted?.length} exit=${noMatch.code}`)
    check('⑥ 注入匹配的特征 → 重新判红(1)',
      yesMatch.data?.polluted?.length === 1 && yesMatch.code === 1,
      `polluted=${yesMatch.data?.polluted?.length} exit=${yesMatch.code}`)
  } else {
    skipped('⑥ 污染特征注入判定', '链接创建被拦')
  }
  check('⑥ --print-config：链接层/期望闭包来自 cli', cfg.data?.linkRoot?.from === 'cli' && cfg.data?.sourceRoot?.from === 'cli',
    `linkRoot.from=${cfg.data?.linkRoot?.from} sourceRoot.from=${cfg.data?.sourceRoot?.from}`)
  check('⑥ --print-config：污染特征标为 injected',
    (cfg.data?.pollutionPatterns ?? []).every((p) => p.from === 'injected'),
    JSON.stringify(cfg.data?.pollutionPatterns ?? null))
}

// ⑦ 自动探测（不传 --source-root 时能自己找到全局 npm 主包依赖目录）
{
  const auto = runCli(CLI_CHECK, ['--link-root', LCLEAN, '--quiet'])
  const probe = runCli(CLI_CHECK, ['--print-config'])
  let src = null
  try { src = JSON.parse(probe.out)?.sourceRoot } catch { /* ignore */ }
  if (src?.value) {
    check('⑦ 不传 --source-root 时可自动探测期望闭包根',
      auto.code === 0 || auto.code === 2,
      `from=${src.from} value=${src.value}`)
  } else {
    skipped('⑦ 自动探测期望闭包根', '当前环境未探测到全局 npm 主包依赖目录（用 --source-root 显式指定即可）')
  }
}

// ⑧ 默认污染特征 = **形态判据**，不是写死某个安装名（纯正则断言：不建目录、不依赖链接，任何机器可复跑）
{
  const { DEFAULT_POLLUTION_PATTERNS } = await import(pathToFileURL(path.join(PKG, 'lib', 'runtime-config.mjs')).href)
  const hit = (p) => DEFAULT_POLLUTION_PATTERNS.some((x) => x.re.test(p))
  // 路径一律用 path.join 现拼 —— 源码文本里不留绝对路径字面量（这也是给使用者看的示范）
  const J = (...seg) => path.join(...seg)
  const cases = [
    [J('F:', 'any', 'proj-test', 'install', 'node_modules', 'pkg-c'), true, '形如 *-test 的安装目录'],
    [J('C:', 'work', 'other-install-test', 'sub', 'node_modules', 'pkg'), true, '路径中段含 *-test 目录段'],
    [J('D:', 'x', 'canary-2', 'node_modules', 'pkg'), true, 'canary'],
    [J('C:', 'Users', 'someone', 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'pkg-a'),
      false, '期望闭包自身（不得误伤）'],
    [J('C:', 'work', 'project', 'node_modules', 'latest-pkg'), false, '普通目录（latest 不算 -test）'],
  ]
  for (const [p, want, why] of cases) {
    check(`⑧ 默认特征（形态判据）：${why}`, hit(p) === want, `${want ? '应命中' : '不应命中'} :: ${p}`)
  }
  check('⑧ 默认特征 id 语义化、不含具体安装名',
    DEFAULT_POLLUTION_PATTERNS.every((x) => /^[a-z][a-z0-9-]*$/.test(String(x.id))),
    DEFAULT_POLLUTION_PATTERNS.map((x) => x.id).join(', '))
}

console.log('')
console.log(`结果：断言 ${fail === 0 ? '全过' : fail + ' 项失败'}｜SKIP ${skip} 项｜夹具保留在 ${FIX}（--clean 可重建）`)
process.exitCode = fail === 0 ? 0 : 1
