// Shared helpers for the demo-recorder scripts (record.mjs, inspect.mjs).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const log = (msg) => console.log(`${c(35, '◆')} ${msg}`);
export const ok = (msg) => console.log(`${c(32, '✓')} ${msg}`);
export const warn = (msg) => console.warn(`${c(33, '⚠')} ${msg}`);
export function die(msg) { console.error(`${c(31, '✖')} ${msg}`); process.exit(1); }

/** Print the leading /** ... *\/ block of a script as its --help text. */
export function printHelp(scriptUrl, code = 0) {
  const src = fs.readFileSync(fileURLToPath(scriptUrl), 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log((m ? m[1] : '').replace(/^ \* ?/gm, '').trim());
  process.exit(code);
}

/**
 * Tiny argv parser. `value` = flags that take a value, `optional` = flags whose
 * value is optional (taken only if the next token is a number).
 */
export function parseArgs(argv, { value = [], optional = [], alias = {} } = {}) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (alias[a]) a = alias[a];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    let k = a.slice(2), v;
    if (k.includes('=')) [k, v] = [k.slice(0, k.indexOf('=')), k.slice(k.indexOf('=') + 1)];
    if (v !== undefined) opts[k] = v;
    else if (value.includes(k)) {
      if (argv[i + 1] === undefined) die(`--${k} needs a value`);
      opts[k] = argv[++i];
    } else if (optional.includes(k) && argv[i + 1] !== undefined && !isNaN(+argv[i + 1])) opts[k] = argv[++i];
    else if (k.startsWith('no-')) opts[k.slice(3)] = false;
    else opts[k] = true;
  }
  return opts;
}

export async function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return (await import(mod)).chromium; } catch (_) {}
  }
  die(`Playwright is not installed. Run: bash "${path.join(SCRIPTS_DIR, 'setup.sh')}"`);
}

export async function launch(chromium, { headed = false } = {}) {
  const tries = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  const args = ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none', '--disable-lcd-text', '--mute-audio'];
  let lastErr;
  for (const t of tries) {
    try { return await chromium.launch({ ...t, headless: !headed, args }); } catch (e) { lastErr = e; }
  }
  die(`Could not launch Chromium. Run: npx playwright install chromium   (from ${SCRIPTS_DIR})\n  ${lastErr?.message?.split('\n')[0]}`);
}

export function hasFfmpeg() {
  try { return spawnSync('ffmpeg', ['-version']).status === 0; } catch { return false; }
}

export function ffmpeg(argv) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...argv], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.split('\n').slice(-12).join('\n')))));
  });
}

export function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return parseFloat(String(r.stdout)) || 0;
}

/** Resolve a URL from a flow file: absolute URLs, host:port, or paths relative to a base / the flow file. */
export function resolveUrl(u, { base, dir = process.cwd() } = {}) {
  if (!u) return base;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('about:') || u.startsWith('data:')) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.(localhost|test))(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  if (base && !base.startsWith('file:')) return new URL(u, base).href;
  const p = path.resolve(base ? path.dirname(fileURLToPath(base)) : dir, u);
  if (fs.existsSync(p.split(/[?#]/)[0])) return pathToFileURL(p.split(/[?#]/)[0]).href + (u.match(/[?#].*$/)?.[0] || '');
  if (base) return new URL(u, base).href;
  die(`Cannot resolve URL "${u}". Use a full URL like http://localhost:3000 or a path to an HTML file.`);
}

export const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1e3)} KB`);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON with // and /* *\/ comments and trailing commas (string-aware). */
export function parseLooseJson(src, file = 'flow') {
  let out = '', i = 0, inStr = false;
  while (i < src.length) {
    const ch = src[i], nx = src[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += nx ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && nx === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '}' || src[j] === ']') { i++; continue; }
    }
    out += ch; i++;
  }
  try { return JSON.parse(out); } catch (e) { die(`${file} is not valid JSON: ${e.message}`); }
}
