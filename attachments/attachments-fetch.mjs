#!/usr/bin/env node
// ============================================================
//  attachments-fetch.mjs — 图片附件对象 · 按需取回 / 导出 / 回滚
//  ------------------------------------------------------------
//  场景：DSH 的图片实体只存 `<home>/attachments/v1/objects/<sha 前 2 位>/<sha256>`，
//  而跨机同步（配置仓 / 会话仓 / 手工拷贝）**默认不搬 attachments** ⇒ 同步过来的含图会话
//  在本机续聊必报 TRANSPORT（根因链见 attachments-audit.mjs 头部注释）。
//  本脚本按 sha256 把缺失对象取回来 —— 从对端目录、从中转介质、或从本机自己的派生数据里。
//
//  用法：
//    # 取回（缺什么补什么）
//    node attachments-fetch.mjs --all-missing [--from <对端 attachments 路径>] --verify
//    node attachments-fetch.mjs --session <会话id|前缀>
//    node attachments-fetch.mjs --hash <sha256> [--hash ...]
//    node attachments-fetch.mjs --probe                  # 只列可用取回源与覆盖率（只读）
//    node attachments-fetch.mjs --export <目录>          # 反向：把本机会话引用的附件导出成中转包
//    node attachments-fetch.mjs --rollback <报告.json>   # 按报告删除本次新写文件
//    node attachments-fetch.mjs --print-config           # 只看路径解析结果（排查用）
//
//  取回源（按优先级；命中即用）
//    1) --from <path>  可多个：对端 attachments 根 / v1 / objects / 任意目录（自动识别层级）
//    2) --relay <dir>  中转目录（`<dir>/objects/<2>/<sha>` 或 `<dir>/<2>/<sha>`，也认一层主机名目录）；
//                      未显式给时探测 `$ATTACH_RELAY_DIRS` 与 `<workspace>/_tmp/attachments-relay`
//    3) 本机派生源（零跨机，自动）：`<home>/dsh-imagegen/{images,gallery/images}`、`<workspace>/generated`
//                       —— 按**内容 sha256** 命中即取（导出过的图、生成的图往往就是同一份字节）
//
//  落盘铁律
//    · 目标路径 = `<objects-root>/<sha 前 2 位>/<sha256>`（与 DSH 自身布局一致）
//    · 写同目录临时文件 → 校验 sha256 → rename 原子落位 → 重读二次校验
//    · 已存在且 sha 一致 ⇒ skip（幂等）；已存在但**内容不符** ⇒ 报 conflict，不覆盖（除非 --force）
//    · 退出码：0 = 全部就位 · 3 = 有未找到源的缺失 · 4 = 有失败（写盘/校验） · 2 = 用法错
// ============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolveDshHome, resolveDshWorkspace } from './lib/dsh-home.mjs'
import {
  resolveObjectsRoot,
  resolveSessionRoots,
  resolveRelayDirs,
  resolveLocalSources,
  resolveReportDir,
  describeResolution,
  formatResolution,
  reportFileName,
} from './lib/attach-config.mjs'
import {
  normalizeSha,
  objectPathFor,
  sha256Bytes,
} from './lib/attach-refs.mjs'
import { collectAudit } from './attachments-audit.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.resolve(fileURLToPath(import.meta.url))

export function usage() {
  return [
    'usage: node attachments-fetch.mjs (--hash <sha256> | --session <id|prefix> | --all-missing | --probe | --export <dir> | --rollback <report.json>)',
    '                                [--from <path>]... [--relay <dir>]... [--local-source <dir>]... [--no-local-sources]',
    '                                [--home <dir>] [--workspace <dir>] [--objects-root <dir>] [--sessions-root <dir>]...',
    '                                [--cache <file>] [--verify|--no-verify] [--dry-run] [--force] [--json]',
    '                                [--report <file>] [--quiet] [--print-config]',
    '',
    '  按 sha256 取回缺失的图片附件对象（落 <objects-root>/<sha 前 2 位>/<sha256>）。',
    '  退出码 0=就位 / 3=有缺失（未找到源） / 4=有失败 / 2=用法错',
    '  路径解析优先级：CLI > 环境变量（DSH_HOME / DSH_WORKSPACE / ATTACH_OBJECTS_ROOT /',
    '                 ATTACH_SESSION_ROOTS / ATTACH_RELAY_DIRS / ATTACH_LOCAL_SOURCES）> 默认。',
  ].join('\n')
}

export function parseFetchArgs(argv) {
  const o = {
    hashes: [], session: null, allMissing: false, probe: false, exportDir: null, rollback: null,
    from: [], relay: [], localSources: [], noLocalSources: false, home: null, workspace: null,
    objectsRoot: null, sessionsRoots: [], printConfig: false, cache: null,
    verify: true, dryRun: false, force: false, json: false, report: null, quiet: false,
    help: false, errors: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) { o.errors.push(`缺少参数值: ${a}`); return null }
      return v
    }
    if (a === '--hash') { const v = next(); if (v) o.hashes.push(...v.split(',').map((s) => s.trim()).filter(Boolean)) }
    else if (a === '--session') o.session = next()
    else if (a === '--all-missing') o.allMissing = true
    else if (a === '--probe') o.probe = true
    else if (a === '--export') o.exportDir = next()
    else if (a === '--rollback') o.rollback = next()
    else if (a === '--from') { const v = next(); if (v) o.from.push(v) }
    else if (a === '--relay') { const v = next(); if (v) o.relay.push(v) }
    else if (a === '--local-source') { const v = next(); if (v) o.localSources.push(v) }
    else if (a === '--no-local-sources') o.noLocalSources = true
    else if (a === '--home') o.home = next()
    else if (a === '--workspace') o.workspace = next()
    else if (a === '--objects-root') o.objectsRoot = next()
    else if (a === '--sessions-root') { const v = next(); if (v) o.sessionsRoots.push(v) }
    else if (a === '--cache') o.cache = next()
    else if (a === '--verify') o.verify = true
    else if (a === '--no-verify') o.verify = false
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--force') o.force = true
    else if (a === '--json') o.json = true
    else if (a === '--report') o.report = next()
    else if (a === '--quiet') o.quiet = true
    else if (a === '--print-config') o.printConfig = true
    else if (a === '--help' || a === '-h') o.help = true
    else o.errors.push(`未知参数: ${a}`)
  }
  return o
}

/**
 * 本机派生源目录（按内容 sha 命中）。默认值来自配置层，可用 `--local-source` /
 * `$ATTACH_LOCAL_SOURCES` **追加**，或用 `--no-local-sources` 整体关闭。
 */
export function defaultLocalSources(home, workspace) {
  return resolveLocalSources({ home, workspace }).dirs
}

/** 候选 relay 目录（默认值来自配置层；注入时整体替换）。 */
export function candidateRelays(workspace) {
  return resolveRelayDirs({ workspace }).dirs
}

/** 一个源根下某个 sha 的候选路径（覆盖各种层级布局）。 */
export function objectCandidatesIn(root, sha) {
  const b = sha.slice(0, 2)
  return [
    path.join(root, b, sha),
    path.join(root, 'objects', b, sha),
    path.join(root, 'v1', 'objects', b, sha),
    path.join(root, 'attachments', 'v1', 'objects', b, sha),
    path.join(root, '.dsh', 'attachments', 'v1', 'objects', b, sha),
  ]
}

/** relay 目录下某个 sha 的候选路径（多一层主机名目录）。 */
export function relayCandidatesIn(root, sha) {
  const out = objectCandidatesIn(root, sha)
  let ents = []
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (!e.isDirectory()) continue
    out.push(...objectCandidatesIn(path.join(root, e.name), sha))
  }
  return out
}

function firstExisting(paths) {
  for (const p of paths) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* 继续 */ }
  }
  return null
}

/** 用内容 sha 建索引（本机派生源）；返回 Map<sha, file>。 */
export function buildContentIndex(dirs, wanted = null) {
  const index = new Map()
  const stats = { dirs: [], files: 0, bytes: 0, skippedLinks: 0 }
  const seen = new Set()
  for (const dir of dirs) {
    let real
    try { real = fs.realpathSync(dir) } catch { continue }
    if (seen.has(real.toLowerCase())) continue
    seen.add(real.toLowerCase())
    let count = 0
    const stack = [dir]
    while (stack.length) {
      const cur = stack.pop()
      let ents = []
      try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = path.join(cur, e.name)
        let st
        try { st = fs.lstatSync(p) } catch { continue }
        if (st.isSymbolicLink()) { stats.skippedLinks++; continue }
        if (st.isDirectory()) { stack.push(p); continue }
        if (!st.isFile()) continue
        stats.files++
        stats.bytes += st.size
        count++
        let buf
        try { buf = fs.readFileSync(p) } catch { continue }
        const sha = sha256Bytes(buf)
        if (wanted === null || wanted.has(sha)) index.set(sha, p)
      }
    }
    stats.dirs.push({ dir, real, files: count })
  }
  return { index, stats }
}

/** 原子落盘：写同目录 tmp → rename → 校验。 */
function writeObject(objectsRoot, sha, bytes) {
  const target = objectPathFor(objectsRoot, sha)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    fs.writeFileSync(tmp, bytes)
    const got = sha256Bytes(fs.readFileSync(tmp))
    if (got !== sha) throw new Error(`临时文件校验失败（${got.slice(0, 16)}… ≠ ${sha.slice(0, 16)}…）`)
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原始错误 */ }
    throw e
  }
  const final = fs.readFileSync(target)
  const got2 = sha256Bytes(final)
  if (got2 !== sha) throw new Error(`落盘后校验失败（${got2.slice(0, 16)}… ≠ ${sha.slice(0, 16)}…）`)
  return { target, bytes: final.length }
}

function readObjectSha(file) {
  try { return sha256Bytes(fs.readFileSync(file)) } catch { return null }
}

export function main(argv = process.argv.slice(2)) {
  const o = parseFetchArgs(argv)
  if (o.help) { process.stdout.write(usage() + '\n'); return 0 }
  if (o.errors.length > 0) { process.stderr.write(o.errors.join('\n') + '\n' + usage() + '\n'); return 2 }
  if (o.printConfig) {
    process.stdout.write(formatResolution(describeResolution({
      home: o.home, workspace: o.workspace, objectsRoot: o.objectsRoot,
      sessionsRoots: o.sessionsRoots, relays: o.relay, localSources: o.localSources, reportDir: o.report,
    })) + '\n')
    return 0
  }

  const home = resolveDshHome(o.home)
  const workspace = resolveDshWorkspace(o.workspace)
  const objectsRoot = resolveObjectsRoot({ home, cli: o.objectsRoot }).value
  // 对账口径与本文件的路径注入保持一致（别让 --objects-root 只作用于一半流程）
  const auditOpts = (extra = {}) => ({
    home, objectsRoot, sessionsRoots: o.sessionsRoots, cache: o.cache, quiet: true, ...extra,
  })

  // ---- 回滚模式（只按清单删文件，绝不递归删目录）
  if (o.rollback) {
    const rp = path.resolve(o.rollback)
    let rep
    try { rep = JSON.parse(fs.readFileSync(rp, 'utf8')) } catch (e) {
      process.stderr.write(`attachments-fetch: 读不到报告 ${rp}: ${e?.message ?? e}\n`)
      return 2
    }
    const targets = (rep.fetched ?? []).map((f) => f.target).filter((p) => typeof p === 'string')
    let removed = 0, missing = 0, failed = 0
    for (const p of targets) {
      try { fs.rmSync(p); removed++ } catch (e) {
        if (e?.code === 'ENOENT') missing++
        else { failed++; process.stderr.write(`  !! 删除失败 ${p}: ${e?.message ?? e}\n`) }
      }
    }
    const out = { rollbackOf: rp, removed, missing, failed, targets: targets.length }
    process.stdout.write((o.json ? JSON.stringify(out, null, 2) : `回滚：删 ${removed} / 缺 ${missing} / 失败 ${failed}（清单 ${targets.length} 条）`) + '\n')
    return failed > 0 ? 4 : 0
  }

  // ---- 导出模式（本机 → 中转目录）
  if (o.exportDir) {
    const outDir = path.resolve(o.exportDir)
    const audit = collectAudit(auditOpts())
    if (!audit.ok) { process.stderr.write(`attachments-fetch: ${audit.reason}\n`); return audit.code }
    const shas = new Set()
    for (const m of audit.summary.missing) shas.add(m.sha)
    // 导出「被引用的全部对象」= 缺失 ∪ 已在位；缺失的用于提示对端也无源
    for (const sha of collectReferencedShas(auditOpts())) shas.add(sha)
    const manifest = { kind: 'dsh-attachments-relay', host: os.hostname(), createdAt: new Date().toISOString(), objects: [] }
    let copied = 0, absent = 0
    for (const sha of shas) {
      const src = objectPathFor(objectsRoot, sha)
      if (!fs.existsSync(src)) { absent++; manifest.objects.push({ sha, present: false }); continue }
      const dst = path.join(outDir, 'objects', sha.slice(0, 2), sha)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      if (!o.dryRun) fs.copyFileSync(src, dst)
      copied++
      manifest.objects.push({ sha, present: true, bytes: fs.statSync(src).size })
    }
    if (!o.dryRun) {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    }
    const line = `导出：${copied} 个对象 → ${outDir}${o.dryRun ? '（dry-run，未写盘）' : ''}；本机也没有的 ${absent} 个`
    process.stdout.write((o.json ? JSON.stringify({ exportDir: outDir, copied, absent, dryRun: o.dryRun, manifest }, null, 2) : line) + '\n')
    return 0
  }

  // ---- 目标集合
  const targets = []
  const targetReasons = new Map()
  let auditSummary = null
  if (o.hashes.length > 0) {
    for (const h of o.hashes) {
      const sha = normalizeSha(h)
      if (!sha) { process.stderr.write(`attachments-fetch: 非法 hash: ${h}\n`); return 2 }
      if (!targets.includes(sha)) targets.push(sha)
    }
  }
  if (o.session || o.allMissing || (o.probe && targets.length === 0)) {
    const audit = collectAudit(auditOpts({ session: o.session ?? null }))
    if (!audit.ok) { process.stderr.write(`attachments-fetch: ${audit.reason}\n`); return audit.code }
    auditSummary = audit.summary
    for (const m of audit.summary.missing) if (!targets.includes(m.sha)) targets.push(m.sha)
  }
  // 无论走哪条路径，都记录「谁引用它」（报告里有用）
  if (auditSummary === null && targets.length > 0) {
    const audit = collectAudit(auditOpts())
    if (audit.ok) {
      auditSummary = audit.summary
      for (const m of audit.summary.missing) targetReasons.set(m.sha, m.sessions)
    }
  } else if (auditSummary) {
    for (const m of auditSummary.missing) targetReasons.set(m.sha, m.sessions)
  }

  const localDirs = o.noLocalSources
    ? []
    : [...resolveLocalSources({ home, workspace, cli: o.localSources }).dirs]
  const explicitSources = o.from.map((p) => path.resolve(p))
  const relayResolved = resolveRelayDirs({ workspace, cli: o.relay })
  const relayDirs = relayResolved.requireExists
    ? relayResolved.dirs.filter((d) => fs.existsSync(d))
    : relayResolved.dirs

  // ---- probe
  if (o.probe) {
    const wanted = new Set(targets)
    const report = {
      dshHome: home, objectsRoot, workspace,
      targets: targets.length,
      explicit: [], relay: [], local: [], coverage: null,
    }
    for (const s of explicitSources) {
      const roots = [s, path.join(s, 'objects'), path.join(s, 'v1', 'objects'), path.join(s, 'attachments', 'v1', 'objects')]
      const probeRoot = roots.find((r) => { try { return fs.statSync(r).isDirectory() } catch { return false } }) ?? null
      let hit = 0
      if (probeRoot) for (const sha of targets) if (firstExisting(objectCandidatesIn(s, sha))) hit++
      report.explicit.push({ path: s, usableRoot: probeRoot, hit, targets: targets.length, exists: fs.existsSync(s) })
    }
    for (const r of relayDirs) {
      let hit = 0
      for (const sha of targets) if (firstExisting(relayCandidatesIn(r, sha))) hit++
      report.relay.push({ path: r, hit, targets: targets.length })
    }
    if (!o.noLocalSources) {
      const { index, stats } = buildContentIndex(localDirs, wanted)
      let hit = 0
      for (const sha of targets) if (index.has(sha)) hit++
      report.local = stats.dirs.map((d) => ({ dir: d.dir, files: d.files }))
      report.coverage = { files: stats.files, bytes: stats.bytes, hit, targets: targets.length, indexSize: index.size }
    }
    if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    else {
      const l = []
      l.push('attachments 取回源探测（只读）')
      l.push(`  目标缺失对象    ${targets.length}`)
      l.push(`  显式 --from     ${report.explicit.length} 个`)
      for (const e of report.explicit) l.push(`    ${e.exists ? '✓' : '✗'} ${e.path}  → 可用根 ${e.usableRoot ?? '(无 objects 布局)'} · 命中 ${e.hit}/${e.targets}`)
      l.push(`  中转 relay      ${report.relay.length} 个`)
      for (const e of report.relay) l.push(`    ✓ ${e.path} · 命中 ${e.hit}/${e.targets}`)
      if (o.noLocalSources) l.push('  本机派生源      已用 --no-local-sources 关闭')
      else {
        l.push(`  本机派生源      ${report.local.length} 个目录 / ${report.coverage?.files ?? 0} 文件 / ${((report.coverage?.bytes ?? 0) / 1048576).toFixed(0)} MB`)
        for (const d of report.local) l.push(`    · ${d.dir}（${d.files} 文件）`)
        l.push(`    ⇒ 按内容命中 ${report.coverage?.hit ?? 0}/${targets.length}`)
      }
      if (explicitSources.length === 0 && relayDirs.length === 0) {
        l.push('')
        l.push('  ⚠ 没有可用的「跨机源」：附件实体通常**不进**配置/会话备份仓（太大），')
        l.push('    所以换机后需要自己带一份。可用的形态 =')
        l.push('      ① --from <对端 attachments 路径>（对端磁盘 / 移动盘在场时）')
        l.push('      ② --relay <中转目录>（先在对端 `--export` 导出到介质，再插到本机取回）')
        l.push('      ③ 本机派生源（导出过的图、生成过的图，按内容 sha 命中即可自愈，无需介质）')
      }
      process.stdout.write(l.join('\n') + '\n')
    }
    return 0
  }

  if (targets.length === 0) {
    // --json 时即使没目标也输出结构化报告（机器消费口径一致：counts 全 0 + reason）
    const empty = {
      kind: 'attachments-fetch', host: os.hostname(), at: new Date().toISOString(),
      dshHome: home, objectsRoot, dryRun: o.dryRun, verify: o.verify, force: o.force,
      targets: 0, reason: 'nothing-missing',
      requested: { hashes: o.hashes.length, session: o.session, allMissing: o.allMissing },
      sources: { explicit: explicitSources, relay: relayDirs, local: o.noLocalSources ? [] : localDirs },
      fetched: [], skipped: [], conflicts: [], missing: [], failed: [],
      counts: { fetched: 0, skipped: 0, conflicts: 0, missing: 0, failed: 0 },
    }
    if (o.json) process.stdout.write(JSON.stringify(empty, null, 2) + '\n')
    else process.stdout.write('attachments-fetch: 没有需要取回的对象（本机被引用的附件都在位 ✅）\n')
    return 0
  }

  // ---- 取回
  const fetched = [], skipped = [], conflicts = [], missing = [], failed = []
  let localIndex = null
  const ensureLocalIndex = () => {
    if (localIndex !== null || o.noLocalSources) return localIndex
    const wanted = new Set(targets)
    localIndex = buildContentIndex(localDirs, wanted).index
    return localIndex
  }

  for (const sha of targets) {
    const target = objectPathFor(objectsRoot, sha)
    const existsNow = fs.existsSync(target)
    if (existsNow) {
      const got = o.verify ? readObjectSha(target) : sha
      if (got === sha) { skipped.push({ sha, target, reason: 'already-present' }); continue }
      conflicts.push({ sha, target, actual: got })
      if (!o.force) continue
    }
    let srcPath = null
    let srcKind = null
    for (const s of explicitSources) {
      const hit = firstExisting(objectCandidatesIn(s, sha))
      if (hit) { srcPath = hit; srcKind = `from:${s}`; break }
    }
    if (!srcPath) {
      for (const r of relayDirs) {
        const hit = firstExisting(relayCandidatesIn(r, sha))
        if (hit) { srcPath = hit; srcKind = `relay:${r}`; break }
      }
    }
    if (!srcPath) {
      const idx = ensureLocalIndex()
      const hit = idx?.get(sha)
      if (hit) { srcPath = hit; srcKind = 'local-derived' }
    }
    if (!srcPath) { missing.push({ sha, target, sessions: targetReasons.get(sha) ?? [] }); continue }

    let bytes
    try { bytes = fs.readFileSync(srcPath) } catch (e) {
      failed.push({ sha, source: srcPath, reason: `读源失败: ${e?.message ?? e}` }); continue
    }
    const srcSha = sha256Bytes(bytes)
    if (o.verify && srcSha !== sha) {
      failed.push({ sha, source: srcPath, reason: `源内容 sha 不符（${srcSha.slice(0, 16)}…）` }); continue
    }
    if (o.dryRun) { fetched.push({ sha, source: srcPath, sourceKind: srcKind, target, bytes: bytes.length, dryRun: true }); continue }
    try {
      const w = writeObject(objectsRoot, sha, bytes)
      fetched.push({ sha, source: srcPath, sourceKind: srcKind, target: w.target, bytes: w.bytes })
    } catch (e) {
      failed.push({ sha, source: srcPath, reason: `写盘失败: ${e?.message ?? e}` })
    }
  }

  const reportPath = o.report
    ? path.resolve(o.report)
    : path.join(resolveReportDir({ workspace }).value, reportFileName())
  const report = {
    kind: 'attachments-fetch', host: os.hostname(), at: new Date().toISOString(),
    dshHome: home, objectsRoot, dryRun: o.dryRun, verify: o.verify, force: o.force,
    targets: targets.length,
    requested: { hashes: o.hashes.length, session: o.session, allMissing: o.allMissing },
    sources: { explicit: explicitSources, relay: relayDirs, local: o.noLocalSources ? [] : localDirs },
    fetched, skipped, conflicts, missing, failed,
    counts: { fetched: fetched.length, skipped: skipped.length, conflicts: conflicts.length, missing: missing.length, failed: failed.length },
    rollbackHint: `node ${path.join(HERE, 'attachments-fetch.mjs')} --rollback "${reportPath}"`,
  }
  if (!o.dryRun) {
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true })
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    } catch (e) { process.stderr.write(`  !! 报告写入失败 ${reportPath}: ${e?.message ?? e}\n`) }
  }

  if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else if (!o.quiet) {
    const l = []
    l.push(`attachments 取回${o.dryRun ? '（dry-run，未写盘）' : ''}：目标 ${targets.length}`)
    l.push(`  取回 ${fetched.length} · 已在位 ${skipped.length} · 未找到源 ${missing.length} · 冲突 ${conflicts.length} · 失败 ${failed.length}`)
    for (const f of fetched.slice(0, 10)) l.push(`    ✓ ${f.sha.slice(0, 16)}…  ← ${f.sourceKind} ${f.source}`)
    if (fetched.length > 10) l.push(`    … 另 ${fetched.length - 10} 个`)
    for (const m of missing.slice(0, 10)) l.push(`    ✗ 无源 ${m.sha.slice(0, 16)}…${m.sessions?.length ? `（${m.sessions.length} 个会话引用）` : ''}`)
    for (const c of conflicts.slice(0, 5)) l.push(`    ! 冲突 ${c.sha.slice(0, 16)}… 目标已有其它内容（需 --force）`)
    for (const f of failed.slice(0, 5)) l.push(`    !! ${f.sha.slice(0, 16)}… ${f.reason}`)
    if (!o.dryRun) {
      l.push(`  报告 ${reportPath}`)
      l.push(`  回滚 ${report.rollbackHint}`)
    }
    process.stdout.write(l.join('\n') + '\n')
  }
  if (failed.length > 0) return 4
  if (missing.length > 0) return 3
  return 0
}

/** 本机会话引用到的全部 sha（导出模式用；口径 = audit 的 referencedShas，别另数）。 */
function collectReferencedShas(auditOpts) {
  const out = new Set()
  const audit = collectAudit(auditOpts)
  if (!audit.ok) return out
  for (const sha of audit.summary.referencedShas ?? []) out.add(sha)
  for (const m of audit.summary.missing) out.add(m.sha)
  return out
}

// 入口守卫：目录链接（junction）下 import.meta.url 会解析成物理路径、argv[1] 是逻辑路径
//   ⇒ 必须 realpath 两侧后再比，否则脚本会静默什么都不做。
function isMain() {
  const arg = process.argv[1]
  if (!arg) return false
  try { return fs.realpathSync(arg) === fs.realpathSync(SELF) } catch { return false }
}

if (isMain()) {
  try {
    process.exitCode = main()
  } catch (e) {
    process.stderr.write(`attachments-fetch: 内部错误 ${e?.stack ?? e}\n`)
    process.exitCode = 4
  }
}
