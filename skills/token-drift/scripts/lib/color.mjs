// Color parsing + perceptual distance (CIEDE2000 and OKLab). Zero dependencies.
// Supports #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch(), oklab()
// in both legacy comma and modern space/slash syntax.

export const COLOR_RE = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab)\([^()]*\)/g;

const num = (s, pctScale = 1) => {
  s = String(s).trim();
  if (s === 'none') return 0;
  if (s.endsWith('%')) return (parseFloat(s) / 100) * pctScale;
  return parseFloat(s);
};
const hue = (s) => {
  s = String(s).trim();
  if (s === 'none') return 0;
  if (s.endsWith('turn')) return parseFloat(s) * 360;
  if (s.endsWith('grad')) return parseFloat(s) * 0.9;
  if (s.endsWith('rad')) return (parseFloat(s) * 180) / Math.PI;
  return parseFloat(s);
};

function splitArgs(inner) {
  let alpha;
  const slash = inner.split('/');
  if (slash.length === 2) alpha = slash[1].trim();
  const parts = slash[0].includes(',') ? slash[0].split(',') : slash[0].trim().split(/\s+/);
  const p = parts.map((x) => x.trim()).filter(Boolean);
  if (alpha === undefined && p.length === 4) alpha = p.pop();
  return { p, alpha };
}

const alphaOf = (a) => (a === undefined ? 1 : Math.max(0, Math.min(1, num(a, 1))));

/** Parse a CSS color literal → { r, g, b, a } in sRGB 0..1 (may be out of gamut for oklch). */
export function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
    const full = h.length <= 4 ? [...h].map((x) => x + x).join('') : h;
    const v = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: full.length === 8 ? v(6) : 1 };
  }
  const m = s.match(/^(rgba?|hsla?|oklch|oklab)\((.*)\)$/s);
  if (!m) return null;
  const { p, alpha } = splitArgs(m[2]);
  if (p.length < 3 || p.some((x) => x.startsWith('var(') || x === 'from')) return null;
  const a = alphaOf(alpha);
  const fn = m[1];
  if (fn.startsWith('rgb')) {
    const ch = (x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255);
    const [r, g, b] = p.map(ch);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a };
  }
  if (fn.startsWith('hsl')) {
    const H = hue(p[0]), S = num(p[1].endsWith('%') ? p[1] : p[1] + '%', 1), L = num(p[2].endsWith('%') ? p[2] : p[2] + '%', 1);
    if ([H, S, L].some(Number.isNaN)) return null;
    const f = (n) => {
      const k = (n + H / 30) % 12;
      return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: f(0), g: f(8), b: f(4), a };
  }
  if (fn === 'oklch' || fn === 'oklab') {
    const L = num(p[0], 1);
    let A, B;
    if (fn === 'oklch') {
      const C = num(p[1], 0.4), H = (hue(p[2]) * Math.PI) / 180;
      A = C * Math.cos(H); B = C * Math.sin(H);
    } else { A = num(p[1], 0.4); B = num(p[2], 0.4); }
    if ([L, A, B].some(Number.isNaN)) return null;
    const lin = oklabToLinear({ L, a: A, b: B });
    return { r: toGamma(lin[0]), g: toGamma(lin[1]), b: toGamma(lin[2]), a };
  }
  return null;
}

const toLinear = (c) => { const s = Math.sign(c), x = Math.abs(c); return s * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); };
const toGamma = (c) => { const s = Math.sign(c), x = Math.abs(c); return s * (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055); };

export function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}
export function oklabToLinear({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToLab([r, g, b]) {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

const clamp255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
const hx = (n) => n.toString(16).padStart(2, '0');

/** Everything the matcher needs about a color, computed once. */
export function describeColor(input) {
  const c = typeof input === 'string' ? parseColor(input) : input;
  if (!c) return null;
  const lin = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  const r = clamp255(c.r), g = clamp255(c.g), b = clamp255(c.b), A = clamp255(c.a);
  const hex = '#' + hx(r) + hx(g) + hx(b);
  return {
    hex, // display hex (alpha dropped)
    key: hex + (A < 255 ? hx(A) : ''), // identity key for EXACT matching
    alpha: Math.round(c.a * 1000) / 1000,
    lab: linearToLab(lin),
    oklab: linearToOklab(lin),
  };
}

const rad = (d) => (d * Math.PI) / 180;
/** CIEDE2000 colour difference. ~1 = just noticeable, >5 = clearly different. */
export function deltaE2000(l1, l2) {
  const { L: L1, a: a1, b: b1 } = l1, { L: L2, a: a2, b: b2 } = l2;
  const avgL = (L1 + L2) / 2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const avgC = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const avgCp = (C1p + C2p) / 2;
  const hp = (b, a) => { if (a === 0 && b === 0) return 0; const h = (Math.atan2(b, a) * 180) / Math.PI; return h < 0 ? h + 360 : h; };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p <= h1p) dhp = h2p - h1p + 360;
  else dhp = h2p - h1p - 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  let avgHp;
  if (C1p * C2p === 0) avgHp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) avgHp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) avgHp = (h1p + h2p + 360) / 2;
  else avgHp = (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos(rad(avgHp - 30)) + 0.24 * Math.cos(rad(2 * avgHp))
    + 0.32 * Math.cos(rad(3 * avgHp + 6)) - 0.2 * Math.cos(rad(4 * avgHp - 63));
  const dTheta = 30 * Math.exp(-(((avgHp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (avgL - 50) ** 2) / Math.sqrt(20 + (avgL - 50) ** 2);
  const Sc = 1 + 0.045 * avgCp, Sh = 1 + 0.015 * avgCp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export const oklabDistance = (a, b) => Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);

/** Rough hue family + tone step, used to name proposed tokens. */
export function colorFamily(d) {
  const { L, a, b } = d.oklab;
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI; if (h < 0) h += 360;
  let family;
  if (C < 0.03) family = 'gray';
  else if (h < 20 || h >= 350) family = 'pink';
  else if (h < 45) family = 'red';
  else if (h < 75) family = 'orange';
  else if (h < 110) family = 'yellow';
  else if (h < 165) family = 'green';
  else if (h < 210) family = 'teal';
  else if (h < 275) family = 'blue';
  else if (h < 310) family = 'violet';
  else family = 'purple';
  const step = Math.max(50, Math.min(950, Math.round((1 - L) * 10) * 100 || 50));
  return { family, step };
}
