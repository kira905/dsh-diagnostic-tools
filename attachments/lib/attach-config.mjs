// ============================================================
//  attach-config.mjs — 附件对账 / 取回 的路径解析层
//  ------------------------------------------------------------
//  优先级（高 → 低）：**CLI 参数 > 环境变量 > 自动探测 > 内置默认**
//  两个 CLI 都支持 `--print-config`：一眼看清「这次到底用的是哪一份、从哪来」。
//
//  可注入的六项（都是路径，全部有默认值）：
//    · home         : `--home`          / `$DSH_HOME`            / `~/.dsh`
//    · workspace    : `--workspace`     / `$DSH_WORKSPACE`       / 由 home 推导 / cwd
//    · 对象根        : `--objects-root`  / `$ATTACH_OBJECTS_ROOT` / `<home>/attachments/v1/objects`
//    · 会话根        : `--sessions-root` / `$ATTACH_SESSION_ROOTS`（可多个）/ `<home>/sessions` + `<home>/_archived-sessions`
//    · 扫描缓存      : `--cache`         / `$ATTACH_SCAN_CACHE`   / `<home>/attach-scan-cache.json`
//    · 取回源        : `--from` / `--relay` / `--local-source` + `$ATTACH_RELAY_DIRS` / `$ATTACH_LOCAL_SOURCES`
//
//  只读原则：本文件只做路径解析与存在性探测，不创建目录、不写任何文件。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { resolveDshHome, resolveDshWorkspace, envValue, describeHomeSource, describeWorkspaceSource } from './dsh-home.mjs'
import { objectsRootFor, attachmentsRootFor, sessionTrees, SESSION_TREES_DEFAULT } from './attach-refs.mjs'

/** 扫描缓存默认文件名（单机状态，可安全删除）。 */
export const DEFAULT_CACHE_NAME = 'attach-scan-cache.json'

/**
 * 多值环境变量拆分：逗号 / 分号 / 竖线都认。
 * ⚠️ 三种写法语义相同 —— 用户按正则习惯写 `A|B` 时不该静默失效（那会让人以为「已配置」）。
 */
export function envList(name) {
  return (process.env[name] ?? '')
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 解析优先级的公共形态：CLI > env > 默认；返回值与来源标注。 */
function pick(cli, envName, fallback) {
  if (cli !== null && cli !== undefined && cli !== '') return { value: path.resolve(cli), from: 'cli' }
  const env = envValue(envName)
  if (env) return { value: path.resolve(env), from: 'env:' + envName }
  return { value: path.resolve(fallback), from: 'default' }
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

/** 对象根（`<...>/objects`，其下按 sha256 前 2 位分层）。 */
export function resolveObjectsRoot({ home = null, cli = null } = {}) {
  const h = resolveDshHome(home)
  return pick(cli, 'ATTACH_OBJECTS_ROOT', objectsRootFor(h))
}

/** 附件根（`<...>/v1`）。多数场景用对象根即可，留着供二次开发。 */
export function resolveAttachmentsRoot({ home = null, cli = null } = {}) {
  const h = resolveDshHome(home)
  return pick(cli, 'ATTACH_ATTACHMENTS_ROOT', attachmentsRootFor(h))
}

/**
 * 会话根列表（要扫哪些会话树）。
 * 默认 = `<home>/sessions` 与 `<home>/_archived-sessions`（**存在才纳入**）。
 * 注入（CLI `--sessions-root` 可重复 / `$ATTACH_SESSION_ROOTS`）= **整体替换**默认，按给定顺序取。
 */
export function resolveSessionRoots({ home = null, cli = [] } = {}) {
  const h = resolveDshHome(home)
  const injected = cli.length ? cli : envList('ATTACH_SESSION_ROOTS')
  if (injected.length) {
    return {
      roots: injected.map((d) => ({ name: path.basename(path.resolve(d)), dir: path.resolve(d) })),
      from: cli.length ? 'cli' : 'env:ATTACH_SESSION_ROOTS',
    }
  }
  return { roots: sessionTrees(h), from: 'default' }
}

/** 扫描缓存文件。`--no-cache` 时调用方忽略本值。 */
export function resolveCacheFile({ home = null, cli = null } = {}) {
  const h = resolveDshHome(home)
  return pick(cli, 'ATTACH_SCAN_CACHE', path.join(h, DEFAULT_CACHE_NAME))
}

/**
 * 中转目录候选（`<dir>/objects/<2>/<sha>` 或 `<dir>/<2>/<sha>`，也认多一层主机名目录）。
 * 注入（CLI `--relay` 可重复 / `$ATTACH_RELAY_DIRS`）= **整体替换**默认。
 * 默认只有一个候选：`<workspace>/_tmp/attachments-relay`（存在才算数）。
 */
export function resolveRelayDirs({ workspace = null, cli = [] } = {}) {
  const injected = cli.length ? cli : envList('ATTACH_RELAY_DIRS')
  if (injected.length) {
    return { dirs: injected.map((d) => path.resolve(d)), from: cli.length ? 'cli' : 'env:ATTACH_RELAY_DIRS', requireExists: false }
  }
  const w = resolveDshWorkspace(workspace)
  return { dirs: [path.join(w, '_tmp', 'attachments-relay')], from: 'default', requireExists: true }
}

/**
 * 本机派生源（按**内容 sha256** 命中即可自愈，不需要跨机介质）。
 * 默认三个：`<home>/dsh-imagegen/images`、`<home>/dsh-imagegen/gallery/images`、`<workspace>/generated`。
 * 注入为**追加**（`--local-source` / `$ATTACH_LOCAL_SOURCES`），加 `--no-local-sources` 可整体关闭。
 */
export function resolveLocalSources({ home = null, workspace = null, cli = [] } = {}) {
  const h = resolveDshHome(home)
  const w = resolveDshWorkspace(workspace)
  const injected = cli.length ? cli.map((d) => path.resolve(d)) : envList('ATTACH_LOCAL_SOURCES').map((d) => path.resolve(d))
  const defaults = [
    path.join(h, 'dsh-imagegen', 'images'),
    path.join(h, 'dsh-imagegen', 'gallery', 'images'),
    path.join(w, 'generated'),
  ]
  return {
    // 默认三源在前、注入源在后 —— 与内部版同序（同一 sha 的内容一致，顺序只影响「选中哪个路径」）
    dirs: [...defaults, ...injected],
    from: cli.length ? 'cli' : (envList('ATTACH_LOCAL_SOURCES').length ? 'env:ATTACH_LOCAL_SOURCES' : 'default'),
    injected,
  }
}

/** 取回报告默认落点（`--report <file>` 可覆盖）。 */
export function resolveReportDir({ workspace = null, cli = null } = {}) {
  const w = resolveDshWorkspace(workspace)
  return pick(cli, 'ATTACH_REPORT_DIR', path.join(w, '_tmp', 'attachments-fetch'))
}

/** 报告文件名（时间戳，可排序）。 */
export function reportFileName(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-report.json'
}

/**
 * `--print-config` 用：把「每个值 + 来源」摊平。
 * 只做解析，不创建任何目录。
 */
export function describeResolution({ home = null, workspace = null, objectsRoot = null, sessionsRoots = [], cache = null, relays = [], localSources = [], reportDir = null } = {}) {
  const h = resolveDshHome(home)
  const w = resolveDshWorkspace(workspace)
  const obj = resolveObjectsRoot({ home, cli: objectsRoot })
  const ses = resolveSessionRoots({ home, cli: sessionsRoots })
  const cch = resolveCacheFile({ home, cli: cache })
  const rel = resolveRelayDirs({ workspace, cli: relays })
  const loc = resolveLocalSources({ home, workspace, cli: localSources })
  const rep = resolveReportDir({ workspace, cli: reportDir })
  return {
    home: { value: h, from: describeHomeSource(home) },
    workspace: { value: w, from: describeWorkspaceSource(workspace) },
    objectsRoot: obj,
    sessionsRoots: { value: ses.roots.map((r) => r.dir), from: ses.from },
    cache: cch,
    relayDirs: {
      value: rel.requireExists ? rel.dirs.filter(isDir) : rel.dirs,
      from: rel.requireExists ? rel.from + '(+exists)' : rel.from,
    },
    localSources: { value: loc.dirs, from: loc.from },
    reportDir: rep,
  }
}

/** 人读格式（`--print-config`）。 */
export function formatResolution(res) {
  const lines = ['附件对账/取回 · 路径解析（CLI > 环境变量 > 自动探测 > 默认）']
  const row = (k, v, from) => lines.push(`  ${k.padEnd(14)} ${v}   ← ${from}`)
  row('home', res.home.value, res.home.from)
  row('workspace', res.workspace.value, res.workspace.from)
  row('对象根', res.objectsRoot.value, res.objectsRoot.from)
  row('会话根', res.sessionsRoots.value.join(' | ') || '(无)', res.sessionsRoots.from)
  row('扫描缓存', res.cache.value, res.cache.from)
  row('中转目录', res.relayDirs.value.join(' | ') || '(无)', res.relayDirs.from)
  lines.push(`  ${'本机派生源'.padEnd(13)} ${res.localSources.value.length} 个   ← ${res.localSources.from}`)
  for (const d of res.localSources.value) lines.push(`                 · ${d}`)
  row('报告目录', res.reportDir.value, res.reportDir.from)
  return lines.join('\n')
}

/** 导出默认会话树名（说明用）。 */
export { SESSION_TREES_DEFAULT, objectsRootFor, attachmentsRootFor }
