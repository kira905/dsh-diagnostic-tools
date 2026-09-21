#!/usr/bin/env node
// scripts/verify-source.mjs —— 开源版静态验证（**发布前必跑**）
//
// 三件事：
//   ① 语法：对包内全部 `.mjs` / `.js` 跑 `node --check`
//   ② 配置层行为：路径解析优先级、多值环境变量拆分、会话根/取回源注入（全部用系统临时目录，绝不写仓库）
//   ③ 脱敏扫描：本机路径 / 用户名 / 设备名 / 个人称呼 / 内部专有名 / 凭证形态
//
// ⚠️ 本文件**不写任何真实机器名、用户名、本机路径、个人称呼或内部专有名**（否则等于把要藏的东西
//    写进要发布的仓）。规则表 = 「通用形态规则（永久生效）」+「环境标识规则（**由发布环境注入**）」。
//    · 通用形态：用户目录形态、盘符绝对路径、卡 id 形态、凭证形态 —— 与具体机器无关，永远生效。
//    · 环境标识：机器名 / 用户名 / 本机目录名 / 同步产品名 / 内部专有名 / 个人称呼 —— **只能靠注入**。
//      其中「内部专有名」「个人称呼」这类形态上无法枚举的，**不注入就没有这条规则**，
//      所以发布前务必把环境变量带全（脚本会打印本次到底加载了几条）。
//    注入方式（逗号 / 分号 / 竖线分隔，大小写不敏感）：
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
//   node scripts/verify-source.mjs [扫描根]
//     扫描根默认 = 本脚本的上一级（即附件工具包根）。
//     若本包位于一个更大的仓库里（例如与别的工具组合仓），也可以传仓根把整仓一起扫：
//     `node attachments/scripts/verify-source.mjs .`
// 退出码：0 = 全部通过；1 = 有失败项。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SELF = fileURLToPath(import.meta.url)
/** 本工具包根（`lib/` 所在处）—— ② 段的行为验证始终针对它，与扫描根无关。 */
const PKG_ROOT = path.resolve(path.join(HERE, '..'))
const ROOT = path.resolve(process.argv[2] ?? PKG_ROOT)
const SELF_REL = path.relative(ROOT, SELF).replace(/\\/g, '/')

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

const cfg = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'attach-config.mjs')).href)
const homeLib = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'dsh-home.mjs')).href)
const refsLib = await import(pathToFileURL(path.join(PKG_ROOT, 'lib', 'attach-refs.mjs')).href)

const ENV_KEYS = [
  'DSH_HOME', 'DSH_WORKSPACE', 'ATTACH_OBJECTS_ROOT', 'ATTACH_ATTACHMENTS_ROOT',
  'ATTACH_SESSION_ROOTS', 'ATTACH_SCAN_CACHE', 'ATTACH_RELAY_DIRS', 'ATTACH_LOCAL_SOURCES', 'ATTACH_REPORT_DIR',
]
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-tools-verify-'))
// 沙箱 home 用 `<临时目录>/.dsh` 形态：workspace 的推导判据是「home 的 basename 是 .dsh」，
// 用别的目录名会让该条断言恒不成立（那是判据本身的设计，不是缺陷）。
const sandbox = path.join(sandboxRoot, '.dsh')
fs.mkdirSync(sandbox, { recursive: true })
const savedEnv = { ...process.env }
for (const k of ENV_KEYS) delete process.env[k]

// ---- home / workspace
check('默认 home = <用户目录>/.dsh',
  homeLib.resolveDshHome() === path.join(os.homedir(), '.dsh'), homeLib.resolveDshHome())
process.env.DSH_HOME = sandbox
check('DSH_HOME 生效', homeLib.resolveDshHome() === path.resolve(sandbox))
check('DSH_HOME 来源标注 = env:DSH_HOME', homeLib.describeHomeSource() === 'env:DSH_HOME')
check('显式参数优先级最高', homeLib.resolveDshHome(path.join(sandbox, 'x')) === path.resolve(path.join(sandbox, 'x')))
check('空白取值视为未设置（不解析成 cwd）',
  (() => { process.env.DSH_HOME = '   '; const v = homeLib.resolveDshHome(); process.env.DSH_HOME = sandbox; return v === path.join(os.homedir(), '.dsh') })())
delete process.env.DSH_WORKSPACE
check('workspace：被重定向的 home 推导出同级目录',
  homeLib.resolveDshWorkspace() === path.resolve(sandboxRoot), homeLib.resolveDshWorkspace())
process.env.DSH_WORKSPACE = path.join(sandbox, 'ws')
check('DSH_WORKSPACE 覆盖推导', homeLib.resolveDshWorkspace() === path.resolve(path.join(sandbox, 'ws')))
delete process.env.DSH_WORKSPACE

// ---- 对象根
const defObj = cfg.resolveObjectsRoot({})
check('默认对象根 = <home>/attachments/v1/objects',
  defObj.value === path.join(path.resolve(sandbox), 'attachments', 'v1', 'objects') && defObj.from === 'default',
  defObj.value + ' ← ' + defObj.from)
process.env.ATTACH_OBJECTS_ROOT = path.join(sandbox, 'env-obj')
check('ATTACH_OBJECTS_ROOT 生效且来源标注正确',
  cfg.resolveObjectsRoot({}).from === 'env:ATTACH_OBJECTS_ROOT' && cfg.resolveObjectsRoot({}).value === path.resolve(path.join(sandbox, 'env-obj')))
check('CLI 参数 > 环境变量',
  cfg.resolveObjectsRoot({ cli: path.join(sandbox, 'cli-obj') }).value === path.resolve(path.join(sandbox, 'cli-obj'))
  && cfg.resolveObjectsRoot({ cli: path.join(sandbox, 'cli-obj') }).from === 'cli')
delete process.env.ATTACH_OBJECTS_ROOT

// ---- 会话根
check('会话根：目录不存在时返回空（由 CLI 判环境不可用）', cfg.resolveSessionRoots({}).roots.length === 0)
fs.mkdirSync(path.join(sandbox, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(sandbox, '_archived-sessions'), { recursive: true })
const defSes = cfg.resolveSessionRoots({})
check('会话根：默认两棵树（现役 + 归档）',
  defSes.roots.length === 2 && defSes.roots[0].name === 'sessions' && defSes.roots[1].name === '_archived-sessions',
  defSes.roots.map((r) => r.name).join(','))
const injSes = cfg.resolveSessionRoots({ cli: [path.join(sandbox, 'a'), path.join(sandbox, 'b')] })
check('会话根：注入即整体替换（保持顺序）',
  injSes.roots.length === 2 && injSes.from === 'cli' && injSes.roots[0].dir === path.resolve(path.join(sandbox, 'a')))
check('会话根：注入不要求目录已存在', cfg.resolveSessionRoots({ cli: [path.join(sandbox, 'nope')] }).roots.length === 1)
process.env.ATTACH_SESSION_ROOTS = [path.join(sandbox, 'x'), path.join(sandbox, 'y')].join(',')
check('会话根：环境变量注入（逗号分隔）',
  cfg.resolveSessionRoots({}).from === 'env:ATTACH_SESSION_ROOTS' && cfg.resolveSessionRoots({}).roots.length === 2)
delete process.env.ATTACH_SESSION_ROOTS

// ---- 缓存 / 报告目录
const defCache = cfg.resolveCacheFile({})
check('默认缓存 = <home>/attach-scan-cache.json',
  defCache.value === path.join(path.resolve(sandbox), 'attach-scan-cache.json'), path.basename(defCache.value))
process.env.ATTACH_SCAN_CACHE = path.join(sandbox, 'c.json')
check('ATTACH_SCAN_CACHE 生效', cfg.resolveCacheFile({}).value === path.resolve(path.join(sandbox, 'c.json')))
delete process.env.ATTACH_SCAN_CACHE

// ---- 中转目录 / 本机派生源
const defRelay = cfg.resolveRelayDirs({})
check('中转目录：默认一条候选（要求存在）',
  defRelay.from === 'default' && defRelay.requireExists === true && defRelay.dirs.length === 1, defRelay.dirs[0])
const injRelay = cfg.resolveRelayDirs({ cli: [path.join(sandbox, 'r1')] })
check('中转目录：注入即整体替换（不要求存在）',
  injRelay.from === 'cli' && injRelay.requireExists === false && injRelay.dirs[0] === path.resolve(path.join(sandbox, 'r1')))
const defLocal = cfg.resolveLocalSources({ home: sandbox, workspace: path.join(sandbox, 'ws') })
check('本机派生源：默认三条（含 workspace/generated）',
  defLocal.dirs.length === 3 && defLocal.dirs[2] === path.resolve(path.join(sandbox, 'ws', 'generated')), defLocal.from)
const injLocal = cfg.resolveLocalSources({ home: sandbox, workspace: path.join(sandbox, 'ws'), cli: [path.join(sandbox, 'extra')] })
check('本机派生源：注入为**追加**（默认在前、注入在后）',
  injLocal.dirs.length === 4 && injLocal.dirs[3] === path.resolve(path.join(sandbox, 'extra')), injLocal.from)

// ---- 报告目录 / 描述层
process.env.ATTACH_REPORT_DIR = path.join(sandbox, 'reports')
check('报告目录可注入', cfg.resolveReportDir({}).value === path.resolve(path.join(sandbox, 'reports')))
delete process.env.ATTACH_REPORT_DIR
check('报告文件名可排序（ISO 时间戳形态）', /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-report\.json$/.test(cfg.reportFileName(new Date('2026-01-02T03:04:05Z'))))
const desc = cfg.describeResolution({ home: sandbox })
check('describeResolution：每个值都带来源标注',
  ['home', 'workspace', 'objectsRoot', 'sessionsRoots', 'cache', 'relayDirs', 'localSources', 'reportDir']
    .every((k) => typeof desc[k]?.from === 'string' && desc[k].from.length > 0))
check('formatResolution：人读输出含「来源」箭头',
  cfg.formatResolution(desc).includes('←'), '')

// ---- 多值环境变量拆分（三种分隔符都必须认）
{
  process.env.__ATTACH_SPLIT_PROBE = 'aa,bb;cc|dd'
  const sp = cfg.envList('__ATTACH_SPLIT_PROBE')
  delete process.env.__ATTACH_SPLIT_PROBE
  check('多值拆分：逗号 / 分号 / 竖线都认', sp.join(',') === 'aa,bb,cc,dd', sp.join(','))
  process.env.__ATTACH_SPLIT_PROBE = 'a,,  ,b'
  const sp2 = cfg.envList('__ATTACH_SPLIT_PROBE')
  delete process.env.__ATTACH_SPLIT_PROBE
  check('多值拆分：空项与空白项被丢掉', sp2.join(',') === 'a,b', JSON.stringify(sp2))
}

// ---- 口径库自检（sha 形态 / 帧切分 / 会话 id 归一）
check('sha 归一：接受裸值 / 前缀 / 大写',
  refsLib.normalizeSha('A'.repeat(64)) === 'a'.repeat(64)
  && refsLib.normalizeSha('sha256:' + 'b'.repeat(64)) === 'b'.repeat(64)
  && refsLib.normalizeSha('zz') === null)
check('对象路径 = <root>/<前2位>/<sha>',
  refsLib.objectPathFor(path.join(sandbox, 'o'), 'abcdef' + '0'.repeat(58)) === path.join(sandbox, 'o', 'ab', 'abcdef' + '0'.repeat(58)))
check('会话 id 归一：接受带前缀与裸 guid，拒绝非 guid',
  refsLib.normalizeSessionId('session-' + 'a'.repeat(8) + '-bbbb-cccc-dddd-' + 'e'.repeat(12)) === 'a'.repeat(8) + '-bbbb-cccc-dddd-' + 'e'.repeat(12)
  && refsLib.normalizeSessionId('not-an-id') === null)

// ---- 恢复环境 / 清理沙箱
for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v
try { fs.rmSync(sandboxRoot, { recursive: true, force: true }) } catch { /* ignore */ }
check('配置层验证沙箱已清理', !fs.existsSync(sandboxRoot))

// ---------------------------------------------------------------- ③ 脱敏扫描

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

// 通用形态规则：与具体机器无关，永远生效。
// ⚠️ 三条形态规则的设计约束：
//   · 绝对路径 / 用户目录：用「负向断言」放过占位符形态（`<...>` / `%VAR%` / `${...}`），
//     否则跨平台惯例写法（`%APPDATA%\npm`、`/usr/local/...`）会被误判；
//   · 短十六进制串：**必须排除 UUID 段** —— 任何 guid 的前 8 位都是 8 个 hex 字符，
//     不排除就会把标准的 uuid 当成「内部编号」误报。判据 = 前后不接 `-` 或 hex 字符。
const PATTERNS = [
  [/[\\/]Users[\\/](?!<|\$\{|%|<user>)[A-Za-z0-9._-]{2,}/, 'user profile dir'],
  [/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/](?!<|\$\{|%|<path>)[^\s'"`<>|?*]{2,}/, 'absolute windows path'],
  [/(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f-])/, 'short hex id shape'],
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
// 无扩展名的常见文本文件（`LICENSE` / `.gitignore` 这类）
const NO_EXT_TEXT = new Set(['LICENSE', 'LICENCE', 'COPYING', 'NOTICE', '.gitignore', '.npmignore'])
// 扫描范围 = 全部代码文件 + **整棵树里的全部文本文件**（不是只挑固定文件名）。
// ⚠️ 只挑固定名会形成「假安全」：子目录里的 README / CHANGELOG / package.json / LICENSE
//    会被静默漏掉 —— 所以这里按扩展名/文件名白名单**递归全收**。
const scanTargets = [...codeFiles]
{
  const stack = [ROOT]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.backups') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      if (scanTargets.includes(full)) continue
      if (TEXT_LIKE.has(path.extname(e.name)) || NO_EXT_TEXT.has(e.name)) scanTargets.push(full)
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
      check(`脱敏 ${rel}:${i + 1} [${label}]`, false, lines[i].trim().slice(0, 120))
    }
  }
}
check(`脱敏扫描完成（${scanTargets.length - (scanTargets.some((f) => path.relative(ROOT, f).replace(/\\/g, '/') === SELF_REL) ? 1 : 0)} 文件 / ${scannedLines} 行 / 命中 ${scanHits}）`, scanHits === 0)

// 自检：**扫描器自己**不许夹带注入类标识（私人称呼 / 内部专有名 / 机器名 / 用户名 / 同步产品名）。
// 这些是「只有发布环境才知道的标识」，规则文本里本来就不该出现 —— 通用规则扫不了自身（规则文本
// 必然含形态样例），所以这里单独用注入规则再扫一遍，把「脚本自身已复核」变成可复跑断言。
// 注意：未注入时 INJECTED_PATTERNS 为空 ⇒ 本段是空判（会打印提示），发布前务必带全 BUILD_* 复跑。
if (fs.existsSync(SELF)) {
  const selfText = fs.readFileSync(SELF, 'utf8')
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
