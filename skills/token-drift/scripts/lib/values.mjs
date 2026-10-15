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
    const re = /(-?\d*\.?\d+)(px|rem)?(?![\w%])/g;
    let m;
    while ((m = re.exec(rest))) lens.push(m[2] ? toPx(m[1], m[2]) : parseFloat(m[1]));
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

/** Infer a token category from its name (and measured value). */
export function inferCategory(name, meas) {
  if (!meas) return null;
  const n = name.toLowerCase();
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
    if (/spac|space|gap|gutter|inset|(^|[-_])(sp|pad|padding|margin|m|p|s|size|stack|inline)([-_]|$)/.test(n) && !/width|height|max|min|breakpoint|screen|container|border/.test(n)) return 'space';
    return null;
  }
  return null;
}
