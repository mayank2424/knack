// Monorepo awareness: which workspace package a file belongs to, which other
// packages' tokens it can actually see at runtime, and which Tailwind major
// version compiles it. Single-package repos collapse to "everything visible".
import fs from 'node:fs';
import path from 'node:path';

/**
 * Build the package graph from the package.json files found under `root`.
 * `cssImports` is a list of [importerFile, importedFile] pairs (CSS @import /
 * @use / JS `import './x.css'`) that add edges package.json may not declare.
 */
export function buildScopes(root, packageJsonFiles, cssImports = []) {
  root = path.resolve(root);
  const pkgs = new Map(); // dir -> { dir, name, deps:Set<dir>, twv }
  const byName = new Map();
  const add = (dir, json) => {
    const deps = { ...json?.dependencies, ...json?.devDependencies, ...json?.peerDependencies };
    const tw = deps.tailwindcss || deps['@tailwindcss/postcss'] || deps['@tailwindcss/vite'] || deps['@tailwindcss/cli'];
    const m = tw && String(tw).match(/(\d+)/);
    const p = { dir, name: json?.name || null, depNames: Object.keys(deps), deps: new Set(), twv: m ? Number(m[1]) : null, twFrom: m ? 'package.json' : null };
    pkgs.set(dir, p);
    if (p.name) byName.set(p.name, p);
  };
  for (const f of packageJsonFiles) {
    let json = null;
    try { json = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    add(path.dirname(f), json);
  }
  if (!pkgs.has(root)) add(root, null);
  for (const p of pkgs.values()) for (const n of p.depNames) { const d = byName.get(n); if (d && d !== p) p.deps.add(d.dir); }

  const cache = new Map();
  const pkgOf = (file) => {
    let dir = path.dirname(path.resolve(file));
    const start = dir;
    if (cache.has(start)) return cache.get(start);
    while (!pkgs.has(dir) && dir.length > root.length) { const up = path.dirname(dir); if (up === dir) break; dir = up; }
    const res = pkgs.has(dir) ? dir : root;
    cache.set(start, res);
    return res;
  };
  // stylesheet imports: relative paths and workspace package specifiers (`@acme/ui/styles.css`, `~pkg/x`)
  const resolveSpec = (from, spec) => {
    spec = spec.replace(/^~/, '');
    if (/^(\.{1,2}\/|\/)/.test(spec)) return pkgOf(path.resolve(path.dirname(from), spec));
    let best = null;
    for (const [n, p] of byName) if ((spec === n || spec.startsWith(n + '/')) && (!best || n.length > best.n.length)) best = { n, dir: p.dir };
    return best ? best.dir : null;
  };
  for (const [from, spec] of cssImports) {
    const a = pkgOf(from), b = resolveSpec(from, spec);
    if (b && a !== b) pkgs.get(a).deps.add(b);
  }
  const ancestors = (dir) => { const out = []; let d = dir; while (d.length > root.length) { d = path.dirname(d); if (pkgs.has(d)) out.push(d); if (d === root) break; } if (!out.includes(root) && dir !== root) out.push(root); return out; };
  const depsStar = new Map();
  const closure = (dir) => {
    if (depsStar.has(dir)) return depsStar.get(dir);
    const seen = new Set();
    const stack = [dir];
    while (stack.length) { const d = stack.pop(); for (const x of pkgs.get(d)?.deps || []) if (!seen.has(x)) { seen.add(x); stack.push(x); } }
    depsStar.set(dir, seen);
    return seen;
  };
  // dependents*: packages whose dependency closure contains dir (the apps that render it)
  const dependents = new Map();
  const dependentsOf = (dir) => {
    if (dependents.has(dir)) return dependents.get(dir);
    const out = [...pkgs.keys()].filter((d) => d !== dir && closure(d).has(dir));
    dependents.set(dir, out);
    return out;
  };
  const rankCache = new Map();
  /**
   * How directly a token defined in package `tokenPkg` reaches code in `filePkg`:
   * 0 same package, 1 an ancestor package, 2 a (transitive) dependency,
   * 3 shipped alongside it by an app that depends on it, Infinity unrelated.
   */
  const rank = (filePkg, tokenPkg) => {
    if (filePkg === tokenPkg) return 0;
    const key = filePkg + '\0' + tokenPkg;
    if (rankCache.has(key)) return rankCache.get(key);
    let r = Infinity;
    if (ancestors(filePkg).includes(tokenPkg)) r = 1;
    else if (closure(filePkg).has(tokenPkg) || ancestors(filePkg).some((a) => closure(a).has(tokenPkg))) r = 2;
    else if (tokenPkg.startsWith(filePkg + path.sep)) r = 3; // root-level code, token in a nested package
    else {
      for (const app of dependentsOf(filePkg)) {
        if (app === tokenPkg || closure(app).has(tokenPkg) || ancestors(app).includes(tokenPkg)) { r = 3; break; }
      }
    }
    rankCache.set(key, r);
    return r;
  };
  /** Resolve a module specifier (relative or workspace package) to a file, trying common extensions. */
  const resolveModule = (from, spec, exts = ['', '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json', '/index.js', '/index.cjs', '/index.ts']) => {
    let base = null;
    if (/^(\.{1,2}\/|\/)/.test(spec)) base = path.resolve(path.dirname(from), spec);
    else {
      let best = null;
      for (const [n, p] of byName) if ((spec === n || spec.startsWith(n + '/')) && (!best || n.length > best.n.length)) best = { n, dir: p.dir };
      if (!best) return null;
      const rest = spec.slice(best.n.length).replace(/^\//, '');
      if (rest) base = path.join(best.dir, rest);
      else {
        let main = null;
        try { main = JSON.parse(fs.readFileSync(path.join(best.dir, 'package.json'), 'utf8')).main; } catch {}
        base = path.join(best.dir, main || 'index');
      }
    }
    for (const e of exts) { const f = base + e; try { if (fs.statSync(f).isFile()) return f; } catch {} }
    return null;
  };
  return { root, pkgs, pkgOf, rank, closure, dependentsOf, ancestors, resolveModule, multi: pkgs.size > 1 };
}

/**
 * Tailwind major version per package: package.json first, then CSS entry points
 * (`@import "tailwindcss"` → 4, `@tailwind base` → 3) and tailwind.config files (→ 3).
 * Packages with no signal inherit from an ancestor, then from the apps that
 * depend on them (when those agree), then the repo-wide majority.
 */
export function tailwindVersions(scopes, { cssSignals = [], configFiles = [] } = {}) {
  const { pkgs, pkgOf } = scopes;
  for (const [file, v] of cssSignals) {
    const p = pkgs.get(pkgOf(file));
    if (p && !p.twv) { p.twv = v; p.twFrom = 'css'; }
    else if (p && p.twFrom === 'css' && v === 4) p.twv = 4;
  }
  for (const f of configFiles) { const p = pkgs.get(pkgOf(f)); if (p && !p.twv) { p.twv = 3; p.twFrom = 'config'; } }
  const counts = {};
  for (const p of pkgs.values()) if (p.twv) counts[p.twv] = (counts[p.twv] || 0) + 1;
  const versions = Object.keys(counts).map(Number);
  const majority = versions.sort((a, b) => counts[b] - counts[a] || b - a)[0] ?? null;
  const cache = new Map();
  const versionFor = (file) => {
    const dir = pkgOf(file);
    if (cache.has(dir)) return cache.get(dir);
    let v = pkgs.get(dir)?.twv ?? null;
    if (!v) for (const a of scopes.ancestors(dir)) if (pkgs.get(a)?.twv) { v = pkgs.get(a).twv; break; }
    if (!v) {
      const fromApps = new Set(scopes.dependentsOf(dir).map((d) => pkgs.get(d)?.twv).filter(Boolean));
      if (fromApps.size === 1) v = [...fromApps][0];
    }
    if (!v) v = majority;
    cache.set(dir, v);
    return v;
  };
  return { versionFor, versions, mixed: versions.length > 1, majority };
}
