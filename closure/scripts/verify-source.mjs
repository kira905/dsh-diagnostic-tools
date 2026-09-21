#!/usr/bin/env node
// scripts/verify-source.mjs —— 开源版静态验证（**发布前必跑**）
//
// 三件事：
//   ① 语法：对包内全部 `.mjs` / `.js` 跑 `node --check`
//   ② 配置层行为：路径解析优先级、污染特征注入与非法正则 fail-closed（全部用系统临时目录，绝不写仓库）
//   ③ 脱敏扫描：本机路径 / 用户名 / 设备名 / 个人称呼 / 内部专有名 / 卡 id 形态 / 凭证形态
//
// ⚠️ 本文件**不写任何真实机器名、用户名、本机路径、个人称呼或内部专有名**（否则等于把要藏的东西
//    写进要发布的仓）。规则表 = 「通用形态规则（永久生效）」+「环境标识规则（**由发布环境注入**）」。
//    · 通用形态：用户目录形态、盘符绝对路径、卡 id 形态、凭证形态 —— 与具体机器无关，永远生效。
//    · 环境标识：机器名 / 用户名 / 本机目录名 / 同步产品名 / 内部专有名 / 个人称呼 —— **只能靠注入**。
//      其中「内部专有名」「个人称呼」这类形态上无法枚举的，**不注入就没有这条规则**，
//      所以发布前务必把环境变量带全（`--print` 那段会打印本次到底加载了几条）。
//      未注入时通用形态仍然生效（用户目录与绝对路径这类形态**无需注入即可检出**）。
//    注入方式（逗号或分号分隔，大小写不敏感）：
//      BUILD_MACHINE_NAMES   例：<主机名1>,<主机名2>
//      BUILD_USER_NAMES      例：<用户名1>,<用户名2>
//      BUILD_LAYOUT_ROOTS    例：<工作区目录名>,<测试根目录名>
//      BUILD_SYNC_PRODUCTS   例：<同步产品目录名>
//      BUILD_INTERNAL_TERMS  例：<内部项目代号>,<内部体系名>   ← 形态上无法枚举，必须注入
//      BUILD_PERSONAL_TERMS  例：<私人称呼1>,<私人称呼2>      ← **本文件里一个字都不写**
//    另外：③ 段末尾会对**本文件自身**再跑一遍「注入规则」，所以「扫描器自己没有夹带私人称呼与
//    内部专有名」是一条**可复跑的断言**，而不是一句人工声明。
//
// 用法：
//   node scripts/verify-source.mjs [包根]      # 包根默认 = 本文件的上一级
// 退出码：0 = 全部通过；1 = 有失败项。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(process.argv[2] ?? path.join(HERE, '..'))
const SELF_REL = 'scripts/verify-source.mjs'

let fail = 0
const check = (name, ok, detail = '') => {
  console.log((ok ? '[OK]  ' : '[FAIL]') + ' ' + name + (detail ? ' :: ' + detail : ''))
  if (!ok) fail += 1
}

// ---------------------------------------------------------------- ① 语法

const codeFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.backups') continue
    const full = path.join(dir, entry)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full)
    else if (['.mjs', '.js', '.cjs'].includes(path.extname(entry))) codeFiles.push(full)
  }
}
walk(ROOT)
for (const file of codeFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  check('syntax ' + rel, res.status === 0, (res.stderr || '').split('\n')[0] ?? '')
}

// ---------------------------------------------------------------- ② 配置层行为

const cfg = await import(pathToFileURL(path.join(ROOT, 'lib', 'runtime-config.mjs')).href)
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-tools-verify-'))
const savedEnv = { ...process.env }

// 默认值（清空相关环境变量后）
for (const k of ['CLOSURE_LINK_ROOT', 'CLOSURE_SOURCE_ROOT', 'CLOSURE_NPM_ROOT', 'CLOSURE_POLLUTION_PATTERNS', 'DSH_PROFILES_HOME', 'DSH_HOME', 'BUTLER_DSH_HOME']) delete process.env[k]
const defLink = cfg.resolveLinkRoot()
check('默认链接层 = <home>/profiles/node_modules', defLink === path.join(os.homedir(), '.dsh', 'profiles', 'node_modules'), defLink)

process.env.DSH_HOME = sandbox
check('DSH_HOME 覆盖生效', cfg.resolveLinkRoot() === path.join(sandbox, 'profiles', 'node_modules'), cfg.resolveLinkRoot())
check('profile 参数拼出 profile 层', cfg.resolveLinkRoot({ profile: 'web' }) === path.join(sandbox, 'profiles', 'web', 'node_modules'))
check('CLI 优先级最高', cfg.resolveLinkRoot({ cli: path.join(sandbox, 'x') }) === path.join(sandbox, 'x'))

// 期望闭包根归一化：只补「明显是主包目录」的那一种
const nmRoot = path.join(sandbox, 'nm')
check('给定 .../node_modules → 原样', cfg.normalizeSourceRoot(nmRoot) === path.resolve(nmRoot))
check('给定主包目录 → 自动补 node_modules',
  cfg.normalizeSourceRoot(path.join(nmRoot, '@deepseek-ai', 'dsh')) === path.resolve(path.join(nmRoot, '@deepseek-ai', 'dsh', 'node_modules')))
check('给定普通目录 → 原样（不猜测式改写）', cfg.normalizeSourceRoot(sandbox) === path.resolve(sandbox))

// 污染特征：默认 / 注入 / 非法
const defPat = cfg.resolvePollutionPatterns()
check('默认污染特征 2 条', defPat.length === 2, JSON.stringify(defPat.map((p) => p.id)))
const inj = cfg.resolvePollutionPatterns({ cli: ['my-roaming', 'another-install'] })
check('注入特征整体替换默认', inj.length === 2 && inj[0].id === 'custom-1' && inj[0].re.test('C:/x/my-roaming/pkg'), JSON.stringify(inj.map((p) => p.id)))
let threw = false
try { cfg.compilePollutionPatterns(['[unterminated']) } catch { threw = true }
check('非法正则 fail-closed（抛错而不是静默放过）', threw)
check('描述解析结果含来源标注',
  typeof cfg.describeResolution().sourceRoot.from === 'string' && cfg.describeResolution().linkRoot.from.startsWith('env:'),
  JSON.stringify(cfg.describeResolution().linkRoot))

// 恢复环境
for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v
try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { /* ignore */ }
check('配置层验证沙箱已清理', !fs.existsSync(sandbox))

// ---------------------------------------------------------------- ③ 脱敏扫描

// 注入值分隔符：逗号 / 分号 / 竖线都认。
// ⚠️ 竖线也必须认 —— 注入值最终是「多值拼成一条正则」（join('|')），所以「A|B」与「A,B」语义**完全相同**；
//    若不认竖线，用户按正则习惯写「A|B」会被 esc() 转义成一个字面量 ⇒ 规则静默哑火、扫描假装通过。
const envList = (name) => (process.env[name] ?? '')
  .split(/[,;|]/).map((s) => s.trim()).filter((s) => s.length >= 2)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
{
  process.env.__BUILD_SPLIT_PROBE = 'aa,bb;cc|dd'
  const sp = envList('__BUILD_SPLIT_PROBE')
  delete process.env.__BUILD_SPLIT_PROBE
  // 探针值都用两个字符：单字符会被 min-length(2) 过滤掉（该过滤是防误注入的，属预期）
  check('注入值分隔符：逗号 / 分号 / 竖线都认', sp.join(',') === 'aa,bb,cc,dd', sp.join(','))
}
const EXTRA_MACHINES = envList('BUILD_MACHINE_NAMES')
const EXTRA_USERS = envList('BUILD_USER_NAMES')
const EXTRA_ROOTS = envList('BUILD_LAYOUT_ROOTS')
const EXTRA_SYNC = envList('BUILD_SYNC_PRODUCTS')
// 内部专有名 / 项目代号：形态上无法枚举（既不是 id、也不是路径），**只能由发布环境注入**。
// 动过测试样本、注释举例或规则文案之后，务必带上这一项再复扫一遍 —— 本项就是为这类残留加的。
const EXTRA_TERMS = envList('BUILD_INTERNAL_TERMS')
// 个人称呼（机主 / 助手自称那一类）：**绝不写在本文件里** —— 本文件会进公开仓，
// 把私人称谓明文写进扫描器，等于换个地方把它公开。一律由发布环境注入：
//   BUILD_PERSONAL_TERMS=<称呼1>,<称呼2>,…
const EXTRA_PERSONAL = envList('BUILD_PERSONAL_TERMS')

// 通用形态规则：与具体机器无关，永远生效
const PATTERNS = [
  [/[\\/]Users[\\/](?!<|\$\{|%|<user>)[A-Za-z0-9._-]{2,}/, 'user profile dir'],
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%|<path>)[^\s'"`<>|?*]{2,}/, 'absolute windows path'],
  [/\b[0-9a-f]{8}\b/, 'card id shape (8-hex)'],
  [/\bsk-[A-Za-z0-9]{8,}/, 'api key'],
]
const GENERIC_COUNT = PATTERNS.length
// 环境标识规则：全部由 BUILD_* 注入（未注入 = 没有这条规则，通用形态规则兜底）；
// 单独存一份 INJECTED_PATTERNS，③ 段末尾要用它给**本文件自身**做自检。
const INJECTED_PATTERNS = []
if (EXTRA_SYNC.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_SYNC.map(esc).join('|'), 'i'), 'sync product (injected)'])
if (EXTRA_TERMS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_TERMS.map(esc).join('|'), 'i'), 'internal proper name (injected)'])
if (EXTRA_PERSONAL.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_PERSONAL.map(esc).join('|'), 'i'), 'personal address (injected)'])
if (EXTRA_MACHINES.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_MACHINES.map(esc).join('|'), 'i'), 'machine name (injected)'])
if (EXTRA_USERS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_USERS.map(esc).join('|'), 'i'), 'user name (injected)'])
if (EXTRA_ROOTS.length) INJECTED_PATTERNS.push([new RegExp(EXTRA_ROOTS.map(esc).join('|'), 'i'), 'local layout root (injected)'])
PATTERNS.unshift(...INJECTED_PATTERNS)
const injected = EXTRA_MACHINES.length + EXTRA_USERS.length + EXTRA_ROOTS.length + EXTRA_SYNC.length
  + EXTRA_TERMS.length + EXTRA_PERSONAL.length
console.log('[i] 脱敏规则：通用 ' + GENERIC_COUNT + ' 条 + 注入 ' + injected + ' 条'
  + '（machine=' + EXTRA_MACHINES.length + ' user=' + EXTRA_USERS.length
  + ' layout=' + EXTRA_ROOTS.length + ' sync=' + EXTRA_SYNC.length
  + ' terms=' + EXTRA_TERMS.length + ' personal=' + EXTRA_PERSONAL.length + '）'
  + (injected
    ? ''
    : '  ← 未注入 BUILD_* 变量（MACHINE_NAMES / USER_NAMES / LAYOUT_ROOTS / SYNC_PRODUCTS / INTERNAL_TERMS'
      + ' / PERSONAL_TERMS），仅通用形态规则生效'))

const TEXT_LIKE = new Set(['.md', '.json', '.example', '.txt', '.yml', '.yaml'])
const scanTargets = [...codeFiles]
for (const rel of ['README.md', 'CHANGELOG.md', 'LICENSE', 'docs/RELEASING.md', '.gitignore', 'package.json']) {
  const full = path.join(ROOT, rel)
  if (fs.existsSync(full) && !scanTargets.includes(full)) scanTargets.push(full)
}
for (const dir of ['examples', 'docs']) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) continue
  const stack = [full]
  while (stack.length) {
    const d = stack.pop()
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) stack.push(f)
      else if (!scanTargets.includes(f)) scanTargets.push(f)
    }
  }
}
let scannedLines = 0
let scanHits = 0
for (const file of scanTargets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  // 本文件自身定义检测规则（规则文本里必然出现 "Users"、盘符这类**形态样例**），故不参与**通用**规则扫描；
  // 但它必须过**注入**规则 —— 见循环之后的自检段。
  if (rel === SELF_REL) continue
  const isText = TEXT_LIKE.has(path.extname(rel))
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    scannedLines += 1
    for (const [re, label] of PATTERNS) {
      if (!re.test(lines[i])) continue
      // 占位符形态（<...> / %VAR% / ${...}）不算命中
      const line = lines[i].replace(/<[^>]{1,40}>/g, '').replace(/%[A-Za-z_]+%/g, '').replace(/\$\{[^}]{1,60}\}/g, '')
      if (!re.test(line)) continue
      scanHits += 1
      check(`脱敏 ${rel}:${i + 1} [${label}]${isText ? '' : ''}`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check(`脱敏扫描完成（${scanTargets.length - 1} 文件 / ${scannedLines} 行 / 命中 ${scanHits}）`, scanHits === 0)

// 自检：**扫描器自己**不许夹带注入类标识（私人称呼 / 内部专有名 / 机器名 / 用户名 / 同步产品名）。
// 这些是「只有发布环境才知道的标识」，规则文本里本来就不该出现 —— 通用规则扫不了自身（规则文本
// 必然含形态样例），所以这里单独用注入规则再扫一遍，把「脚本自身已复核」变成可复跑断言。
// 注意：未注入时 INJECTED_PATTERNS 为空 ⇒ 本段是空判（会打印提示），发布前务必带全 BUILD_* 复跑。
const selfPath = path.join(ROOT, SELF_REL)
if (fs.existsSync(selfPath)) {
  const selfText = fs.readFileSync(selfPath, 'utf8')
  let selfHits = 0
  for (const [re, label] of INJECTED_PATTERNS) {
    if (!re.test(selfText)) continue
    selfHits += 1
    check(`自检 ${SELF_REL} [${label}]（扫描器自身不得夹带该标识）`, false, re.source)
  }
  check(`自检 ${SELF_REL}：${INJECTED_PATTERNS.length} 条注入规则 / 命中 ${selfHits}`
    + (INJECTED_PATTERNS.length ? '' : '（未注入 → 空判，请带全 BUILD_* 复跑）'), selfHits === 0)
}

console.log('\n' + (fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED'))
process.exitCode = fail === 0 ? 0 : 1
