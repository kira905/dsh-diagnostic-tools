// 依赖闭包链接指向体检 —— 只读、零依赖、跨平台
//
// 它治什么：`<DSH home>/profiles/node_modules` 是「依赖闭包链接层」——里面的包通常是指向
// **全局 npm 主包自带依赖**的链接（junction / symlink）。若同一台机器上还有**另一个 DSH 安装**
// （测试实例 / 金丝雀实例 / 多版本共存环境）与生产共用同一份物理闭包，那个安装启动时的依赖
// 自愈逻辑会按它自己的主包位置改写这些共享链接 ⇒ 生产重启即加载错版本包（插件静默崩）。
//
// 干净态判据：**链接层里每个链接都指向「期望闭包根」**（默认 = 全局 npm 安装的主包自带
// `node_modules`，自动探测见 lib/runtime-config.mjs）；命中污染特征（默认特征 = 指向另一个
// DSH 安装的依赖目录）的即为 🔴。
//
// 路径与污染特征**全部可注入**：CLI 参数 > 环境变量 > 自动探测 > 内置默认（见 README §4）。
import { existsSync, lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENV, PKG_ROOT, splitList,
  resolveLinkRoot, resolveSourceRoot, resolvePollutionPatterns, DEFAULT_POLLUTION_PATTERNS,
} from './runtime-config.mjs'

/**
 * 污染特征（内置默认值见 lib/runtime-config.mjs 的 DEFAULT_POLLUTION_PATTERNS）。
 * 可用 `--pollution-pattern <正则>` / `CLOSURE_POLLUTION_PATTERNS` **整体替换**默认值。
 */
export const POLLUTION_PATTERNS = DEFAULT_POLLUTION_PATTERNS

/** 单个目标是否命中污染特征（`patterns` 省略时用内置默认特征）。 */
export function isPollutedTarget(target, patterns = POLLUTION_PATTERNS) {
  if (typeof target !== 'string' || target === '') return false
  return patterns.some((p) => p.re.test(target))
}

/** 目标命中的污染特征 id 列表（归因 / 报告用）。 */
export function matchedPollutionIds(target, patterns = POLLUTION_PATTERNS) {
  if (typeof target !== 'string' || target === '') return []
  return patterns.filter((p) => p.re.test(target)).map((p) => p.id)
}

function norm(p) {
  return String(p).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 默认链接层 = DSH home 下的 `profiles/node_modules`。
 * 覆写优先级：`--link-root` > `CLOSURE_LINK_ROOT` > `DSH_PROFILES_HOME`
 *            > `(BUTLER_DSH_HOME|DSH_HOME)/profiles/node_modules` > `~/.dsh/profiles/node_modules`。
 * 传 `{ profile: 'web' }` 可指向某个 profile 自己的依赖目录（`<home>/profiles/<profile>/node_modules`）。
 */
export function defaultLinkRoot(opts = {}) {
  return resolveLinkRoot(opts)
}

/**
 * 默认期望闭包根 = 全局 npm 安装的主包自带 `node_modules`（**自动探测**，跨平台）。
 * 解析不到 → null（调用方据此判「环境不可用」，绝不猜）。
 */
export function defaultSourceRoot(opts = {}) {
  return resolveSourceRoot(opts)
}

/**
 * 收集链接层下所有 junction（含 @scope 一层；不穿透到包内部）。
 * 返回 [{ rel, full, target, targetExists, resolved }]
 */
export function collectLinks(linkRoot, { maxDepth = 2 } = {}) {
  const out = []
  const walk = (dir, prefix, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        let target = ''
        try {
          target = readlinkSync(full)
        } catch {
          /* ignore */
        }
        let resolved = ''
        try {
          resolved = realpathSync(full)
        } catch {
          resolved = ''
        }
        out.push({
          rel: prefix + entry.name,
          full,
          target,
          targetExists: target !== '' && existsSync(full),
          resolved,
        })
      } else if (st.isDirectory() && entry.name.startsWith('@') && depth < maxDepth) {
        walk(full, prefix + entry.name + '/', depth + 1)
      }
    }
  }
  walk(linkRoot, '', 0)
  return out
}

/**
 * 扫描并分类。level: ok | warn | danger
 *   danger = 存在指向「另一个安装」的链接（命中任一污染特征；默认 = 名字形如 *-test 的目录段 / canary）
 *   warn   = 无污染但有断链（目标不存在）
 */
export function scanClosureLinks({
  linkRoot = defaultLinkRoot(),
  sourceRoot = defaultSourceRoot(),
  pollutionPatterns = resolvePollutionPatterns(),
} = {}) {
  const result = {
    ok: false,
    reason: null,
    linkRoot,
    sourceRoot,
    physicalRoot: null,
    total: 0,
    matched: 0,
    pollutionPatternIds: pollutionPatterns.map((p) => p.id),
    polluted: [],
    broken: [],
    other: [],
    level: 'ok',
  }
  if (!linkRoot || !existsSync(linkRoot)) {
    result.reason = 'link-root-missing'
    result.level = 'warn'
    return result
  }
  if (!sourceRoot) {
    result.reason = 'source-root-unresolved'
    result.level = 'warn'
    return result
  }
  try {
    result.physicalRoot = realpathSync(linkRoot)
  } catch {
    result.physicalRoot = linkRoot
  }

  const links = collectLinks(linkRoot)
  result.total = links.length
  const src = norm(sourceRoot) + sep
  for (const link of links) {
    if (isPollutedTarget(link.target, pollutionPatterns)) {
      result.polluted.push({ ...link, pollutionIds: matchedPollutionIds(link.target, pollutionPatterns) })
      continue
    }
    if (norm(link.target).startsWith(src)) {
      result.matched += 1
      continue
    }
    if (!link.targetExists) result.broken.push(link)
    else result.other.push(link)
  }

  result.level = result.polluted.length > 0 ? 'danger' : result.broken.length > 0 ? 'warn' : 'ok'
  result.ok = true
  return result
}

/** [rel, target] 形态的紧凑样例，供日报/面板渲染。 */
export function pollutionSamples(scan, n = 5) {
  return scan.polluted.slice(0, n).map((l) => ({ rel: l.rel, target: l.target, targetExists: l.targetExists }))
}

export function formatScanLine(scan) {
  if (!scan.ok) return `闭包指向检查：无法扫描（${scan.reason || 'unknown'}）`
  if (scan.level === 'danger') {
    return `闭包指向：**${scan.polluted.length}** 个链接指向受污染闭包（另一个 DSH 安装的依赖；应为 0）`
  }
  if (scan.level === 'warn') {
    return `闭包指向：干净，但 ${scan.broken.length} 个链接目标不存在（断链）`
  }
  return `闭包指向：干净（${scan.total} 个链接全部指向生产闭包）`
}

// ---------------------------------------------------------------------------
//  归因 + 修法
//  只生成「谁改的、怎么修」的措辞 —— **判定口径仍是上面那一套，勿在此另造**。
// ---------------------------------------------------------------------------

/**
 * 污染目标 → 按命中的污染特征归类计数（归因用）。
 * @param {Array<object>} links scan 结果的 polluted 列表
 * @param {Array<{id:string,re:RegExp}>} [patterns]
 * @returns {{total:number, counts:Record<string,number>, other:number, samples:Record<string,object|null>, patterns:string[]}}
 */
export function attributePollution(links = [], patterns = POLLUTION_PATTERNS) {
  const out = { total: links.length, counts: {}, other: 0, samples: {}, patterns: patterns.map((p) => p.id) }
  for (const p of patterns) { out.counts[p.id] = 0; out.samples[p.id] = null }
  out.samples.other = null
  for (const l of links) {
    const t = String(l?.target || '')
    const hit = patterns.find((p) => p.re.test(t))
    const kind = hit ? hit.id : 'other'
    if (kind === 'other') out.other += 1
    else out.counts[kind] += 1
    if (!out.samples[kind]) out.samples[kind] = { rel: l.rel, target: t }
  }
  return out
}

/** 归因结论一行（人读；无污染返回空串）。 */
export function formatAttributionLine(scan, patterns = resolvePollutionPatterns()) {
  if (!scan || !Array.isArray(scan.polluted) || scan.polluted.length === 0) return ''
  const a = attributePollution(scan.polluted, patterns)
  const bits = []
  for (const [id, n] of Object.entries(a.counts)) if (n) bits.push(`${n} 个命中污染特征 \`${id}\``)
  if (a.other) bits.push(`${a.other} 个指向其他非期望路径`)
  return `归因：${bits.join('；')} ⇒ 典型成因 = 同机另一个 DSH 安装（测试 / 金丝雀 / 多版本共存）启动时`
    + '按它自己的主包位置改写了这份共享依赖闭包；也可能链接层本身就指错了地方。'
}

/** 本包自带的修法入口（`repairCommands()` 的第一顺位探测项）。 */
export const TOOLS_REPAIR_SCRIPTS = [
  {
    script: 'repair-closure-links.mjs',
    label: '本工具组修法脚本（repair-closure-links.mjs：把指向受污染闭包的链接重建为**期望闭包**指向；期望闭包无同名包则只删链接、不造物）',
  },
]

/**
 * 修法脚本探测（**存在性判定，不带任何写死路径**）。
 * 顺序 = ① 本包自带（`<pkg>/repair-closure-links.mjs`）
 *      → ② `CLOSURE_REPAIR_SCRIPTS` 注入的外部脚本
 *      → ③ `CLOSURE_TEST_ROOTS` 下各根自带的 `scripts/repair-shared-modules.mjs`（若确有这类环境资产）。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{toolsRoot?:string}} [opts]
 */
export function repairCommands(env = process.env, opts = {}) {
  const out = []
  const seen = new Set()
  const toolsRoot = opts.toolsRoot ?? env[ENV.toolsDir] ?? PKG_ROOT
  const add = (p, host, label) => {
    const key = String(p).toLowerCase()
    if (seen.has(key) || !existsSync(p)) return
    seen.add(key)
    out.push({ path: p, host, label })
  }
  for (const t of TOOLS_REPAIR_SCRIPTS) add(join(String(toolsRoot), t.script), 'tools', t.label)
  for (const extra of splitList(env.CLOSURE_REPAIR_SCRIPTS)) {
    add(extra, 'external', '外部注入的修法脚本（CLOSURE_REPAIR_SCRIPTS）')
  }
  for (const root of splitList(env.CLOSURE_TEST_ROOTS)) {
    add(join(String(root), 'scripts', 'repair-shared-modules.mjs'), 'test-root',
      '环境自带修法脚本（把指向另一个安装的链接改回期望闭包）')
  }
  return out
}

/** 本体检（closure-check.mjs）路径 —— 本包自带，同源同口径。 */
export function checkerPath() {
  return fileURLToPath(new URL('../closure-check.mjs', import.meta.url))
}

/** 处置段（多行，供 CLI / 启动哨兵打印；无污染返回空数组）。 */
export function formatRepairLines(scan, env = process.env) {
  if (!scan || !Array.isArray(scan.polluted) || scan.polluted.length === 0) return []
  const lines = ['处置（先只读确认，再执行）：']
  const cmds = repairCommands(env)
  if (cmds.length === 0) {
    lines.push('  · 未探测到修法脚本 → 手工重建：把受污染链接改回「期望闭包根」下的同名包；')
    lines.push('    期望闭包里没有同名包时**只删链接、不造物**（删的是链接本身，绝不递归删目录）')
  }
  for (const c of cmds) {
    lines.push(`  · ${c.label}`)
    lines.push(`      node "${c.path}"            # DRY-RUN，先看计划`)
    lines.push(`      node "${c.path}" --apply    # 执行（自动写回滚清单）`)
  }
  lines.push(`  · 复核：node "${checkerPath()}"   # 期望退出码 0`)
  lines.push('  · 预防：每个 DSH 安装的 `profiles/node_modules` 应各自独立（实体目录或独立宿主目录），')
  lines.push('    不要让两个安装共用同一份物理闭包；链接层本身也不应指向另一个安装的依赖目录。')
  return lines
}
