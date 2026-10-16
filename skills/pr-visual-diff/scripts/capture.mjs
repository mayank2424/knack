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
 * Determinism (on by default): a virtual clock (Date, timers and requestAnimationFrame only
 * advance by fixed steps, identically on both sides), seeded Math.random, media that never
 * plays, CSS animations/transitions off, GIFs and SMIL frozen, fonts/images/background
 * images/aria-busy waited for. Unchanged pages diff at exactly 0 pixels.
 *
 * Options:
 *   --pages <list>          Comma-separated paths (default: /). Repeatable.
 *   --widths <list>         Viewport widths in CSS px (default: 375,1280)
 *   --height <px>           Viewport height (default: 900)
 *   --full-page             Capture the whole scrollable page, not just the first viewport
 *   --mask <selectors>      Paint over dynamic regions on both sides (e.g. ".timestamp,.avatar").
 *                           Elements with data-visual-test="blackout" are always masked.
 *   --hide <selectors>      visibility:hidden on these elements before capture
 *   --css <file|css>        Extra CSS injected on both sides
 *   --wait-for <x>          networkidle (default) | load | <css selector> | <milliseconds of JS time>
 *   --settle <ms>           JS time (virtual clock) to let pass after load (default 2000)
 *   --freeze-time <iso>     Clock start (default: today 12:00 UTC). --no-freeze-time = real clock
 *   --color-scheme <s>      light (default) | dark
 *   --storage-state <file>  Playwright storageState JSON (cookies + localStorage) for logged-in pages.
 *                           Have the user create it: npx playwright codegen --save-storage=auth.json <url>
 *   --threshold <pct>       Changed-pixel % at/above which a pair is "changed" (default 0.1)
 *   --min-region <px>       A single changed cluster this big (CSS px²) also makes it "changed",
 *                           so a reworded label counts even when it is <0.1% (default 40)
 *   --pixel-threshold <n>   pixelmatch per-pixel colour tolerance 0..1 (default 0.1, lower = stricter).
 *                           Differences below it are still reported as "faint" (amber).
 *   --include-aa            Count anti-aliased pixels as changes (default: ignored)
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
 * Diff colours: red = changed, blue wash = content that only moved (row alignment detects
 * "everything below y moved down 70px"), amber = faint change. Removed and added blocks are
 * reported as such.
 *
 * Output: <out>/summary.md, <out>/summary.json and per pair
 *   <out>/pages/<page-slug>/<width>/{base,head,diff,compare}.png
 *   plus focus.png (close-ups of changed regions, base vs head, up to 2x) for changed/minor pairs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs, list, printHelp, log, ok, warn, die, loadChromium, launchBrowser, loadPngLibs } from './lib.mjs';

const opts = parseArgs(process.argv.slice(2), {
  values: ['base', 'head', 'pages', 'widths', 'height', 'mask', 'hide', 'css', 'wait-for', 'color-scheme', 'storage-state', 'threshold',
    'pixel-threshold', 'scale', 'settle', 'min-region', 'label-base', 'label-head', 'image-base-url', 'out', 'concurrency', 'timeout'],
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
const includeAA = !!opts['include-aa'];
const minRegion = +(one(opts['min-region']) ?? 40);
const timeout = +(one(opts.timeout) ?? 45000);
const concurrency = Math.max(1, +(one(opts.concurrency) ?? 3));
const waitFor = one(opts['wait-for']) ?? 'networkidle';
const masks = list(opts.mask);
const hides = list(opts.hide);
const fullPage = !!opts['full-page'];
// Default: today at 12:00 UTC (same for both sides, realistic year in footers).
const today = new Date(); today.setUTCHours(12, 0, 0, 0);
const freezeTime = opts['freeze-time'] === false ? null
  : (opts['freeze-time'] === undefined || opts['freeze-time'] === true ? today.toISOString() : one(opts['freeze-time']));
const settleMs = +(one(opts.settle) ?? 2000);
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
[data-visual-test="transparent"] { opacity: 0 !important; }
[data-visual-test="removed"] { display: none !important; }
`;
const DEV_OVERLAY_CSS = `
nextjs-portal, [data-nextjs-toast], [data-nextjs-dev-tools-button], #__next-build-watcher, #__next-prerender-indicator,
vite-error-overlay, astro-dev-toolbar, #webpack-dev-server-client-overlay, #react-refresh-overlay,
nuxt-devtools-frame, #nuxt-devtools-container, #__nuxt_devtools__ { display: none !important; }
`;
const css = STABILIZE_CSS + (opts['dev-overlays'] === false ? '' : DEV_OVERLAY_CSS)
  + (hides.length ? `${hides.join(',\n')} { visibility: hidden !important; }\n` : '') + extraCss;
const maskLocators = [...masks, '[data-visual-test="blackout"]'];

/** Seeded PRNG so Math.random() returns the same sequence on both sides (mulberry32). */
function seedRandom() {
  let s = 0x2f6b9a1d;
  Math.random = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * From the first byte: CSS animations and transitions finish in 1ms. Otherwise they run on
 * wall-clock time during load, and JS listening for animationend/animationiteration (cycling
 * demos, staged intros) would land in a different state on each side. 1ms rather than 0s so
 * transitionend still fires for code that waits on it. Capture-time CSS then sets 0s.
 */
function earlyCss() {
  const css = '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important}';
  const add = () => { const el = document.createElement('style'); el.id = '__pvd_early'; el.textContent = css; (document.head || document.documentElement).appendChild(el); };
  if (document.documentElement) add();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
}

/**
 * Web Animations started from JS (element.animate(), Motion/framer's hardware-accelerated
 * path) run on the document timeline, which Playwright's clock does not control. Pause each
 * one at birth and step it with the virtual clock (window.__pvdTick), finishing it when it
 * reaches its end so `finished` chains continue, in virtual time, identically on both sides.
 */
function virtualAnimations() {
  const anims = new Set();
  const track = (a) => { try { a.pause(); anims.add(a); } catch (_) {} return a; };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) { return track(animate.apply(this, args)); };
  const play = Animation.prototype.play;
  Animation.prototype.play = function (...args) { play.apply(this, args); track(this); };
  window.__pvdTick = (ms) => {
    for (const a of anims) {
      if (a.playState === 'idle' || a.playState === 'finished') { anims.delete(a); continue; }
      try {
        const end = a.effect ? a.effect.getComputedTiming().endTime : 0;
        const t = (a.currentTime || 0) + ms * (a.playbackRate || 1);
        if (Number.isFinite(end) && t >= end) { anims.delete(a); a.finish(); } else a.currentTime = t;
      } catch (_) { anims.delete(a); }
    }
  };
}

/** Media never plays: playback runs on wall-clock time, so frames (and "ended" handlers) would differ. */
function freezeMedia() {
  const stop = (e) => { try { e.target.pause(); } catch (_) {} };
  document.addEventListener('play', stop, true);
  document.addEventListener('playing', stop, true);
  HTMLMediaElement.prototype.play = function play() { try { this.pause(); } catch (_) {} return Promise.resolve(); };
}

/**
 * In-page preparation, run once right before capture (no page timers are used: with the
 * virtual clock paused they would never fire). Returns what still needs waiting on.
 * Mirrors the stabilization plugins of @argos-ci/browser: eager + sync image decoding,
 * spellcheck off, GIFs frozen on their first frame, endless SVG (SMIL) animations paused,
 * videos paused on frame 0, CSS background images preloaded.
 */
function prepareInPage() {
  const w = window;
  w.__pvd = w.__pvd || { bg: [], gifs: 0 };
  for (const img of document.images) {
    if (img.loading !== 'eager') img.loading = 'eager';
    if (img.decoding !== 'sync') img.decoding = 'sync';
  }
  document.querySelectorAll('[contenteditable]:not([contenteditable=false]), input, textarea').forEach((el) => el.setAttribute('spellcheck', 'false'));
  // GIFs: swap in a canvas snapshot of frame 1 (same-origin or CORS-enabled only).
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (img.dataset.pvdGif || !(/\.gif(?:$|[?#])/i.test(src) || /^data:image\/gif/i.test(src) || img.dataset.imageType === 'gif')) continue;
    img.dataset.pvdGif = '1';
    w.__pvd.gifs++;
    const f = new Image();
    f.crossOrigin = 'anonymous';
    f.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = f.naturalWidth; c.height = f.naturalHeight;
        c.getContext('2d').drawImage(f, 0, 0);
        img.src = c.toDataURL('image/png');
        if (img.srcset) img.srcset = '';
      } catch (_) {}
      w.__pvd.gifs--;
    };
    f.onerror = () => { w.__pvd.gifs--; };
    f.src = src;
  }
  // SMIL animations that repeat forever run on their own clock; pause them at t=0.
  document.querySelectorAll('[repeatCount="indefinite"], [repeatDur="indefinite"]').forEach((el) => {
    for (let svg = el.ownerSVGElement; svg; svg = svg.ownerSVGElement) { try { svg.pauseAnimations(); svg.setCurrentTime(0); } catch (_) {} }
  });
  // Videos: stop autoplay and show frame 0 on both sides.
  for (const v of document.querySelectorAll('video')) {
    v.autoplay = false;
    try { v.pause(); } catch (_) {}
    if (v.preload === 'none') v.preload = 'auto';
    if (v.readyState === 0 && v.networkState !== 2) { try { v.load(); } catch (_) {} }
    if (v.currentTime !== 0) { try { v.currentTime = 0; } catch (_) {} }
  }
  // CSS background images have no load event; preload their URLs (bounded sweep).
  const urls = new Set();
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length && i < 6000; i++) {
    for (const pseudo of [null, '::before', '::after']) {
      const bg = getComputedStyle(all[i], pseudo).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const m of bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) if (!m[2].startsWith('data:')) urls.add(m[2]);
    }
  }
  w.__pvd.bg = [...urls].slice(0, 300).map((u) => { const i = new Image(); i.decoding = 'sync'; i.src = u; return i; });
}

/** What is still loading. Empty array = ready. */
function pendingInPage() {
  const out = [];
  const w = window;
  if (document.fonts && document.fonts.status !== 'loaded') out.push('web fonts');
  const imgs = [...document.images].filter((i) => !i.complete);
  if (imgs.length) out.push(`${imgs.length} image(s)`);
  if (w.__pvd && w.__pvd.bg.some((i) => !i.complete)) out.push('background images');
  if (w.__pvd && w.__pvd.gifs > 0) out.push('GIF freezing');
  const vids = [...document.querySelectorAll('video')].filter((v) => v.getClientRects().length && (v.readyState < 2 || v.seeking));
  if (vids.length) out.push(`${vids.length} video(s)`);
  const busy = [...document.querySelectorAll('[aria-busy="true"]')].filter((e) => e.getClientRects().length);
  if (busy.length) out.push('aria-busy elements');
  return out;
}

const STEP = 100; // virtual ms per clock step

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
  // Virtual clock: Date, timers and requestAnimationFrame only advance when we say so, by
  // the same amounts on both sides. Carousels, rotating banners, typewriters and JS-driven
  // animations therefore land on the same frame in base and head.
  const clock = freezeTime ? ctx.clock : null;
  const advance = async (page, ms) => {
    if (!clock) return page.waitForTimeout(Math.min(ms, 5000));
    for (let t = 0; t < ms; t += STEP) {
      const dt = Math.min(STEP, ms - t);
      await clock.runFor(dt);
      await page.evaluate((x) => window.__pvdTick && window.__pvdTick(x), dt).catch(() => {});
      await page.waitForTimeout(20);
    }
  };
  try {
    if (clock) {
      await clock.install({ time: new Date(freezeTime) });
      await clock.pauseAt(new Date(freezeTime));
      await ctx.addInitScript(seedRandom);
    }
    await ctx.addInitScript(freezeMedia);
    if (clock) { await ctx.addInitScript(earlyCss); await ctx.addInitScript(virtualAnimations); }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });

    const resp = await page.goto(url, { waitUntil: 'load', timeout });
    const httpStatus = resp ? resp.status() : null;

    // Let a fixed amount of JS time pass while the network settles in real time.
    let idle = false;
    const idleWait = page.waitForLoadState('networkidle', { timeout: 10000 }).then(() => { idle = true; }, () => {});
    await advance(page, settleMs);
    await idleWait;
    if (!idle) notes.push('network never went idle (10s); captured anyway');
    if (/^\d+$/.test(waitFor)) {
      await advance(page, +waitFor);
    } else if (waitFor !== 'load' && waitFor !== 'networkidle') {
      const loc = page.locator(waitFor).first();
      const until = Date.now() + timeout;
      while (!(await loc.isVisible().catch(() => false))) {
        if (Date.now() > until) throw new Error(`--wait-for selector "${waitFor}" never became visible`);
        await advance(page, STEP * 2);
      }
    }
    await page.addStyleTag({ content: css }).catch(() => notes.push('could not inject stabilization CSS (CSP?)'));
    if (fullPage) {
      // Walk the page so lazy content, intersection observers and scroll reveals fire. JS time
      // stays paused during the walk: whatever an observer starts, it starts at the same virtual
      // instant on both sides, however late the observer fired in real time.
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const step = Math.max(200, Math.round(height * 0.8));
      for (let y = 0; y < total && y < 40000; y += step) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(clock ? 80 : 60);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await advance(page, 1000); // let reveal animations finish
    }
    await page.evaluate(prepareInPage).catch(() => {});
    let pending = [];
    for (const until = Date.now() + 8000; Date.now() < until;) {
      pending = await page.evaluate(pendingInPage).catch(() => []);
      if (!pending.length) break;
      await page.waitForTimeout(150);
    }
    if (pending.length) notes.push(`still loading after 8s: ${pending.join(', ')}`);
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)).catch(() => {});
    if (clock) await clock.runFor(STEP); // flush timers queued by late loads

    const shotOpts = {
      type: 'png', fullPage, animations: 'disabled', caret: 'hide', scale: 'device', timeout,
      mask: maskLocators.map((m) => page.locator(m)), maskColor: '#FF00FF',
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
      if (!stable) notes.push('page kept changing between screenshots (video, GIF, canvas/WebGL, or live data?)');
    }
    return { buf, httpStatus, errors: [...new Set(errors)].slice(0, 5), stable, notes };
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------------ diff
const { PNG, pixelmatch } = await loadPngLibs();
const DIFF_COLOR = [255, 0, 80];
const MOVED_COLOR = [96, 165, 250];
const SUBTLE_COLOR = [245, 165, 36];
const BOX_COLOR = [0, 120, 255];

function checker(out, w, x, y) {
  const i = (y * w + x) * 4, light = ((x + y) >> 3) & 1;
  out[i] = out[i + 1] = light ? 236 : 214; out[i + 2] = light ? 240 : 222; out[i + 3] = 255;
}
function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x >= png.width || y >= png.height) checker(out.data, w, x, y);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/** FNV-1a hash of every pixel row. */
function rowHashes(png) {
  const out = new Uint32Array(png.height), rowBytes = png.width * 4;
  for (let y = 0; y < png.height; y++) {
    let h = 2166136261;
    const o = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) h = Math.imul(h ^ png.data[o + i], 16777619);
    out[y] = h >>> 0;
  }
  return out;
}

/**
 * Align head rows to base rows (patience diff over row hashes): rows that are pixel-identical
 * and in the same order get matched even if they moved up or down. Returns match[j] = base row
 * for head row j, or -1. Off-diagonal runs shorter than MIN_RUN rows are discarded as chance.
 */
function alignRows(ha, hb) {
  const n = ha.length, m = hb.length, match = new Int32Array(m).fill(-1);
  let pre = 0;
  while (pre < n && pre < m && ha[pre] === hb[pre]) { match[pre] = pre; pre++; }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && ha[n - 1 - suf] === hb[m - 1 - suf]) { match[m - 1 - suf] = n - 1 - suf; suf++; }
  const aEnd = n - suf, bEnd = m - suf;
  if (pre < aEnd && pre < bEnd) {
    const ca = new Map(), cb = new Map();
    for (let i = pre; i < aEnd; i++) { const e = ca.get(ha[i]); if (e) e.n++; else ca.set(ha[i], { n: 1, i }); }
    for (let j = pre; j < bEnd; j++) { const e = cb.get(hb[j]); if (e) e.n++; else cb.set(hb[j], { n: 1, i: j }); }
    const pairs = [];
    for (const [h, eb] of cb) { const ea = ca.get(h); if (ea && ea.n === 1 && eb.n === 1) pairs.push([ea.i, eb.i]); }
    pairs.sort((p, q) => p[0] - q[0]);
    // Longest increasing subsequence on head index -> monotone anchors.
    const tails = [], prev = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1; else hi = mid; }
      if (lo > 0) prev[k] = tails[lo - 1];
      tails[lo] = k;
    }
    const anchors = [];
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.push(pairs[k]);
    anchors.reverse();
    let lastI = pre - 1, lastJ = pre - 1;
    for (const [i, j] of anchors) {
      if (i <= lastI || j <= lastJ) continue;
      let bi = i, bj = j;
      while (bi - 1 > lastI && bj - 1 > lastJ && ha[bi - 1] === hb[bj - 1]) { bi--; bj--; }
      let fi = i, fj = j;
      while (fi + 1 < aEnd && fj + 1 < bEnd && ha[fi + 1] === hb[fj + 1]) { fi++; fj++; }
      for (let t = 0; t <= fi - bi; t++) match[bj + t] = bi + t;
      lastI = fi; lastJ = fj;
    }
  }
  // Drop short off-diagonal runs (coincidental identical rows, e.g. borders).
  const MIN_RUN = 6;
  for (let j = 0; j < m;) {
    if (match[j] < 0) { j++; continue; }
    let k = j;
    while (k + 1 < m && match[k + 1] === match[k] + 1) k++;
    if (match[j] !== j && k - j + 1 < MIN_RUN) for (let t = j; t <= k; t++) match[t] = -1;
    j = k + 1;
  }
  return match;
}

/** Group marked pixels into boxes: 8px grid cells, merged when within 24px of each other. */
function regionsOf(mask, w, h) {
  const CELL = 8, REACH = 3;
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) counts[((y / CELL) | 0) * cols + ((x / CELL) | 0)]++;
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
        const nIdx = ny * cols + nx;
        if (counts[nIdx] && !seen[nIdx]) { seen[nIdx] = 1; stack.push(nIdx); }
      }
    }
    boxes.push({
      x: box.x0 * CELL, y: box.y0 * CELL,
      width: Math.min(w, (box.x1 + 1) * CELL) - box.x0 * CELL, height: Math.min(h, (box.y1 + 1) * CELL) - box.y0 * CELL,
      pixels: box.pixels, kind: 'changed',
    });
  }
  return boxes;
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

const isDiff = (d, p) => d[p] === DIFF_COLOR[0] && d[p + 1] === DIFF_COLOR[1] && d[p + 2] === DIFF_COLOR[2];

/**
 * Compare base and head. Besides a plain pixel diff, rows of head that are pixel-identical
 * to rows of base at another height are recognised as "moved" (a taller header pushes the page
 * down) and shown in blue instead of red, so the diff highlights the cause, not the cascade.
 */
function diffPair(baseBuf, headBuf) {
  const a0 = PNG.sync.read(baseBuf), b0 = PNG.sync.read(headBuf);
  const w = Math.max(a0.width, b0.width), h = Math.max(a0.height, b0.height);
  const a = padTo(a0, w, h), b = padTo(b0, w, h);
  const total = w * h;
  const pmOpts = { threshold: pixelThreshold, alpha: 0.12, diffColor: DIFF_COLOR, aaColor: [215, 215, 215], includeAA };

  // 1. Plain diff (head drawn faded underneath).
  const raw = new PNG({ width: w, height: h });
  const rawChanged = pixelmatch(b.data, a.data, raw.data, w, h, pmOpts);

  // 2. Row alignment for moved content.
  const aw = a0.width === w ? a0 : padTo(a0, w, a0.height), bw = b0.width === w ? b0 : padTo(b0, w, b0.height);
  const match = rawChanged ? alignRows(rowHashes(aw), rowHashes(bw)) : null;
  const offset = new Int32Array(h); // head row y shows base row y - offset[y]
  const shifts = [];
  let aligned = false;
  if (match) {
    let off = 0;
    for (let j = 0; j < h; j++) {
      if (j < b0.height && match[j] >= 0) off = j - match[j];
      offset[j] = off;
      if (j < b0.height && match[j] >= 0 && off !== 0) aligned = true;
    }
  }
  let diff = raw, changed = rawChanged, moved = 0;
  const removed = [];
  const addedRegions = [];
  const mask = new Uint8Array(w * h);
  if (aligned) {
    // Base rearranged into head coordinates, then compared again. Unmatched head rows are tried
    // against a few candidate base rows (the offset of the matched rows above, ±1px, and the one below if close),
    // because sub-pixel layout often moves neighbouring elements by 70 vs 71px. A pixel counts
    // as changed only if it differs under every candidate.
    const offPrev = new Int32Array(h), offNext = new Int32Array(h);
    { let o = 0; for (let j = 0; j < h; j++) { if (j < b0.height && match[j] >= 0) o = j - match[j]; offPrev[j] = o; } }
    { let o = offPrev[h - 1]; for (let j = h - 1; j >= 0; j--) { if (j < b0.height && match[j] >= 0) o = j - match[j]; offNext[j] = o; } }
    // Only near offsets: trying a far one would let removed content "match" plain background.
    const candidates = (j) => [...new Set([offPrev[j], offPrev[j] + 1, offPrev[j] - 1,
      ...(Math.abs(offNext[j] - offPrev[j]) <= 2 * scale ? [offNext[j], offNext[j] + 1, offNext[j] - 1] : [])])];
    // Pure insertions: unmatched head rows with no base rows left between their matched
    // neighbours. Compare them against plain background (their row's edge colour) instead of
    // whatever base content happens to sit at that height, so new content shows without ghosts.
    const inserted = new Uint8Array(h);
    const added = [];
    for (let j = 0; j < b0.height;) {
      if (match[j] >= 0) { j++; continue; }
      let k = j;
      while (k + 1 < b0.height && match[k + 1] < 0) k++;
      const bStart = j > 0 && match[j - 1] >= 0 ? match[j - 1] + 1 : 0;
      const bEnd = k + 1 < b0.height ? match[k + 1] - 1 : a0.height - 1;
      if (j > 0 && bEnd < bStart && k - j + 1 > 2 * scale) {
        inserted.fill(1, j, k + 1);
        added.push({ j0: j, j1: k });
      }
      j = k + 1;
    }
    const used = new Uint8Array(a0.height);
    let real = null;
    const realMask = new Uint8Array(w * h);
    const ba = new PNG({ width: w, height: h });
    for (let pass = 0; pass < 6; pass++) {
      let anyNew = false;
      for (let j = 0; j < h; j++) {
        let src;
        if (inserted[j]) { const o = j * w * 4; for (let x = 0; x < w; x++) bw.data.copy(ba.data, o + x * 4, o, o + 4); continue; }
        if (j < b0.height && match[j] >= 0) src = match[j];
        else { const c = candidates(j); if (pass < c.length) anyNew = true; src = j - c[Math.min(pass, c.length - 1)]; }
        if (src >= 0 && src < a0.height) { aw.data.copy(ba.data, j * w * 4, src * w * 4, (src + 1) * w * 4); if (pass === 0) used[src] = 1; }
        else for (let x = 0; x < w; x++) checker(ba.data, w, x, j);
      }
      if (pass > 0 && !anyNew) break;
      const out = new PNG({ width: w, height: h });
      pixelmatch(b.data, ba.data, out.data, w, h, pmOpts);
      if (!real) { real = out; for (let q = 0; q < w * h; q++) realMask[q] = isDiff(out.data, q * 4) ? 1 : 0; }
      else for (let q = 0; q < w * h; q++) if (realMask[q] && !isDiff(out.data, q * 4)) realMask[q] = 0;
    }
    for (const ad of added) {
      let x0 = w, x1 = -1, px = 0;
      for (let y = ad.j0; y <= ad.j1; y++) {
        const o = y * w * 4;
        for (let x = 0; x < w; x++) {
          const p = o + x * 4;
          if (bw.data[p] === bw.data[o] && bw.data[p + 1] === bw.data[o + 1] && bw.data[p + 2] === bw.data[o + 2]) continue;
          px++; if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (!realMask[y * w + x]) { realMask[y * w + x] = 1; real.data[p] = DIFF_COLOR[0]; real.data[p + 1] = DIFF_COLOR[1]; real.data[p + 2] = DIFF_COLOR[2]; }
        }
      }
      if (px) addedRegions.push({ x: x0, y: ad.j0, width: x1 - x0 + 1, height: ad.j1 - ad.j0 + 1, pixels: px, kind: 'added' });
    }
    // Paint: red = changed; rows that moved get a light blue wash over the faded head (no
    // doubled "ghost" text from comparing content against its old position).
    changed = 0;
    for (let j = 0; j < h; j++) {
      const band = j < b0.height && offPrev[j] !== 0;
      for (let x = 0; x < w; x++) {
        const q = j * w + x, p = q * 4;
        if (realMask[q]) { changed++; continue; }
        if (isDiff(raw.data, p)) moved++;
        if (!band && !isDiff(raw.data, p) && !isDiff(real.data, p)) continue;
        const g = 255 + (0.29889531 * b.data[p] + 0.58662247 * b.data[p + 1] + 0.11448223 * b.data[p + 2] - 255) * 0.12;
        const k = band ? 0.3 : 0;
        real.data[p] = g + (MOVED_COLOR[0] - g) * k; real.data[p + 1] = g + (MOVED_COLOR[1] - g) * k; real.data[p + 2] = g + (MOVED_COLOR[2] - g) * k;
      }
    }
    diff = real;
    // Base rows that vanished (not matched, not compared against anything): content removed.
    let headRow = 0;
    const firstHeadFor = new Int32Array(a0.height).fill(-1);
    for (let j = 0; j < b0.height; j++) if (match[j] >= 0) firstHeadFor[match[j]] = j;
    for (let i = 0; i < a0.height;) {
      if (firstHeadFor[i] >= 0) { headRow = firstHeadFor[i] + 1; i++; continue; }
      if (used[i]) { i++; continue; }
      let k = i;
      while (k + 1 < a0.height && !used[k + 1] && firstHeadFor[k + 1] < 0) k++;
      // Content extent of the removed rows (pixels that differ from the row's first pixel).
      let x0 = w, x1 = -1, px = 0;
      for (let y = i; y <= k; y++) {
        const o = y * w * 4;
        for (let x = 0; x < w; x++) {
          const p = o + x * 4;
          if (aw.data[p] !== aw.data[o] || aw.data[p + 1] !== aw.data[o + 1] || aw.data[p + 2] !== aw.data[o + 2]) { px++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
        }
      }
      // A 1-2px gap between matched runs is sub-pixel jitter, not removed content.
      const jitter = k - i + 1 <= 2 * scale && headRow > 0 && firstHeadFor[k + 1] >= 0;
      // Viewport captures: base rows after the last match were pushed below the fold, not removed.
      let trailing = !fullPage;
      for (let t = k + 1; trailing && t < a0.height; t++) if (firstHeadFor[t] >= 0) trailing = false;
      if (px && !jitter && !trailing) removed.push({ y: Math.min(headRow, h - 1), baseY: i, rows: k - i + 1, x0, x1, pixels: px });
      i = k + 1;
    }
    // Shift segments for the summary: contiguous matched head rows with the same non-zero offset.
    for (let j = 0; j < b0.height;) {
      if (match[j] < 0 || j - match[j] === 0) { j++; continue; }
      const dy = j - match[j];
      let k = j;
      while (k + 1 < b0.height && (match[k + 1] < 0 || Math.abs(k + 1 - match[k + 1] - dy) <= 2 * scale)) k++;
      while (k > j && match[k] < 0) k--;
      if (k - j + 1 >= 24) shifts.push({ fromY: j, toY: k, dy });
      j = k + 1;
    }
  }
  for (let p = 0, q = 0; q < w * h; q++, p += 4) if (isDiff(diff.data, p)) mask[q] = 1;
  // Added blocks are reported as one region each; other red pixels are clustered as usual.
  for (const g of addedRegions) for (let y = g.y; y < g.y + g.height; y++) mask.fill(0, y * w, (y + 1) * w);
  const regions = changed ? [...addedRegions, ...regionsOf(mask, w, h)] : [];
  // Nothing visible, yet the bytes differ: a colour shift below pixelmatch's perceptual threshold
  // (e.g. #6b7280 -> #64748b). Renders are deterministic, so exact differences are real; flag them.
  // Skipped when rows were realigned (sub-pixel jitter there would read as subtle changes).
  let subtle = 0, faintColors = null;
  const pairs = new Map(); // base colour -> head colour, counted, to name the tweak (#6b7280 → #64748b)
  if (!aligned && !a.data.equals(b.data)) {
    const sm = new Uint8Array(w * h), near = new Uint8Array(w * h);
    for (const g of regions) for (let y = Math.max(0, g.y - 4); y < Math.min(h, g.y + g.height + 4); y++) near.fill(1, y * w + Math.max(0, g.x - 4), y * w + Math.min(w, g.x + g.width + 4));
    for (let p = 0, q = 0; q < w * h; q++, p += 4) {
      if (a.data[p] === b.data[p] && a.data[p + 1] === b.data[p + 1] && a.data[p + 2] === b.data[p + 2]) continue;
      if (near[q] || isDiff(diff.data, p) || (diff.data[p] === 215 && diff.data[p + 1] === 215 && diff.data[p + 2] === 215)) continue; // visible change or AA next to one
      sm[q] = 1; subtle++;
      const key = (a.data[p] << 16 | a.data[p + 1] << 8 | a.data[p + 2]) * 16777216 + (b.data[p] << 16 | b.data[p + 1] << 8 | b.data[p + 2]);
      pairs.set(key, (pairs.get(key) || 0) + 1);
      diff.data[p] = SUBTLE_COLOR[0]; diff.data[p + 1] = SUBTLE_COLOR[1]; diff.data[p + 2] = SUBTLE_COLOR[2];
    }
    // Sub-pixel motion leaves a small visible core inside a halo of faint pixels; a real small
    // edit (one changed digit) has no such halo. Record the halo so the status can tell them apart.
    for (const g of regions) {
      if (g.kind !== 'changed') continue;
      let n = 0;
      for (let y = Math.max(0, g.y - 24); y < Math.min(h, g.y + g.height + 24); y++) for (let x = Math.max(0, g.x - 24); x < Math.min(w, g.x + g.width + 24); x++) n += sm[y * w + x];
      g.faintNear = n;
    }
    for (const g of regionsOf(sm, w, h)) regions.push({ ...g, kind: 'subtle' });
    const hex = (n) => '#' + n.toString(16).padStart(6, '0');
    const best = [...pairs].sort((p, q) => q[1] - p[1])[0];
    if (best && best[1] >= 8) faintColors = { base: hex(Math.floor(best[0] / 16777216)), head: hex(best[0] % 16777216), pixels: best[1] };
  }
  for (const r of removed) {
    // Mark removed content as a red bar at the place it used to be.
    const y0 = Math.max(0, r.y - 2), y1 = Math.min(h - 1, r.y + 2);
    for (let y = y0; y <= y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      if (((x >> 3) & 1) === 0) continue;
      const p = (y * w + x) * 4;
      diff.data[p] = DIFF_COLOR[0]; diff.data[p + 1] = DIFF_COLOR[1]; diff.data[p + 2] = DIFF_COLOR[2];
    }
    regions.push({ x: r.x0, y: y0, width: r.x1 - r.x0 + 1, height: y1 - y0 + 1, pixels: r.pixels, kind: 'removed', baseY: r.baseY, removedHeight: r.rows, junction: r.y });
  }
  regions.sort((p, q) => q.pixels - p.pixels);
  const top = regions.slice(0, 12);
  // Where moved content starts, when no changed region explains it: the cause is usually right there.
  const shiftMarks = [];
  for (const sh of shifts) {
    if (top.some((g) => g.y - 48 * scale <= sh.fromY && sh.fromY <= g.y + g.height + 48 * scale)) continue;
    let x0 = w, x1 = -1; // extent of the content that moved (pixels differing before alignment)
    for (let y = sh.fromY; y < Math.min(h, sh.fromY + 60 * scale); y++) for (let x = 0; x < w; x++) {
      if (isDiff(raw.data, (y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    if (x1 >= x0) shiftMarks.push({ x: x0, y: Math.max(0, sh.fromY - 8 * scale), width: x1 - x0 + 1, height: 16 * scale, pixels: 0, kind: 'shift', dy: sh.dy });
  }
  drawBoxes(diff, top);
  const removedPixels = removed.reduce((s, r) => s + r.pixels, 0);
  const cssRound = (v) => Math.round(v / scale);
  return {
    a: a0.width !== w || a0.height !== h ? PNG.sync.write(a) : baseBuf,
    b: b0.width !== w || b0.height !== h ? PNG.sync.write(b) : headBuf,
    aPng: a, bPng: b, offset,
    diff: PNG.sync.write(diff),
    w, h, total, rawChanged, changed: changed + removedPixels, moved, subtle, faintColors,
    shifts: shifts.sort((p, q) => (q.toY - q.fromY) - (p.toY - p.fromY)).slice(0, 5)
      .map((s) => ({ fromY: cssRound(s.fromY), toY: cssRound(s.toY), dy: cssRound(s.dy) })).sort((p, q) => p.fromY - q.fromY),
    sizes: { base: { width: cssRound(a0.width), height: cssRound(a0.height) }, head: { width: cssRound(b0.width), height: cssRound(b0.height) } },
    regionsPx: top, shiftMarks,
    regions: top.map(({ x, y, width, height, pixels, kind, removedHeight }) => ({
      x: cssRound(x), y: cssRound(y), width: cssRound(width), height: cssRound(height), pixels, kind,
      ...(removedHeight ? { removedHeight: cssRound(removedHeight) } : {}),
    })),
  };
}

// --------------------------------------------------------------- compose
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const STATUS_COLOR = { changed: '#e5484d', minor: '#f5a524', unchanged: '#30a46c', error: '#8e8e93' };
const COMPOSE_CSS = `
  body{margin:0;background:#0f1115;color:#e6e6ea;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;display:inline-block}
  header{display:flex;align-items:center;gap:12px;padding:14px 16px 4px;flex-wrap:wrap}
  header code{font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff}
  header .w{color:#9a9aa3}
  .pill{padding:4px 10px;border-radius:999px;font-weight:700;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#0f1115}
  .meta{color:#9a9aa3;font-size:13px;margin-left:auto}
  .key{display:inline-flex;align-items:center;gap:5px;color:#9a9aa3;font-size:12px}
  .key i{width:10px;height:10px;border-radius:2px;display:inline-block}
  main{display:flex;gap:16px;padding:12px 16px 16px;align-items:flex-start}
  figure{margin:0;position:relative}
  figcaption{display:flex;justify-content:space-between;gap:8px;padding:0 2px 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
  figcaption span{color:#9a9aa3;text-transform:none;letter-spacing:0}
  img{display:block;border-radius:6px;outline:1px solid #2a2d35;background:#fff}
  .crop{position:relative}
  .box{position:absolute;border:2px dashed #3b82f6;border-radius:4px;box-shadow:0 0 0 1px rgba(15,17,21,.6)}
  .box.shift{border-color:#f59e0b}
  .box.subtle{border-color:#f5a524;border-style:dotted}
  .rows{display:flex;flex-direction:column;gap:18px;padding:8px 16px 16px}
  .row h3{margin:0 0 8px;font-size:12px;font-weight:600;color:#9a9aa3;letter-spacing:.02em}
  .row .pair{display:flex;gap:16px;align-items:flex-start}
`;
const pctText = (p) => (p === 0 ? '0%' : p < 0.01 ? '<0.01%' : `${p.toFixed(2)}%`);

async function renderHtml(browser, dir, name, html, width) {
  const file = path.join(dir, `.${name}.html`);
  fs.writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width, height: 200 }, deviceScaleFactor: scale });
  try {
    await page.goto(pathToFileURL(file).href);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    const box = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await page.setViewportSize({ width: box.w, height: Math.min(box.h, 16000) });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
  } finally {
    await page.close();
    fs.rmSync(file, { force: true });
  }
}

function headerHtml(r, extra = '') {
  const meta = [r.percent === null ? '' : `${pctText(r.percent)} changed`,
    r.movedPercent ? `${pctText(r.movedPercent)} moved` : '',
    r.faintPixels ? `${r.faintPixels} px faint change` : '',
    r.sizeChanged ? `height ${r.base.height}→${r.head.height}px` : '',
    ...(r.shifts || []).slice(0, 2).map((s) => `y≈${s.fromY}px+ moved ${s.dy > 0 ? 'down' : 'up'} ${Math.abs(s.dy)}px`)].filter(Boolean).join(' · ');
  return `<header><code>${esc(r.page)}</code><span class="w">${r.width}px${fullPage ? ' · full page' : ''}${extra}</span>
  <span class="pill" style="background:${STATUS_COLOR[r.status]}">${r.status}</span><span class="meta">${esc(meta)}</span></header>`;
}

async function compose(browser, dir, r, d) {
  const cssW = d.w / scale, cssH = d.h / scale;
  const f = Math.min(1, 2400 / (3 * cssW + 64), 7000 / cssH);
  const pw = Math.round(cssW * f), ph = Math.round(cssH * f);
  const panel = (src, label, sub) => `<figure><figcaption><b>${esc(label)}</b><span>${sub}</span></figcaption><img src="${src}" width="${pw}" height="${ph}"></figure>`;
  const key = `<span class="key"><i style="background:rgb(${d.subtle ? SUBTLE_COLOR : DIFF_COLOR})"></i>${d.subtle ? 'faint change' : 'changed'}</span>` + (d.moved ? ` <span class="key"><i style="background:rgb(${MOVED_COLOR})"></i>moved</span>` : '');
  const html = `<!doctype html><meta charset="utf-8"><style>${COMPOSE_CSS}</style><body>${headerHtml(r)}
  <main>${panel('base.png', 'Base', esc(labels.base))}${panel('head.png', 'Head', esc(labels.head))}${panel('diff.png', 'Diff', r.regions.length ? `${r.regions.length} region${r.regions.length > 1 ? 's' : ''} &nbsp;${key}` : (d.moved ? key : 'no changes'))}</main></body>`;
  await renderHtml(browser, dir, 'compare', html, 3 * pw + 64);
  return { scale: f };
}

/**
 * Close-ups: the changed regions cropped from base and head at (up to 2x) native size, side by
 * side, so a 1px border or color change is visible even when compare.png is scaled way down.
 */
async function composeFocus(browser, dir, r, d) {
  const marks = [...d.regionsPx.slice(0, 8), ...d.shiftMarks.slice(0, 2)];
  if (!marks.length) return false;
  const PAD = Math.round(32 * scale), MAXW = Math.round(760 * scale), MAXH = Math.round(420 * scale);
  // Expand, merge overlapping, keep the biggest few.
  let boxes = marks.map((b) => ({ x0: Math.max(0, b.x - PAD * 2), y0: Math.max(0, b.y - PAD), x1: Math.min(d.w, b.x + b.width + PAD * 2), y1: Math.min(d.h, b.y + b.height + PAD), regs: [b] }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i], q = boxes[j];
      if (p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1 && Math.max(p.y1, q.y1) - Math.min(p.y0, q.y0) <= MAXH * 1.5) {
        boxes[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1), regs: [...p.regs, ...q.regs] };
        boxes.splice(j, 1); merged = true; break outer;
      }
    }
  }
  const weight = (bx) => bx.regs.reduce((sum, g) => sum + (g.kind === 'shift' ? 1e9 : g.pixels), 0); // shift starts always make the cut
  boxes = boxes.sort((p, q) => weight(q) - weight(p)).slice(0, 4).sort((p, q) => p.y0 - q.y0);
  const crop = (png, x0, y0, cw, ch) => {
    const out = new PNG({ width: cw, height: ch });
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = x0 + x, sy = y0 + y;
      if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) checker(out.data, cw, x, y);
    }
    const bx = Math.max(0, x0), by = Math.max(0, y0);
    const bw = Math.min(png.width, x0 + cw) - bx, bh = Math.min(png.height, y0 + ch) - by;
    if (bw > 0 && bh > 0) PNG.bitblt(png, out, bx, by, bw, bh, bx - x0, by - y0);
    return 'data:image/png;base64,' + PNG.sync.write(out).toString('base64');
  };
  const rows = boxes.map((bx) => {
    const cw = bx.x1 - bx.x0, ch = Math.min(bx.y1 - bx.y0, MAXH * 2);
    const rem = bx.regs.find((g) => g.kind === 'removed');
    // Where this crop sits in base: same rows shifted by the local offset; for removed content,
    // anchor at the junction and make the base crop tall enough to show what was removed.
    const offB = rem ? rem.junction - rem.baseY : (d.offset[Math.min(d.h - 1, bx.y0 + (ch >> 1))] || 0);
    const chB = Math.min(ch + (rem ? rem.removedHeight : 0), MAXH * 3);
    const zoom = Math.min(2, MAXW / cw, (MAXH * 1.6) / Math.max(ch, chB));
    const css = (v) => ((v * zoom) / scale).toFixed(1);
    const boxHtml = (x, y, bw, bh, cls = '') => `<div class="box ${cls}" style="left:${(+css(x) - 4).toFixed(1)}px;top:${(+css(y) - 4).toFixed(1)}px;width:${(+css(bw) + 8).toFixed(1)}px;height:${(+css(bh) + 8).toFixed(1)}px"></div>`;
    const headBoxes = bx.regs.map((g) => boxHtml(g.x - bx.x0, g.y - bx.y0, g.width, g.height, g.kind === 'changed' || g.kind === 'removed' ? '' : g.kind)).join('');
    const baseBoxes = bx.regs.map((g) => (g.kind === 'removed'
      ? boxHtml(g.x - bx.x0, g.baseY - (bx.y0 - offB), g.width, g.removedHeight)
      : boxHtml(g.x - bx.x0, g.y - bx.y0, g.width, g.height, g.kind === 'changed' || g.kind === 'removed' ? '' : g.kind))).join('');
    const label = `x ${Math.round(bx.x0 / scale)}–${Math.round(bx.x1 / scale)}, y ${Math.round(bx.y0 / scale)}–${Math.round((bx.y0 + ch) / scale)}`
      + `${offB ? ` (base y ${Math.round((bx.y0 - offB) / scale)})` : ''} · ${zoom >= 1.01 ? `${zoom.toFixed(1)}×` : `${Math.round(zoom * 100)}%`}`
      + (rem ? ` · ${Math.round(rem.removedHeight / scale)}px of content removed` : '')
      + (bx.regs.some((g) => g.kind === 'added') ? ' · new block' : '')
      + (bx.regs.every((g) => g.kind === 'subtle') ? ` · faint change${r.faintColors ? ` (mostly ${r.faintColors.base} → ${r.faintColors.head})` : ' (low contrast)'}` : '')
      + bx.regs.filter((g) => g.kind === 'shift').map((g) => ` · content below moves ${g.dy > 0 ? 'down' : 'up'} ${Math.abs(Math.round(g.dy / scale))}px`).join('');
    const img = (src, hgt) => `<img src="${src}" width="${css(cw)}" height="${css(hgt)}" style="image-rendering:${zoom >= 1.5 ? 'pixelated' : 'auto'}">`;
    return `<div class="row"><h3>${esc(label)}</h3><div class="pair">
      <figure><figcaption><b>Base</b><span>${esc(labels.base)}</span></figcaption><div class="crop">${img(crop(d.aPng, bx.x0, bx.y0 - offB, cw, chB), chB)}${baseBoxes}</div></figure>
      <figure><figcaption><b>Head</b><span>${esc(labels.head)}</span></figcaption><div class="crop">${img(crop(d.bPng, bx.x0, bx.y0, cw, ch), ch)}${headBoxes}</div></figure></div></div>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>${COMPOSE_CSS}</style><body>${headerHtml(r, ' · close-up of changed regions')}<div class="rows">${rows}</div></body>`;
  await renderHtml(browser, dir, 'focus', html, 1000);
  return true;
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
  const r = { page, width, status: 'error', percent: null, movedPercent: 0, changedPixels: null, movedPixels: 0, totalPixels: null, sizeChanged: false, regions: [], shifts: [], shift: null, notes: [], files: {} };
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
    const errorRoute = /(^|\/)(404|500|not-found|_error)(\.html)?\/?$/.test(page.replace(/[?#].*$/, ''));
    if (bad(cb.httpStatus) && bad(ch.httpStatus) && !errorRoute) throw new Error(`HTTP ${cb.httpStatus} on base and ${ch.httpStatus} on head; check the page path`);
    if (bad(cb.httpStatus) && !errorRoute) r.notes.push(`new page? base returned HTTP ${cb.httpStatus}`);
    if (bad(ch.httpStatus) && !errorRoute) r.notes.push(`REGRESSION? head returned HTTP ${ch.httpStatus} (base ${cb.httpStatus})`);
    r.stable = { base: cb.stable, head: ch.stable };
    const d = diffPair(cb.buf, ch.buf);
    fs.writeFileSync(path.join(dir, 'base.png'), d.a);
    fs.writeFileSync(path.join(dir, 'head.png'), d.b);
    fs.writeFileSync(path.join(dir, 'diff.png'), d.diff);
    Object.assign(r, {
      changedPixels: d.changed, movedPixels: d.moved, totalPixels: d.total,
      percent: (d.changed / d.total) * 100, movedPercent: (d.moved / d.total) * 100,
      base: d.sizes.base, head: d.sizes.head, regions: d.regions, shifts: d.shifts,
      shift: d.shifts.length ? d.shifts.reduce((p, q) => ((q.toY - q.fromY) > (p.toY - p.fromY) ? q : p)) : null,
      sizeChanged: d.sizes.base.height !== d.sizes.head.height || d.sizes.base.width !== d.sizes.head.width,
    });
    // "changed" = enough pixels overall, or one solid cluster (a reworded label is tiny in % but real).
    const px2 = scale * scale;
    const solid = d.regionsPx.some((g) => g.kind !== 'subtle'
      && (g.pixels >= minRegion * px2 || (g.kind === 'changed' && g.pixels >= 16 * px2 && (g.faintNear || 0) < g.pixels)));
    r.faintPixels = d.subtle;
    if (d.faintColors) r.faintColors = d.faintColors;
    if (d.subtle) r.notes.push(`faint change in ${d.subtle} px${d.subtle < minRegion * scale * scale ? ' (too few to matter)' : ''} (below the visible threshold: a colour tweak or a pale element's edge; amber in diff)${d.faintColors ? `; most common: ${d.faintColors.base} → ${d.faintColors.head}` : ''}`);
    // A handful of faint pixels with nothing visible (image resampling, a gradient's dithering)
    // is not worth a reviewer's time; real colour tweaks touch hundreds.
    const faintMatters = d.subtle >= minRegion * px2;
    r.status = d.rawChanged === 0 && !r.sizeChanged ? (faintMatters ? 'minor' : 'unchanged')
      : (r.percent >= threshold || r.movedPercent >= threshold || r.sizeChanged || solid ? 'changed' : 'minor');
    if (bad(cb.httpStatus) !== bad(ch.httpStatus)) r.status = 'changed';
    const kinds = ['base', 'head', 'diff', 'compare'];
    const shown = await compose(browser, dir, r, d);
    r.compareScale = shown.scale;
    if (r.status !== 'unchanged' && await composeFocus(browser, dir, r, d)) kinds.push('focus');
    r.files = Object.fromEntries(kinds.map((k) => [k, `${rel}/${k}.png`]));
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
  options: { pages, widths, height, scale, fullPage, threshold, pixelThreshold, includeAA, masks, hides, waitFor, freezeTime, settleMs },
  totals,
  results,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

const img = (rel) => (imageBase ? imageBase.replace(/\/$/, '') + '/' + rel : rel);
const fmtPct = (r) => (r.percent === null ? '–' : pctText(r.percent));
const shiftText = (sh) => `content from y≈${sh.fromY}px moved ${sh.dy > 0 ? 'down' : 'up'} ${Math.abs(sh.dy)}px`;
const noteOf = (r) => [
  r.sizeChanged ? `height ${r.base.height} → ${r.head.height}px${r.base.width !== r.head.width ? `, width ${r.base.width} → ${r.head.width}px` : ''}` : '',
  r.regions.filter((g) => g.kind === 'changed').length ? `${r.regions.filter((g) => g.kind === 'changed').length} changed region${r.regions.filter((g) => g.kind === 'changed').length > 1 ? 's' : ''}` : '',
  ...r.regions.filter((g) => g.kind === 'added').slice(0, 2).map((g) => `${g.height}px-tall block added at y≈${g.y}px`),
  ...r.regions.filter((g) => g.kind === 'removed').slice(0, 2).map((g) => `${g.removedHeight}px of content removed at y≈${g.y}px`),
  ...(r.shifts || []).slice(0, 2).map(shiftText),
  r.error || '',
  ...r.notes.filter((n) => /HTTP|console errors|kept changing|still loading|faint change/.test(n) && !n.includes('too few to matter')).map((n) => n.replace(/^(base|head): (?=HTTP)/, '')),
].filter(Boolean).join('; ').replace(/\|/g, '\\|');
const statusCell = (r) => (r.status === 'changed' ? '**changed**' : r.status === 'error' ? '**error**' : r.status);
const movedCell = (r) => (r.movedPercent ? ` (+${pctText(r.movedPercent)} moved)` : '');
// GitHub renders PR images at most ~880px wide; tuck the full comparison away when it would be tiny or very tall there.
const tucked = (r) => {
  const cssW = 3 * Math.round(Math.max(r.base.width, r.head.width) * r.compareScale) + 64;
  const shownScale = Math.min(1, 880 / cssW);
  const shownH = Math.max(r.base.height, r.head.height) * r.compareScale * shownScale;
  return !!r.files.focus && (shownScale < 0.6 || shownH > 1800);
};

const md = [];
md.push('## Visual changes', '');
md.push(`Captured ${pages.length} page${pages.length > 1 ? 's' : ''} at ${widths.join(' / ')}px${fullPage ? ' (full page)' : ''}: `
  + `**${totals.changed} changed**, ${totals.minor} minor, ${totals.unchanged} unchanged${totals.error ? `, **${totals.error} error**` : ''}. `
  + `Base: ${labels.base} · Head: ${labels.head}.`, '');
md.push('| Page | Width | Result | Pixels changed | Notes |', '|---|---:|---|---:|---|');
for (const r of results) md.push(`| \`${r.page}\` | ${r.width}px | ${statusCell(r)} | ${fmtPct(r)}${movedCell(r)} | ${noteOf(r)} |`);
md.push('');
const pairMd = (r, level) => {
  const out = [];
  const what = [r.percent || !r.faintPixels ? `${fmtPct(r)} changed` : '', r.movedPercent ? `${pctText(r.movedPercent)} moved` : '',
    r.faintPixels && !r.percent ? `faint change in ${r.faintPixels} px` : ''].filter(Boolean).join(', ');
  out.push(`${level} \`${r.page}\` at ${r.width}px (${what})`, '');
  if (r.files.focus) out.push(`![${r.page} at ${r.width}px: close-up of changed regions, base vs head](${img(r.files.focus)})`, '');
  if (tucked(r)) out.push('<details><summary>Full comparison: base | head | diff</summary>', '', `![${r.page} at ${r.width}px: base, head and diff](${img(r.files.compare)})`, '', '</details>', '');
  else out.push(`![${r.page} at ${r.width}px: base, head and diff](${img(r.files.compare)})`, '');
  return out;
};
for (const r of results.filter((x) => x.status === 'changed')) md.push(...pairMd(r, '###'));
const quiet = results.filter((r) => r.status === 'minor' && r.files.compare);
if (quiet.length) {
  md.push(`<details><summary>Minor differences (${quiet.length}): faint or scattered pixels, under ${threshold}%</summary>`, '');
  for (const r of quiet) md.push(...pairMd(r, '####'));
  md.push('</details>', '');
}
md.push(`<sub>Generated by Knack pr-visual-diff. Red = changed, blue = only moved, amber = faint. Masked: ${masks.length ? masks.map((m) => `\`${m}\``).join(', ') : 'none'}${freezeTime ? '' : '; clock not frozen'}.</sub>`, '');
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n'));

const secs = ((Date.now() - started) / 1000).toFixed(1);
ok(`${totals.changed} changed · ${totals.minor} minor · ${totals.unchanged} unchanged${totals.error ? ` · ${totals.error} error` : ''} (${secs}s)`);
console.log(`  summary: ${path.join(outDir, 'summary.md')}`);
const review = results.filter((r) => (r.status === 'changed' || r.status === 'minor') && r.files.compare);
if (review.length) {
  console.log('  Look at these compare images:');
  review.forEach((r) => console.log(`    ${path.join(outDir, r.files.compare)}${r.files.focus ? '\n    ' + path.join(outDir, r.files.focus) : ''}`));
}
const unstable = results.filter((r) => r.stable && (!r.stable.base || !r.stable.head));
if (unstable.length) warn(`${unstable.length} pair(s) never settled. Diffs there may be noise; consider --mask, --freeze-time or --wait-for. See references/stabilization.md`);
const errs = results.filter((r) => r.status === 'error');
if (errs.length) warn(`${errs.length} pair(s) failed: ${errs.map((r) => `${r.page}@${r.width}: ${r.error}`).join('; ')}`);
if (opts['fail-on-change'] && totals.changed) process.exitCode = 2;
else if (errs.length === results.length) process.exitCode = 1;
