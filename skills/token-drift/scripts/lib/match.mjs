// Nearest-token matching, EXACT / NEAR / OFF-SCALE classification and the
// per-context fix (replacement text) for each finding.
import { deltaE2000, oklabDistance } from './color.mjs';
import { shadowDistance } from './values.mjs';
import { AMBIGUOUS, NEGATABLE } from './tailwind.mjs';

export const DEFAULT_THRESHOLDS = { color: 4, size: 2, pct: 5, font: 1, duration: 15, weight: 50 };

export function parseThresholds(list = []) {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const item of list) {
    const [k, v] = item.split('=');
    if (!(k in t) || Number.isNaN(Number(v))) throw new Error(`Bad --threshold "${item}". Use e.g. color=4,size=2,pct=5,font=1,duration=15,weight=50`);
    t[k] = Number(v);
  }
  return t;
}

/** Build per-category candidate lists and Tailwind fragment sets. */
const valueKey = (t) => (t.meas.kind === 'color' ? t.meas.color.key : t.meas.kind === 'length' ? 'px' + t.meas.px : t.meas.kind === 'duration' ? 'ms' + t.meas.ms : t.meas.kind === 'number' ? 'n' + t.meas.n : t.meas.key);

export function buildIndex(tokens, scopes = null, reach = null, themeReach = null) {
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
  const hasLocal = {};
  for (const t of tokens) if (t.localFile) hasLocal[t.category] = true;
  return { byCat, fragments, scopes, cache: new Map(), hasLocal, reach, themeReach };
}

/**
 * The tokens a finding can actually use: drops tokens from unrelated workspace
 * packages, Tailwind tokens of the other major version, file-local SCSS
 * variables of other files, and class-only framework defaults outside class
 * strings. When one name has different values among the visible tokens, the
 * nearest package wins; if the nearest still disagree the name is ambiguous.
 */
function candidatesFor(f, index) {
  const { scopes } = index;
  const cls = f.context === 'tw-class' ? 'c' : 'x';
  const key = `${f.category}|${f.pkg || ''}|${f.twv || ''}|${cls}|${index.hasLocal[f.category] ? f.file : ''}`;
  const hit = index.cache.get(key);
  if (hit) return hit;
  const out = [];
  for (const t of index.byCat[f.category] || []) {
    if (t.localFile && t.localFile !== f.file) continue;
    if (t.twv && f.twv && t.twv !== f.twv) continue;
    if (t.isDefault && t.twv && !f.twv) continue;
    // class-only framework defaults (Tailwind v3 scales) still tell us a value is on scale where Tailwind compiles
    if (cls === 'x' && t.isDefault && !t.refs.css && !t.refs.scss && !t.refs.less && !f.twv) continue;
    let rank = scopes?.multi && t.pkg && f.pkg ? scopes.rank(f.pkg, t.pkg) : 0;
    // a v4 @theme class only exists where the Tailwind entry compiling this file includes that @theme
    if (cls === 'c' && t.tw4 && t.file && index.themeReach) {
      const ok = index.themeReach(f.file, t.file);
      if (ok === false) continue;
      if (ok === true && rank === Infinity) rank = 3;
    }
    if (rank === Infinity) continue;
    out.push({ t, rank });
  }
  const byName = new Map();
  for (const c of out) (byName.get(c.t.name) || byName.set(c.t.name, []).get(c.t.name)).push(c);
  const ambiguous = new Map();
  const keep = [];
  for (const [name, list] of byName) {
    if (list.length === 1 || new Set(list.map((c) => valueKey(c.t))).size === 1) { keep.push(...list); continue; }
    const min = Math.min(...list.map((c) => c.rank));
    const nearest = list.filter((c) => c.rank === min);
    keep.push(...nearest);
    if (new Set(nearest.map((c) => valueKey(c.t))).size > 1) ambiguous.set(name, nearest.map((c) => `${c.t.value}${c.t.file ? ' (' + shortPath(c.t.file) + ')' : ''}`));
  }
  // file-local variables first: a value defined in this very file is its own token
  const res = { list: keep, ambiguous };
  index.cache.set(key, res);
  return res;
}
const shortPath = (p) => p.split(/[\\/]/).slice(-3).join('/');

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
      // 9999px, 624.9375rem and calc(1px * infinity) all mean "pill"
      if (f.category === 'radius' && f.px >= 999 && m.px >= 999) return { d: 0, exact: true, abs: 0, pct: 0 };
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

function isNear(f, dist, th, t = null) {
  switch (f.category) {
    case 'color':
      // pure white / black are almost always deliberate, not a drifted off-white
      if ((f.color.key === '#ffffff' || f.color.key === '#000000') && dist.deltaE > 1) return false;
      return dist.deltaE <= (t?.isDefault ? th.color / 2 : th.color) && dist.alpha <= Math.min(0.05, Math.max(0.011, f.color.alpha * 0.25));
    // every px is a visible step in a type scale, so font sizes get a tighter absolute bound
    case 'font-size': return dist.abs <= th.font || dist.pct <= th.pct;
    // offsets (top/left/inset) are positions, not rhythm: only snap them when they're within a couple of px
    case 'space': if (/^(top|right|bottom|left|start|end|inset)/.test(f.prop)) return dist.abs <= th.size && dist.pct <= 25;
      return (dist.abs <= th.size && dist.pct <= 25) || dist.pct <= th.pct;
    case 'radius': return (dist.abs <= th.size && dist.pct <= 25) || dist.pct <= th.pct;
    case 'font-weight': return dist.abs <= th.weight;
    case 'z-index': return false;
    case 'duration': return dist.abs <= 10 || dist.pct <= th.duration;
    case 'shadow': return dist.d !== Infinity && dist.px <= th.size && dist.de <= th.color && dist.da <= 0.05;
  }
  return false;
}

/** Can token `t` be referenced from this finding's context? Returns the reference string or null. */
export function referenceFor(f, t, index) {
  const r = t.refs;
  if (f.context === 'js-literal') return null;
  if (f.context === 'tw-class') return null; // handled by twReplacement
  if (f.context === 'css' && (r.scss || r.less) && ((f.lang === 'scss' && r.scss) || (f.lang === 'less' && r.less))) {
    // a preprocessor variable only exists where its file is imported (@import, @use … as *, or @use with a namespace)
    const prefix = !t.file || t.file === f.file ? '' : index?.reach ? index.reach(f.file).get(t.file) : '';
    if (prefix !== undefined) return f.lang === 'scss' ? (prefix ? prefix + r.scss : r.scss) : r.less;
  }
  if (r.css && !r.cssAssumed) return r.css;
  return null;
}

function twReplacement(f, t) {
  const { variants, impPre, impSuf, util, modifier, prefix } = f.tw;
  // `-mt-[4px]` and `mt-[-4px]` are both negative; `-mt-[-4px]` is positive
  const neg = f.category === 'z-index' ? f.n < 0 : !!f.negative;
  // `/x` is opacity on colors (unsafe with var-backed colors) but line-height on text-[size] (kept as is)
  if (modifier && !(f.category === 'font-size' && t.refs.tw != null)) return null;
  if (neg && !NEGATABLE.has(util)) return null;
  const head = variants + impPre + (neg ? '-' : '') + prefix;
  // text-sm also sets line-height; text-[14px] doesn't. Keep the canonical class only when a leading-* or /lh
  // already pins the line height, else use the theme variable (font-size only) or leave it to a human.
  if (f.category === 'font-size' && t.refs.tw != null && !modifier && !f.tw.hasLeading) {
    if (t.refs.css && !t.refs.cssAssumed && /^var\(/.test(t.refs.css)) return `${head}${util}-[length:${t.refs.css}]${impSuf}`;
    return null;
  }
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

const CAT_WORD = { radius: /^(radius|radii|rounded|border(radius)?|corner)/i, space: /^(space|spacing|spacer|gap|size|sp|s|scale)\b/i, 'font-size': /^(font|fs|text|type|typo|size|fontsize)/i, 'z-index': /^(z|zindex|z-index|layer|elevation)/i, duration: /^(duration|motion|transition|speed|time)/i };
const SEMANTIC = [
  [/^background|^bg/, /bg|background|surface|canvas|base/],
  [/^color$|^fill$/, /text|fg|ink|foreground|body|content/],
  [/^border|^outline|^stroke/, /border|line|divider|stroke|outline/],
];

function preference(f, t, rank = 0, index = null) {
  let p = rank * 0.05;
  if (f.context === 'tw-class') p += t.refs.tw != null ? 0 : t.refs.css && !t.refs.cssAssumed ? 1 : 3;
  else if (f.context === 'js-literal') p += t.refs.css ? 0 : 1;
  else {
    const ref = referenceFor(f, t, index);
    if (!ref) p += 3;
    else if (ref === t.name || ref.endsWith('.' + t.name)) p += 0; // $x / @x in its own language
    else if (ref === `var(${t.name})`) p += 0.5; // the CSS variable itself
    else p += 0.9; // an alias that resolves to it (e.g. a Tailwind color pointing at a var)
  }
  // framework defaults lose ties to project tokens; for colors even against a var() reference
  // (bg-[color:var(--color-danger)] carries intent that bg-red-600 doesn't), for scales a class still wins
  if (t.isDefault) p += (t.onProjectScale ? 0.25 : 0.75) + (f.category === 'color' ? 1 : 0);
  // scale tokens (--radius-*, --space-*) over component tokens (--avatar-border-radius) on ties
  if (CAT_WORD[f.category] && !CAT_WORD[f.category].test(t.name.replace(/^[-$@]+/, '').split(/[-_.]/)[0])) p += 0.1;
  if (f.category === 'color') {
    for (const [pr, nr] of SEMANTIC) if (pr.test(f.prop) && nr.test(t.name)) { p -= 0.2; break; }
    if (roleMismatch(f.prop, t.name) || roleMismatch(f.prop, aliasOf(t))) p += 0.3; // a role-free primitive beats a token meant for another role
    // a custom property or other role-less spot: prefer the palette primitive over someone else's semantic alias
    else if (!ROLE_OF_PROP.some(([, re]) => re.test(String(f.prop).toLowerCase())) && aliasOf(t)) p += 0.05;
  }
  return p;
}

// semantic color roles: a border token shouldn't be pasted into a background just because the hex matches
const ROLE_OF_TOKEN = [['backgrounds', /^(bg|background|backgrounds|surface|canvas|backdrop|base|page|app)$/], ['text', /^(text|fg|foreground|ink|on|content|copy)$/], ['borders', /^(border|borders|outline|divider|stroke|ring|line|separator)$/]];
const ROLE_OF_PROP = [['backgrounds', /^(background|background-color|background-image|bg|from|via|to)$/], ['text', /^(color|text|caret|caret-color|placeholder|decoration|text-decoration-color|accent)$/], ['borders', /^(border|border-[a-z-]*|outline|outline-color|divide|ring|ring-offset|column-rule)$/]];
// `--color-emphasis: var(--cal-bg-emphasis)` carries the role of what it points at
const aliasOf = (t) => (String(t.raw || '').match(/^var\(\s*(--[\w-]+)/) || [])[1] || '';
export function roleMismatch(prop, tokenName) {
  if (!tokenName) return null;
  const segs = String(tokenName).replace(/^[-$@]+/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_.]+/);
  const tRole = ROLE_OF_TOKEN.find(([, re]) => segs.some((s) => re.test(s)))?.[0];
  const pRole = ROLE_OF_PROP.find(([, re]) => re.test(String(prop).toLowerCase()))?.[0];
  if (!tRole || !pRole || tRole === pRole) return null;
  // `--on-primary` / `--primary-foreground` style names are text tokens even if they also say "bg"
  if (segs.includes('foreground') || segs.includes('on')) return pRole === 'text' ? null : 'text';
  return tRole;
}

/** Classify every finding in place. */
export function classify(findings, index, th) {
  for (const f of findings) {
    const { list: cands, ambiguous } = candidatesFor(f, index);
    const scored = [];
    for (const { t, rank } of cands) {
      const dist = distance(f, t);
      if (!dist || dist.d === Infinity || Number.isNaN(dist.d)) continue;
      scored.push({ t, dist, rank, pref: preference(f, t, rank, index) });
    }
    scored.sort((a, b) => (Math.round(a.dist.d * 1000) - Math.round(b.dist.d * 1000)) || (a.pref - b.pref) || a.t.name.localeCompare(b.t.name));
    const best = scored[0];
    if (!best) {
      f.status = 'OFF-SCALE'; f.token = null; f.fix = null;
      f.fixNote = cands.length ? (f.category === 'shadow' ? 'no token with the same shadow structure (layers / inset)' : 'no comparable token') : (index.byCat[f.category] || []).length ? 'no token of this category is usable here (other package, other Tailwind version, or class-only)' : 'no token in this category';
      continue;
    }
    f.status = best.dist.exact ? 'EXACT' : isNear(f, best.dist, th, best.t) ? 'NEAR' : 'OFF-SCALE';
    f.token = best.t;
    f.distance = best.dist;
    f.alternatives = scored.slice(1, 3).filter((s) => Math.abs(s.dist.d - best.dist.d) < 0.001).map((s) => s.t.name);
    // midway between two different scale steps (10px between 8 and 12): not drift toward either one
    const tie = f.status === 'NEAR' && f.category !== 'color' && scored.find((s) => s !== best && Math.abs(s.dist.d - best.dist.d) < 0.001 && valueKey(s.t) !== valueKey(best.t));
    if (tie) { f.status = 'OFF-SCALE'; f.between = [best.t.name, tie.t.name]; }
    // fix
    f.fix = null;
    if (f.status === 'OFF-SCALE') { f.fixNote = f.between ? `midway between ${f.between[0]} and ${f.between[1]}: pick one, or add a token` : 'off-scale: add a token or keep as a deliberate one-off'; continue; }
    if (f.noVar) { f.fixNote = f.noVar + '; review by hand'; continue; }
    if (f.noFix) { f.fixNote = f.noFix; continue; }
    if (f.context === 'js-literal') { f.fixNote = 'string literal in JS (canvas/charts may not accept var()); review by hand'; continue; }
    if (ambiguous.has(best.t.name)) { f.ambiguous = true; f.fixNote = `${best.t.name} has different values in the packages this file can see (${ambiguous.get(best.t.name).join(' vs ')}); fix by hand`; continue; }
    const role = f.category === 'color' ? roleMismatch(f.prop, best.t.name) || roleMismatch(f.prop, aliasOf(best.t)) : null;
    if (role) { f.fixNote = `nearest token ${best.t.name} is meant for ${role}; pick a token for this property by hand`; continue; }
    // z-index tokens are usually named layers (--z-modal); equal numbers don't mean "same layer", so suggest, don't rewrite
    if (f.category === 'z-index' && f.context !== 'tw-class' && !/(^|[-_.×\s])-?\d+$/.test(best.t.name)) { f.fixNote = `${best.t.name} is a named layer; use it only if this element belongs to that layer`; continue; }
    if (best.t.scoped && best.rank > 0) { f.fixNote = `${best.t.name} is defined inside ${best.t.scoped} (another package); fix by hand if this code renders there`; continue; }
    if (best.t.themes === 'theme-only') { f.fixNote = `${best.t.name} is only defined inside alternative theme scopes; fix by hand`; continue; }
    if (f.context === 'tw-class') {
      const rep = twReplacement(f, best.t);
      if (rep) f.fix = { start: f.start, end: f.end, text: rep };
      else f.fixNote = f.tw.modifier ? `has a /modifier (${f.tw.modifier}); rewrite by hand`
        : f.category === 'font-size' && best.t.refs.tw != null ? `${best.t.usage.split('  ·  ').find((u) => /^text-/.test(u)) || 'the text-* class'} also sets line-height; add a leading-* class or rewrite by hand`
        : f.category === 'shadow' ? `use the token by hand (${best.t.usage}); Tailwind cannot reliably type a var() shadow`
        : 'no Tailwind class or CSS variable for this token';
      continue;
    }
    if (f.negative) { f.fixNote = 'negative value: rewrite as calc(-1 * token) by hand'; continue; }
    const ref = referenceFor(f, best.t, index);
    if (!ref && best.t.refs.tw != null && f.context === 'jsx-style') { f.fixNote = `inline style can't use a Tailwind theme value; use the class (${best.t.usage.split('  ·  ').find((u) => !u.startsWith('theme(')) || best.t.usage}) instead`; continue; }
    if (!ref) { f.fixNote = best.t.refs.cssAssumed ? 'token JSON has no generated CSS variable in this repo' : (best.t.refs.scss || best.t.refs.less) && f.lang === (best.t.refs.scss ? 'scss' : 'less') ? `${best.t.name} is not imported into this file (@use/@import its file first)` : `token not referenceable from ${f.lang} (${best.t.usage})`; continue; }
    if (f.context === 'jsx-style') {
      f.fix = f.numeric ? { start: f.start, end: f.end, text: `'${ref}'` } : { start: f.start, end: f.end, text: ref };
    } else {
      f.fix = { start: f.start, end: f.end, text: ref };
    }
  }
  return findings;
}
