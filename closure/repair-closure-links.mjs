// repair-closure-links.mjs —— 依赖闭包链接指向重建（**默认 dry-run，只读**）
//
// 它治什么：链接层里出现「指向受污染闭包」的链接（典型：同机另一个 DSH 安装的依赖目录）时，
//   把每条链接**重建为期望闭包里的同名包**；期望闭包没有同名包时**只删链接、不造物**。
//
// 【判据同源（不另造一套）】扫描 / 分类 / 污染特征**全部复用** `lib/closure-links.mjs`：
//   `scanClosureLinks()` 判「命中污染特征」（= polluted）、「断链」（= broken）、「指向期望闭包」
//   （matched = 目标以期望闭包根开头）。本脚本只做修法。
//
// 【修法（逐条、可证、不猜）】
//   对每条 polluted 链接：目标候选 ① 期望闭包 `<sourceRoot>/<rel>` → ② 全局 npm 顶层 `<npmRoot>/<rel>`
//   （主包本体等）；命中 → 重建为该目标；**都不命中 → 只删链接**（期望闭包里没有同名包时，按包名
//   "重建"是凭空造物，绝不做）。断链（broken）**跳过不动**、只统计。
//
// 【安全护栏（junction 跟删坑）】
//   · 只处理 `lstat().isSymbolicLink()` 为真的条目；**不是链接一律拒删**（绝不递归删含 junction 的父目录）；
//   · 删链接只作用于链接本身（`unlinkSync` → `rmdirSync` → Windows `rd` 兜底，都不是递归删）；
//   · 每删一条都断言"链接本体已消失 **且** 原目标仍在"（目标被连带删 = 立刻报错）；
//   · 全程不出现 `{recursive:true}`；`--apply` 前要求 linkRoot/sourceRoot 均可解析（判不了就不动手）。
//
// 用法（**默认 = dry-run 只读**）：
//   node repair-closure-links.mjs                      # 只读：列出计划，不写任何文件
//   node repair-closure-links.mjs --json               # 机器读
//   node repair-closure-links.mjs --verify             # 只读自校验：污染是否为 0（退出码 0/1）
//   node repair-closure-links.mjs --print-config       # 打印路径解析结果与来源（排障）
//   node repair-closure-links.mjs --apply              # 真执行（先写回滚清单 → 逐条处理 → 复扫）
//   node repair-closure-links.mjs --rollback <清单.json>  # 一键还原（relink 改回、remove 重建）
//   覆盖项：--link-root <dir> / --source-root <dir> / --npm-root <dir> / --archive-root <dir>
//          / --pollution-pattern <正则>（可重复）/ --samples N
//
// 退出码：0 = 无需修复 / 已修复且复扫干净 / 校验通过；1 = 有失败或复扫仍有污染；2 = 用法错误；3 = 环境不可用。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanClosureLinks, defaultLinkRoot, defaultSourceRoot } from './lib/closure-links.mjs';
import { resolvePollutionPatterns, resolveNpmRoot, describeResolution } from './lib/runtime-config.mjs';

export const SCRIPT_ID = 'repair-closure-links';
export const SCRIPT_VERSION = '1.0.0';

/** 脚本所在目录（realpath —— 路径里有 junction 时才不会跑偏）。 */
const SELF_DIR = (() => {
  try { return path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))); } catch { return path.dirname(fileURLToPath(import.meta.url)); }
})();
/** 包根（本脚本住在包根；默认备份目录 = `<包根>/.backups/`，可用 `CLOSURE_ARCHIVE_ROOT` 改）。 */
export const PKG_ROOT = SELF_DIR;

const norm = (p) => path.resolve(String(p)).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const sha256 = (file) => {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
};
/** rel（`@scope/name` 或 `name`）→ 平台路径片段。 */
export function relToPath(rel) { return String(rel).split('/').join(path.sep); }

/**
 * 全局 npm 顶层根（次级候选：主包本体住这儿）。
 * 跨平台自动探测（`%APPDATA%\npm\node_modules` / `~/.npm-global/lib/node_modules` / `/usr/local/lib/node_modules` …），
 * 也可用 `CLOSURE_NPM_ROOT` 或 `--npm-root` 注入。
 */
export function defaultNpmRoot(env = process.env) {
  return resolveNpmRoot({ env });
}

const lstatQuiet = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const existsLstat = (p) => lstatQuiet(p) !== null;

/**
 * 删掉**链接本体**（绝不递归、绝不碰目标）。
 * 顺序：unlinkSync（文件重解析点）→ rmdirSync（目录链接 / junction，只摘链接）→ `cmd rd` 兜底。
 * 每条都做双断言：链接已消失 **且**（原本存在的）目标仍在。
 * @returns {{ok:boolean, reason:string, target:string|null, targetKept:boolean}}
 */
export function removeLink(full) {
  const st = lstatQuiet(full);
  if (!st) return { ok: true, reason: 'already-gone', target: null, targetKept: true };
  if (!st.isSymbolicLink()) return { ok: false, reason: 'not-a-link（拒删：防 junction/目录跟删）', target: null, targetKept: true };
  let target = null;
  try { target = fs.readlinkSync(full); } catch { target = null; }
  const targetExisted = target ? fs.existsSync(target) : false;

  let lastErr = null;
  const attempts = [
    () => fs.unlinkSync(full),
    () => fs.rmdirSync(full),
  ];
  // Windows 兜底：目录链接偶有 unlink/rmdir 都拒的情形（`rd` 是**非递归**删除，只摘链接本体）
  if (process.platform === 'win32') {
    attempts.push(() => { const r = spawnSync('cmd', ['/c', 'rd', full], { windowsHide: true, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`rd 退出码 ${r.status}：${String(r.stderr ?? '').trim()}`); });
  }
  for (const fn of attempts) {
    try { fn(); lastErr = null; break; } catch (e) { lastErr = e; }
  }
  const gone = !existsLstat(full);
  const targetKept = targetExisted ? fs.existsSync(target) : true;
  if (lastErr && !gone) return { ok: false, reason: `删除失败：${lastErr?.message ?? lastErr}`, target, targetKept };
  if (!gone) return { ok: false, reason: '删除后链接仍存在', target, targetKept };
  if (!targetKept) return { ok: false, reason: `⚠️ 目标被连带删除：${target}`, target, targetKept };
  return { ok: true, reason: 'removed', target, targetKept };
}

/**
 * 规划修复（纯函数，**零写入**）。
 * @param {{polluted:Array<object>}} scan
 * @returns {{items:Array<object>, skipped:Array<object>}}
 */
export function planRepairs(scan, opts = {}) {
  const linkRoot = opts.linkRoot;
  const sourceRoot = opts.sourceRoot;
  const npmRoot = opts.npmRoot ?? defaultNpmRoot();
  const rootNorm = norm(linkRoot);
  const items = [];
  const skipped = [];
  for (const l of scan?.polluted ?? []) {
    const full = String(l.full ?? '');
    if (!full || norm(full) === rootNorm || !norm(full).startsWith(rootNorm + '\\')) {
      skipped.push({ rel: l.rel, full, reason: 'outside-link-root（拒绝操作链接层之外的路径）' });
      continue;
    }
    const st = lstatQuiet(full);
    if (!st) { skipped.push({ rel: l.rel, full, reason: 'not-found' }); continue; }
    if (!st.isSymbolicLink()) { skipped.push({ rel: l.rel, full, reason: 'not-a-link' }); continue; }
    const relPath = relToPath(l.rel);
    const cands = [];
    if (sourceRoot) cands.push({ kind: 'sourceRoot', target: path.join(sourceRoot, relPath) });
    if (npmRoot) cands.push({ kind: 'npmRoot', target: path.join(npmRoot, relPath) });
    const hit = cands.find((c) => { try { return fs.statSync(c.target).isDirectory(); } catch { return false; } });
    if (hit) {
      if (norm(hit.target) === norm(full)) { skipped.push({ rel: l.rel, full, reason: 'self-reference（不改）' }); continue; }
      items.push({ rel: l.rel, full, action: 'relink', oldTarget: l.target, newTarget: hit.target, source: hit.kind });
    } else {
      items.push({ rel: l.rel, full, action: 'remove', oldTarget: l.target, newTarget: null, source: null });
    }
  }
  return { items, skipped };
}

// ---------------------------------------------------------------- CLI
export function parseArgs(argv = []) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const boolFlags = new Set(['--apply', '--dry-run', '--verify', '--json', '--help', '-h', '--quiet', '--yes', '--print-config']);
  const valueFlags = new Set(['--link-root', '--source-root', '--npm-root', '--archive-root', '--rollback', '--samples', '--pollution-pattern']);
  const out = {
    apply: false, verify: false, json: false, quiet: false, help: false, printConfig: false,
    linkRoot: null, sourceRoot: null, npmRoot: null, archiveRoot: null, rollback: null,
    pollutionPatterns: [], samples: 8, unknown: [],
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--verify') { out.verify = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--print-config') { out.printConfig = true; continue; }
    if (a === '--quiet' || a === '--yes') { out.quiet = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--dry-run') continue;
    if (valueFlags.has(a)) {
      const v = list[i + 1];
      i += 1;
      if (v === undefined || boolFlags.has(v) || valueFlags.has(v)) { out.unknown.push(`${a}（缺取值）`); continue; }
      if (a === '--link-root') out.linkRoot = v;
      else if (a === '--source-root') out.sourceRoot = v;
      else if (a === '--npm-root') out.npmRoot = v;
      else if (a === '--archive-root') out.archiveRoot = v;
      else if (a === '--rollback') out.rollback = v;
      else if (a === '--pollution-pattern') out.pollutionPatterns.push(v);
      else out.samples = Number.parseInt(v, 10) >= 0 ? Number.parseInt(v, 10) : out.samples;
      continue;
    }
    out.unknown.push(a);
  }
  return out;
}

export function usage() {
  return [
    'repair-closure-links —— 依赖闭包链接指向重建（默认 dry-run，只读）',
    '',
    '  node repair-closure-links.mjs                 只读：列出计划（DRY-RUN，默认）',
    '  node repair-closure-links.mjs --json          机器读',
    '  node repair-closure-links.mjs --verify        只读自校验：污染是否已归零',
    '  node repair-closure-links.mjs --print-config  打印路径解析结果与来源（排障）',
    '  node repair-closure-links.mjs --apply         真执行（写回滚清单 → 逐条重建/删除 → 复扫）',
    '  node repair-closure-links.mjs --rollback <清单.json>   按回滚清单还原',
    '  覆盖项：--link-root <dir>（默认 <DSH home>/profiles/node_modules）/ --source-root <dir>',
    '          / --npm-root <dir> / --archive-root <dir>',
    '          / --pollution-pattern <正则>（可重复，整体替换内置污染特征）/ --samples N',
    '',
    '  边界：只动「命中污染特征」的那些链接**本身**；断链跳过不动；期望闭包无同名包 → 只删链接不重建。',
    '  退出码：0 正常 / 1 有失败或复扫仍有污染 / 2 用法 / 3 环境不可用。',
    '',
  ].join('\n');
}

function archiveRootOf(args, now) {
  if (args.archiveRoot) return path.resolve(args.archiveRoot);
  const envRoot = String(process.env.CLOSURE_ARCHIVE_ROOT ?? '').trim();
  if (envRoot) return path.resolve(envRoot);
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date(now);
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return path.join(PKG_ROOT, '.backups', `closure-link-repair-${ts}`);
}

/** 扫描（判据源 = lib/closure-links.mjs，不另造一套）。 */
export function scanNow(args = {}) {
  const linkRoot = path.resolve(args.linkRoot ?? defaultLinkRoot());
  const sourceRoot = args.sourceRoot ? path.resolve(args.sourceRoot) : defaultSourceRoot();
  const pollutionPatterns = resolvePollutionPatterns({ cli: args.pollutionPatterns });
  const scan = scanClosureLinks({ linkRoot, sourceRoot, pollutionPatterns });
  return { ...scan, linkRoot, sourceRoot };
}

/** 真执行（唯一写点）：回滚清单 → 逐条处理 → 复扫。 */
export function applyRepair(args, opts = {}) {
  const now = opts.now ?? Date.now();
  const scan = opts.scan ?? scanNow(args);
  if (!scan.ok) return { ok: false, error: `扫描不可用：${scan.reason}`, written: 0, failed: 0, items: [], verify: null, rollbackFile: null };
  if (!scan.sourceRoot) return { ok: false, error: '期望闭包根不可解析（%APPDATA% 缺失）→ 判不了"修完对"，拒绝动手', written: 0, failed: 0, items: [], verify: null, rollbackFile: null };
  const plan = planRepairs(scan, { linkRoot: scan.linkRoot, sourceRoot: scan.sourceRoot });

  const arch = archiveRootOf(args, now);
  fs.mkdirSync(arch, { recursive: true });
  const rollbackFile = path.join(arch, `rollback-${now}.json`);
  fs.writeFileSync(rollbackFile, JSON.stringify({
    schemaVersion: 1, script: SCRIPT_ID, version: SCRIPT_VERSION, createdAt: new Date(now).toISOString(),
    linkRoot: scan.linkRoot, sourceRoot: scan.sourceRoot,
    beforeScan: { total: scan.total, matched: scan.matched, polluted: scan.polluted.length, broken: scan.broken.length, other: scan.other.length },
    entries: plan.items.map((i) => ({ rel: i.rel, full: i.full, action: i.action, oldTarget: i.oldTarget, newTarget: i.newTarget })),
  }, null, 2) + '\n', 'utf8');

  const results = [];
  for (const it of plan.items) {
    const row = { rel: it.rel, full: it.full, action: it.action, oldTarget: it.oldTarget, newTarget: it.newTarget, ok: false, error: null, removed: null };
    if (it.action === 'relink') {
      const rm = removeLink(it.full);
      row.removed = rm;
      if (!rm.ok) { row.error = rm.reason; results.push(row); continue; }
      try {
        fs.symlinkSync(it.newTarget, it.full, 'junction');
        const back = (() => { try { return fs.readlinkSync(it.full); } catch { return null; } })();
        if (norm(back) !== norm(it.newTarget)) { row.error = `重建后指向不符（${back}）`; } else { row.ok = true; }
      } catch (e) {
        row.error = `重建失败：${e?.message ?? e}`;
      }
    } else {
      const rm = removeLink(it.full);
      row.removed = rm;
      row.ok = rm.ok;
      if (!rm.ok) row.error = rm.reason;
    }
    results.push(row);
  }

  const after = scanNow(args);
  const verify = { ok: after.ok === true && after.polluted.length === 0, polluted: after.polluted.length, broken: after.broken.length, matched: after.matched, total: after.total, level: after.level };
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0 && verify.ok, written: results.filter((r) => r.ok).length, failed, items: results, skipped: plan.skipped, verify, rollbackFile };
}

/** 按回滚清单还原（relink 项改回 oldTarget；remove 项重建 oldTarget —— 目标不在就报告，不造物）。 */
export function rollbackFrom(rollbackFile) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(rollbackFile, 'utf8')); } catch (e) { return { ok: false, error: `回滚清单不可读：${e?.message ?? e}`, items: [] }; }
  const entries = Array.isArray(rec.entries) ? rec.entries : [];
  const items = [];
  for (const e of entries) {
    const row = { rel: e.rel, action: e.action, ok: false, error: null };
    if (!e.oldTarget) { row.error = '清单缺 oldTarget'; items.push(row); continue; }
    try {
      if (e.action === 'relink') {
        const rm = removeLink(e.full);
        if (!rm.ok) { row.error = rm.reason; items.push(row); continue; }
        fs.symlinkSync(e.oldTarget, e.full, 'junction');
        row.ok = true;
      } else if (e.action === 'remove') {
        let st = null; try { st = fs.statSync(e.oldTarget).isDirectory(); } catch { st = false; }
        if (!st) { row.error = `原目标已不存在，按"不造物"跳过：${e.oldTarget}`; items.push(row); continue; }
        fs.symlinkSync(e.oldTarget, e.full, 'junction');
        row.ok = true;
      } else { row.error = `未知 action：${e.action}`; }
    } catch (err) { row.error = String(err?.message ?? err); }
    items.push(row);
  }
  return { ok: items.every((i) => i.ok), items, linkRoot: rec.linkRoot, sourceRoot: rec.sourceRoot };
}

async function cliMain(argv) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage()); return 0; }
  if (args.unknown.length) { process.stderr.write(`未知参数：${args.unknown.join(' ')}\n${usage()}`); return 2; }
  if (args.printConfig) {
    process.stdout.write(JSON.stringify(describeResolution({
      cli: args.linkRoot, sourceRoot: args.sourceRoot, npmRoot: args.npmRoot, env: process.env,
    }), null, 2) + '\n');
    return 0;
  }
  if (args.rollback) {
    const r = rollbackFrom(path.resolve(args.rollback));
    const lines = [`[${SCRIPT_ID}] 回滚：${r.items.length} 项`];
    for (const i of r.items) lines.push(`  ${i.ok ? '✓' : '✗'} ${i.action} ${i.rel}${i.error ? ` —— ${i.error}` : ''}`);
    lines.push(r.ok ? '  结果：全部还原' : '  结果：有失败（见上）');
    process.stdout.write(lines.join('\n') + '\n');
    return r.ok ? 0 : 1;
  }

  const scan = scanNow(args);
  if (!scan.ok) {
    process.stdout.write(`[${SCRIPT_ID}] 环境不可用（${scan.reason}）：linkRoot=${scan.linkRoot}\n`);
    return 3;
  }

  if (args.verify) {
    const ok = scan.polluted.length === 0;
    process.stdout.write([
      `[${SCRIPT_ID}] --verify：${scan.linkRoot}`,
      `  链接 ${scan.total} / 指向生产闭包 ${scan.matched} / **污染 ${scan.polluted.length}** / 断链 ${scan.broken.length} / 其他 ${scan.other.length}`,
      `  判定：${ok ? '✅ 污染已归零' : '❌ 仍有指向受污染闭包的链接'}（level=${scan.level}）`,
      '',
    ].join('\n'));
    return ok ? 0 : 1;
  }

  const plan = planRepairs(scan, { linkRoot: scan.linkRoot, sourceRoot: scan.sourceRoot });
  const relink = plan.items.filter((i) => i.action === 'relink');
  const remove = plan.items.filter((i) => i.action === 'remove');

  const lines = [];
  lines.push(`[${SCRIPT_ID}] 模式：${args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（只读，默认）'}`);
  lines.push(`  链接层   : ${scan.linkRoot}`);
  lines.push(`  期望闭包 : ${scan.sourceRoot ?? '(不可解析)'}`);
  lines.push(`  统计     : 链接 ${scan.total} / 指向生产闭包 ${scan.matched} / 污染 ${scan.polluted.length} / 断链 ${scan.broken.length}（跳过不动） / 其他 ${scan.other.length}`);
  lines.push(`  计划     : 重建指向 ${relink.length} 项；删除（生产闭包无同名包 → 不造物）${remove.length} 项`);
  for (const it of plan.items.slice(0, Math.max(args.samples, plan.items.length))) {
    lines.push(`    ${it.action === 'relink' ? 'relink' : 'remove'} ${it.rel}`);
    lines.push(`        ${it.oldTarget}`);
    if (it.newTarget) lines.push(`     → ${it.newTarget}   [${it.source}]`);
  }
  for (const s of plan.skipped.slice(0, args.samples)) lines.push(`    · 跳过 ${s.rel}（${s.reason}）`);

  if (plan.items.length === 0) {
    lines.push('  结果     : 幂等——无需修复（污染 0），未写任何文件');
    if (args.json) process.stdout.write(JSON.stringify({ mode: 'dry-run', ...scan, items: [], skipped: plan.skipped }, null, 2) + '\n');
    else process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  if (!args.apply) {
    if (args.json) process.stdout.write(JSON.stringify({ mode: 'dry-run', linkRoot: scan.linkRoot, sourceRoot: scan.sourceRoot, total: scan.total, matched: scan.matched, polluted: scan.polluted.length, broken: scan.broken.length, items: plan.items, skipped: plan.skipped, wouldWrite: plan.items.length }, null, 2) + '\n');
    else { lines.push('  结果     : DRY-RUN —— 未写任何文件；确认后加 --apply'); process.stdout.write(lines.join('\n') + '\n'); }
    return 0;
  }

  const r = applyRepair(args, { scan });
  if (r.error) lines.push(`  失败     : ${r.error}`);
  lines.push(`  回滚清单 : ${r.rollbackFile ?? '（无）'}`);
  lines.push(`  已处理   : 成功 ${r.written} / 失败 ${r.failed}`);
  for (const it of r.items) lines.push(`    ${it.ok ? '✓' : '✗'} ${it.action} ${it.rel}${it.error ? ` —— ${it.error}` : ''}`);
  lines.push(`  复扫     : ${r.verify ? `污染 ${r.verify.polluted} / 断链 ${r.verify.broken} / level=${r.verify.level} → ${r.verify.ok ? '✅ 干净' : '❌ 仍有污染'}` : '（无）'}`);
  if (r.rollbackFile) lines.push(`  回滚命令 : node "${path.join(SELF_DIR, path.basename(fileURLToPath(import.meta.url)))}" --rollback "${r.rollbackFile}"`);
  if (args.json) process.stdout.write(JSON.stringify({ mode: 'apply', ...r }, null, 2) + '\n');
  else process.stdout.write(lines.join('\n') + '\n');
  return r.ok ? 0 : 1;
}

const isMainEntry = (() => {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return Boolean(argv1) && argv1 === self;
  } catch { return false; }
})();

if (isMainEntry) {
  cliMain(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => { process.stderr.write(`[${SCRIPT_ID}] 失败：${e?.stack ?? e}\n`); process.exitCode = 1; });
}
