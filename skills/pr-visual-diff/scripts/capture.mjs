#!/usr/bin/env node
/**
 * Knack PR Visual Diff: screenshot pages on a base and a head build, pixel-diff them,
 * and write compare images + summary.md / summary.json.
 *
 *   node capture.mjs --base http://localhost:4100 --head http://localhost:3000 --pages /,/settings
 *   node capture.mjs --base ./examples/before --head ./examples/after --pages /,/pricing
 *
 * Targets (--base / --head): an http(s):// origin, a file:// URL, or a local folder.
 *   For file:// and folders, "/pricing" resolves to pricing.html or pricing/index.html.
 *
 * Options:
 *   --pages <list>          Comma-separated paths (default: /). Repeatable.
 *   --widths <list>         Viewport widths in CSS px (default: 375,1280)
 *   --height <px>           Viewport height (default: 900)
 *   --full-page             Capture the whole scrollable page, not just the first viewport
 *   --mask <selectors>      Paint over dynamic regions on both sides (e.g. ".timestamp,.avatar")
 *   --hide <selectors>      visibility:hidden on these elements before capture
 *   --css <file|css>        Extra CSS injected on both sides
 *   --wait-for <x>          networkidle (default) | load | <css selector> | <milliseconds>
 *   --freeze-time [iso]     Pin Date/Date.now (default 2024-01-01T10:00:00Z) and seed Math.random
 *   --color-scheme <s>      light (default) | dark
 *   --storage-state <file>  Playwright storageState JSON (cookies + localStorage) for logged-in pages.
 *                           Have the user create it: npx playwright codegen --save-storage=auth.json <url>
 *   --threshold <pct>       Changed-pixel % at/above which a pair is "changed" (default 0.1).
 *                           Anything above 0 but below it is "minor".
 *   --pixel-threshold <n>   pixelmatch per-pixel color tolerance 0..1 (default 0.1, lower = stricter)
 *   --scale <n>             deviceScaleFactor (default 1)
 *   --label-base <s>        Label for the base side (default: "before")
 *   --label-head <s>        Label for the head side (default: "after")
 *   --image-base-url <url>  Prefix for image links in summary.md (default: relative paths)
 *   --out <dir>             Output folder (default: ./.knack/pr-visual-diff)
 *   --concurrency <n>       Parallel page×width pairs (default: 3)
 *   --timeout <ms>          Navigation timeout per page (default: 45000)
 *   --no-stable-check       Skip the "two identical screenshots in a row" stability check
 *   --no-dev-overlays       Do not hide Next/Vite/Astro dev overlays (hidden by default)
 *   --fail-on-change        Exit 2 if any pair is "changed" (useful in CI)
 *
 * Output: <out>/summary.md, <out>/summary.json and per pair
 *   <out>/pages/<page-slug>/<width>/{base,head,diff,compare}.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs, list, printHelp, log, ok, warn, die, loadChromium, launchBrowser, loadPngLibs } from './lib.mjs';

const opts = parseArgs(process.argv.slice(2), {
  values: ['base', 'head', 'pages', 'widths', 'height', 'mask', 'hide', 'css', 'wait-for', 'color-scheme', 'storage-state', 'threshold',
    'pixel-threshold', 'scale', 'label-base', 'label-head', 'image-base-url', 'out', 'concurrency', 'timeout'],
  optional: ['freeze-time'],
});
if (opts.help) { printHelp(import.meta.url); process.exit(0); }
if (!opts.base || !opts.head) {
  printHelp(import.meta.url);
  die('Both --base and --head are required.');
}

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const pages = list(opts.pages).length ? list(opts.pages) : ['/'];
const widths = (list(opts.widths).length ? list(opts.widths) : ['375', '1280']).map(Number);
if (widths.some((w) => !Number.isFinite(w) || w < 200 || w > 4000)) die(`--widths must be numbers between 200 and 4000 (got ${list(opts.widths).join(',')})`);
const height = +(one(opts.height) ?? 900);
const scale = +(one(opts.scale) ?? 1);
const threshold = +(one(opts.threshold) ?? 0.1);
const pixelThreshold = +(one(opts['pixel-threshold']) ?? 0.1);
const timeout = +(one(opts.timeout) ?? 45000);
const concurrency = Math.max(1, +(one(opts.concurrency) ?? 3));
const waitFor = one(opts['wait-for']) ?? 'networkidle';
const masks = list(opts.mask);
const hides = list(opts.hide);
const fullPage = !!opts['full-page'];
const freezeTime = opts['freeze-time'] === undefined ? null : (opts['freeze-time'] === true ? '2024-01-01T10:00:00Z' : one(opts['freeze-time']));
if (freezeTime && Number.isNaN(Date.parse(freezeTime))) die(`--freeze-time expects an ISO date, got "${freezeTime}"`);
const outDir = path.resolve(one(opts.out) ?? '.knack/pr-visual-diff');
const imageBase = one(opts['image-base-url']);
const storageState = one(opts['storage-state']);
if (storageState && !fs.existsSync(storageState)) die(`--storage-state file not found: ${storageState}`);
const labels = { base: one(opts['label-base']) ?? 'before', head: one(opts['label-head']) ?? 'after' };

let extraCss = '';
if (opts.css) {
  const v = one(opts.css);
  extraCss = fs.existsSync(v) ? fs.readFileSync(v, 'utf8') : v;
}

// ------------------------------------------------------------- targets
function toTarget(raw, side) {
  if (/^https?:\/\//i.test(raw)) return { kind: 'http', raw, url: new URL(raw) };
  let dir;
  if (/^file:/i.test(raw)) dir = fileURLToPath(raw);
  else dir = path.resolve(raw);
  if (!fs.existsSync(dir)) die(`--${side} folder not found: ${dir}`);
  if (fs.statSync(dir).isFile()) return { kind: 'file', raw, dir: path.dirname(dir), single: dir };
  return { kind: 'file', raw, dir };
}
const targets = { base: toTarget(one(opts.base), 'base'), head: toTarget(one(opts.head), 'head') };
if (targets.base.raw === targets.head.raw) warn('--base and --head are identical; every pair will be unchanged.');

function resolvePage(t, page) {
  if (t.kind === 'http') {
    const basePath = t.url.pathname.replace(/\/$/, '');
    const p = page.startsWith('/') ? page : '/' + page;
    return { url: `${t.url.origin}${basePath}${p}${t.url.search && !p.includes('?') ? t.url.search : ''}` };
  }
  if (t.single && (page === '/' || page === '')) return { url: pathToFileURL(t.single).href };
  const [p, rest = ''] = page.split(/(?=[?#])/);
  const rel = decodeURIComponent(p.replace(/^\/+/, ''));
  const candidates = rel === '' || rel.endsWith('/')
    ? [path.join(t.dir, rel, 'index.html')]
    : [path.join(t.dir, rel), path.join(t.dir, rel + '.html'), path.join(t.dir, rel, 'index.html')];
  const hit = candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!hit) return { error: `No file for "${page}" in ${t.dir} (tried ${candidates.map((f) => path.relative(t.dir, f) || f).join(', ')})` };
  return { url: pathToFileURL(hit).href + rest };
}

const slug = (page) => {
  const s = page.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\.html?$/, '');
  return s || 'home';
};

// --------------------------------------------------------- stabilization
const STABILIZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}
html { scrollbar-width: none !important; }
::-webkit-scrollbar { display: none !important; }
`;
const DEV_OVERLAY_CSS = `
nextjs-portal, [data-nextjs-toast], [data-nextjs-dev-tools-button], #__next-build-watcher, #__next-prerender-indicator,
vite-error-overlay, astro-dev-toolbar, #webpack-dev-server-client-overlay, #react-refresh-overlay,
nuxt-devtools-frame, #nuxt-devtools-container, #__nuxt_devtools__ { display: none !important; }
`;
const css = STABILIZE_CSS + (opts['dev-overlays'] === false ? '' : DEV_OVERLAY_CSS)
  + (hides.length ? `${hides.join(',\n')} { visibility: hidden !important; }\n` : '') + extraCss;

async function capture(browser, url, width) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
    colorScheme: one(opts['color-scheme']) === 'dark' ? 'dark' : 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors: true,
    ...(storageState ? { storageState } : {}),
  });
  const notes = [];
  try {
    if (freezeTime) {
      await ctx.clock.setFixedTime(new Date(freezeTime));
      await ctx.addInitScript(() => {
        let s = 0x2f6b9a1d;
        Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      });
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });

    const resp = await page.goto(url, { waitUntil: 'load', timeout });
    const httpStatus = resp ? resp.status() : null;

    if (waitFor === 'networkidle') {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => notes.push('network never went idle (10s); captured anyway'));
    } else if (/^\d+$/.test(waitFor)) {
      await page.waitForTimeout(+waitFor);
    } else if (waitFor !== 'load') {
      await page.waitForSelector(waitFor, { state: 'visible', timeout }).catch(() => { throw new Error(`--wait-for selector "${waitFor}" never became visible`); });
    }
    await page.addStyleTag({ content: css }).catch(() => notes.push('could not inject stabilization CSS (CSP?)'));
    await page.evaluate(async (full) => {
      document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
      if (full) {
        // Walk the page so lazy content and intersection observers fire, then return to the top.
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      window.scrollTo(0, 0);
      const imgs = [...document.images].filter((i) => !i.complete);
      await Promise.race([
        Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    }, fullPage);

    const shotOpts = {
      type: 'png', fullPage, animations: 'disabled', caret: 'hide', scale: 'device', timeout,
      mask: masks.map((m) => page.locator(m)), maskColor: '#FF00FF',
    };
    let buf = await page.screenshot(shotOpts);
    let stable = true;
    if (opts['stable-check'] !== false) {
      stable = false;
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(250);
        const next = await page.screenshot(shotOpts);
        if (next.equals(buf)) { stable = true; break; }
        buf = next;
      }
      if (!stable) notes.push('page kept changing between screenshots (animation, carousel, video, or live data?)');
    }
    return { buf, httpStatus, errors: [...new Set(errors)].slice(0, 5), stable, notes };
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------------ diff
const { PNG, pixelmatch } = await loadPngLibs();
const DIFF_COLOR = [255, 0, 80];
const BOX_COLOR = [0, 120, 255];

function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < png.width && y < png.height) continue;
    const i = (y * w + x) * 4, light = ((x + y) >> 3) & 1;
    out.data[i] = out.data[i + 1] = light ? 236 : 214; out.data[i + 2] = light ? 240 : 222; out.data[i + 3] = 255;
  }
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** Group changed pixels into boxes: 8px grid cells, merged when within 24px of each other. */
function regionsOf(diff, w, h) {
  const CELL = 8, REACH = 3;
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  const counts = new Uint32Array(cols * rows);
  const d = diff.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (d[i] === DIFF_COLOR[0] && d[i + 1] === DIFF_COLOR[1] && d[i + 2] === DIFF_COLOR[2]) counts[((y / CELL) | 0) * cols + ((x / CELL) | 0)]++;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, pixels: 0 };
    const stack = [start]; seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop(), cx = cell % cols, cy = (cell / cols) | 0;
      box.x0 = Math.min(box.x0, cx); box.y0 = Math.min(box.y0, cy); box.x1 = Math.max(box.x1, cx); box.y1 = Math.max(box.y1, cy);
      box.pixels += counts[cell];
      for (let dy = -REACH; dy <= REACH; dy++) for (let dx = -REACH; dx <= REACH; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (counts[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    boxes.push({
      x: box.x0 * CELL, y: box.y0 * CELL,
      width: Math.min(w, (box.x1 + 1) * CELL) - box.x0 * CELL, height: Math.min(h, (box.y1 + 1) * CELL) - box.y0 * CELL,
      pixels: box.pixels,
    });
  }
  return boxes.sort((a, b) => b.pixels - a.pixels).slice(0, 12);
}

function drawBoxes(png, boxes) {
  const T = 3, PAD = 4;
  for (const b of boxes) {
    const x0 = Math.max(0, b.x - PAD), y0 = Math.max(0, b.y - PAD);
    const x1 = Math.min(png.width - 1, b.x + b.width + PAD), y1 = Math.min(png.height - 1, b.y + b.height + PAD);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x - x0 >= T && x1 - x >= T && y - y0 >= T && y1 - y >= T) continue;
      const i = (y * png.width + x) * 4;
      png.data[i] = BOX_COLOR[0]; png.data[i + 1] = BOX_COLOR[1]; png.data[i + 2] = BOX_COLOR[2]; png.data[i + 3] = 255;
    }
  }
}

/**
 * Detect "everything below Y moved by dy px" (a taller header, a new banner...). Compares
 * per-row hashes of the unpadded images; uniform rows are ignored because they match anything.
 */
function detectShift(a, b, firstRow) {
  const rowHashes = (png) => {
    const out = new Array(png.height);
    for (let y = 0; y < png.height; y++) {
      let h = 2166136261, uniform = true;
      const row = y * png.width * 4;
      for (let i = 0; i < png.width * 4; i++) {
        const v = png.data[row + i];
        if (uniform && v !== png.data[row + (i % 4)]) uniform = false;
        h = Math.imul(h ^ v, 16777619);
      }
      out[y] = uniform ? null : h >>> 0;
    }
    return out;
  };
  const ha = rowHashes(a), hb = rowHashes(b);
  const count = (dy) => {
    let n = 0;
    for (let y = firstRow; y < ha.length; y++) if (ha[y] !== null && ha[y] === hb[y + dy]) n++;
    return n;
  };
  const still = count(0);
  let best = { dy: 0, n: still };
  const range = Math.min(600, Math.max(a.height, b.height));
  for (let dy = -range; dy <= range; dy++) {
    if (!dy) continue;
    const n = count(dy);
    if (n > best.n) best = { dy, n };
  }
  if (!best.dy || best.n < 24 || best.n < still * 1.5) return null;
  return { fromY: Math.round(firstRow / scale), dy: Math.round(best.dy / scale), matchedRows: best.n };
}

function diffPair(baseBuf, headBuf) {
  const a0 = PNG.sync.read(baseBuf), b0 = PNG.sync.read(headBuf);
  const w = Math.max(a0.width, b0.width), h = Math.max(a0.height, b0.height);
  const a = padTo(a0, w, h), b = padTo(b0, w, h);
  const diff = new PNG({ width: w, height: h });
  const changed = pixelmatch(a.data, b.data, diff.data, w, h, {
    threshold: pixelThreshold, alpha: 0.12, diffColor: DIFF_COLOR, aaColor: [200, 200, 200], includeAA: false,
  });
  const regions = changed ? regionsOf(diff, w, h) : [];
  const shift = regions.length ? detectShift(a0, b0, Math.min(...regions.map((r) => r.y))) : null;
  drawBoxes(diff, regions);
  return {
    a: a0.width !== w || a0.height !== h ? PNG.sync.write(a) : baseBuf,
    b: b0.width !== w || b0.height !== h ? PNG.sync.write(b) : headBuf,
    diff: PNG.sync.write(diff),
    w, h, changed, total: w * h, shift,
    sizes: { base: { width: a0.width, height: a0.height }, head: { width: b0.width, height: b0.height } },
    regions: regions.map(({ x, y, width, height, pixels }) => ({
      x: Math.round(x / scale), y: Math.round(y / scale), width: Math.round(width / scale), height: Math.round(height / scale), pixels,
    })),
  };
}

// --------------------------------------------------------------- compose
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const STATUS_COLOR = { changed: '#e5484d', minor: '#f5a524', unchanged: '#30a46c', error: '#8e8e93' };

async function compose(browser, dir, r, d) {
  const cssW = d.w / scale, cssH = d.h / scale;
  const f = Math.min(1, 2400 / (3 * cssW + 64), 7000 / cssH);
  const pw = Math.round(cssW * f), ph = Math.round(cssH * f);
  const pct = r.percent === null ? '' : `${r.percent.toFixed(r.percent < 0.01 && r.percent > 0 ? 4 : 2)}% changed`;
  const sizeNote = (r.sizeChanged ? ` · height ${r.base.height}→${r.head.height}px` : '')
    + (r.shift ? ` · below y≈${r.shift.fromY}px shifted ${r.shift.dy > 0 ? 'down' : 'up'} ${Math.abs(r.shift.dy)}px` : '');
  const panel = (src, label, sub) => `<figure><figcaption><b>${esc(label)}</b><span>${esc(sub)}</span></figcaption><img src="${src}" width="${pw}" height="${ph}"></figure>`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0f1115;color:#e6e6ea;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;display:inline-block}
    header{display:flex;align-items:center;gap:12px;padding:14px 16px 4px}
    header code{font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff}
    header .w{color:#9a9aa3}
    .pill{margin-left:auto;padding:4px 10px;border-radius:999px;font-weight:700;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#0f1115;background:${STATUS_COLOR[r.status]}}
    .meta{color:#9a9aa3;font-size:13px}
    main{display:flex;gap:16px;padding:12px 16px 16px;align-items:flex-start}
    figure{margin:0}
    figcaption{display:flex;justify-content:space-between;gap:8px;padding:0 2px 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
    figcaption span{color:#9a9aa3;text-transform:none;letter-spacing:0}
    img{display:block;border-radius:6px;outline:1px solid #2a2d35;background:#fff}
  </style><body><header><code>${esc(r.page)}</code><span class="w">${r.width}px${fullPage ? ' · full page' : ''}</span>
  <span class="pill">${r.status}</span><span class="meta">${esc(pct + sizeNote)}</span></header>
  <main>${panel('base.png', 'Base', labels.base)}${panel('head.png', 'Head', labels.head)}${panel('diff.png', 'Diff', r.regions.length ? `${r.regions.length} region${r.regions.length > 1 ? 's' : ''}` : 'no changes')}</main></body>`;
  const file = path.join(dir, '.compare.html');
  fs.writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: 3 * pw + 64, height: 200 }, deviceScaleFactor: scale });
  try {
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    const box = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await page.setViewportSize({ width: box.w, height: Math.min(box.h, 16000) });
    await page.screenshot({ path: path.join(dir, 'compare.png'), fullPage: true });
  } finally {
    await page.close();
    fs.rmSync(file, { force: true });
  }
}

// ------------------------------------------------------------------ main
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, 'pages'), { recursive: true, force: true });

const chromium = await loadChromium();
const browser = await launchBrowser(chromium);
const started = Date.now();
const jobs = pages.flatMap((page) => widths.map((width) => ({ page, width })));
log(`Capturing ${pages.length} page(s) × ${widths.length} width(s) = ${jobs.length} pair(s)`);
log(`base: ${targets.base.raw}`);
log(`head: ${targets.head.raw}`);

let done = 0;
const results = await pool(jobs, concurrency, async ({ page, width }) => {
  const rel = path.posix.join('pages', slug(page), String(width));
  const dir = path.join(outDir, rel);
  fs.mkdirSync(dir, { recursive: true });
  const r = { page, width, status: 'error', percent: null, changedPixels: null, totalPixels: null, sizeChanged: false, regions: [], shift: null, notes: [], files: {} };
  try {
    const urls = { base: resolvePage(targets.base, page), head: resolvePage(targets.head, page) };
    for (const side of ['base', 'head']) if (urls[side].error) throw new Error(`${side}: ${urls[side].error}`);
    r.urls = { base: urls.base.url, head: urls.head.url };
    const [cb, ch] = await Promise.all([capture(browser, urls.base.url, width), capture(browser, urls.head.url, width)]);
    for (const [side, c] of [['base', cb], ['head', ch]]) c.notes.forEach((n) => r.notes.push(`${side}: ${n}`));
    r.consoleErrors = { base: cb.errors, head: ch.errors };
    const fresh = ch.errors.filter((e) => !cb.errors.includes(e));
    if (fresh.length) r.notes.push(`head: new console errors: ${fresh.slice(0, 2).join(' | ')}`);
    r.httpStatus = { base: cb.httpStatus, head: ch.httpStatus };
    const bad = (s) => s && s >= 400;
    if (bad(cb.httpStatus) && bad(ch.httpStatus)) throw new Error(`HTTP ${cb.httpStatus} on base and ${ch.httpStatus} on head; check the page path`);
    if (bad(cb.httpStatus)) r.notes.push(`new page? base returned HTTP ${cb.httpStatus}`);
    if (bad(ch.httpStatus)) r.notes.push(`REGRESSION? head returned HTTP ${ch.httpStatus} (base ${cb.httpStatus})`);
    r.stable = { base: cb.stable, head: ch.stable };
    const d = diffPair(cb.buf, ch.buf);
    fs.writeFileSync(path.join(dir, 'base.png'), d.a);
    fs.writeFileSync(path.join(dir, 'head.png'), d.b);
    fs.writeFileSync(path.join(dir, 'diff.png'), d.diff);
    Object.assign(r, {
      changedPixels: d.changed, totalPixels: d.total, percent: (d.changed / d.total) * 100,
      base: d.sizes.base, head: d.sizes.head, regions: d.regions, shift: d.shift,
      sizeChanged: d.sizes.base.height !== d.sizes.head.height || d.sizes.base.width !== d.sizes.head.width,
    });
    r.status = d.changed === 0 && !r.sizeChanged ? 'unchanged' : (r.percent >= threshold || r.sizeChanged ? 'changed' : 'minor');
    if (bad(cb.httpStatus) !== bad(ch.httpStatus)) r.status = 'changed';
    await compose(browser, dir, r, d);
    r.files = Object.fromEntries(['base', 'head', 'diff', 'compare'].map((k) => [k, `${rel}/${k}.png`]));
  } catch (e) {
    r.error = e.message.split('\n')[0];
    r.status = 'error';
  }
  done++;
  const pct = r.percent === null ? '' : ` ${r.percent.toFixed(2)}%`;
  console.log(`  [${done}/${jobs.length}] ${r.page} @ ${r.width}px → ${r.status}${pct}${r.error ? ` (${r.error})` : ''}`);
  return r;
});
await browser.close();

// --------------------------------------------------------------- reports
const totals = { pairs: results.length };
for (const s of ['changed', 'minor', 'unchanged', 'error']) totals[s] = results.filter((r) => r.status === s).length;

const summary = {
  tool: 'knack/pr-visual-diff',
  createdAt: new Date().toISOString(),
  base: { target: targets.base.raw, label: labels.base },
  head: { target: targets.head.raw, label: labels.head },
  options: { pages, widths, height, scale, fullPage, threshold, pixelThreshold, masks, hides, waitFor, freezeTime },
  totals,
  results,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

const img = (rel) => (imageBase ? imageBase.replace(/\/$/, '') + '/' + rel : rel);
const fmtPct = (r) => (r.percent === null ? '–' : r.percent === 0 ? '0%' : `${r.percent < 0.01 ? '<0.01' : r.percent.toFixed(2)}%`);
const noteOf = (r) => [
  r.sizeChanged ? `size ${r.base.width}×${r.base.height} → ${r.head.width}×${r.head.height}` : '',
  r.regions.length ? `${r.regions.length} region${r.regions.length > 1 ? 's' : ''}` : '',
  r.shift ? shiftText(r.shift) : '',
  r.error || '',
  ...r.notes.filter((n) => /HTTP|console errors|kept changing/.test(n)).map((n) => n.replace(/^(base|head): (?=HTTP)/, '')),
].filter(Boolean).join('; ').replace(/\|/g, '\\|');
const shiftText = (sh) => `content below y≈${sh.fromY}px shifted ${sh.dy > 0 ? 'down' : 'up'} ${Math.abs(sh.dy)}px`;
const statusCell = (r) => (r.status === 'changed' ? '**changed**' : r.status === 'error' ? '**error**' : r.status);

const md = [];
md.push('## Visual changes', '');
md.push(`Captured ${pages.length} page${pages.length > 1 ? 's' : ''} at ${widths.join(' / ')}px${fullPage ? ' (full page)' : ''}: `
  + `**${totals.changed} changed**, ${totals.minor} minor, ${totals.unchanged} unchanged${totals.error ? `, ${totals.error} error` : ''}. `
  + `Base: ${labels.base} · Head: ${labels.head}.`, '');
md.push('| Page | Width | Result | Pixels changed | Notes |', '|---|---:|---|---:|---|');
for (const r of results) md.push(`| \`${r.page}\` | ${r.width}px | ${statusCell(r)} | ${fmtPct(r)} | ${noteOf(r)} |`);
md.push('');
const shown = results.filter((r) => r.status === 'changed');
for (const r of shown) {
  md.push(`### \`${r.page}\` at ${r.width}px (${fmtPct(r)} changed)`, '');
  md.push(`![${r.page} at ${r.width}px: base, head and diff](${img(r.files.compare)})`, '');
}
const quiet = results.filter((r) => r.status === 'minor' && r.files.compare);
if (quiet.length) {
  md.push(`<details><summary>Minor differences (${quiet.length}, under ${threshold}% of pixels)</summary>`, '');
  for (const r of quiet) md.push(`**\`${r.page}\` at ${r.width}px** (${fmtPct(r)})`, '', `![${r.page} at ${r.width}px](${img(r.files.compare)})`, '');
  md.push('</details>', '');
}
md.push(`<sub>Generated by Knack pr-visual-diff. Masked: ${masks.length ? masks.map((m) => `\`${m}\``).join(', ') : 'none'}.</sub>`, '');
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n'));

const secs = ((Date.now() - started) / 1000).toFixed(1);
ok(`${totals.changed} changed · ${totals.minor} minor · ${totals.unchanged} unchanged${totals.error ? ` · ${totals.error} error` : ''} (${secs}s)`);
console.log(`  summary: ${path.join(outDir, 'summary.md')}`);
const review = results.filter((r) => (r.status === 'changed' || r.status === 'minor') && r.files.compare);
if (review.length) {
  console.log('  Look at these compare images:');
  review.forEach((r) => console.log(`    ${path.join(outDir, r.files.compare)}`));
}
const unstable = results.filter((r) => r.stable && (!r.stable.base || !r.stable.head));
if (unstable.length) warn(`${unstable.length} pair(s) never settled. Diffs there may be noise; consider --mask, --freeze-time or --wait-for. See references/stabilization.md`);
const errs = results.filter((r) => r.status === 'error');
if (errs.length) warn(`${errs.length} pair(s) failed: ${errs.map((r) => `${r.page}@${r.width}: ${r.error}`).join('; ')}`);
if (opts['fail-on-change'] && totals.changed) process.exitCode = 2;
else if (errs.length === results.length) process.exitCode = 1;
