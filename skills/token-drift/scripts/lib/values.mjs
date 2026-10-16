// Value measurement shared by token loading and scanning.
import { COLOR_RE, describeColor, deltaE2000 } from './color.mjs';

export let REM_PX = 16;
export const setRem = (px) => { REM_PX = px; };

export const LENGTH_RE = /(?<![\w.#-])(-?\d*\.?\d+)(px|rem)(?![\w-])/g;
export const DURATION_RE = /(?<![\w.#-])(\d*\.?\d+)(ms|s)(?![\w-])/g;

export function toPx(numStr, unit) {
  const n = parseFloat(numStr);
  return unit === 'rem' ? n * REM_PX : n;
}

export function splitTopLevel(value, sep = ',') {
  const out = [];
  let d = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') d++; else if (ch === ')') d--;
    else if (ch === sep && d === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseShadow(value) {
  if (!value || /^(none|inherit|initial|unset)$/i.test(value.trim())) return null;
  const layers = [];
  for (const layer of splitTopLevel(value)) {
    const colors = layer.match(COLOR_RE) || [];
    const rest = layer.replace(COLOR_RE, ' ');
    const lens = [];
    if (/\d%/.test(rest)) return null;
    const re = /(?<![\w.])(-?\d*\.?\d+)(px|rem)?(?![\w%.])/g;
    let m;
    while ((m = re.exec(rest))) {
      if (!m[2] && parseFloat(m[1]) !== 0) return null; // CSS lengths need a unit unless they are 0
      lens.push(m[2] ? toPx(m[1], m[2]) : 0);
    }
    if (lens.length < 2 || lens.length > 4) return null;
    while (lens.length < 4) lens.push(0);
    const color = colors[0] ? describeColor(colors[0]) : describeColor('#000');
    if (!color) return null;
    layers.push({ inset: /\binset\b/.test(rest), lens, color });
  }
  return layers.length ? layers : null;
}

export function shadowKey(layers) {
  return layers.map((l) => `${l.inset ? 'inset ' : ''}${l.lens.map((n) => Math.round(n * 100) / 100).join(' ')} ${l.color.key}`).join(', ');
}

/** Distance between two parsed shadows: sum of px differences + colour difference. Infinity if structure differs. */
export function shadowDistance(a, b) {
  if (a.length !== b.length) return { d: Infinity };
  let px = 0, de = 0, da = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].inset !== b[i].inset) return { d: Infinity };
    for (let k = 0; k < 4; k++) px = Math.max(px, Math.abs(a[i].lens[k] - b[i].lens[k]));
    de = Math.max(de, deltaE2000(a[i].color.lab, b[i].color.lab));
    da = Math.max(da, Math.abs(a[i].color.alpha - b[i].color.alpha));
  }
  return { d: px + de / 2 + da * 40, px, de, da };
}

/** Measure a token value. Returns null if not a single measurable design value. */
export function measure(value, hint) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || /\bvar\(|\bcalc\(|\$|^@/.test(v) && !/^calc\(var\(--spacing\)\s*\*\s*[\d.]+\)$/.test(v)) return null;
  const col = describeColor(v);
  if (col && (v.startsWith('#') || /^(rgba?|hsla?|oklch|oklab)\(/i.test(v))) return { kind: 'color', color: col };
  let m = v.match(/^(-?\d*\.?\d+)(px|rem)$/);
  if (m) return { kind: 'length', px: toPx(m[1], m[2]) };
  if (v === '0') return { kind: 'length', px: 0 };
  m = v.match(/^(\d*\.?\d+)(ms|s)$/);
  if (m) return { kind: 'duration', ms: m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]) };
  m = v.match(/^-?\d+$/);
  if (m) return { kind: 'number', n: Number(v) };
  if (hint === 'shadow' || /\d(px|rem)?\s+-?\d/.test(v)) {
    const sh = parseShadow(v);
    if (sh) return { kind: 'shadow', layers: sh, key: shadowKey(sh) };
  }
  return null;
}

/**
 * Evaluate a px/rem length expression: `calc(0.625rem - 2px)`, `calc(4px * 3)`, `0.5rem`.
 * Returns px or null (unknown units, min()/max(), percentages …).
 */
export function evalLength(expr) {
  const src = String(expr).trim().replace(/\binfinity\b/gi, '99999');
  if (!src || /\b(min|max|clamp|var|env)\(|%|[a-z]{2,}\s*\(/i.test(src.replace(/\bcalc\(/g, '('))) return null;
  const toks = [];
  const re = /\s*(?:(-?\d*\.?\d+(?:e-?\d+)?)(px|rem)?|([-+*/()]))/gy;
  const body = src.replace(/\bcalc\(/g, '(');
  let m, i = 0;
  re.lastIndex = 0;
  while (i < body.length) {
    re.lastIndex = i;
    m = re.exec(body);
    if (!m || m[0].length === 0) { if (/^\s+$/.test(body.slice(i))) break; return null; }
    i = re.lastIndex;
    if (m[1] !== undefined) toks.push({ n: m[2] === 'rem' ? parseFloat(m[1]) * REM_PX : parseFloat(m[1]), len: !!m[2] });
    else toks.push({ op: m[3] });
  }
  let k = 0;
  const peek = () => toks[k];
  const expr_ = () => {
    let a = term();
    while (a && peek() && (peek().op === '+' || peek().op === '-')) {
      const op = toks[k++].op; const b = term();
      if (!b || a.len !== b.len) return null;
      a = { n: op === '+' ? a.n + b.n : a.n - b.n, len: a.len };
    }
    return a;
  };
  const term = () => {
    let a = factor();
    while (a && peek() && (peek().op === '*' || peek().op === '/')) {
      const op = toks[k++].op; const b = factor();
      if (!b) return null;
      if (op === '*') { if (a.len && b.len) return null; a = { n: a.n * b.n, len: a.len || b.len }; }
      else { if (b.len || b.n === 0) return null; a = { n: a.n / b.n, len: a.len }; }
    }
    return a;
  };
  const factor = () => {
    const t = toks[k++];
    if (!t) return null;
    if (t.op === '(') { const v = expr_(); if (!toks[k] || toks[k].op !== ')') return null; k++; return v; }
    if (t.op === '-') { const v = factor(); return v && { n: -v.n, len: v.len }; }
    return t.op ? null : t;
  };
  const v = expr_();
  if (!v || k !== toks.length || !v.len || !Number.isFinite(v.n)) return null;
  return v.n;
}

/** Infer a token category from its name (and measured value). */
export function inferCategory(name, meas) {
  if (!meas) return null;
  const n = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  if (meas.kind === 'color') return 'color';
  if (meas.kind === 'shadow') return 'shadow';
  if (meas.kind === 'duration') return /delay/.test(n) ? null : 'duration';
  if (meas.kind === 'number') {
    if (/(^|[-_])(z|z-?index|zindex|layer|elevation|stack)([-_]|$)/.test(n)) return 'z-index';
    if (/weight|(^|[-_])fw([-_]|$)/.test(n) && meas.n >= 100 && meas.n <= 900 && meas.n % 50 === 0) return 'font-weight';
    return null;
  }
  if (meas.kind === 'length') {
    if (/radius|rounded|(^|[-_])radii([-_]|$)|corner/.test(n)) return 'radius';
    if (/font-?size|text-?size|(^|[-_])(fs|font|text|type|typo|heading|body)([-_]|$)/.test(n) && !/line|leading|track|letter|weight/.test(n)) return 'font-size';
    // `size` alone is too broad (--icon-size, --button-size): only scale-style names like --size-4 / --base-size-8
    if ((/spac|space|gap|gutter|inset|(^|[-_])(pad|padding|margin|stack)([-_]|$)|^(sp|m|p|s)[-_]\d/.test(n) || /^(base-)?(size|sizes|sizing)[-_][\w.]+$/.test(n)) && !/width|height|max|min|breakpoint|screen|container|border|icon|avatar|button|btn|input|control|logo|thumb|handle|header|footer|sidebar|toolbar|modal|dialog|card|popover|menu|nav/.test(n)) return 'space';
    return null;
  }
  return null;
}
