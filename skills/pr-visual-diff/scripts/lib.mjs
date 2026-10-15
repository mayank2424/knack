// Shared helpers for the pr-visual-diff scripts (arg parsing, logging, git, Playwright).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const log = (msg) => console.log(`${c(35, '◆')} ${msg}`);
export const ok = (msg) => console.log(`${c(32, '✓')} ${msg}`);
export const warn = (msg) => console.warn(`${c(33, '⚠')} ${msg}`);
export function die(msg, code = 1) {
  console.error(`${c(31, '✖')} ${msg}`);
  process.exit(code);
}
export const dim = (s) => c(2, s);

/**
 * Minimal flag parser: --key value, --key=value, --flag, --no-flag, -h.
 * `values` lists keys that take a value; `optional` lists keys whose value is optional.
 * Repeated value flags become arrays. Positionals land in `_`.
 */
export function parseArgs(argv, { values = [], optional = [], alias = {} } = {}) {
  const V = new Set(values), O = new Set(optional);
  const out = { _: [] };
  const set = (k, v) => {
    if (k in out && V.has(k)) out[k] = [].concat(out[k], v);
    else out[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (alias[a]) a = alias[a];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let k = a.slice(2), v;
    const eq = k.indexOf('=');
    if (eq !== -1) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (v !== undefined) set(k, v);
    else if (V.has(k)) {
      if (argv[i + 1] === undefined) die(`--${k} needs a value`);
      set(k, argv[++i]);
    } else if (O.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) set(k, argv[++i]);
    else if (k.startsWith('no-')) out[k.slice(3)] = false;
    else out[k] = true;
  }
  return out;
}

/** Split comma lists, accepting repeated flags too. */
export const list = (v) => [].concat(v ?? []).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);

/** Print the leading /** ... *\/ block of a script as its --help text. */
export function printHelp(scriptUrl) {
  const src = fs.readFileSync(fileURLToPath(scriptUrl), 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log((m ? m[1] : '').replace(/^ \* ?/gm, '').trim());
}

// ------------------------------------------------------------------ git
export function git(args, cwd = process.cwd(), { allowFail = false, env } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die('git is not installed or not on PATH.');
  if (r.status !== 0) {
    if (allowFail) return null;
    die(`git ${args.join(' ')} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.replace(/\n$/, '');
}

export function repoRoot(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd, { allowFail: true });
  if (!root) die(`Not inside a git repository: ${cwd}\n  cd into your project first (or pass --repo <path>).`);
  return root;
}

/**
 * Resolve the commit to use as "before". With an explicit ref, that ref.
 * Otherwise the merge-base of HEAD with the default branch (origin/HEAD, origin/main,
 * origin/master, main, master).
 */
export function resolveBase(cwd, ref) {
  const verify = (r) => git(['rev-parse', '--verify', '--quiet', `${r}^{commit}`], cwd, { allowFail: true });
  if (ref) {
    const sha = verify(ref);
    if (!sha) die(`Unknown ref "${ref}". Try: git fetch origin && pass --ref origin/<branch>`);
    return { ref, sha, short: sha.slice(0, 7), how: 'explicit ref' };
  }
  const originHead = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd, { allowFail: true });
  const candidates = [originHead && originHead.replace('refs/remotes/', ''), 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean);
  for (const cand of [...new Set(candidates)]) {
    if (!verify(cand)) continue;
    const mb = git(['merge-base', 'HEAD', cand], cwd, { allowFail: true });
    if (!mb) continue;
    const head = verify('HEAD');
    return { ref: cand, sha: mb, short: mb.slice(0, 7), how: `merge-base of HEAD and ${cand}`, onBase: mb === head };
  }
  die('Could not find a base branch (tried origin/HEAD, origin/main, origin/master, main, master).\n  Pass one explicitly: --ref <branch|sha>  (for a PR: gh pr view --json baseRefName -q .baseRefName)');
}

// ------------------------------------------------------------ playwright
export async function loadChromium() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return (await import(mod)).chromium; } catch (_) {}
  }
  die(`Playwright is not installed. Run: bash "${path.join(SCRIPTS_DIR, 'setup.sh')}"`);
}

export async function launchBrowser(chromium) {
  const tries = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const t of tries) {
    try {
      return await chromium.launch({
        ...t,
        args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text', '--font-render-hinting=none', '--disable-skia-runtime-opts', '--disable-gpu-rasterization'],
      });
    } catch (e) { lastErr = e; }
  }
  die(`Could not launch Chromium. Run: npx playwright install chromium\n${lastErr?.message?.split('\n')[0]}`);
}

export async function loadPngLibs() {
  try {
    const { PNG } = await import('pngjs');
    const pixelmatch = (await import('pixelmatch')).default;
    return { PNG, pixelmatch };
  } catch (_) {
    die(`pixelmatch/pngjs are not installed. Run: bash "${path.join(SCRIPTS_DIR, 'setup.sh')}"`);
  }
}
