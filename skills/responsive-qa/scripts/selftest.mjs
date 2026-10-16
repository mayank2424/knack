#!/usr/bin/env node
/**
 * Knack responsive-qa self-test: sweeps the bundled fixtures and checks the detector still
 * finds every planted bug (recall) and nothing else at error level (precision).
 *
 *   node selftest.mjs              # all fixtures
 *   node selftest.mjs --out dir    # where reports go (default ./.knack/responsive-qa/selftest)
 *
 * Each fixture declares what it expects in an HTML comment:
 *   EXPECT <check> <selector-substring | (page)> @<min>-<max> | @all  <BUG id>
 * Fixtures with no EXPECT lines must come out with 0 errors and 0 warnings.
 * Exit codes: 0 all pass, 1 a fixture failed or the tool broke.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}
const outIdx = args.indexOf('--out');
const outRoot = path.resolve(outIdx >= 0 ? args[outIdx + 1] : '.knack/responsive-qa/selftest');
const here = path.dirname(fileURLToPath(import.meta.url));
const ex = path.join(here, '..', 'examples');
const fixtures = [
  path.join(ex, 'broken-page.html'),
  path.join(ex, 'fixed-page.html'),
  ...fs.readdirSync(path.join(ex, 'fixtures')).filter((f) => f.endsWith('.html')).sort().map((f) => path.join(ex, 'fixtures', f)),
];

let failed = 0;
for (const fx of fixtures) {
  const name = path.relative(ex, fx);
  const out = path.join(outRoot, name.replace(/[^a-z0-9]+/gi, '-'));
  try {
    execFileSync(process.execPath, [path.join(here, 'sweep.mjs'), fx, '--out', out, '--fail-on', 'none'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.log(`✖ ${name}: sweep failed\n${e.stderr?.toString() || e.message}`);
    failed++;
    continue;
  }
  const rep = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const W = rep.widths;
  const html = fs.readFileSync(fx, 'utf8');
  const expects = [...html.matchAll(/EXPECT\s+(\S+)\s+(\S+)\s+@(\S+)\s+(BUG \w+)/g)].map(([, check, sel, ws, bug]) => {
    let widths = W;
    if (ws !== 'all') { const [a, b] = ws.split('-').map(Number); widths = W.filter((w) => w >= a && w <= (b || a)); }
    return { check, sel, widths, bug };
  });
  const matches = (i, e) => i.check === e.check && (e.sel === '(page)' ? !i.selector : (i.selector || '').includes(e.sel));
  const used = new Set();
  const lines = [];
  let ok = true;
  for (const e of expects) {
    const got = new Set();
    for (const r of rep.results) for (const i of r.issues) if (matches(i, e)) { used.add(i); if (e.widths.includes(r.viewport.width)) got.add(r.viewport.width); }
    const missing = e.widths.filter((w) => !got.has(w));
    if (missing.length) { ok = false; lines.push(`    ✖ ${e.bug} ${e.check} ${e.sel}: missing @${missing.join(',')}`); }
  }
  const extra = [];
  for (const r of rep.results) for (const i of r.issues) if (!used.has(i) && (i.severity === 'error' || (!expects.length && i.severity === 'warn'))) extra.push(`@${r.viewport.width} ${i.severity} ${i.check} ${i.selector || '(page)'}`);
  if (extra.length) { ok = false; lines.push(...[...new Set(extra)].slice(0, 12).map((x) => `    ✖ unexpected ${x}`)); }
  const s = rep.summary;
  console.log(`${ok ? '✓' : '✖'} ${name.padEnd(26)} ${expects.length ? `${expects.length - lines.filter((l) => l.includes('missing')).length}/${expects.length} planted bugs found` : 'clean page'} · ${s.errors} errors, ${s.warnings} warnings`);
  for (const l of lines) console.log(l);
  if (!ok) failed++;
}
console.log(failed ? `\n✖ ${failed} fixture(s) failed` : `\n✓ all ${fixtures.length} fixtures pass`);
process.exit(failed ? 1 : 0);
