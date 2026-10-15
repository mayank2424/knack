// Nearest-token matching, EXACT / NEAR / OFF-SCALE classification and the
// per-context fix (replacement text) for each finding.
import { deltaE2000, oklabDistance } from './color.mjs';
import { shadowDistance } from './values.mjs';
import { AMBIGUOUS, NEGATABLE } from './tailwind.mjs';

export const DEFAULT_THRESHOLDS = { color: 4, size: 2, pct: 10, duration: 15, weight: 50 };

export function parseThresholds(list = []) {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const item of list) {
    const [k, v] = item.split('=');
    if (!(k in t) || Number.isNaN(Number(v))) throw new Error(`Bad --threshold "${item}". Use e.g. color=4,size=2,pct=10,duration=15,weight=50`);
    t[k] = Number(v);
  }
  return t;
}

/** Build per-category candidate lists and Tailwind fragment sets. */
const valueKey = (t) => (t.meas.kind === 'color' ? t.meas.color.key : t.meas.kind === 'length' ? 'px' + t.meas.px : t.meas.kind === 'duration' ? 'ms' + t.meas.ms : t.meas.kind === 'number' ? 'n' + t.meas.n : t.meas.key);

export function buildIndex(tokens) {
  const byCat = {};
  const fragments = {};
  const projectValues = new Set();
  for (const t of tokens) {
    if (t.mode !== 'base') continue;
    (byCat[t.category] ||= []).push(t);
    if (t.refs.tw != null) (fragments[t.category] ||= new Set()).add(t.refs.tw);
    if (!t.isDefault) projectValues.add(t.category + ':' + valueKey(t));
  }
  // a framework default that lands on a value the project itself tokenized is "on scale"
  for (const t of tokens) t.onProjectScale = !t.isDefault || projectValues.has(t.category + ':' + valueKey(t));
  return { byCat, fragments };
}

function distance(f, t) {
  const m = t.meas;
  switch (f.category) {
    case 'color': {
      if (m.kind !== 'color') return null;
      const de = deltaE2000(f.color.lab, m.color.lab);
      const da = Math.abs(f.color.alpha - m.color.alpha);
      return { d: de + da * 100, exact: f.color.key === m.color.key, deltaE: de, oklab: oklabDistance(f.color.oklab, m.color.oklab), alpha: da };
    }
    case 'space': case 'radius': case 'font-size': {
      if (m.kind !== 'length') return null;
      const abs = Math.abs(f.px - m.px);
      return { d: abs, exact: abs < 0.01, abs, pct: m.px ? (abs / m.px) * 100 : (f.px ? 100 : 0) };
    }
    case 'font-weight': case 'z-index': {
      if (m.kind !== 'number') return null;
      const abs = Math.abs(f.n - m.n);
      return { d: abs, exact: abs === 0, abs, pct: m.n ? (abs / Math.abs(m.n)) * 100 : 100 };
    }
    case 'duration': {
      if (m.kind !== 'duration') return null;
      const abs = Math.abs(f.ms - m.ms);
      return { d: abs, exact: abs < 0.5, abs, pct: m.ms ? (abs / m.ms) * 100 : 100 };
    }
    case 'shadow': {
      if (m.kind !== 'shadow') return null;
      const sd = shadowDistance(f.shadow, m.layers);
      return { ...sd, exact: f.key === m.key };
    }
  }
  return null;
}

function isNear(f, dist, th) {
  switch (f.category) {
    case 'color': return dist.deltaE <= th.color && dist.alpha <= Math.min(0.05, Math.max(0.011, f.color.alpha * 0.25));
    case 'space': case 'radius': case 'font-size': return (dist.abs <= th.size && dist.pct <= 25) || dist.pct <= th.pct;
    case 'font-weight': return dist.abs <= th.weight;
    case 'z-index': return false;
    case 'duration': return dist.abs <= 30 || dist.pct <= th.duration;
    case 'shadow': return dist.d !== Infinity && dist.px <= th.size && dist.de <= th.color && dist.da <= 0.05;
  }
  return false;
}

/** Can token `t` be referenced from this finding's context? Returns the reference string or null. */
export function referenceFor(f, t) {
  const r = t.refs;
  if (f.context === 'js-literal') return null;
  if (f.context === 'tw-class') return null; // handled by twReplacement
  if (f.context === 'css' || f.context === 'css-in-js') {
    if (f.lang === 'scss' && r.scss) return r.scss;
    if (f.lang === 'less' && r.less) return r.less;
  }
  if (r.css && !r.cssAssumed) return r.css;
  return null;
}

function twReplacement(f, t) {
  const { variants, impPre, impSuf, neg, util, modifier, prefix } = f.tw;
  // `/x` is opacity on colors (unsafe with var-backed colors) but line-height on text-[size] (kept as is)
  if (modifier && !(f.category === 'font-size' && t.refs.tw != null)) return null;
  if (neg && !NEGATABLE.has(util)) return null;
  const head = variants + impPre + (neg ? '-' : '') + prefix;
  if (t.refs.tw != null) {
    const frag = t.refs.tw;
    return head + (frag === 'DEFAULT' ? util : `${util}-${frag}`) + modifier + impSuf;
  }
  if (t.refs.css && !t.refs.cssAssumed && !neg && f.category !== 'shadow') {
    let hint = '';
    if (AMBIGUOUS.has(util)) hint = f.category === 'color' ? 'color:' : f.category === 'font-size' ? 'length:' : '';
    return `${head}${util}-[${hint}${t.refs.css}]${impSuf}`;
  }
  return null;
}

const SEMANTIC = [
  [/^background|^bg/, /bg|background|surface|canvas|base/],
  [/^color$|^fill$/, /text|fg|ink|foreground|body|content/],
  [/^border|^outline|^stroke/, /border|line|divider|stroke|outline/],
];

function preference(f, t) {
  let p = 0;
  if (f.context === 'tw-class') p += t.refs.tw != null ? 0 : t.refs.css && !t.refs.cssAssumed ? 1 : 3;
  else if (f.context === 'js-literal') p += t.refs.css ? 0 : 1;
  else {
    const ref = referenceFor(f, t);
    if (!ref) p += 3;
    else if (ref === t.name) p += 0; // $x / @x in its own language
    else if (ref === `var(${t.name})`) p += 0.5; // the CSS variable itself
    else p += 0.9; // an alias that resolves to it (e.g. a Tailwind color pointing at a var)
  }
  if (t.isDefault) p += t.onProjectScale ? 0.25 : 0.75;
  if (f.category === 'color') {
    for (const [pr, nr] of SEMANTIC) if (pr.test(f.prop) && nr.test(t.name)) { p -= 0.2; break; }
  }
  return p;
}

/** Classify every finding in place. */
export function classify(findings, index, th) {
  for (const f of findings) {
    let cands = index.byCat[f.category] || [];
    // framework defaults without a CSS reference only make sense inside class strings
    if (f.context !== 'tw-class') cands = cands.filter((t) => !(t.isDefault && !t.refs.css && !t.refs.scss && !t.refs.less));
    const scored = [];
    for (const t of cands) {
      const dist = distance(f, t);
      if (!dist || dist.d === Infinity || Number.isNaN(dist.d)) continue;
      scored.push({ t, dist, pref: preference(f, t) });
    }
    scored.sort((a, b) => (Math.round(a.dist.d * 1000) - Math.round(b.dist.d * 1000)) || (a.pref - b.pref) || a.t.name.localeCompare(b.t.name));
    const best = scored[0];
    if (!best) {
      f.status = 'OFF-SCALE'; f.token = null; f.fix = null;
      f.fixNote = (index.byCat[f.category] || []).length ? 'only Tailwind theme tokens exist for this category (use a class, or add a CSS variable)' : 'no token in this category';
      continue;
    }
    f.status = best.dist.exact ? 'EXACT' : isNear(f, best.dist, th) ? 'NEAR' : 'OFF-SCALE';
    f.token = best.t;
    f.distance = best.dist;
    f.alternatives = scored.slice(1, 3).filter((s) => Math.abs(s.dist.d - best.dist.d) < 0.001).map((s) => s.t.name);
    // fix
    f.fix = null;
    if (f.status === 'OFF-SCALE') { f.fixNote = 'off-scale: add a token or keep as a deliberate one-off'; continue; }
    if (f.noVar) { f.fixNote = f.noVar + '; review by hand'; continue; }
    if (f.context === 'js-literal') { f.fixNote = 'string literal in JS (canvas/charts may not accept var()); review by hand'; continue; }
    if (f.context === 'tw-class') {
      const rep = twReplacement(f, best.t);
      if (rep) f.fix = { start: f.start, end: f.end, text: rep };
      else f.fixNote = f.tw.modifier ? `has a /modifier (${f.tw.modifier}); rewrite by hand`
        : f.category === 'shadow' ? `use the token by hand (${best.t.usage}); Tailwind cannot reliably type a var() shadow`
        : 'no Tailwind class or CSS variable for this token';
      continue;
    }
    if (f.negative) { f.fixNote = 'negative value — rewrite as calc(-1 * token) by hand'; continue; }
    const ref = referenceFor(f, best.t);
    if (!ref) { f.fixNote = best.t.refs.cssAssumed ? 'token JSON has no generated CSS variable in this repo' : `token not referenceable from ${f.lang} (${best.t.usage})`; continue; }
    if (f.context === 'jsx-style') {
      f.fix = f.numeric ? { start: f.start, end: f.end, text: `'${ref}'` } : { start: f.start, end: f.end, text: ref };
    } else {
      f.fix = { start: f.start, end: f.end, text: ref };
    }
  }
  return findings;
}
