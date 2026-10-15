#!/usr/bin/env node
/**
 * Knack responsive-qa: sweep a page across viewport widths and detect layout bugs.
 *
 *   node sweep.mjs http://localhost:3000
 *   node sweep.mjs http://localhost:3000 --pages /,/pricing,/blog
 *   node sweep.mjs ./index.html --full-page            # local files work too
 *   node sweep.mjs http://localhost:5173 --compare     # diff against the last run
 *
 * Options:
 *   --pages /,/pricing    Extra paths, resolved against the URL (file URLs: relative to its folder)
 *   --widths 320,375,...  Viewport widths (default 320,375,414,768,1024,1280,1440,1920)
 *   --height auto|N       Viewport height; auto picks a typical device height per width
 *   --full-page           Screenshot the whole page instead of the first screen
 *   --max-height N        Cap full-page screenshots at N CSS px (default 8000)
 *   --out dir             Output folder (default ./.knack/responsive-qa)
 *   --json                Print the full report JSON to stdout (logs go to stderr)
 *   --fail-on L           Exit 2 when issues at level L exist: error (default) | warn | none
 *   --compare [file]      Show fixed/new issues vs a previous report.json
 *                         (bare flag = the previous run in --out, kept as report.prev.json)
 *   --ignore sel,sel      CSS selectors to exclude (third-party widgets, etc.).
 *                         Elements with data-responsive-qa="ignore" are always excluded.
 *   --skip check,check    Disable checks, e.g. --skip tap-target-44,long-lines
 *   --wait ms             Extra settle time after load (default 300)
 *   --max-issues N        Max issues per check per viewport (default 20)
 *   --timeout ms          Navigation timeout (default 30000)
 *
 * Checks: horizontal-overflow, hidden-overflow, image-overflow, text-overflow,
 *   text-clipped, overlap, tap-target (24px WCAG 2.2 AA), tap-target-44 (44px AAA/HIG),
 *   tiny-text, long-lines, image-distorted, image-dimensions (info), fixed-cover,
 *   viewport-meta
 *
 * Output: <out>/report.json, <out>/contact-sheet.png (one per page when several),
 *   <out>/shots/<page>/<width>x<height>.png with numbered issue overlays.
 * Exit codes: 0 clean, 1 tool error, 2 issues at or above --fail-on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const VALUE = new Set(['pages', 'widths', 'height', 'out', 'fail-on', 'ignore', 'skip', 'wait', 'max-issues', 'timeout', 'max-height']);
const OPTIONAL_VALUE = new Set(['compare']);
const opts = {};
let input;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a.startsWith('--')) {
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) opts[k] = v;
    else if (VALUE.has(k)) opts[k] = argv[++i];
    else if (OPTIONAL_VALUE.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
    else opts[k] = true;
  } else if (!input) input = a;
  else die(`Unexpected argument: ${a}`);
}

if (opts.help || !input) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, '').trim());
  process.exit(opts.help ? 0 : 1);
}

const JSON_MODE = !!opts.json;
const out = JSON_MODE ? process.stderr : process.stdout; // keep stdout clean for --json
const COLOR = !!out.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = c(31), yellow = c(33), green = c(32), dim = c(2), bold = c(1), magenta = c(35), cyan = c(36);
let outClosed = false; // e.g. piped into `head`: keep working, just stop printing
for (const stream of [process.stdout, process.stderr]) stream.on('error', (e) => { if (e.code === 'EPIPE') outClosed = true; else throw e; });
function log(msg = '') { if (!outClosed) out.write(msg + '\n'); }
function die(msg) { process.stderr.write(`${COLOR ? '\x1b[31m✖\x1b[0m' : '✖'} ${msg}\n`); process.exit(1); }

// ------------------------------------------------------------- options
const widths = String(opts.widths || '320,375,414,768,1024,1280,1440,1920')
  .split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
if (!widths.length) die('--widths needs comma-separated numbers, e.g. --widths 375,768,1280');
const heightOpt = opts.height && opts.height !== 'auto' ? parseInt(opts.height, 10) : 'auto';
if (heightOpt !== 'auto' && !(heightOpt > 0)) die('--height must be "auto" or a number of pixels');
const failOn = String(opts['fail-on'] || 'error');
if (!['error', 'warn', 'none'].includes(failOn)) die('--fail-on must be error, warn or none');
const outDir = path.resolve(typeof opts.out === 'string' ? opts.out : '.knack/responsive-qa');
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const ignoreSel = list(opts.ignore);
const skipChecks = list(opts.skip);
const waitMs = +(opts.wait ?? 300);
const maxIssues = +(opts['max-issues'] ?? 20);
const navTimeout = +(opts.timeout ?? 30000);
const maxHeight = +(opts['max-height'] ?? 8000);
const fullPage = !!opts['full-page'];

const DEVICE_HEIGHTS = { 320: 568, 360: 740, 375: 812, 390: 844, 393: 852, 412: 915, 414: 896, 428: 926, 430: 932, 768: 1024, 810: 1080, 820: 1180, 834: 1194, 1024: 768, 1280: 800, 1366: 768, 1440: 900, 1536: 864, 1680: 1050, 1920: 1080, 2560: 1440 };
function heightFor(w) {
  if (heightOpt !== 'auto') return heightOpt;
  if (DEVICE_HEIGHTS[w]) return DEVICE_HEIGHTS[w];
  if (w <= 480) return Math.round(w * 2.16);
  if (w < 1024) return Math.round(w * 1.33);
  return Math.round(w * 0.5625);
}

// ------------------------------------------------------------- targets
function toUrl(s) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return new URL(s);
  if (fs.existsSync(s)) return pathToFileURL(path.resolve(s));
  if (/^(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+:\d+)/i.test(s)) return new URL('http://' + s);
  die(`Not a URL or an existing file: ${s}\n  Examples: http://localhost:3000  ./dist/index.html  file:///abs/page.html`);
}
const base = toUrl(input);
function resolvePage(p) {
  if (base.protocol === 'file:') {
    if (p === '/' || p === '') return new URL(base.href);
    return new URL(p.replace(/^\/+/, ''), base.href);
  }
  return new URL(p, base.href);
}
const pageUrls = opts.pages ? list(opts.pages).map(resolvePage) : [base];
const usedSlugs = new Set();
const targets = pageUrls.map((u) => {
  let label, slug;
  if (u.protocol === 'file:') { label = path.basename(fileURLToPath(u)); slug = label.replace(/\.[a-z0-9]+$/i, ''); }
  else { label = u.pathname + u.search; slug = u.pathname.replace(/\.html?$/i, '').replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home'; }
  let s = slug.toLowerCase().slice(0, 60) || 'page', n = 2;
  while (usedSlugs.has(s)) s = `${slug}-${n++}`;
  usedSlugs.add(s);
  return { url: u.href, label, slug: s };
});

// ------------------------------------------------------------ playwright
async function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return (await import(mod)).chromium; } catch (_) {}
  }
  die('Playwright is not installed. Run: bash "' + path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.sh') + '"');
}
async function launch(chromium) {
  const tries = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const t of tries) {
    try { return await chromium.launch({ ...t, args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'] }); }
    catch (e) { lastErr = e; }
  }
  die(`Could not launch Chromium. Run: npx playwright install chromium\n  ${lastErr?.message?.split('\n')[0]}`);
}

// ======================================================================
// In-page detector. Runs inside the page via page.evaluate; must be
// self-contained (no closures over Node variables).
// ======================================================================
function detectInPage(cfg) {
  const { vw, vh, touch, mobileText, desktop, pageChecks, ignore, skip, maxPerCheck } = cfg;
  const root = document.documentElement;
  const body = document.body || root;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'OPTION', 'OPTGROUP', 'DATALIST', 'AREA', 'MAP']);
  const INLINE = new Set(['inline', 'contents', 'ruby', 'ruby-base', 'ruby-text']);
  const skipSet = new Set(skip);
  const raw = [];
  const add = (check, severity, el, message, o = {}) => {
    if (skipSet.has(check)) return;
    raw.push({ check, severity, el, message, rect: o.rect || null, details: o.details || {}, magnitude: o.magnitude || 0 });
  };

  // ---- cached accessors
  const csMap = new Map(), rectMap = new Map(), visMap = new Map(), ancMap = new Map();
  const cs = (el) => { let s = csMap.get(el); if (!s) { s = getComputedStyle(el); csMap.set(el, s); } return s; };
  const rect = (el) => { let r = rectMap.get(el); if (!r) { r = el.getBoundingClientRect(); rectMap.set(el, r); } return r; };
  const visible = (el) => {
    if (visMap.has(el)) return visMap.get(el);
    let v = true;
    try { if (el.checkVisibility) v = el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }); } catch (_) {}
    visMap.set(el, v);
    return v;
  };
  let ignoreSelector = '[data-responsive-qa="ignore"],#__knack_rqa';
  const badIgnore = [];
  for (const s of ignore) { try { document.querySelector(s); ignoreSelector += ',' + s; } catch (_) { badIgnore.push(s); } }
  const ignored = (el) => !!el.closest(ignoreSelector);
  const skipEl = (el) => SKIP_TAGS.has(el.tagName) || (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') || ignored(el);
  const hiddenByAria = (el) => !!el.closest('[aria-hidden="true"]');

  const R = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: Math.max(0, r - l), height: Math.max(0, b - t) });
  const inter = (a, b) => R(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
  const union = (rs) => R(Math.min(...rs.map((r) => r.left)), Math.min(...rs.map((r) => r.top)), Math.max(...rs.map((r) => r.right)), Math.max(...rs.map((r) => r.bottom)));
  const area = (r) => (r.width > 0 && r.height > 0 ? r.width * r.height : 0);
  const paddingBox = (el) => { const r = rect(el); return R(r.left + el.clientLeft, r.top + el.clientTop, r.left + el.clientLeft + el.clientWidth, r.top + el.clientTop + el.clientHeight); };
  const isScroll = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
  const isClip = (v) => v === 'hidden' || v === 'clip';
  const blockOf = (el) => { while (el && el !== body && INLINE.has(cs(el).display)) el = el.parentElement; return el || body; };

  // Ancestor context (excludes the element itself, html and body):
  // clip = visible area after ancestor clipping, xBox = nearest ancestor that
  // contains horizontal overflow (scroll/hidden/clip), fixed = inside position:fixed.
  function anc(el) {
    if (ancMap.has(el)) return ancMap.get(el);
    const p = el.parentElement;
    let info;
    if (!p || p === body || p === root) info = { clip: null, xBox: null, xKind: null, fixed: false };
    else {
      const pi = anc(p);
      const s = cs(p);
      info = { ...pi };
      const containPaint = /paint|strict|content/.test(s.contain || '');
      const ox = containPaint && s.overflowX === 'visible' ? 'clip' : s.overflowX;
      const oy = containPaint && s.overflowY === 'visible' ? 'clip' : s.overflowY;
      if (ox !== 'visible' || oy !== 'visible') {
        const b = paddingBox(p);
        const cr = R(ox !== 'visible' ? b.left : -1e9, oy !== 'visible' ? b.top : -1e9, ox !== 'visible' ? b.right : 1e9, oy !== 'visible' ? b.bottom : 1e9);
        info.clip = pi.clip ? inter(pi.clip, cr) : cr;
      }
      if (ox !== 'visible') { info.xBox = p; info.xKind = isScroll(ox) ? 'scroll' : 'clip'; }
      if (s.position === 'fixed') info.fixed = true;
    }
    ancMap.set(el, info);
    return info;
  }
  const clipped = (el, r) => { const a = anc(el); return a.clip ? inter(r, a.clip) : r; };
  // like clipped(), but also clips by the element's own overflow box (ellipsis spans, scrolling <code>)
  const clippedSelf = (el, r) => {
    let v = clipped(el, r);
    const s = cs(el);
    if (!INLINE.has(s.display) && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
      const b = paddingBox(el);
      v = inter(v, R(s.overflowX !== 'visible' ? b.left : -1e9, s.overflowY !== 'visible' ? b.top : -1e9, s.overflowX !== 'visible' ? b.right : 1e9, s.overflowY !== 'visible' ? b.bottom : 1e9));
    }
    return v;
  };
  const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return c === 'transparent' ? 0 : 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const opaque = (el) => { const s = cs(el); return alpha(s.backgroundColor) >= 0.85 || s.backgroundImage !== 'none' || /^(IMG|VIDEO|CANVAS)$/.test(el.tagName); };
  const floating = (el) => { const p = cs(el).position; return p === 'fixed' || p === 'sticky' || anc(el).fixed; };

  // ---- readable, stable selector
  // skip utility classes with special chars (md:flex, w-[600px]) and hashed CSS-in-JS names
  const hashed = (k) => /^(css|sc|jsx|svelte|emotion|chakra|mui|tw)-[\w-]{4,}$/i.test(k) || (/\d/.test(k) && /[A-Z]/.test(k) && /[a-z]/.test(k) && /^_?[a-zA-Z0-9_]{5,12}$/.test(k));
  const okClass = (k) => /^[a-zA-Z_][\w-]*$/.test(k) && !hashed(k);
  const okId = (id) => id && /^[a-zA-Z][\w-]*$/.test(id) && !/\d{4,}|^(radix|headlessui|mui|react)-/i.test(id) && !/^:/.test(id);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
  function segment(el) {
    const tag = el.tagName.toLowerCase();
    if (okId(el.id) && unique('#' + CSS.escape(el.id))) return { s: '#' + CSS.escape(el.id), anchor: true };
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(a);
      if (v) { const s = `[${a}="${v.replace(/"/g, '\\"')}"]`; return { s, anchor: unique(s) }; }
    }
    const classes = [...el.classList].filter(okClass);
    classes.sort((a, b) => document.getElementsByClassName(a).length - document.getElementsByClassName(b).length);
    let s = tag + classes.slice(0, 2).map((k) => '.' + CSS.escape(k)).join('');
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter((x) => x.tagName === el.tagName);
      if (same.length > 1 && [...p.children].filter((x) => { try { return x.matches(s); } catch (_) { return false; } }).length > 1) {
        s += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
    }
    return { s, anchor: false };
  }
  function selector(el) {
    if (!el) return null;
    if (el === body) return 'body';
    if (el === root) return 'html';
    const parts = [];
    let node = el;
    while (node && node !== body && node !== root && parts.length < 5) {
      const seg = segment(node);
      parts.unshift(seg.s);
      if (seg.anchor || unique(parts.join(' > '))) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  const snippet = (el, n = 48) => {
    if (!el) return '';
    let t = (el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || el.textContent || el.getAttribute?.('title') || el.getAttribute?.('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
    if (!t && el.tagName === 'IMG') t = (el.currentSrc || el.src || '').split('/').pop().slice(0, 40);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };
  const q = (s) => (s ? `“${s}”` : '');

  // ---- collect visible elements
  const all = [];
  for (const el of body.querySelectorAll('*')) {
    if (skipEl(el) || !visible(el)) continue;
    const r = rect(el);
    if (r.width < 1 && r.height < 1) continue;
    all.push(el);
  }
  // ---- collect visible text runs
  const texts = [];
  const range = document.createRange();
  const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  for (let n = tw.nextNode(); n && texts.length < 6000; n = tw.nextNode()) {
    const p = n.parentElement;
    if (!p || p instanceof SVGElement || SKIP_TAGS.has(p.tagName) || p.closest('select,textarea,svg') || ignored(p) || !visible(p)) continue;
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5).map((r) => R(r.left, r.top, r.right, r.bottom));
    if (!rects.length) continue;
    const pr = rect(p);
    if (pr.width <= 2 && pr.height <= 2) continue; // sr-only
    texts.push({ node: n, el: p, rects, len: n.nodeValue.replace(/\s+/g, ' ').trim().length });
  }

  // =========================== viewport meta (once per page)
  if (pageChecks) {
    const meta = document.querySelector('meta[name="viewport"]');
    const content = meta?.getAttribute('content') || '';
    if (!/width\s*=\s*device-width/i.test(content)) {
      add('viewport-meta', 'error', null, 'Missing <meta name="viewport" content="width=device-width, initial-scale=1">; phones will render a zoomed-out 980px desktop layout.');
    } else if (/user-scalable\s*=\s*(no|0)\b|maximum-scale\s*=\s*1(\.0+)?\b/i.test(content)) {
      add('viewport-meta', 'warn', null, 'Viewport meta blocks pinch-zoom (user-scalable=no / maximum-scale=1); fails WCAG 1.4.4 Resize Text.');
    }
  }

  // =========================== horizontal overflow
  const docW = Math.max(root.scrollWidth, body.scrollWidth);
  const rootClipX = isClip(cs(root).overflowX) || isClip(cs(body).overflowX);
  const pageScrolls = docW > vw + 1 && !rootClipX;
  const overSet = new Set();
  const overCandidates = body !== root && rect(body).right > vw + 1 ? [body, ...all] : all;
  for (const el of overCandidates) {
    const r = rect(el);
    if (r.right <= vw + 1 || r.width < 3 || r.height < 3) continue;
    if (el !== body) { const a = anc(el); if (a.xBox || a.fixed) continue; }
    if (cs(el).position === 'fixed') continue;
    overSet.add(el);
  }
  const culprits = [];
  for (const el of overSet) {
    const p = el.parentElement;
    const pRight = !p || p === root ? vw : rect(p).right;
    if (!overSet.has(p) || rect(el).right > pRight + 1) culprits.push({ el, r: rect(el) });
  }
  // text runs (long words, nowrap) that stick out past the viewport
  const textOver = new Map();
  for (const t of texts) {
    const maxR = Math.max(...t.rects.map((r) => r.right));
    if (maxR <= vw + 1) continue;
    const a = anc(t.el);
    if (a.xBox || a.fixed || cs(t.el).position === 'fixed' || !INLINE.has(cs(t.el).display) && cs(t.el).overflowX !== 'visible') continue;
    const blk = blockOf(t.el);
    if (blk !== body && cs(blk).overflowX !== 'visible') continue;
    if (overSet.has(t.el) && rect(t.el).right >= maxR - 1) continue; // its element already explains it
    const prev = textOver.get(blk);
    if (!prev || prev.right < maxR) textOver.set(blk, { right: maxR, rects: t.rects.filter((r) => r.right > vw + 1), node: t.node });
  }
  for (const [blk, info] of textOver) culprits.push({ el: blk, r: union(info.rects), text: info });

  function overflowHints(el, r, text) {
    const s = cs(el), h = [];
    const p = el.parentElement, ps = p && p !== root ? cs(p) : null;
    const tag = el.tagName;
    if (text) {
      const longest = (text.node.nodeValue.match(/\S+/g) || []).sort((a, b) => b.length - a.length)[0] || '';
      if (/nowrap|pre/.test(cs(text.node.parentElement).whiteSpace) || /nowrap|pre/.test(s.whiteSpace)) h.push('white-space: nowrap keeps text on one line');
      else if (longest.length > 18) h.push(`long unbroken word ${q(longest.slice(0, 32) + (longest.length > 32 ? '…' : ''))}: add overflow-wrap: anywhere`);
      return h;
    }
    if (/^(IMG|VIDEO|CANVAS|IFRAME|PICTURE|svg|EMBED|OBJECT)$/.test(tag) && s.maxWidth === 'none') h.push(`<${tag.toLowerCase()}> has no max-width: 100%`);
    if (tag === 'IMG' && el.getAttribute('width')) h.push(`width="${el.getAttribute('width')}" attribute`);
    if (tag === 'TABLE') h.push('table wider than the screen: wrap it in an overflow-x: auto container');
    if (tag === 'PRE') h.push('<pre> without overflow-x: auto');
    if (el.style.width) h.push(`inline style width: ${el.style.width}`);
    if (parseFloat(s.minWidth) > vw) h.push(`min-width: ${s.minWidth}`);
    if (/flex/.test(s.display) && s.flexWrap === 'nowrap' && s.flexDirection.startsWith('row') && el.children.length > 1) h.push(`flex row without flex-wrap (${el.children.length} items)`);
    if (/grid/.test(s.display)) h.push(`grid tracks: ${s.gridTemplateColumns}`);
    if (ps && /flex/.test(ps.display) && s.minWidth === 'auto' && r.width > rect(p).width + 1) h.push('flex item cannot shrink below its content (min-width: auto); add min-width: 0');
    if (ps && /grid/.test(ps.display) && r.width > rect(p).width + 1) h.push('grid item wider than its track; use minmax(0, 1fr) / min-width: 0');
    if (Math.abs(r.width - window.innerWidth) < 1 && vw !== window.innerWidth) h.push('width: 100vw (includes the scrollbar)');
    if (s.transform && s.transform !== 'none') h.push('transform moves it off-screen');
    if (parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0) h.push(`negative margin (${s.marginLeft} / ${s.marginRight})`);
    if (s.position === 'absolute' || s.position === 'relative') { if (s.left !== 'auto' && parseFloat(s.left) > 0) h.push(`position: ${s.position}; left: ${s.left}`); }
    if (/nowrap/.test(s.whiteSpace) && el.textContent.trim()) h.push('white-space: nowrap');
    return h;
  }
  culprits.sort((a, b) => b.r.right - a.r.right);
  const reportedCulprits = new Set();
  for (const { el, r, text } of culprits.slice(0, 8)) {
    reportedCulprits.add(el);
    const px = Math.round(r.right - vw);
    const hints = overflowHints(el, r, text);
    const isImg = !text && /^(IMG|PICTURE|VIDEO)$/.test(el.tagName);
    const what = text ? `Text ${q(text.node.nodeValue.trim().slice(0, 30))} runs` : isImg ? `Image is ${Math.round(r.width)}px wide and runs` : `Runs`;
    if (pageScrolls) add(isImg ? 'image-overflow' : 'horizontal-overflow', 'error', el, `${what} ${px}px past the ${vw}px viewport; the page scrolls sideways.`, { rect: r, magnitude: px, details: { overflowPx: px, hints } });
    else if (rootClipX) add('hidden-overflow', 'warn', el, `${what} ${px}px past the viewport and is cut off by overflow-x: hidden on <html>/<body> (hidden, not fixed).`, { rect: r, magnitude: px, details: { overflowPx: px, hints } });
  }
  if (pageScrolls && !culprits.length) {
    add('horizontal-overflow', 'error', null, `Page is ${docW - vw}px wider than the viewport, but no element box sticks out (pseudo-element, box-shadow or transform?).`, { magnitude: docW - vw });
  }

  // =========================== text overflow / clipping
  const overflowByBlock = new Map(), clipByEl = new Map();
  for (const t of texts) {
    if (hiddenByAria(t.el)) continue;
    const blk = blockOf(t.el);
    // nearest clipping/scrolling ancestor-or-self per axis, starting at the text's parent
    let xC = null, yC = null, xScroll = false, yScroll = false;
    for (let n = t.el; n && n !== body && n !== root && !(xC && yC); n = n.parentElement) {
      const s = cs(n);
      if (!xC && s.overflowX !== 'visible') { xC = n; xScroll = isScroll(s.overflowX); }
      if (!yC && s.overflowY !== 'visible') { yC = n; yScroll = isScroll(s.overflowY); }
    }
    const tr = union(t.rects);
    // visible spill beyond the text's own block box
    if (blk && blk !== body && blk !== root && cs(blk).overflowX === 'visible' && cs(blk).overflowY === 'visible') {
      const b = paddingBox(blk);
      const vis = clipped(t.el, tr);
      const dx = Math.max(vis.right - b.right, b.left - vis.left, 0);
      const dy = Math.max(vis.bottom - b.bottom, 0);
      const bigX = dx > 3 && blk.scrollWidth > blk.clientWidth + 1 && !(xC && xScroll && xC.contains(blk));
      // glyphs of tight line-heights (≤ 1.1) poke a few px out of their line box; ignore that ink overflow
      const lineH = Math.min(...t.rects.map((r) => r.height));
      const bigY = dy > Math.max(3, lineH * 0.3) && blk.scrollHeight > blk.clientHeight + 1 && !(yC && yScroll && yC.contains(blk));
      if ((bigX || bigY) && area(vis) > 0) {
        const prev = overflowByBlock.get(blk) || { dx: 0, dy: 0, rects: [], node: t.node };
        prev.dx = Math.max(prev.dx, bigX ? dx : 0); prev.dy = Math.max(prev.dy, bigY ? dy : 0); prev.rects.push(...t.rects);
        overflowByBlock.set(blk, prev);
      }
    }
    // partially clipped text (hidden overflow, no ellipsis / line-clamp)
    for (const [axis, C, scroll] of [['x', xC, xScroll], ['y', yC, yScroll]]) {
      if (!C || scroll) continue;
      const s = cs(C);
      const b = paddingBox(C);
      if (b.width <= 2 || b.height <= 2) continue; // collapsed / sr-only
      if (axis === 'x' ? C.scrollWidth <= C.clientWidth + 1 : C.scrollHeight <= C.clientHeight + 1) continue; // only ink overflow
      if (axis === 'x' && s.textOverflow === 'ellipsis') continue;
      if (axis === 'y' && ((s.webkitLineClamp && s.webkitLineClamp !== 'none') || (s.lineClamp && s.lineClamp !== 'none'))) continue;
      for (const r of t.rects) {
        if (area(inter(r, b)) <= 0) continue; // fully hidden text is intentional (inactive slide etc.)
        const d = axis === 'x' ? Math.max(r.right - b.right, b.left - r.left) : Math.max(r.bottom - b.bottom, b.top - r.top);
        if (d > (axis === 'x' ? 1.5 : Math.max(2.5, r.height * 0.3))) {
          const prev = clipByEl.get(C) || { dx: 0, dy: 0, node: t.node };
          prev[axis === 'x' ? 'dx' : 'dy'] = Math.max(prev[axis === 'x' ? 'dx' : 'dy'], d);
          clipByEl.set(C, prev);
        }
      }
    }
  }
  for (const [blk, o] of overflowByBlock) {
    const longest = (o.node.nodeValue.match(/\S+/g) || []).sort((a, b) => b.length - a.length)[0] || '';
    const s = cs(blk);
    const hints = [];
    if (o.dx && /nowrap|pre/.test(s.whiteSpace)) hints.push('white-space: nowrap');
    else if (o.dx && longest.length > 15) hints.push(`long unbroken word ${q(longest.slice(0, 32))}: add overflow-wrap: anywhere`);
    if (o.dy) hints.push(`height/max-height (${s.height}) is too small for the text: use min-height instead`);
    const dirs = [o.dx ? `${Math.round(o.dx)}px sideways` : '', o.dy ? `${Math.round(o.dy)}px below` : ''].filter(Boolean).join(' and ');
    add('text-overflow', 'error', blk, `Text ${q(o.node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 32))} spills out of its box by ${dirs}.`, { rect: union([rect(blk), ...o.rects]), magnitude: Math.max(o.dx, o.dy), details: { hints } });
  }
  for (const [C, o] of clipByEl) {
    const s = cs(C);
    const hints = [];
    if (o.dx) hints.push(/nowrap/.test(s.whiteSpace) ? 'nowrap + overflow: hidden without text-overflow: ellipsis' : 'fixed width + overflow: hidden');
    if (o.dy) hints.push(`height ${s.height}${s.maxHeight !== 'none' ? ` / max-height ${s.maxHeight}` : ''} cuts the text: use min-height or line-clamp`);
    const dirs = [o.dx ? `${Math.round(o.dx)}px cut off horizontally` : '', o.dy ? `${Math.round(o.dy)}px cut off at the bottom` : ''].filter(Boolean).join(', ');
    add('text-clipped', 'warn', C, `Text ${q(o.node.nodeValue.replace(/\s+/g, ' ').trim().slice(0, 32))} is truncated: ${dirs} (no ellipsis/line-clamp).`, { rect: rect(C), magnitude: Math.max(o.dx, o.dy), details: { hints } });
  }

  // =========================== interactive targets
  const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])';
  const targets = [];
  for (const el of body.querySelectorAll(INTERACTIVE)) {
    if (skipEl(el) || !visible(el) || el.disabled || hiddenByAria(el)) continue;
    if (el.parentElement?.closest(INTERACTIVE)) continue; // nested inside another control
    const r = rect(el);
    if (r.width <= 2 || r.height <= 2) continue; // visually hidden (sr-only skip links)
    if (area(clipped(el, r)) <= 0) continue;
    targets.push({ el, r, fixed: anc(el).fixed || cs(el).position === 'fixed' });
  }

  // =========================== overlap (text + controls)
  const items = [];
  const targetSet = new Set(targets.map((t) => t.el));
  for (const t of targets) {
    if (t.fixed || t.r.width < 4 || t.r.height < 4) continue;
    // a link wrapped over two lines has a bounding box covering both lines; use its line fragments
    const frags = cs(t.el).display === 'inline' ? [...t.el.getClientRects()].map((r) => R(r.left, r.top, r.right, r.bottom)) : [t.r];
    items.push({ el: t.el, kind: 'control', rects: frags.map((r) => clipped(t.el, r)).filter((r) => area(r) > 0) });
  }
  const textByEl = new Map();
  for (const t of texts) {
    if (hiddenByAria(t.el) || t.el.closest(INTERACTIVE) || anc(t.el).fixed || cs(t.el).position === 'fixed') continue;
    const arr = textByEl.get(t.el) || [];
    for (const r of t.rects) { const v = clippedSelf(t.el, r); if (area(v) > 0) arr.push(v); }
    textByEl.set(t.el, arr);
  }
  for (const [el, rects] of textByEl) if (rects.length) items.push({ el, kind: 'text', rects });
  const entries = [];
  items.forEach((it, i) => it.rects.forEach((r) => entries.push({ i, r })));
  entries.sort((a, b) => a.r.top - b.r.top);
  const pairs = new Map();
  const limit = Math.min(entries.length, 4000);
  for (let a = 0; a < limit; a++) {
    const A = entries[a];
    for (let b = a + 1; b < limit && entries[b].r.top < A.r.bottom; b++) {
      const B = entries[b];
      if (A.i === B.i) continue;
      const x = inter(A.r, B.r);
      if (x.width <= 2 || x.height <= 2) continue;
      const ia = items[A.i], ib = items[B.i];
      if (ia.el.contains(ib.el) || ib.el.contains(ia.el)) continue;
      const ratio = area(x) / Math.min(area(A.r), area(B.r));
      const bothControls = ia.kind === 'control' && ib.kind === 'control';
      if (bothControls ? x.width <= 4 || x.height <= 4 : ratio < 0.1) continue;
      const key = A.i < B.i ? `${A.i}|${B.i}` : `${B.i}|${A.i}`;
      const prev = pairs.get(key);
      if (!prev || prev.ratio < ratio) pairs.set(key, { a: ia, b: ib, ratio, x, ra: A.r, rb: B.r });
    }
  }
  // Verify each geometric overlap against paint order: scroll the spot into view and ask the
  // browser what is stacked there. Skip overlaps hidden behind a third opaque layer, and
  // deliberate full covers (an opaque control sitting completely over a hidden label).
  const sx0 = window.scrollX, sy0 = window.scrollY;
  const verified = [];
  for (const pr of pairs.values()) {
    const cx = (pr.x.left + pr.x.right) / 2 + sx0, cy = (pr.x.top + pr.x.bottom) / 2 + sy0;
    window.scrollTo(Math.max(0, cx - vw / 2), Math.max(0, cy - vh / 2));
    const stack = document.elementsFromPoint(cx - window.scrollX, cy - window.scrollY);
    const idx = (it) => stack.findIndex((e) => e === it.el || it.el.contains(e));
    const ia = idx(pr.a), ib = idx(pr.b);
    if (ia < 0 || ib < 0) continue; // one of them isn't reachable at that spot (covered or inert)
    const [top, under] = ia < ib ? [pr.a, pr.b] : [pr.b, pr.a];
    const occluders = stack.slice(0, Math.min(ia, ib) === ia ? ib : ia).filter((e) => !e.contains(under.el) && !floating(e) && opaque(e));
    // an opaque layer that is not the top item itself (e.g. the panel the top item sits on) hides `under`
    if (occluders.some((e) => e !== top.el && !top.el.contains(e))) continue;
    if (occluders.length) { // the top item itself covers `under`: only a partial cover is visible
      const tr = rect(top.el);
      if (under.rects.every((r) => r.left >= tr.left - 1 && r.right <= tr.right + 1 && r.top >= tr.top - 1 && r.bottom <= tr.bottom + 1)) continue; // fully covered: invisible
    }
    verified.push({ ...pr, a: top, b: under });
  }
  window.scrollTo(sx0, sy0);
  for (const { a, b, ratio, x, ra, rb } of verified) {
    const [top, under] = [a, b];
    const sev = ratio >= 0.25 || (a.kind === 'control' && b.kind === 'control') ? 'error' : 'warn';
    add('overlap', sev, top.el, `${top.kind === 'control' ? 'Control' : 'Text'} ${q(snippet(top.el, 28))} overlaps ${under.kind === 'control' ? 'control' : 'text'} ${q(snippet(under.el, 28))} (${Math.round(x.width)}×${Math.round(x.height)}px).`, { rect: union([ra, rb]), magnitude: ratio * 100, details: { with: selector(under.el), overlapRatio: +ratio.toFixed(2) } });
  }

  // =========================== tap targets (touch widths)
  if (touch) {
    const effective = targets.map((t) => {
      let r = t.r;
      if (t.el.tagName === 'INPUT' && /checkbox|radio/.test(t.el.type) && t.el.labels?.length) {
        const lr = t.el.labels[0].getBoundingClientRect();
        if (lr.width * lr.height > r.width * r.height) r = lr;
      }
      return { ...t, r };
    });
    const square = (r) => { const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2; return R(cx - 12, cy - 12, cx + 12, cy + 12); };
    for (const t of effective) {
      const { el, r } = t;
      if (r.width >= 44 && r.height >= 44) continue;
      const s = cs(el);
      // WCAG inline exception: links inside a sentence
      if (s.display === 'inline') {
        const blk = blockOf(el);
        let prose = 0;
        const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n && prose <= 10; n = w.nextNode()) if (!n.parentElement.closest(INTERACTIVE)) prose += n.nodeValue.replace(/\s+/g, '').length;
        if (prose > 10) continue; // link sits inside a sentence
      }
      const size = `${Math.round(r.width)}×${Math.round(r.height)}px`;
      const name = q(snippet(el, 28)) || `<${el.tagName.toLowerCase()}>`;
      if (r.width < 24 || r.height < 24) {
        const mine = square(r);
        const crowded = effective.some((o) => o !== t && (area(inter(mine, o.r)) > 0 || ((o.r.width < 24 || o.r.height < 24) && area(inter(mine, square(o.r))) > 0)));
        if (crowded) { add('tap-target', 'error', el, `Tap target ${name} is ${size}, below the 24×24px WCAG 2.2 AA minimum, and crowded by neighbours.`, { rect: r, magnitude: 24 - Math.min(r.width, r.height), details: { width: Math.round(r.width), height: Math.round(r.height), level: 'AA' } }); continue; }
      }
      add('tap-target-44', 'warn', el, `Tap target ${name} is ${size}; 44×44px is the comfortable touch size (WCAG 2.5.5 AAA / Apple HIG).`, { rect: r, magnitude: 44 - Math.min(r.width, r.height), details: { width: Math.round(r.width), height: Math.round(r.height), level: 'AAA' } });
    }
  }

  // =========================== tiny text (mobile) & long lines (desktop)
  const byBlock = new Map();
  for (const t of texts) {
    if (hiddenByAria(t.el)) continue;
    const blk = blockOf(t.el);
    const g = byBlock.get(blk) || { runs: [], minFont: Infinity, minEl: null };
    g.runs.push(t);
    const fs = parseFloat(cs(t.el).fontSize);
    if (fs < g.minFont && t.len >= 2) { g.minFont = fs; g.minEl = t.el; }
    byBlock.set(blk, g);
  }
  if (mobileText) {
    for (const [blk, g] of byBlock) {
      if (g.minFont >= 12 || !g.minEl) continue;
      add('tiny-text', 'warn', blk, `Text ${q(snippet(g.minEl, 30))} is ${+g.minFont.toFixed(1)}px; under 12px is hard to read on phones (use ≥ 14px for body copy).`, { rect: union(g.runs.flatMap((t) => t.rects)), magnitude: 12 - g.minFont, details: { fontSize: g.minFont } });
    }
  }
  if (desktop) {
    for (const [blk, g] of byBlock) {
      if (blk === body || /^(PRE|CODE|TEXTAREA|TD|TH)$/.test(blk.tagName) || /pre|nowrap/.test(cs(blk).whiteSpace)) continue;
      const chars = g.runs.reduce((n, t) => n + t.len, 0);
      if (chars < 160) continue;
      const lines = new Map();
      let totalW = 0;
      for (const t of g.runs) for (const r of t.rects) { const k = Math.round(r.top / 4); lines.set(k, (lines.get(k) || 0) + r.width); totalW += r.width; }
      if (lines.size < 2 || !totalW) continue;
      const cpl = Math.round(Math.max(...lines.values()) / (totalW / chars));
      if (cpl > 90) add('long-lines', 'warn', blk, `Lines run ~${cpl} characters; aim for 45–75 (e.g. max-width: 65ch).`, { rect: union(g.runs.flatMap((t) => t.rects)), magnitude: cpl, details: { charsPerLine: cpl } });
    }
  }

  // =========================== images
  for (const img of document.images) {
    if (skipEl(img) || !visible(img)) continue;
    const r = rect(img);
    if (r.width < 2 || r.height < 2) continue;
    const src = img.currentSrc || img.src || '';
    const s = cs(img);
    if (r.width > vw + 1 && !reportedCulprits.has(img)) {
      const a = anc(img);
      if (a.xKind !== 'scroll' && !a.fixed) {
        const where = a.xBox ? `cropped by overflow on ${selector(a.xBox)}` : 'it runs off-screen';
        add('image-overflow', 'error', img, `Image is ${Math.round(r.width)}px wide, wider than the ${vw}px viewport; ${where}.`, { rect: r, magnitude: r.width - vw, details: { hints: [s.maxWidth === 'none' ? 'no max-width: 100%' : `max-width: ${s.maxWidth}`, img.getAttribute('width') ? `width="${img.getAttribute('width')}" attribute` : `width: ${Math.round(r.width)}px`].filter(Boolean) } });
      }
    }
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && !/\.svg(\?|#|$)|^data:image\/svg/i.test(src) && s.objectFit === 'fill') {
      const bw = parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth) + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
      const bh = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
      const cw = r.width - bw, ch = r.height - bh;
      const natural = img.naturalWidth / img.naturalHeight, shown = cw / ch;
      const off = Math.abs(shown - natural) / natural;
      if (off > 0.05 && Math.abs(cw - ch * natural) >= 2) {
        add('image-distorted', 'error', img, `Image is ${shown > natural ? 'stretched' : 'squashed'}: shown at ${Math.round(cw)}×${Math.round(ch)} (${shown.toFixed(2)}:1) but its natural ratio is ${natural.toFixed(2)}:1. Use object-fit: cover or height: auto.`, { rect: r, magnitude: off * 100, details: { natural: [img.naturalWidth, img.naturalHeight], rendered: [Math.round(cw), Math.round(ch)] } });
      }
    }
    if (pageChecks && s.aspectRatio === 'auto' && !(img.getAttribute('width') && img.getAttribute('height'))) {
      add('image-dimensions', 'info', img, `Image ${q(snippet(img, 30))} has no width/height attributes or aspect-ratio; it shifts the layout (CLS) while loading.`, { rect: r });
    }
  }

  // =========================== fixed / sticky elements covering the screen
  if (touch) {
    const screen = R(0, 0, vw, vh);
    let total = 0;
    const flagged = [];
    for (const el of all) {
      const s = cs(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (anc(el).fixed) continue;
      if (s.position === 'sticky' && s.top === 'auto' && s.bottom === 'auto') continue;
      const transparent = /rgba\(.*,\s*0\)|transparent/.test(s.backgroundColor) && s.backgroundImage === 'none';
      if (transparent && s.pointerEvents === 'none') continue;
      const r = rect(el);
      const cover = s.position === 'fixed' ? area(inter(r, screen)) : Math.min(r.width, vw) * Math.min(r.height, vh);
      const ratio = cover / (vw * vh);
      if (ratio < 0.02) continue;
      total += ratio;
      if (ratio > 0.3) { flagged.push(el); add('fixed-cover', ratio > 0.5 ? 'error' : 'warn', el, `${s.position === 'fixed' ? 'Fixed' : 'Sticky'} element ${q(snippet(el, 28))} covers ${Math.round(ratio * 100)}% of the ${vw}×${vh} screen.`, { rect: s.position === 'fixed' ? inter(r, screen) : r, magnitude: ratio * 100, details: { coverage: +ratio.toFixed(2) } }); }
    }
    if (!flagged.length && total > 0.4) add('fixed-cover', 'warn', null, `Fixed/sticky bars together cover ${Math.round(total * 100)}% of the ${vw}×${vh} screen.`, { magnitude: total * 100 });
  }

  // =========================== serialise
  const sx = window.scrollX, sy = window.scrollY;
  const SEV = { error: 0, warn: 1, info: 2 };
  const grouped = new Map();
  for (const i of raw) { const g = grouped.get(i.check) || []; g.push(i); grouped.set(i.check, g); }
  const truncated = {};
  const final = [];
  for (const [check, arr] of grouped) {
    arr.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.magnitude - a.magnitude);
    if (arr.length > maxPerCheck) truncated[check] = arr.length - maxPerCheck;
    final.push(...arr.slice(0, maxPerCheck));
  }
  const issues = final.map((i) => {
    const r = i.rect || (i.el ? rect(i.el) : null);
    const el = i.el;
    return {
      check: i.check,
      severity: i.severity,
      selector: el ? selector(el) : null,
      message: i.message,
      box: r ? { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) } : null,
      element: el ? { tag: el.tagName.toLowerCase(), id: el.id || undefined, classes: [...el.classList].slice(0, 12), text: snippet(el, 60) || undefined } : undefined,
      details: i.details,
    };
  });
  issues.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.box ? a.box.y : -1) - (b.box ? b.box.y : -1));
  return {
    issues,
    truncated,
    badIgnore,
    doc: { scrollWidth: docW, clientWidth: vw, scrollHeight: Math.max(root.scrollHeight, body.scrollHeight), overflowX: Math.max(0, docW - vw), rootClipsX: rootClipX },
    title: document.title,
  };
}

// In-page overlay: numbered boxes drawn in a shadow root so page CSS can't touch them.
function drawOverlay({ issues, vw, docH }) {
  document.getElementById('__knack_rqa')?.remove();
  const host = document.createElement('div');
  host.id = '__knack_rqa';
  host.style.cssText = `all:initial;position:absolute;left:0;top:0;width:${vw}px;height:${docH}px;overflow:hidden;pointer-events:none;z-index:2147483647;`;
  const sh = host.attachShadow({ mode: 'open' });
  const COL = { error: '#ff2d55', warn: '#ff9f0a', info: '#64d2ff' };
  let html = `<style>
    .b{position:absolute;box-sizing:border-box;border:2px solid var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);border-radius:3px}
    .b.dash{border-style:dashed}
    .l{position:absolute;font:700 11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:var(--c);padding:0 5px;border-radius:8px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.35)}
    .e{position:absolute;right:0;font:700 11px/16px ui-monospace,Menlo,monospace;color:#fff;background:var(--c);padding:0 6px;border-radius:8px 0 0 8px}
  </style>`;
  const placed = [];
  for (const i of issues) {
    if (!i.box) continue;
    const col = COL[i.severity];
    const x0 = Math.max(0, i.box.x), y0 = Math.max(0, i.box.y);
    const x1 = Math.min(vw, i.box.x + Math.max(i.box.w, 4)), y1 = Math.min(docH, i.box.y + Math.max(i.box.h, 4));
    if (x1 <= x0 || y1 <= y0) continue;
    const dash = i.severity !== 'error' ? ' dash' : '';
    html += `<div class="b${dash}" style="--c:${col};left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px"></div>`;
    let lx = Math.min(x0, vw - 34), ly = y0 - 16 >= 0 ? y0 - 16 : y0 + 2;
    while (placed.some((p) => Math.abs(p[0] - lx) < 30 && Math.abs(p[1] - ly) < 16)) lx += 30;
    if (lx > vw - 30) { lx = Math.max(0, x0 - 2); ly += 16; }
    placed.push([lx, ly]);
    html += `<div class="l" style="--c:${col};left:${lx}px;top:${ly}px">${i.n}</div>`;
    if (i.box.x + i.box.w > vw + 1) html += `<div class="e" style="--c:${col};top:${Math.min(docH - 16, y0 + 18)}px">+${Math.round(i.box.x + i.box.w - vw)}px →</div>`;
  }
  sh.innerHTML = html;
  document.documentElement.appendChild(host);
}

// ======================================================================
// Node side
// ======================================================================
const SEV_RANK = { error: 0, warn: 1, info: 2 };
const issueKey = (pageLabel, i, width) => `${pageLabel}|${i.check}|${i.selector || '(page)'}|${width}`;

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // scroll through once so lazy images and reveal-on-scroll content load
  await page.evaluate(async () => {
    const H = innerHeight;
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 40; y += H, i++) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 50));
    }
    scrollTo(0, 0);
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 3000); })));
    if (document.fonts) await document.fonts.ready;
  }).catch(() => {});
  await page.waitForTimeout(waitMs);
}

async function sweepTarget(browser, target) {
  // page-level checks (viewport meta, image dimensions) run once, at the first touch width if any
  const results = [];
  const shotDir = path.join(outDir, 'shots', target.slug);
  fs.mkdirSync(shotDir, { recursive: true });
  const pageCheckWidth = widths.find((w) => w <= 768) ?? widths[0];
  for (const w of widths) {
    const h = heightFor(w);
    const touch = w <= 768;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: touch, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(target.url, { waitUntil: 'load', timeout: navTimeout });
    } catch (e) {
      await ctx.close();
      const hint = /ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(e.message)
        ? `Nothing is listening at ${target.url}. Start the dev server, or find it with: node "${path.join(path.dirname(fileURLToPath(import.meta.url)), 'detect-server.mjs')}"`
        : e.message.split('\n')[0];
      die(`Could not load ${target.url}\n  ${hint}`);
    }
    await settle(page);
    const res = await page.evaluate(detectInPage, {
      vw: await page.evaluate(() => document.documentElement.clientWidth),
      vh: h, touch, mobileText: w < 768, desktop: w >= 1024,
      pageChecks: w === pageCheckWidth,
      ignore: ignoreSel, skip: skipChecks, maxPerCheck: maxIssues,
    });
    if (res.badIgnore.length) log(yellow(`⚠ Ignoring invalid --ignore selector(s): ${res.badIgnore.join(', ')}`));
    res.issues.forEach((i, idx) => { i.n = idx + 1; i.viewport = { width: w, height: h }; });
    const docH = Math.min(res.doc.scrollHeight, fullPage ? maxHeight : h);
    await page.evaluate(drawOverlay, { issues: res.issues, vw: res.doc.clientWidth, docH: res.doc.scrollHeight });
    const file = path.join(shotDir, `${w}x${h}.png`);
    await page.screenshot({ path: file, fullPage, clip: { x: 0, y: 0, width: res.doc.clientWidth, height: docH }, animations: 'disabled', caret: 'hide' });
    await ctx.close();
    const ec = res.issues.filter((i) => i.severity === 'error').length;
    const wc = res.issues.filter((i) => i.severity === 'warn').length;
    log(`  ${String(w).padStart(4)}×${String(h).padEnd(5)} ${ec ? red(`✖ ${ec}`) : green('✓ 0')}  ${wc ? yellow(`⚠ ${wc}`) : dim('⚠ 0')}${res.doc.overflowX && !res.doc.rootClipsX ? red(`  scrolls sideways +${res.doc.overflowX}px`) : ''}`);
    results.push({ page: target.label, url: target.url, viewport: { width: w, height: h }, screenshot: path.relative(process.cwd(), file), doc: res.doc, title: res.title, truncated: res.truncated, pageErrors: errors, issues: res.issues });
  }
  // cross-viewport hint: same culprit width at every viewport usually means a hard-coded width
  const byEl = new Map();
  for (const r of results) for (const i of r.issues) if (/^(horizontal|image|hidden)-overflow$/.test(i.check) && i.selector && i.box) {
    const arr = byEl.get(i.selector) || []; arr.push(i); byEl.set(i.selector, arr);
  }
  for (const arr of byEl.values()) {
    if (arr.length >= 2 && arr.every((i) => Math.abs(i.box.w - arr[0].box.w) <= 1)) {
      for (const i of arr) (i.details.hints ||= []).push(`same ${arr[0].box.w}px width at every failing viewport → hard-coded width or unbreakable content`);
    }
  }
  return results;
}

// ------------------------------------------------------------ contact sheet
async function contactSheet(browser, target, results, file) {
  const tw = (w) => Math.round(150 + w * 0.17);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const totals = { error: 0, warn: 0 };
  results.forEach((r) => r.issues.forEach((i) => { if (totals[i.severity] !== undefined) totals[i.severity]++; }));
  const cols = results.map((r) => {
    const png = fs.readFileSync(path.resolve(r.screenshot)).toString('base64');
    const W = tw(r.viewport.width);
    const scale = W / r.doc.clientWidth;
    const e = r.issues.filter((i) => i.severity === 'error').length, wn = r.issues.filter((i) => i.severity === 'warn').length;
    const shown = r.issues.filter((i) => i.severity !== 'info');
    const listed = shown.slice(0, 14).map((i) => `<li class="${i.severity}"><b>${i.n}</b> ${esc(i.check)} <span>${esc((i.selector || 'page').slice(0, 38))}</span></li>`).join('');
    const more = shown.length > 14 ? `<li class="more">+${shown.length - 14} more in report.json</li>` : '';
    return `<figure style="width:${W}px">
      <figcaption><strong>${r.viewport.width}</strong><em>×${r.viewport.height}</em>
        <span class="pill ${e ? 'error' : 'ok'}">${e ? '✖ ' + e : '✓'}</span>${wn ? `<span class="pill warn">⚠ ${wn}</span>` : ''}
        ${r.doc.overflowX && !r.doc.rootClipsX ? `<span class="pill error">↔ +${r.doc.overflowX}px</span>` : ''}</figcaption>
      <div class="shot" style="max-height:1100px"><img src="data:image/png;base64,${png}" style="width:${W}px;height:auto"/>${(r.doc.scrollHeight * scale > 1100 && fullPage) ? '<div class="fade"></div>' : ''}</div>
      <ol>${listed}${more}</ol>
    </figure>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#0f1013;color:#d9dae0;font:13px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
    header{display:flex;align-items:baseline;gap:16px;padding:20px 24px 4px;flex-wrap:wrap}
    header h1{font-size:16px;margin:0;color:#fff;font-weight:650}header code{color:#9aa0ad;font-size:12px}
    header .tot{margin-left:auto;font-weight:650}.tot .e{color:#ff5c7a}.tot .w{color:#ffb340}.tot .ok{color:#4cd98a}
    main{display:flex;flex-wrap:wrap;gap:22px;padding:16px 24px 24px;max-width:1880px;align-items:flex-start}
    figure{margin:0}figcaption{display:flex;align-items:center;gap:6px;padding-bottom:8px;white-space:nowrap}
    figcaption strong{color:#fff;font-size:15px}figcaption em{font-style:normal;color:#7d8290;margin-right:2px}
    .pill{font:700 11px/18px ui-monospace,Menlo,monospace;padding:0 7px;border-radius:9px;background:#24262d}
    .pill.error{background:#ff2d55;color:#fff}.pill.warn{background:#ff9f0a;color:#1a1200}.pill.ok{background:#1f8f55;color:#fff}
    .shot{position:relative;overflow:hidden;border-radius:6px;outline:1px solid #2b2e36;background:#fff}
    .shot img{display:block}.fade{position:absolute;left:0;right:0;bottom:0;height:60px;background:linear-gradient(transparent,#0f1013)}
    ol{list-style:none;margin:8px 0 0;padding:0;font:11px/1.45 ui-monospace,Menlo,monospace}
    li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#aeb2bd}li b{display:inline-block;min-width:18px;text-align:center;border-radius:7px;color:#fff;margin-right:3px}
    li.error b{background:#ff2d55}li.warn b{background:#ff9f0a;color:#1a1200}li span{color:#767b88}li.more{color:#767b88}
  </style></head><body>
    <header><h1>responsive-qa</h1><code>${esc(target.url)}</code>
      <span class="tot">${totals.error ? `<span class="e">✖ ${totals.error} errors</span>` : '<span class="ok">✓ no errors</span>'} &nbsp; <span class="w">⚠ ${totals.warn} warnings</span></span></header>
    <main>${cols}</main></body></html>`;
  const page = await browser.newPage({ viewport: { width: 1900, height: 800 } });
  await page.setContent(html, { waitUntil: 'load' });
  const w = await page.evaluate(() => Math.ceil(Math.max(...[...document.querySelectorAll('figure')].map((f) => f.getBoundingClientRect().right))));
  await page.setViewportSize({ width: Math.max(900, w + 24), height: 800 });
  const h = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
  await page.setViewportSize({ width: Math.max(900, w + 24), height: h });
  await page.screenshot({ path: file, fullPage: true });
  await page.close();
}

// ------------------------------------------------------------ compare
function compare(prev, cur) {
  // Only compare viewports both runs swept. With one page on each side, ignore the page
  // label so a renamed copy (before.html vs after.html) still lines up.
  const single = (prev.pages || []).length === 1 && (cur.pages || []).length === 1;
  const label = (pg) => (single ? '' : pg);
  const shared = (rep, other) => new Set((rep.results || []).map((r) => `${label(r.page)}|${r.viewport.width}`).filter((k) => (other.results || []).some((o) => `${label(o.page)}|${o.viewport.width}` === k)));
  const common = shared(prev, cur);
  const keys = (rep) => {
    const m = new Map();
    for (const r of rep.results || []) {
      if (!common.has(`${label(r.page)}|${r.viewport.width}`)) continue;
      for (const i of r.issues || []) if (i.severity !== 'info') m.set(issueKey(label(r.page), i, r.viewport.width), { page: r.page, width: r.viewport.width, ...i });
    }
    return m;
  };
  const a = keys(prev), b = keys(cur);
  const fixed = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
  const added = [...b].filter(([k]) => !a.has(k)).map(([, v]) => v);
  const remaining = [...b].filter(([k]) => a.has(k)).length;
  return { fixed, new: added, remaining };
}

// Group issues by page/check/selector so the terminal shows one line per bug, not per viewport.
function groupIssues(issues) {
  const g = new Map();
  for (const i of issues) {
    const k = `${i.page}|${i.check}|${i.selector}|${i.severity}`;
    const e = g.get(k) || { ...i, widths: [] };
    e.widths.push(i.width ?? i.viewport?.width);
    g.set(k, e);
  }
  return [...g.values()].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.widths.length - a.widths.length);
}
function fmtWidths(ws) {
  const idx = [...new Set(ws)].map((w) => widths.indexOf(w)).sort((a, b) => a - b);
  if (idx.length === widths.length) return 'all';
  const runs = [];
  for (const i of idx) { const last = runs[runs.length - 1]; if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]); }
  return runs.map(([s, e]) => (s === e ? `${widths[s]}` : `${widths[s]}–${widths[e]}`)).join(',');
}

// ------------------------------------------------------------------ main
const chromium = await loadPlaywright();
const browser = await launch(chromium);
const started = Date.now();
let report;
try {
  const reportPath = path.join(outDir, 'report.json');
  let previous = null;
  if (fs.existsSync(reportPath)) { try { previous = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (_) {} }
  fs.rmSync(path.join(outDir, 'shots'), { recursive: true, force: true });
  for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) if (/^contact-sheet.*\.png$/.test(f)) fs.rmSync(path.join(outDir, f));
  fs.mkdirSync(outDir, { recursive: true });

  log(`${magenta('◆')} responsive-qa · ${bold(base.href)} · ${widths.length} width${widths.length === 1 ? "" : "s"} (${widths.join(', ')})${fullPage ? ' · full page' : ''}`);
  const results = [];
  const sheets = [];
  for (const t of targets) {
    if (targets.length > 1) log(`${magenta('◆')} ${t.label}`);
    const r = await sweepTarget(browser, t);
    results.push(...r);
    const sheet = path.join(outDir, targets.length > 1 ? `contact-sheet-${t.slug}.png` : 'contact-sheet.png');
    await contactSheet(browser, t, r, sheet);
    sheets.push(path.relative(process.cwd(), sheet));
  }

  const all = results.flatMap((r) => r.issues.map((i) => ({ ...i, page: r.page, width: r.viewport.width })));
  const count = (s) => all.filter((i) => i.severity === s).length;
  const byCheck = {};
  for (const i of all) byCheck[i.check] = (byCheck[i.check] || 0) + 1;
  report = {
    tool: 'knack/responsive-qa', version: VERSION, generatedAt: new Date().toISOString(),
    url: base.href, pages: targets.map((t) => ({ label: t.label, url: t.url })), widths,
    options: { fullPage, height: heightOpt, ignore: ignoreSel, skip: skipChecks, failOn },
    summary: { errors: count('error'), warnings: count('warn'), info: count('info'), byCheck, horizontalScroll: results.filter((r) => r.doc.overflowX && !r.doc.rootClipsX).map((r) => ({ page: r.page, width: r.viewport.width, px: r.doc.overflowX })) },
    contactSheets: sheets,
    results,
  };

  let cmpSource = null;
  if (opts.compare === true) cmpSource = previous ? { rep: previous, from: 'previous run' } : null;
  else if (typeof opts.compare === 'string') {
    if (!fs.existsSync(opts.compare)) die(`--compare file not found: ${opts.compare}`);
    cmpSource = { rep: JSON.parse(fs.readFileSync(opts.compare, 'utf8')), from: opts.compare };
  }
  if (cmpSource) {
    const cmp = compare(cmpSource.rep, report);
    report.compare = { against: cmpSource.from, fixed: cmp.fixed.length, new: cmp.new.length, remaining: cmp.remaining, fixedIssues: cmp.fixed, newIssues: cmp.new };
  }

  if (previous) fs.writeFileSync(path.join(outDir, 'report.prev.json'), JSON.stringify(previous, null, 2));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // ---------------------------------------------------------- summary
  log('');
  const e = count('error'), w = count('warn');
  log(e ? red(bold(`✖ ${e} error${e === 1 ? '' : 's'}`)) + `  ${yellow(`⚠ ${w} warning${w === 1 ? '' : 's'}`)}  ${dim(`${count('info')} info · ${results.length} viewport${results.length === 1 ? "" : "s"} · ${((Date.now() - started) / 1000).toFixed(1)}s`)}`
    : green(bold('✓ No errors')) + `  ${w ? yellow(`⚠ ${w} warning${w === 1 ? '' : 's'}`) : dim('no warnings')}  ${dim(`${results.length} viewport${results.length === 1 ? "" : "s"} · ${((Date.now() - started) / 1000).toFixed(1)}s`)}`);
  const groups = groupIssues(all.filter((i) => i.severity !== 'info'));
  const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const MAX_LINES = 30, PER_CHECK_WARN = 4;
  // errors are listed in full; long runs of one warning type collapse into a single line
  const shownPerCheck = {}, hiddenPerCheck = {};
  const visibleGroups = groups.filter((g) => {
    if (g.severity === 'error') return true;
    shownPerCheck[g.check] = (shownPerCheck[g.check] || 0) + 1;
    if (shownPerCheck[g.check] <= PER_CHECK_WARN) return true;
    hiddenPerCheck[g.check] = (hiddenPerCheck[g.check] || 0) + 1;
    return false;
  });
  for (const g of visibleGroups.slice(0, MAX_LINES)) {
    const icon = g.severity === 'error' ? red('✖') : yellow('⚠');
    const where = `@${fmtWidths(g.widths)}`;
    log(`  ${icon} ${pad(g.check, 19)} ${cyan(pad(g.selector || '(page)', 40))} ${dim(pad(where, 16))} ${g.message}`);
    const hints = g.details?.hints;
    if (hints?.length) log(`      ${dim('↳ ' + hints.join(' · '))}`);
  }
  for (const [check, n] of Object.entries(hiddenPerCheck)) log(dim(`  ⚠ … ${n} more ${check} warning${n === 1 ? '' : 's'} (see report.json)`));
  if (visibleGroups.length > MAX_LINES) log(dim(`  … ${visibleGroups.length - MAX_LINES} more grouped issues in report.json`));
  const info = groupIssues(all.filter((i) => i.severity === 'info'));
  if (info.length) log(dim(`  ℹ ${info.length} info: ${[...new Set(info.map((i) => i.check))].join(', ')} (see report.json)`));
  const truncated = results.filter((r) => Object.keys(r.truncated).length);
  if (truncated.length) log(dim(`  (some checks hit --max-issues ${maxIssues}; raise it to see everything)`));
  const pageErrs = [...new Set(results.flatMap((r) => r.pageErrors))];
  if (pageErrs.length) log(yellow(`⚠ ${pageErrs.length} JavaScript error(s) on the page: `) + dim(pageErrs.slice(0, 3).join(' | ').slice(0, 300)));

  if (report.compare) {
    const cm = report.compare;
    log('');
    log(`${magenta('◆')} vs ${cm.against}: ${green(`✓ ${cm.fixed} fixed`)} · ${cm.new ? red(`✖ ${cm.new} new`) : dim('0 new')} · ${cm.remaining} remaining`);
    for (const g of groupIssues(cm.newIssues).slice(0, 10)) log(`  ${red('+')} ${pad(g.check, 19)} ${cyan(pad(g.selector || '(page)', 40))} ${dim('@' + fmtWidths(g.widths))}`);
    for (const g of groupIssues(cm.fixedIssues).slice(0, 10)) log(`  ${green('−')} ${pad(g.check, 19)} ${dim(pad(g.selector || '(page)', 40))} ${dim('@' + fmtWidths(g.widths))}`);
  }

  log('');
  for (const s of sheets) log(`${magenta('◆')} Contact sheet → ${s}`);
  log(`${magenta('◆')} Screenshots   → ${path.relative(process.cwd(), path.join(outDir, 'shots'))}/`);
  log(`${magenta('◆')} Report        → ${path.relative(process.cwd(), reportPath)}`);

  if (JSON_MODE && !outClosed) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  const failing = failOn === 'none' ? 0 : failOn === 'warn' ? e + w : e;
  process.exitCode = failing ? 2 : 0;
} finally {
  await browser.close();
}
