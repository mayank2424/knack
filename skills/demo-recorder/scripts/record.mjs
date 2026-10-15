#!/usr/bin/env node
/**
 * Knack demo recorder: flow file (JSON) -> polished MP4 / GIF / WebM of a real web app,
 * with a smooth synthetic cursor, click ripples, keystroke HUD, captions and zoom.
 *
 *   node record.mjs flow.json                       # -> .knack/demo-recorder/flow.mp4 + contact sheet
 *   node record.mjs flow.json --format mp4,gif      # several outputs from one take
 *   node record.mjs flow.json --dry-run             # run steps, screenshot after each, no video
 *   node record.mjs flow.json -o docs/demo.gif --frame --trim-idle
 *
 * Options
 *   -o, --out FILE        Output path; extension picks the format (mp4 | gif | webm)
 *   --format LIST         Comma list of formats, e.g. mp4,gif (default: mp4, or flow "format")
 *   --dry-run, --still    Run the flow without recording; save a screenshot per step + a steps sheet
 *   --viewport WxH        Browser viewport in CSS px (default 1280x800)
 *   --scale N             Device scale factor; 2 = retina-crisp frames (default 2)
 *   --fps N               Capture frame rate (default 30)
 *   --frame / --no-frame  Wrap in a macOS-style window on a gradient background
 *   --background NAME     Frame background: aurora | sunset | ocean | mint | mono | midnight | any CSS
 *   --title TEXT          Text in the window title bar (default: the page host)
 *   --trim-idle [MS]      Cut runs of identical frames longer than MS (default 1000 when given)
 *   --max-seconds N       Hard cap on output length (cuts the end and warns)
 *   --speed N             Playback speed multiplier, e.g. 1.25
 *   --max-width N         Max width for MP4/WebM (default 1920)
 *   --gif-width N         GIF width (default 960)      --gif-fps N   GIF frame rate (default 15)
 *   --crf N               MP4 quality, lower = better/larger (default 20)
 *   --sheet N             Frames in the contact sheet (default 12); --no-sheet to skip
 *   --realtime            Do not virtualise time (use for pages with <video>/WebGL that break under it)
 *   --no-cursor           Hide the synthetic cursor
 *   --headed              Show the browser window while running
 *   --keep-frames         Keep the raw PNG frames (printed path)
 *   -h, --help            Show this help
 *
 * Flow format: see ../references/flow-format.md. Output defaults to ./.knack/demo-recorder/.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs, printHelp, loadPlaywright, launch, hasFfmpeg, ffmpeg, ffprobeDuration, resolveUrl,
  parseLooseJson, fmtBytes, clamp, log, ok, warn, die, SCRIPTS_DIR, tty,
} from './lib.mjs';
import { candidatesInPage } from './candidates.mjs';

const opts = parseArgs(process.argv.slice(2), {
  value: ['out', 'format', 'viewport', 'scale', 'fps', 'background', 'title', 'max-seconds', 'speed', 'max-width', 'gif-width', 'gif-fps', 'crf', 'name', 'timeout'],
  optional: ['trim-idle', 'sheet'],
  alias: { '-o': '--out', '-h': '--help' },
});
if (opts.help) printHelp(import.meta.url, 0);
if (!opts._[0]) printHelp(import.meta.url, 1);

// ------------------------------------------------------------------ config
const flowPath = path.resolve(opts._[0]);
if (!fs.existsSync(flowPath)) die(`Flow file not found: ${flowPath}`);
const flow = substituteEnv(parseLooseJson(fs.readFileSync(flowPath, 'utf8'), path.basename(flowPath)));
// "${env:NAME}" in any string pulls from the environment, so test credentials
// for a local app never have to be committed in the flow file.
function substituteEnv(v) {
  if (typeof v === 'string') return v.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => {
    if (process.env[k] === undefined) die(`Flow references \${env:${k}} but ${k} is not set.`);
    return process.env[k];
  });
  if (Array.isArray(v)) return v.map(substituteEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteEnv(x)]));
  return v;
}
if (!Array.isArray(flow.steps) || !flow.steps.length) die(`${path.basename(flowPath)} needs a non-empty "steps" array.`);
const flowDir = path.dirname(flowPath);
const name = opts.name || flow.name || path.basename(flowPath).replace(/\.(json|jsonc|flow)$/i, '').replace(/\.flow$/, '');

const pick = (cli, key, def) => (opts[cli] !== undefined ? opts[cli] : flow[key] !== undefined ? flow[key] : def);
const vpRaw = opts.viewport || flow.viewport || '1280x800';
const vp = typeof vpRaw === 'string' ? vpRaw.split(/[x×,]/).map(Number) : [vpRaw.width, vpRaw.height];
const [W, H] = vp;
if (!(W > 0 && H > 0)) die(`Bad viewport "${vpRaw}". Use e.g. 1280x800.`);
const SCALE = +pick('scale', 'scale', 2);
const FPS = +pick('fps', 'fps', 30);
const DT = 1000 / FPS;
const REALTIME = !!pick('realtime', 'realtime', false);
const DRY = !!(opts['dry-run'] || opts.still);
const outFlag = opts.out;
// Priority: --format, then the -o extension, then the flow's "format", then mp4.
const outExt = outFlag && /\.(mp4|gif|webm)$/i.test(outFlag) ? path.extname(outFlag).slice(1) : null;
const formatSrc = opts.format || outExt || flow.format || 'mp4';
const formats = (Array.isArray(formatSrc) ? formatSrc : String(formatSrc).split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
for (const f of formats) if (!['mp4', 'gif', 'webm'].includes(f)) die(`Unsupported format "${f}". Use mp4, gif or webm.`);
const outDir = outFlag ? path.dirname(path.resolve(outFlag)) : path.resolve('.knack/demo-recorder');
const outBase = outFlag ? path.resolve(outFlag).replace(/\.(mp4|gif|webm)$/i, '') : path.join(outDir, name);
const trimIdle = opts['trim-idle'] === true ? 1000 : +pick('trim-idle', 'trimIdle', 0) || 0;
const maxSeconds = +pick('max-seconds', 'maxSeconds', 0) || 0;
const speed = +pick('speed', 'speed', 1) || 1;
const maxWidth = +pick('max-width', 'maxWidth', 1920);
const gifWidth = +pick('gif-width', 'gifWidth', Math.min(960, W));
const gifFps = +pick('gif-fps', 'gifFps', 15);
const crf = +pick('crf', 'crf', 20);
const sheetN = opts.sheet === false ? 0 : opts.sheet === true || opts.sheet === undefined ? +(flow.sheet ?? 12) : +opts.sheet;
const STEP_TIMEOUT = +pick('timeout', 'timeout', 8000);

const frameRaw = opts.frame !== undefined ? opts.frame : flow.frame;
const frameCfg = frameRaw ? { padding: 56, radius: 12, bar: 38, ...(typeof frameRaw === 'object' ? frameRaw : {}) } : null;
if (frameCfg && opts.background) frameCfg.background = opts.background;
if (frameCfg && opts.title) frameCfg.title = opts.title;

const cursorCfg = { visible: true, size: 1, color: '#6366f1', speed: 1, start: [Math.round(W * 0.6), Math.round(H * 0.72)], ...(flow.cursor || {}) };
if (opts.cursor === false || flow.cursor === false) cursorCfg.visible = false;
const typeDelay = +(flow.typeDelay ?? 55);
const PAUSE = { goto: 700, click: 650, type: 450, press: 650, hover: 500, scroll: 450, drag: 600, select: 600, zoom: 200, highlight: 0, caption: 0, wait: 0, js: 0, cursor: 0, ...(flow.pauses || {}) };
const ACTIONS = Object.keys(PAUSE);

// Validate steps up front so typos fail before the browser starts.
const describe = (s) => {
  const a = actionOf(s);
  const v = s[a];
  const vs = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
  return `${a} ${vs && vs.length > 60 ? vs.slice(0, 57) + '…' : vs ?? ''}`.trim();
};
function actionOf(s) { return Object.keys(s).find((k) => ACTIONS.includes(k)); }
for (const [list, label] of [[flow.steps, 'steps'], [flow.setup || [], 'setup']]) {
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !actionOf(s)) die(`${label}[${i}] has no known action. Expected one of: ${ACTIONS.join(', ')}.\n  Got: ${JSON.stringify(s)}`);
  });
}

// ------------------------------------------------------------------ deps
if (!DRY && !hasFfmpeg()) die('ffmpeg not found. Install it (macOS: brew install ffmpeg · Ubuntu: sudo apt-get install -y ffmpeg · Windows: winget install Gyan.FFmpeg).');
fs.mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ browser
/*
 * Capture strategy (why not Playwright's recordVideo?)
 * recordVideo encodes a lossy ~1 Mbps VP8 stream at 1x device pixels with a
 * variable frame rate that drops frames whenever the machine is busy. Demos
 * made that way look soft and stutter. Instead we virtualise time and capture
 * frames ourselves:
 *   - page.clock freezes Date/timers/requestAnimationFrame/performance.now,
 *   - CDP Animation.setPlaybackRate(0) freezes CSS animations/transitions/WAAPI,
 *   - each frame we advance both by exactly 1/fps and grab a lossless PNG via
 *     CDP Page.captureScreenshot at deviceScaleFactor 2.
 * Result: every frame exists, timing is exact regardless of CPU speed, text is
 * retina-sharp, and zoom re-renders at higher resolution (clip.scale) instead
 * of upscaling pixels. Real network I/O still happens in real time, which only
 * makes slow requests look faster. --realtime turns virtual time off for pages
 * that misbehave under it (video, some WebGL), timestamping frames instead.
 */
const chromium = await loadPlaywright();
const browser = await launch(chromium, { headed: !!opts.headed });
const ctxOpts = { viewport: { width: W, height: H }, deviceScaleFactor: SCALE, reducedMotion: 'no-preference' };
if (flow.colorScheme) ctxOpts.colorScheme = flow.colorScheme;
if (flow.locale) ctxOpts.locale = flow.locale;
if (flow.storageState) ctxOpts.storageState = path.resolve(flowDir, flow.storageState);
if (flow.userAgent) ctxOpts.userAgent = flow.userAgent;
const ctx = await browser.newContext(ctxOpts);
const css = [
  flow.hideScrollbars === false ? '' : 'html,body,*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}',
  (flow.hide || []).length ? `${flow.hide.join(',')}{visibility:hidden!important}` : '',
  flow.css || '',
].join('\n');
if (css.trim()) {
  await ctx.addInitScript((css) => {
    const add = () => { const s = document.createElement('style'); s.setAttribute('data-knack', ''); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  }, css);
}
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const OVERLAY_SRC = fs.readFileSync(path.join(SCRIPTS_DIR, 'overlay.js'), 'utf8');

async function freezeAnimations() {
  if (REALTIME) return;
  try { await cdp.send('Animation.enable'); await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 }); } catch (_) {}
}
if (!REALTIME) {
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 1000);
  page.on('domcontentloaded', () => { freezeAnimations(); });
}
await freezeAnimations();

// ------------------------------------------------------------------ timeline + state
const realStart = Date.now();
let vt = 0;
const now = () => (REALTIME ? Date.now() - realStart : vt);
let capturing = false;
let frameDir = null;
const frames = []; // { file, t, hash, step }
let curStep = -1;
const rand = mulberry32(+(flow.seed ?? 7));

const S = {
  cursor: { x: cursorCfg.start[0], y: cursorCfg.start[1], visible: cursorCfg.visible },
  mouse: { x: -1, y: -1 },
  press: null, ripples: [], highlight: null, caption: null, keys: null, scroll: null,
  cam: { z: 1, cx: W / 2, cy: H / 2, follow: false, anim: null },
};

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const fade = (t, a, b, fi, fo) => (t < a ? 0 : t < a + fi ? easeOut((t - a) / fi) : t < b ? 1 : t < b + fo ? 1 - easeOut((t - b) / fo) : 0);

function overlayState(t) {
  const st = { cursor: { ...S.cursor, size: cursorCfg.size, down: 0, kind: undefined }, ripples: [], scroll: S.scroll };
  if (S.press) st.cursor.down = S.press.up == null ? clamp((t - S.press.t0) / 60, 0, 1) : clamp(1 - (t - S.press.up) / 140, 0, 1);
  S.ripples = S.ripples.filter((r) => t - r.t0 < 560);
  st.ripples = S.ripples.map((r) => ({ x: r.x, y: r.y, p: clamp((t - r.t0) / 560, 0, 1), color: cursorCfg.color, size: 46 }));
  if (S.highlight) st.highlight = { ...S.highlight, o: fade(t, S.highlight.t0, S.highlight.t1, 220, 300) };
  if (S.caption) st.caption = { text: S.caption.text, position: S.caption.position, o: fade(t, S.caption.t0, S.caption.t1, 260, 300) };
  if (S.keys) st.keys = { parts: S.keys.parts, o: fade(t, S.keys.t0, S.keys.t1, 120, 260) };
  return st;
}

function updateCamera(t) {
  const c = S.cam;
  if (c.anim) {
    const p = clamp((t - c.anim.t0) / c.anim.dur, 0, 1), e = easeInOut(p);
    c.z = c.anim.from.z + (c.anim.to.z - c.anim.from.z) * e;
    c.cx = c.anim.from.cx + (c.anim.to.cx - c.anim.from.cx) * e;
    c.cy = c.anim.from.cy + (c.anim.to.cy - c.anim.from.cy) * e;
    if (p >= 1) c.anim = null;
  } else if (c.follow && c.z > 1.001) {
    // Dead-zone follow: the camera only drifts when the cursor leaves the
    // middle ~60% of the zoomed view, then eases toward it (no sudden lurch).
    const vw = W / c.z, vh = H / c.z;
    const cx = clamp(c.cx, vw / 2, W - vw / 2), cy = clamp(c.cy, vh / 2, H - vh / 2);
    const mx = vw * 0.3, my = vh * 0.3;
    let tx = cx, ty = cy;
    if (S.cursor.x < cx - mx) tx = S.cursor.x + mx; else if (S.cursor.x > cx + mx) tx = S.cursor.x - mx;
    if (S.cursor.y < cy - my) ty = S.cursor.y + my; else if (S.cursor.y > cy + my) ty = S.cursor.y - my;
    const k = 1 - Math.exp(-DT / 320);
    c.cx = cx + (tx - cx) * k;
    c.cy = cy + (ty - cy) * k;
  }
}
function camClip(sx, sy) {
  const { z } = S.cam, vw = W / z, vh = H / z;
  const s = SCALE * z;
  // Snap the clip to the output pixel grid so every frame is exactly W*SCALE x H*SCALE
  // (Chrome rounds sub-pixel clips, which would make zoom frames wobble by a pixel).
  const snap = (v) => Math.round(v * s) / s;
  const x = snap(clamp(S.cam.cx - vw / 2, 0, W - vw) + sx), y = snap(clamp(S.cam.cy - vh / 2, 0, H - vh) + sy);
  return { x, y, width: (W * SCALE) / s, height: (H * SCALE) / s, scale: s };
}

// Runs inside the page every frame: advance frozen animations by dt, apply
// pending scroll, draw the overlay. Returns null if the overlay is missing.
const FRAME_FN = ([dt, st]) => {
  if (dt) {
    for (const a of document.getAnimations()) {
      if (a.playState !== 'running' || a.timeline !== document.timeline) continue;
      const cur = a.currentTime;
      a.currentTime = (cur == null || cur < 0 ? 0 : cur) + dt * (a.playbackRate || 1);
    }
  }
  if (st.scroll && window.__knackScroll) window.__knackScroll.scrollTo({ top: st.scroll.top, left: st.scroll.left, behavior: 'instant' });
  return window.__knack ? window.__knack.render(st) : null;
};

let lastRender = { sx: 0, sy: 0 };
async function tick(update) {
  if (!REALTIME) {
    const next = vt + DT;
    const ms = Math.round(next) - Math.round(vt);
    vt = next;
    if (ms > 0) await page.clock.runFor(ms).catch(navTolerant);
  }
  const t = now();
  update?.(t);
  updateCamera(t);
  const st = overlayState(t);
  S.scroll = null;
  if (S.cursor.visible && (Math.abs(S.mouse.x - S.cursor.x) > 0.3 || Math.abs(S.mouse.y - S.cursor.y) > 0.3)) {
    S.mouse = { x: S.cursor.x, y: S.cursor.y };
    await page.mouse.move(S.cursor.x, S.cursor.y).catch(navTolerant);
  }
  let r = await page.evaluate(FRAME_FN, [REALTIME ? 0 : DT, st]).catch(navTolerant);
  if (r === null) {
    await page.evaluate(OVERLAY_SRC).catch(navTolerant);
    r = await page.evaluate(FRAME_FN, [0, st]).catch(navTolerant);
  }
  if (r) lastRender = r;
  if (capturing) {
    const clip = camClip(lastRender.sx, lastRender.sy);
    if (process.env.KNACK_DEBUG) console.log(`\n#${frames.length} t=${t.toFixed(0)} z=${S.cam.z.toFixed(3)} clip=${JSON.stringify(clip)} sx=${lastRender.sx} sy=${lastRender.sy}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false, clip }).catch(navTolerant);
    if (shot) {
      const buf = Buffer.from(shot.data, 'base64');
      const file = path.join(frameDir, `f${String(frames.length).padStart(6, '0')}.png`);
      fs.writeFileSync(file, buf);
      frames.push({ file, t, hash: crypto.createHash('md5').update(buf).digest('hex'), step: curStep });
      if (tty && frames.length % 10 === 0) process.stdout.write(`\r  ${frames.length} frames · ${(t / 1000).toFixed(1)}s`);
    }
  }
}
function navTolerant(e) {
  // A step can trigger navigation mid-frame; skip that frame instead of crashing.
  if (/context was destroyed|navigation|Target closed|detached/i.test(e?.message || '')) return undefined;
  throw e;
}

let due = 0;
async function hold(ms) {
  if (!(ms > 0)) return;
  if (due < now()) due = now();
  due += ms;
  while (now() + DT / 2 <= due) await tick();
}
async function animate(dur, fn) {
  const t0 = now();
  let p = 0;
  do { await tick((t) => { p = dur > 0 ? clamp((t - t0) / dur, 0, 1) : 1; fn(p); }); } while (p < 1);
}

// ------------------------------------------------------------------ targets
class StepError extends Error {}
function locatorFor(sel, step = {}) {
  let loc = page.locator(sel);
  loc = step.nth !== undefined ? loc.nth(step.nth) : loc.first();
  return loc;
}
async function waitVisible(sel, step = {}, { gone = false } = {}) {
  const loc = locatorFor(sel, step);
  const timeout = +(step.timeout ?? STEP_TIMEOUT);
  const t0 = now(), r0 = Date.now();
  for (;;) {
    const vis = await loc.isVisible().catch(() => false);
    if (vis !== gone) return loc;
    if (now() - t0 > timeout || Date.now() - r0 > timeout * 3 + 5000) {
      throw new StepError(gone ? `"${sel}" is still visible after ${timeout}ms.` : `No visible element matches "${sel}" after ${timeout}ms.`);
    }
    await tick();
  }
}
async function scrollIntoView(loc) {
  for (let pass = 0; pass < 3; pass++) {
    const plan = await loc.evaluate((el) => {
      const r = el.getBoundingClientRect(), vh = innerHeight, vw = innerWidth, m = 24;
      let c = el.parentElement;
      while (c && c !== document.body && c !== document.documentElement) {
        const cs = getComputedStyle(c);
        if ((/(auto|scroll|overlay)/.test(cs.overflowY) && c.scrollHeight > c.clientHeight + 1) || (/(auto|scroll|overlay)/.test(cs.overflowX) && c.scrollWidth > c.clientWidth + 1)) break;
        c = c.parentElement;
      }
      const isDoc = !c || c === document.body || c === document.documentElement;
      const sc = isDoc ? document.scrollingElement || document.documentElement : c;
      const b = isDoc ? { top: 0, bottom: vh, left: 0, right: vw } : c.getBoundingClientRect();
      const box = { top: Math.max(0, b.top), bottom: Math.min(vh, b.bottom), left: Math.max(0, b.left), right: Math.min(vw, b.right) };
      const inY = r.top >= box.top + m && r.bottom <= box.bottom - m || r.height > box.bottom - box.top - 2 * m && r.top >= box.top && r.top < box.bottom;
      const inX = r.left >= box.left && r.right <= box.right;
      if (inY && inX) return null;
      let dy = 0, dx = 0;
      if (!inY) dy = r.height > box.bottom - box.top - 2 * m ? r.top - box.top - m : r.top + r.height / 2 - (box.top + box.bottom) / 2;
      if (!inX) dx = r.left + r.width / 2 - (box.left + box.right) / 2;
      const top = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, sc.scrollTop + dy));
      const left = Math.max(0, Math.min(sc.scrollWidth - sc.clientWidth, sc.scrollLeft + dx));
      if (Math.abs(top - sc.scrollTop) < 2 && Math.abs(left - sc.scrollLeft) < 2) return null;
      window.__knackScroll = sc;
      return { fromTop: sc.scrollTop, top, fromLeft: sc.scrollLeft, left };
    }).catch(() => null);
    if (!plan) return;
    await smoothScroll(plan);
  }
}
async function smoothScroll({ fromTop, top, fromLeft, left }, dur) {
  const dist = Math.hypot(top - fromTop, left - fromLeft);
  dur = dur ?? clamp(300 + dist * 0.6, 400, 1300);
  await animate(dur, (p) => {
    const e = easeInOut(p);
    S.scroll = { top: fromTop + (top - fromTop) * e, left: fromLeft + (left - fromLeft) * e };
  });
}
async function targetPoint(sel, step = {}) {
  if (Array.isArray(sel)) return { x: sel[0], y: sel[1] };
  const loc = await waitVisible(sel, step);
  await scrollIntoView(loc);
  const bb = await loc.boundingBox();
  if (!bb) throw new StepError(`"${sel}" has no layout box (hidden or detached).`);
  const [ox, oy] = step.offset || [0, 0];
  const pos = step.position || 'center';
  const px = pos === 'left' ? bb.x + Math.min(24, bb.width / 2) : pos === 'right' ? bb.x + bb.width - Math.min(24, bb.width / 2) : bb.x + bb.width / 2;
  return { x: clamp(px + ox, 2, W - 2), y: clamp(bb.y + bb.height / 2 + oy, 2, H - 2), loc };
}
async function moveTo(x, y, step = {}) {
  const fx = S.cursor.x, fy = S.cursor.y, d = Math.hypot(x - fx, y - fy);
  if (d < 1) return;
  const dur = step.moveDuration ?? clamp(260 + 115 * Math.log2(1 + d / 22), 320, 1050) / (cursorCfg.speed || 1);
  // Slight arc (quadratic bezier) reads as a human hand rather than a robot line.
  const nx = -(y - fy) / d, ny = (x - fx) / d, bend = Math.min(d * 0.1, 50) * (x >= fx ? 1 : -1);
  const cx = (fx + x) / 2 + nx * bend, cy = (fy + y) / 2 + ny * bend;
  await animate(dur, (p) => {
    const e = easeInOut(p), u = 1 - e;
    S.cursor.x = u * u * fx + 2 * u * e * cx + e * e * x;
    S.cursor.y = u * u * fy + 2 * u * e * cy + e * e * y;
  });
}
async function clickAt(x, y, step = {}) {
  const button = step.button || 'left';
  const count = step.double ? 2 : 1;
  await hold(70);
  for (let i = 1; i <= count; i++) {
    S.press = { t0: now(), up: null };
    await page.mouse.down({ button, clickCount: i });
    await hold(80);
    await page.mouse.up({ button, clickCount: i });
    S.press.up = now();
    S.ripples.push({ x, y, t0: now() });
    if (i < count) await hold(60);
  }
}

// ------------------------------------------------------------------ keys
const IS_MAC = process.platform === 'darwin';
const KEY_LABEL = {
  Meta: '⌘', Command: '⌘', Cmd: '⌘', ControlOrMeta: IS_MAC ? '⌘' : 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl',
  Alt: IS_MAC ? '⌥' : 'Alt', Option: '⌥', Shift: '⇧', Enter: '↵', Return: '↵', Escape: 'Esc', Esc: 'Esc',
  Backspace: '⌫', Delete: 'Del', Tab: 'Tab', Space: 'Space', ' ': 'Space',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn',
};
const keyParts = (combo) => combo.split('+').filter(Boolean).map((k) => KEY_LABEL[k] || (k.length === 1 ? k.toUpperCase() : k));
const normKey = (k) => k.split('+').map((p) => ({ Cmd: 'Meta', Command: 'Meta', Ctrl: 'Control', Option: 'Alt', Esc: 'Escape', Return: 'Enter' }[p] || p)).join('+');

// ------------------------------------------------------------------ steps
async function runStep(step) {
  const action = actionOf(step);
  const v = step[action];
  switch (action) {
    case 'goto': {
      const url = resolveUrl(v, { base: baseUrl, dir: flowDir });
      await page.goto(url, { waitUntil: step.waitUntil || 'load', timeout: 45000 });
      await freezeAnimations();
      break;
    }
    case 'click': {
      const p = await targetPoint(v, step);
      await moveTo(p.x, p.y, step);
      await clickAt(p.x, p.y, step);
      break;
    }
    case 'hover': {
      const p = await targetPoint(v, step);
      await moveTo(p.x, p.y, step);
      break;
    }
    case 'type': {
      if (step.into) {
        const p = await targetPoint(step.into, step);
        await moveTo(p.x, p.y, step);
        await clickAt(p.x, p.y, step);
        await hold(180);
      }
      if (step.clear) { await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace'); }
      const base = +(step.delay ?? typeDelay);
      for (const ch of [...String(v)]) {
        if (ch === '\n') await page.keyboard.press('Enter'); else await page.keyboard.type(ch);
        let d = base * (0.55 + rand() * 0.9);
        if (ch === ' ') d += base * 0.5;
        if (/[.,!?;:]/.test(ch)) d += base * 2;
        await hold(d);
      }
      break;
    }
    case 'press': {
      const keys = Array.isArray(v) ? v : [v];
      for (const k of keys) {
        const show = step.hud !== undefined ? step.hud : k.includes('+') || /^(Escape|Esc|Tab)$/.test(k);
        if (show) S.keys = { parts: keyParts(k), t0: now(), t1: now() + (step.hudDuration ?? 1000) };
        await hold(show ? 120 : 0);
        await page.keyboard.press(normKey(k));
        if (keys.length > 1) await hold(step.gap ?? 350);
      }
      break;
    }
    case 'scroll': {
      const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? v : typeof v === 'number' ? { by: v } : { to: v };
      if (o.to === 'top' || o.to === 'bottom' || o.by !== undefined) {
        const plan = await page.evaluate(([o, inSel]) => {
          const pick = inSel ? document.querySelector(inSel) : null;
          const sc = pick || document.scrollingElement || document.documentElement;
          window.__knackScroll = sc;
          const max = sc.scrollHeight - sc.clientHeight;
          const top = o.to === 'top' ? 0 : o.to === 'bottom' ? max : Math.max(0, Math.min(max, sc.scrollTop + o.by));
          return { fromTop: sc.scrollTop, top, fromLeft: sc.scrollLeft, left: sc.scrollLeft, found: !inSel || !!pick };
        }, [o, o.in || null]);
        if (!plan.found) throw new StepError(`scroll "in" container "${o.in}" not found (use a CSS selector).`);
        await smoothScroll(plan, o.duration);
      } else {
        const loc = await waitVisible(o.to, step);
        await scrollIntoView(loc);
      }
      break;
    }
    case 'wait': {
      if (typeof v === 'number') { await hold(v); break; }
      const o = typeof v === 'string' ? { for: v } : v;
      if (o.for) await waitVisible(o.for, { ...step, ...o });
      if (o.gone) await waitVisible(o.gone, { ...step, ...o }, { gone: true });
      if (o.ms) await hold(o.ms);
      break;
    }
    case 'drag': {
      const from = await targetPoint(v, step);
      await moveTo(from.x, from.y, step);
      await hold(80);
      S.press = { t0: now(), up: null };
      await page.mouse.down();
      await hold(140);
      let to;
      if (Array.isArray(step.to) && typeof step.to[0] === 'number' && step.by !== false && !step.absolute) to = { x: from.x + step.to[0], y: from.y + step.to[1] };
      else to = await targetPoint(step.to, step);
      await moveTo(to.x, to.y, { moveDuration: step.moveDuration ?? 900 });
      await hold(120);
      await page.mouse.up();
      S.press.up = now();
      break;
    }
    case 'select': {
      const p = await targetPoint(v, step);
      await moveTo(p.x, p.y, step);
      S.ripples.push({ x: p.x, y: p.y, t0: now() });
      await p.loc.selectOption(step.value ?? step.option);
      break;
    }
    case 'zoom': {
      const o = v === 'out' || v === false || v === 1 ? { scale: 1 } : typeof v === 'number' ? { scale: v } : typeof v === 'string' ? { to: v } : v;
      const z = clamp(+(o.scale ?? 1.6), 1, 4);
      let cx = S.cursor.x, cy = S.cursor.y;
      if (o.to) { const p = await targetPoint(o.to, step); cx = p.x; cy = p.y; }
      if (z === 1) { cx = W / 2; cy = H / 2; }
      S.cam.follow = !!o.follow && z > 1;
      cx = clamp(cx, W / z / 2, W - W / z / 2); cy = clamp(cy, H / z / 2, H - H / z / 2);
      const fz = S.cam.z, fcx = clamp(S.cam.cx, W / fz / 2, W - W / fz / 2), fcy = clamp(S.cam.cy, H / fz / 2, H - H / fz / 2);
      S.cam.anim = { from: { z: fz, cx: fcx, cy: fcy }, to: { z, cx, cy }, t0: now(), dur: +(o.duration ?? 800) };
      await hold(+(o.duration ?? 800));
      break;
    }
    case 'highlight': {
      if (v === false) { if (S.highlight) S.highlight.t1 = Math.min(S.highlight.t1, now()); break; }
      const loc = await waitVisible(v, step);
      await scrollIntoView(loc);
      await loc.evaluate((el) => { window.__knackHl = el; });
      const dur = +(step.duration ?? 1500);
      S.highlight = { t0: now(), t1: now() + dur, dim: !!step.dim, color: step.color || cursorCfg.color, padding: step.padding ?? 8, radius: step.radius ?? 12 };
      if (step.block !== false) await hold(dur + 300);
      break;
    }
    case 'caption': {
      if (v === false) { if (S.caption) S.caption.t1 = Math.min(S.caption.t1, now()); break; }
      const dur = step.duration === 0 ? Infinity : +(step.duration ?? 2200);
      S.caption = { text: String(v), position: step.position || 'bottom', t0: now(), t1: now() + dur };
      if (step.block) await hold(dur === Infinity ? 1500 : dur);
      break;
    }
    case 'cursor': {
      if (Array.isArray(v)) await moveTo(v[0], v[1], step);
      else S.cursor.visible = !(v === false || v === 'hide');
      break;
    }
    case 'js': {
      await page.evaluate(String(v));
      break;
    }
  }
  const pause = step.pause ?? PAUSE[action];
  await hold(pause);
}

async function suggest(step) {
  const sel = step[actionOf(step)];
  const q = typeof sel === 'string' ? sel : step.into || step.for || '';
  if (!q) return [];
  return page.evaluate(candidatesInPage, { query: String(q), limit: 6 }).catch(() => []);
}

// ------------------------------------------------------------------ run
const baseUrl = flow.url ? resolveUrl(flow.url, { dir: flowDir }) : null;
let stepsDir = null;
const stepShots = [];
async function run(list, { label, shoot }) {
  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    if (label === 'steps') curStep = i;
    log(`[${label === 'setup' ? 'setup ' : ''}${i + 1}/${list.length}] ${describe(step)}`);
    try {
      await runStep(step);
    } catch (e) {
      if (tty) process.stdout.write('\n');
      const errShot = `${outBase}-error.png`;
      await page.screenshot({ path: errShot }).catch(() => {});
      const msg = e instanceof StepError ? e.message : e.message.split('\n')[0];
      console.error(`\n✖ ${label}[${i}] ${describe(step)} failed: ${msg}`);
      const cands = await suggest(step);
      if (cands.length) {
        console.error('  Visible elements that look similar (selector → what it is):');
        for (const c of cands) console.error(`    ${c.selector}   ← ${c.role} "${c.name}"`);
      }
      console.error(`  Screenshot of the page at failure: ${errShot}`);
      console.error('  Tip: run inspect.mjs on the URL to list selectors, then fix the flow and re-run with --dry-run.');
      if (pageErrors.length) console.error(`  Page errors: ${pageErrors.slice(-3).join(' | ')}`);
      await browser.close();
      process.exit(1);
    }
    if (shoot) {
      const f = path.join(stepsDir, `${String(i + 1).padStart(2, '0')}-${actionOf(step)}.png`);
      await page.screenshot({ path: f });
      stepShots.push({ file: f, label: `${i + 1}. ${describe(step)}`, t: now() });
    }
  }
}

if (baseUrl) {
  log(`Opening ${baseUrl}`);
  try { await page.goto(baseUrl, { waitUntil: flow.waitUntil || 'load', timeout: 45000 }); }
  catch (e) { await browser.close(); die(`Could not open ${baseUrl}: ${e.message.split('\n')[0]}\n  Is the dev server running? Try: node "${path.join(SCRIPTS_DIR, 'inspect.mjs')}" --find-server`); }
  await freezeAnimations();
}
if (flow.setup?.length) await run(flow.setup, { label: 'setup', shoot: false });
await hold(150); // let the first paint settle before recording

if (DRY) {
  stepsDir = `${outBase}-steps`;
  fs.rmSync(stepsDir, { recursive: true, force: true });
  fs.mkdirSync(stepsDir, { recursive: true });
  await run(flow.steps, { label: 'steps', shoot: true });
  const est = now() / 1000;
  const sheet = `${outBase}-steps.png`;
  await buildSheet(stepShots.map((s) => ({ src: s.file, caption: s.label })), sheet, `${name} · dry run · ${flow.steps.length} steps · ~${est.toFixed(1)}s`);
  ok(`All ${flow.steps.length} steps passed. Estimated length ≈ ${est.toFixed(1)}s${est > 15 ? ' (long: aim for < 15s)' : ''}.`);
  ok(`Step screenshots → ${stepsDir}`);
  ok(`Steps sheet (open this to review) → ${sheet}`);
  if (pageErrors.length) warn(`Page errors during run: ${pageErrors.slice(-3).join(' | ')}`);
  await browser.close();
  process.exit(0);
}

frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knack-demo-'));
capturing = true;
const startedAt = Date.now();
log(`Recording ${W}×${H} @${SCALE}x, ${FPS}fps${REALTIME ? ' (realtime)' : ''}`);
await tick();
await hold(+(flow.leadIn ?? 400));
await run(flow.steps, { label: 'steps', shoot: false });
curStep = flow.steps.length;
await hold(+(flow.tail ?? 1200));
capturing = false;
if (tty) process.stdout.write('\n');
log(`Captured ${frames.length} frames (${(now() / 1000).toFixed(1)}s of timeline) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

// ------------------------------------------------------------------ edit: durations, trim, cap
for (let i = 0; i < frames.length; i++) frames[i].dur = i + 1 < frames.length ? Math.max(1, frames[i + 1].t - frames[i].t) : DT;
let kept = frames;
if (trimIdle > 0) {
  kept = [];
  let still = 0, cut = 0;
  for (let i = 0; i < frames.length; i++) {
    still = i && frames[i].hash === frames[i - 1].hash ? still + frames[i].dur : 0;
    if (still > trimIdle) { cut += frames[i].dur; continue; }
    kept.push(frames[i]);
  }
  if (cut > 0) log(`Trimmed ${(cut / 1000).toFixed(1)}s of idle frames (runs > ${trimIdle}ms)`);
}
let total = kept.reduce((a, f) => a + f.dur, 0) / speed;
if (maxSeconds > 0 && total / 1000 > maxSeconds) {
  warn(`Recording is ${(total / 1000).toFixed(1)}s; cutting to --max-seconds ${maxSeconds}. Shorten the flow or raise --speed instead of losing the ending.`);
  let acc = 0;
  kept = kept.filter((f) => (acc += f.dur / speed) <= maxSeconds * 1000);
  total = kept.reduce((a, f) => a + f.dur, 0) / speed;
}
const timeline = [];
{ let acc = 0; for (const f of kept) { timeline.push({ t: acc / 1000, step: f.step }); acc += f.dur / speed; } }
const listFile = path.join(frameDir, 'list.ffconcat');
fs.writeFileSync(listFile, 'ffconcat version 1.0\n' + kept.map((f) => `file '${path.basename(f.file)}'\nduration ${(f.dur / 1000).toFixed(6)}`).join('\n') + `\nfile '${path.basename(kept[kept.length - 1].file)}'\n`);

// ------------------------------------------------------------------ frame chrome
const BACKGROUNDS = {
  aurora: 'radial-gradient(70% 90% at 0% 0%, #7c3aed 0%, transparent 60%), radial-gradient(60% 80% at 100% 100%, #db2777 0%, transparent 60%), radial-gradient(50% 70% at 100% 0%, #2563eb 0%, transparent 60%), #0b1020',
  sunset: 'linear-gradient(135deg, #fb923c 0%, #f43f5e 50%, #8b5cf6 100%)',
  ocean: 'linear-gradient(135deg, #22d3ee 0%, #3b82f6 50%, #6366f1 100%)',
  mint: 'linear-gradient(135deg, #a7f3d0 0%, #bae6fd 100%)',
  mono: 'linear-gradient(180deg, #f4f4f5 0%, #e4e4e7 100%)',
  midnight: 'radial-gradient(80% 80% at 50% 0%, #27272a 0%, #09090b 70%)',
};
let FG = null;
if (frameCfg) {
  const pad = +frameCfg.padding, bar = +frameCfg.bar, R = +frameCfg.radius;
  const CW = W + 2 * pad, CH = H + bar + 2 * pad;
  const bg = BACKGROUNDS[frameCfg.background || 'aurora'] || frameCfg.background;
  const dark = (frameCfg.theme || (flow.colorScheme === 'dark' ? 'dark' : 'light')) === 'dark';
  let host = frameCfg.title;
  if (!host) { try { const u = new URL(page.url()); host = u.protocol === 'file:' ? decodeURIComponent(u.pathname.split('/').pop()) : u.host + (u.pathname !== '/' ? u.pathname : ''); } catch { host = name; } }
  const y0 = pad + bar;
  const hole = `M0 0H${CW}V${CH}H0Z M${pad} ${y0}H${pad + W}V${y0 + H - R}A${R} ${R} 0 0 1 ${pad + W - R} ${y0 + H}H${pad + R}A${R} ${R} 0 0 1 ${pad} ${y0 + H - R}Z`;
  const mask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${CW}' height='${CH}' viewBox='0 0 ${CW} ${CH}'><path fill-rule='evenodd' fill='#fff' d='${hole}'/></svg>`)}")`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fp = await browser.newPage({ viewport: { width: CW, height: CH }, deviceScaleFactor: SCALE });
  await fp.setContent(`<!doctype html><html><head><style>.canvas{position:absolute;inset:0;background:${bg};-webkit-mask:${mask} 0 0/100% 100% no-repeat;mask:${mask} 0 0/100% 100% no-repeat}</style></head>
    <body style="margin:0;background:transparent;width:${CW}px;height:${CH}px;overflow:hidden">
    <div class="canvas">
      <div style="position:absolute;left:${pad}px;top:${pad}px;width:${W}px;height:${H + bar}px;border-radius:${R}px;overflow:hidden;
        box-shadow:0 0 0 1px ${dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)'}, 0 30px 70px -10px rgba(0,0,0,.45), 0 10px 24px rgba(0,0,0,.18);
        background:${dark ? 'linear-gradient(#2a2a2e,#232327)' : 'linear-gradient(#f6f6f7,#ececef)'}">
        <div style="height:${bar}px;display:flex;align-items:center;position:relative;border-bottom:1px solid ${dark ? '#151517' : '#dcdce0'};box-sizing:border-box">
          <div style="display:flex;gap:8px;padding-left:14px">${['#ff5f57', '#febc2e', '#28c840'].map((c) => `<span style="width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)"></span>`).join('')}</div>
          <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:${Math.round(W * 0.55)}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            font:500 13px/1 ui-sans-serif,-apple-system,'SF Pro Text','Segoe UI',sans-serif;color:${dark ? '#a1a1aa' : '#6b6b73'};
            background:${dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.045)'};padding:6px 14px;border-radius:7px">${esc(host)}</div>
        </div>
      </div>
    </div></body></html>`);
  FG = { file: path.join(frameDir, 'chrome.png'), pad, y0, CW, CH };
  await fp.screenshot({ path: FG.file, omitBackground: true });
  await fp.close();
}

// ------------------------------------------------------------------ encode
const FW = Math.round(W * SCALE), FH = Math.round(H * SCALE);
function baseGraph(outFps) {
  // Normalise size (zoom clips can be off by a pixel), retime, constant fps, then add chrome.
  let g = `[0:v]scale=${FW}:${FH}:flags=bicubic,setsar=1,setpts=PTS/${speed},fps=${outFps}`;
  if (FG) g += `,pad=${FG.CW * SCALE}:${FG.CH * SCALE}:${FG.pad * SCALE}:${FG.y0 * SCALE}:color=black[base];[base][1:v]overlay=0:0:shortest=1:format=auto`;
  return g;
}
const inputs = (outFps) => ['-reinit_filter', '0', '-f', 'concat', '-safe', '0', '-i', listFile, ...(FG ? ['-loop', '1', '-framerate', String(outFps), '-i', FG.file] : [])];
const outputs = [];
for (const fmt of formats) {
  const out = `${outBase}.${fmt}`;
  log(`Encoding ${fmt.toUpperCase()}…`);
  let argv;
  if (fmt === 'gif') {
    const g = `${baseGraph(gifFps)},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
    argv = ['-y', ...inputs(gifFps), '-filter_complex', g, '-loop', '0', out];
  } else {
    const g = `${baseGraph(FPS)},scale='min(${maxWidth},iw)':-2:flags=lanczos,format=yuv420p`;
    argv = fmt === 'webm'
      ? ['-y', ...inputs(FPS), '-filter_complex', g, '-c:v', 'libvpx-vp9', '-crf', String(crf + 12), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an', out]
      : ['-y', ...inputs(FPS), '-filter_complex', g, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-tune', 'animation', '-movflags', '+faststart', '-an', out];
  }
  try { await ffmpeg(argv); } catch (e) { await browser.close(); die(`ffmpeg failed for ${fmt}:\n${e.message}`); }
  outputs.push({ fmt, out, size: fs.statSync(out).size });
}

// ------------------------------------------------------------------ contact sheet
async function buildSheet(items, out, header) {
  const cols = items.length <= 4 ? 2 : items.length <= 9 ? 3 : 4;
  const thumbW = cols === 2 ? 720 : cols === 3 ? 560 : 440;
  const p = await browser.newPage({ viewport: { width: cols * (thumbW + 16) + 16, height: 200 } });
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await p.setContent(`<!doctype html><body style="margin:0;background:#141418;font:600 13px/1.35 ui-monospace,Menlo,monospace;color:#d4d4d8">
    <div style="padding:14px 16px 0;opacity:.75">${esc(header)}</div>
    <div style="display:grid;grid-template-columns:repeat(${cols},${thumbW}px);gap:16px;padding:12px 16px 18px">
    ${items.map((it) => `<figure style="margin:0"><img src="data:image/png;base64,${fs.readFileSync(it.src).toString('base64')}" style="width:${thumbW}px;display:block;border-radius:6px;outline:1px solid #2a2a30"/><figcaption style="padding-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it.caption)}</figcaption></figure>`).join('')}
    </div></body>`);
  await p.waitForLoadState('load');
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: cols * (thumbW + 16) + 16, height: h });
  await p.screenshot({ path: out, fullPage: true });
  await p.close();
}
let sheetPath = null;
if (sheetN > 0 && outputs.length) {
  const src = (outputs.find((o) => o.fmt !== 'gif') || outputs[0]).out;
  const dur = ffprobeDuration(src) || total / 1000;
  const n = Math.max(2, sheetN);
  // Pick real frame timestamps (packets, no decode) so GIFs, whose identical
  // frames are merged, still map each thumbnail to an existing frame.
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', src]);
  const pts = String(pr.stdout).split('\n').map(parseFloat).filter((x) => !isNaN(x)).sort((x, y) => x - y);
  const times = Array.from({ length: n }, (_, i) => {
    const want = (i * dur) / (n - 1);
    let t = pts[0] ?? 0;
    for (const p of pts) { if (p <= want + 1e-3) t = p; else break; }
    return t;
  });
  const items = [];
  await Promise.all(times.map(async (t, i) => {
    const f = path.join(frameDir, `sheet-${i}.png`);
    await ffmpeg(['-y', '-i', src, '-vf', `select='gte(t,${Math.max(0, t - 0.001).toFixed(4)})',scale=900:-2:flags=lanczos`, '-frames:v', '1', f]).catch(() => {});
    if (!fs.existsSync(f)) return;
    let si = timeline.length - 1;
    for (let k = 0; k < timeline.length; k++) if (timeline[k].t > t + 1e-6) { si = Math.max(0, k - 1); break; }
    const stepIdx = timeline[si]?.step ?? -1;
    const label = stepIdx < 0 ? 'intro' : stepIdx >= flow.steps.length ? 'outro' : `${stepIdx + 1}. ${describe(flow.steps[stepIdx])}`;
    items[i] = { src: f, caption: `${t.toFixed(2)}s · ${label}` };
  }));
  for (let i = items.length - 1; i >= 0; i--) if (!items[i]) items.splice(i, 1);
  sheetPath = `${outBase}-sheet.png`;
  await buildSheet(items, sheetPath, `${name} · ${(total / 1000).toFixed(1)}s · ${outputs.map((o) => `${o.fmt} ${fmtBytes(o.size)}`).join(' · ')}`);
}
await browser.close();

// ------------------------------------------------------------------ report
if (opts['keep-frames']) ok(`Raw frames kept → ${frameDir}`);
else fs.rmSync(frameDir, { recursive: true, force: true });
for (const o of outputs) {
  ok(`${o.fmt.toUpperCase()} → ${o.out} (${fmtBytes(o.size)}, ${(total / 1000).toFixed(1)}s)`);
  if (o.size > 10e6) warn(`${path.basename(o.out)} is over 10 MB: GitHub rejects larger ${o.fmt === 'gif' ? 'images' : 'videos on free plans'}. ${o.fmt === 'gif' ? 'Try --gif-width 720 --gif-fps 12, --trim-idle, a shorter flow, or ship the MP4.' : 'Try --crf 26, --max-width 1280 or a shorter flow.'}`);
}
if (total / 1000 > 15) warn(`Clip is ${(total / 1000).toFixed(1)}s. Demos under ~15s get watched to the end; consider splitting it or --trim-idle / --speed 1.2.`);
if (sheetPath) ok(`Contact sheet (open this to review) → ${sheetPath}`);
if (pageErrors.length) warn(`Page errors during recording: ${pageErrors.slice(-3).join(' | ')}`);

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
