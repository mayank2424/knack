// Cluster OFF-SCALE values into a minimal set of proposed new tokens.
import { deltaE2000, colorFamily } from './color.mjs';
import { shadowDistance } from './values.mjs';

const PREFIX = { color: '--color-', space: '--space-', radius: '--radius-', 'font-size': '--font-size-', 'font-weight': '--font-weight-',
  shadow: '--shadow-', 'z-index': '--z-', duration: '--duration-' };

function namingFor(cat, tokens) {
  const own = tokens.filter((t) => t.category === cat && !t.isDefault && t.name.startsWith('--'));
  const prefixes = {};
  // colors: keep the first segment only (--color-gray-500 → --color-); scales: everything before the last segment
  for (const t of own) { const m = cat === 'color' ? t.name.match(/^(--[a-z0-9]+-)/i) : t.name.match(/^(--.*-)[^-]+$/); if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1; }
  const prefix = Object.entries(prefixes).sort((a, b) => b[1] - a[1])[0]?.[0] || PREFIX[cat];
  // numeric convention: --space-4 = 16px → "quarter" (n = px / 4); --space-16 = 16px → "px"
  let conv = 'px';
  const numeric = own.filter((t) => t.name.startsWith(prefix) && /^\d+(\.\d+)?$/.test(t.name.slice(prefix.length)) && t.meas.kind === 'length');
  if (numeric.length >= 2 && numeric.every((t) => Math.abs(Number(t.name.slice(prefix.length)) * 4 - t.meas.px) < 0.01)) conv = 'quarter';
  return { prefix, conv };
}

function uniqueName(base, taken) {
  let n = base, i = 2;
  while (taken.has(n)) n = `${base}-${i++}`;
  taken.add(n);
  return n;
}

export function propose(findings, tokens, th, { all = false } = {}) {
  // emails / OG images and JS data colors aren't part of the UI's system; categories with no tokens yet are exactly what to bootstrap
  const pool = findings.filter((f) => (all || f.status === 'OFF-SCALE') && (!f.excluded || f.excluded === 'no-tokens'));
  const taken = new Set(tokens.map((t) => t.name));
  const proposals = [];
  const oneOffs = [];
  const cats = [...new Set(pool.map((f) => f.category))];
  for (const cat of cats) {
    const items = new Map();
    for (const f of pool.filter((x) => x.category === cat)) {
      const key = cat === 'color' ? f.color.key : cat === 'shadow' ? f.key : String(f.px ?? f.n ?? f.ms);
      const it = items.get(key) || { key, count: 0, sample: f, locations: [] };
      it.count++;
      it.locations.push(`${f.rel}:${f.line}`);
      items.set(key, it);
    }
    const sorted = [...items.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const clusters = [];
    for (const it of sorted) {
      const f = it.sample;
      const home = clusters.find((c) => {
        const g = c.center.sample;
        if (cat === 'color') return Math.abs(g.color.alpha - f.color.alpha) <= 0.05 && deltaE2000(g.color.lab, f.color.lab) <= Math.max(2.5, th.color * 0.75);
        if (cat === 'shadow') { const d = shadowDistance(g.shadow, f.shadow); return d.d !== Infinity && d.px <= 2 && d.de <= 3; }
        const a = g.px ?? g.n ?? g.ms, b = f.px ?? f.n ?? f.ms;
        if (cat === 'z-index' || cat === 'font-weight') return a === b;
        if (cat === 'duration') return Math.abs(a - b) <= Math.max(20, a * 0.12);
        return Math.abs(a - b) <= Math.max(1, a * 0.07);
      });
      if (home) { home.members.push(it); home.count += it.count; } else clusters.push({ center: it, members: [it], count: it.count });
    }
    const naming = namingFor(cat, tokens);
    for (const cl of clusters) {
      const f = cl.center.sample;
      if (cl.count < 2 && !all) { oneOffs.push({ category: cat, value: displayValue(f), location: cl.center.locations[0] }); continue; }
      let value = displayValue(f), name, note;
      if (cat === 'color') {
        const { family, step } = colorFamily(f.color);
        name = uniqueName(`${naming.prefix}${family}-${step}`, taken);
      } else if (cat === 'shadow') {
        name = uniqueName(`${naming.prefix}${proposals.filter((p) => p.category === 'shadow').length + 1}`, taken);
      } else if (cat === 'space' || cat === 'radius' || cat === 'font-size') {
        const px = f.px;
        const grid = px >= 8 ? 4 : 2;
        const snapped = Math.round(px / grid) * grid;
        if (snapped !== px && Math.abs(px % grid - grid / 2) > 0.01 && (cat === 'space' || cat === 'radius')) note = `consider snapping to ${snapped}px (${grid}px grid)`;
        value = `${+px.toFixed(3)}px`;
        const label = naming.conv === 'quarter' ? String(+(px / 4).toFixed(2)) : String(+px.toFixed(2));
        name = uniqueName(`${naming.prefix}${label}`, taken);
      } else if (cat === 'duration') {
        value = `${f.ms}ms`;
        name = uniqueName(`${naming.prefix}${f.ms}`, taken);
      } else {
        name = uniqueName(`${naming.prefix}${f.n}`, taken);
      }
      proposals.push({
        category: cat, name, value, count: cl.count, note,
        members: cl.members.map((m) => ({ value: displayValue(m.sample), count: m.count, hex: m.sample.color?.hex, locations: m.locations.slice(0, 5) })),
        hex: f.color?.hex,
      });
    }
  }
  proposals.sort((a, b) => b.count - a.count);
  return { proposals, oneOffs, css: toCss(proposals) };
}

function displayValue(f) {
  if (f.category === 'color') return f.color.alpha < 1 ? f.value : f.color.hex;
  if (f.category === 'shadow') return f.value;
  if (f.px != null) return `${+f.px.toFixed(3)}px`;
  if (f.ms != null) return `${f.ms}ms`;
  return String(f.n);
}

function toCss(proposals) {
  if (!proposals.length) return '';
  const lines = [':root {'];
  for (const p of proposals) {
    const from = p.members.map((m) => `${m.value}×${m.count}`).join(', ');
    lines.push(`  /* ${p.count} ${p.count === 1 ? 'use' : 'uses'}: ${from}${p.note ? ' · ' + p.note : ''} */`);
    lines.push(`  ${p.name}: ${p.value};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
