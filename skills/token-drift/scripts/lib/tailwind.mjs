// Tailwind knowledge: default (non-color) scales for v3/v4, utility → category
// maps, and a static (no-execution) parser for tailwind.config.* files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SPACING_KEYS = ['px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12',
  '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96'];

export function defaultTheme(version) {
  const spacing = {};
  for (const k of SPACING_KEYS) spacing[k] = k === 'px' ? '1px' : `${parseFloat(k) * 0.25}rem`;
  const fontSize = { xs: '0.75rem', sm: '0.875rem', base: '1rem', lg: '1.125rem', xl: '1.25rem', '2xl': '1.5rem', '3xl': '1.875rem',
    '4xl': '2.25rem', '5xl': '3rem', '6xl': '3.75rem', '7xl': '4.5rem', '8xl': '6rem', '9xl': '8rem' };
  const fontWeight = { thin: '100', extralight: '200', light: '300', normal: '400', medium: '500', semibold: '600', bold: '700', extrabold: '800', black: '900' };
  const zIndex = { 0: '0', 10: '10', 20: '20', 30: '30', 40: '40', 50: '50' };
  const transitionDuration = { 75: '75ms', 100: '100ms', 150: '150ms', 200: '200ms', 300: '300ms', 500: '500ms', 700: '700ms', 1000: '1000ms' };
  const borderRadius = version >= 4
    ? { xs: '0.125rem', sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', '4xl': '2rem', full: '9999px' }
    : { sm: '0.125rem', DEFAULT: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', full: '9999px' };
  const boxShadow = version >= 4
    ? { '2xs': '0 1px rgb(0 0 0 / 0.05)', xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)', sm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)' }
    : { sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)', DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
        md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)' };
  return { spacing, fontSize, fontWeight, zIndex, transitionDuration, borderRadius, boxShadow, colors: { white: '#ffffff', black: '#000000' } };
}

/** Theme key → token category. */
export const THEME_KEYS = {
  colors: 'color', spacing: 'space', borderRadius: 'radius', fontSize: 'font-size', fontWeight: 'font-weight',
  boxShadow: 'shadow', zIndex: 'z-index', transitionDuration: 'duration',
};

/** Utilities that take each category (prefix before `-<fragment>` or `-[arbitrary]`). */
export const UTILS = {
  space: ['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me',
    'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end',
    'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml', 'scroll-p', 'scroll-px', 'scroll-py', 'scroll-pt', 'scroll-pr', 'scroll-pb', 'scroll-pl'],
  color: ['text', 'bg', 'border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l', 'border-s', 'border-e',
    'ring', 'ring-offset', 'outline', 'fill', 'stroke', 'from', 'via', 'to', 'accent', 'caret', 'decoration', 'divide', 'placeholder', 'shadow'],
  'font-size': ['text'],
  radius: ['rounded', 'rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-s', 'rounded-e', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl',
    'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee'],
  'font-weight': ['font'],
  shadow: ['shadow'],
  'z-index': ['z'],
  duration: ['duration'],
};
export const NEGATABLE = new Set(['m', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'space-x', 'space-y', 'inset', 'inset-x', 'inset-y',
  'top', 'right', 'bottom', 'left', 'start', 'end', 'scroll-m', 'scroll-mx', 'scroll-my', 'scroll-mt', 'scroll-mr', 'scroll-mb', 'scroll-ml', 'z']);
/** Utilities whose arbitrary var() values need a type hint (`text-[color:var(--x)]`). */
export const AMBIGUOUS = new Set(['text', 'bg', 'border', 'border-x', 'border-y', 'border-t', 'border-r', 'border-b', 'border-l', 'border-s', 'border-e',
  'ring', 'ring-offset', 'outline', 'stroke', 'fill', 'decoration', 'divide', 'shadow']);

export const ALL_UTILS = [...new Set(Object.values(UTILS).flat())].sort((a, b) => b.length - a.length);

/* ------------------------------------------------- static config parsing -- */

const UNRESOLVED = Symbol('unresolved');

/** Tolerant JS literal parser: objects, arrays, strings, numbers, simple template strings, local const refs. */
function parseLiteral(src, consts, warnings) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const skipExpr = () => {
    // skip an unsupported expression until , or closing bracket at depth 0
    let d = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === '`') { readString(); continue; }
      if ('([{'.includes(ch)) d++;
      else if (')]}'.includes(ch)) { if (d === 0) return; d--; }
      else if (ch === ',' && d === 0) return;
      i++;
    }
  };
  const readString = () => {
    const q = src[i++];
    let s = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') { s = UNRESOLVED; }
      if (s !== UNRESOLVED) s += src[i];
      i++;
    }
    i++;
    return s;
  };
  const value = () => {
    let v = rawValue();
    // member access on a resolved const: brand[500], brand['500']
    for (;;) {
      ws();
      if (src[i] !== '[' || v === UNRESOLVED || typeof v !== 'object' || v === null) break;
      const m = src.slice(i).match(/^\[\s*(?:(['"])([^'"]*)\1|(\d+))\s*\]/);
      if (!m) break;
      i += m[0].length;
      v = v[m[2] ?? m[3]];
      if (v === undefined) v = UNRESOLVED;
    }
    ws();
    if (/^(as|satisfies)\b/.test(src.slice(i, i + 10))) skipExpr(); // TS type assertions
    return v;
  };
  const rawValue = () => {
    ws();
    const ch = src[i];
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"' || ch === "'" || ch === '`') return readString();
    const numM = src.slice(i).match(/^-?\d*\.?\d+(?![\w.])/);
    if (numM) { i += numM[0].length; return Number(numM[0]); }
    const idM = src.slice(i).match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/);
    if (idM) {
      const after = src.slice(i + idM[0].length).trimStart();
      const drilled = idM[0].split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), consts);
      if (!after.startsWith('(') && !after.startsWith('=>') && drilled !== undefined) { i += idM[0].length; return drilled; }
      if (idM[0] === 'true' || idM[0] === 'false') { i += idM[0].length; return idM[0] === 'true'; }
      warnings.add(idM[0]);
    }
    skipExpr();
    return UNRESOLVED;
  };
  const object = () => {
    i++;
    const o = {};
    for (;;) {
      ws();
      if (src[i] === '}') { i++; return o; }
      if (src[i] === ',') { i++; continue; }
      if (src.startsWith('...', i)) {
        i += 3; ws();
        const idM = src.slice(i).match(/^[A-Za-z_$][\w$.]*/);
        const spread = idM && idM[0].split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), consts);
        if (spread && typeof spread === 'object') { Object.assign(o, spread); i += idM[0].length; }
        else { if (idM) warnings.add('...' + idM[0]); skipExpr(); }
        continue;
      }
      let key;
      if (src[i] === '"' || src[i] === "'") key = readString();
      else if (src[i] === '[') { skipExpr(); i++; ws(); if (src[i] === ':') { i++; value(); } continue; }
      else {
        const m = src.slice(i).match(/^[\w$.-]+/);
        if (!m) { i++; continue; }
        key = m[0]; i += m[0].length;
      }
      ws();
      if (src[i] === '(') { // method shorthand: key() { ... }
        warnings.add(key + '()');
        skipExpr(); ws(); if (src[i] === '{') { let d = 0; do { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } while (i < src.length && d); }
        continue;
      }
      if (src[i] !== ':') { // shorthand property { colors }
        if (consts[key] !== undefined) o[key] = consts[key];
        continue;
      }
      i++;
      const v = value();
      if (v !== UNRESOLVED) o[key] = v;
    }
  };
  const array = () => {
    i++;
    const a = [];
    for (;;) {
      ws();
      if (src[i] === ']') { i++; return a; }
      if (src[i] === ',') { i++; continue; }
      if (i >= src.length) return a;
      const v = value();
      a.push(v === UNRESOLVED ? null : v);
    }
  };
  return value();
}

/** Statically read `theme` from a tailwind config without executing it. */
export function readConfigStatic(file) {
  const raw = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  const warnings = new Set();
  const consts = {};
  // top-level const NAME = { … } | '…'  (in source order, so later ones can reference earlier ones)
  const constRe = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?=[{['"`\d])/g;
  let m;
  while ((m = constRe.exec(raw))) {
    const v = parseLiteral(raw.slice(m.index + m[0].length), consts, warnings);
    if (v !== UNRESOLVED) consts[m[1]] = v;
  }
  const themeIdx = raw.search(/\btheme\s*:\s*\{/);
  let theme = {};
  if (themeIdx !== -1) {
    const start = raw.indexOf('{', themeIdx);
    theme = parseLiteral(raw.slice(start), consts, warnings) || {};
    if (theme === UNRESOLVED) theme = {};
  } else if (/\btheme\s*:/.test(raw)) {
    warnings.add('theme (not an object literal)');
  }
  const prefixM = raw.match(/\bprefix\s*:\s*['"]([^'"]*)['"]/);
  return { theme, prefix: prefixM ? prefixM[1] : '', warnings: [...warnings] };
}

/** Evaluate the config in a child Node process (opt-in). Uses the project's resolveConfig when installed. */
export function readConfigExec(file, projectRoot) {
  const isTs = /\.(c|m)?ts$/.test(file);
  const script = `
    import { createRequire } from 'node:module';
    const req = createRequire(${JSON.stringify(pathToFileURL(path.join(projectRoot, 'package.json')).href)});
    let cfg = await import(${JSON.stringify(pathToFileURL(file).href)});
    cfg = cfg.default ?? cfg;
    if (cfg && cfg.default) cfg = cfg.default;
    let theme, resolved = false;
    try { const rc = req('tailwindcss/resolveConfig'); theme = (rc.default ?? rc)(cfg).theme; resolved = true; } catch {}
    if (!theme) {
      const stub = (p) => undefined;
      const call = (v) => typeof v === 'function' ? v({ theme: stub, colors: {} }) : v;
      theme = {};
      for (const [k, v] of Object.entries(cfg.theme || {})) theme[k] = k === 'extend' ? Object.fromEntries(Object.entries(v || {}).map(([a, b]) => [a, call(b)])) : call(v);
    }
    const seen = new WeakSet();
    process.stdout.write(JSON.stringify({ theme, prefix: cfg.prefix || '', resolved }, (k, v) => {
      if (typeof v === 'function') return undefined;
      if (v && typeof v === 'object') { if (seen.has(v)) return undefined; seen.add(v); }
      return v;
    }));`;
  const args = ['--input-type=module', '-e', script];
  const major = Number(process.versions.node.split('.')[0]);
  if (isTs && major >= 22) args.unshift('--experimental-strip-types', '--no-warnings');
  const r = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = (r.stderr || r.error?.message || 'unknown error').split('\n').find((l) => /Error|error/.test(l)) || r.stderr;
    throw new Error(`could not evaluate ${path.basename(file)}: ${String(err).trim().slice(0, 200)}`);
  }
  return JSON.parse(r.stdout);
}

/** Detect Tailwind major version from package.json files / CSS entry points. */
export function detectTailwindVersion(root, cssTexts = []) {
  for (const css of cssTexts) {
    if (/@import\s+["']tailwindcss["']|@theme\b/.test(css)) return 4;
  }
  for (const pj of [path.join(root, 'package.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const v = { ...j.dependencies, ...j.devDependencies }.tailwindcss;
      if (v) { const m = String(v).match(/(\d+)/); if (m) return Number(m[1]); }
    } catch {}
  }
  for (const css of cssTexts) if (/@tailwind\s+(base|components|utilities)/.test(css)) return 3;
  return null;
}
