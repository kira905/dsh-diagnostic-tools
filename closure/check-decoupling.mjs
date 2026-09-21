#!/usr/bin/env node
/**
 * check-decoupling.mjs —— 自研插件「解耦纪律」检查
 *
 * 为什么存在：
 *   宿主（主包）一升级，**import 了宿主运行时符号**的插件会随之崩，而**只走运行时 ctx API**
 *   的插件天然免疫。本脚本把这条经验固化成硬检查 —— 升级前跑一遍，风险面自动列出，不靠人记。
 *
 * 规则（完整规则表见 README §3）：
 *   - **R1 运行时符号禁用**：禁 `import <宿主包>/*` 的运行时符号，只允许 `import type`
 *   - **R2 依赖面归零**：`dependencies` 应为空；`dsh.client.inject` 尽量为空
 *   - **R3 运行时 API 登记**：用到的 ctx 服务 / 事件名须登记到自己的登记表（**只提示，不判定**）
 *   - **R4 裸宿主事实字面量**：除**宿主适配层**（唯一源 + 派生副本）、测试夹具、注释之外，
 *     包里出现宿主事件名 / ctx 服务名字面量 → 报告条目。默认**只提醒不拦**（`--strict-r4` 才计入退出码）
 *   - **R5 适配层副本一致性**：各包 `lib/host-adapter.*` 副本的 sha 必须等于唯一源
 *     → 不一致 **🔴 且计入退出码**（防"跑着旧副本无人发现"）。**仅在配置了校验器时启用**，
 *     没有适配层机制的项目 R5 显示 ⚪ 跳过、不影响退出码
 *
 * R1 分级：
 *   - 🔴 **hard**：静态 import 运行时符号 / 裸副作用 import → 编译期硬绑定，符号被删即崩
 *   - 🟡 **soft**：动态 `import()` / `require()` / 空绑定导入 → **可在 try/catch 内降级兜底**，
 *     不计入退出码，但需人工确认兜底是否真的存在
 *
 * 覆盖范围：
 *   ① `--root <dir>` 下全部自带 package.json 的目录（自研插件源码）——默认自动探测（见下）
 *   ② profile 实体里的自研包（`--profile-pkgs a,b` / env `DECOUPLING_PROFILE_PKGS`）——
 *      这类包没有源码目录，扫描根够不到，需单独登记；**默认空**（不是所有人都需要）
 *
 * 路径全部可注入（CLI > 环境变量 > 自动探测 > 内置默认）：
 *   扫描根 / profile 名 / profile 的 node_modules / 词表文件 / 适配层唯一源 / 适配层校验器。
 *
 * 用法：
 *   node check-decoupling.mjs                     # 扫描根自动探测，只读、不写文件
 *   node check-decoupling.mjs --print-config      # 打印路径解析结果与来源（排障）
 *   node check-decoupling.mjs --json out.json     # 额外写 JSON 报告（默认不写）
 *   node check-decoupling.mjs --root <dir>        # 指定扫描根
 *   node check-decoupling.mjs --quiet             # 仅一行摘要
 *   node check-decoupling.mjs --help              # 全部参数
 * 退出码：0 = 无 hard 违规且 R5 一致（或跳过）；1 = 存在 hard 违规 / R5 不一致 / （--strict-r4 时）R4 命中；
 *        2 = 用法错误 / 根目录不存在
 *
 * 只读、幂等、零第三方依赖（node >= 18）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome } from './lib/runtime-config.mjs'

export const VERSION = '0.1.0'

/** 本文件所在目录（realpath —— 路径里有 junction 时才不会跑偏）。 */
const HERE = (() => {
  try { return path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))) } catch { return path.dirname(fileURLToPath(import.meta.url)) }
})()

/**
 * 扫描根自动探测：cwd 下有 `tools/` 就用 `cwd/tools`，否则用 cwd。
 * 可被 `--root` / `DECOUPLING_SCAN_ROOT` / `DSH_TOOLS_DIR` 覆盖。
 */
function detectScanRoot() {
  const cwd = process.cwd()
  try {
    const tools = path.join(cwd, 'tools')
    if (fs.existsSync(tools) && fs.statSync(tools).isDirectory()) return tools
  } catch { /* ignore */ }
  return cwd
}
const DEFAULT_ROOT = process.env.DECOUPLING_SCAN_ROOT ?? process.env.DSH_TOOLS_DIR ?? detectScanRoot()
/** JSON 报告路径：**默认不写文件**（`--json [path]` 或 `DECOUPLING_JSON` 显式开启）。 */
const DEFAULT_JSON = process.env.DECOUPLING_JSON ?? null
// 自研但**源码只在 profile 实体里**的包（无源码目录）—— 扫描根够不到，需单独登记。
// 默认空：不是所有人都需要这一层；用 `--profile-pkgs a,b` 或 env `DECOUPLING_PROFILE_PKGS` 开启。
const PROFILE_SELF_PKGS = (process.env.DECOUPLING_PROFILE_PKGS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)
// 宿主数据根：口径 `BUTLER_DSH_HOME` > `DSH_HOME` > `~/.dsh`（跨平台）
const PROFILE_NAME = process.env.DECOUPLING_PROFILE ?? 'web'
const PROFILE_NM = process.env.DECOUPLING_PROFILE_ROOT
  ? path.resolve(process.env.DECOUPLING_PROFILE_ROOT)
  : path.join(resolveDshHome(), 'profiles', PROFILE_NAME, 'node_modules')
const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', '_tmp', 'dist', '.cache', 'backups', 'logs'])
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx)$/i

/** `a,b,c` → `['a','b','c']`（去空、去空格）。 */
function splitCsv(v) {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

// ---- 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较 ----
function isMainEntry() {
  try {
    const fromMeta = fs.realpathSync(fileURLToPath(import.meta.url))
    const fromArgv = fs.realpathSync(path.resolve(process.argv[1] ?? ''))
    return fromMeta === fromArgv
  } catch {
    return false
  }
}

// ---- R4：宿主事实字面量（主包事件名 / ctx 服务名）的唯一合法落点 = 宿主适配层 ----

/**
 * 宿主适配层唯一源（R4 词表来源、R5 比对基准）。
 * 默认 = `<扫描根>/lib/host-adapter.mjs`；可用 `DECOUPLING_ADAPTER_SOURCE` / `--adapter-source` 注入。
 * 该文件不存在**不算错误**：R4 退化为只用手册词表，R5 由 `--adapter-verifier` 决定是否启用。
 */
export const HOST_ADAPTER_SOURCE = process.env.DECOUPLING_ADAPTER_SOURCE
  ? path.resolve(process.env.DECOUPLING_ADAPTER_SOURCE)
  : path.join(DEFAULT_ROOT, 'lib', 'host-adapter.mjs')
/** 豁免路径：适配层自身（唯一源 + 副本）/ 测试夹具。 */
const R4_SKIP_PATH = /(^|[\\/])host-adapter\.[cm]?js$|(^|[\\/])_test[\\/]|(^|[\\/])test-[^\\/]*\.mjs$/i
/** 内置 ctx 服务名词表（可用 `--vocab <file>` 的 JSON 覆盖 / 扩充）。 */
const R4_SERVICE_NAMES = [
  'webServer', 'settings', 'commands', 'tools', 'skills', 'sessionTitle',
  'llm', 'sessions', 'systemPrompt', 'apiProxy', 'agents', 'logger',
  'locale', 'slots', 'connection', 'settingsScope', 'remote', 'workspaces',
]
/** 内置事件名词表 —— 适配层词表之外的补充项（同样可被 `--vocab <file>` 覆盖 / 扩充）。 */
const R4_EXTRA_EVENTS = [
  'fs/write-intent', 'fs/edit-intent', 'fs/observed', 'tools/pre-execute',
  'session/event', 'connection/reset',
]

/**
 * 从适配层唯一源提取「宿主事实词表」。
 * ⚠️ **不硬编码事件名** —— 词表跟着唯一源走：适配层加了新事件，R4 自动开始查它。
 */
export function hostVocabulary(file = HOST_ADAPTER_SOURCE, opts = {}) {
  const events = new Set(R4_EXTRA_EVENTS)
  const services = new Set(R4_SERVICE_NAMES)
  // 词表文件（JSON：{ "events": [...], "services": [...] }）——可选，用来描述你自己宿主的词汇
  if (opts.vocabFile) {
    try {
      const j = JSON.parse(fs.readFileSync(opts.vocabFile, 'utf8'))
      for (const e of j.events ?? []) events.add(String(e))
      for (const s of j.services ?? []) services.add(String(s))
    } catch { /* 词表文件不可读/非法 → 并入失效（不影响其他判定） */ }
  }
  try {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/'([a-z][a-z0-9-]*\/[a-z0-9\/-]+)'/g)) events.add(m[1])
  } catch { /* 唯一源缺失 → 只有手册/注入词表，R4 退化为弱检查 */ }
  return { events, services }
}

/**
 * R4：扫单文件的裸字面量。
 * 白名单：①适配层（唯一源 + 各包副本）②测试夹具 ③注释（整行注释 / 行内 `//` 之后）。
 * 匹配口径：
 *   - 事件名：必须**在适配层词表内**且带引号（`'turn/end'`）→ 误报极低；
 *   - 服务名：带引号 **且同行出现 ctx/inject 上下文**（`ctx.get('sessions')` / `inject = ['agents']`）。
 *     ⚠️ 没有上下文约束的话，`path.join('tools', …)`、`'sessions'`（目录名）、字典键会大量误报
 *     ——实测首版 214 处里大半是这类，会让守门器被当噪音忽略（风险 6）。
 * 结果：只认**带引号**的形态；`ctx.webServer.register(...)` 这类属性访问首版不查（D2 过渡期）。
 */
export function scanLiterals(file, vocab) {
  if (R4_SKIP_PATH.test(file)) return []
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return [] }
  const hits = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) continue
    const slash = line.indexOf('//')
    if (slash >= 0) line = line.slice(0, slash) // 行内注释之后不算（URL 里的 `//` 只会让本行少检，不会误报）
    const ctxCtx = /\bctx\b|inject|\.get\(|\.on\(|\.service\(/.test(line)
    for (const m of line.matchAll(/['"`]([a-z][a-z0-9-]*\/[a-z0-9\/-]+)['"`]/g)) {
      if (vocab.events.has(m[1])) hits.push({ line: i + 1, literal: m[1], kind: 'event' })
    }
    if (!ctxCtx) continue
    for (const m of line.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g)) {
      if (vocab.services.has(m[1])) hits.push({ line: i + 1, literal: m[1], kind: 'service' })
    }
  }
  return hits
}

function parseArgs(argv) {
  const o = {
    root: DEFAULT_ROOT, json: DEFAULT_JSON, quiet: false, noJson: false, noProfile: false, noR4: false,
    strictR4: false, help: false, printConfig: false,
    vocabFile: process.env.DECOUPLING_VOCAB ?? null,
    adapterSource: process.env.DECOUPLING_ADAPTER_SOURCE ?? null,
    adapterVerifier: process.env.DECOUPLING_ADAPTER_VERIFIER ?? null,
    profile: PROFILE_NAME, profileRoot: process.env.DECOUPLING_PROFILE_ROOT ?? null, profilePkgs: null,
  }
  const takeValue = (name, i) => {
    const v = argv[i + 1]
    if (v === undefined || String(v).startsWith('--')) return { error: `${name} 缺取值` }
    return { value: v, next: i + 1 }
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root' || a === '--json' || a === '--vocab' || a === '--adapter-source'
      || a === '--adapter-verifier' || a === '--profile' || a === '--profile-root' || a === '--profile-pkgs') {
      const r = takeValue(a, i)
      if (r.error) return { error: r.error }
      i = r.next
      if (a === '--root') o.root = r.value
      else if (a === '--json') o.json = r.value
      else if (a === '--vocab') o.vocabFile = r.value
      else if (a === '--adapter-source') o.adapterSource = r.value
      else if (a === '--adapter-verifier') o.adapterVerifier = r.value
      else if (a === '--profile') o.profile = r.value
      else if (a === '--profile-root') o.profileRoot = r.value
      else o.profilePkgs = r.value
    } else if (a === '--no-json') o.noJson = true
    else if (a === '--no-profile') o.noProfile = true
    else if (a === '--no-r4') o.noR4 = true
    else if (a === '--strict-r4') o.strictR4 = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--print-config') o.printConfig = true
    else if (a === '--help' || a === '-h') o.help = true
    else return { error: `未知参数: ${a}` }
  }
  return o
}

/**
 * 适配层副本校验器解析（R5）：
 * `--adapter-verifier` > `DECOUPLING_ADAPTER_VERIFIER` > 自动探测 `<扫描根>/sync-host-adapter.mjs`。
 * @returns {string|null} 校验器模块路径（模块需导出 `verifySummary()`）
 */
export function resolveAdapterVerifier({ cli, root } = {}) {
  const cands = [cli, process.env.DECOUPLING_ADAPTER_VERIFIER, path.join(root ?? DEFAULT_ROOT, 'sync-host-adapter.mjs'), path.join(HERE, 'sync-host-adapter.mjs')]
  for (const c of cands) {
    if (!c) continue
    try { if (fs.existsSync(c)) return path.resolve(c) } catch { /* ignore */ }
  }
  return null
}

/** 递归收集代码文件（跳过 node_modules 等）。 */
function collectFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collectFiles(full, out, depth + 1)
    } else if (e.isFile() && CODE_EXT.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

/** 从 `{ a, type B as C, d }` 里取绑定名，并返回是否全部为 inline type。 */
function parseBindings(raw) {
  const names = []
  let allType = true
  let any = false
  for (const part of String(raw ?? '').split(',')) {
    const t = part.trim()
    if (!t) continue
    any = true
    const isType = /^type\s/.test(t)
    if (!isType) allType = false
    const name = t.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
    if (name) names.push(name)
  }
  return { names, allType: any && allType }
}

/**
 * 扫描单文件的主包 import 面。
 * 返回 [{ line, module, kind, symbols, runtime, severity }]
 *   runtime=false → 纯类型导入（合规）；severity: 'hard' | 'soft'
 */
export function scanFile(file) {
  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { return [] }
  const hits = []
  // 行号修正（v1.0.2）：静态 import 的正则以 `(^|\n)` 起匹配 → 命中位置常停在**上一行的换行符**上，
  // 旧实现 `slice(0,idx).split('\n').length` 于是少算 1 行（实测 src\index.ts 报 11、实为 12）。
  // 规则：命中点若本身是换行符，则从它的下一字符起算行号。
  const lineOf = (idx) => {
    const start = src.charCodeAt(idx) === 10 ? idx + 1 : idx
    let n = 1
    for (let i = 0; i < start; i++) if (src.charCodeAt(i) === 10) n++
    return n
  }

  // ① import [type] <binding> from '@deepseek-ai/...'
  //    binding 精确列举三种形态（不跨行吞并），避免把多行代码误当符号。
  const IMPORT_RE = /(^|\n)[ \t]*import\s+(type\s+)?(\{[^}\n]*\}|\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+(?:\s*,\s*(?:\{[^}\n]*\}|\*\s+as\s+[A-Za-z0-9_$]+))?)\s+from\s*['"](@deepseek-ai\/[^'"]+)['"]/g
  let m
  while ((m = IMPORT_RE.exec(src))) {
    const isTypeOnly = Boolean(m[2])
    const binding = m[3].trim()
    const mod = m[4]
    const line = lineOf(m.index)
    if (isTypeOnly) {
      hits.push({ line, module: mod, kind: 'import type', symbols: [], runtime: false, severity: 'ok' })
      continue
    }
    const brace = binding.match(/\{([^}\n]*)\}/)
    const bindings = brace ? parseBindings(brace[1]) : { names: [binding.replace(/^\*\s+as\s+/, '')], allType: false }
    const runtime = !bindings.allType
    hits.push({
      line, module: mod,
      kind: brace ? 'import {…}' : (binding.startsWith('*') ? 'import * as' : 'import default'),
      symbols: bindings.names,
      runtime,
      // 绑定了运行时符号 → hard；空绑定（如 `import {} from`）→ soft
      severity: !runtime ? 'ok' : (bindings.names.length ? 'hard' : 'soft'),
    })
  }

  // ② 裸副作用导入：import '@deepseek-ai/...'
  const BARE_RE = /(^|\n)[ \t]*import\s*['"](@deepseek-ai\/[^'"]+)['"]/g
  while ((m = BARE_RE.exec(src))) {
    hits.push({ line: lineOf(m.index), module: m[2], kind: 'import bare', symbols: [], runtime: true, severity: 'hard' })
  }

  // ③ 动态 import('@deepseek-ai/...') / require('@deepseek-ai/...') → soft（可 try/catch 兜底）
  const DYN_RE = /(?:import\s*\(|require\s*\()\s*['"](@deepseek-ai\/[^'"]+)['"]/g
  while ((m = DYN_RE.exec(src))) {
    hits.push({ line: lineOf(m.index), module: m[1], kind: 'dynamic import/require', symbols: [], runtime: true, severity: 'soft' })
  }

  return hits
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 扫描一个自研包目录。scope: 'tools'（源码目录）| 'profile'（仅在 profile 实体） */
export function scanPackage(dir, scope = 'tools', vocab = null) {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (!pkg?.name) return null
  const files = collectFiles(dir)
  const hard = []
  const soft = []
  const r4 = []
  let typed = 0
  const v = vocab ?? hostVocabulary()
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\\/g, '/')
    for (const hit of scanFile(f)) {
      if (!hit.runtime) { typed++; continue }
      const rec = { line: hit.line, module: hit.module, kind: hit.kind, symbols: hit.symbols, file: rel }
      if (hit.severity === 'hard') hard.push(rec)
      else soft.push(rec)
    }
    // R4：裸事件名 / 服务名字面量（首版只提醒；适配层 / 夹具 / 注释已豁免）
    for (const lit of scanLiterals(f, v)) r4.push({ file: rel, ...lit })
  }
  const deps = Object.keys(pkg.dependencies ?? {})
  const inject = Array.isArray(pkg.dsh?.client?.inject) ? pkg.dsh.client.inject : []
  return {
    name: pkg.name,
    version: pkg.version ?? 'n/a',
    dir,
    scope,
    files: files.length,
    hardViolations: hard,
    softViolations: soft,
    typeOnlyImports: typed,
    r4Violations: r4,
    dependencies: deps,
    clientInject: inject,
    verdict: hard.length ? 'R1-HARD' : (soft.length ? 'R1-SOFT' : ((deps.length || inject.length) ? 'R2-NOTE' : 'CLEAN')),
  }
}

export function scanRoot(root, vocab = null) {
  const results = []
  const v = vocab ?? hostVocabulary()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return { error: `根目录不可读: ${root}` } }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
    const dir = path.join(root, e.name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    const r = scanPackage(dir, 'tools', v)
    if (r) results.push(r)
  }
  return { results }
}

/**
 * 扫描 profile 实体里的自研包（没有 tools\ 源码目录的那类）。
 * 缺目录 / 缺 package.json 一律跳过并回报（双机可能未装同一批包），绝不报错中断。
 */
export function scanProfilePackages(names = PROFILE_SELF_PKGS, vocab = null, profileNm = PROFILE_NM) {
  const results = []
  const missing = []
  const v = vocab ?? hostVocabulary()
  for (const name of names) {
    const dir = path.join(profileNm, ...name.split('/'))
    if (!fs.existsSync(path.join(dir, 'package.json'))) { missing.push(name); continue }
    const r = scanPackage(dir, 'profile', v)
    if (r) results.push(r)
    else missing.push(name)
  }
  return { results, missing }
}

const ICON = { 'R1-HARD': '🔴', 'R1-SOFT': '🟡', 'R2-NOTE': '🟡', 'CLEAN': '🟢' }
const ORDER = { 'R1-HARD': 0, 'R1-SOFT': 1, 'R2-NOTE': 2, 'CLEAN': 3 }

function render(results, root, profileMissing = [], extra = {}) {
  const L = []
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  L.push('# 自研插件解耦纪律检查报告')
  L.push('')
  L.push(`生成: ${now}｜脚本 v${VERSION}｜扫描根: \`${root}\`｜包数: ${results.length}`)
  L.push('')
  L.push('> R1 运行时符号禁用（🔴 静态 / 🟡 动态兜底）· R2 依赖面归零 · R3 运行时 API 登记（规则表见 README §3）')
  L.push('> R4 裸宿主事实字面量（🟡 默认只提醒）· R5 适配层副本一致性（🔴 计入退出码；未配置校验器时 ⚪ 跳过）')
  L.push(`> 范围: \`tools\` = \`${root}\` 下自研源码目录；\`profile\` = 只在 profile 实体的自研包（无源码目录，用 \`--profile-pkgs\` 登记）`)
  if (profileMissing.length > 0) L.push(`> ⚠️ profile 侧登记但未找到实体（已跳过）: ${profileMissing.join(', ')}`)
  L.push('')
  L.push('## 总览')
  L.push('')
  L.push('| 自研包 | 范围 | 版本 | R1 静态🔴 | R1 动态🟡 | R2 dependencies | R2 client.inject | 判定 |')
  L.push('|---|---|---|---|---|---|---|---|')
  for (const r of [...results].sort((a, b) => (ORDER[a.verdict] - ORDER[b.verdict]) || a.name.localeCompare(b.name))) {
    L.push(`| \`${r.name}\` | ${r.scope} | ${r.version} | ${r.hardViolations.length} | ${r.softViolations.length} | ${r.dependencies.length ? r.dependencies.join('<br>') : '—'} | ${r.clientInject.length ? r.clientInject.join('<br>') : '—'} | ${ICON[r.verdict]} ${r.verdict} |`)
  }
  L.push('')

  const hard = results.filter((r) => r.hardViolations.length)
  if (hard.length) {
    L.push('## 🔴 R1 静态违规（编译期硬绑定 → 主包删符号时直接崩）')
    L.push('')
    for (const r of hard) {
      L.push(`### \`${r.name}\`@${r.version}`)
      L.push('')
      L.push('| 文件:行 | 模块 | 形式 | 符号 |')
      L.push('|---|---|---|---|')
      for (const v of r.hardViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
        L.push(`| \`${v.file}:${v.line}\` | \`${v.module}\` | ${v.kind} | ${v.symbols.join(', ') || '—'} |`)
      }
      L.push('')
    }
  }

  const soft = results.filter((r) => r.softViolations.length)
  if (soft.length) {
    L.push('## 🟡 R1 动态导入（运行时可 try/catch 降级 → 需人工确认兜底真的存在）')
    L.push('')
    L.push('| 自研包 | 文件:行 | 模块 | 形式 |')
    L.push('|---|---|---|---|')
    for (const r of soft) {
      for (const v of r.softViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
        L.push(`| \`${r.name}\` | \`${v.file}:${v.line}\` | \`${v.module}\` | ${v.kind} |`)
      }
    }
    L.push('')
  }

  L.push('## 结论速览')
  L.push('')
  if (!hard.length && !soft.length) L.push('- 🟢 无 R1 违规：全部自研包符合解耦纪律')
  for (const r of hard) L.push(`- 🔴 \`${r.name}\` 有 ${r.hardViolations.length} 处**静态**运行时 import → 改为 \`import type\`，或集中到单一适配模块（R1 口径见 README §3）`)
  for (const r of soft) L.push(`- 🟡 \`${r.name}\` 有 ${r.softViolations.length} 处动态导入 → 确认调用点有 try/catch 兜底（P5 audit-guard 即此型），否则同 🔴`)
  const notes = results.filter((r) => !r.hardViolations.length && !r.softViolations.length && (r.dependencies.length || r.clientInject.length))
  for (const r of notes) L.push(`- 🟡 \`${r.name}\` 依赖面未归零：deps=[${r.dependencies.join(', ')}] inject=[${r.clientInject.join(', ')}]`)
  const typedTotal = results.reduce((s, r) => s + r.typeOnlyImports, 0)
  L.push(`- ℹ️ 合规类型导入 ${typedTotal} 处（\`import type\` 编译期擦除，不计违规）`)
  L.push('')

  // ---- R4：裸事件名 / 服务名（v1.1.0；首版只提醒不进退出码） ----
  const r4 = extra.r4 ?? { violations: [], count: 0, byPkg: {} }
  L.push('## 🟡 R4 裸事件名 / 服务名（宿主事实字面量）')
  L.push('')
  L.push(`> 唯一合法落点 = **宿主适配层** \`${extra.adapterSource ?? HOST_ADAPTER_SOURCE}\`（各包消费其派生副本）。`)
  L.push('> 白名单：适配层自身（唯一源 + 副本）/ 测试夹具 / 注释。**默认只提醒不拦**（加 `--strict-r4` 才计入退出码）。')
  L.push('')
  if (!r4.count) {
    L.push('- ✅ 无裸字面量：全部自研包已收敛到适配层')
  } else {
    L.push(`- 🟡 共 **${r4.count}** 处，涉及 **${Object.keys(r4.byPkg).length}** 个包：`)
    L.push('')
    L.push('| 自研包 | 文件:行 | 字面量 | 类别 |')
    L.push('|---|---|---|---|')
    for (const v of r4.violations.slice(0, 80)) {
      L.push(`| \`${v.pkg}\` | \`${v.file}:${v.line}\` | \`${v.literal}\` | ${v.kind === 'event' ? '事件名' : 'ctx 服务名'} |`)
    }
    if (r4.count > 80) L.push(`\n_（另有 ${r4.count - 80} 处，见 JSON 明细）_`)
    L.push('')
    L.push('> 处置：把字面量换成适配层语义接口（`isTurnStart` / `has(ctx, 服务名)` …），别在功能代码里留名。')
  }
  L.push('')

  // ---- R5：适配层副本一致性（配置了校验器才计入退出码） ----
  const r5 = extra.r5 ?? { level: 'skipped', note: '未运行', violations: [] }
  L.push('## 🔗 R5 宿主适配层副本一致性')
  L.push('')
  L.push(`- 唯一源：\`${extra.adapterSource ?? HOST_ADAPTER_SOURCE}\`${r5.sha ? `｜sha256 \`${r5.sha}\`` : ''}`)
  L.push(`- ${r5.level === 'ok' ? '✅' : (r5.level === 'skipped' ? '⚪' : '🔴')} 副本状态：${r5.note ?? '不可用'}`)
  for (const v of (r5.violations ?? [])) L.push(`  - 🔴 \`${v.id}\`：${v.status} → \`${v.file}\`（用你们的适配层同步器重新生成该副本）`)
  L.push('')
  L.push('> R5 **在配置了 `--adapter-verifier` 时计入退出码**：副本静默过期 = 跑着旧行为而无人发现，属必须拦住的一类。')
  L.push('> 没有适配层机制的项目可以不管它（R5 显示 ⚪ 跳过，不影响退出码）。')
  L.push('')
  L.push('## R3 提醒')
  L.push('')
  L.push('- 各包用到的 **ctx 服务 / 事件名**须登记到你们自己的登记表（建议每包一节：服务名 / 事件名 / 失效症状 / 复验方式），主包升级时逐条核对')
  L.push('')
  return L.join('\n')
}

function usage() {
  return [
    `usage: check-decoupling.mjs [选项]   (v${VERSION})`,
    '',
    '  自研插件「解耦纪律」检查：R1 运行时 import / R2 依赖面 / R3 登记提醒 / R4 裸字面量 / R5 适配层副本。',
    '  只读、幂等、零第三方依赖（node >= 18）。规则表见 README §3。',
    '',
    `  --root <dir>              扫描根（默认 ${DEFAULT_ROOT}）`,
    '  --json [path]             额外写 JSON 报告（默认不写文件）',
    '  --no-json                 不写 JSON',
    `  --profile <name>          扫 profile 侧包时用哪个 profile（默认 ${PROFILE_NAME}）`,
    '  --profile-root <dir>      直接指定 profile 的 node_modules（默认 <DSH home>/profiles/<profile>/node_modules）',
    '  --profile-pkgs <a,b>      只在 profile 实体里的自研包名（默认空）',
    '  --no-profile              不扫 profile 侧',
    '  --vocab <file>            词表 JSON（{ "events": [...], "services": [...] }）',
    '  --adapter-source <file>   宿主适配层唯一源（R4 词表来源 / R5 基准）',
    '  --adapter-verifier <file> 适配层副本校验器模块（需导出 verifySummary()；给了才跑 R5）',
    '  --no-r4                   关闭 R4',
    '  --strict-r4               R4 也计入退出码（默认只提醒）',
    '  --print-config            打印路径解析结果与来源（排障）',
    '  --quiet                   只打一行摘要',
    '',
    '  退出码: 0=无静态违规且 R5 一致（或跳过）/ 1=有静态违规或 R5 不一致 / 2=用法错误',
  ].join('\n')
}

/**
 * 跑全套检查（R1~R5）—— **导出给面板 / 日报复用**（口径唯一，不复制判定逻辑）。
 * @param {{root?:string, noProfile?:boolean, withR4?:boolean, strictR4?:boolean}} opts
 * @returns {object} 见下方 return；`exitCode` 已含 R5（`strictR4` 时也含 R4）
 */
export function runChecks(opts = {}) {
  const root = opts.root ?? DEFAULT_ROOT
  if (!fs.existsSync(root)) return { error: `根目录不存在: ${root}`, version: VERSION, root }
  const adapterSource = opts.adapterSource ?? HOST_ADAPTER_SOURCE
  const vocab = hostVocabulary(adapterSource, { vocabFile: opts.vocabFile ?? null })
  const { results, error } = scanRoot(root, vocab)
  if (error) return { error, version: VERSION, root }
  const profilePkgs = opts.profilePkgs ?? PROFILE_SELF_PKGS
  const profileNm = opts.profileRoot ? path.resolve(opts.profileRoot) : PROFILE_NM
  let profileMissing = []
  if (opts.noProfile !== true && profilePkgs.length > 0) {
    const pr = scanProfilePackages(profilePkgs, vocab, profileNm)
    results.push(...pr.results)
    profileMissing = pr.missing
  }
  const hardPackages = results.filter((r) => r.hardViolations.length)
  const hardCount = results.reduce((s, r) => s + r.hardViolations.length, 0)
  const softCount = results.reduce((s, r) => s + r.softViolations.length, 0)
  const r2Notes = results
    .filter((r) => !r.hardViolations.length && !r.softViolations.length && (r.dependencies.length || r.clientInject.length))
    .map((r) => ({ name: r.name, deps: r.dependencies, inject: r.clientInject }))
  const rawR4 = opts.withR4 === false ? [] : results.flatMap((r) => (r.r4Violations ?? []).map((v) => ({ pkg: r.name, ...v })))
  const byPkg = {}
  for (const v of rawR4) byPkg[v.pkg] = (byPkg[v.pkg] ?? 0) + 1
  // R5：适配层副本 sha 一致性。判定逻辑**不在本文件复制** —— 由调用方注入校验器函数
  //（CLI 从 `--adapter-verifier` 动态 import 取得），**未注入 = ⚪ 跳过，不计退出码**。
  let r5
  const verifier = typeof opts.adapterVerifier === 'function' ? opts.adapterVerifier : null
  if (!verifier) {
    r5 = { level: 'skipped', total: 0, inSync: 0, violations: [], sha: null, note: '未配置适配层校验器（--adapter-verifier）→ R5 跳过' }
  } else {
    try { r5 = verifier() } catch (e) {
      r5 = { level: 'error', total: 0, inSync: 0, violations: [], sha: null, note: e?.message ?? String(e) }
    }
  }
  const r5Bad = r5.level === 'error'
  const r4Bad = opts.strictR4 === true && rawR4.length > 0
  return {
    version: VERSION,
    root,
    profileNodeModules: profileNm,
    packages: results,
    profileMissing,
    r1: { hardCount, softCount, hardPackages: hardPackages.map((r) => r.name), typeOnlyImports: results.reduce((s, r) => s + r.typeOnlyImports, 0) },
    r2: { notes: r2Notes },
    r4: { violations: rawR4, count: rawR4.length, byPkg, strict: opts.strictR4 === true },
    r5: { ...r5, gate: r5.level !== 'skipped' },
    adapterSource,
    exitCode: (hardCount > 0 || r5Bad || r4Bad) ? 1 : 0,
  }
}

/** 一行摘要（面板 / CLI 共用）。 */
export function summaryLine(res) {
  if (!res || res.error) return `🔴 解耦检查：不可用（${res?.error ?? '未知'}）`
  const r4 = res.r4?.count ?? 0
  const r5 = res.r5 ?? {}
  const icon = res.exitCode ? '🔴' : (r4 ? '🟡' : '✅')
  const pkgs = Object.keys(res.r4?.byPkg ?? {})
  return `${icon} 解耦检查：${res.packages.length} 包｜R1 静态 ${res.r1.hardCount} / 动态 ${res.r1.softCount}`
    + `｜R4 裸字面量 ${r4}${r4 ? `（${pkgs.slice(0, 4).join('、')}${pkgs.length > 4 ? ` 等 ${pkgs.length} 包` : ''}）` : ''}`
    + `｜R5 副本 ${r5.note ?? '不可用'}${r5.level === 'error' ? ' 🔴' : (r5.level === 'skipped' ? ' ⚪' : '')}`
}

/**
 * 日报段（Markdown 行）—— 供 `report.mjs` 直接 push。
 * **失败环可见**（§9.6 轮四表 2 / 五环 ①②）：R5 没接日常就会静默，所以本段每日随日报跑。
 */
export function dailySectionLines(res) {
  const L = []
  L.push('## 🔗 解耦健康（R1~R5 · 宿主适配层）')
  L.push('')
  if (!res || res.error) {
    L.push(`_（解耦段降级：${res?.error ?? '未知'}）_`)
    L.push('')
    return L
  }
  const r4 = res.r4?.count ?? 0
  const r5 = res.r5 ?? {}
  const r4pkgs = Object.entries(res.r4?.byPkg ?? {}).sort((a, b) => b[1] - a[1])
  L.push(`- ${res.r1.hardCount ? '🔴' : '🟢'} R1 运行时 import：静态 **${res.r1.hardCount}** / 动态 **${res.r1.softCount}**（${res.packages.length} 个自研包${res.profileMissing?.length ? ` · profile 缺 ${res.profileMissing.length}` : ''}）`)
  L.push(`- ${r5.level === 'ok' ? '✅' : (r5.level === 'skipped' ? '⚪' : '🔴')} R5 适配层副本 sha 一致率：**${r5.note ?? '不可用'}**（唯一源 \`${res.adapterSource}\`${r5.sha ? ` · \`${String(r5.sha).slice(0, 12)}…\`` : ''}）`)
  for (const v of (r5.violations ?? []).slice(0, 5)) {
    L.push(`  - 🔴 \`${v.id}\`：${v.status} → 用你们的适配层同步器重新生成该副本`)
  }
  L.push(`- ${r4 ? '🟡' : '✅'} R4 裸宿主事实字面量：**${r4}** 处（默认只提醒不拦；唯一合法落点 = 宿主适配层）`)
  for (const [pkg, n] of r4pkgs.slice(0, 5)) L.push(`  - \`${pkg}\` ×${n}`)
  if (r4pkgs.length > 5) L.push(`  - …另有 ${r4pkgs.length - 5} 包，全量清单跑 \`node check-decoupling.mjs\``)
  L.push('')
  L.push('> 判定唯一源 = `check-decoupling.mjs`（本段只渲染，不复制判定；R1–R5 规则表见 README §3）。')
  L.push('')
  return L
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.error) { process.stderr.write(args.error + '\n'); return 2 }
  if (args.help) { console.log(usage()); return 0 }
  if (args.printConfig) {
    console.log(JSON.stringify({
      scanRoot: args.root,
      jsonReport: args.json,
      profile: args.profile,
      profileNodeModules: args.profileRoot ?? PROFILE_NM,
      profilePackages: args.profilePkgs ? splitCsv(args.profilePkgs) : PROFILE_SELF_PKGS,
      vocabFile: args.vocabFile,
      adapterSource: args.adapterSource ?? HOST_ADAPTER_SOURCE,
      adapterVerifier: resolveAdapterVerifier({ cli: args.adapterVerifier, root: args.root }),
      dshHome: resolveDshHome(),
    }, null, 2))
    return 0
  }
  // R5：只有配置了（或自动探测到）校验器才跑；判定逻辑不在本文件复制
  let adapterVerifier = null
  const verifierPath = resolveAdapterVerifier({ cli: args.adapterVerifier, root: args.root })
  if (verifierPath) {
    try {
      const mod = await import(pathToFileURL(verifierPath).href)
      if (typeof mod.verifySummary === 'function') adapterVerifier = mod.verifySummary
      else adapterVerifier = () => ({ level: 'error', total: 0, inSync: 0, violations: [], sha: null, note: `校验器未导出 verifySummary()：${verifierPath}` })
    } catch (e) {
      adapterVerifier = () => ({ level: 'error', total: 0, inSync: 0, violations: [], sha: null, note: `校验器加载失败：${e?.message ?? e}` })
    }
  }
  const res = runChecks({
    root: args.root,
    noProfile: args.noProfile,
    withR4: !args.noR4,
    strictR4: args.strictR4,
    vocabFile: args.vocabFile,
    adapterSource: args.adapterSource ?? HOST_ADAPTER_SOURCE,
    adapterVerifier,
    profileRoot: args.profileRoot,
    profilePkgs: args.profilePkgs ? splitCsv(args.profilePkgs) : null,
  })
  if (res.error) { process.stderr.write(res.error + '\n'); return 2 }
  const results = res.packages
  const hard = results.filter((r) => r.hardViolations.length)
  if (args.quiet) {
    console.log(summaryLine(res))
  } else {
    console.log(render(results, args.root, res.profileMissing, { r4: res.r4, r5: res.r5, adapterSource: res.adapterSource }))
  }
  if (args.json && !args.noJson) {
    try {
      fs.mkdirSync(path.dirname(args.json), { recursive: true })
      fs.writeFileSync(args.json, JSON.stringify({
        generatedAt: new Date().toISOString(),
        scriptVersion: VERSION,
        root: args.root,
        profileNodeModules: res.profileNodeModules,
        adapterSource: res.adapterSource,
        packages: results,
        summary: {
          packages: results.length,
          hardViolations: results.reduce((s, r) => s + r.hardViolations.length, 0),
          softViolations: results.reduce((s, r) => s + r.softViolations.length, 0),
          hardPackages: hard.map((r) => r.name),
          r2Notes: results.filter((r) => !r.hardViolations.length && !r.softViolations.length && (r.dependencies.length || r.clientInject.length)).length,
          r4Violations: res.r4.count,
          r4Packages: Object.keys(res.r4.byPkg).length,
          r5Level: res.r5.level,
          r5InSync: res.r5.inSync,
          r5Total: res.r5.total,
          r5Violations: (res.r5.violations ?? []).length,
          exitCode: res.exitCode,
        },
      }, null, 2), 'utf8')
    } catch (e) {
      process.stderr.write(`[warn] JSON 写入失败: ${e.message}\n`)
    }
  }
  // 退出码：R1 静态违规 或 R5 不一致（=1）；R4 默认只提醒（--strict-r4 才计）
  return res.exitCode
}

if (isMainEntry()) {
  main()
    .then((code) => { process.exitCode = code })
    .catch((e) => { process.stderr.write(`check-decoupling 失败：${e?.stack ?? e}\n`); process.exitCode = 1 })
}
