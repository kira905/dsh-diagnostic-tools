// runtime-config.mjs —— 路径与污染模式的统一解析层（零依赖 · 跨平台 · 可注入）
//
// 为什么有这一层：本工具组原先写死了「本机形态」——
//   · 链接层默认 `~/.dsh/profiles/node_modules`
//   · 期望闭包根默认 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules`（Windows 专有）
//   · 污染特征写死「某个具体测试安装名 + canary」（名字是各环境自己的事，不该进公开默认值）
//   · 修法入口写死某个固定的工具目录
// 开源形态下这些全部改为**可注入 + 自动探测**：
//
//   解析优先级（高 → 低）
//     ① CLI 参数（--link-root / --source-root / --npm-root / --pollution-pattern …）
//     ② 环境变量（本文件 ENV 表）
//     ③ 自动探测（本机全局 npm 根 / 主包自带依赖目录）
//     ④ 内置默认（~/.dsh/profiles/node_modules 等，跨平台成立的那部分）
//
// 只读：本文件不写任何文件、不 spawn 任何进程。

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（本文件住在 <pkg>/lib/ 下）。 */
export const PKG_ROOT = (() => {
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } catch { return process.cwd() }
})()

/** 环境变量名（对外契约，README 有表）。 */
export const ENV = {
  linkRoot: 'CLOSURE_LINK_ROOT',
  sourceRoot: 'CLOSURE_SOURCE_ROOT',
  npmRoot: 'CLOSURE_NPM_ROOT',
  profilesHome: 'DSH_PROFILES_HOME',
  home: 'DSH_HOME',
  altHome: 'BUTLER_DSH_HOME',
  pollutionPatterns: 'CLOSURE_POLLUTION_PATTERNS',
  archiveRoot: 'CLOSURE_ARCHIVE_ROOT',
  toolsDir: 'DSH_TOOLS_DIR',
  packageName: 'CLOSURE_PACKAGE_NAME',
}

/** 受检主包名（默认 `@deepseek-ai/dsh`；期望闭包根 = 该包自带的 `node_modules`）。 */
export function packageName(env = process.env) {
  const v = String(env[ENV.packageName] ?? '').trim()
  return v || '@deepseek-ai/dsh'
}

const trim = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * 全局包管理器的 `node_modules` 候选根（**只读探测，不 spawn**）。
 * 顺序 = 环境变量显式指定 → 平台惯例目录。返回去重后的**全部**候选（含不存在的）。
 */
export function globalNodeModulesCandidates(env = process.env) {
  const out = []
  const push = (p) => { if (p && !out.some((x) => x.toLowerCase() === String(p).toLowerCase())) out.push(path.resolve(String(p))) }
  const prefix = trim(env.npm_config_prefix) || trim(env.NPM_CONFIG_PREFIX) || trim(env.PREFIX)
  if (prefix) push(path.join(prefix, 'lib', 'node_modules'))
  const appdata = trim(env.APPDATA)
  if (appdata) push(path.join(appdata, 'npm', 'node_modules'))
  const home = homedir()
  push(path.join(home, '.npm-global', 'lib', 'node_modules'))
  push(path.join(home, '.local', 'lib', 'node_modules'))
  push('/opt/homebrew/lib/node_modules')
  push('/usr/local/lib/node_modules')
  push('/usr/lib/node_modules')
  const programFiles = trim(env.ProgramFiles)
  if (programFiles) push(path.join(programFiles, 'nodejs', 'node_modules'))
  return out
}

/** 候选里第一个**存在**的全局 node_modules 根；都没有 → null。 */
export function detectGlobalNodeModules(env = process.env) {
  return globalNodeModulesCandidates(env).find(isDir) ?? null
}

/**
 * 归一期望闭包根：允许用户直接给「主包目录」而不必给到 `node_modules`。
 *   <npmRoot>/@deepseek-ai/dsh          → <npmRoot>/@deepseek-ai/dsh/node_modules
 *   <npmRoot>/@deepseek-ai/dsh/node_modules → 原样
 *   <任意别的目录>                       → **原样**（当作「依赖目录根」；不做猜测式改写）
 */
export function normalizeSourceRoot(input, env = process.env) {
  if (!input) return null
  const p = path.resolve(String(input))
  if (path.basename(p).toLowerCase() === 'node_modules') return p
  const tail = packageName(env).split('/').pop().toLowerCase()
  if (tail && path.basename(p).toLowerCase() === tail) return path.join(p, 'node_modules')
  return p
}

/**
 * 期望闭包根（干净态判据的基准）。
 * @param {{cli?:string, env?:NodeJS.ProcessEnv}} [opts]
 * @returns {string|null} 解析不到 → null（调用方据此判「环境不可用」，绝不猜）
 */
export function resolveSourceRoot(opts = {}) {
  const env = opts.env ?? process.env
  const explicit = trim(opts.cli) ?? trim(env[ENV.sourceRoot])
  if (explicit) return normalizeSourceRoot(explicit, env)
  const name = packageName(env)
  for (const nm of globalNodeModulesCandidates(env)) {
    const cand = path.join(nm, ...name.split('/'), 'node_modules')
    if (isDir(cand)) return cand
  }
  return null
}

/** 全局 npm 顶层根（修法的次级候选：主包本体住这儿）。 */
export function resolveNpmRoot(opts = {}) {
  const env = opts.env ?? process.env
  const explicit = trim(opts.npmRoot) ?? trim(opts.cli) ?? trim(env[ENV.npmRoot])
  if (explicit) return path.resolve(explicit)
  return detectGlobalNodeModules(env)
}

/** `a,b;c` → `['a','b','c']`（去空、去空格）—— 解析「注入式」环境变量用。 */
export function splitList(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/)
  return list.map((s) => String(s).trim()).filter((s) => s !== '')
}

/** DSH 数据根：`BUTLER_DSH_HOME` > `DSH_HOME` > `~/.dsh`（跨平台）。 */
export function resolveDshHome(env = process.env) {
  const h = trim(env[ENV.altHome]) ?? trim(env[ENV.home])
  return h ? path.resolve(h) : path.join(homedir(), '.dsh')
}

/**
 * 默认链接层 = DSH home 下的 profiles/node_modules。
 * 优先级：CLI `--link-root` > `CLOSURE_LINK_ROOT` > `DSH_PROFILES_HOME`
 *         > `(BUTLER_DSH_HOME|DSH_HOME)/profiles/node_modules` > `~/.dsh/profiles/node_modules`
 * @param {{cli?:string, env?:NodeJS.ProcessEnv, profile?:string}} [opts]
 */
export function resolveLinkRoot(opts = {}) {
  const env = opts.env ?? process.env
  const profile = trim(opts.profile)
  const explicit = trim(opts.cli) ?? trim(env[ENV.linkRoot])
  if (explicit) return path.resolve(explicit)
  const profilesHome = trim(env[ENV.profilesHome])
  if (profilesHome) {
    const base = path.resolve(profilesHome)
    return profile ? path.join(base, profile, 'node_modules') : base
  }
  const home = resolveDshHome(env)
  return profile
    ? path.join(home, 'profiles', profile, 'node_modules')
    : path.join(home, 'profiles', 'node_modules')
}

// ---------------------------------------------------------------- 污染特征

/**
 * 内置污染特征（默认值 = 面向「多个 DSH 安装共用一套依赖闭包」的场景）。
 * `id` 只用于文案与归因，`re` 命中目标路径即判 🔴。
 * ⚠️ 判据是**形态**而不是具体安装名：路径里出现「名字以 `-test` 结尾的目录段」或 `canary` 即视为
 *    另一个（测试/灰度用）安装的依赖目录 —— 具体叫什么名字由各环境自己决定，要收紧/替换就注入。
 * ⚠️ 这不是「写死某个环境的策略」：CLI `--pollution-pattern` / 环境变量
 *    `CLOSURE_POLLUTION_PATTERNS` 可整体替换（见 resolvePollutionPatterns）。
 */
export const DEFAULT_POLLUTION_PATTERNS = [
  { id: 'sibling-test-install', re: /(^|[\\/])[^\\/]*-test[^\\/]*(?=[\\/]|$)/i },
  { id: 'canary', re: /canary/i },
]

/**
 * 解析自定义污染特征（字符串 = 正则源码，编译时带 `i`；也可传 `{id, pattern}`）。
 * 非法正则 → **抛错**（fail-closed：判据坏了就不许跑出“干净”结论）。
 * @param {string|string[]|object[]|null} [custom]
 */
export function compilePollutionPatterns(custom) {
  const list = []
  const raw = Array.isArray(custom) ? custom : (typeof custom === 'string' && custom ? custom.split(',') : [])
  for (const item of raw) {
    const src = typeof item === 'string' ? item.trim() : (item && typeof item === 'object' ? item.pattern : null)
    if (!src) continue
    if (typeof item === 'object' && item.enabled === false) continue
    let re
    try { re = new RegExp(String(src), 'i') } catch (e) { throw new Error(`污染特征不是合法正则：${src}（${e?.message ?? e}）`) }
    list.push({ id: (typeof item === 'object' && item.id) ? String(item.id) : `custom-${list.length + 1}`, re, source: String(src) })
  }
  return list
}

/**
 * 污染特征解析：CLI/环境变量给了就用（**整体替换**默认值），没给就用内置默认。
 * @param {{cli?:string|string[], env?:NodeJS.ProcessEnv}} [opts]
 */
export function resolvePollutionPatterns(opts = {}) {
  const env = opts.env ?? process.env
  const custom = opts.cli ?? trim(env[ENV.pollutionPatterns])
  if (!custom || (Array.isArray(custom) && custom.length === 0)) {
    return DEFAULT_POLLUTION_PATTERNS.map((p) => ({ ...p, source: String(p.re.source) }))
  }
  return compilePollutionPatterns(custom)
}

// ---------------------------------------------------------------- 自检（排障用）

/**
 * 解析结果 + 每个值的来源（`cli` / `env:<名>` / `detected` / `default`）。
 * 供 CLI `--print-config` 与报告头打印，别人环境里排障一眼看清「用的是哪一份」。
 */
export function describeResolution(opts = {}) {
  const env = opts.env ?? process.env
  const out = { linkRoot: null, sourceRoot: null, npmRoot: null, home: null, pollutionPatterns: [] }
  const src = (v, cli, envKey) => (trim(cli) ? 'cli' : (trim(env[envKey]) ? `env:${envKey}` : v))
  out.home = { value: resolveDshHome(env), from: src('default', null, ENV.home) }
  out.linkRoot = {
    value: resolveLinkRoot(opts),
    from: trim(opts.cli) ? 'cli' : (trim(env[ENV.linkRoot]) ? `env:${ENV.linkRoot}`
      : (trim(env[ENV.profilesHome]) ? `env:${ENV.profilesHome}` : (trim(env[ENV.home]) || trim(env[ENV.altHome]) ? 'env:DSH_HOME' : 'default'))),
  }
  const srcCli = trim(opts.sourceRoot)
  const envSrc = trim(env[ENV.sourceRoot])
  const resolvedSrc = resolveSourceRoot(opts)
  out.sourceRoot = {
    value: resolvedSrc,
    from: srcCli ? 'cli' : (envSrc ? `env:${ENV.sourceRoot}` : (resolvedSrc ? 'detected' : 'unresolved')),
    candidates: globalNodeModulesCandidates(env),
  }
  out.npmRoot = { value: resolveNpmRoot({ npmRoot: opts.npmRoot, npmRootCli: null, env }), from: (trim(opts.npmRoot) ? 'cli' : (trim(env[ENV.npmRoot]) ? `env:${ENV.npmRoot}` : 'detected')) }
  out.pollutionPatterns = resolvePollutionPatterns(opts).map((p) => ({
    id: p.id,
    source: p.source,
    from: (trim(env[ENV.pollutionPatterns]) || opts.cli) ? 'injected' : 'default',
  }))
  return out
}
