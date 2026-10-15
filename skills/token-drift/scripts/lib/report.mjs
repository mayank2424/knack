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
      console.log(`    ${cat.padEnd(20)} ${String(v.tokenized).padStart(7)} ${String(v.EXACT).padStart(6)} ${String(v.NEAR).padStart(5)} ${String(v['OFF-SCALE']).padStart(5)} ${String(v.score + '%').padStart(6)}`);
    }
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
  const near = r.findings.filter((f) => f.status === 'NEAR').slice(0, 6);
  if (near.length) {
    console.log(c.bold('  Near misses') + c.dim(' (first 6)'));
    for (const f of near) {
      const sw = f.category === 'color' && swatch(f.color.hex) ? `${swatch(f.color.hex)}${swatch(f.token.meas.color.hex)} ` : '';
      console.log(`    ${sw}${c.dim(`${f.rel}:${f.line}`)}  ${f.display || f.value} → ${c.cyan(f.fix?.text || f.token.usage.split('  ·  ')[0])}  ${c.dim(distText(f))}`);
    }
    console.log('');
  }
  if (r.noVarFiles?.length) {
    const n = r.noVarFiles.reduce((a, f) => a + f.count, 0);
    console.log(c.yellow(`  ! ${n} values in ${plural(r.noVarFiles.length, 'file')} that cannot use CSS variables (emails, OG images, React Native) are report-only:`));
    for (const f of r.noVarFiles.slice(0, 4)) console.log(c.dim(`      ${f.file} (${f.reason})`));
    console.log(c.dim(`    Exclude them from the score with --exclude "<glob>".\n`));
  }
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
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

export function writeReports(r, outDir, { proposal } = {}) {
  fs.mkdirSync(path.join(outDir, 'swatches'), { recursive: true });
  const sw = (a, b) => {
    const name = b ? `${a.slice(1)}-${b.slice(1)}.svg` : `${a.slice(1)}.svg`;
    const p = path.join(outDir, 'swatches', name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, b ? swatchSvg(a, b) : singleSvg(a));
    return `![${a}${b ? ' vs ' + b : ''}](swatches/${name})`;
  };
  fs.writeFileSync(path.join(outDir, 'swatches', 'gauge.svg'), gaugeSvg(r.score));
  const L = [];
  L.push(`# Token drift report`, '');
  L.push(`Scanned ${code(r.target)} on ${r.generatedAt.slice(0, 10)} · ${plural(r.fileCount, 'file')} · ${plural(r.tokenCount, 'token')} from ${plural(r.sources.length, 'source')}${r.tailwind?.version ? ` · Tailwind v${r.tailwind.version}` : ''}`, '');
  L.push(`![drift score](swatches/gauge.svg)`, '');
  L.push(`**Drift score: ${r.score}%**. ${r.tokenized} of ${r.tokenized + r.raw} design values reference a token.`, '');
  L.push('| Class | Count | Meaning |', '|---|---:|---|');
  L.push(`| EXACT | ${r.counts.EXACT} | Raw value equals a token. Swap in the token (${r.fixable.EXACT} auto-fixable). |`);
  L.push(`| NEAR | ${r.counts.NEAR} | Within threshold of a token. Almost certainly drift; review (${r.fixable.NEAR} fixable with \`--fix=near\`). |`);
  L.push(`| OFF-SCALE | ${r.counts['OFF-SCALE']} | Far from every token. Add a token, or keep it as a deliberate one-off. |`, '');
  L.push('## By category', '', '| Category | Tokenized | Exact | Near | Off-scale | Score |', '|---|---:|---:|---:|---:|---:|');
  for (const [cat, v] of Object.entries(r.byCategory)) if (v.raw + v.tokenized) L.push(`| ${cat} | ${v.tokenized} | ${v.EXACT} | ${v.NEAR} | ${v['OFF-SCALE']} | ${v.score}% |`);
  L.push('', '## Top offenders', '', '| File | Raw values | Exact | Near | Off-scale |', '|---|---:|---:|---:|---:|');
  for (const f of r.byFile.slice(0, 15)) L.push(`| ${code(f.file)} | ${f.total} | ${f.EXACT} | ${f.NEAR} | ${f['OFF-SCALE']} |`);
  if (r.byFile.length > 15) L.push(`| … ${r.byFile.length - 15} more files | | | | |`);

  const cap = 300;
  const nearColors = r.findings.filter((f) => f.status === 'NEAR' && f.category === 'color');
  if (nearColors.length) {
    L.push('', '## Near-miss colors', '', 'Left: the hard-coded value. Right: the nearest token.', '', '| Swatch | Found | Nearest token | Difference | Where |', '|---|---|---|---|---|');
    for (const f of nearColors.slice(0, cap)) L.push(`| ${sw(f.color.hex, f.token.meas.color.hex)} | ${code(f.display || f.value)} | ${code(f.token.name)} ${code(f.token.value)} | ${distText(f)} | ${code(`${f.rel}:${f.line}:${f.col}`)} |`);
  }
  const nearOther = r.findings.filter((f) => f.status === 'NEAR' && f.category !== 'color');
  if (nearOther.length) {
    L.push('', '## Near misses (sizes, weights, motion, shadows)', '', '| Found | Property | Nearest token | Difference | Suggested | Where |', '|---|---|---|---|---|---|');
    for (const f of nearOther.slice(0, cap)) L.push(`| ${code(f.display || f.value)} | ${f.prop} | ${code(f.token.name)} ${code(tokenValue(f.token))} | ${distText(f)} | ${f.fix ? code(f.fix.text) : esc(f.fixNote || '')} | ${code(`${f.rel}:${f.line}:${f.col}`)} |`);
  }
  const exact = r.findings.filter((f) => f.status === 'EXACT');
  if (exact.length) {
    L.push('', '## Exact matches (use the token)', '', '| Found | Property | Token | Replacement | Where |', '|---|---|---|---|---|');
    for (const f of exact.slice(0, cap)) L.push(`| ${f.color ? sw(f.color.hex) + ' ' : ''}${code(f.display || f.value)} | ${f.prop} | ${code(f.token.name)} | ${f.fix ? code(f.fix.text) : esc(f.fixNote || '')} | ${code(`${f.rel}:${f.line}:${f.col}`)} |`);
    if (exact.length > cap) L.push(`| … ${exact.length - cap} more in report.json | | | | |`);
  }
  const off = r.findings.filter((f) => f.status === 'OFF-SCALE');
  if (off.length) {
    L.push('', '## Off-scale values', '', '| Found | Property | Closest token | Where |', '|---|---|---|---|');
    for (const f of off.slice(0, cap)) L.push(`| ${f.color ? sw(f.color.hex) + ' ' : ''}${code(f.display || f.value)} | ${f.prop} | ${f.token ? `${code(f.token.name)} (${distText(f)})` : '(none)'} | ${code(`${f.rel}:${f.line}:${f.col}`)} |`);
  }
  if (proposal && proposal.proposals.length) {
    L.push('', '## Proposed tokens', '', 'Off-scale values clustered into candidate tokens. Rename to fit your naming before adding them.', '');
    L.push('| Proposed | Value | Uses | Absorbs |', '|---|---|---:|---|');
    for (const p of proposal.proposals) L.push(`| ${p.hex ? sw(p.hex) + ' ' : ''}${code(p.name)} | ${code(p.value)} | ${p.count} | ${p.members.map((m) => `${m.hex ? sw(m.hex) + ' ' : ''}${code(m.value)}×${m.count}`).join(', ')}${p.note ? ` (${p.note})` : ''} |`);
    L.push('', '```css', proposal.css.trimEnd(), '```');
  }
  L.push('', '## Next steps', '');
  L.push('1. Preview safe fixes: `scan.mjs --fix --dry-run` (EXACT only), then apply with `--fix`.');
  L.push('2. Review NEAR in batches: `scan.mjs --fix=near --dry-run --include "src/components/**"`.');
  L.push('3. Decide OFF-SCALE: `scan.mjs --propose` clusters them into candidate tokens.');
  L.push('4. Guard it in CI: `scan.mjs --fail-under ' + Math.min(95, Math.max(r.score, 50)) + '`.');
  const md = L.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(toJson(r, proposal), null, 2));
  if (proposal?.css) fs.writeFileSync(path.join(outDir, 'proposed-tokens.css'), proposal.css);
  return md;
}

export function toJson(r, proposal) {
  return {
    target: r.target, generatedAt: r.generatedAt, score: r.score, tokenized: r.tokenized, raw: r.raw,
    counts: r.counts, fixable: r.fixable, byCategory: r.byCategory, byFile: r.byFile,
    sources: r.sources, tailwind: r.tailwind, warnings: r.warnings, thresholds: r.thresholds, noVarFiles: r.noVarFiles,
    findings: r.findings.map((f) => ({
      file: f.rel, line: f.line, col: f.col, category: f.category, property: f.prop, context: f.context,
      value: f.display || f.value, status: f.status,
      token: f.token ? { name: f.token.name, value: f.token.value, usage: f.token.usage } : null,
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
