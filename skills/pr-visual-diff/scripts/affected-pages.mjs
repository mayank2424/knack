#!/usr/bin/env node
/**
 * Guess which pages a branch visually affects, so you know what to screenshot.
 * Maps changed files to routes (Next.js app/ and pages/, Remix / React Router, SvelteKit,
 * Nuxt, Astro, plain HTML, React Router SPAs) and follows imports from changed components
 * and stylesheets up to the pages that use them.
 *
 *   node affected-pages.mjs                     # base = merge-base with origin/main (or main)
 *   node affected-pages.mjs --base origin/develop
 *   node affected-pages.mjs --dir apps/web      # monorepo app folder
 *   node affected-pages.mjs --files src/components/Button.tsx,app/globals.css
 *   node affected-pages.mjs --all               # also list every route found
 *   node affected-pages.mjs --json
 *
 * --dir and --files paths are relative to the current directory (like any shell path); a path
 * that only exists relative to the repo root is accepted too.
 *
 * Changed files = committed changes since the base + uncommitted + untracked files.
 * Confidence: high = the page file itself or a component it imports directly;
 * medium = reached through layouts or deeper imports; low = global/heuristic.
 * Last line: PAGES=/,/settings  (static routes worth capturing; dynamic ones need real values)
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, list, printHelp, log, warn, die, git, repoRoot, resolveBase, dim } from './lib.mjs';

const opts = parseArgs(process.argv.slice(2), { values: ['base', 'dir', 'files', 'repo', 'max', 'ref'] });
if (opts.help) { printHelp(import.meta.url); process.exit(0); }

const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : process.cwd());
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', '.astro', '.vercel', '.turbo', '.cache', 'dist', 'build', 'out', 'coverage', '.knack', 'storybook-static', 'public']);
const SRC_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.mdx', '.md', '.css', '.scss', '.sass', '.less', '.html'];
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * A path the user typed: relative to the current directory first (what a shell path means), then
 * to the repo root. Returns an absolute real path (symlinks resolved, so it compares with the
 * repo root git reports), or null when it exists in neither place.
 */
function userPath(p) {
  for (const base of [process.cwd(), repo]) {
    const abs = path.resolve(base, p);
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
  }
  return null;
}
const insideRepo = (abs) => { const r = path.relative(repo, abs); return !r.startsWith('..') && !path.isAbsolute(r); };

// ----------------------------------------------------------- changed files
let changed, baseInfo = null;
if (opts.files) {
  changed = list(opts.files).map((f) => {
    // A deleted file exists nowhere: resolve it like a shell path, against the current directory.
    let abs = userPath(f);
    if (!abs) { const raw = path.resolve(f); const dir = userPath(path.dirname(raw)); abs = dir ? path.join(dir, path.basename(raw)) : raw; }
    if (!insideRepo(abs)) die(`--files: ${f} is outside the repository (${repo}).`);
    return toPosix(path.relative(repo, abs));
  });
}
else {
  baseInfo = resolveBase(repo, opts.base || opts.ref);
  const committedAndDirty = git(['diff', '--name-only', baseInfo.sha], repo).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard'], repo).split('\n');
  changed = [...new Set([...committedAndDirty, ...untracked])].filter(Boolean);
}
if (!changed.length) { console.log('No changed files.'); console.log('PAGES='); process.exit(0); }

// ---------------------------------------------------------------- app root
function findAppRoot() {
  if (opts.dir) {
    const abs = userPath(opts.dir);
    if (!abs) die(`--dir ${opts.dir} does not exist (looked in ${process.cwd()} and in the repo root ${repo}).`);
    if (!fs.statSync(abs).isDirectory()) die(`--dir ${opts.dir} is not a folder: ${abs}`);
    if (!insideRepo(abs)) die(`--dir ${opts.dir} is outside the repository (${repo}).`);
    return abs;
  }
  // Nearest package.json above each changed file; pick the folder holding the most changes.
  const votes = new Map();
  for (const f of changed) {
    let d = path.dirname(path.join(repo, f));
    while (d.startsWith(repo)) {
      if (fs.existsSync(path.join(d, 'package.json'))) { votes.set(d, (votes.get(d) || 0) + 1); break; }
      if (d === repo) break;
      d = path.dirname(d);
    }
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : repo;
}
const appRoot = findAppRoot();
const appRel = toPosix(path.relative(repo, appRoot));
const inApp = (f) => (appRel ? f.startsWith(appRel + '/') : true);
const rel = (f) => (appRel ? f.slice(appRel.length + 1) : f); // repo-relative → app-relative
const changedApp = changed.filter(inApp).map(rel);
const outside = changed.filter((f) => !inApp(f));

let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')); } catch {}
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

// ------------------------------------------------------------ walk sources
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name)); }
    else if (SRC_EXT.includes(path.extname(e.name))) files.push(toPosix(path.relative(appRoot, path.join(dir, e.name))));
    if (files.length > 20000) return;
  }
})(appRoot);
const fileSet = new Set(files);

// --------------------------------------------------------------- routers
const strip = (f) => f.replace(/\.[^./]+$/, '');
const isDynamic = (r) => /\[|:|\*/.test(r);
const join = (segs) => '/' + segs.filter(Boolean).join('/');
const cleanSegs = (segs) => segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));

const routers = [];
const GLOBAL = '*'; // a scope that affects every page
const has = (d) => !!deps[d];
const exists = (p) => fs.existsSync(path.join(appRoot, p));

if (has('next')) {
  routers.push({
    name: 'Next.js app router',
    route(f) {
      const m = f.match(/^(?:src\/)?app\/(?:(.*)\/)?page\.(tsx|ts|jsx|js|mdx|md)$/);
      if (!m) return null;
      const segs = (m[1] || '').split('/');
      if (segs.some((s) => /^\(\.{1,3}\)/.test(s))) return null; // intercepting route
      if (segs.some((s) => s.startsWith('_'))) return null; // _private folder: not routable
      return join(cleanSegs(segs));
    },
    scope(f) {
      const m = f.match(/^(?:src\/)?app\/(?:(.*)\/)?(layout|template|loading|error|not-found|default)\.(tsx|ts|jsx|js)$/);
      if (!m) return null;
      return m[1] ? f.slice(0, f.lastIndexOf('/') + 1) : GLOBAL; // applies to page files in this folder
    },
  });
  routers.push({
    name: 'Next.js pages router',
    route(f) {
      const m = f.match(/^(?:src\/)?pages\/(.*)\.(tsx|ts|jsx|js|mdx|md)$/);
      if (!m || m[1].startsWith('api/') || /(^|\/)_(app|document|error)$/.test(m[1])) return null;
      return join(m[1].split('/').map((s) => (s === 'index' ? '' : s)));
    },
    scope(f) { return /^(?:src\/)?pages\/_(app|document)\.(tsx|ts|jsx|js)$/.test(f) ? GLOBAL : null; },
  });
}
if (has('@remix-run/react') || has('@remix-run/dev') || has('@react-router/dev') || (has('react-router') && exists('app/routes'))) {
  const toRoute = (name) => join(name.split('.').map((s) => {
    if (s === '_index' || s === 'index' || s === 'route') return '';
    if (s.startsWith('_')) return ''; // pathless layout
    if (/^\(.*\)$/.test(s)) return ''; // optional segment
    s = s.replace(/_$/, '');
    if (s === '$') return '*';
    return s.startsWith('$') ? ':' + s.slice(1) : s;
  }));
  routers.push({
    name: 'Remix / React Router',
    route(f) {
      let m = f.match(/^app\/routes\/([^/]+)\/route\.(tsx|ts|jsx|js|mdx)$/);
      if (!m) m = f.match(/^app\/routes\/([^/]+)\.(tsx|ts|jsx|js|mdx|md)$/);
      return m ? toRoute(m[1]) : null;
    },
    // dashboard.tsx is also the layout for dashboard.settings.tsx etc.
    children(f) {
      const m = f.match(/^app\/routes\/([^/]+?)(?:\/route)?\.(tsx|ts|jsx|js)$/);
      return m && !m[1].endsWith('_index') ? `app/routes/${m[1]}.` : null;
    },
    scope(f) { return /^app\/root\.(tsx|ts|jsx|js)$/.test(f) ? GLOBAL : null; },
  });
}
if (has('@sveltejs/kit')) {
  routers.push({
    name: 'SvelteKit',
    route(f) {
      const m = f.match(/^src\/routes\/(?:(.*)\/)?\+page(?:\.server)?\.(svelte|ts|js)$/);
      return m ? join(cleanSegs((m[1] || '').split('/'))) : null;
    },
    scope(f) {
      if (f === 'src/app.html') return GLOBAL;
      const m = f.match(/^src\/routes\/(?:(.*)\/)?\+layout(?:\.server)?\.(svelte|ts|js)$/);
      return m ? (m[1] ? `src/routes/${m[1]}/` : GLOBAL) : null;
    },
  });
}
if (has('nuxt')) {
  routers.push({
    name: 'Nuxt',
    route(f) {
      const m = f.match(/^(?:app\/)?pages\/(.*)\.vue$/);
      return m ? join(m[1].split('/').map((s) => (s === 'index' ? '' : s))) : null;
    },
    scope(f) { return /^(?:app\/)?(app|error)\.vue$/.test(f) || /^(?:app\/)?layouts\//.test(f) ? GLOBAL : null; },
  });
}
if (has('astro')) {
  routers.push({
    name: 'Astro',
    route(f) {
      const m = f.match(/^src\/pages\/(.*)\.(astro|md|mdx|html)$/);
      if (!m || m[1].split('/').some((s) => s.startsWith('_'))) return null; // _files and _dirs are excluded from routing
      return join(m[1].split('/').map((s) => (s === 'index' ? '' : s)));
    },
    scope() { return null; },
  });
}
const frameworkRouters = routers.length;
// Plain HTML pages (static sites, or Vite's index.html entry).
routers.push({
  name: 'HTML',
  route(f) {
    if (!f.endsWith('.html') || frameworkRouters && f !== 'index.html') return null;
    if (f === 'src/app.html') return null;
    if (/(^|\/)index\.html$/.test(f)) return '/' + f.replace(/index\.html$/, '');
    return '/' + f;
  },
  scope() { return null; },
});

// SPA routes declared in code: <Route path="/x" element={<X/>}> or { path: '/x', element: <X/> }.
const spaRoutes = new Map(); // file -> [{path, component}]
if (has('react-router') || has('react-router-dom') || has('@tanstack/react-router') || has('vue-router')) {
  for (const f of files) {
    if (!/\.(tsx|jsx|ts|js|vue)$/.test(f)) continue;
    const src = read(f);
    if (!/path\s*[:=]/.test(src) || !/Route|createBrowserRouter|createRouter|routes/.test(src)) continue;
    const found = [];
    const re = /path\s*[:=]\s*\{?\s*["'`]([^"'`]*)["'`][\s\S]{0,240}?(?:element|component|Component)\s*[:=]\s*\{?\s*<?\s*([A-Z]\w*)/g;
    let m;
    while ((m = re.exec(src))) found.push({ path: m[1].startsWith('/') ? m[1] : '/' + m[1], component: m[2] });
    if (found.length) spaRoutes.set(f, found);
  }
}

function classify(f) {
  for (const r of routers) {
    const route = r.route(f);
    if (route !== null && route !== undefined) return { type: 'route', route, router: r.name, children: r.children?.(f) || null };
    const scope = r.scope(f);
    if (scope !== null && scope !== undefined) return { type: 'scope', scope, router: r.name };
  }
  return null;
}

// ---------------------------------------------------------- import graph
function read(f) { try { return fs.readFileSync(path.join(appRoot, f), 'utf8'); } catch { return ''; } }

function loadAliases() {
  const aliases = [];
  for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
    const txt = read(cfg);
    if (!txt) continue;
    try {
      const json = JSON.parse(txt.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
      const co = json.compilerOptions || {};
      const baseUrl = co.baseUrl || '.';
      for (const [k, v] of Object.entries(co.paths || {})) {
        const target = [].concat(v)[0];
        if (target) aliases.push([k.replace(/\*$/, ''), toPosix(path.join(baseUrl, target.replace(/\*$/, '')))]);
      }
    } catch {}
  }
  const srcOr = (d) => (fs.existsSync(path.join(appRoot, d)) ? d + '/' : '');
  aliases.push(['@/', srcOr('src')], ['~/', exists('app') && !has('nuxt') ? 'app/' : srcOr('src')], ['$lib/', 'src/lib/'], ['$lib', 'src/lib'], ['~~/', ''], ['@@/', '']);
  return aliases;
}
const aliases = loadAliases();

function resolveSpec(from, spec) {
  spec = spec.split('?')[0];
  let base;
  const plainRelative = /\.(html|s?css|less|sass)$/.test(from) && !/^[@~$#]/.test(spec); // href="x.css", @import "x.css"
  if (spec.startsWith('.') || plainRelative && !spec.startsWith('/')) base = toPosix(path.join(path.dirname(from), spec));
  else if (spec.startsWith('/')) base = spec.slice(1);
  else {
    const a = aliases.find(([k]) => spec === k.replace(/\/$/, '') || spec.startsWith(k));
    if (!a) return null; // bare package import
    base = toPosix(path.normalize(a[1] + spec.slice(a[0].length))).replace(/^\.\//, '');
  }
  if (fileSet.has(base)) return base;
  for (const ext of SRC_EXT) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of SRC_EXT) if (fileSet.has(base + '/index' + ext)) return base + '/index' + ext;
  // TS projects importing "./x.js" that is really x.ts
  const noExt = base.replace(/\.(m?js|jsx)$/, '');
  for (const ext of ['.ts', '.tsx']) if (fileSet.has(noExt + ext)) return noExt + ext;
  return null;
}

const IMPORT_RES = [
  /\bimport\s+(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[\w*{}\s,]+?\s+from\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /@(?:import|use|forward)\s+(?:url\()?["']?([^"');\s]+)["']?\)?/g,
  /<(?:link|script)\b[^>]*?(?:href|src)=["']([^"':]+)["']/g,
];
const importers = new Map(); // file -> Set(files importing it)
for (const f of files) {
  const src = read(f);
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const target = resolveSpec(f, m[1]);
      if (target && target !== f) {
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(f);
      }
    }
  }
}

// ---------------------------------------------------------------- analysis
const GLOBAL_RE = /(^|\/)(tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|uno\.config\.[jt]s|panda\.config\.[jt]s|theme\.([jt]sx?|s?css|less)|tokens?\.(json|css|scss|[jt]s)|globals?\.(s?css|less)|app\.(s?css|less)|index\.(s?css|less)|reset\.(s?css)|fonts?\.(s?css)|variables\.(s?css))$/;
const NON_VISUAL_RE = /(\.test\.|\.spec\.|__tests__\/|\.stories\.|\.snap$|(^|\/)README|\.md$|^\.github\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$|\.d\.ts$|(^|\/)(e2e|cypress|playwright)\/)/;

const candidates = new Map(); // route -> {route, confidence, reasons[]}
const RANK = { high: 3, medium: 2, low: 1 };
// Rest params that may be empty (Astro/SvelteKit [...x], Next [[...x]]) also render the parent path.
const OPTIONAL_REST = has('astro') || has('@sveltejs/kit') ? /\/\[\[?\.\.\.[^\]]+\]\]?$/ : /\/\[\[\.\.\.[^\]]+\]\]$/;
function add(route, confidence, reason) {
  if (OPTIONAL_REST.test(route)) {
    const parent = route.replace(OPTIONAL_REST, '') || '/';
    if (!isDynamic(parent)) addOne(parent, confidence, `${reason} (rest param, parent path)`);
  }
  addOne(route, confidence, reason);
}
function addOne(route, confidence, reason) {
  const c = candidates.get(route) || { route, confidence, dynamic: isDynamic(route), reasons: [] };
  if (RANK[confidence] > RANK[c.confidence]) c.confidence = confidence;
  if (c.reasons.length < 4 && !c.reasons.includes(reason)) c.reasons.push(reason);
  candidates.set(route, c);
}
const routeFiles = new Map(); // file -> route
for (const f of files) { const c = classify(f); if (c?.type === 'route') routeFiles.set(f, c.route); }
const allRoutes = [...new Set(routeFiles.values())].sort();
for (const routesInFile of spaRoutes.values()) for (const r of routesInFile) if (!allRoutes.includes(r.path)) allRoutes.push(r.path);
const routesUnder = (prefix) => [...new Set([...routeFiles].filter(([f]) => f.startsWith(prefix)).map(([, r]) => r))];
let globalHit = null;
const unmapped = [], nonVisual = [];

function expandScope(scope, confidence, reason) {
  if (scope === GLOBAL) { globalHit = globalHit || reason; return; }
  for (const r of routesUnder(scope)) add(r, confidence, reason);
}

for (const f of changedApp) {
  const direct = classify(f);
  if (direct?.type !== 'route' && NON_VISUAL_RE.test(f)) { nonVisual.push(f); continue; }
  if (direct?.type === 'route') {
    add(direct.route, 'high', `${f} (page file changed)`);
    if (direct.children) expandScope(direct.children, 'medium', `${f} (parent layout)`);
    continue;
  }
  if (direct?.type === 'scope') { expandScope(direct.scope, 'medium', `${f} (${direct.scope === GLOBAL ? 'root layout' : 'layout'})`); continue; }
  // Follow importers up to pages/layouts.
  let reached = false;
  const seen = new Set([f]);
  let frontier = [f];
  for (let depth = 1; depth <= 8 && frontier.length; depth++) {
    const next = [];
    for (const cur of frontier) {
      for (const imp of importers.get(cur) || []) {
        if (seen.has(imp)) continue;
        seen.add(imp);
        const c = classify(imp);
        const via = depth === 1 ? `${f} → ${imp}` : `${f} → … → ${imp} (${depth} hops)`;
        if (c?.type === 'route') {
          add(c.route, depth <= 2 ? 'high' : 'medium', via);
          if (c.children) expandScope(c.children, 'medium', `${via} (parent layout)`);
          reached = true; continue;
        }
        if (c?.type === 'scope') { expandScope(c.scope, 'medium', via); reached = true; continue; }
        const spa = spaRoutes.get(imp);
        if (spa) {
          const names = bindingsFor(imp, cur);
          const hits = spa.filter((r) => names.includes(r.component));
          hits.forEach((r) => add(r.path, depth <= 2 ? 'medium' : 'low', `${f} → ${imp} (route ${r.path})`));
          if (hits.length) { reached = true; continue; }
        }
        next.push(imp);
      }
    }
    frontier = next;
  }
  if (reached && GLOBAL_RE.test(f)) globalHit = globalHit || `${f} (global style/config)`;
  if (!reached) {
    if (GLOBAL_RE.test(f) || /\.(s?css|less)$/.test(f) && !importers.has(f)) { globalHit = globalHit || `${f} (global style/config)`; }
    else if (/\.(woff2?|ttf|otf)$/.test(f) || /^public\//.test(f)) { globalHit = globalHit || `${f} (static asset)`; }
    else if (seen.size > 1 && [...seen].some((s) => /(^|\/)(main|index|App)\.(tsx|jsx|ts|js|vue)$/.test(s))) { globalHit = globalHit || `${f} (imported by the app entry)`; }
    else unmapped.push(f);
  }
}

/** Local names under which `imp` imports `target` (default, named, or lazy). */
function bindingsFor(imp, target) {
  const src = read(imp), names = [];
  const re = /import\s+([\w*{}\s,]+?)\s+from\s+["']([^"']+)["']|(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[2] || m[4];
    if (resolveSpec(imp, spec) !== target) continue;
    if (m[3]) names.push(m[3]);
    else m[1].replace(/[{}]/g, ' ').split(/[\s,]+/).filter((n) => n && n !== 'as' && n !== '*').forEach((n) => names.push(n));
  }
  return names;
}

if (globalHit) {
  const staticRoutes = allRoutes.filter((r) => !isDynamic(r));
  const top = staticRoutes.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 5);
  if (!top.length) top.push('/');
  top.forEach((r, i) => add(r, i === 0 ? 'medium' : 'low', `global change: ${globalHit}`));
}

// ------------------------------------------------------------------ output
const sorted = [...candidates.values()].sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.route.localeCompare(b.route));
const max = +(opts.max ?? 8);
// Error pages (/404, /500) only when their own file changed: otherwise they just repeat the layout.
const errorPage = (c) => /^\/(404|500|not-found|_error)\/?$/.test(c.route) && !c.reasons.some((r) => r.includes('(page file changed)'));
const pick = sorted.filter((c) => !c.dynamic && !errorPage(c) && (c.confidence !== 'low' || globalHit)).slice(0, max);
if (!pick.length) pick.push(...sorted.filter((c) => !c.dynamic).slice(0, Math.min(max, 3)));
const result = {
  base: baseInfo && { ref: baseInfo.ref, sha: baseInfo.sha },
  appRoot: appRel || '.',
  frameworks: routers.map((r) => r.name).filter((n) => n !== 'HTML' || !frameworkRouters).concat(spaRoutes.size ? ['SPA routes in code'] : []),
  changedFiles: changed.length,
  candidates: sorted,
  globalChange: globalHit,
  unmapped, nonVisual, outsideApp: outside,
  suggestedPages: pick.map((c) => c.route),
  allRoutes: opts.all ? allRoutes : undefined,
};
if (opts.json) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

if (baseInfo) log(`Base ${baseInfo.ref} @ ${baseInfo.short} · ${changed.length} changed file(s) · app root: ${appRel || '.'} · ${result.frameworks.join(', ') || 'no router detected'}`);
else log(`${changed.length} file(s) given · app root: ${appRel || '.'} · ${result.frameworks.join(', ')}`);
if (!sorted.length) console.log('  No page candidates found.');
for (const c of sorted) {
  console.log(`  ${c.confidence.toUpperCase().padEnd(6)} ${c.route}${c.dynamic ? dim('  (dynamic: needs a real value)') : ''}`);
  c.reasons.forEach((r) => console.log(dim(`           ← ${r}`)));
}
if (globalHit) warn(`Global change (${globalHit}): every page may shift. Capture a representative set.`);
if (unmapped.length) console.log(`  Unmapped (no page imports found): ${unmapped.slice(0, 8).join(', ')}${unmapped.length > 8 ? ` +${unmapped.length - 8}` : ''}`);
if (nonVisual.length) console.log(dim(`  Skipped as non-visual: ${nonVisual.slice(0, 6).join(', ')}${nonVisual.length > 6 ? ` +${nonVisual.length - 6}` : ''}`));
if (outside.length) console.log(dim(`  Outside ${appRel || 'app'}: ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ` +${outside.length - 6}` : ''} (shared packages? pass --dir or check their consumers)`));
if (opts.all) console.log(`  All routes (${allRoutes.length}): ${allRoutes.join(', ')}`);
console.log(`PAGES=${result.suggestedPages.join(',')}`);
