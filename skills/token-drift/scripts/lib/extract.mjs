// Extract raw design values (and token usages) from source files.
// Every finding carries absolute [start, end) offsets into the original file.
import path from 'node:path';
import { COLOR_RE, describeColor } from './color.mjs';
import { blankCssComments, walkCss, lexJs, splitSfc, maskedRanges, inRanges } from './parse.mjs';
import { LENGTH_RE, DURATION_RE, toPx, parseShadow, shadowKey } from './values.mjs';
import { UTILS, ALL_UTILS } from './tailwind.mjs';
import { ROOTISH } from '../tokens.mjs';

export const SCAN_EXTS = new Set(['.css', '.scss', '.less', '.pcss', '.postcss', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.astro', '.html', '.htm']);
const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

const SPACE_PROP = /^(margin|padding)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-|grid-|grid-row-|grid-column-)?gap$|^inset(-(inline|block)(-(start|end))?)?$|^(top|right|bottom|left)$|^scroll-(margin|padding)(-[a-z-]+)?$/;
const RADIUS_PROP = /^border(-(top|bottom|start|end)-(left|right|start|end))?-radius$/;
export const COLORISH_PROP = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|inline|block)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|text-emphasis-color|scrollbar-color|stop-color|flood-color|lighting-color|text-shadow)$/;
const DURATION_PROP = /^(transition|transition-duration|animation|animation-duration)$/;

export function propCategory(p) {
  if (SPACE_PROP.test(p)) return 'space';
  if (RADIUS_PROP.test(p)) return 'radius';
  if (p === 'font-size') return 'font-size';
  if (p === 'font-weight') return 'font-weight';
  if (p === 'z-index') return 'z-index';
  if (p === 'box-shadow') return 'shadow';
  if (DURATION_PROP.test(p)) return 'duration';
  return null;
}
function customPropCategory(name) {
  const n = name.toLowerCase();
  if (/radius|rounded/.test(n)) return 'radius';
  if (/font-size|text-size|(^|-)fs(-|$)/.test(n)) return 'font-size';
  if (/(^|-)(space|spacing|gap|gutter|pad|padding|margin|inset)(-|$)/.test(n)) return 'space';
  if (/shadow|elevation/.test(n)) return 'shadow';
  if (/duration|speed/.test(n)) return 'duration';
  return null;
}
const camelToKebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

export function makeIgnore(list = [], strict = false) {
  const set = new Set(strict ? [] : ['0px', '0rem', '1px', '-1px', '0.5px', '0ms', '0s', 'z:0', 'z:1', 'z:-1']);
  for (const v of list) set.add(String(v).toLowerCase());
  return set;
}

/**
 * Scan one file. Returns { findings, usage } where usage counts token references
 * per category (var(--x), $x, @x, tokenized Tailwind classes).
 */
export function extractFile(file, text, env) {
  const ext = path.extname(file).toLowerCase();
  const findings = [];
  const usage = {};
  const bump = (cat, n = 1) => { if (cat) usage[cat] = (usage[cat] || 0) + n; };
  const add = (f) => {
    const key = f.category === 'z-index' ? 'z:' + f.value : String(f.value).toLowerCase();
    if (env.ignore.has(key) || (f.color && env.ignore.has(f.color.key))) return;
    findings.push(f);
  };
  const S = { file, text, env, add, bump };
  const noVar = noVarReason(file, text);

  if (ext === '.css' || ext === '.scss' || ext === '.less' || ext === '.pcss' || ext === '.postcss') {
    scanCss(S, text, 0, ext === '.scss' ? 'scss' : ext === '.less' ? 'less' : 'css', 'css');
  } else if (JS_EXTS.has(ext)) {
    scanJs(S, text, 0);
  } else if (ext === '.vue' || ext === '.svelte' || ext === '.astro' || ext === '.html' || ext === '.htm') {
    const { regions, markup } = splitSfc(text);
    for (const r of regions) {
      if (r.kind === 'style') scanCss(S, r.content, r.start, r.lang === 'scss' || r.lang === 'less' ? r.lang : 'css', 'css');
      else if (!/json|template|html/.test(r.lang)) scanJs(S, r.content, r.start);
    }
    scanMarkup(S, markup);
    if (ext === '.astro') { const fm = text.match(/^---\n([\s\S]*?)\n---/); if (fm) scanJs(S, fm[1], 4); }
  }
  if (noVar) for (const f of findings) f.noVar = noVar;
  return { findings, usage, noVar };
}

/** Files whose renderer cannot resolve CSS variables: emails, OG images, React Native, PDFs. */
export function noVarReason(file, text) {
  const head = text.slice(0, 4000);
  if (/from\s+['"](next\/og|@vercel\/og|satori)['"]|\bImageResponse\b/.test(head)) return 'OG-image renderer (satori) has no CSS variables';
  if (/from\s+['"]react-native['"]/.test(head)) return 'React Native has no CSS variables';
  if (/from\s+['"](@react-email\/[\w-]+|mjml[\w-]*|@react-pdf\/renderer)['"]/.test(head)) return 'email/PDF renderer has no CSS variables';
  if (/\.html?$/i.test(file) && (/(^|[\/])(e-?mails?|mail|newsletters?)([\/]|$)/i.test(file) || /<!--\[if mso|mso-[a-z-]+\s*:|role=["']presentation["']|\bbgcolor=/i.test(text))) return 'email HTML: most email clients ignore CSS variables';
  return null;
}

/* ------------------------------------------------------------------ CSS -- */

function scanCss(S, content, base, lang, context, extra = {}) {
  const blanked = blankCssComments(content, lang);
  walkCss(blanked, {
    base,
    onDecl: ({ prop, value, valueStart, selectors }) => {
      if (prop.startsWith('$') || prop.startsWith('@')) return; // SCSS/LESS variable definitions are tokens
      if (prop.startsWith('--') && selectors.length && selectors.some((s) => ROOTISH.test(s))) return; // token definition
      scanDecl(S, prop, value, valueStart, { lang, context, selectors, ...extra });
    },
    onAt: ({ name, params, paramsStart }) => {
      if (name === 'apply') scanClasses(S, params, paramsStart, { lang, context: 'tw-class', inApply: true });
    },
  });
}

/** Scan one declaration value. `valueStart` is the absolute offset of value[0]. */
export function scanDecl(S, prop, value, valueStart, meta) {
  const p = prop.toLowerCase();
  const isCustom = p.startsWith('--');
  const cat = isCustom ? customPropCategory(p.slice(2)) : propCategory(p);
  const masks = maskedRanges(value);
  // token references count as tokenized usage for the property's category
  let refs = (value.match(/\bvar\(\s*--/g) || []).length + (value.match(/\btheme\(/g) || []).length;
  if (meta.lang === 'scss') refs += (value.replace(/#\{[^}]*\}/g, '').match(/(^|[\s(,-])\$[\w-]+/g) || []).length;
  if (meta.lang === 'less') refs += (value.match(/(^|[\s(,])@[\w-]+/g) || []).length;
  if (refs) S.bump(cat || (COLORISH_PROP.test(p) || isCustom ? 'color' : null), refs);
  const base = { file: S.file, prop: p, context: meta.context, lang: meta.lang };
  const important = value.match(/\s*!important\s*$/);
  const v = important ? value.slice(0, important.index) : value;

  if (cat === 'shadow') {
    if (masks.length || /\$|@[\w-]/.test(v)) return;
    const sh = parseShadow(v);
    if (sh) S.add({ ...base, category: 'shadow', value: v.trim(), start: valueStart, end: valueStart + v.trimEnd().length, shadow: sh, key: shadowKey(sh) });
    return;
  }
  // colors anywhere in the value (gradients, borders, custom props …)
  if (isCustom || COLORISH_PROP.test(p) || (!cat && !/^(-webkit-)?mask/.test(p))) {
    COLOR_RE.lastIndex = 0;
    let m;
    while ((m = COLOR_RE.exec(v))) {
      if (inRanges(masks, m.index)) continue;
      const color = describeColor(m[0]);
      if (!color || color.alpha === 0) continue; // fully transparent stops are not design colors
      S.add({ ...base, category: 'color', value: m[0], start: valueStart + m.index, end: valueStart + m.index + m[0].length, color });
    }
  }
  if (cat === 'space' || cat === 'radius' || cat === 'font-size') {
    LENGTH_RE.lastIndex = 0;
    let m;
    while ((m = LENGTH_RE.exec(v))) {
      if (inRanges(masks, m.index)) continue;
      const px = toPx(m[1], m[2]);
      S.add({ ...base, category: cat, value: m[0], start: valueStart + m.index, end: valueStart + m.index + m[0].length, px: Math.abs(px), negative: px < 0 });
    }
  } else if (cat === 'font-weight') {
    const t = v.trim();
    if (/^[1-9]00$/.test(t)) S.add({ ...base, category: cat, value: t, start: valueStart, end: valueStart + t.length, n: Number(t) });
  } else if (cat === 'z-index') {
    const t = v.trim();
    if (/^-?\d+$/.test(t)) S.add({ ...base, category: cat, value: t, start: valueStart, end: valueStart + t.length, n: Number(t) });
  } else if (cat === 'duration') {
    DURATION_RE.lastIndex = 0;
    let m;
    while ((m = DURATION_RE.exec(v))) {
      if (inRanges(masks, m.index)) continue;
      const ms = m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
      if (ms < 5) continue; // 0.01ms reduced-motion overrides
      S.add({ ...base, category: 'duration', value: m[0], start: valueStart + m.index, end: valueStart + m.index + m[0].length, ms });
    }
  }
}

/* ------------------------------------------------------------- markup -- */

function scanMarkup(S, markup) {
  const re = /(\s)(class|className|:class|v-bind:class|class:list|style)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(markup))) {
    const content = m[4] ?? m[5];
    const contentStart = m.index + m[0].length - content.length - 1;
    if (m[2] === 'style') {
      walkCss(content, { base: contentStart, onDecl: ({ prop, value, valueStart }) => scanDecl(S, prop, value, valueStart, { lang: 'css', context: 'style-attr' }) });
    } else {
      scanClasses(S, content, contentStart, { lang: 'html', context: 'tw-class' });
    }
  }
}

/* ----------------------------------------------------------------- JS -- */

const CSS_IN_JS_TAG = /(?:\bstyled(?:\.[\w$]+|\([^()]*\))(?:\.attrs\([^()]*\))?|\bcss|\bcreateGlobalStyle|\bkeyframes|\binjectGlobal|\bglobal)\s*$/;

function scanJs(S, content, base) {
  const { blanked, strings } = lexJs(content);
  const consumed = new Set();
  // 1) CSS-in-JS tagged templates
  for (const s of strings) {
    if (s.quote !== '`') continue;
    if (!CSS_IN_JS_TAG.test(blanked.slice(Math.max(0, s.start - 80), s.start))) continue;
    let css = s.content;
    for (const [hs, he] of s.holes) {
      const a = hs - s.contentStart, b = he - s.contentStart;
      css = css.slice(0, a) + ' '.repeat(b - a) + css.slice(b);
    }
    scanCss(S, css, base + s.contentStart, 'css', 'css-in-js');
    consumed.add(s.start);
  }
  // 2) JSX inline style objects: style={{ … }}
  const styleRe = /\bstyle\s*=\s*\{\{/g;
  let m;
  while ((m = styleRe.exec(blanked))) {
    const open = m.index + m[0].length - 1; // the inner {
    const close = matchBrace(blanked, open, strings);
    if (close === -1) continue;
    scanStyleObject(S, content, blanked, strings, open + 1, close, base, consumed);
  }
  // 3) Every other string: Tailwind classes + bare color literals
  for (const s of strings) {
    if (consumed.has(s.start)) continue;
    let str = s.content;
    for (const [hs, he] of s.holes) {
      const a = hs - s.contentStart, b = he - s.contentStart;
      str = str.slice(0, a) + ' '.repeat(b - a) + str.slice(b);
    }
    scanClasses(S, str, base + s.contentStart, { lang: 'js', context: 'tw-class' });
    const t = str.trim();
    if (/^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch|oklab)\([^()]*\))$/.test(t)) {
      const color = describeColor(t);
      if (color) {
        const off = str.indexOf(t);
        S.add({ file: S.file, prop: '(string literal)', context: 'js-literal', lang: 'js', category: 'color', value: t, start: base + s.contentStart + off, end: base + s.contentStart + off + t.length, color });
      }
    }
  }
}

function matchBrace(text, open, strings) {
  let d = 0;
  let si = 0;
  for (let i = open; i < text.length; i++) {
    while (si < strings.length && strings[si].end <= i) si++;
    if (si < strings.length && strings[si].start <= i && i < strings[si].end) { i = strings[si].end - 1; continue; }
    const ch = text[i];
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d === 0) return i; }
  }
  return -1;
}

const UNITLESS = new Set(['z-index', 'font-weight']);

function scanStyleObject(S, content, blanked, strings, from, to, base, consumed) {
  // walk top-level `key: value` pairs
  const inner = strings.filter((s) => s.start >= from && s.end <= to);
  const strAt = new Map(inner.map((s) => [s.start, s]));
  let i = from;
  while (i < to) {
    const keyM = /^\s*,?\s*(?:(['"])([\w-]+)\1|([A-Za-z_$][\w$]*))\s*:\s*/.exec(blanked.slice(i, to));
    if (!keyM) {
      const nextComma = findTopLevel(blanked, i, to, ',', inner);
      if (nextComma === -1) break;
      i = nextComma + 1; continue;
    }
    const key = keyM[2] || keyM[3];
    const vs = i + keyM[0].length;
    let ve = findTopLevel(blanked, vs, to, ',', inner);
    if (ve === -1) ve = to;
    const prop = key.startsWith('--') ? key : camelToKebab(key);
    const valueText = content.slice(vs, ve);
    const trimmed = valueText.trim();
    const lead = valueText.length - valueText.trimStart().length;
    const meta = { lang: 'css', context: 'jsx-style' };
    const numM = trimmed.match(/^(-?\d*\.?\d+)$/);
    if (numM) {
      const cat = propCategory(prop);
      const n = Number(numM[1]);
      const st = base + vs + lead, en = st + trimmed.length;
      if (cat === 'space' || cat === 'radius' || cat === 'font-size') {
        S.add({ file: S.file, prop, context: 'jsx-style', lang: 'css', category: cat, value: trimmed + 'px', display: trimmed, numeric: true, start: st, end: en, px: Math.abs(n), negative: n < 0 });
      } else if (UNITLESS.has(prop) && Number.isInteger(n)) {
        if (cat === 'font-weight' && !/^[1-9]00$/.test(trimmed)) { /* skip */ } else S.add({ file: S.file, prop, context: 'jsx-style', lang: 'css', category: cat, value: trimmed, numeric: true, start: st, end: en, n });
      }
    } else {
      for (const s of inner) {
        if (s.start < vs || s.end > ve) continue;
        consumed.add(s.start);
        if (s.holes.length) continue;
        scanDecl(S, prop, s.content, base + s.contentStart, meta);
      }
    }
    i = ve + 1;
  }
  // any remaining strings inside the style object belong to it
  for (const s of inner) consumed.add(s.start);
  void strAt;
}

function findTopLevel(text, from, to, ch, strings) {
  let d = 0;
  for (let i = from; i < to; i++) {
    const s = strings.find((x) => x.start === i);
    if (s) { i = s.end - 1; continue; }
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
    else if (c === ch && d === 0) return i;
  }
  return -1;
}

/* ---------------------------------------------------------- Tailwind -- */

const UTIL_CATS = {};
for (const [cat, list] of Object.entries(UTILS)) for (const u of list) (UTIL_CATS[u] ||= []).push(cat);

function scanClasses(S, str, base, meta) {
  if (!str || str.length > 20000) return;
  const tw = S.env.tailwind;
  const prefix = tw?.prefix || '';
  const re = /[^\s'"`{}]+/g;
  let m;
  while ((m = re.exec(str))) {
    const tok = m[0];
    if (tok.length > 200) continue;
    // split variants on ':' outside brackets
    let depth = 0, last = -1;
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] === '[' || tok[i] === '(') depth++;
      else if (tok[i] === ']' || tok[i] === ')') depth--;
      else if (tok[i] === ':' && depth === 0) last = i;
    }
    const variants = tok.slice(0, last + 1);
    let u = tok.slice(last + 1);
    let impPre = '', impSuf = '';
    if (u.startsWith('!')) { impPre = '!'; u = u.slice(1); }
    if (u.endsWith('!')) { impSuf = '!'; u = u.slice(0, -1); }
    let neg = false;
    if (u.startsWith('-')) { neg = true; u = u.slice(1); }
    if (prefix) { if (!u.startsWith(prefix)) continue; u = u.slice(prefix.length); }
    const arb = u.match(/^([a-z][a-z0-9-]*?)-\[(.+)\](\/[\w.[\]]+)?$/);
    if (arb) {
      const util = arb[1];
      if (!UTIL_CATS[util]) continue;
      let val = arb[2].replace(/_/g, ' ');
      const hintM = val.match(/^(color|length|size|percentage|number|any|shadow|line-width):(.*)$/);
      const hint = hintM ? hintM[1] : null;
      if (hintM) val = hintM[2];
      if (/\bvar\(|\btheme\(/.test(val)) {
        S.bump(util === 'text' ? (hint === 'length' ? 'font-size' : 'color') : UTIL_CATS[util][0]);
        continue;
      }
      let cat = null;
      const f = { file: S.file, prop: util, context: 'tw-class', lang: meta.lang, value: tok.slice(last + 1), display: tok, start: base + m.index, end: base + m.index + tok.length,
        tw: { variants, impPre, impSuf, neg, util, modifier: arb[3] || '', prefix } };
      const lenM = val.match(/^(-?\d*\.?\d+)(px|rem)$/);
      if (UTILS.color.includes(util) && hint !== 'length' && /^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch|oklab)\(.*\))$/.test(val)) {
        const color = describeColor(val);
        if (color) { cat = 'color'; f.color = color; }
      } else if (lenM) {
        const px = toPx(lenM[1], lenM[2]);
        if (UTILS.space.includes(util)) cat = 'space';
        else if (util === 'text') cat = 'font-size';
        else if (UTILS.radius.includes(util)) cat = 'radius';
        if (cat) { f.px = Math.abs(px); f.negative = neg || px < 0; }
      } else if (util === 'z' && /^-?\d+$/.test(val)) { cat = 'z-index'; f.n = Number(val) * (neg ? -1 : 1); }
      else if (util === 'font' && /^[1-9]00$/.test(val)) { cat = 'font-weight'; f.n = Number(val); }
      else if (util === 'duration' && /^\d*\.?\d+m?s$/.test(val)) { cat = 'duration'; f.ms = val.endsWith('ms') ? parseFloat(val) : parseFloat(val) * 1000; }
      else if (util === 'shadow') { const sh = parseShadow(val); if (sh) { cat = 'shadow'; f.shadow = sh; f.key = shadowKey(sh); } }
      if (!cat) continue;
      f.category = cat;
      f.raw = val;
      S.add(f);
      continue;
    }
    // Tailwind v4 shorthand for variables: bg-(--brand)
    const v4var = u.match(/^([a-z][a-z0-9-]*?)-\((?:[a-z-]+:)?--[\w-]+\)$/);
    if (v4var && UTIL_CATS[v4var[1]]) { S.bump(UTIL_CATS[v4var[1]][0]); continue; }
    // canonical, tokenized classes (p-4, text-brand-500, rounded-lg) count as token usage
    if (!tw?.version || !S.env.fragments) continue;
    const core = u.replace(/\/[\w.]+$/, '');
    for (const util of ALL_UTILS) {
      let frag;
      if (core === util) frag = 'DEFAULT';
      else if (core.startsWith(util + '-')) frag = core.slice(util.length + 1);
      else continue;
      const cat = UTIL_CATS[util].find((c) => S.env.fragments[c]?.has(frag));
      if (cat) { S.bump(cat); break; }
    }
  }
}
