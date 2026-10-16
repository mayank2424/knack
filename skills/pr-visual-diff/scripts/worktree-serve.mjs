#!/usr/bin/env node
/**
 * Bring up a "before" build of your app from a git ref in a throwaway worktree, without
 * touching your working tree. Also starts/stops a server for the current tree.
 *
 *   node worktree-serve.mjs start                     # base = merge-base with origin/main (or main)
 *   node worktree-serve.mjs start --ref origin/develop --port 4100
 *   node worktree-serve.mjs start --dir apps/web      # monorepo: app lives in a subfolder
 *   node worktree-serve.mjs start --dry-run           # print the plan, run nothing
 *   node worktree-serve.mjs serve --port 4101         # serve the CURRENT tree (head) if nothing runs yet
 *   node worktree-serve.mjs list                      # running servers started by this script
 *   node worktree-serve.mjs stop --all                # kill servers, remove worktrees
 *   node worktree-serve.mjs stop --id base-1a2b3c4
 *
 * start/serve options:
 *   --ref <ref>          Base ref (start only). Default: merge-base of HEAD and the default branch
 *   --port <n>           Port to use (default: first free port from 4100)
 *   --dir <path>         App folder relative to the repo root (default: repo root)
 *   --script <name>      package.json script to run (default: dev, then start, serve, preview)
 *   --cmd "<command>"    Custom start command; "{port}" is replaced, PORT is also exported
 *   --no-install         Skip dependency install in the worktree
 *   --link-node-modules  Symlink your node_modules instead of installing (only if lockfile is unchanged;
 *                        ignored for Next.js/Turbopack, which rejects out-of-project node_modules)
 *   --copy-env           Copy untracked .env* files from your tree into the worktree
 *   --static             Ignore package.json and serve the folder as static files
 *   --timeout <s>        Seconds to wait for the server to answer (default: 240)
 *   --repo <path>        Repository path (default: current directory)
 *   --json               Print machine-readable result on the last line
 *
 * Prints BASE_URL=... (start) or HEAD_URL=... (serve) when the server answers (warns on HTTP 5xx).
 * Dev servers that detach themselves (astro dev under an AI agent, `cmd &` wrappers) are
 * tracked by the PID listening on the port; servers that were already running are never stopped.
 * Your working tree is never modified: worktrees live in the OS temp dir and are
 * registered under .git/worktrees until `stop` removes them.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printHelp, log, ok, warn, die, git, repoRoot, resolveBase, dim } from './lib.mjs';

const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

// ------------------------------------------------------------------ state
function stateFile() {
  const dir = path.join(os.tmpdir(), 'knack-pr-visual-diff');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'servers.json');
}
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return []; } };
const writeState = (s) => fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- detection
function detectPM(appDir, stopAt) {
  let dir = appDir;
  while (true) {
    const has = (f) => fs.existsSync(path.join(dir, f));
    if (has('pnpm-lock.yaml')) return { pm: 'pnpm', root: dir, lock: 'pnpm-lock.yaml' };
    if (has('bun.lockb') || has('bun.lock')) return { pm: 'bun', root: dir, lock: has('bun.lock') ? 'bun.lock' : 'bun.lockb' };
    if (has('yarn.lock')) return { pm: 'yarn', root: dir, lock: 'yarn.lock', berry: has('.yarnrc.yml') };
    if (has('package-lock.json')) return { pm: 'npm', root: dir, lock: 'package-lock.json' };
    if (dir === stopAt || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  const pkg = readPkg(appDir);
  const fromField = pkg?.packageManager?.split('@')[0];
  return { pm: ['pnpm', 'yarn', 'bun', 'npm'].includes(fromField) ? fromField : 'npm', root: appDir, lock: null };
}

const INSTALL = {
  pnpm: () => ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
  yarn: (d) => (d.berry ? ['yarn', ['install', '--immutable']] : ['yarn', ['install', '--frozen-lockfile', '--prefer-offline']]),
  npm: (d) => (d.lock ? ['npm', ['ci', '--no-audit', '--no-fund']] : ['npm', ['install', '--no-audit', '--no-fund']]),
  bun: () => ['bun', ['install', '--frozen-lockfile']],
};
// How to forward extra args to a package.json script with each package manager.
const RUN = {
  pnpm: (s, extra) => ['pnpm', ['run', s, ...extra]],
  yarn: (s, extra) => ['yarn', ['run', s, ...extra]],
  bun: (s, extra) => ['bun', ['run', s, ...extra]],
  npm: (s, extra) => ['npm', ['run', s, ...(extra.length ? ['--', ...extra] : [])]],
};

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

/** Map a package.json to {framework, script, portArgs}. See references/frameworks.md. */
function detectServer(pkg, port, wanted) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  const script = wanted || ['dev', 'start', 'serve', 'preview', 'develop'].find((s) => scripts[s]);
  if (!script || !scripts[script]) return { script: null };
  const body = scripts[script];
  const P = String(port);
  const rules = [
    ['next', /\bnext\b/, ['--port', P]],
    ['nuxt', /\bnuxi?\b/, ['--port', P]],
    ['astro', /\bastro\b/, ['--port', P]],
    ['sveltekit', /\bvite\b/, ['--port', P, '--strictPort'], '@sveltejs/kit'],
    ['react-router', /\breact-router\b/, ['--port', P, '--strictPort'], '@react-router/dev'],
    ['remix-vite', /\bremix vite:dev\b/, ['--port', P, '--strictPort'], '@remix-run/dev'],
    ['remix', /\bremix dev\b/, [], '@remix-run/dev'],
    ['vite', /\bvite\b/, ['--port', P, '--strictPort']],
    ['angular', /\bng serve\b/, ['--port', P]],
    ['gatsby', /\bgatsby\b/, ['--port', P]],
    ['docusaurus', /\bdocusaurus\b/, ['--port', P, '--no-open']],
    ['eleventy', /\beleventy\b/, [`--port=${P}`]],
    ['parcel', /\bparcel\b/, ['--port', P]],
    ['webpack', /\bwebpack(-dev-server| serve)\b/, ['--port', P]],
    ['cra', /\breact-scripts start\b/, []], // CRA reads PORT from env
  ];
  let match = rules.find(([, re, , dep]) => re.test(body) && (!dep || deps[dep]));
  if (!match) match = rules.find(([name, , , dep]) => (dep && deps[dep]) || deps[name]);
  const chained = /&&|\|\||;|\bconcurrently\b|\bnpm-run-all\b|\brun-p\b|\bturbo\b|\bnx\b/.test(body);
  return {
    script,
    body,
    framework: match ? match[0] : 'unknown',
    portArgs: match && !chained ? match[2] : [],
    chained,
  };
}

async function portFree(port) {
  // Busy if anything accepts a connection on IPv4 or IPv6 loopback, or if we cannot bind it.
  const connects = (host) => new Promise((res) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); res(v); };
    sock.setTimeout(400, () => done(false));
    sock.once('connect', () => done(true)).once('error', () => done(false));
  });
  if ((await connects('127.0.0.1')) || (await connects('::1'))) return false;
  const binds = (host) => new Promise((res) => {
    const srv = net.createServer().once('error', (e) => res(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')).once('listening', () => srv.close(() => res(true)));
    srv.listen(port, host);
  });
  return (await binds('127.0.0.1')) && (await binds('::'));
}
async function pickPort(wanted, start = 4100) {
  if (wanted) {
    if (!(await portFree(+wanted))) die(`Port ${wanted} is already in use. Pick another with --port, or omit it to auto-pick.`);
    return +wanted;
  }
  for (let p = start; p < start + 200; p++) if (await portFree(p)) return p;
  die('No free port found between 4100 and 4300.');
}

async function probe(port) {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `http://${host}:${port}/`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      return { url: url.replace(/\/$/, ''), status: r.status };
    } catch {}
  }
  return null;
}

function listenerPid(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pid = parseInt((r.stdout || '').trim().split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}
/** Seconds since a process started (ps etime: [[dd-]hh:]mm:ss), or null. */
function processAgeSeconds(pid) {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  const m = (r.stdout || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]) : null;
}
const tail = (file, n = 25) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; } };
const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin]).status === 0;
const fmtCmd = ([c, a], env = {}) => [...Object.entries(env).map(([k, v]) => `${k}=${v}`), c, ...a.map((x) => (/[\s"'{}]/.test(x) ? JSON.stringify(x) : x))].join(' ');

async function waitUp(child, port, logFile, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastLog = Date.now(), exitedAt = 0;
  let exitCode = null;
  child.once('exit', (code) => { exitCode = code; });
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      // A clean exit can mean "I daemonized" (astro dev under an agent, `next start &` wrappers...).
      // Keep probing for a while before giving up; a non-zero exit is a real failure.
      if (exitCode !== null && exitCode !== 0) return { error: 'exited', code: exitCode };
      if (!exitedAt) exitedAt = Date.now();
      if (Date.now() - exitedAt > 30000) return { error: 'exited', code: exitCode };
    }
    const hit = await probe(port);
    if (hit) return { ...hit, daemonized: !!exitedAt || !alive(child.pid) };
    // Some servers ignore the port we asked for; read the real one from the log.
    const m = tail(logFile, 80).match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g);
    if (m) {
      const other = +m[m.length - 1].split(':').pop();
      if (other !== port) { const h2 = await probe(other); if (h2) return { ...h2, portMismatch: other, daemonized: !!exitedAt || !alive(child.pid) }; }
    }
    if (Date.now() - lastLog > 15000) { log(`waiting for http://localhost:${port} ... ${dim(`(${Math.round((deadline - Date.now()) / 1000)}s left)`)}`); lastLog = Date.now(); }
    await new Promise((r) => setTimeout(r, 750));
  }
  return { error: 'timeout' };
}

// --------------------------------------------------------------------- main
async function main() {
  const opts = parseArgs(argv, { values: ['ref', 'port', 'dir', 'script', 'cmd', 'timeout', 'repo', 'id'] });
  const cmd = opts._[0];
  if (opts.help || !cmd) { printHelp(import.meta.url); process.exit(opts.help ? 0 : 1); }
  if (cmd === 'list') return list();
  if (cmd === 'stop') return stop(opts);
  if (cmd !== 'start' && cmd !== 'serve') die(`Unknown command "${cmd}". Use start | serve | list | stop (see --help).`);

  const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : process.cwd());
  const relDir = opts.dir ? path.normalize(opts.dir) : '.';
  const timeoutS = +(opts.timeout ?? 240);
  const port = opts['dry-run'] && opts.port ? +opts.port : await pickPort(opts.port);
  let srcRoot = repo, base = null, id;

  if (cmd === 'start') {
    base = resolveBase(repo, opts.ref);
    srcRoot = path.join(os.tmpdir(), `knack-pvd-${path.basename(repo).replace(/[^\w.-]/g, '_')}-${base.short}`);
    id = `base-${base.short}`;
    log(`Base: ${base.ref} → ${base.short} ${dim(`(${base.how})`)}`);
    if (base.onBase) warn(`HEAD is the base commit itself (${base.short}). "Before" = last commit; "after" = your uncommitted changes.`);
  } else {
    id = `head-${port}`;
  }
  const appDir = path.join(srcRoot, relDir);
  const plan = [];

  // 1. worktree
  if (cmd === 'start') {
    const existing = git(['worktree', 'list', '--porcelain'], repo).split('\n\n').find((b) => b.startsWith(`worktree ${fs.existsSync(srcRoot) ? fs.realpathSync(srcRoot) : srcRoot}\n`) || b.startsWith(`worktree ${srcRoot}\n`));
    if (existing && existing.includes(`HEAD ${base.sha}`)) log(`Reusing worktree ${srcRoot}`);
    else {
      if (fs.existsSync(srcRoot)) { git(['worktree', 'remove', '--force', srcRoot], repo, { allowFail: true }); fs.rmSync(srcRoot, { recursive: true, force: true }); git(['worktree', 'prune'], repo); }
      plan.push(`git worktree add --detach ${srcRoot} ${base.sha}`);
      if (!opts['dry-run']) {
        git(['worktree', 'add', '--detach', srcRoot, base.sha], repo);
        if (fs.existsSync(path.join(srcRoot, '.gitmodules'))) git(['submodule', 'update', '--init', '--recursive'], srcRoot, { allowFail: true });
        ok(`Worktree at ${srcRoot}`);
      }
    }
    if (opts['copy-env']) {
      const envs = fs.readdirSync(path.join(repo, relDir)).filter((f) => /^\.env(\..+)?$/.test(f) && !git(['ls-files', '--error-unmatch', path.join(relDir, f)], repo, { allowFail: true }));
      for (const f of envs) { plan.push(`cp ${path.join(relDir, f)} → worktree`); if (!opts['dry-run']) fs.copyFileSync(path.join(repo, relDir, f), path.join(appDir, f)); }
      if (envs.length && !opts['dry-run']) ok(`Copied ${envs.join(', ')} into the worktree`);
    } else if (fs.existsSync(path.join(repo, relDir)) && fs.readdirSync(path.join(repo, relDir)).some((f) => /^\.env(\.local|\.development(\.local)?)?$/.test(f))) {
      warn('Your tree has .env files that the worktree will not have. If the base app needs them, re-run with --copy-env.');
    }
  }
  if (!opts['dry-run'] && !fs.existsSync(appDir)) die(`--dir ${relDir} does not exist at ${cmd === 'start' ? base.short : 'HEAD'}: ${appDir}`);

  // 2. decide how to serve
  // In a dry run the worktree does not exist yet; inspect your tree as an approximation.
  const probeDir = fs.existsSync(appDir) ? appDir : path.join(repo, relDir);
  const probeRoot = fs.existsSync(appDir) ? srcRoot : repo;
  const pkg = opts.static ? null : readPkg(probeDir);
  // ASTRO_DEV_BACKGROUND=1: Astro 7+ detaches `astro dev` into a daemon when it detects an AI agent;
  // this keeps it in the foreground so we own (and can stop) the process.
  const env = { PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', ASTRO_DEV_BACKGROUND: '1' };
  let runCmd, framework = 'static', installCmd = null, pmInfo = null;
  if (opts.cmd) {
    const s = String(opts.cmd).replaceAll('{port}', String(port));
    runCmd = [process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', s]];
    framework = 'custom';
  } else if (pkg) {
    const srv = detectServer(pkg, port, opts.script);
    if (!srv.script) {
      if (fs.existsSync(path.join(probeDir, 'index.html'))) pkgFallbackStatic();
      else die(manual(`package.json has no dev/start/serve/preview script${opts.script ? ` named "${opts.script}"` : ''}.`, appDir, port));
    } else {
      pmInfo = detectPM(probeDir, probeRoot);
      if (!has(pmInfo.pm)) die(`${pmInfo.pm} is not installed. Fix: corepack enable  (or: npm i -g ${pmInfo.pm}), then re-run.`);
      runCmd = RUN[pmInfo.pm](srv.script, srv.portArgs);
      framework = srv.framework;
      if (srv.chained) warn(`"${srv.script}" runs a compound command (${srv.body}). Only PORT=${port} is passed; if the app ignores it, re-run with --cmd "<command that serves the app on {port}>" or --dir <app folder>.`);
      else if (framework === 'unknown') warn(`Unrecognized dev server ("${srv.body}"). Passing PORT=${port} only; if it binds elsewhere, use --cmd.`);
      log(`${framework === 'unknown' ? 'Using' : `Detected ${framework} via`} "${srv.script}": ${srv.body}`);
    }
  } else if (fs.existsSync(path.join(probeDir, 'index.html')) || opts.static) {
    pkgFallbackStatic();
  } else {
    die(manual('No package.json and no index.html found.', appDir, port));
  }
  function pkgFallbackStatic() {
    runCmd = [process.execPath, [SELF, '__static', appDir, String(port)]];
    framework = 'static';
  }

  // 3. install deps (worktree only)
  if (cmd === 'start' && pmInfo && opts.install !== false) {
    const srcRel = path.relative(probeRoot, pmInfo.root);
    const pmRoot = path.join(srcRoot, srcRel); // install location inside the worktree
    const nm = path.join(pmRoot, 'node_modules');
    const userNm = path.join(repo, srcRel, 'node_modules');
    const lockSame = pmInfo.lock && git(['diff', '--quiet', base.sha, '--', path.join(srcRel, pmInfo.lock)], repo, { allowFail: true }) !== null;
    const turbopack = framework === 'next' && !/--webpack\b/.test(String(runCmd[1].join(' ')) + ' ' + (pkg?.scripts?.[opts.script || 'dev'] || ''));
    if (opts['link-node-modules'] && turbopack) {
      warn('--link-node-modules ignored: Next.js (Turbopack) refuses a node_modules symlinked from outside the project and serves HTTP 500. Installing instead.');
      opts['link-node-modules'] = false;
    }
    if (opts['link-node-modules']) {
      if (!lockSame) die(`--link-node-modules refused: ${pmInfo.lock || 'lockfile'} differs between ${base.short} and your tree. Drop the flag to install instead.`);
      if (!fs.existsSync(userNm)) die(`--link-node-modules: ${userNm} does not exist. Install deps in your tree first, or drop the flag.`);
      plan.push(`ln -s ${userNm} ${nm}`);
      if (!opts['dry-run'] && !fs.existsSync(nm)) fs.symlinkSync(userNm, nm, 'dir');
    } else if (fs.existsSync(nm)) {
      log('node_modules already present in worktree; skipping install');
    } else {
      installCmd = INSTALL[pmInfo.pm](pmInfo);
      plan.push(`(cd ${pmRoot} && ${fmtCmd(installCmd)})`);
      if (lockSame && fs.existsSync(userNm) && !turbopack) log(dim(`Tip: lockfile is unchanged since base; --link-node-modules would skip this install.`));
      if (!opts['dry-run']) {
        log(`Installing dependencies: ${fmtCmd(installCmd)} ${dim('(in worktree)')}`);
        const r = spawnSync(installCmd[0], installCmd[1], { cwd: pmRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CI: '1' } });
        if (r.status !== 0) die(`Install failed (exit ${r.status}):\n${((r.stderr || '') + (r.stdout || '')).split('\n').slice(-20).join('\n')}\n\nFix the install manually:\n  cd ${pmRoot} && ${fmtCmd(installCmd)}`);
        ok('Dependencies installed');
      }
    }
  } else if (cmd === 'serve' && pmInfo && !fs.existsSync(path.join(pmInfo.root, 'node_modules'))) {
    warn(`No node_modules in ${pmInfo.root}. Install your deps first (${fmtCmd(INSTALL[pmInfo.pm](pmInfo))}).`);
  }

  plan.push(`(cd ${appDir} && ${fmtCmd(runCmd, { PORT: port })})`);
  if (opts['dry-run']) {
    console.log('Plan (nothing executed):');
    plan.forEach((p) => console.log('  ' + p));
    return;
  }

  // 4. start detached, log to file, wait until reachable
  const logFile = path.join(path.dirname(stateFile()), `${id}.log`);
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(runCmd[0], runCmd[1], { cwd: appDir, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
  child.unref();
  const entry = { id, kind: cmd === 'start' ? 'worktree' : 'serve', repo, worktree: cmd === 'start' ? srcRoot : null, ref: base?.ref, sha: base?.sha, pid: child.pid, port, framework, log: logFile, startedAt: new Date().toISOString() };
  writeState([...readState().filter((s) => s.id !== id), entry]);
  log(`Starting ${framework} server on :${port} ${dim(`(log: ${logFile})`)}`);
  const up = await waitUp(child, port, logFile, timeoutS);
  if (up.error) {
    const why = up.error === 'exited' ? `The server process exited${up.code != null ? ` (code ${up.code})` : ''}` : `Nothing answered on port ${port} within ${timeoutS}s`;
    const out = tail(logFile);
    console.error(out);
    if (cmd === 'start' && !opts['copy-env'] && /\benv\b|environment variable|_URL\b|API_KEY|SECRET|is not defined/i.test(out)) warn('Looks like missing configuration. If your tree has .env files, re-run with --copy-env.');
    die(`${why}.\n${manual('', appDir, port, runCmd)}\nClean up with: node ${SELF} stop --id ${id}`);
  }
  if (up.portMismatch) { entry.port = up.portMismatch; warn(`Server ignored --port and is on :${up.portMismatch}.`); }
  if (up.daemonized) {
    // The process we spawned exited but something serves the port. Track the listener only if it
    // started after we did; otherwise it is a server the user already had running (never stop it).
    const lp = listenerPid(entry.port);
    const age = lp ? processAgeSeconds(lp) : null;
    if (lp && age !== null && age <= (Date.now() - Date.parse(entry.startedAt)) / 1000 + 2) {
      entry.pid = lp;
      warn(`The dev server detached itself into the background (pid ${lp}); tracking that process so \`stop\` can end it.`);
    } else {
      entry.pid = null;
      entry.external = true;
      warn(`Port ${entry.port} is served by a process that was already running${lp ? ` (pid ${lp})` : ''}. Using it, but \`stop\` will leave it alone.`);
    }
  }
  entry.url = up.url;
  if (up.status >= 500) {
    console.error(tail(logFile, 30));
    warn(`The server answers, but / returned HTTP ${up.status}: the app is erroring (log tail above). Fix that before capturing, or every page will diff as an error page.`);
  }
  writeState([...readState().filter((s) => s.id !== id), entry]);
  ok(`${cmd === 'start' ? 'Base' : 'Head'} is up: ${up.url} ${dim(`(HTTP ${up.status}${base ? `, ${base.ref} @ ${base.short}` : ''})`)}`);
  console.log(`${cmd === 'start' ? 'BASE_URL' : 'HEAD_URL'}=${up.url}`);
  console.log(`Stop with: node ${SELF} stop --id ${id}`);
  if (opts.json) console.log(JSON.stringify(entry));
}

function manual(reason, appDir, port, runCmd) {
  return `${reason}
Could not start the server automatically. Do this instead:
  1. cd ${appDir}
  2. Install deps if needed (pnpm install / yarn / npm ci / bun install, per the lockfile)
  3. Start the app on port ${port}, e.g. ${runCmd ? fmtCmd(runCmd, { PORT: port }) : `PORT=${port} npm run dev -- --port ${port}`}
     (port flags per framework: references/frameworks.md)
  4. Use http://localhost:${port} as --base for capture.mjs
Or re-run with: --cmd "<your start command using {port}>"`;
}

function list() {
  const s = readState();
  if (!s.length) return console.log('No servers started by worktree-serve.');
  for (const e of s) console.log(`${e.id.padEnd(16)} ${e.external ? 'external' : e.pid && alive(e.pid) ? 'running' : 'stopped'}  ${e.url || `:${e.port}`}  ${e.framework}  ${e.worktree || e.repo}`);
}

function killTree(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const until = Date.now() + 4000;
  while (alive(pid) && Date.now() < until) spawnSync('sleep', ['0.2']);
  if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}

function stop(opts) {
  const s = readState();
  const targets = opts.all ? s : s.filter((e) => e.id === opts.id);
  if (!opts.all && !opts.id) die('Pass --id <id> or --all (see: node worktree-serve.mjs list).');
  if (!targets.length) { warn(opts.all ? 'Nothing to stop.' : `No server with id "${opts.id}".`); return; }
  for (const e of targets) {
    if (e.pid && alive(e.pid)) killTree(e.pid);
    if (e.worktree) {
      git(['worktree', 'remove', '--force', e.worktree], e.repo, { allowFail: true });
      fs.rmSync(e.worktree, { recursive: true, force: true });
      git(['worktree', 'prune'], e.repo, { allowFail: true });
    }
    ok(e.external ? `Forgot ${e.id} (left the server that was already running on :${e.port} alone)` : `Stopped ${e.id}${e.worktree ? ' and removed its worktree' : ''}`);
  }
  writeState(s.filter((e) => !targets.includes(e)));
}

// Internal: tiny static file server used when a project has no dev server.
function staticServer() {
  const [, root, port] = argv;
  const MIME = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain', xml: 'application/xml', mp4: 'video/mp4', webm: 'video/webm' };
  http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const hit = [base, base + '.html', path.join(base, 'index.html')].find((f) => f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(hit).slice(1).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(hit).pipe(res);
  }).listen(+port, '127.0.0.1', () => console.log(`static server: http://localhost:${port}/ (root ${root})`));
}

if (argv[0] === '__static') staticServer();
else await main();
