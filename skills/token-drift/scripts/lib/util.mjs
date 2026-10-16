// Small shared helpers: argument parsing, terminal styling, file walking with
// .gitignore support, glob matching. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';

/* ----------------------------------------------------------------- args -- */

/**
 * Parse argv. `spec.bool` flags take no value (but accept `--flag=value`),
 * `spec.multi` flags may repeat (values also split on commas), everything else
 * that starts with `--` takes the next token as its value.
 */
export function parseArgs(argv, spec = {}) {
  const bool = new Set(spec.bool || []);
  const multi = new Set(spec.multi || []);
  const known = new Set([...(spec.bool || []), ...(spec.multi || []), ...(spec.value || [])]);
  const out = { _: [] };
  for (const m of multi) out[m] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (k.startsWith('no-') && bool.has(k.slice(3))) { out[k.slice(3)] = false; continue; }
    if (!known.has(k)) {
      throw new UsageError(`Unknown option --${k}. Run with --help to see the options.`);
    }
    if (bool.has(k)) { out[k] = v === undefined ? true : v; continue; }
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${k} needs a value.`);
    }
    if (multi.has(k)) out[k].push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    else out[k] = v;
  }
  return out;
}

export class UsageError extends Error {}

/* ------------------------------------------------------------- terminal -- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39),
  yellow: wrap(33, 39), blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};
export const swatch = (hex) => {
  if (!useColor || !hex) return '';
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return '';
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return `\x1b[48;2;${r};${g};${b}m  \x1b[49m`;
};

/** Path for display: relative to cwd unless that climbs out more than two levels. */
export const shown = (p) => { const r = rel(p); return r.startsWith('../../..') ? p : r; };

export const rel = (p, base = process.cwd()) => {
  const r = path.relative(base, p) || '.';
  return r.split(path.sep).join('/');
};

/* ---------------------------------------------------------------- globs -- */

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|') + ')';
      i = end;
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Match a repo-relative posix path against user globs (basename match when the glob has no slash). */
export function makeMatcher(globs) {
  if (!globs || !globs.length) return null;
  const tests = globs.map((g) => {
    const clean = g.replace(/^\.\//, '');
    const re = globToRegExp(clean.includes('/') ? clean : '**/' + clean);
    const dirRe = globToRegExp((clean.includes('/') ? clean : '**/' + clean).replace(/\/?$/, '/**'));
    return (p) => re.test(p) || dirRe.test(p);
  });
  return (p) => tests.some((t) => t(p));
}

/* ------------------------------------------------------------ gitignore -- */

function compileGitignore(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    if (line.startsWith('\\')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\//, '');
    const re = globToRegExp(anchored ? line : '**/' + line);
    rules.push({ re, neg, dirOnly });
  }
  return rules;
}

function findGitRoot(start) {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export const ALWAYS_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output',
  'coverage', '.knack', '.turbo', '.cache', '.vercel', '.netlify', 'vendor', 'storybook-static',
  '.parcel-cache', '.yarn', '.pnpm-store', '__snapshots__',
]);

/**
 * Walk `root`, yielding absolute file paths. Respects .gitignore files from the
 * git root down, skips ALWAYS_SKIP dirs, minified bundles and huge files.
 */
export function walk(root, { exts, include, exclude, gitignore = true, maxBytes = 1_500_000 } = {}) {
  root = path.resolve(root);
  const files = [];
  const incl = makeMatcher(include);
  const excl = makeMatcher(exclude);
  const ruleSets = [];
  if (gitignore) {
    const gitRoot = findGitRoot(root);
    if (gitRoot && gitRoot !== root) {
      // ancestors between git root and scan root
      const chain = [];
      let d = path.dirname(root);
      while (d.length >= gitRoot.length) { chain.unshift(d); if (d === gitRoot) break; d = path.dirname(d); }
      for (const dir of chain) addIgnore(dir);
    }
  }
  function addIgnore(dir) {
    const f = path.join(dir, '.gitignore');
    if (gitignore && fs.existsSync(f)) {
      try { ruleSets.push({ base: dir, rules: compileGitignore(fs.readFileSync(f, 'utf8')) }); } catch {}
    }
  }
  function ignored(abs, isDir) {
    let res = false;
    for (const { base, rules } of ruleSets) {
      if (!abs.startsWith(base + path.sep)) continue;
      const r = abs.slice(base.length + 1).split(path.sep).join('/');
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(r)) res = !rule.neg;
      }
    }
    return res;
  }
  function visit(dir) {
    const before = ruleSets.length;
    addIgnore(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.storybook') || ignored(abs, true)) continue;
        const relDir = rel(abs, root);
        if (excl && excl(relDir)) continue;
        visit(abs);
      } else if (e.isFile()) {
        if (exts && !exts.has(path.extname(e.name).toLowerCase())) continue;
        if (/\.min\.(js|css)$/.test(e.name) || /\.(map|d\.ts)$/.test(e.name)) continue;
        if (ignored(abs, false)) continue;
        const r = rel(abs, root);
        if (incl && !incl(r)) continue;
        if (excl && excl(r)) continue;
        try { if (fs.statSync(abs).size > maxBytes) continue; } catch { continue; }
        files.push(abs);
      }
    }
    ruleSets.length = before;
  }
  visit(root);
  return files;
}

/* ---------------------------------------------------------- line/col map -- */

export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;

/** Tests, stories and fixtures: skipped by default (they hold demo values and fake token sets). */
const TEST_DIR = /(^|[\\/])(__tests__|__mocks__|__fixtures__|__stories__|fixtures?|tests?|e2e|cypress|playwright|stories|\.storybook)[\\/]/;
const TEST_FILE = /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$|\.(stories|story)\.[\w.]+$/;
export const isTestPath = (relPath) => TEST_DIR.test(relPath) || TEST_FILE.test(relPath);
