// ============================================================
//  attach-refs.mjs — 会话附件引用 / 附件对象 的共享口径库
//  ------------------------------------------------------------
//  为什么需要独立一层：`attachments-audit.mjs`（只读对账）与 `attachments-fetch.mjs`
//  （按需取回）必须用**同一套口径**回答「会话引用了哪些对象」「对象该落在哪」——
//  各写一套必然漂移，而漂移的后果是「补齐了却还是报错」。
//
//  口径来源（与 DSH 主程序自身的布局一致）：
//    · 对象实体路径 `<home>/attachments/v1/objects/<sha256 前 2 位>/<sha256>`
//    · 对象 id 形态   `^sha256:[a-f0-9]{64}$`（强制小写十六进制）
//    · 会话文件       `<home>/sessions/**_/session.jsonl.zstd`（**多帧 zstd 拼接**、
//                     append-only；必须逐帧解压 —— 只解第一帧会把非空会话当成空会话）
//    · 引用形态       事件 JSON 里的 `{type:"image", attachment:{attachmentId:"sha256:…"}}`，
//                     且工具结果里也会嵌图 ⇒ **递归收集**，不能只看第一层
//
//  只读库：本文件不做任何写操作。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

/** zstd 帧魔数（多帧拼接文件的切帧依据）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话文件名。 */
export const SESSION_FILE_NAME = 'session.jsonl.zstd'

/** 默认会话树名（现役 + 物理归档）。可用 `--sessions-root` / `$ATTACH_SESSION_ROOTS` 整体替换。 */
export const SESSION_TREES_DEFAULT = ['sessions', '_archived-sessions']

/** 附件 id 严格形态。 */
const ATTACHMENT_ID_RE = /^sha256:([a-f0-9]{64})$/

/** 宽松扫描用（在文本里找 sha 引用；文件名与目录名都是小写）。 */
const SHA_IN_TEXT_RE = /sha256:([a-f0-9]{64})/g

/** 是否为合法 sha256 十六进制（小写）。 */
export function isSha256(v) {
  return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
}

/** 归一化用户输入的 hash：接受裸 sha / `sha256:<sha>` / 大写。返回 null 表示非法。 */
export function normalizeSha(input) {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase().replace(/^sha256:/, '')
  return isSha256(s) ? s : null
}

/** 附件实体路径（唯一口径，别在调用方另拼）。 */
export function objectPathFor(objectsRoot, sha) {
  return path.join(objectsRoot, sha.slice(0, 2), sha)
}

/** 附件对象根（由 home 推出）。 */
export function objectsRootFor(home) {
  return path.join(home, 'attachments', 'v1', 'objects')
}

/** 附件根（对账/临时目录的同级）。 */
export function attachmentsRootFor(home) {
  return path.join(home, 'attachments', 'v1')
}

/** 文件 sha256（小写十六进制）。 */
export function sha256File(file) {
  const buf = fs.readFileSync(file)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 字节 sha256。 */
export function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ---------------------------------------------------------------- 会话帧解析

/**
 * 把多帧 zstd 拼接缓冲切成帧。
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
export function splitFrames(buf) {
  const starts = []
  let i = 0
  while (i >= 0 && i < buf.length) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 4
  }
  return starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length))
}

/**
 * 逐帧解压会话缓冲。
 * ⚠️ 只解第一帧会把完整会话误判成空会话（追加写入的文件有多帧）。
 * @param {Buffer} buf
 * @returns {{text:string, frames:number, badFrames:number, bytes:number}}
 */
export function decodeSessionBuffer(buf) {
  const frames = splitFrames(buf)
  const parts = []
  let badFrames = 0
  for (const f of frames) {
    try { parts.push(zlib.zstdDecompressSync(f)) } catch { badFrames++ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, badFrames, bytes: buf.length }
}

/** 读文件并解码（IO 版）。 */
export function decodeSessionFile(file) {
  return decodeSessionBuffer(fs.readFileSync(file))
}

/**
 * 递归收集一个会话事件里的附件引用（`attachmentId` 字段，任意深度；工具结果内容里的图也在内）。
 * @param {unknown} node 已 JSON.parse 的事件
 * @param {Array<{sha:string, ref:object}>} out
 */
export function collectRefsFromEvent(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) collectRefsFromEvent(v, out)
    return
  }
  const id = node.attachmentId
  if (typeof id === 'string') {
    const m = ATTACHMENT_ID_RE.exec(id)
    if (m) out.push({ sha: m[1], ref: node })
  }
  for (const v of Object.values(node)) collectRefsFromEvent(v, out)
}

/**
 * 从会话文本（多行 JSONL）收集全部附件引用（去重后按 sha 归并）。
 * @param {string} text
 * @returns {{refs: Map<string, {sha:string, count:number, sample:object}>, badLines:number, events:number}}
 */
export function collectSessionRefs(text) {
  const refs = new Map()
  let badLines = 0
  let events = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let obj
    try { obj = JSON.parse(line) } catch { badLines++; continue }
    events++
    const found = []
    collectRefsFromEvent(obj, found)
    for (const { sha, ref } of found) {
      let rec = refs.get(sha)
      if (!rec) { rec = { sha, count: 0, sample: ref }; refs.set(sha, rec) }
      rec.count++
    }
  }
  return { refs, badLines, events }
}

/** 文本里出现的 sha256（宽松扫描，用于报告里的摘录）。 */
export function scanShaInText(text) {
  const out = new Set()
  SHA_IN_TEXT_RE.lastIndex = 0
  let m
  while ((m = SHA_IN_TEXT_RE.exec(text)) !== null) out.add(m[1])
  return out
}

// ---------------------------------------------------------------- 会话文件枚举

/**
 * 枚举一棵会话树下的会话文件（**不跟随链接/重解析点** —— 避免被目录链接带出树外）。
 * @param {string} dir
 * @returns {string[]} 绝对路径
 */
export function listSessionFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let ents
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const p = path.join(cur, e.name)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { stack.push(p); continue }
      if (st.isFile() && e.name === SESSION_FILE_NAME) out.push(p)
    }
  }
  return out.sort()
}

/**
 * 枚举本机会话树（现役 + 物理归档）。
 * 归档会话里的图**同样会被历史回合带上**（续聊时整段历史一起回放），
 * 所以对账必须两棵树一起扫 —— 只扫现役会明显低估受影响面。
 * @param {string} home
 * @param {string[]} [names] 会话树名；默认 `SESSION_TREES_DEFAULT`
 * @returns {Array<{name:string, dir:string}>}
 */
export function sessionTrees(home, names = SESSION_TREES_DEFAULT) {
  return names
    .map((name) => ({ name, dir: path.join(home, name) }))
    .filter((t) => fs.existsSync(t.dir))
}

/** 会话目录名/路径 → 归一会话 id（兼容 `session-<guid>` 与裸 `<guid>`）。 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  let n = path.basename(value.trim())
  if (n.startsWith('session-')) n = n.slice('session-'.length)
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(n)
    ? n.toLowerCase()
    : null
}
