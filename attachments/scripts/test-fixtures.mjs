#!/usr/bin/env node
// scripts/test-fixtures.mjs —— 干净夹具验证（**不碰任何真实 DSH 数据**）
//
// 全部输入都是本脚本现造的假 home / 假会话 / 假对象树，落在**系统临时目录**里的固定路径
// （固定 + 幂等复用，避免反复重建）。所有子进程调用都显式传 `--home` / `--cache` / `--report`，
// 并对夹具根做「路径自证」断言 —— 保证不可能落到真实 home 上。
//
// 覆盖：
//   ① 缺对象能报出（多帧会话、归档树、受影响会话归并）
//   ② 会话过滤 / `--quiet` / 缓存命中
//   ③ 取回：中转源 → 本机派生源 → 归零（退出码 3 → 0）
//   ④ `--rollback` 只删它自己写的清单（**指纹前后对照**）
//   ⑤ `--dry-run` 不写盘（指纹不变、无报告文件）
//   ⑥ 退出码：4 = 环境不可用（fail-closed）· 2 = 用法错
//   ⑦ 冲突：目标已有别的内容 ⇒ 报 conflict 不覆盖；`--force` 才覆盖
//   ⑧ 注入通道：`--objects-root` / `--sessions-root` / `--cache`
//   ⑨ `--export` → `--relay` 往返（中转包可被读回）
//   ⑩ `--probe` 只读（指纹不变）
//
// 用法：
//   node scripts/test-fixtures.mjs            # 重建夹具并跑全部断言
//   node scripts/test-fixtures.mjs --clean    # 先删掉夹具再重建
// 退出码：0 = 断言全过；1 = 有失败项。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sha256Bytes } from '../lib/attach-refs.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(path.join(HERE, '..'))
const FX = path.join(os.tmpdir(), 'attach-tools-fixture')

// 自证：夹具只允许落在系统临时目录里带特定名字的路径上
if (!FX.toLowerCase().includes('attach-tools-fixture') || !FX.toLowerCase().startsWith(os.tmpdir().toLowerCase())) {
  console.error(`拒绝执行：夹具根不在系统临时目录内（${FX}）`)
  process.exitCode = 1
  throw new Error('unsafe fixture root')
}

// 未捕获异常要给出**能照做的**提示，而不是只丢一段 node 栈 + 版本号
// （实测踩点：安全软件占用夹具目录时 `rmSync` 抛 EPERM，表现为「莫名退出码 1」）
process.on('uncaughtException', (e) => {
  console.error(`\n[夹具脚本] 未捕获异常：${e?.stack ?? e}`)
  console.error(`夹具根：${FX}`)
  console.error('处理：稍后重跑；若仍失败，手工删除该目录后再跑 —— node scripts/test-fixtures.mjs --clean')
  process.exitCode = 1
})

// `--clean` = 连夹具根本身一起删掉重建；默认只清内容（根目录不重建，见 resetFixtureRoot 的说明）
if (process.argv.includes('--clean')) {
  try {
    fs.rmSync(FX, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })
    console.log(`[i] --clean：已删除夹具根 ${FX}`)
  } catch (e) {
    console.error(`[夹具脚本] --clean 删除失败（${e?.message ?? e}）—— 跳过删除，改用「只清内容」模式继续`)
  }
}

let pass = 0, fail = 0, skip = 0
const check = (name, ok, detail = '') => {
  if (ok) pass += 1
  else fail += 1
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
}
const skipCheck = (name, reason) => { skip += 1; console.log('[SKIP] ' + name + ' :: ' + reason) }

// ---------------------------------------------------------------- 材料

const HOME = path.join(FX, 'home')
const OTHER_HOME = path.join(FX, 'other-home')
const EMPTY_HOME = path.join(FX, 'empty-home')
const RELAY = path.join(FX, 'relay')
const LOCALSRC = path.join(FX, 'local')
const CACHE = path.join(FX, 'cache', 'scan.json')
const REPORT = path.join(FX, 'report.json')
const WS = path.join(FX, 'workspace')

const CONTENT_PRESENT = Buffer.from('fixture: an object that is already in place\n')
const CONTENT_M1 = Buffer.from('fixture: object available from the relay\n')
const CONTENT_M2 = Buffer.from('fixture: object available only from local derived data\n')
const shaPresent = sha256Bytes(CONTENT_PRESENT)
const shaM1 = sha256Bytes(CONTENT_M1)
const shaM2 = sha256Bytes(CONTENT_M2)

// uuid 形态一律**现拼**（源码里不留可被误认为内部编号的字面量）
const GUID_A = ['a'.repeat(8), '0000', '4000', '8000', '000000000001'].join('-')
const GUID_B = ['b'.repeat(8), '0000', '4000', '8000', '000000000002'].join('-')

const evImage = (sha, extra = {}) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + sha, mediaType: 'image/png', name: 'shot.png', bytes: 64, width: 8, height: 8 } }],
  ...extra,
})
const frames = (objs) => Buffer.concat(objs.map((o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n', 'utf8'))))

const writeSession = (root, guid, objs) => {
  const dir = path.join(root, guid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), frames(objs))
}
const writeObject = (objectsRoot, sha, bytes) => {
  const p = path.join(objectsRoot, sha.slice(0, 2), sha)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, bytes)
  return p
}

const OBJECTS = path.join(HOME, 'attachments', 'v1', 'objects')

/**
 * 删除文件/目录 —— **必须带重试**。
 * Windows 上删刚跑完的夹具目录会偶发 `EPERM`/`EBUSY`：安全软件可能正在扫描这些新文件、或上一个子进程
 * 的句柄还没释放；裸 `fs.rmSync` 会抛未捕获异常，表现为「脚本莫名退出码 1 + 只打印 node 版本号」。
 * ⚠️ 这条是实测踩出来的（同一命令在 09:56 成功、09:59 失败），不是防御性写法。
 */
function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })
  } catch (e) {
    throw new Error(`清理夹具失败（${target}）：${e?.message ?? e} —— 多半是安全软件正在扫描该目录，稍后重跑即可`)
  }
}

/**
 * 清空夹具根**的内容**但保留根本身：根目录 inode 不变 ⇒ 更不容易被占用，
 * 也避免反复删除/重建整个目录触发安全软件反复弹窗。
 */
function resetFixtureRoot() {
  fs.mkdirSync(FX, { recursive: true })
  for (const entry of fs.readdirSync(FX)) rmrf(path.join(FX, entry))
}

function buildFixture({ withObjects = true } = {}) {
  resetFixtureRoot()
  fs.mkdirSync(OBJECTS, { recursive: true })
  fs.mkdirSync(EMPTY_HOME, { recursive: true })
  fs.mkdirSync(OTHER_HOME, { recursive: true })
  fs.mkdirSync(WS, { recursive: true })
  if (withObjects) {
    writeObject(OBJECTS, shaPresent, CONTENT_PRESENT)
    writeSession(path.join(HOME, 'sessions'), GUID_A, [evImage(shaPresent), evImage(shaM1)])
    writeSession(path.join(HOME, '_archived-sessions'), GUID_B, [evImage(shaM2)])
    // 取回源：中转目录（objects 布局）
    writeObject(path.join(RELAY, 'objects'), shaM1, CONTENT_M1)
    // 本机派生源：按内容 sha 命中（目录名任意，工具按内容建索引）
    fs.mkdirSync(path.join(LOCALSRC, 'generated'), { recursive: true })
    fs.writeFileSync(path.join(LOCALSRC, 'generated', 'pic-0001.bin'), CONTENT_M2)
  }
}

// ---------------------------------------------------------------- 运行

const baseEnv = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) if (/^(DSH_|ATTACH_)/.test(k)) delete e[k]
  return e
})()

const run = (script, args, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(PKG, script), ...args], {
    encoding: 'utf8', cwd: FX, env: { ...baseEnv, ...env },
  })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const audit = (args = [], env = {}) => run('attachments-audit.mjs', ['--home', HOME, '--cache', CACHE, ...args], env)
const fetchCmd = (args = [], env = {}) => run('attachments-fetch.mjs', ['--home', HOME, '--workspace', WS, '--cache', CACHE, '--report', REPORT, ...args], env)
const jparse = (s) => { try { return JSON.parse(s) } catch { return null } }

/** 目录指纹：**只看文件**（相对路径 + 大小 + 内容 sha256）。
 *  ⚠️ 有意不含目录条目：`--rollback` 只删清单里的文件、**从不删目录**（保守设计），
 *     所以「回滚到原状」的准确判据是**文件集合与内容逐一相同**，允许留下空的顺片目录。 */
function fingerprint(dir) {
  const items = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isDirectory()) { stack.push(p); continue }
      let sha = '?'
      try { sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) } catch { /* ignore */ }
      items.push(`F ${path.relative(dir, p)} ${st.size} ${sha}`)
    }
  }
  return crypto.createHash('sha256').update(items.sort().join('\n')).digest('hex').slice(0, 12)
}

// ================================================================ ① 缺对象能报出

console.log('=== ① 缺对象能报出 ===')
buildFixture()
{
  const r = audit(['--json'])
  const j = jparse(r.out)
  check('① 有缺失 ⇒ 退出码 3', r.code === 3, `exit=${r.code}`)
  check('① JSON 可解析且含缺失清单', !!j && Array.isArray(j.missing), j ? `missing=${j.missing.length}` : r.err.slice(0, 120))
  if (j) {
    const shas = j.missing.map((m) => m.sha).sort()
    check('① 两个缺失对象都被报出（含**第二帧**里的引用 ⇒ 多帧确实逐帧解压了）',
      shas.length === 2 && shas.includes(shaM1) && shas.includes(shaM2), shas.map((s) => s.slice(0, 8)).join(','))
    check('① 受影响会话数 = 2（现役 1 + 归档 1）', j.affectedSessions === 2, String(j.affectedSessions))
    check('① 归档树也被扫到（归档里的历史回合同样会回放）',
      j.affected.some((a) => a.tree === 'archived'), j.affected.map((a) => a.tree).join(','))
    check('① 已在位对象不被误报', !shas.includes(shaPresent))
    check('① 引用计数与对象数一致', j.refsTotal === 3 && j.distinctSha === 3, `refs=${j.refsTotal} distinct=${j.distinctSha}`)
    check('① 缺失体积估算 > 0（取自会话里记录的元数据）', j.missingBytesEstimate > 0, String(j.missingBytesEstimate))
  }
  const t = audit(['--json', '--top', '1'])
  check('① --top 不影响退出码', t.code === 3)
}

// ================================================================ ② 过滤 / quiet / 缓存

console.log('\n=== ② 会话过滤 / --quiet / 缓存 ===')
{
  const r = audit(['--session', GUID_A, '--json'])
  const j = jparse(r.out)
  check('② --session 只算该会话（仅缺 1 个）', r.code === 3 && j?.missingObjects === 1 && j?.affectedSessions === 1,
    `exit=${r.code} missing=${j?.missingObjects} affected=${j?.affectedSessions}`)

  const bad = audit(['--session', 'not-a-guid'])
  check('② --session 传非 guid ⇒ 退出码 2', bad.code === 2, `exit=${bad.code}`)

  const q = audit(['--quiet'])
  check('② --quiet 不输出正文（只留退出码）', q.code === 3 && q.out.trim() === '', `exit=${q.code} out=${JSON.stringify(q.out.slice(0, 40))}`)

  const first = audit(['--json'])                       // 写缓存
  const second = audit(['--json'])                      // 读缓存
  const j1 = jparse(first.out), j2 = jparse(second.out)
  check('② 缓存命中：结论一致（同一数字）',
    j1 && j2 && j1.missingObjects === j2.missingObjects && j1.refsTotal === j2.refsTotal,
    `first=${j1?.missingObjects}/${j1?.cache?.scanned} second=${j2?.missingObjects}/${j2?.cache?.scanned}`)
  check('② 缓存命中：第二次整库复用（scanned=0 且 reused>0）', j2?.cache?.scanned === 0 && j2?.cache?.reused > 0,
    `scanned=${j2?.cache?.scanned} reused=${j2?.cache?.reused}`)
  const noCache = audit(['--json', '--no-cache'])
  check('② --no-cache：强制全量重扫且结论不变', jparse(noCache.out)?.cache?.scanned > 0 && noCache.code === 3)

  const thr = run('attachments-audit.mjs', ['--home', HOME, '--sessions-only', '--json'])
  const jt = jparse(thr.out)
  check('② --sessions-only：只扫现役树（缺 1 个，归档不参与）', jt?.missingObjects === 1 && jt?.affectedSessions === 1,
    `missing=${jt?.missingObjects} affected=${jt?.affectedSessions}`)

  const cacheExists = fs.existsSync(CACHE)
  check('② 缓存文件写在指定位置（--cache 生效）', cacheExists, CACHE)
}

// ================================================================ ③ 取回 → 归零

console.log('\n=== ③ 取回（中转源 → 本机派生源）→ 归零 ===')
{
  buildFixture()
  // 显式源通道（--from）：dry-run 下先看计划，确认来源标注
  const r0 = fetchCmd(['--all-missing', '--from', RELAY, '--local-source', LOCALSRC, '--dry-run', '--json'])
  check('③ --from 显式源通道可用（计划里标注来源）',
    jparse(r0.out)?.fetched?.some((f) => String(f.sourceKind).startsWith('from:')),
    JSON.stringify(jparse(r0.out)?.fetched?.map((f) => f.sourceKind)))

  const r1 = fetchCmd(['--all-missing', '--relay', RELAY, '--json'])
  const j1 = jparse(r1.out)
  check('③ 中转源取回 1 个 / 另 1 个无源 ⇒ 退出码 3',
    r1.code === 3 && j1?.counts?.fetched === 1 && j1?.counts?.missing === 1,
    `exit=${r1.code} fetched=${j1?.counts?.fetched} missing=${j1?.counts?.missing}`)
  check('③ 取回来源标注为中转目录（relay: 前缀）', String(j1?.fetched?.[0]?.sourceKind ?? '').startsWith('relay:'), j1?.fetched?.[0]?.sourceKind ?? '')
  check('③ 落盘路径符合 `<objects-root>/<前2位>/<sha>`',
    j1?.fetched?.[0]?.target === path.join(OBJECTS, shaM1.slice(0, 2), shaM1), j1?.fetched?.[0]?.target ?? '')
  check('③ 报告文件已写（含回滚提示）', !!j1?.rollbackHint && fs.existsSync(REPORT))

  const r2 = fetchCmd(['--all-missing', '--from', RELAY, '--local-source', LOCALSRC, '--json'])
  const j2 = jparse(r2.out)
  check('③ 本机派生源按**内容 sha** 命中补齐最后一个 ⇒ 退出码 0',
    r2.code === 0 && j2?.counts?.fetched === 1 && j2?.fetched?.[0]?.sourceKind === 'local-derived',
    `exit=${r2.code} fetched=${j2?.counts?.fetched} kind=${j2?.fetched?.[0]?.sourceKind}`)

  const a = audit(['--json'])
  const ja = jparse(a.out)
  check('③ 补齐后对账归零（退出码 0 / 缺失 0 / 受影响 0）',
    a.code === 0 && ja?.missingObjects === 0 && ja?.affectedSessions === 0,
    `exit=${a.code} missing=${ja?.missingObjects} affected=${ja?.affectedSessions}`)

  const idem = fetchCmd(['--all-missing', '--json'])
  check('③ 再跑取回：幂等（已在位 skip，不重复写）', jparse(idem.out)?.counts?.skipped === 3 || jparse(idem.out)?.reason === 'nothing-missing',
    JSON.stringify(jparse(idem.out)?.counts ?? jparse(idem.out)?.reason))
}

// ================================================================ ④ rollback 指纹对照

console.log('\n=== ④ --rollback 只删它自己写的清单 ===')
{
  buildFixture()
  const fpBefore = fingerprint(HOME)
  const listingBefore = listFiles(HOME)

  const r1 = fetchCmd(['--all-missing', '--from', RELAY, '--local-source', LOCALSRC, '--json'])
  check('④ 补齐两个对象（写盘）', r1.code === 0 && jparse(r1.out)?.counts?.fetched === 2, `exit=${r1.code}`)
  const fpAfterFetch = fingerprint(HOME)
  check('④ 写盘后指纹确实变了（说明指纹对照有效）', fpAfterFetch !== fpBefore, `${fpBefore} → ${fpAfterFetch}`)

  const rb = fetchCmd(['--rollback', REPORT, '--json'])
  const jr = jparse(rb.out)
  check('④ 回滚成功且无失败', rb.code === 0 && jr?.failed === 0, `exit=${rb.code} failed=${jr?.failed}`)
  check('④ 回滚只删它写的那 2 个（removed=2）', jr?.removed === 2, `removed=${jr?.removed} missing=${jr?.missing}`)

  const fpAfterRb = fingerprint(HOME)
  check('④ **指纹前后对照**：回滚后文件集合与内容与补齐前逐一相同', fpAfterRb === fpBefore, `${fpAfterRb} vs ${fpBefore}`)
  const listingAfter = listFiles(HOME)
  const filesBefore = listingBefore.filter((p) => p.startsWith('F '))
  const filesAfter = listingAfter.filter((p) => p.startsWith('F '))
  check('④ 原有文件一个不少（含已在位对象与会话文件）',
    filesBefore.every((p) => filesAfter.includes(p)) && filesAfter.length === filesBefore.length,
    `before=${filesBefore.length} after=${filesAfter.length}`)
  const added = listingAfter.filter((p) => !listingBefore.includes(p))
  check('④ 回滚不留下任何新文件（只可能留下空的分片目录）',
    added.every((p) => p.startsWith('D ') && fs.readdirSync(path.join(HOME, p.slice(2))).length === 0),
    added.length ? added.join(' | ') : '(无新增条目)')

  // 回滚清单只含 fetched[].target，且不递归删目录
  const rep = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
  check('④ 清单条目 = 本次新写文件（不含 skip / 已有对象）',
    rep.fetched.length === 2 && rep.skipped.every((s) => s.reason === 'already-present'),
    `fetched=${rep.fetched.length} skipped=${rep.skipped.length}`)
  check('④ 回滚后目标目录仍在（只删文件、不删目录）',
    fs.existsSync(path.join(OBJECTS, shaM1.slice(0, 2))), path.join(OBJECTS, shaM1.slice(0, 2)))
}

// ================================================================ ⑤ dry-run 不写盘

console.log('\n=== ⑤ --dry-run 不写盘 ===')
{
  buildFixture()
  const fpBefore = fingerprint(HOME)
  const r = fetchCmd(['--all-missing', '--from', RELAY, '--local-source', LOCALSRC, '--dry-run', '--json'])
  const j = jparse(r.out)
  check('⑤ dry-run 报告里标了 dryRun 且列出计划写入的对象',
    j?.dryRun === true && j?.counts?.fetched === 2, `dryRun=${j?.dryRun} fetched=${j?.counts?.fetched}`)
  check('⑤ dry-run 后 home 指纹不变（一个字节都没写）', fingerprint(HOME) === fpBefore, fingerprint(HOME))
  check('⑤ dry-run 不写报告文件', !fs.existsSync(REPORT))
}

// ================================================================ ⑥ 退出码 4 / 2

console.log('\n=== ⑥ 退出码：4 = 环境不可用 · 2 = 用法错 ===')
{
  const r4 = run('attachments-audit.mjs', ['--home', EMPTY_HOME, '--cache', CACHE])
  check('⑥ 读不到会话目录 ⇒ 退出码 4（fail-closed：读不到 ≠ 没缺失）', r4.code === 4, `exit=${r4.code}`)
  check('⑥ 退出码 4 时 stderr 有原因说明', /找不到会话目录|attachments-audit/.test(r4.err), r4.err.split('\n')[0])

  const f4 = run('attachments-fetch.mjs', ['--home', EMPTY_HOME, '--all-missing'])
  check('⑥ 取回侧同样 fail-closed（退出码 4）', f4.code === 4, `exit=${f4.code}`)

  check('⑥ 未知参数 ⇒ 退出码 2', audit(['--nope']).code === 2)
  check('⑥ 缺参数值 ⇒ 退出码 2', audit(['--home']).code === 2)
  const badHash = fetchCmd(['--hash', 'zzz'])
  check('⑥ 非法 hash ⇒ 退出码 2', badHash.code === 2, `exit=${badHash.code}`)
  const rb = fetchCmd(['--rollback', path.join(FX, 'no-such-report.json')])
  check('⑥ 回滚指向不存在的报告 ⇒ 退出码 2', rb.code === 2, `exit=${rb.code}`)

  const help = run('attachments-audit.mjs', ['--help'])
  check('⑥ --help ⇒ 退出码 0 且打印用法', help.code === 0 && help.out.includes('usage:'), `exit=${help.code}`)
  const pc = run('attachments-audit.mjs', ['--home', HOME, '--print-config'])
  check('⑥ --print-config ⇒ 退出码 0 且带来源标注', pc.code === 0 && pc.out.includes('←'), `exit=${pc.code}`)
}

// ================================================================ ⑦ 冲突 / --force

console.log('\n=== ⑦ 冲突：不覆盖已有内容 ===')
{
  buildFixture()
  const bogus = Buffer.from('fixture: WRONG bytes under the right name\n')
  const conflictPath = writeObject(OBJECTS, shaM1, bogus)
  const r1 = fetchCmd(['--hash', shaM1, '--from', RELAY, '--json'])
  const j1 = jparse(r1.out)
  check('⑦ 目标已有内容不符 ⇒ 报 conflict', j1?.counts?.conflicts === 1, `conflicts=${j1?.counts?.conflicts}`)
  check('⑦ conflict 时**不覆盖**（字节未变）', fs.readFileSync(conflictPath).equals(bogus))
  check('⑦ conflict 不计入失败（退出码 0）', r1.code === 0, `exit=${r1.code}`)

  const r2 = fetchCmd(['--hash', shaM1, '--from', RELAY, '--force', '--json'])
  check('⑦ --force 才覆盖，且覆盖后内容正确',
    r2.code === 0 && jparse(r2.out)?.counts?.fetched === 1 && fs.readFileSync(conflictPath).equals(CONTENT_M1),
    `exit=${r2.code} fetched=${jparse(r2.out)?.counts?.fetched}`)

  const r3 = fetchCmd(['--hash', shaPresent, '--from', RELAY, '--json'])
  check('⑦ 已存在且内容一致 ⇒ skip（幂等）', jparse(r3.out)?.counts?.skipped === 1, `skipped=${jparse(r3.out)?.counts?.skipped}`)
  const r4 = fetchCmd(['--hash', shaM2, '--no-local-sources', '--json'])
  check('⑦ --no-local-sources 关掉派生源 ⇒ 无源可补（退出码 3）', r4.code === 3, `exit=${r4.code}`)
}

// ================================================================ ⑧ 注入通道

console.log('\n=== ⑧ 注入通道：--objects-root / --sessions-root / --cache ===')
{
  buildFixture()
  // 把对象根指到别处（模拟「对象在另一个位置」）：缺失数应回到 2
  const altObjects = path.join(OTHER_HOME, 'objects')
  fs.mkdirSync(path.join(altObjects, shaPresent.slice(0, 2)), { recursive: true })
  fs.writeFileSync(path.join(altObjects, shaPresent.slice(0, 2), shaPresent), CONTENT_PRESENT)
  const r = run('attachments-audit.mjs', ['--home', HOME, '--objects-root', altObjects, '--cache', CACHE, '--json'])
  const j = jparse(r.out)
  check('⑧ --objects-root 生效（换成只有 1 个对象的根 ⇒ 缺 2 个）',
    j?.missingObjects === 2 && j?.objectsRoot === path.resolve(altObjects), `missing=${j?.missingObjects}`)

  const r2 = run('attachments-audit.mjs', ['--home', HOME, '--sessions-root', path.join(HOME, 'sessions'), '--cache', CACHE, '--json'])
  const j2 = jparse(r2.out)
  check('⑧ --sessions-root 生效（只扫指定树 ⇒ 缺 1 个，归档不参与）',
    j2?.missingObjects === 1 && j2?.affectedSessions === 1, `missing=${j2?.missingObjects}`)

  const altCache = path.join(FX, 'cache', 'alt.json')
  const r3 = run('attachments-audit.mjs', ['--home', HOME, '--cache', altCache, '--json'])
  check('⑧ --cache 生效（缓存落到指定文件）', r3.code === 3 && fs.existsSync(altCache), altCache)

  // 默认缓存位置（不传 --cache）：落在 home 下
  const freshHome = path.join(FX, 'default-cache-home')
  fs.mkdirSync(path.join(freshHome, 'sessions'), { recursive: true })
  const r4 = run('attachments-audit.mjs', ['--home', freshHome])
  check('⑧ 默认缓存 = <home>/attach-scan-cache.json',
    r4.code === 0 && fs.existsSync(path.join(freshHome, 'attach-scan-cache.json')), `exit=${r4.code}`)

  // 环境变量通道（ATTACH_OBJECTS_ROOT / ATTACH_SESSION_ROOTS）
  const envHome = path.join(FX, 'env-home')
  fs.mkdirSync(path.join(envHome, 'sessions', GUID_A), { recursive: true })
  fs.copyFileSync(path.join(HOME, 'sessions', GUID_A, 'session.jsonl.zstd'), path.join(envHome, 'sessions', GUID_A, 'session.jsonl.zstd'))
  fs.mkdirSync(path.join(envHome, 'attachments'), { recursive: true })
  const r5 = run('attachments-audit.mjs', ['--home', envHome, '--cache', CACHE, '--json'], {
    ATTACH_OBJECTS_ROOT: OBJECTS, ATTACH_SESSION_ROOTS: path.join(envHome, 'sessions'),
  })
  const j5 = jparse(r5.out)
  check('⑧ 环境变量通道生效（ATTACH_OBJECTS_ROOT + ATTACH_SESSION_ROOTS）',
    j5?.objectsRoot === path.resolve(OBJECTS) && j5?.missingObjects === 1, `objectsRoot=${j5?.objectsRoot} missing=${j5?.missingObjects}`)
}

// ================================================================ ⑨ export → relay 往返

console.log('\n=== ⑨ --export → --relay 往返 ===')
{
  buildFixture()
  const exportDir = path.join(FX, 'exported')
  const r1 = fetchCmd(['--export', exportDir, '--json'])
  const j1 = jparse(r1.out)
  check('⑨ 导出成功且写出 manifest', r1.code === 0 && fs.existsSync(path.join(exportDir, 'manifest.json')),
    `exit=${r1.code} copied=${j1?.copied}`)
  check('⑨ 导出清单区分「在位」与「本机也没有」',
    Array.isArray(j1?.manifest?.objects) && j1.manifest.objects.some((o) => o.present === true) && j1.manifest.objects.some((o) => o.present === false),
    `objects=${j1?.manifest?.objects?.length}`)

  // 用一个全新的 home，从导出包按 relay 取回
  const home2 = path.join(FX, 'home2')
  fs.mkdirSync(path.join(home2, 'sessions'), { recursive: true })
  fs.cpSync(path.join(HOME, 'sessions'), path.join(home2, 'sessions'), { recursive: true })
  const r2 = run('attachments-fetch.mjs', ['--home', home2, '--workspace', WS, '--all-missing', '--relay', exportDir, '--no-local-sources', '--report', path.join(FX, 'report2.json'), '--json'])
  const j2 = jparse(r2.out)
  check('⑨ 从导出包按 relay 取回（在位对象被带过来）',
    j2?.fetched?.some((f) => f.sha === shaPresent && f.sourceKind.startsWith('relay:')),
    `fetched=${j2?.counts?.fetched} missing=${j2?.counts?.missing}`)

  const r3 = run('attachments-audit.mjs', ['--home', home2, '--cache', path.join(FX, 'cache', 'h2.json'), '--json'])
  check('⑨ 新 home 取回后仅剩「导出包里也没有」的那个（缺 1）', jparse(r3.out)?.missingObjects === 1, `missing=${jparse(r3.out)?.missingObjects}`)
}

// ================================================================ ⑩ probe 只读

console.log('\n=== ⑩ --probe 只读 ===')
{
  buildFixture()
  const fpBefore = fingerprint(HOME)
  const r = fetchCmd(['--probe', '--from', RELAY, '--json'])
  const j = jparse(r.out)
  check('⑩ probe 退出码 0 且列出源与覆盖率', r.code === 0 && Array.isArray(j?.explicit) && j?.coverage !== null, `exit=${r.code}`)
  check('⑩ probe 报出显式源的命中数', j?.explicit?.[0]?.hit === 1 && j?.explicit?.[0]?.targets === 2,
    `hit=${j?.explicit?.[0]?.hit}/${j?.explicit?.[0]?.targets}`)
  check('⑩ probe 后指纹不变（只读）', fingerprint(HOME) === fpBefore, fingerprint(HOME))
  const txt = fetchCmd(['--probe', '--from', RELAY])
  check('⑩ probe 人读输出含「只读」声明', txt.out.includes('只读'), txt.out.split('\n')[0])
}

// ================================================================

function listFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isDirectory()) { out.push('D ' + path.relative(dir, p)); stack.push(p) }
      else out.push('F ' + path.relative(dir, p))
    }
  }
  return out.sort()
}

// 收尾清理：失败也不影响断言结论（不让清理问题把「全过」变成失败）
for (const p of [REPORT, path.join(FX, 'report2.json')]) {
  try { rmrf(p) } catch { /* 收尾清理失败不改判定 */ }
}

console.log(`\n结果：断言 ${fail === 0 ? '全过' : fail + ' 项失败'}（通过 ${pass} / 失败 ${fail}）｜SKIP ${skip} 项｜夹具保留在 ${FX}（--clean 可重建）`)
process.exitCode = fail === 0 ? 0 : 1
