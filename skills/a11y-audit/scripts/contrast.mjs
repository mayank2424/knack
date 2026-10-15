#!/usr/bin/env node
/**
 * Knack contrast checker: WCAG 2.x contrast ratio + nearest passing color.
 *
 *   node contrast.mjs "#777" "#fff"
 *   node contrast.mjs "rgb(160 168 181)" white --large
 *   node contrast.mjs "oklch(0.7 0.1 270)" "#0b0b0f" --fix bg
 *   node contrast.mjs "#6d4aff" "#fff" --target 3 --json
 *
 * Colors: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch(), CSS names.
 * A translucent foreground is composited over the background first.
 *
 * Options:
 *   --large        Text is large (≥24px, or ≥18.66px bold): AA 3:1, AAA 4.5:1
 *   --target N     Custom target ratio (e.g. 3 for UI components / focus rings, WCAG 1.4.11)
 *   --fix fg|bg    Which color to adjust when suggesting (default fg)
 *   --json         Machine-readable output
 *   --help         Show this help
 *
 * Suggestions keep hue and chroma (OKLCH) and move only lightness, so the brand
 * color stays recognizable. Exit code 0 if AA passes, 2 if it fails, 1 on error.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') flags.help = true;
  else if (a === '--target' || a === '--fix') flags[a.slice(2)] = args[++i];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
  else pos.push(a);
}
if (flags.help || pos.length < 2) {
  const txt = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n', '').replace('/**', '').replace(/^ \* ?/gm, '').trim();
  (flags.help ? console.log : console.error)(txt);
  process.exit(flags.help ? 0 : 1);
}
const die = (m) => { console.error(`✖ ${m}`); process.exit(1); };

// ------------------------------------------------------------- parsing
const NAMED = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', silver: 'c0c0c0', maroon: '800000', navy: '000080', teal: '008080', olive: '808000', lime: '00ff00', aqua: '00ffff', cyan: '00ffff', fuchsia: 'ff00ff', magenta: 'ff00ff', pink: 'ffc0cb', brown: 'a52a2a', gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', coral: 'ff7f50', salmon: 'fa8072', tomato: 'ff6347', crimson: 'dc143c', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', dimgray: '696969', dimgrey: '696969', gainsboro: 'dcdcdc', whitesmoke: 'f5f5f5', slategray: '708090', darkblue: '00008b', darkgreen: '006400', darkred: '8b0000', royalblue: '4169e1', steelblue: '4682b4', dodgerblue: '1e90ff', skyblue: '87ceeb', tan: 'd2b48c', beige: 'f5f5dc', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', rebeccapurple: '663399', transparent: '00000000' };
const num = (s, scale = 1) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));
function parse(input) {
  let s = String(input).trim().toLowerCase();
  if (NAMED[s]) s = '#' + NAMED[s];
  if (/^[0-9a-f]{3,8}$/.test(s)) s = '#' + s;
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
    if (h.length !== 6 && h.length !== 8) die(`Bad hex color: ${input}`);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if ((m = s.match(/^(rgba?|hsla?|oklch)\((.*)\)$/))) {
    const parts = m[2].replace(/\//g, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    const alpha = parts[3] !== undefined ? num(parts[3]) : 1;
    if (m[1].startsWith('rgb')) return { r: num(parts[0], 255), g: num(parts[1], 255), b: num(parts[2], 255), a: alpha };
    if (m[1].startsWith('hsl')) return { ...hslToRgb(parseFloat(parts[0]), num(parts[1]) / (parts[1].endsWith('%') ? 1 : 100), num(parts[2]) / (parts[2].endsWith('%') ? 1 : 100)), a: alpha };
    const L = parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const C = parts[1].endsWith('%') ? (parseFloat(parts[1]) / 100) * 0.4 : parseFloat(parts[1]);
    const rgb = oklchToRgb({ L, C, H: parseFloat(parts[2]) || 0 }).rgb;
    return { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255, a: alpha };
  }
  die(`Unrecognized color: ${input} (try #rrggbb, rgb(), hsl(), oklch() or a CSS name)`);
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

// ---------------------------------------------------------- WCAG math
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x, y) => { const a = luminance(x), b = luminance(y); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const round8 = (c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 1 });

// ------------------------------------------------------------- OKLCH
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToOklch({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, Bb), H: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360 };
}
function oklchToRgb({ L, C, H }) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const lin3 = [lr, lg, lb];
  const inGamut = lin3.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  return { rgb: lin3.map((v) => toGam(Math.max(0, Math.min(1, v)))), inGamut };
}
// Fixed L and H; reduce chroma until the color fits in sRGB (keeps the hue honest).
function fitGamut(L, C, H) {
  if (oklchToRgb({ L, C, H }).inGamut) return oklchToRgb({ L, C, H }).rgb;
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (oklchToRgb({ L, C: mid, H }).inGamut) lo = mid; else hi = mid; }
  return oklchToRgb({ L, C: lo, H }).rgb;
}

// Walk lightness away from the original in both directions; return the closest 8-bit color that passes.
function nearest(color, other, target, which) {
  const o = rgbToOklch(color);
  const results = [];
  for (const dir of [-1, 1]) {
    for (let step = 1; step <= 1000; step++) {
      const L = o.L + dir * step * 0.001;
      if (L < 0 || L > 1) break;
      const rgb = fitGamut(L, o.C, o.H);
      const cand = round8({ r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255 });
      const r = which === 'fg' ? ratio(cand, other) : ratio(other, cand);
      if (r >= target) { results.push({ hex: hex(cand), ratio: +r.toFixed(2), direction: dir < 0 ? 'darker' : 'lighter', deltaL: +(step * 0.001).toFixed(3), oklch: `oklch(${(L * 100).toFixed(1)}% ${o.C.toFixed(3)} ${o.H.toFixed(1)})` }); break; }
    }
  }
  return results.sort((a, b) => a.deltaL - b.deltaL);
}

// ---------------------------------------------------------------- main
const large = !!flags.large;
const which = flags.fix === 'bg' ? 'bg' : 'fg';
let bg = parse(pos[1]);
if (bg.a < 1) { console.error('⚠ background is translucent; compositing it over white.'); bg = over(bg, { r: 255, g: 255, b: 255, a: 1 }); }
const fgRaw = parse(pos[0]);
const fg = fgRaw.a < 1 ? over(fgRaw, bg) : { ...fgRaw, a: 1 };
const r = ratio(fg, bg);
const levels = {
  'AA': large ? 3 : 4.5,
  'AAA': large ? 4.5 : 7,
  'UI / large-text (3:1)': 3,
};
if (flags.target) levels[`custom (${flags.target}:1)`] = +flags.target;
// Round to 2 decimals, but show 3 if rounding would make a failing ratio look like a pass (4.497 → "4.497").
const crosses = Object.values(levels).some((t) => r < t && +r.toFixed(2) >= t);
const shownStr = r.toFixed(crosses ? 3 : 2);
const shown = +shownStr;
const checks = Object.entries(levels).map(([name, t]) => ({ level: name, target: t, pass: r >= t }));
const targets = [...new Set([flags.target ? +flags.target : null, levels.AA, levels.AAA].filter(Boolean))];
const suggestions = {};
for (const t of targets) if (r < t) suggestions[`${t}:1`] = nearest(which === 'fg' ? fg : bg, which === 'fg' ? bg : fg, t, which);

if (flags.json) {
  console.log(JSON.stringify({ fg: hex(fg), bg: hex(bg), ratio: shown, large, checks, adjust: which, suggestions }, null, 2));
} else {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const col = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  console.log(`${hex(fg)}${fgRaw.a < 1 ? ` (from ${pos[0]})` : ''} on ${hex(bg)}  →  ${col(1, shownStr + ':1')}${large ? '  (large text)' : ''}`);
  for (const c of checks) console.log(`  ${c.pass ? col(32, 'PASS') : col(31, 'FAIL')}  ${c.level.padEnd(22)} needs ${c.target}:1`);
  for (const [t, list] of Object.entries(suggestions)) {
    if (!list.length) { console.log(`  No ${which} lightness reaches ${t} with this ${which === 'fg' ? 'background' : 'foreground'}; change the other color.`); continue; }
    console.log(`\n  Nearest ${which} for ${t} (same hue, OKLCH lightness only):`);
    for (const s of list) console.log(`    ${s.hex}  ${s.ratio.toFixed(2)}:1  ${s.direction.padEnd(7)} ΔL ${s.deltaL}  ${s.oklch}`);
  }
}
process.exitCode = r >= levels.AA ? 0 : 2;
