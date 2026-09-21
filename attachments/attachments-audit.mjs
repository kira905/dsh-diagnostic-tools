#!/usr/bin/env node
// ============================================================
//  attachments-audit.mjs — 会话引用的图片附件 vs 本机实体 · 只读对账
//  ------------------------------------------------------------
//  治什么病：从另一台机器同步过来的「含图会话」在本机续聊必挂，报的却是
//    `<上游服务> stream from … failed` / code=TRANSPORT
//    —— 看起来像网络故障，其实是历史图片实体（`attachments/v1/objects/<前2位>/<sha256>`）
//    **不在本机**：每轮请求在准备图片时会扫**全部历史消息**里的图，读不到实体就抛一个
//    普通错误（不是传输层错误），被上层兜底 catch 归成了 TRANSPORT。
//    于是「缺文件」被误判成「网络抖动」，按网络排障永远修不好。
//
//  本脚本只做一件事：把「缺哪些对象 / 哪些会话受影响」变成**看得见的事实**。
//
//  用法（全部只读，除自身缓存外不写任何文件）：
//    node attachments-audit.mjs                       # 全量对账（默认带缓存）
//    node attachments-audit.mjs --json                # 机器可读
//    node attachments-audit.mjs --session <id|前缀>   # 只看一个会话
//    node attachments-audit.mjs --quiet               # 只出退出码（给开机/交接挂点）
//    node attachments-audit.mjs --no-cache            # 忽略缓存全量重扫
//    node attachments-audit.mjs --top 30              # 摘要里最多列几个会话
//    node attachments-audit.mjs --print-config        # 只看路径解析结果（排查用）
//  退出码：0 = 无缺失 · 3 = 有缺失 · 2 = 用法错 · 4 = 环境不可用（读不到会话/附件根）
//          ⚠️ 4 是 fail-closed：**读不到 ≠ 没缺失**，别把 4 当 0 用
//
//  缓存：`<home>/attach-scan-cache.json`（单机状态，键 = 相对路径 + size + mtimeMs）。
//    首次全量耗时与你的会话总量成正比，缓存命中后通常一秒内返回。
//    ⚠️ mtime 会被「复制/搬动整个目录」骗过 ⇒ 键里**同时含 size**，且 `--no-cache` 可强制全量重扫。
//  本文件的 `collectAudit()` 是 attachments-fetch.mjs 的**同一口径来源**，别在那边另写一套。
// ============================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './lib/dsh-home.mjs'
import {
  resolveObjectsRoot,
  resolveSessionRoots,
  resolveCacheFile,
  describeResolution,
  formatResolution,
} from './lib/attach-config.mjs'
import {
  collectSessionRefs,
  decodeSessionBuffer,
  listSessionFiles,
  normalizeSessionId,
  objectPathFor,
  SESSION_TREES_DEFAULT,
  sha256File,
} from './lib/attach-refs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.resolve(fileURLToPath(import.meta.url))
const CACHE_VERSION = 2

export function usage() {
  return [
    'usage: node attachments-audit.mjs [--home <dir>] [--session <id|prefix>] [--json] [--quiet]',
    '                                   [--no-cache] [--cache <file>] [--top <n>] [--sessions-only]',
    '                                   [--verify-objects] [--objects-root <dir>]',
    '                                   [--sessions-root <dir>]... [--print-config]',
    '',
    '  只读对账：会话引用的 sha256 vs 本机 <objects-root> 下的实体。',
    '  退出码 0=无缺失 / 3=有缺失 / 2=用法错 / 4=环境不可用（读不到 ≠ 无缺失）',
    '  路径解析优先级：CLI > 环境变量（DSH_HOME / ATTACH_OBJECTS_ROOT / ATTACH_SESSION_ROOTS /',
    '                 ATTACH_SCAN_CACHE）> 自动探测 > 默认。--print-config 可查看本次实际取值。',
  ].join('\n')
}

export function parseAuditArgs(argv) {
  const o = {
    home: null, session: null, json: false, quiet: false, noCache: false,
    cache: null, top: 20, sessionsOnly: false, verifyObjects: false,
    objectsRoot: null, sessionsRoots: [], printConfig: false, help: false, errors: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) { o.errors.push(`缺少参数值: ${a}`); return null }
      return v
    }
    if (a === '--home') o.home = next()
    else if (a === '--session') o.session = next()
    else if (a === '--cache') o.cache = next()
    else if (a === '--objects-root') o.objectsRoot = next()
    else if (a === '--sessions-root') { const v = next(); if (v) o.sessionsRoots.push(v) }
    else if (a === '--top') o.top = Number(next() ?? NaN)
    else if (a === '--json') o.json = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--no-cache') o.noCache = true
    else if (a === '--sessions-only') o.sessionsOnly = true
    else if (a === '--verify-objects') o.verifyObjects = true
    else if (a === '--print-config') o.printConfig = true
    else if (a === '--help' || a === '-h') o.help = true
    else o.errors.push(`未知参数: ${a}`)
  }
  if (!Number.isFinite(o.top) || o.top < 1) o.top = 20
  return o
}

function readCache(cacheFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    if (raw?.version !== CACHE_VERSION || typeof raw.entries !== 'object') return null
    return raw
  } catch { return null }
}

function writeCacheAtomic(cacheFile, data) {
  const tmp = `${cacheFile}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
    fs.renameSync(tmp, cacheFile)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 缓存写失败不影响对账结论 */ }
  }
}

function scanSession(file, home) {
  const buf = fs.readFileSync(file)
  const dec = decodeSessionBuffer(buf)
  const { refs } = collectSessionRefs(dec.text)
  return {
    rel: path.relative(home, file),
    bytes: buf.length,
    frames: dec.frames,
    badFrames: dec.badFrames,
    shas: [...refs.keys()],
    meta: refs,
  }
}

function countFiles(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) n++
    }
  }
  return n
}

/**
 * 执行一次对账（只读；除缓存外不写文件）。
 * @param {object} o 解析后的参数（见 parseAuditArgs）
 * @param {(msg:string)=>void} [logErr] 局部错误输出（默认 stderr）
 * @returns {{ok:boolean, reason?:string, summary?:object, cacheFile:string, code:number}}
 */
export function collectAudit(o, logErr = (m) => process.stderr.write(m)) {
  const home = resolveDshHome(o.home)
  const objectsRoot = resolveObjectsRoot({ home, cli: o.objectsRoot }).value
  const cacheFile = resolveCacheFile({ home, cli: o.cache }).value
  const trees = resolveSessionRoots({ home, cli: o.sessionsRoots ?? [] })
    .roots.filter((t) => !(o.sessionsOnly && t.name !== 'sessions'))
  if (trees.length === 0) {
    return {
      ok: false, code: 4, cacheFile,
      reason: `找不到会话目录（查找位置: ${SESSION_TREES_DEFAULT.map((n) => path.join(home, n)).join(' | ')}）`
        + '；可用 --sessions-root 或 $ATTACH_SESSION_ROOTS 指定',
    }
  }
  const target = o.session ? normalizeSessionId(o.session) : null
  if (o.session && target === null) {
    return { ok: false, code: 2, cacheFile, reason: `--session 需要会话 id（guid）或含 guid 的路径: ${o.session}` }
  }

  const cache = o.noCache ? null : readCache(cacheFile)
  const cacheEntries = {}
  const results = []
  let scanned = 0, reused = 0, decodeFailures = 0, scanMs = 0
  for (const tree of trees) {
    for (const file of listSessionFiles(tree.dir)) {
      const rel = path.relative(home, file)
      if (target !== null && !rel.toLowerCase().includes(target)) continue
      let st
      try { st = fs.statSync(file) } catch { continue }
      const prev = cache?.entries?.[rel]
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && Array.isArray(prev.shas)) {
        reused++
        cacheEntries[rel] = prev
        // 缓存里带上 ref 元数据（bytes/mediaType/name）：缺失对象的体积估算只能从这里来
        //   —— 对象本身不在盘上，无法 stat（v2 起；v1 缓存无此字段 ⇒ 版本门整库失效）
        results.push({
          rel, bytes: st.size, frames: prev.frames ?? 0, badFrames: 0, shas: prev.shas,
          meta: new Map(Object.entries(prev.meta ?? {}).map(([sha, m]) => [sha, { sha, count: 1, sample: m }])),
        })
        continue
      }
      const t0 = Date.now()
      let r
      try { r = scanSession(file, home) } catch (e) {
        decodeFailures++
        logErr(`  !! 读取失败 ${rel}: ${e?.message ?? e}\n`)
        continue
      }
      scanMs += Date.now() - t0
      scanned++
      cacheEntries[rel] = {
        size: st.size, mtimeMs: st.mtimeMs, frames: r.frames, shas: r.shas,
        meta: Object.fromEntries([...r.meta].map(([sha, rec]) => [sha, {
          bytes: rec.sample?.bytes ?? 0,
          mediaType: rec.sample?.mediaType ?? null,
          name: rec.sample?.name ?? null,
          width: rec.sample?.width ?? null,
          height: rec.sample?.height ?? null,
        }])),
      }
      results.push(r)
    }
  }
  if (target === null && !o.noCache) {
    writeCacheAtomic(cacheFile, {
      version: CACHE_VERSION, host: os.hostname(), updatedAt: new Date().toISOString(),
      home, entries: cacheEntries,
    })
  }

  const exists = new Map()
  const checkExists = (sha) => {
    let v = exists.get(sha)
    if (v === undefined) { v = fs.existsSync(objectPathFor(objectsRoot, sha)); exists.set(sha, v) }
    return v
  }
  const corrupt = []
  const bySession = []
  const missingMap = new Map()
  let refsTotal = 0, withImages = 0
  for (const r of results) {
    if (r.shas.length === 0) continue
    withImages++
    const miss = []
    for (const sha of r.shas) {
      refsTotal++
      if (checkExists(sha)) continue
      miss.push(sha)
      let rec = missingMap.get(sha)
      if (!rec) { rec = { sha, refs: 0, sessions: [], sample: r.meta.get(sha)?.sample ?? null }; missingMap.set(sha, rec) }
      rec.refs += r.meta.get(sha)?.count ?? 1
      rec.sessions.push(r.rel)
    }
    if (miss.length > 0) {
      bySession.push({
        rel: r.rel,
        tree: r.rel.startsWith('_archived-sessions') ? 'archived' : 'sessions',
        missing: miss,
      })
    }
  }
  let presentObjects = 0
  for (const v of exists.values()) if (v) presentObjects++
  if (o.verifyObjects) {
    for (const [sha, ok] of exists) {
      if (!ok) continue
      try { if (sha256File(objectPathFor(objectsRoot, sha)) !== sha) corrupt.push(sha) } catch { corrupt.push(sha) }
    }
  }

  const missingBytes = [...missingMap.values()].reduce((n, m) => n + (m.sample?.bytes ?? 0), 0)
  const summary = {
    dshHome: home,
    host: os.hostname(),
    objectsRoot,
    objectFiles: fs.existsSync(objectsRoot) ? countFiles(objectsRoot) : 0,
    sessionFiles: results.length,
    sessionsWithImages: withImages,
    refsTotal,
    distinctSha: exists.size,
    presentObjects,
    missingObjects: missingMap.size,
    missingBytesEstimate: missingBytes,
    affectedSessions: bySession.length,
    corruptObjects: corrupt.length,
    decodeFailures,
    referencedShas: [...exists.keys()].sort(),
    cache: { file: o.noCache ? null : cacheFile, reused, scanned, scanMs, cacheHit: reused > 0 && scanned === 0 },
    generatedAt: new Date().toISOString(),
    missing: [...missingMap.values()].map((m) => ({
      sha: m.sha, refs: m.refs, sessionCount: m.sessions.length,
      sessions: m.sessions.slice(0, 20), sample: m.sample,
    })).sort((a, b) => b.sessionCount - a.sessionCount || b.refs - a.refs),
    affected: bySession.sort((a, b) => b.missing.length - a.missing.length),
  }
  return { ok: true, code: summary.missingObjects > 0 ? 3 : 0, summary, cacheFile, objectsRoot, home }
}

/** 人读摘要（`--quiet` 时不调用）。 */
export function formatAudit(summary, { top = 20 } = {}) {
  const lines = []
  lines.push('attachments 对账（只读）')
  lines.push(`  DSH_HOME        ${summary.dshHome}`)
  lines.push(`  会话文件        ${summary.sessionFiles}（含图 ${summary.sessionsWithImages}）· 解压重扫 ${summary.cache.scanned} / 缓存复用 ${summary.cache.reused}${summary.cache.scanMs ? ` · 扫描 ${(summary.cache.scanMs / 1000).toFixed(1)}s` : ''}`)
  lines.push(`  引用            ${summary.refsTotal} 次（会话×对象）/ ${summary.distinctSha} 个不同对象`)
  lines.push(`  本机 objects    ${summary.objectFiles} 个文件`)
  const flag = summary.missingObjects > 0 ? '⚠ ' : 'OK '
  lines.push(`  ${flag}缺失对象      ${summary.missingObjects}（约 ${(summary.missingBytesEstimate / 1048576).toFixed(2)} MB）· 受影响会话 ${summary.affectedSessions}`)
  if (summary.corruptObjects) lines.push(`  ⚠ 内容与文件名不符的对象 ${summary.corruptObjects}（--verify-objects）`)
  if (summary.decodeFailures) lines.push(`  ⚠ 读取失败的会话文件 ${summary.decodeFailures}（见 stderr）`)
  if (summary.affectedSessions > 0) {
    lines.push('  受影响会话（缺失数降序）：')
    for (const s of summary.affected.slice(0, top)) lines.push(`    ${String(s.missing.length).padStart(3)} 个  ${s.rel}`)
    if (summary.affected.length > top) lines.push(`    … 另 ${summary.affected.length - top} 个（--top 调大）`)
    lines.push('')
    lines.push(`  补齐命令：node ${path.join(HERE, 'attachments-fetch.mjs')} --all-missing`)
    lines.push(`            node ${path.join(HERE, 'attachments-fetch.mjs')} --session <会话id>   # 只补一个会话`)
    lines.push(`            node ${path.join(HERE, 'attachments-fetch.mjs')} --probe            # 先看有哪些可用的取回源`)
  } else {
    lines.push('  未发现缺失：本机所有被引用的附件实体都在位 ✅')
  }
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2)) {
  const o = parseAuditArgs(argv)
  if (o.help) { process.stdout.write(usage() + '\n'); return 0 }
  if (o.errors.length > 0) { process.stderr.write(o.errors.join('\n') + '\n' + usage() + '\n'); return 2 }
  if (o.printConfig) {
    process.stdout.write(formatResolution(describeResolution({
      home: o.home, objectsRoot: o.objectsRoot, sessionsRoots: o.sessionsRoots, cache: o.cache,
    })) + '\n')
    return 0
  }
  const r = collectAudit(o)
  if (!r.ok) {
    process.stderr.write(`attachments-audit: ${r.reason}\n`)
    if (r.code === 4) process.stderr.write('  ⇒ 退出码 4（读不到 ≠ 无缺失）\n')
    return r.code
  }
  if (o.json) process.stdout.write(JSON.stringify(r.summary, null, 2) + '\n')
  else if (!o.quiet) process.stdout.write(formatAudit(r.summary, { top: o.top }) + '\n')
  return r.code
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
    process.stderr.write(`attachments-audit: 内部错误 ${e?.stack ?? e}\n`)
    process.exitCode = 4
  }
}
