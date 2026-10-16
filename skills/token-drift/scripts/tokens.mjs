#!/usr/bin/env node
/**
 * Discover and normalize a project's design tokens.
 *
 *   node tokens.mjs [dir] [--tokens <file|dir>...] [--json] [--all] [--exec-config]
 *                   [--tailwind-defaults scales|none] [--rem 16]
 *
 * Sources: CSS custom properties in root / theme scopes (:root, html, :host,
 * [data-theme], .dark, prefers-color-scheme, SCSS mixins included there, and
 * component roots that are mostly custom properties), Tailwind v4 @theme,
 * Tailwind v3 tailwind.config.* with presets (read statically; --exec-config
 * evaluates it), W3C DTCG / Style Dictionary JSON, SCSS $variables, LESS
 * @variables. Monorepos: every token remembers its workspace package so the
 * scanner only matches tokens a file can actually see.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError, walk, rel, shown, c, swatch, lineIndex, plural, isTestPath } from './lib/util.mjs';
import { blankCssComments, walkCss, splitSfc } from './lib/parse.mjs';
import { measure, inferCategory, setRem, REM_PX, evalLength } from './lib/values.mjs';
import { defaultTheme, THEME_KEYS, readConfigStatic, readConfigExec, presetChain } from './lib/tailwind.mjs';
import { buildScopes, tailwindVersions } from './lib/scope.mjs';

export const CATEGORIES = ['color', 'space', 'radius', 'font-size', 'font-weight', 'shadow', 'z-index', 'duration'];
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less', '.pcss', '.postcss', '.vue', '.svelte', '.astro']);
const TW_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/;
/** Compiled Tailwind output committed to the repo: neither a token source nor hand-written code. */
export const GENERATED_CSS = /^\s*\/\*!\s*tailwindcss v\d/;

const TW4_NS = [
  ['--color-', 'color'], ['--radius-', 'radius'], ['--text-', 'font-size'], ['--font-weight-', 'font-weight'],
  ['--shadow-', 'shadow'], ['--spacing-', 'space'], ['--z-', 'z-index'], ['--duration-', 'duration'],
];

const kebab = (parts) => parts.join('-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_.]+/g, '-').toLowerCase();

/* ------------------------------------------------ selector classification -- */

const ROOT_SEL = /^(?::root|html|:host|body)(?![\w-])|^:where\(\s*:root|^:is\(\s*:root|^&$/;
const THEME_HINT = /\[data-[\w-]*(?:theme|mode|scheme)[\w-]*(?:\s*[~|^$*]?=\s*["']?([^"'\]\s]*)["']?)?\s*\]|\.(dark|light)(?:-(?:mode|theme))?(?![\w-])|\.theme-+([\w-]+)|prefers-color-scheme\s*:\s*(dark|light)/gi;
const LIGHTISH = new Set(['', 'light', 'default', 'base', 'auto', 'system', 'root', 'normal']);
const SIMPLE_SEL = /^(?:[.#][\w-]+|\[[\w-]+(?:[~|^$*]?=[^\]]*)?\]|[a-z][\w-]*)$/i;
const MODE_RANK = { base: 0, dark: 1, variant: 2 };
const worse = (a, b) => (MODE_RANK[b] > MODE_RANK[a] ? b : a);
const valueMode = (v) => { v = String(v || '').toLowerCase(); return /dark/.test(v) ? 'dark' : LIGHTISH.has(v) ? 'base' : 'variant'; };

function splitTop(s, sep) {
  const out = [];
  let d = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    else if (ch === sep && d === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}
const compounds = (sel) => sel.replace(/\s*[>+~]\s*/g, ' ').split(/\s+(?![^([]*[)\]])/).filter(Boolean);

/**
 * Mode of one selector entry (possibly a comma list) as a token scope:
 * 'base' (light / default), 'dark', 'variant' (another theme, density, brand …),
 * or null when it is not a token scope at all (a component selector).
 */
export function selectorMode(entry, block = {}) {
  if (typeof block === 'boolean') block = { root: block };
  let anyDark = false, anyBase = false, anyVariant = false;
  const parts = splitTop(entry, ',');
  // `:root, .app-shell { … }`: a plain class listed next to :root is an alternative root
  const besideRoot = parts.some((p) => ROOT_SEL.test(p.trim()));
  for (const p of parts) {
    THEME_HINT.lastIndex = 0;
    const hints = [...p.matchAll(THEME_HINT)];
    let qualified = false;
    for (const comp of compounds(p)) {
      if (ROOT_SEL.test(comp) || comp === '&') {
        // `html.todesktop.light`: an extra non-theme qualifier on the root makes it a variant scope
        THEME_HINT.lastIndex = 0;
        const rest = comp.replace(ROOT_SEL, '').replace(THEME_HINT, '').replace(/:(not|is|where|has)\([^)]*\)/g, '').replace(/::?[\w-]+(\([^)]*\))?/g, '');
        if (/[.[#]/.test(rest)) qualified = true;
        continue;
      }
      THEME_HINT.lastIndex = 0;
      if (THEME_HINT.test(comp)) continue;
      // `.theme-x [data-portal]`: a theme applied to another subtree, if the block is (almost) only custom properties
      if (SIMPLE_SEL.test(comp) && (block.root || besideRoot || (block.themeOnly && hints.length))) continue;
      return null; // `.dark .card` with real declarations: a component inside a theme, not a token scope
    }
    let mode = qualified ? 'variant' : 'base';
    for (const h of hints) mode = worse(mode, valueMode(h[1] ?? h[2] ?? h[3] ?? h[4] ?? ''));
    if (mode === 'dark') anyDark = true; else if (mode === 'base') anyBase = true; else anyVariant = true;
  }
  return anyDark ? 'dark' : anyBase ? 'base' : anyVariant ? 'variant' : null;
}

/** Mode of a whole selector stack (outermost first), or null if any level is not a token scope. */
export function stackMode(stack, tokenRootAt = () => ({})) {
  let mode = 'base', any = false;
  for (let i = 0; i < stack.length; i++) {
    const s = stack[i];
    if (!s) continue;
    if (s[0] === '@') {
      if (/^@media\b/i.test(s)) { const pm = s.match(/prefers-color-scheme\s*:\s*(dark|light)/i); mode = worse(mode, pm ? (pm[1].toLowerCase() === 'dark' ? 'dark' : 'base') : 'variant'); continue; }
      if (/^@(supports|layer|scope)\b/i.test(s)) continue;
      if (/^@theme\b/.test(s)) { any = true; continue; }
      if (/^@(container|include)\b/.test(s)) { mode = worse(mode, 'variant'); continue; }
      if (/^@variant\b/.test(s)) { mode = worse(mode, /\bdark\b/.test(s) ? 'dark' : 'variant'); continue; } // Tailwind v4 `@variant dark { … }`
      return null; // @keyframes, @font-face, @property, @each … (and @mixin, resolved by the caller)
    }
    const m = selectorMode(s, tokenRootAt(i));
    if (!m) return null;
    any = true; mode = worse(mode, m);
  }
  return any ? mode : null;
}

/* ------------------------------------------------------- style pre-pass -- */

const SEP = '\u0001';
const mixinNs = (file) => path.basename(file).replace(/^_/, '').replace(/\.[^.]+$/, '');

/** Parse every declaration, @include and @import of a stylesheet (or SFC <style> blocks) once. */
export function parseStyle(file, text) {
  const ext = path.extname(file).toLowerCase();
  const decls = [], includes = [], imports = [];
  const regions = (ext === '.vue' || ext === '.svelte' || ext === '.astro')
    ? splitSfc(text).regions.filter((r) => r.kind === 'style').map((r) => ({ content: r.content, base: r.start, lang: r.lang }))
    : [{ content: text, base: 0, lang: ext === '.pcss' || ext === '.postcss' ? 'css' : ext.slice(1) }];
  for (const { content, base, lang } of regions) {
    walkCss(blankCssComments(content, lang), {
      base,
      onDecl: ({ prop, value, valueStart, propStart, selectors }) => decls.push({ prop, value, valueStart, propStart, selectors, lang }),
      onAt: ({ name, params, selectors }) => {
        if (name === 'include') { const m = params.match(/^(?:([\w-]+)\.)?([\w-]+)/); if (m) includes.push({ ns: m[1] || null, name: m[2], selectors }); }
        else if (name === 'import' || name === 'use' || name === 'forward') {
          const as = params.match(/\bas\s+([\w-]+|\*)/);
          for (const m of params.matchAll(/(?:url\(\s*)?["']([^"']+)["']/g)) imports.push({ spec: m[1], kind: name, as: as ? as[1] : null, lang });
        }
      },
    });
  }
  const twSignal = /@import\s+["']tailwindcss(?:\/[\w./-]*)?["']|@theme\b/.test(text) ? 4 : /@tailwind\s+(base|components|utilities)/.test(text) ? 3 : null;
  const stats = new Map(); // per block: how many declarations, how many of them custom properties
  for (const d of decls) {
    const key = d.selectors.join(SEP);
    const s = stats.get(key) || { custom: 0, total: 0 };
    s.total++; if (d.prop.startsWith('--')) s.custom++;
    stats.set(key, s);
  }
  return { file, decls, includes, imports, twSignal, stats };
}

/**
 * Block shape at stack depth i: `root` when it is a component root that is really
 * a token scope (≥ 8 custom properties making up most of the block), `themeOnly`
 * when it holds nothing but custom properties (a theme override block).
 */
function tokenRootAt(stats, stack) {
  return (i) => {
    const s = stats.get(stack.slice(0, i + 1).join(SEP));
    if (!s) return {};
    return { root: s.custom >= 8 && s.custom / s.total >= 0.5, themeOnly: s.custom >= 1 && s.custom / s.total >= 0.8 };
  };
}

/* ------------------------------------------------------------- loading -- */

export async function loadTokens(root, opts = {}) {
  root = path.resolve(root);
  if (opts.rem) setRem(Number(opts.rem));
  const warnings = [];
  const sources = [];
  const tokenFiles = new Set(); // files consumed wholesale (skip when scanning)
  const tokenDefSites = new Set(); // file:offset of every custom-property token definition
  const generated = new Set();
  const raw = []; // un-resolved token records

  const all = walk(root, {});
  const packageJsons = all.filter((f) => path.basename(f) === 'package.json');
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
    const incl = opts.include || opts.exclude ? new Set(walk(root, { include: opts.include, exclude: opts.exclude })) : null;
    candidates = all.filter((f) => (!incl || incl.has(f)) && (opts.includeTests || !isTestPath(path.relative(root, f))));
  }

  // pass 1: parse stylesheets once
  const styles = [];
  const cssImports = [];
  const cssSignals = [];
  const configFiles = [];
  const jsonFiles = [];
  for (const file of candidates) {
    const base = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    if (TW_CONFIG.test(base)) { configFiles.push(file); continue; }
    if (ext === '.json' || base.endsWith('.tokens')) { jsonFiles.push(file); continue; }
    if (!STYLE_EXTS.has(ext)) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (GENERATED_CSS.test(text)) { generated.add(file); continue; }
    const st = parseStyle(file, text);
    st.text = text;
    styles.push(st);
    for (const im of st.imports) cssImports.push([file, im.spec]);
    if (st.twSignal) cssSignals.push([file, st.twSignal]);
  }
  const scopes = buildScopes(root, packageJsons, cssImports);
  const preprocessorReach = buildReach(styles);
  const tw = tailwindVersions(scopes, { cssSignals, configFiles });

  // SCSS mixins that define custom properties and are @included in a token scope (Mastodon-style)
  const includesByName = new Map();
  for (const st of styles) for (const inc of st.includes) (includesByName.get(inc.name) || includesByName.set(inc.name, []).get(inc.name)).push({ ...inc, file: st.file });
  const mixinFiles = new Map(); // name -> Set(ns)
  for (const st of styles) for (const d of st.decls) for (const s of d.selectors) { const m = s.match(/^@mixin\s+([\w-]+)/); if (m) (mixinFiles.get(m[1]) || mixinFiles.set(m[1], new Set()).get(m[1])).add(mixinNs(st.file)); }
  const contextsOf = (name, ns, depth = 0) => {
    if (depth > 4) return [];
    const out = [];
    for (const inc of includesByName.get(name) || []) {
      if (inc.ns && inc.ns !== ns && (mixinFiles.get(name) || new Set()).has(inc.ns)) continue;
      const k = inc.selectors.findIndex((s) => /^@mixin\b/.test(s));
      if (k === -1) out.push(inc.selectors);
      else {
        const outer = inc.selectors[k].match(/^@mixin\s+([\w-]+)/)[1];
        for (const ctx of contextsOf(outer, mixinNs(inc.file), depth + 1)) out.push([...ctx, ...inc.selectors.slice(k + 1)]);
      }
    }
    return out;
  };

  // pass 2: style tokens
  for (const st of styles) {
    const { file, text } = st;
    const pos = lineIndex(text);
    const got = [];
    const scssTop = st.decls.filter((d) => d.prop.startsWith('$') && d.selectors.length === 0).length;
    const lessTop = st.decls.filter((d) => d.prop.startsWith('@') && d.selectors.length === 0).length;
    const tokenish = /(var|token|theme|colou?r|palette|setting|config|spac|typo|font|size|radius|shadow|elevation|z-?index|layer|breakpoint|base|design|core|global|abstract|constant|brand)/i.test(path.basename(path.dirname(file)) + '/' + path.basename(file));
    for (const d of st.decls) {
      const { prop, selectors, propStart, lang } = d;
      const line = pos(propStart).line;
      const value0 = d.value.replace(/\s*!(default|global|important)\s*$/g, '').trim();
      if (prop.startsWith('--')) {
        if (prop.startsWith('--tw-')) continue; // Tailwind internals
        let modes = [];
        const k = selectors.findIndex((s) => /^@mixin\b/.test(s));
        if (k !== -1) {
          const name = selectors[k].match(/^@mixin\s+([\w-]+)/)[1];
          const inner = selectors.slice(k + 1);
          for (const ctx of contextsOf(name, mixinNs(file))) { const m = stackMode([...ctx, ...inner]); if (m && !modes.includes(m)) modes.push(m); }
        } else {
          const shape = tokenRootAt(st.stats, selectors);
          let m = stackMode(selectors, (i) => ({ themeOnly: shape(i).themeOnly }));
          if (!m) { m = stackMode(selectors, shape); if (m) d.scoped = selectors.filter((x) => x[0] !== '@').join(' '); }
          if (m) modes = [m];
        }
        if (!modes.length) continue;
        tokenDefSites.add(file + ':' + propStart);
        const isTheme = selectors.some((s) => /^@theme\b/.test(s));
        for (const mode of modes) {
          got.push({ name: prop, value: value0, file, line, sourceKind: isTheme ? 'tailwind v4 @theme' : 'css custom properties', css: `var(${prop})`, mode, tw4: isTheme, scoped: d.scoped || null });
        }
      } else if (prop.startsWith('$') && (lang === 'scss' || lang === 'sass') && selectors.length === 0) {
        got.push({ name: prop, value: value0, file, line, sourceKind: 'scss variables', scss: prop, mode: 'base', localFile: scssTop >= 4 || tokenish ? null : file });
      } else if (prop.startsWith('@') && lang === 'less' && selectors.length === 0) {
        got.push({ name: prop, value: value0, file, line, sourceKind: 'less variables', less: prop, mode: 'base', localFile: lessTop >= 4 || tokenish ? null : file });
      }
    }
    if (got.length) {
      raw.push(...got);
      const kinds = [...new Set(got.map((t) => t.sourceKind))];
      for (const kind of kinds) sources.push({ file, kind, count: 0 });
    }
  }

  // JSON (DTCG / Style Dictionary)
  for (const file of jsonFiles) {
    const base = path.basename(file);
    if (!explicit.length && !/token/i.test(base) && !/(^|[\\/])tokens[\\/]/.test(file)) continue;
    if (/^(package|tsconfig|package-lock|composer|jsconfig)\.json$/.test(base)) continue;
    const got = readJsonTokens(file, warnings);
    if (got.length) { raw.push(...got); tokenFiles.add(file); sources.push({ file, kind: got[0].sourceKind, count: 0 }); }
  }

  // Tailwind v3-style JS configs (one per package; presets followed)
  const tailwind = { version: tw.majority, versions: tw.versions, mixed: tw.mixed, configFile: configFiles[0] || null, configFiles, prefix: '', mode: null };
  const defaultsWanted = (opts.tailwindDefaults || 'scales') !== 'none';
  for (const configFile of configFiles) {
    tokenFiles.add(configFile);
    const twv = tw.versionFor(configFile) || 3;
    let cfg = null;
    let resolvedTheme = null;
    if (opts.execConfig) {
      try { const r = readConfigExec(configFile, root); cfg = { theme: r.theme, prefix: r.prefix }; if (r.resolved) resolvedTheme = r.theme; tailwind.mode = r.resolved ? 'exec+resolveConfig' : 'exec'; }
      catch (e) { warnings.push(`${e.message}; falling back to static read`); }
    }
    let chain;
    if (!cfg) {
      const st = readConfigStatic(configFile, { resolveModule: scopes.resolveModule });
      for (const f of st.files) tokenFiles.add(f);
      tailwind.mode = tailwind.mode || 'static';
      if (st.warnings.length) warnings.push(`${rel(configFile)}: could not statically resolve ${st.warnings.slice(0, 4).join(', ')}${st.warnings.length > 4 ? '…' : ''}; re-run with --exec-config to evaluate the config`);
      chain = presetChain(st.config);
      if (!tailwind.prefix) tailwind.prefix = st.prefix;
    } else {
      chain = [{ theme: cfg.theme }];
      if (!tailwind.prefix) tailwind.prefix = cfg.prefix || '';
    }
    const got = twConfigTokens(chain, { resolvedTheme, twv, useDefaults: defaultsWanted && !resolvedTheme && twv < 4, configFile, pkg: scopes.pkgOf(configFile) });
    raw.push(...got);
    const own = got.filter((t) => !t.isDefault).length, dflt = got.length - own;
    if (own) sources.push({ file: configFile, kind: `tailwind v3 config (${tailwind.mode})`, count: own });
    if (dflt) sources.push({ file: null, kind: 'tailwind v3 defaults', count: dflt });
  }

  // Tailwind v4 default theme (only when some package compiles with v4)
  const hasV4 = tw.versions.includes(4) || raw.some((t) => t.tw4);
  if (hasV4) {
    if (!tailwind.version) tailwind.version = 4;
    if (defaultsWanted) {
      const got = tw4Defaults(raw);
      raw.push(...got);
      if (got.length) sources.push({ file: null, kind: 'tailwind v4 defaults', count: got.length });
    }
  }

  const tokens = resolveAndNormalize(raw, warnings, { ...opts, scopes });
  for (const s of sources) {
    const kind = s.kind.replace(/ \(.*\)$/, '');
    s.count = new Set(tokens.filter((t) => !t.derived && (t.file || null) === (s.file || null) && t.source === kind).map((t) => t.name + '|' + t.value)).size;
  }
  const seenSrc = new Set();
  const uniqSources = sources.filter((s) => { const k = (s.file || '') + '|' + s.kind; if (seenSrc.has(k) || !s.count) return false; seenSrc.add(k); return true; });
  // only report clashes between packages that can actually see each other
  const conflicts = [...new Set(tokens.filter((t) => t.conflict && tokens.some((o) => o !== t && o.name === t.name && valueKeyOf(o.meas) !== valueKeyOf(t.meas)
    && (o.pkg === t.pkg || !t.pkg || !o.pkg || scopes.rank(t.pkg, o.pkg) < Infinity || scopes.rank(o.pkg, t.pkg) < Infinity))).map((t) => t.name))];
  if (conflicts.length) warnings.push(`${plural(conflicts.length, 'token name')} ${conflicts.length === 1 ? 'is' : 'are'} defined with different values in different packages/files (${conflicts.slice(0, 4).join(', ')}${conflicts.length > 4 ? '…' : ''}); matches use the definition nearest the file, and ambiguous ones are not auto-fixed`);
  return { root, tokens, sources: uniqSources, tokenFiles, tokenDefSites, generated, tailwind, warnings, rem: REM_PX, scopes, twVersionFor: tw.versionFor, preprocessorReach,
    themeReach: buildThemeReach(styles, scopes), texts: new Map(styles.map((st) => [st.file, st.text])) };
}

/**
 * Tailwind v4 only generates a utility (bg-brand) if the CSS entry that compiles your
 * code includes the @theme that defines it. Entries are stylesheets with
 * `@import "tailwindcss"`; an entry compiles its own package and that package's
 * workspace dependencies. Returns (codeFile, themeFile) → true / false, or null when
 * no entry compiles that code (fall back to package visibility).
 */
function buildThemeReach(styles, scopes) {
  const byFile = new Map(styles.map((st) => [st.file, st]));
  const resolveCss = (from, spec) => {
    if (spec === 'tailwindcss' || /^tailwindcss\//.test(spec)) return null;
    let f = null;
    if (/^(\.{1,2}\/|\/)/.test(spec)) f = path.resolve(path.dirname(from), spec);
    else f = scopes.resolveModule(from, spec, ['', '.css', '/index.css']);
    if (!f) return null;
    for (const cand of [f, f + '.css']) if (byFile.has(cand)) return cand;
    return null;
  };
  const entries = styles.filter((st) => /@import\s+["']tailwindcss["']/.test(st.text)).map((st) => st.file);
  const includes = new Map();
  for (const e of entries) {
    const seen = new Set([e]);
    const stack = [e];
    while (stack.length) { const f = stack.pop(); for (const im of byFile.get(f)?.imports || []) { const t = resolveCss(f, im.spec); if (t && !seen.has(t)) { seen.add(t); stack.push(t); } } }
    includes.set(e, seen);
  }
  const serving = new Map();
  const servingFor = (pkg) => {
    if (serving.has(pkg)) return serving.get(pkg);
    const list = entries.filter((e) => { const ep = scopes.pkgOf(e); return ep === pkg || scopes.closure(ep).has(pkg) || scopes.ancestors(pkg).includes(ep); });
    serving.set(pkg, list);
    return list;
  };
  return (codeFile, themeFile) => {
    if (!entries.length) return null;
    const list = servingFor(scopes.pkgOf(codeFile));
    if (!list.length) return null;
    return list.every((e) => includes.get(e).has(themeFile));
  };
}

/**
 * Which SCSS/LESS files' variables each stylesheet can reference, and with what
 * prefix: '' for @import / `@use … as *` (plus whatever those @forward),
 * 'ns.' for a namespaced `@use`. Returns (file) => Map(defFile → prefix).
 */
function buildReach(styles) {
  const known = new Set(styles.map((s) => s.file));
  const resolveStyle = (from, spec) => {
    if (/^(sass|less):|^https?:|^~|^@?[\w-]+\/.*\.css$/.test(spec) || !/^[./\w@-]/.test(spec)) return null;
    const base = path.resolve(path.dirname(from), spec);
    const dir = path.dirname(base), name = path.basename(base);
    const tries = [base, ...['.scss', '.sass', '.less', '.css'].flatMap((e) => [base + e, path.join(dir, '_' + name + e), path.join(base, '_index' + e), path.join(base, 'index' + e)])];
    return tries.find((t) => known.has(t)) || null;
  };
  const edges = new Map();
  for (const st of styles) {
    const list = [];
    for (const im of st.imports) {
      const to = resolveStyle(st.file, im.spec);
      if (!to) continue;
      const ns = im.as && im.as !== '*' ? im.as : path.basename(to).replace(/^_/, '').replace(/\.[^.]+$/, '').replace(/^index$/, path.basename(path.dirname(to)));
      list.push({ to, kind: im.kind === 'import' ? 'import' : im.kind === 'forward' ? 'forward' : im.as === '*' ? 'flat' : 'ns', ns });
    }
    edges.set(st.file, list);
  }
  const forwards = (f, seen = new Set()) => {
    const out = [];
    for (const e of edges.get(f) || []) if ((e.kind === 'forward' || e.kind === 'import') && !seen.has(e.to)) { seen.add(e.to); out.push(e.to, ...forwards(e.to, seen)); }
    return out;
  };
  const cache = new Map();
  const reach = (file, seen = new Set([file])) => {
    if (cache.has(file)) return cache.get(file);
    const out = new Map([[file, '']]);
    for (const e of edges.get(file) || []) {
      if (seen.has(e.to)) continue;
      const prefix = e.kind === 'ns' ? e.ns + '.' : '';
      if (e.kind === 'import') { seen.add(e.to); for (const [k, v] of reach(e.to, seen)) if (!out.has(k)) out.set(k, v); continue; }
      if (e.kind === 'forward') continue;
      for (const t of [e.to, ...forwards(e.to)]) if (!out.has(t)) out.set(t, prefix);
    }
    cache.set(file, out);
    return out;
  };
  return (file) => reach(path.resolve(file));
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Tokens from a Tailwind JS config chain (presets first), merged the way Tailwind merges them. */
function twConfigTokens(chain, { resolvedTheme, twv, useDefaults, configFile, pkg }) {
  const defs = defaultTheme(twv >= 4 ? 4 : 3);
  const got = [];
  for (const [key, cat] of Object.entries(THEME_KEYS)) {
    let own = null;
    const exts = [];
    if (resolvedTheme) own = resolvedTheme[key];
    else for (const c of chain) {
      const t = c?.theme || {};
      if (t[key] && typeof t[key] === 'object') own = t[key];
      if (t.extend?.[key] && typeof t.extend[key] === 'object') exts.push(t.extend[key]);
    }
    const fromDefaults = !own && useDefaults;
    let merged = own && typeof own === 'object' ? own : fromDefaults ? defs[key] : {};
    for (const e of exts) merged = deepMerge(merged, e);
    const defLeaves = new Map();
    if (fromDefaults) flattenTheme(defs[key], [], (frag, v) => defLeaves.set(frag, v));
    const extLeaves = new Set();
    for (const e of exts) flattenTheme(e, [], (frag) => extLeaves.add(frag));
    flattenTheme(merged, [], (frag, value) => {
      if (key === 'fontSize' && Array.isArray(value)) value = value[0];
      if (typeof value === 'number') value = key === 'transitionDuration' ? value + 'ms' : String(value);
      if (typeof value !== 'string') return;
      const isDefault = defLeaves.get(frag) === value && !extLeaves.has(frag);
      got.push({
        name: `${key}.${frag.replace(/-/g, '.')}`, value, category: cat, file: isDefault ? null : configFile, line: null,
        sourceKind: isDefault ? 'tailwind v3 defaults' : 'tailwind v3 config', tw: { fragment: frag }, mode: 'base', isDefault, pkg, twv,
      });
    });
  }
  return got;
}

/** Tailwind v4's default theme, minus anything the project's @theme redefines or resets. */
function tw4Defaults(raw) {
  const defs = defaultTheme(4);
  const resets = raw.filter((t) => t.tw4 && t.value === 'initial').map((t) => t.name);
  const reset = (ns) => resets.includes('--*') || resets.includes(ns + '*');
  const defined = new Set(raw.filter((t) => t.tw4).map((t) => t.name));
  const got = [];
  const v4map = { borderRadius: '--radius-', fontSize: '--text-', fontWeight: '--font-weight-', boxShadow: '--shadow-' };
  for (const [key, ns] of Object.entries(v4map)) {
    if (reset(ns)) continue;
    for (const [frag, value] of Object.entries(defs[key])) {
      const name = ns + frag;
      if (defined.has(name)) continue;
      // rounded-full is calc(infinity * 1px) in v4: a class, not a theme variable
      got.push({ name, value, category: THEME_KEYS[key], sourceKind: 'tailwind v4 defaults', tw: { fragment: frag }, css: frag === 'full' ? undefined : `var(${name})`, mode: 'base', isDefault: true, twv: 4 });
    }
  }
  if (!reset('--color-')) {
    for (const [fam, val] of Object.entries(defs.colors)) {
      const entries = typeof val === 'string' ? [[fam, val]] : Object.entries(val).map(([sh, v]) => [`${fam}-${sh}`, v]);
      for (const [frag, value] of entries) {
        const name = '--color-' + frag;
        if (defined.has(name)) continue;
        got.push({ name, value, category: 'color', sourceKind: 'tailwind v4 defaults', tw: { fragment: frag }, css: `var(${name})`, mode: 'base', isDefault: true, twv: 4 });
      }
    }
  }
  // spacing: --spacing base (default 0.25rem) × scale keys; z-index and duration accept bare numbers
  if (!reset('--spacing')) {
    const spacingTok = raw.find((t) => t.tw4 && t.name === '--spacing');
    const basePx = spacingTok ? (measure(spacingTok.value)?.px ?? 4) : 4;
    for (const k of Object.keys(defs.spacing)) {
      if (defined.has('--spacing-' + k)) continue;
      const px = k === 'px' ? 1 : parseFloat(k) * basePx;
      got.push({ name: `--spacing × ${k}`, value: px + 'px', category: 'space', sourceKind: 'tailwind v4 defaults', tw: { fragment: k },
        css: k === 'px' ? '1px' : `calc(var(--spacing) * ${k})`, mode: 'base', isDefault: true, twv: 4 });
    }
  }
  for (const [k, v] of Object.entries(defs.zIndex)) got.push({ name: `z-${k}`, value: v, category: 'z-index', sourceKind: 'tailwind v4 defaults', tw: { fragment: k }, mode: 'base', isDefault: true, twv: 4 });
  for (const [k, v] of Object.entries(defs.transitionDuration)) got.push({ name: `duration-${k}`, value: v, category: 'duration', sourceKind: 'tailwind v4 defaults', tw: { fragment: k }, mode: 'base', isDefault: true, twv: 4 });
  return got;
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

/** Back-compat helper: style tokens of one file, without project-wide context. */
export function readStyleTokens(file, text) {
  const st = parseStyle(file, text);
  const out = [];
  for (const d of st.decls) {
    if (!d.prop.startsWith('--')) continue;
    const mode = stackMode(d.selectors, tokenRootAt(st.stats, d.selectors));
    if (mode) out.push({ name: d.prop, value: d.value.trim(), file, mode });
  }
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
    const hasPlain = !hasDollar && 'value' in node && (typeof node.value !== 'object' || Array.isArray(node.value) || node.value?.hex || node.value?.unit || node.value?.colorSpace);
    if (hasDollar || hasPlain) {
      if (hasDollar) dtcg = true;
      let v = hasDollar ? node.$value : node.value;
      const t = hasDollar ? type : (node.type || node.$type || node.attributes?.category || inheritedType);
      v = normalizeJsonValue(v, t);
      if (v == null) return;
      const name = kebab(pathParts);
      const cat = typeMap[t] ?? null;
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

const fmtNum = (x) => +Number(x).toFixed(4);
/** DTCG 2025.10 color object → a CSS color string we can parse (srgb, srgb-linear, hsl, oklch, oklab; else its hex). */
function dtcgColor(v) {
  const comps = Array.isArray(v.components) ? v.components.map((x) => (x === 'none' ? 0 : x)) : null;
  const a = v.alpha != null && v.alpha < 1 ? ` / ${fmtNum(v.alpha)}` : '';
  if (comps && comps.length === 3) {
    const [x, y, z] = comps;
    switch (v.colorSpace) {
      case 'srgb': return `rgb(${fmtNum(x * 255)} ${fmtNum(y * 255)} ${fmtNum(z * 255)}${a})`;
      case 'srgb-linear': { const g = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255; return `rgb(${fmtNum(g(x))} ${fmtNum(g(y))} ${fmtNum(g(z))}${a})`; }
      case 'hsl': return `hsl(${fmtNum(x)} ${fmtNum(y)}% ${fmtNum(z)}%${a})`;
      case 'oklch': return `oklch(${fmtNum(x)} ${fmtNum(y)} ${fmtNum(z)}${a})`;
      case 'oklab': return `oklab(${fmtNum(x)} ${fmtNum(y)} ${fmtNum(z)}${a})`;
    }
  }
  return v.hex || null;
}

function normalizeJsonValue(v, type) {
  if (v == null) return null;
  if (typeof v === 'number') return type === 'duration' ? v + 'ms' : /dimension|spacing|size|radius|font-?size/i.test(type || '') ? v + 'px' : String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.colorSpace) return dtcgColor(v);
    if (v.hex) return v.hex;
    if (v.value != null && v.unit) return `${v.value}${v.unit}`;
    if ('offsetX' in v) return shadowObj(v);
  }
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && 'offsetX' in x)) return v.map(shadowObj).join(', ');
  return null;
}
const dimStr = (d) => (d && typeof d === 'object' ? `${d.value}${d.unit}` : typeof d === 'number' ? d + 'px' : d);
const shadowObj = (s) => `${s.inset ? 'inset ' : ''}${dimStr(s.offsetX)} ${dimStr(s.offsetY)} ${dimStr(s.blur)} ${dimStr(s.spread ?? 0)} ${typeof s.color === 'object' ? normalizeJsonValue(s.color) : s.color}`;

/* ------------------------------------------------ resolve + normalize -- */

const HSL_CHANNELS = /^-?\d*\.?\d+(?:deg)?(?:\s*,\s*|\s+)\d*\.?\d+%(?:\s*,\s*|\s+)\d*\.?\d+%$/;
const RGB_CHANNELS = /^(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})$/;
const SIZEISH = new Set(['space', 'spacing', 'gap', 'size', 'width', 'height', 'radius', 'font', 'z', 'zindex', 'index', 'weight', 'line', 'leading', 'grid', 'col', 'cols', 'columns', 'row', 'rows', 'duration', 'delay', 'ease', 'opacity', 'scale', 'ratio', 'order', 'breakpoint', 'blur', 'spread', 'offset', 'angle', 'rotate']);
/** `--primary: 222 47% 11%` (shadcn v3) or `--brand-rgb: 13, 110, 253` (Bootstrap): color channels meant for hsl()/rgb(). */
function channelKind(name, value) {
  if (name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/).some((seg) => SIZEISH.has(seg))) return null;
  if (HSL_CHANNELS.test(value)) return 'hsl';
  const m = value.match(RGB_CHANNELS);
  if (m && [m[1], m[2], m[3]].every((x) => Number(x) <= 255)) return 'rgb';
  return null;
}

function resolveAndNormalize(raw, warnings, opts = {}) {
  const { scopes } = opts;
  const byName = new Map();
  const byJsonPath = new Map();
  for (const t of raw) {
    if (t.value === 'initial') continue;
    t.pkg = t.pkg !== undefined ? t.pkg : t.file && scopes ? scopes.pkgOf(t.file) : null;
    (byName.get(t.name) || byName.set(t.name, []).get(t.name)).push(t);
    if (t.jsonPath) byJsonPath.set(t.jsonPath, t);
  }
  // the definition of `name` that `from` sees: same file, then same package, then nearest package, base mode first
  const lookup = (name, from) => {
    const list = byName.get(name);
    if (!list) return null;
    if (list.length === 1) return list[0];
    let best = null, bestScore = Infinity;
    for (const t of list) {
      let s = t.mode === 'base' ? 0 : 0.5;
      if (from?.file && t.file === from.file) s += 0;
      else if (from?.pkg && t.pkg === from.pkg) s += 1;
      else if (from?.pkg && t.pkg && scopes) s += 2 + Math.min(scopes.rank(from.pkg, t.pkg), 10);
      else s += 20;
      if (s < bestScore) { bestScore = s; best = t; }
    }
    return best;
  };
  const resolve = (value, from, depth = 0) => {
    if (depth > 12 || typeof value !== 'string') return value;
    let v = value;
    v = v.replace(/^\{([^}]+)\}$/, (m, p) => { const t = byJsonPath.get(p); return t ? resolve(t.value, t, depth + 1) : m; });
    v = v.replace(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/s, (m, name, fb) => { const t = lookup(name, from); return t && t !== from ? resolve(t.value, t, depth + 1) : (fb ? resolve(fb.trim(), from, depth + 1) : m); });
    v = v.replace(/^(\$[\w-]+)$/, (m, name) => { const t = lookup(name, from); return t ? resolve(t.value, t, depth + 1) : m; });
    v = v.replace(/^(@[\w-]+)$/, (m, name) => { const t = lookup(name, from); return t ? resolve(t.value, t, depth + 1) : m; });
    // hsl(var(--primary)) / rgb(var(--x) / <alpha-value>) over channel variables
    v = v.replace(/^(hsla?|rgba?)\(\s*var\(\s*(--[\w-]+)\s*\)\s*(?:(?:\/|,)\s*(<alpha-value>|[\d.]+%?))?\s*\)$/, (m, fn, name, alpha) => {
      const t = lookup(name, from);
      if (!t) return m;
      const ch = resolve(t.value, t, depth + 1);
      if (!channelKind(name, ch)) return m;
      return `${fn.replace(/a$/, '')}(${ch}${alpha && alpha !== '<alpha-value>' ? (ch.includes(',') ? ', ' : ' / ') + alpha : ''})`;
    });
    return v;
  };
  // inline every var() / $x then evaluate calc(): `calc(var(--radius) - 2px)` → px
  const resolveDeep = (value, from, depth = 0) => {
    if (depth > 6 || typeof value !== 'string' || !/var\(|calc\(|\$[\w-]|[*+]/.test(value)) return null;
    let v = value, guard = 0;
    while (/var\(\s*--[\w-]+\s*(?:,[^()]*)?\)/.test(v) && guard++ < 8) {
      v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (m, name, fb) => {
        const t = lookup(name, from);
        if (t === from) return fb?.trim() || 'NaN';
        const r = t ? resolve(t.value, t, depth + 1) : fb?.trim();
        if (r && !/var\(/.test(r)) return r;
        return (t && resolveDeep(t.value, t, depth + 1)) || 'NaN';
      });
    }
    v = v.replace(/\$[\w-]+/g, (m) => { const t = lookup(m, from); return t && t !== from ? resolve(t.value, t, depth + 1) : m; });
    const px = evalLength(v);
    return px == null ? null : `${+px.toFixed(4)}px`;
  };
  const cssNames = new Set(raw.filter((t) => t.sourceKind === 'css custom properties' || t.sourceKind === 'tailwind v4 @theme').map((t) => t.name));
  const out = [];
  for (const [name, list] of byName) {
    const bases = list.filter((t) => t.mode === 'base');
    const darks = list.filter((t) => t.mode === 'dark');
    const variants = list.filter((t) => t.mode === 'variant');
    // a token that only exists inside alternative themes is still a token; its value depends on the theme
    const primaries = bases.length ? bases : variants.length ? [variants[0]] : darks.length ? [] : [];
    for (const t of primaries) {
      if (t.cssAssumed && cssNames.has(t.name)) continue; // DTCG token also emitted as a CSS var: the CSS one carries the reference
      let value = resolve(t.value, t);
      let category = t.category || null;
      if (t.tw4) {
        if (/^--text-[\w.-]+--/.test(t.name) || (/^--(font|ease|animate|breakpoint|container|tracking|leading|perspective|aspect|blur|drop-shadow|inset-shadow|text-shadow|default-)/.test(t.name) && !/^--font-weight-/.test(t.name))) continue;
        if (t.name === '--spacing') continue;
        const ns = TW4_NS.find(([p]) => t.name.startsWith(p));
        if (ns) { category = ns[1]; t.tw = { fragment: t.name.slice(ns[0].length) }; }
      }
      const refs = {};
      if (t.css) refs.css = t.css;
      const ck = t.css && typeof value === 'string' ? channelKind(t.name, value) : null;
      if (ck) { value = `${ck}(${value})`; refs.css = `${ck}(var(${t.name}))`; category = 'color'; }
      let meas = measure(value, category);
      let calcValue;
      if (!meas) { const px = resolveDeep(value, t); if (px) { meas = measure(px, category); calcValue = px; } }
      if (!category) category = inferCategory(t.name.replace(/^[-$@]+/, ''), meas);
      if (!category && t.typeHint === 'dimension' && meas?.kind === 'length') category = inferCategory(t.jsonPath || t.name, meas) || 'space';
      if (!category || !meas) continue;
      if (category === 'font-weight' && meas.kind === 'length') continue;
      const ok = { color: 'color', space: 'length', radius: 'length', 'font-size': 'length', 'font-weight': 'number', shadow: 'shadow', 'z-index': 'number', duration: 'duration' }[category];
      if (meas.kind !== ok) continue;
      if (t.cssAssumed && !opts.jsonVars) refs.cssAssumed = true;
      if (t.scss) refs.scss = t.scss;
      if (t.less) refs.less = t.less;
      if (t.tw) refs.tw = t.tw.fragment;
      // Tailwind JS config values that point at CSS variables can be written in CSS too
      if (!refs.css && t.sourceKind?.startsWith('tailwind v3')) {
        if (/^var\(--[\w-]+\)$/.test(t.value)) refs.css = t.value;
        else { const m = t.value.match(/^(hsla?|rgba?)\(\s*var\((--[\w-]+)\)\s*(?:(?:\/|,)\s*<alpha-value>)?\s*\)$/); if (m && value !== t.value) refs.css = `${m[1].replace(/a$/, '')}(var(${m[2]}))`; }
      }
      const themed = [];
      const darkDef = darks.find((d) => d.pkg === t.pkg) || darks[0];
      let dark;
      if (darkDef) { dark = resolve(darkDef.value, darkDef); if (ck && channelKind(t.name, dark)) dark = `${ck}(${dark})`; }
      const otherVariants = (bases.length ? variants : variants.slice(1)).filter((v) => resolve(v.value, v) !== t.value);
      if (otherVariants.length) themed.push(`${otherVariants.length} other theme${otherVariants.length === 1 ? '' : 's'}`);
      out.push({
        category, name: t.name, value: calcValue && value === t.value ? t.value : value, raw: t.value !== value ? t.value : undefined,
        usage: usageString(category, refs, t),
        refs, source: t.sourceKind, file: t.file || null, line: t.line || null, mode: 'base',
        isDefault: !!t.isDefault, pkg: t.pkg ?? null, twv: t.twv ?? (t.tw4 ? 4 : null), localFile: t.localFile || null, scoped: t.scoped || null, tw4: !!t.tw4,
        dark: dark !== undefined && dark !== value ? dark : undefined,
        themes: !bases.length && variants.length ? 'theme-only' : themed.length ? themed.join(', ') : undefined,
        meas,
      });
    }
  }
  // a spacing unit (`--space-factor: 0.25rem`, `--grid-unit: 8px`) is a scale: calc(var(--x) * n) is on it
  for (const t of out.slice()) {
    if (t.category !== 'space' || !t.refs.css || t.refs.cssAssumed || !/(^|-)(factor|unit|grid-unit|base-unit|step)$/i.test(t.name.replace(/^--/, ''))) continue;
    for (const n of [0.5, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16]) {
      const px = t.meas.px * n;
      out.push({ ...t, name: `${t.name} × ${n}`, value: `${+px.toFixed(3)}px`, raw: `calc(var(${t.name}) * ${n})`, refs: { css: `calc(var(${t.name}) * ${n})` },
        usage: `calc(var(${t.name}) * ${n})`, meas: { kind: 'length', px }, derived: true });
    }
  }
  // a token defined through a themed one (`--radius-sm: calc(var(--radius) * 0.6)`) follows that theme too
  const themedNames = new Map(out.filter((t) => t.dark || t.themes).map((t) => [t.name, t]));
  for (const t of out) {
    if (t.dark || t.themes || typeof (t.raw ?? t.value) !== 'string') continue;
    const via = [...String(t.raw ?? t.value).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]).find((n) => themedNames.has(n) && n !== t.name);
    if (via) t.themes = `follows ${via}, which changes per theme`;
  }
  // same name, different values (several apps / themes in one repo)
  const groups = new Map();
  for (const t of out) (groups.get(t.name) || groups.set(t.name, []).get(t.name)).push(t);
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keys = new Set(list.map((t) => valueKeyOf(t.meas)));
    if (keys.size > 1) for (const t of list) t.conflict = list.filter((o) => o !== t).map((o) => `${o.value}${o.file ? ' in ' + rel(o.file) : ''}`).slice(0, 3);
  }
  return out;
}

export const valueKeyOf = (m) => (m.kind === 'color' ? m.color.key : m.kind === 'length' ? 'px' + Math.round(m.px * 100) / 100 : m.kind === 'duration' ? 'ms' + m.ms : m.kind === 'number' ? 'n' + m.n : m.key);

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
  if (m.kind === 'length' && !/^-?[\d.]+px$/.test(t.value)) return `${t.value} (${+m.px.toFixed(2)}px)`;
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
  --tailwind-defaults <m>   scales (default): include Tailwind's default palette and spacing/
                            radius/text/weight/shadow/z/duration scales (for the package's major
                            version) when Tailwind is detected; none: off.
  --json-vars               Trust that DTCG / Style Dictionary tokens exist as var(--path)
                            at runtime (your build generates them), so they can be auto-fixed.
  --rem <px>                Root font size for rem → px (default 16).
  --include/--exclude <g>   Globs limiting where token sources are discovered.
  --include-tests           Also read token sources inside tests/fixtures/stories.
  -h, --help                Show this help.

Detects: CSS custom properties in :root/html/:host/[data-*theme*]/.dark/prefers-color-scheme
blocks (other themes are variants; SCSS mixins @included there count too), Tailwind v4 @theme,
Tailwind v3 configs with presets (theme + extend), W3C DTCG and Style Dictionary JSON
(*token*.json, tokens/**/*.json, *.tokens), SCSS $variables, LESS @variables. hsl()/rgb()
channel variables (--primary: 222 47% 11%) and calc() values are resolved. Test fixtures and
compiled Tailwind output are ignored. In monorepos every token is tagged with its package.`;

async function main() {
  const a = parseArgs(process.argv.slice(2), {
    bool: ['json', 'all', 'exec-config', 'json-vars', 'include-tests', 'help'], multi: ['tokens', 'include', 'exclude'], value: ['tailwind-defaults', 'rem'],
  });
  if (a.help) { console.log(HELP); return; }
  const root = path.resolve(a._[0] || '.');
  if (!fs.existsSync(root)) throw new UsageError(`Directory ${a._[0]} does not exist.`);
  const res = await loadTokens(root, { tokens: a.tokens, execConfig: a['exec-config'], tailwindDefaults: a['tailwind-defaults'], rem: a.rem, include: a.include, exclude: a.exclude, jsonVars: a['json-vars'], includeTests: a['include-tests'] });
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
  if (tailwind.version) console.log(c.dim(`    Tailwind ${tailwind.mixed ? 'v' + tailwind.versions.join(' + v') + ' (per package)' : 'v' + tailwind.version}${tailwind.prefix ? ` (prefix "${tailwind.prefix}")` : ''}${tailwind.configFiles?.length ? ' · ' + tailwind.configFiles.map((f) => rel(f, root)).join(', ') : ''}`));
  if (res.scopes?.multi) console.log(c.dim(`    ${res.scopes.pkgs.size} workspace packages: each file only matches tokens its package can see`));
  // the same default scale read for several configs is one token as far as a human is concerned
  const seen = new Set();
  const uniq = tokens.filter((t) => { if (t.derived) return false; const k = t.category + '|' + t.name + '|' + t.value; if (seen.has(k)) return false; seen.add(k); return true; });
  const dark = uniq.filter((t) => t.dark).length;
  console.log(`\n${c.bold('  By category')}${dark ? c.dim(`   (${plural(dark, 'token')} with dark-mode overrides)`) : ''}`);
  for (const cat of CATEGORIES) {
    const list = uniq.filter((t) => t.category === cat);
    if (!list.length) continue;
    const own = list.filter((t) => !t.isDefault).length;
    const show = all ? list : list.filter((t) => !t.isDefault).slice(0, 4).concat(own ? [] : list.slice(0, 3));
    console.log(`    ${c.bold(cat.padEnd(12))} ${String(list.length).padStart(4)}${own !== list.length ? c.dim(` (${own} project, ${list.length - own} framework defaults)`) : ''}`);
    for (const t of show) {
      const sw = t.meas.kind === 'color' && swatch(t.meas.color.hex) ? swatch(t.meas.color.hex) + ' ' : '';
      console.log(`      ${sw}${c.cyan(t.name)} ${c.dim('=')} ${fmtValue(t)}${t.dark ? c.dim(` (dark: ${t.dark})`) : t.themes ? c.dim(` (${t.themes})`) : ''}  ${c.gray('→ ' + t.usage)}`);
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
