// closure-check.mjs —— 依赖闭包链接指向体检（**只读** CLI）
//
// 干净态判据：链接层里每个链接都指向「期望闭包根」（默认 = 全局 npm 安装的宿主自带
//   `node_modules`，自动探测）。命中污染特征（默认特征 = 指向**另一个 DSH 安装**的依赖目录）
//   记为 🔴；目标不存在的链接记为断链 🟡。
//
// 用法：
//   node closure-check.mjs                        # 人读报告
//   node closure-check.mjs --json                 # 机器读（含全量污染清单 + 路径解析结果）
//   node closure-check.mjs --print-config         # 只打印路径解析结果与来源（排障）
//   node closure-check.mjs --samples 10           # 样例条数（默认 10）
//   node closure-check.mjs --link-root <dir>      # 覆盖链接层（默认 <DSH home>/profiles/node_modules）
//   node closure-check.mjs --home <dir>           # 同上（旧名，保留兼容）
//   node closure-check.mjs --source-root <dir>    # 覆盖期望闭包根（默认自动探测）
//   node closure-check.mjs --source <dir>         # 同上（旧名，保留兼容）
//   node closure-check.mjs --pollution-pattern <正则>   # 覆盖污染特征（可重复；整体替换默认值）
//   node closure-check.mjs --quiet                # 只打判定结果行
//
// 环境变量：CLOSURE_LINK_ROOT / CLOSURE_SOURCE_ROOT / CLOSURE_POLLUTION_PATTERNS /
//          DSH_HOME / BUTLER_DSH_HOME / DSH_PROFILES_HOME（见 README §4）
//
// 退出码：0 干净 / 1 有污染（🔴）/ 2 有断链（🟡）/ 3 环境不可用
// 只读：不写任何文件、不改任何链接、不删任何东西。
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scanClosureLinks, attributePollution, formatAttributionLine, formatRepairLines, repairCommands,
} from './lib/closure-links.mjs'
import {
  resolveLinkRoot, resolveSourceRoot, resolvePollutionPatterns, describeResolution, compilePollutionPatterns,
} from './lib/runtime-config.mjs'

const USAGE = [
  'usage: closure-check.mjs [选项]',
  '',
  '  依赖闭包链接指向体检（只读）。链接层里每个链接都应指向「期望闭包根」；',
  '  命中污染特征（默认 = 指向另一个 DSH 安装的依赖目录）判 🔴，目标不存在判断链 🟡。',
  '',
  '  --link-root <dir>            链接层（默认 <DSH home>/profiles/node_modules）',
  '  --source-root <dir>          期望闭包根（默认自动探测全局 npm 主包自带 node_modules）',
  '  --pollution-pattern <正则>   污染特征（可重复；给了就整体替换内置默认）',
  '  --samples <n>                样例条数（默认 10）',
  '  --json                       输出 JSON（含全量清单 + 路径解析）',
  '  --print-config               只打印路径解析结果与来源',
  '  --quiet                      只打判定结果行',
  '  --help                       本帮助',
  '',
  '  退出码: 0 干净 / 1 有污染 / 2 有断链 / 3 环境不可用',
].join('\n')

function parseArgs(list) {
  const out = {
    linkRoot: null, sourceRoot: null, samples: 10, json: false, printConfig: false,
    quiet: false, help: false, pollutionPatterns: [], error: null,
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const need = () => {
      const v = list[i + 1]
      if (v === undefined || String(v).startsWith('--')) { out.error = `${a} 缺取值`; return null }
      i += 1
      return v
    }
    if (a === '--link-root' || a === '--home') { const v = need(); if (v === null) return out; out.linkRoot = v }
    else if (a === '--source-root' || a === '--source') { const v = need(); if (v === null) return out; out.sourceRoot = v }
    else if (a === '--pollution-pattern') { const v = need(); if (v === null) return out; out.pollutionPatterns.push(v) }
    else if (a === '--samples') { const v = need(); if (v === null) return out; const n = Number.parseInt(v, 10); out.samples = Number.isFinite(n) && n >= 0 ? n : out.samples }
    else if (a === '--json') out.json = true
    else if (a === '--print-config') out.printConfig = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') out.help = true
    else { out.error = `未知参数: ${a}`; return out }
  }
  return out
}

const isMain = (() => {
  try {
    const a = realpathSync(process.argv[1])
    const b = realpathSync(fileURLToPath(import.meta.url))
    return a === b
  } catch {
    return false
  }
})()

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE + '\n')
  } else if (args.error) {
    process.stderr.write(args.error + '\n' + USAGE + '\n')
    process.exitCode = 2
  } else {
    let pollutionPatterns = null
    try {
      pollutionPatterns = args.pollutionPatterns.length
        ? compilePollutionPatterns(args.pollutionPatterns)
        : resolvePollutionPatterns()
    } catch (e) {
      process.stderr.write(`${e?.message ?? e}\n`)
      process.exitCode = 2
    }

    if (pollutionPatterns && args.printConfig) {
      process.stdout.write(JSON.stringify(describeResolution({
        cli: args.linkRoot, sourceRoot: args.sourceRoot, pollutionPatterns: args.pollutionPatterns,
      }), null, 2) + '\n')
    } else if (pollutionPatterns) {
      const linkRoot = resolveLinkRoot({ cli: args.linkRoot })
      const sourceRoot = resolveSourceRoot({ cli: args.sourceRoot })
      const scan = scanClosureLinks({
        linkRoot: resolve(linkRoot),
        sourceRoot: sourceRoot ? resolve(sourceRoot) : null,
        pollutionPatterns,
      })
      const levelCode = scan.level === 'danger' ? 1 : scan.level === 'warn' ? 2 : 0

      if (args.json) {
        process.stdout.write(JSON.stringify({
          ...scan,
          polluted: scan.polluted.map((l) => ({ rel: l.rel, target: l.target, targetExists: l.targetExists, pollutionIds: l.pollutionIds ?? [] })),
          config: describeResolution({ cli: args.linkRoot, sourceRoot: args.sourceRoot, pollutionPatterns: args.pollutionPatterns }),
          // 归因（谁改的）+ 可用修法命令（探测式，不含任何写死路径）
          attribution: attributePollution(scan.polluted, pollutionPatterns),
          repair: repairCommands(),
        }, null, 2) + '\n')
        process.exitCode = scan.ok ? levelCode : 3
      } else if (args.quiet) {
        process.stdout.write('[判定] ' + (scan.level === 'danger' ? '🔴 有污染' : scan.level === 'warn' ? '🟡 有断链' : '✅ 干净')
          + (scan.ok ? `（链接 ${scan.total} / 指向期望闭包 ${scan.matched} / 污染 ${scan.polluted.length} / 断链 ${scan.broken.length}）` : `（${scan.reason}）`) + '\n')
        process.exitCode = scan.ok ? levelCode : 3
      } else {
        console.log('=== 依赖闭包链接指向体检（只读）===')
        console.log('链接层     : ' + scan.linkRoot)
        console.log('物理目录   : ' + (scan.physicalRoot || 'N/A'))
        console.log('期望闭包   : ' + (scan.sourceRoot || 'N/A'))
        console.log('污染特征   : ' + pollutionPatterns.map((p) => p.id).join(', '))
        if (!scan.ok) {
          console.log('结果       : 环境不可用（' + (scan.reason || 'unknown') + '）')
          process.exitCode = 3
        } else {
          console.log('链接总数   : ' + scan.total)
          console.log('  指向期望闭包 : ' + scan.matched)
          console.log('  命中污染特征(🔴) : ' + scan.polluted.length)
          console.log('  断链(🟡)     : ' + scan.broken.length)
          console.log('  其他目标     : ' + scan.other.length)
          if (scan.polluted.length > 0) {
            console.log('\n--- 污染链接（前 ' + args.samples + ' 条）---')
            for (const l of scan.polluted.slice(0, args.samples)) {
              console.log('  ' + l.rel)
              console.log('     -> ' + l.target + (l.targetExists ? '' : '   [目标不存在]'))
            }
            if (scan.polluted.length > args.samples) console.log('  ... 共 ' + scan.polluted.length + ' 个')
            const attr = formatAttributionLine(scan, pollutionPatterns)
            if (attr) console.log('\n' + attr)
            for (const line of formatRepairLines(scan)) console.log(line)
          }
          if (scan.broken.length > 0) {
            console.log('\n--- 断链（前 ' + args.samples + ' 条）---')
            for (const l of scan.broken.slice(0, args.samples)) console.log('  ' + l.rel + ' -> ' + l.target)
            if (scan.broken.length > args.samples) console.log('  ... 共 ' + scan.broken.length + ' 个')
          }
          console.log('\n[判定] ' + (scan.level === 'danger' ? '🔴 有污染' : scan.level === 'warn' ? '🟡 有断链' : '✅ 干净'))
          process.exitCode = levelCode
        }
      }
    }
  }
}
