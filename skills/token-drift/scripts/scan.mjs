#!/usr/bin/env node
/**
 * Find design-token drift: hard-coded colors, spacing, font sizes, radii,
 * shadows, z-indexes and durations that bypass the project's tokens.
 *
 *   node scan.mjs [dir] [--tokens path] [--json] [--md] [--fix[=near]] [--dry-run]
 *                 [--propose] [--threshold color=4,size=2,pct=10] [--include/--exclude glob]
 *                 [--fail-under 90] [--out dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError, walk, rel, shown, c, lineIndex, plural, isTestPath } from './lib/util.mjs';
import { loadTokens, CATEGORIES } from './tokens.mjs';
import { extractFile, makeIgnore, isGenerated, SCAN_EXTS } from './lib/extract.mjs';
import { buildIndex, classify, parseThresholds } from './lib/match.mjs';
import { propose } from './lib/propose.mjs';
import { printSummary, writeReports, toJson, unifiedDiff, STATUS } from './lib/report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const HELP = `token-drift · scan.mjs — audit design-token drift

Usage
  node scan.mjs [dir] [options]

Report
  --json                 Print the full JSON report to stdout (instead of the summary).
  --md                   Print the Markdown report to stdout.
  --out <dir>            Where report.md / report.json / swatches go (default ./.knack/token-drift).
  --fail-under <pct>     Exit 1 when the drift score is below <pct> (CI guard).

Fixing
  --fix                  Rewrite EXACT matches to their token reference (CSS → var(--x),
                         SCSS → $x, Tailwind arbitrary → canonical class, JSX style → 'var(--x)').
  --fix=near             Also rewrite NEAR matches (review the diff first!).
  --dry-run              With --fix: print a unified diff and change nothing.
  --propose              Cluster OFF-SCALE values into a minimal set of proposed new tokens
                         (with no tokens at all, this bootstraps a token set).

Matching
  --tokens <path>        Token source file/folder (repeatable). Default: auto-discover.
  --threshold <k=v,…>    NEAR thresholds. color=ΔE2000 (default 4), size=px (2) and pct=% (5) for
                         spacing/radius, font=px (1) for font sizes, duration=% (15), weight=units (50).
  --ignore <values>      Extra raw values to ignore, e.g. 2px,#000,z:9999. Defaults ignore
                         0, 1px, 0.5px hairlines and z-index -1/0/1.
  --strict               Do not ignore hairlines / trivial z-indexes.
  --include <glob>       Only scan matching files (repeatable, comma-separated).
  --exclude <glob>       Skip matching files (repeatable). node_modules, dist, build, dot-folders
                         and .gitignored paths are always skipped.
  --include-tests        Also scan tests, stories and fixtures (*.test.*, *.stories.*, __tests__/,
                         fixtures/, stories/), skipped by default.
  --exec-config          Evaluate tailwind.config.* instead of reading it statically.
  --tailwind-defaults <m>  scales (default) | none.
  --json-vars            Trust that DTCG / Style Dictionary JSON tokens exist as var(--path).
  --rem <px>             Root font size for rem → px (default 16).
  -h, --help             Show this help.

Skipped automatically: generated files (compiled Tailwind, @generated), JS/TS palette or theme
objects, @font-face descriptors, and lines marked token-drift-ignore / stylelint-disable-line
(or the line before with -next-line). Emails, OG images and React Native files are listed but
not scored, and so are colors in plain JS strings.

Examples
  node scan.mjs .                              # summary + .knack/token-drift/report.md
  node scan.mjs src --fix --dry-run            # preview safe rewrites
  node scan.mjs src --fix=near --include "src/components/**"
  node scan.mjs . --propose                    # suggest tokens for off-scale clusters
  node scan.mjs . --fail-under 90              # CI guard`;

export async function scan(target, opts = {}) {
  const root = path.resolve(target);
  // token discovery always sees the whole project; --include/--exclude only limit what is scanned
  const ctx = await loadTokens(root, { ...opts, include: undefined, exclude: undefined });
  const index = buildIndex(ctx.tokens, ctx.scopes, ctx.preprocessorReach, ctx.themeReach);
  const thresholds = parseThresholds(opts.threshold);
  const env = { tailwind: ctx.tailwind, fragments: index.fragments, ignore: makeIgnore(opts.ignore, opts.strict), tokenDefSites: ctx.tokenDefSites };
  const files = walk(root, { exts: SCAN_EXTS, include: opts.include, exclude: opts.exclude })
    .filter((f) => !ctx.tokenFiles.has(f) && !ctx.generated.has(f) && (opts.includeTests || !isTestPath(path.relative(root, f))));
  const findings = [];
  const usage = {};
  const texts = new Map();
  const noVarFiles = [];
  const skipped = { generated: [...ctx.generated].map((f) => rel(f, root)), themeFiles: [] };
  for (const file of files) {
    let text;
    try { text = ctx.texts?.get(file) ?? fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    if (isGenerated(text)) { skipped.generated.push(rel(file, root)); continue; }
    texts.set(file, text);
    const res = extractFile(file, text, env);
    if (res.themeFile) skipped.themeFiles.push({ file: rel(file, root), count: res.themeFile });
    if (res.ignored) skipped.ignoredByComment = (skipped.ignoredByComment || 0) + res.ignored;
    if (res.noVar && res.findings.length) noVarFiles.push({ file: rel(file, root), reason: res.noVar, count: res.findings.length });
    if (!res.findings.length && !Object.keys(res.usage).length) continue;
    const pos = lineIndex(text);
    const pkg = ctx.scopes.pkgOf(file);
    const twv = ctx.twVersionFor(file);
    for (const f of res.findings) {
      const { line, col } = pos(f.start);
      f.line = line; f.col = col; f.rel = rel(file, root); f.pkg = pkg; f.twv = twv;
      findings.push(f);
    }
    for (const [k, v] of Object.entries(res.usage)) usage[k] = (usage[k] || 0) + v;
  }
  findings.sort((a, b) => a.rel.localeCompare(b.rel) || a.start - b.start);
  classify(findings, index, thresholds);
  return { ...summarize({ root, target, ctx, files, findings, usage, thresholds, texts }), noVarFiles, skipped };
}

function summarize({ root, target, ctx, files, findings, usage, thresholds, texts }) {
  const counts = { EXACT: 0, NEAR: 0, 'OFF-SCALE': 0 };
  const fixable = { EXACT: 0, NEAR: 0 };
  const byCategory = {};
  // categories the project has no token for at all can't be "tokenized": list them, don't score them
  const tokenCats = new Set(ctx.tokens.filter((t) => !t.localFile).map((t) => t.category)); // a lone file-local $var doesn't make a scale
  const untracked = {};
  for (const cat of CATEGORIES) byCategory[cat] = { tokenized: usage[cat] || 0, raw: 0, EXACT: 0, NEAR: 0, 'OFF-SCALE': 0, score: 0, noTokens: ctx.tokens.length > 0 && !tokenCats.has(cat) };
  const files2 = new Map();
  const jsLiterals = { EXACT: 0, NEAR: 0, 'OFF-SCALE': 0 };
  const noVarCounts = { EXACT: 0, NEAR: 0, 'OFF-SCALE': 0 };
  for (const f of findings) {
    const bc = byCategory[f.category];
    // colors in plain JS strings usually feed canvas/charts/data: listed, never scored
    if (f.context === 'js-literal') { f.excluded = 'js-literal'; jsLiterals[f.status]++; continue; }
    // emails, OG images, React Native: they can't use CSS variables, so they aren't scored either
    if (f.noVar) { f.excluded = 'no-var'; noVarCounts[f.status]++; continue; }
    bc.raw++; bc[f.status]++;
    if (bc.noTokens) { f.untracked = true; f.excluded = 'no-tokens'; untracked[f.category] = (untracked[f.category] || 0) + 1; continue; }
    counts[f.status]++;
    if (f.fix && f.status !== 'OFF-SCALE') fixable[f.status]++;
    const e = files2.get(f.rel) || { file: f.rel, total: 0, EXACT: 0, NEAR: 0, 'OFF-SCALE': 0 };
    e.total++; e[f.status]++;
    files2.set(f.rel, e);
  }
  for (const v of Object.values(byCategory)) v.score = v.noTokens ? null : v.raw + v.tokenized ? Math.round((v.tokenized / (v.raw + v.tokenized)) * 100) : 100;
  const scored = Object.values(byCategory).filter((v) => !v.noTokens);
  const tokenized = scored.reduce((a, v) => a + v.tokenized, 0);
  const raw = scored.reduce((a, v) => a + v.raw, 0);
  const score = raw + tokenized ? Math.round((tokenized / (raw + tokenized)) * 1000) / 10 : 100;
  return {
    root, target: rel(root) === '.' ? path.basename(root) + '/' : shown(root) + '/', generatedAt: new Date().toISOString(),
    fileCount: files.length, tokenCount: ctx.tokens.length, tokens: ctx.tokens,
    sources: ctx.sources.map((s) => ({ ...s, file: s.file ? rel(s.file, root) : null })), tailwind: { ...ctx.tailwind, configFile: ctx.tailwind.configFile ? rel(ctx.tailwind.configFile, root) : null, configFiles: (ctx.tailwind.configFiles || []).map((f) => rel(f, root)) },
    packages: ctx.scopes.pkgs.size, warnings: ctx.warnings, thresholds, score: Math.round(score), scoreExact: score, tokenized, raw, counts, fixable, byCategory, untracked, jsLiterals, noVarCounts,
    byFile: [...files2.values()].sort((a, b) => b.total - a.total || a.file.localeCompare(b.file)),
    findings, texts,
  };
}

/** Apply (or preview) fixes. Returns { diff, edits, files, skipped }. */
export function applyFixes(r, { mode = 'exact', dryRun = false } = {}) {
  const allowed = mode === 'near' ? new Set(['EXACT', 'NEAR']) : new Set(['EXACT']);
  const byFile = new Map();
  for (const f of r.findings) {
    if (!f.fix || !allowed.has(f.status)) continue;
    const abs = path.join(r.root, f.rel);
    (byFile.get(abs) || byFile.set(abs, []).get(abs)).push(f);
  }
  let diff = '';
  let edits = 0;
  const themed = [];
  const skipped = [];
  const changedFiles = [];
  for (const [abs, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const before = r.texts.get(abs) ?? fs.readFileSync(abs, 'utf8');
    list.sort((a, b) => b.fix.start - a.fix.start);
    let after = before;
    let lastStart = Infinity;
    let n = 0;
    for (const f of list) {
      if (f.fix.end > lastStart) { skipped.push(`${f.rel}:${f.line} overlapping edit`); continue; }
      if (after.slice(f.fix.start, f.fix.end) !== before.slice(f.fix.start, f.fix.end)) { skipped.push(`${f.rel}:${f.line} offset mismatch`); continue; }
      after = after.slice(0, f.fix.start) + f.fix.text + after.slice(f.fix.end);
      lastStart = f.fix.start;
      n++;
      if (f.token.dark || f.token.themes) themed.push(`${f.rel}:${f.line} ${f.display || f.value} → ${f.fix.text} (${f.token.dark ? 'dark: ' + f.token.dark : f.token.themes})`);
    }
    const balance = (s) => ['{}', '()', '[]'].map(([o, cl]) => s.split(o).length - s.split(cl).length).join(',');
    if (balance(before) !== balance(after) || before.split('\n').length !== after.split('\n').length) {
      skipped.push(`${rel(abs, r.root)}: sanity check failed (bracket balance changed), file left untouched`);
      continue;
    }
    if (!n) continue;
    edits += n;
    changedFiles.push(rel(abs, r.root));
    diff += unifiedDiff(rel(abs, r.root), before, after);
    if (!dryRun) fs.writeFileSync(abs, after);
  }
  return { diff, edits, files: changedFiles, skipped, themed };
}

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    bool: ['json', 'md', 'fix', 'dry-run', 'propose', 'strict', 'exec-config', 'json-vars', 'include-tests', 'help'],
    multi: ['tokens', 'include', 'exclude', 'threshold', 'ignore'],
    value: ['fail-under', 'out', 'tailwind-defaults', 'rem'],
  });
  if (a.help) { console.log(HELP); return; }
  const target = a._[0] || '.';
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new UsageError(`${target} is not a directory. Usage: node scan.mjs [dir]`);
  if (a['dry-run'] && !a.fix) a.fix = true;
  const fixMode = a.fix === true ? 'exact' : a.fix ? String(a.fix) : null;
  if (fixMode && !['exact', 'near'].includes(fixMode)) throw new UsageError(`--fix accepts no value, =exact or =near (got "${fixMode}").`);
  const opts = {
    tokens: a.tokens, include: a.include, exclude: a.exclude, threshold: a.threshold, ignore: a.ignore, strict: a.strict,
    execConfig: a['exec-config'], tailwindDefaults: a['tailwind-defaults'], rem: a.rem, jsonVars: a['json-vars'], includeTests: a['include-tests'],
  };
  let r;
  try { r = await scan(target, opts); } catch (e) { if (/--threshold/.test(e.message)) throw new UsageError(e.message); throw e; }
  const outDir = path.resolve(a.out || path.join(process.cwd(), '.knack', 'token-drift'));
  const proposal = a.propose ? propose(r.findings, r.tokens, r.thresholds, { all: r.tokenCount === 0 }) : null;
  const md = writeReports(r, outDir, { proposal });
  r.written = { md: shown(path.join(outDir, 'report.md')) };
  // carry the flags that change what is scanned into the suggested next command
  const passOn = [...(a.tokens || []).map((t) => `--tokens ${t}`), ...(a.include || []).map((g) => `--include "${g}"`), ...(a.exclude || []).map((g) => `--exclude "${g}"`), a['exec-config'] ? '--exec-config' : '', a['json-vars'] ? '--json-vars' : ''].filter(Boolean).join(' ');
  r.argTarget = target + (passOn ? ' ' + passOn : '');
  const scriptRel = shown(path.join(here, 'scan.mjs'));
  const quietStdout = a.json || a.md;

  if (fixMode) {
    const res = applyFixes(r, { mode: fixMode, dryRun: !!a['dry-run'] });
    if (a['dry-run']) {
      fs.writeFileSync(path.join(outDir, 'fix.diff'), res.diff);
      if (!quietStdout) {
        console.log(res.diff || c.dim('(no changes)'));
        console.log(`${c.bold('Dry run')}: ${plural(res.edits, 'value')} in ${plural(res.files.length, 'file')} would be rewritten (${fixMode === 'near' ? 'EXACT + NEAR' : 'EXACT only'}). Nothing was changed.`);
        console.log(c.dim(`Diff saved to ${shown(path.join(outDir, 'fix.diff'))}. Apply with: node ${scriptRel} ${r.argTarget} --fix${fixMode === 'near' ? '=near' : ''}`));
      }
    } else {
      const after = await scan(target, opts);
      writeReports(after, outDir, { proposal: a.propose ? propose(after.findings, after.tokens, after.thresholds, { all: after.tokenCount === 0 }) : null });
      if (!quietStdout) {
        console.log(`${c.bold('Fixed')} ${plural(res.edits, 'value')} in ${plural(res.files.length, 'file')}: ${res.files.join(', ') || '-'}`);
        console.log(`Drift score ${c.bold(r.score + '%')} → ${c.bold(c.green(after.score + '%'))}  ${c.dim(`(${after.counts.EXACT} exact · ${after.counts.NEAR} near · ${after.counts['OFF-SCALE']} off-scale left)`)}`);
        console.log(c.dim(`Updated report: ${r.written.md}. Review the changes with git diff.`));
      }
      r = after;
    }
    if (res.themed.length && !quietStdout) {
      console.log(c.yellow(`\n! ${plural(res.themed.length, 'replacement')} use${res.themed.length === 1 ? 's' : ''} a theme-aware token: the value will now follow dark mode. Confirm that is intended:`));
      for (const t of res.themed.slice(0, 8)) console.log(c.dim('    ' + t));
      if (res.themed.length > 8) console.log(c.dim(`    … ${res.themed.length - 8} more`));
    }
    for (const s of res.skipped) console.error(c.yellow('! skipped ' + s));
  } else if (!quietStdout) {
    printSummary(r, { scriptRel });
  }
  if (proposal && !quietStdout) {
    console.log('');
    if (!proposal.proposals.length) console.log(c.dim('  --propose: no repeated off-scale values to cluster (one-offs are listed in the report).'));
    else {
      console.log(c.bold(`  Proposed tokens`) + c.dim(` (${plural(proposal.proposals.length, 'cluster')}, ${plural(proposal.oneOffs.length, 'one-off')}) → ${shown(path.join(outDir, 'proposed-tokens.css'))}`));
      for (const p of proposal.proposals.slice(0, 10)) console.log(`    ${c.cyan(p.name.padEnd(26))} ${String(p.value).padEnd(14)} ${c.dim(`${p.count} uses: ${p.members.map((m) => m.value).join(', ')}${p.note ? ' · ' + p.note : ''}`)}`);
    }
  }
  for (const w of r.warnings) console.error(c.yellow('! ' + w));
  if (a.json) console.log(JSON.stringify(toJson(r, proposal), null, 2));
  if (a.md) process.stdout.write(md);
  if (a['fail-under'] != null) {
    const min = Number(a['fail-under']);
    if (Number.isNaN(min)) throw new UsageError('--fail-under needs a number, e.g. --fail-under 90');
    if (r.scoreExact < min) {
      console.error(c.red(`✖ Drift score ${r.score}% is below the required ${min}%.`));
      process.exit(1);
    } else if (!quietStdout) console.log(c.green(`✓ Drift score ${r.score}% meets --fail-under ${min}.`));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(c.red('✖ ') + (e instanceof UsageError ? e.message : e.stack || e.message));
    process.exit(e instanceof UsageError ? 2 : 1);
  });
}
void STATUS;
