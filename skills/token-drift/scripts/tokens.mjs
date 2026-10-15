#!/usr/bin/env node
/**
 * Discover and normalize a project's design tokens.
 *
 *   node tokens.mjs [dir] [--tokens <file|dir>...] [--json] [--all] [--exec-config]
 *                   [--tailwind-defaults scales|none] [--rem 16]
 *
 * Sources: CSS custom properties (:root / html / :host / [data-theme] / .dark /
 * prefers-color-scheme blocks), Tailwind v4 @theme, Tailwind v3 tailwind.config.*
 * (read statically; --exec-config evaluates it in a child process), W3C DTCG /
 * Style Dictionary JSON, SCSS $variables and LESS @variables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError, walk, rel, shown, c, swatch, lineIndex, plural } from './lib/util.mjs';
import { blankCssComments, walkCss, splitSfc } from './lib/parse.mjs';
import { measure, inferCategory, setRem, REM_PX } from './lib/values.mjs';
import { defaultTheme, THEME_KEYS, readConfigStatic, readConfigExec, detectTailwindVersion } from './lib/tailwind.mjs';

export const CATEGORIES = ['color', 'space', 'radius', 'font-size', 'font-weight', 'shadow', 'z-index', 'duration'];
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.pcss', '.postcss', '.vue', '.svelte', '.astro']);
export const ROOTISH = /^(:root|html|:host|body)\b|\[data-(theme|mode|color-scheme)|\.(dark|light|theme-[\w-]+)\b|^@theme|prefers-color-scheme|^:where\(:root/;
const DARK = /dark/i;

const TW4_NS = [
  ['--color-', 'color'], ['--radius-', 'radius'], ['--text-', 'font-size'], ['--font-weight-', 'font-weight'],
  ['--shadow-', 'shadow'], ['--spacing-', 'space'], ['--z-', 'z-index'], ['--duration-', 'duration'],
];

const kebab = (parts) => parts.join('-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_.]+/g, '-').toLowerCase();

/* ------------------------------------------------------------- loading -- */

export async function loadTokens(root, opts = {}) {
  root = path.resolve(root);
  if (opts.rem) setRem(Number(opts.rem));
  const warnings = [];
  const sources = [];
  const tokenFiles = new Set(); // files consumed wholesale (skip when scanning)
  const raw = []; // un-resolved token records

  const explicit = (opts.tokens || []).map((t) => path.resolve(t));
  let candidates;
  if (explicit.length) {
    candidates = [];
    for (const t of explicit) {
      if (!fs.existsSync(t)) throw new UsageError(`--tokens ${rel(t)} does not exist.`);
      if (fs.statSync(t).isDirectory()) candidates.push(...walk(t, { gitignore: false }));
      else candidates.push(t);
    }
  } else {
    candidates = walk(root, { include: opts.include, exclude: opts.exclude });
  }

  const cssTexts = [];
  let twConfig = null;
  for (const file of candidates) {
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    if (/^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(base)) { if (!twConfig) twConfig = file; tokenFiles.add(file); continue; }
    if (ext === '.json' || base.endsWith('.tokens')) {
      if (!explicit.length && !/token/i.test(base) && !/(^|[\\/])tokens[\\/]/.test(file)) continue;
      if (/^(package|tsconfig|package-lock|composer)\.json$/.test(base)) continue;
      const got = readJsonTokens(file, warnings);
      if (got.length) { raw.push(...got); tokenFiles.add(file); sources.push({ file, kind: got[0].sourceKind, count: got.length }); }
      continue;
    }
    if (STYLE_EXTS.has(ext)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      cssTexts.push(text);
      const got = readStyleTokens(file, text);
      if (got.length) {
        raw.push(...got);
        const kinds = [...new Set(got.map((t) => t.sourceKind))];
        for (const k of kinds) sources.push({ file, kind: k, count: got.filter((t) => t.sourceKind === k).length });
      }
    }
  }

  // Tailwind
  let twVersion = detectTailwindVersion(root, cssTexts);
  if (!twVersion && twConfig) twVersion = 3;
  const tailwind = { version: twVersion, configFile: twConfig, prefix: '', mode: null };
  const hasTw4Theme = raw.some((t) => t.sourceKind === 'tailwind v4 @theme');
  if (twConfig && (twVersion || 3) < 4) {
    let cfg;
    if (opts.execConfig) {
      try { cfg = readConfigExec(twConfig, root); tailwind.mode = cfg.resolved ? 'exec+resolveConfig' : 'exec'; }
      catch (e) { warnings.push(`${e.message}; falling back to static read`); }
    }
    if (!cfg) {
      cfg = readConfigStatic(twConfig);
      tailwind.mode = 'static';
      if (cfg.warnings.length) {
        warnings.push(`${rel(twConfig)}: could not statically resolve ${cfg.warnings.slice(0, 4).join(', ')}${cfg.warnings.length > 4 ? '…' : ''} — re-run with --exec-config to evaluate the config`);
      }
    }
    tailwind.prefix = cfg.prefix || '';
    const theme = cfg.theme || {};
    const merged = {};
    const useDefaults = (opts.tailwindDefaults || 'scales') !== 'none' && !cfg.resolved;
    const defs = defaultTheme(3);
    for (const key of Object.keys(THEME_KEYS)) {
      const own = theme[key], ext = theme.extend?.[key];
      merged[key] = { ...(own && typeof own === 'object' ? own : (useDefaults ? defs[key] : {})), ...(ext && typeof ext === 'object' ? ext : {}) };
      // track which keys came from defaults
      merged[key].__defaults = !own && useDefaults ? new Set(Object.keys(defs[key])) : new Set();
      merged[key].__ext = new Set(Object.keys(ext && typeof ext === 'object' ? ext : {}));
    }
    const got = [];
    for (const [key, cat] of Object.entries(THEME_KEYS)) {
      const fromDefaults = merged[key].__defaults, extKeys = merged[key].__ext;
      delete merged[key].__defaults; delete merged[key].__ext;
      flattenTheme(merged[key], [], (frag, value) => {
        if (key === 'fontSize' && Array.isArray(value)) value = value[0];
        if (typeof value === 'number') value = key === 'transitionDuration' ? value + 'ms' : String(value);
        if (typeof value !== 'string') return;
        const top = fromDefaults.has(frag) ? frag : frag.split('-')[0];
        const isDefault = fromDefaults.has(top) && !extKeys.has(top);
        got.push({
          name: `${key}.${frag.replace(/-/g, '.')}`, value, category: cat, file: isDefault ? null : twConfig, line: null,
          sourceKind: isDefault ? 'tailwind v3 defaults' : 'tailwind v3 config', tw: { fragment: frag }, mode: 'base', isDefault,
        });
      });
    }
    raw.push(...got);
    const own = got.filter((t) => !t.isDefault).length, dflt = got.length - own;
    if (own) sources.push({ file: twConfig, kind: `tailwind v3 config (${tailwind.mode})`, count: own });
    if (dflt) sources.push({ file: null, kind: 'tailwind v3 defaults', count: dflt });
  }
  if (twVersion >= 4 || hasTw4Theme) {
    tailwind.version = 4;
    if ((opts.tailwindDefaults || 'scales') !== 'none') {
      const defs = defaultTheme(4);
      const resets = raw.filter((t) => t.sourceKind === 'tailwind v4 @theme' && t.value === 'initial').map((t) => t.name);
      const reset = (ns) => resets.includes('--*') || resets.includes(ns + '*');
      const v4map = { borderRadius: '--radius-', fontSize: '--text-', fontWeight: '--font-weight-', boxShadow: '--shadow-' };
      const got = [];
      for (const [key, ns] of Object.entries(v4map)) {
        if (reset(ns)) continue;
        for (const [frag, value] of Object.entries(defs[key])) {
          const name = ns + frag;
          if (raw.some((t) => t.name === name)) continue;
          got.push({ name, value, category: THEME_KEYS[key], sourceKind: 'tailwind v4 defaults', tw: { fragment: frag }, css: `var(${name})`, mode: 'base', isDefault: true });
        }
      }
      // spacing: --spacing base (default 0.25rem) × scale keys; z-index and duration accept bare numbers
      const spacingTok = raw.find((t) => t.name === '--spacing');
      if (!reset('--spacing')) {
        const basePx = spacingTok ? (measure(spacingTok.value)?.px ?? 4) : 4;
        for (const k of Object.keys(defs.spacing)) {
          if (raw.some((t) => t.name === '--spacing-' + k)) continue;
          const px = k === 'px' ? 1 : parseFloat(k) * basePx;
          got.push({ name: `--spacing × ${k}`, value: px + 'px', category: 'space', sourceKind: 'tailwind v4 defaults', tw: { fragment: k },
            css: k === 'px' ? '1px' : `calc(var(--spacing) * ${k})`, mode: 'base', isDefault: true });
        }
      }
      for (const [k, v] of Object.entries(defs.zIndex)) got.push({ name: `z-${k}`, value: v, category: 'z-index', sourceKind: 'tailwind v4 defaults', tw: { fragment: k }, mode: 'base', isDefault: true });
      for (const [k, v] of Object.entries(defs.transitionDuration)) got.push({ name: `duration-${k}`, value: v, category: 'duration', sourceKind: 'tailwind v4 defaults', tw: { fragment: k }, mode: 'base', isDefault: true });
      got.push({ name: '--color-white', value: '#ffffff', category: 'color', sourceKind: 'tailwind v4 defaults', tw: { fragment: 'white' }, css: 'var(--color-white)', mode: 'base', isDefault: true });
      got.push({ name: '--color-black', value: '#000000', category: 'color', sourceKind: 'tailwind v4 defaults', tw: { fragment: 'black' }, css: 'var(--color-black)', mode: 'base', isDefault: true });
      const fresh = got.filter((g) => !raw.some((t) => t.name === g.name));
      raw.push(...fresh);
      if (fresh.length) sources.push({ file: null, kind: 'tailwind v4 defaults', count: fresh.length });
    }
  }

  const tokens = resolveAndNormalize(raw, warnings, opts);
  for (const s of sources) {
    const kind = s.kind.replace(/ \(.*\)$/, '');
    s.count = tokens.filter((t) => (t.file || null) === (s.file || null) && t.source === kind).length;
  }
  return { root, tokens, sources: sources.filter((s) => s.count), tokenFiles, tailwind, warnings, rem: REM_PX };
}

function flattenTheme(obj, prefix, cb) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenTheme(v, [...prefix, k], cb);
    else {
      const parts = [...prefix, k].filter((p) => p !== 'DEFAULT');
      cb(parts.length ? parts.join('-') : 'DEFAULT', v);
    }
  }
}

/* ------------------------------------------------------ style sources -- */

export function readStyleTokens(file, text) {
  const ext = path.extname(file).toLowerCase();
  const out = [];
  const pos = lineIndex(text);
  const handle = (content, base, lang) => {
    const blanked = blankCssComments(content, lang);
    walkCss(blanked, {
      base,
      onDecl: ({ prop, value, propStart, selectors }) => {
        const line = pos(propStart).line;
        const top = selectors.length === 0;
        const value0 = value.replace(/\s*!(default|global|important)\s*$/g, '').trim();
        if (prop.startsWith('--')) {
          const isTheme = selectors.some((s) => /^@theme\b/.test(s));
          const rootish = selectors.length > 0 && selectors.every((s) => ROOTISH.test(s) || /^@(media|supports|layer|container)\b/.test(s)) && selectors.some((s) => ROOTISH.test(s));
          if (!isTheme && !rootish) return;
          const mode = selectors.some((s) => DARK.test(s)) ? 'dark' : 'base';
          out.push({ name: prop, value: value0, file, line, sourceKind: isTheme ? 'tailwind v4 @theme' : 'css custom properties', css: `var(${prop})`, mode, tw4: isTheme });
        } else if (prop.startsWith('$') && (lang === 'scss' || lang === 'sass') && top) {
          out.push({ name: prop, value: value0, file, line, sourceKind: 'scss variables', scss: prop, mode: 'base' });
        } else if (prop.startsWith('@') && lang === 'less' && top) {
          out.push({ name: prop, value: value0, file, line, sourceKind: 'less variables', less: prop, mode: 'base' });
        }
      },
    });
  };
  if (ext === '.vue' || ext === '.svelte' || ext === '.astro') {
    for (const r of splitSfc(text).regions) if (r.kind === 'style') handle(r.content, r.start, r.lang);
  } else handle(text, 0, ext.slice(1) === 'pcss' || ext.slice(1) === 'postcss' ? 'css' : ext.slice(1));
  return out;
}

/* ------------------------------------------------------- JSON sources -- */

function readJsonTokens(file, warnings) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { warnings.push(`${rel(file)}: invalid JSON (${e.message.split('\n')[0]})`); return []; }
  const out = [];
  const typeMap = { color: 'color', dimension: null, spacing: 'space', space: 'space', sizing: null, borderRadius: 'radius', radius: 'radius', fontSize: 'font-size', fontSizes: 'font-size',
    fontWeight: 'font-weight', fontWeights: 'font-weight', shadow: 'shadow', boxShadow: 'shadow', duration: 'duration', zIndex: 'z-index' };
  let dtcg = false;
  const visit = (node, pathParts, inheritedType) => {
    if (!node || typeof node !== 'object') return;
    const type = node.$type || inheritedType;
    const hasDollar = '$value' in node;
    const hasPlain = !hasDollar && 'value' in node && (typeof node.value !== 'object' || Array.isArray(node.value) || node.value?.hex || node.value?.unit);
    if (hasDollar || hasPlain) {
      if (hasDollar) dtcg = true;
      let v = hasDollar ? node.$value : node.value;
      const t = hasDollar ? type : (node.type || node.$type || node.attributes?.category || inheritedType);
      v = normalizeJsonValue(v, t);
      if (v == null) return;
      const name = kebab(pathParts);
      let cat = typeMap[t] ?? null;
      out.push({ name: '--' + name, jsonPath: pathParts.join('.'), value: v, file, line: null, sourceKind: hasDollar ? 'w3c dtcg json' : 'style dictionary json', css: `var(--${name})`, cssAssumed: true, mode: /(^|\.)dark(\.|$)/i.test(pathParts.join('.')) ? 'dark' : 'base', category: cat, typeHint: t });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      visit(v, [...pathParts, k], type);
    }
  };
  visit(data, [], undefined);
  if (!dtcg && !out.length) return [];
  return out;
}

function normalizeJsonValue(v, type) {
  if (v == null) return null;
  if (typeof v === 'number') return type === 'duration' ? v + 'ms' : /dimension|spacing|size|radius|font-?size/i.test(type || '') ? v + 'px' : String(v);
  if (typeof v === 'string') return v.replace(/\{([^}]+)\}/g, (_, p) => `{${p}}`);
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.hex) return v.hex;
    if (v.colorSpace === 'srgb' && Array.isArray(v.components)) {
      const [r, g, b] = v.components.map((x) => Math.round(x * 255));
      return v.alpha != null && v.alpha < 1 ? `rgb(${r} ${g} ${b} / ${v.alpha})` : `rgb(${r} ${g} ${b})`;
    }
    if (v.value != null && v.unit) return `${v.value}${v.unit}`;
    if ('offsetX' in v) return shadowObj(v);
  }
  if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'offsetX' in x)) return v.map(shadowObj).join(', ');
  return null;
}
const dimStr = (d) => (d && typeof d === 'object' ? `${d.value}${d.unit}` : typeof d === 'number' ? d + 'px' : d);
const shadowObj = (s) => `${s.inset ? 'inset ' : ''}${dimStr(s.offsetX)} ${dimStr(s.offsetY)} ${dimStr(s.blur)} ${dimStr(s.spread ?? 0)} ${typeof s.color === 'object' ? normalizeJsonValue(s.color) : s.color}`;

/* ------------------------------------------------ resolve + normalize -- */

function resolveAndNormalize(raw, warnings, opts = {}) {
  const byName = new Map();
  const byJsonPath = new Map();
  for (const t of raw) {
    if (t.mode === 'base' || !byName.has(t.name)) byName.set(t.name, t);
    if (t.jsonPath) byJsonPath.set(t.jsonPath, t);
  }
  const resolve = (value, depth = 0) => {
    if (depth > 12 || typeof value !== 'string') return value;
    let v = value;
    v = v.replace(/^\{([^}]+)\}$/, (m, p) => { const t = byJsonPath.get(p); return t ? resolve(t.value, depth + 1) : m; });
    v = v.replace(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/, (m, name, fb) => { const t = byName.get(name); return t ? resolve(t.value, depth + 1) : (fb ? resolve(fb.trim(), depth + 1) : m); });
    v = v.replace(/^(\$[\w-]+)$/, (m, name) => { const t = byName.get(name); return t ? resolve(t.value, depth + 1) : m; });
    v = v.replace(/^(@[\w-]+)$/, (m, name) => { const t = byName.get(name); return t ? resolve(t.value, depth + 1) : m; });
    return v;
  };
  // CSS var names present (to confirm DTCG-assumed references)
  const cssNames = new Set(raw.filter((t) => t.sourceKind === 'css custom properties' || t.sourceKind === 'tailwind v4 @theme').map((t) => t.name));
  const out = [];
  const darkByName = new Map();
  for (const t of raw) if (t.mode === 'dark') darkByName.set(t.name, t);
  for (const t of raw) {
    if (t.value === 'initial') continue;
    if (t.mode === 'dark' && raw.some((o) => o.name === t.name && o.mode === 'base')) continue; // folded into base
    // skip DTCG tokens already emitted as CSS vars (same name) — the CSS one carries the reference
    if (t.cssAssumed && cssNames.has(t.name)) continue;
    const value = resolve(t.value);
    let category = t.category || null;
    if (t.tw4) {
      if (/^--text-[\w.-]+--/.test(t.name) || /^--(font|ease|animate|breakpoint|container|tracking|leading|perspective|aspect|blur|drop-shadow|inset-shadow|text-shadow)-/.test(t.name) && !/^--font-weight-/.test(t.name)) continue;
      if (t.name === '--spacing') continue;
      const ns = TW4_NS.find(([p]) => t.name.startsWith(p));
      if (ns) { category = ns[1]; t.tw = { fragment: t.name.slice(ns[0].length) }; }
    }
    const meas = measure(value, category);
    if (!category) category = inferCategory(t.name.replace(/^[-$@]+/, ''), meas);
    if (!category && t.typeHint === 'dimension' && meas?.kind === 'length') category = inferCategory(t.jsonPath || t.name, meas) || 'space';
    if (!category || !meas) continue;
    if (category === 'font-weight' && meas.kind === 'length') continue;
    const ok = { color: 'color', space: 'length', radius: 'length', 'font-size': 'length', 'font-weight': 'number', shadow: 'shadow', 'z-index': 'number', duration: 'duration' }[category];
    if (meas.kind !== ok && !(category === 'font-weight' && meas.kind === 'number')) continue;
    const dark = darkByName.get(t.name);
    const refs = {};
    if (t.css) refs.css = t.css;
    if (t.cssAssumed && !opts.jsonVars) refs.cssAssumed = true;
    if (t.scss) refs.scss = t.scss;
    if (t.less) refs.less = t.less;
    if (t.tw) refs.tw = t.tw.fragment;
    if (!refs.css && t.sourceKind?.startsWith('tailwind v3') && /^var\(--[\w-]+\)$/.test(t.value)) refs.css = t.value; // brand: 'var(--x)'
    out.push({
      category, name: t.name, value, raw: t.value !== value ? t.value : undefined,
      usage: usageString(category, refs, t),
      refs, source: t.sourceKind, file: t.file || null, line: t.line || null, mode: t.mode,
      isDefault: !!t.isDefault,
      dark: dark ? resolve(dark.value) : undefined,
      meas,
    });
  }
  return out;
}

const TW_EXAMPLE = { color: (f) => `bg-${f} / text-${f}`, space: (f) => `p-${f} / gap-${f}`, radius: (f) => (f === 'DEFAULT' ? 'rounded' : `rounded-${f}`),
  'font-size': (f) => `text-${f}`, 'font-weight': (f) => `font-${f}`, shadow: (f) => (f === 'DEFAULT' ? 'shadow' : `shadow-${f}`), 'z-index': (f) => `z-${f}`, duration: (f) => `duration-${f}` };
function usageString(category, refs, t) {
  const parts = [];
  if (refs.scss) parts.push(refs.scss);
  if (refs.less) parts.push(refs.less);
  if (refs.css) parts.push(refs.css + (refs.cssAssumed ? ' (assumed build output; --json-vars to trust)' : ''));
  if (refs.tw != null) parts.push(TW_EXAMPLE[category](refs.tw));
  if (!refs.css && !refs.scss && !refs.less && t.sourceKind?.startsWith('tailwind v3')) parts.push(`theme('${t.name}')`);
  return parts.join('  ·  ');
}

/** Human-readable token value. */
export function fmtValue(t) {
  const m = t.meas;
  if (!m) return t.value;
  if (m.kind === 'length' && /rem$/.test(t.value)) return `${t.value} (${+m.px.toFixed(2)}px)`;
  return t.value;
}

/* ------------------------------------------------------------------ CLI -- */

const HELP = `token-drift · tokens.mjs — discover a project's design tokens

Usage
  node tokens.mjs [dir] [options]

Options
  --tokens <path>           Token source file or folder (repeatable). Disables auto-discovery.
  --json                    Print the normalized token list as JSON.
  --all                     List every token (default: first few per category).
  --exec-config             Evaluate tailwind.config.* in a child Node process (uses the
                            project's tailwindcss/resolveConfig when installed). Default is a
                            static read that never executes project code.
  --tailwind-defaults <m>   scales (default): include Tailwind's default spacing/radius/text/
                            weight/shadow/z/duration scales when Tailwind is detected; none: off.
  --json-vars               Trust that DTCG / Style Dictionary tokens exist as var(--path)
                            at runtime (your build generates them), so they can be auto-fixed.
  --rem <px>                Root font size for rem → px (default 16).
  --include/--exclude <g>   Globs limiting where token sources are discovered.
  -h, --help                Show this help.

Detects: CSS custom properties in :root/html/:host/[data-theme]/.dark/prefers-color-scheme
blocks, Tailwind v4 @theme, Tailwind v3 config (theme + extend), W3C DTCG and Style Dictionary
JSON (*token*.json, tokens/**/*.json, *.tokens), SCSS $variables, LESS @variables.`;

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    bool: ['json', 'all', 'exec-config', 'json-vars', 'help'], multi: ['tokens', 'include', 'exclude'], value: ['tailwind-defaults', 'rem'],
  });
  if (a.help) { console.log(HELP); return; }
  const root = path.resolve(a._[0] || '.');
  if (!fs.existsSync(root)) throw new UsageError(`Directory ${a._[0]} does not exist.`);
  const res = await loadTokens(root, { tokens: a.tokens, execConfig: a['exec-config'], tailwindDefaults: a['tailwind-defaults'], rem: a.rem, include: a.include, exclude: a.exclude, jsonVars: a['json-vars'] });
  if (a.json) {
    const clean = res.tokens.map(({ meas, ...t }) => ({ ...t, file: t.file ? rel(t.file, root) : null, ...(meas.kind === 'length' ? { px: meas.px } : meas.kind === 'duration' ? { ms: meas.ms } : meas.kind === 'color' ? { hex: meas.color.key } : {}) }));
    console.log(JSON.stringify({ root, tailwind: { ...res.tailwind, configFile: res.tailwind.configFile ? rel(res.tailwind.configFile, root) : null }, sources: res.sources.map((s) => ({ ...s, file: s.file ? rel(s.file, root) : null })), warnings: res.warnings, tokens: clean }, null, 2));
    return;
  }
  printSummary(res, root, a.all);
}

export function printSummary(res, root, all = false) {
  const { tokens, sources, warnings, tailwind } = res;
  console.log(`${c.bold('token-drift')} ${c.dim('·')} tokens in ${c.cyan(rel(root) === '.' ? path.basename(root) + '/' : rel(root) + '/')}\n`);
  if (!tokens.length) {
    console.log(c.yellow('  No design tokens found.'));
    console.log(c.dim('  Looked for: :root custom properties, Tailwind @theme / tailwind.config.*, tokens.json (DTCG / Style Dictionary), SCSS $vars, LESS @vars.'));
    console.log(`  Point at them with ${c.cyan('--tokens <path>')}, or bootstrap a set from your most common values:`);
    console.log(`    node ${shown(path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan.mjs'))} ${shown(root)} --propose`);
    for (const w of warnings) console.log(c.yellow('  ! ' + w));
    return;
  }
  console.log(c.bold('  Sources'));
  const w = Math.max(...sources.map((s) => (s.file ? rel(s.file, root) : '(built-in)').length), 10);
  for (const s of sources) {
    console.log(`    ${(s.file ? rel(s.file, root) : '(built-in)').padEnd(w)}  ${c.dim(s.kind.padEnd(34))} ${String(s.count).padStart(4)}`);
  }
  if (tailwind.version) console.log(c.dim(`    Tailwind v${tailwind.version}${tailwind.prefix ? ` (prefix "${tailwind.prefix}")` : ''}${tailwind.configFile ? ' · ' + rel(tailwind.configFile, root) : ''}`));
  const dark = tokens.filter((t) => t.dark).length;
  console.log(`\n${c.bold('  By category')}${dark ? c.dim(`   (${plural(dark, 'token')} with dark-mode overrides)`) : ''}`);
  for (const cat of CATEGORIES) {
    const list = tokens.filter((t) => t.category === cat);
    if (!list.length) continue;
    const own = list.filter((t) => !t.isDefault).length;
    const show = all ? list : list.filter((t) => !t.isDefault).slice(0, 4).concat(own ? [] : list.slice(0, 3));
    console.log(`    ${c.bold(cat.padEnd(12))} ${String(list.length).padStart(4)}${own !== list.length ? c.dim(` (${own} project, ${list.length - own} framework defaults)`) : ''}`);
    for (const t of show) {
      const sw = t.meas.kind === 'color' && swatch(t.meas.color.hex) ? swatch(t.meas.color.hex) + ' ' : '';
      console.log(`      ${sw}${c.cyan(t.name)} ${c.dim('=')} ${fmtValue(t)}${t.dark ? c.dim(` (dark: ${t.dark})`) : ''}  ${c.gray('→ ' + t.usage)}`);
    }
    if (!all && list.length > show.length) console.log(c.dim(`      … ${list.length - show.length} more (--all)`));
  }
  for (const w2 of warnings) console.log(c.yellow('\n  ! ' + w2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(c.red('✖ ') + (e instanceof UsageError ? e.message : e.stack || e.message));
    process.exit(e instanceof UsageError ? 2 : 1);
  });
}
