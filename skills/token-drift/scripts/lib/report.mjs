// Terminal summary, Markdown report (with SVG swatches), JSON shape and unified diffs.
import fs from 'node:fs';
import path from 'node:path';
import { c, swatch, round, plural } from './util.mjs';

export const STATUS = ['EXACT', 'NEAR', 'OFF-SCALE'];

export function bar(pct, width = 24) {
  const n = Math.round((pct / 100) * width);
  return '█'.repeat(n) + '░'.repeat(width - n);
}

export function distText(f) {
  const d = f.distance;
  if (!d) return '';
  if (f.category === 'color') return d.exact ? 'identical' : `ΔE ${round(d.deltaE, 2)}${d.alpha > 0.001 ? `, α Δ${round(d.alpha, 2)}` : ''}`;
  if (f.category === 'shadow') return d.exact ? 'identical' : [d.px > 0.001 && `max Δ${round(d.px, 2)}px`, d.de > 0.05 && `ΔE ${round(d.de, 1)}`, d.da > 0.001 && `α Δ${round(d.da, 2)}`].filter(Boolean).join(', ');
  if (d.exact) return 'equal';
  const unit = f.category === 'duration' ? 'ms' : f.category === 'z-index' || f.category === 'font-weight' ? '' : 'px';
  return `Δ${round(d.abs, 2)}${unit} (${round(d.pct, 1)}%)`;
}

const tokenValue = (t) => t.meas.kind === 'length' && /rem$/.test(t.value) ? `${t.value} = ${+t.meas.px.toFixed(2)}px` : t.value;

/* -------------------------------------------------------------- terminal -- */

export function printSummary(r, { scriptRel, showNext = true } = {}) {
  const scoreColor = r.score >= 90 ? c.green : r.score >= 70 ? c.yellow : c.red;
  console.log(`${c.bold('token-drift')} ${c.dim('·')} ${c.cyan(r.target)}  ${c.dim(`${plural(r.fileCount, 'file')} scanned · ${plural(r.tokenCount, 'token')} from ${plural(r.sources.length, 'source')}`)}\n`);
  if (!r.tokenCount) console.log(c.yellow('  No design tokens found — every value counts as off-scale. Bootstrap a token set with --propose.\n'));
  console.log(`  ${c.bold('Drift score')}  ${scoreColor(c.bold(String(r.score).padStart(3) + '%'))}  ${scoreColor(bar(r.score))}  ${c.dim(`${r.tokenized} of ${r.tokenized + r.raw} design values use tokens`)}\n`);
  const fx = r.fixable;
  console.log(`  ${c.green('EXACT    ')} ${String(r.counts.EXACT).padStart(4)}  ${c.dim('equals a token → swap in the token')}${fx.EXACT ? c.dim(` (${fx.EXACT} auto-fixable)`) : ''}`);
  console.log(`  ${c.yellow('NEAR     ')} ${String(r.counts.NEAR).padStart(4)}  ${c.dim('within threshold of a token → likely drift')}${fx.NEAR ? c.dim(` (${fx.NEAR} fixable with --fix=near)`) : ''}`);
  console.log(`  ${c.red('OFF-SCALE')} ${String(r.counts['OFF-SCALE']).padStart(4)}  ${c.dim('far from every token → new token or deliberate one-off')}\n`);
  const cats = Object.entries(r.byCategory).filter(([, v]) => v.raw + v.tokenized > 0);
  if (cats.length) {
    console.log(c.bold('  By category') + c.dim('            tokens  exact  near   off  score'));
    for (const [cat, v] of cats) {
      if (v.noTokens) { console.log(c.dim(`    ${cat.padEnd(20)} ${String(v.tokenized).padStart(7)}  ${String(v.raw).padStart(4)} raw values, no ${cat} tokens: not scored`)); continue; }
      console.log(`    ${cat.padEnd(20)} ${String(v.tokenized).padStart(7)} ${String(v.EXACT).padStart(6)} ${String(v.NEAR).padStart(5)} ${String(v['OFF-SCALE']).padStart(5)} ${String(v.score + '%').padStart(6)}`);
    }
    console.log('');
  }
  const reasons = blockers(r);
  if (reasons.length) {
    console.log(c.bold('  Not auto-fixable') + c.dim(' (EXACT/NEAR that need a human)'));
    for (const [why, n] of reasons.slice(0, 6)) console.log(`    ${String(n).padStart(5)}  ${c.dim(why)}`);
    console.log('');
  }
  if (r.byFile.length) {
    console.log(c.bold('  Top offenders'));
    const w = Math.min(48, Math.max(...r.byFile.slice(0, 8).map((f) => f.file.length)));
    for (const f of r.byFile.slice(0, 8)) {
      console.log(`    ${f.file.padEnd(w)} ${String(f.total).padStart(4)}  ${c.dim(`${f.EXACT} exact · ${f.NEAR} near · ${f['OFF-SCALE']} off`)}`);
    }
    console.log('');
  }
  const near = r.findings.filter((f) => f.status === 'NEAR' && !f.excluded).sort((a, b) => (!a.fix - !b.fix)).slice(0, 6);
  if (near.length) {
    console.log(c.bold('  Near misses') + c.dim(' (first 6)'));
    for (const f of near) {
      const sw = f.category === 'color' && swatch(f.color.hex) ? `${swatch(f.color.hex)}${swatch(f.token.meas.color.hex)} ` : '';
      console.log(`    ${sw}${c.dim(`${f.rel}:${f.line}`)}  ${f.display || f.value} → ${c.cyan(f.fix?.text || f.token.usage.split('  ·  ')[0])}  ${c.dim(distText(f) + (f.fix ? '' : '  (by hand)'))}`);
    }
    console.log('');
  }
  const jl = r.jsLiterals || {};
  if (jl.EXACT + jl.NEAR + jl['OFF-SCALE']) console.log(c.dim(`  ${jl.EXACT + jl.NEAR + jl['OFF-SCALE']} colors in plain JS strings (${jl.EXACT} equal a token) are listed in the report but not scored.\n`));
  if (r.noVarFiles?.length) {
    const n = r.noVarFiles.reduce((a, f) => a + f.count, 0);
    console.log(c.yellow(`  ! ${n} values in ${plural(r.noVarFiles.length, 'file')} that cannot use CSS variables (emails, OG images, React Native) are listed, not scored:`));
    for (const f of r.noVarFiles.slice(0, 4)) console.log(c.dim(`      ${f.file} (${f.reason})`));
    if (r.noVarFiles.length > 4) console.log(c.dim(`      … ${r.noVarFiles.length - 4} more in the report`));
    console.log('');
  }
  const sk = r.skipped || {};
  if (sk.generated?.length || sk.themeFiles?.length) console.log(c.dim(`  Skipped: ${[sk.generated?.length && plural(sk.generated.length, 'generated file'), sk.themeFiles?.length && plural(sk.themeFiles.length, 'JS theme/palette file') + ' (token definitions)'].filter(Boolean).join(', ')}`));
  if (r.written) console.log(c.dim(`  Report: ${r.written.md}  (+ report.json, swatches/)`));
  if (showNext && scriptRel) {
    const tgt = r.argTarget || r.target;
    const next = r.fixable.EXACT ? `node ${scriptRel} ${tgt} --fix --dry-run` : r.counts.NEAR ? `node ${scriptRel} ${tgt} --fix=near --dry-run` : r.counts['OFF-SCALE'] ? `node ${scriptRel} ${tgt} --propose` : null;
    if (next) console.log(c.dim(`  Next:   ${next}`));
  }
}

/* -------------------------------------------------------------- markdown -- */

function swatchSvg(a, b) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24" viewBox="0 0 64 24"><rect x="0.5" y="0.5" width="31" height="23" rx="4" fill="${a}" stroke="#0002"/><rect x="32.5" y="0.5" width="31" height="23" rx="4" fill="${b}" stroke="#0002"/></svg>`;
}
function singleSvg(a) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="0.5" y="0.5" width="23" height="23" rx="4" fill="${a}" stroke="#0002"/></svg>`;
}
function gaugeSvg(score) {
  const r = 52, C = 2 * Math.PI * r, col = score >= 90 ? '#16a34a' : score >= 70 ? '#d97706' : '#dc2626';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140"><circle cx="70" cy="70" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="14"/><circle cx="70" cy="70" r="${r}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(C * score) / 100} ${C}" transform="rotate(-90 70 70)"/><text x="70" y="78" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="${col}">${score}%</text></svg>`;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;');
const code = (s) => '`' + String(s).replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ') + '`';

/** Why EXACT/NEAR findings were left alone, grouped: [[reason, count], …] sorted by count. */
export function blockers(r) {
  const m = new Map();
  for (const f of r.findings) {
    if (f.excluded || f.status === 'OFF-SCALE' || f.fix) continue;
    let why = String(f.fixNote || 'not fixable');
    for (let i = 0; i < 4 && /\([^()]*\)/.test(why); i++) why = why.replace(/\s*\([^()]*\)/g, '');
    why = why.replace(/[\w.-]*--[\w-]+(?: × [\d.]+)?|\$[\w-]+|@[\w-]+/g, '<token>').replace(/ \/\S+/, ' /modifier').replace(/\s+([;,])/g, '$1').replace(/\s+/g, ' ').trim();
    m.set(why, (m.get(why) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const loc = (f) => `${f.rel}:${f.line}:${f.col}`;
function details(L, summary, lines, open = false) {
  if (lines.length <= 25) { L.push(...lines); return; }
  L.push(`<details${open ? ' open' : ''}><summary>${summary}</summary>`, '', ...lines, '', '</details>');
}
/** Group findings by (value → token/replacement) so one row covers every occurrence. */
function grouped(list, keyOf) {
  const g = new Map();
  for (const f of list) {
    const k = keyOf(f);
    const e = g.get(k) || { f, count: 0, files: new Set(), where: [] };
    e.count++; e.files.add(f.rel); if (e.where.length < 3) e.where.push(loc(f));
    g.set(k, e);
  }
  return [...g.values()].sort((a, b) => b.count - a.count);
}

export function writeReports(r, outDir, { proposal } = {}) {
  const themed = r.findings.filter((f) => f.fix && f.status === 'EXACT' && (f.token.dark || f.token.themes)).length;
  fs.mkdirSync(path.join(outDir, 'swatches'), { recursive: true });
  const sw = (a, b) => {
    const name = b ? `${a.slice(1)}-${b.slice(1)}.svg` : `${a.slice(1)}.svg`;
    const p = path.join(outDir, 'swatches', name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, b ? swatchSvg(a, b) : singleSvg(a));
    return `![${a}${b ? ' vs ' + b : ''}](swatches/${name})`;
  };
  fs.writeFileSync(path.join(outDir, 'swatches', 'gauge.svg'), gaugeSvg(r.score));
  const L = [];
  const n = (x) => Number(x).toLocaleString('en-US');
  L.push(`# Token drift report`, '');
  L.push(`Scanned ${code(r.target)} on ${r.generatedAt.slice(0, 10)} · ${plural(r.fileCount, 'file')} · ${plural(r.tokenCount, 'token')} from ${plural(r.sources.length, 'source')}${r.tailwind?.version ? ` · Tailwind v${r.tailwind.mixed ? r.tailwind.versions.join(' + v') : r.tailwind.version}` : ''}${r.packages > 1 ? ` · ${r.packages} workspace packages` : ''}`, '');
  L.push(`![drift score](swatches/gauge.svg)`, '');
  L.push(`**Drift score: ${r.score}%**. ${n(r.tokenized)} of ${n(r.tokenized + r.raw)} design values reference a token.`, '');
  L.push('| Class | Count | Auto-fixable | Meaning |', '|---|---:|---:|---|');
  L.push(`| EXACT | ${n(r.counts.EXACT)} | ${n(r.fixable.EXACT)} | Raw value equals a token. Swap in the token; nothing changes visually. |`);
  L.push(`| NEAR | ${n(r.counts.NEAR)} | ${n(r.fixable.NEAR)} with \`--fix=near\` | Within threshold of a token. Almost certainly drift; review before fixing. |`);
  L.push(`| OFF-SCALE | ${n(r.counts['OFF-SCALE'])} | never | Far from every token. Add a token, or keep it as a deliberate one-off. |`, '');
  const unscored = Object.entries(r.untracked || {});
  if (unscored.length) L.push(`> **Not scored:** ${unscored.map(([k, v]) => `${k} (${n(v)} raw values)`).join(', ')}. The project has no tokens in ${unscored.length === 1 ? 'this category' : 'these categories'}; \`--propose\` drafts a starter set.`, '');

  // next steps first: what the reader can do right now
  L.push('## What to do next', '');
  const fixFiles = new Set(r.findings.filter((f) => f.fix && f.status === 'EXACT').map((f) => f.rel)).size;
  const steps = [];
  if (r.fixable.EXACT) steps.push(`**Apply the safe fixes.** ${n(r.fixable.EXACT)} EXACT values in ${plural(fixFiles, 'file')} can be swapped for their token with no visual change: \`scan.mjs --fix --dry-run\`, review the diff, then \`--fix\`.${themed ? ` ${plural(themed, 'replacement')} use a theme-aware token and will start following dark mode / other themes.` : ''}`);
  if (r.counts.NEAR) {
    const dirs = grouped(r.findings.filter((f) => f.status === 'NEAR' && !f.excluded), (f) => f.rel.split('/').slice(0, -1).join('/') || '.').slice(0, 3).map((g) => `\`${g.f.rel.split('/').slice(0, -1).join('/') || '.'}/\` (${g.count})`);
    steps.push(`**Review the near misses in batches.** ${n(r.counts.NEAR)} NEAR values (${n(r.fixable.NEAR)} fixable), mostly in ${dirs.join(', ')}: \`scan.mjs --fix=near --dry-run --include "<dir>/**"\`.`);
  }
  const bl = blockers(r);
  if (bl.length) steps.push(`**Hand-fix or accept the rest.** ${n(bl.reduce((a, [, c]) => a + c, 0))} EXACT/NEAR values can't be rewritten automatically; reasons are listed under "Not auto-fixable".`);
  if (r.counts['OFF-SCALE']) steps.push(`**Decide the off-scale values.** ${n(r.counts['OFF-SCALE'])} values (${n(grouped(r.findings.filter((f) => f.status === 'OFF-SCALE' && !f.excluded), (f) => f.category + ':' + (f.color?.key || f.key || f.px || f.n || f.ms || f.value)).length)} distinct) don't fit the system: \`scan.mjs --propose\` clusters them into candidate tokens.`);
  steps.push(`**Guard it in CI.** \`scan.mjs --fail-under ${Math.max(0, Math.min(99, Math.floor(r.scoreExact)))}\` fails the build if the score drops.`);
  steps.forEach((t, i) => L.push(`${i + 1}. ${t}`));

  L.push('', '## By category', '', '| Category | Tokenized | Exact | Near | Off-scale | Score |', '|---|---:|---:|---:|---:|---:|');
  for (const [cat, v] of Object.entries(r.byCategory)) {
    if (!(v.raw + v.tokenized)) continue;
    L.push(v.noTokens ? `| ${cat} | ${n(v.tokenized)} | | | ${n(v.raw)} raw | no tokens |` : `| ${cat} | ${n(v.tokenized)} | ${n(v.EXACT)} | ${n(v.NEAR)} | ${n(v['OFF-SCALE'])} | ${v.score}% |`);
  }
  L.push('', '## Top offenders', '', '| File | Raw values | Exact | Near | Off-scale |', '|---|---:|---:|---:|---:|');
  for (const f of r.byFile.slice(0, 15)) L.push(`| ${code(f.file)} | ${f.total} | ${f.EXACT} | ${f.NEAR} | ${f['OFF-SCALE']} |`);
  if (r.byFile.length > 15) L.push(`| … ${r.byFile.length - 15} more files | | | | |`);

  const cap = 300;
  const live = r.findings.filter((f) => !f.excluded);
  const nearColors = live.filter((f) => f.status === 'NEAR' && f.category === 'color');
  if (nearColors.length) {
    L.push('', `## Near-miss colors (${n(nearColors.length)})`, '', 'Left: the hard-coded value. Right: the nearest token. ΔE2000 below ~1 is invisible, 2–4 is subtle side by side.', '');
    const rows = ['| Swatch | Found | Nearest token | Difference | Fix | Where |', '|---|---|---|---|---|---|'];
    for (const f of nearColors.slice(0, cap)) rows.push(`| ${sw(f.color.hex, f.token.meas.color.hex)} | ${code(f.display || f.value)} | ${code(f.token.name)} ${code(f.token.value)} | ${distText(f)} | ${f.fix ? code(f.fix.text) : esc(f.fixNote || '')} | ${code(loc(f))} |`);
    details(L, `${n(nearColors.length)} near-miss colors`, rows, true);
  }
  const nearOther = live.filter((f) => f.status === 'NEAR' && f.category !== 'color');
  if (nearOther.length) {
    L.push('', `## Near misses: sizes, weights, motion, shadows (${n(nearOther.length)})`, '');
    const rows = ['| Found | Property | Nearest token | Difference | Fix | Where |', '|---|---|---|---|---|---|'];
    for (const f of nearOther.slice(0, cap)) rows.push(`| ${code(f.display || f.value)} | ${esc(f.prop)} | ${code(f.token.name)} ${code(tokenValue(f.token))} | ${distText(f)} | ${f.fix ? code(f.fix.text) : esc(f.fixNote || '')} | ${code(loc(f))} |`);
    if (nearOther.length > cap) rows.push(`| … ${nearOther.length - cap} more in report.json | | | | | |`);
    details(L, `${n(nearOther.length)} near misses`, rows);
  }
  const exact = live.filter((f) => f.status === 'EXACT');
  if (exact.length) {
    const g = grouped(exact, (f) => `${f.display || f.value}→${f.fix ? f.fix.text : f.token.name}`);
    L.push('', `## Exact matches: use the token (${n(exact.length)} values, ${n(g.length)} distinct)`, '');
    const rows = ['| Found | Token | Replacement | Uses | Files | Examples |', '|---|---|---|---:|---:|---|'];
    for (const e of g.slice(0, cap)) rows.push(`| ${e.f.color ? sw(e.f.color.hex) + ' ' : ''}${code(e.f.display || e.f.value)} | ${code(e.f.token.name)} | ${e.f.fix ? code(e.f.fix.text) : esc(e.f.fixNote || '')} | ${e.count} | ${e.files.size} | ${e.where.map(code).join(' ')} |`);
    if (g.length > cap) rows.push(`| … ${g.length - cap} more in report.json | | | | | |`);
    details(L, `${n(g.length)} distinct exact matches`, rows);
  }
  const off = live.filter((f) => f.status === 'OFF-SCALE');
  if (off.length) {
    const g = grouped(off, (f) => f.category + ':' + (f.color?.key || f.key || f.px || f.n || f.ms || f.value));
    L.push('', `## Off-scale values (${n(off.length)} values, ${n(g.length)} distinct)`, '');
    const rows = ['| Found | Category | Closest token | Uses | Examples |', '|---|---|---|---:|---|'];
    for (const e of g.slice(0, cap)) rows.push(`| ${e.f.color ? sw(e.f.color.hex) + ' ' : ''}${code(e.f.display || e.f.value)} | ${e.f.category} | ${e.f.between ? `midway: ${code(e.f.between[0])} / ${code(e.f.between[1])} (${distText(e.f)})` : e.f.token ? `${code(e.f.token.name)} (${distText(e.f)})` : '(none)'} | ${e.count} | ${e.where.map(code).join(' ')} |`);
    if (g.length > cap) rows.push(`| … ${g.length - cap} more in report.json | | | | |`);
    details(L, `${n(g.length)} distinct off-scale values`, rows);
  }
  const lits = r.findings.filter((f) => f.excluded === 'js-literal');
  if (lits.length) {
    const g = grouped(lits, (f) => (f.color?.key || f.value) + '→' + (f.status === 'OFF-SCALE' ? '' : f.token?.name));
    L.push('', `## Colors in JS strings (${n(lits.length)}, report-only, not scored)`, '', 'Plain string literals such as \`const RED = "#ef4444"\`. They often feed canvas, charts or data, which can\'t use \`var()\`; when one duplicates a token, consider importing a shared constant instead.', '');
    const rows = ['| Found | Status | Token | Uses | Examples |', '|---|---|---|---:|---|'];
    for (const e of g.slice(0, 100)) rows.push(`| ${e.f.color ? sw(e.f.color.hex) + ' ' : ''}${code(e.f.value)} | ${e.f.status} | ${e.f.token && e.f.status !== 'OFF-SCALE' ? `${code(e.f.token.name)} (${distText(e.f)})` : ''} | ${e.count} | ${e.where.map(code).join(' ')} |`);
    if (g.length > 100) rows.push(`| … ${g.length - 100} more in report.json | | | | |`);
    details(L, `${n(g.length)} distinct JS color literals`, rows);
  }
  if (bl.length) {
    L.push('', '## Not auto-fixable', '', 'EXACT and NEAR values the fixer leaves alone, and why:', '', '| Reason | Values |', '|---|---:|');
    for (const [why, c2] of bl) L.push(`| ${esc(why)} | ${n(c2)} |`);
  }
  const sk = r.skipped || {};
  const notes = [];
  if (r.noVarFiles?.length) notes.push(`**Not scored: ${n(r.noVarFiles.reduce((a, f) => a + f.count, 0))} values in ${plural(r.noVarFiles.length, 'file')} with no CSS variables at runtime** (emails, OG images, React Native): ${r.noVarFiles.slice(0, 8).map((f) => `${code(f.file)} (${f.reason})`).join(', ')}${r.noVarFiles.length > 8 ? `, … ${r.noVarFiles.length - 8} more` : ''}. They are in report.json with their nearest token; share values through a JS constants module if they must match.`);
  if (sk.themeFiles?.length) notes.push(`**Treated as token definitions** (JS/TS palette or theme objects): ${sk.themeFiles.slice(0, 8).map((f) => code(f.file)).join(', ')}${sk.themeFiles.length > 8 ? `, … ${sk.themeFiles.length - 8} more` : ''}.`);
  if (sk.ignoredByComment) notes.push(`**Ignored by comment:** ${n(sk.ignoredByComment)} values on lines marked \`token-drift-ignore\` or \`stylelint-disable-line\` (or the line before with \`-next-line\`).`);
  if (sk.generated?.length) notes.push(`**Skipped as generated:** ${sk.generated.slice(0, 8).map(code).join(', ')}${sk.generated.length > 8 ? `, … ${sk.generated.length - 8} more` : ''}.`);
  if (r.warnings?.length) notes.push(...r.warnings.map((w) => `**Warning:** ${esc(w)}`));
  if (notes.length) { L.push('', '## Notes', ''); for (const x of notes) L.push(`- ${x}`); }
  if (proposal && proposal.proposals.length) {
    L.push('', '## Proposed tokens', '', 'Off-scale values clustered into candidate tokens. Rename to fit your naming before adding them.', '');
    L.push('| Proposed | Value | Uses | Absorbs |', '|---|---|---:|---|');
    for (const p of proposal.proposals) L.push(`| ${p.hex ? sw(p.hex) + ' ' : ''}${code(p.name)} | ${code(p.value)} | ${p.count} | ${p.members.map((m) => `${m.hex ? sw(m.hex) + ' ' : ''}${code(m.value)}×${m.count}`).join(', ')}${p.note ? ` (${esc(p.note)})` : ''} |`);
    L.push('', '```css', proposal.css.trimEnd(), '```');
  }
  const md = L.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(toJson(r, proposal), null, 2));
  if (proposal?.css) fs.writeFileSync(path.join(outDir, 'proposed-tokens.css'), proposal.css);
  return md;
}

export function toJson(r, proposal) {
  return {
    target: r.target, generatedAt: r.generatedAt, score: r.score, tokenized: r.tokenized, raw: r.raw,
    counts: r.counts, fixable: r.fixable, byCategory: r.byCategory, untracked: r.untracked, byFile: r.byFile, skipped: r.skipped,
    sources: r.sources, tailwind: r.tailwind, warnings: r.warnings, thresholds: r.thresholds, noVarFiles: r.noVarFiles,
    findings: r.findings.map((f) => ({
      file: f.rel, line: f.line, col: f.col, category: f.category, property: f.prop, context: f.context,
      value: f.display || f.value, status: f.status, excluded: f.excluded,
      token: f.token ? { name: f.token.name, value: f.token.value, usage: f.token.usage, themed: f.token.dark ? 'dark: ' + f.token.dark : f.token.themes || undefined } : null,
      alternatives: f.alternatives?.length ? f.alternatives : undefined,
      distance: f.distance ? Object.fromEntries(Object.entries(f.distance).filter(([k, v]) => typeof v === 'number' && k !== 'd').map(([k, v]) => [k, round(v, 3)])) : null,
      replacement: f.fix?.text ?? null, note: f.fix ? undefined : f.fixNote,
    })),
    proposals: proposal ? proposal.proposals : undefined,
    oneOffs: proposal ? proposal.oneOffs : undefined,
  };
}

/* ----------------------------------------------------------------- diff -- */

/** Unified diff for same-line-count edits (our fixes never add or remove lines). */
export function unifiedDiff(relPath, before, after, context = 3) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length !== b.length) throw new Error('line count changed');
  const changed = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
  if (!changed.length) return '';
  const hunks = [];
  let cur = null;
  for (const i of changed) {
    if (cur && i - cur.end <= context * 2) cur.end = i;
    else { cur = { start: i, end: i }; hunks.push(cur); }
  }
  const out = [`--- a/${relPath}`, `+++ b/${relPath}`];
  for (const h of hunks) {
    const s = Math.max(0, h.start - context), e = Math.min(a.length - 1, h.end + context);
    out.push(`@@ -${s + 1},${e - s + 1} +${s + 1},${e - s + 1} @@`);
    for (let i = s; i <= e; i++) {
      if (a[i] === b[i]) { out.push(' ' + a[i]); continue; }
      let j = i;
      while (j <= e && a[j] !== b[j]) j++;
      for (let k = i; k < j; k++) out.push('-' + a[k]);
      for (let k = i; k < j; k++) out.push('+' + b[k]);
      i = j - 1;
    }
  }
  return out.join('\n') + '\n';
}
