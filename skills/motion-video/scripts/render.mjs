#!/usr/bin/env node
/**
 * Knack Motion renderer: HTML composition -> MP4 / WebM / GIF / MOV / PNG.
 *
 *   node render.mjs comp.html                      # -> comp.mp4 (H.264, BT.709-tagged)
 *   node render.mjs comp.html -o out.webm          # format from extension: .mp4 .webm .mov .gif
 *   node render.mjs comp.html -o frames/           # PNG sequence (trailing slash)
 *   node render.mjs comp.html --still 2.5 -o p.png # single frame
 *   node render.mjs comp.html --filmstrip 12       # contact sheet for review
 *   node render.mjs comp.html --check              # lint layout/timing
 *
 * Options:
 *   --fps N            override the composition fps (time-based, so motion is unchanged)
 *   --scale N          2 = 4K from a 1080p comp (crisp text), 0.5 = fast draft
 *   --from S --to S    render a time range (audio is offset to match)
 *   --workers N        parallel browser pages (default: min(6, cores/2))
 *   --crf N            quality, lower = better/bigger (default 18 for MP4)
 *   --motion-blur N    average N sub-frame samples per frame (8-16 is film-like; N x render time)
 *   --shutter DEG      shutter angle for motion blur (default 180; 360 = smear the full frame)
 *   --trc bt709|srgb   transfer tag for MP4/WebM/MOV (default bt709; srgb = exact on Apple + Chrome)
 *   --dither           add a static ±1-level dither before 8-bit encoding; breaks up banding in big
 *                      dark gradients/glows (costs bitrate)
 *   --10bit            MP4 as HEVC Main10: smoothest gradients and smallest files; plays in Safari,
 *                      Chrome, Edge and QuickTime, not in Firefox on macOS/Linux or old players
 *   --audio file       mux audio (trimmed/padded to the video)   --audio-fade S (default 1)
 *   --transparent      keep alpha (WebM VP9 / MOV ProRes 4444; PNG stills)
 *   --gif-fps N        default 20     --gif-width N   default min(960, width)
 *   --gif-colors N     palette size (default 256); fewer = smaller files
 *   --gifski           encode the GIF with gifski if installed (~2x smaller on UI clips; may ghost
 *                      on moving gradients)   --gif-quality N (gifski, default 100)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VALUE = new Set(['fps', 'scale', 'from', 'to', 'workers', 'crf', 'audio', 'audio-fade', 'gif-fps', 'gif-width', 'gif-colors', 'gif-quality', 'out', 'motion-blur', 'shutter', 'trc']);
const OPTIONAL_NUM = new Set(['still', 'filmstrip']);
const opts = {};
let input, outFlag;
const argv0 = process.argv.slice(2);
for (let i = 0; i < argv0.length; i++) {
  const a = argv0[i];
  if (a === '-o') outFlag = argv0[++i];
  else if (a === '-h') opts.help = true;
  else if (a.startsWith('--')) {
    const k = a.slice(2);
    if (VALUE.has(k)) opts[k] = argv0[++i];
    else if (OPTIONAL_NUM.has(k) && argv0[i + 1] !== undefined && !isNaN(+argv0[i + 1])) opts[k] = argv0[++i];
    else opts[k] = true;
  } else input = a;
}
outFlag = outFlag || opts.out;
const flag = (name, fallback) => (name in opts ? opts[name] : fallback);

if (!input || opts.help) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace('#!/usr/bin/env node\n', '').replace('/**', '').replace(/^ \* ?/gm, ''));
  process.exit(input || opts.help ? 0 : 1);
}

const compPath = path.resolve(input);
if (!fs.existsSync(compPath)) die(`Composition not found: ${compPath}`);
const url = pathToFileURL(compPath).href;

// Temp dirs are removed on success, failure and Ctrl-C.
const tmpDirs = new Set();
const cleanup = () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); tmpDirs.clear(); };
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'knack-frames-')); tmpDirs.add(d); return d; };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });

function die(msg) { cleanup(); console.error(`\x1b[31m✖\x1b[0m ${msg}`); process.exit(1); }
const log = (msg) => console.log(`\x1b[35m◆\x1b[0m ${msg}`);

async function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return (await import(mod)).chromium; } catch (_) {}
  }
  die('Playwright is not installed. Run: bash "' + path.join(path.dirname(new URL(import.meta.url).pathname), 'setup.sh') + '"');
}

async function launch(chromium) {
  const tries = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const t of tries) {
    try { return await chromium.launch({ ...t, args: ['--force-color-profile=srgb', '--hide-scrollbars', '--disable-lcd-text', '--font-render-hinting=none'] }); }
    catch (e) { lastErr = e; }
  }
  die(`Could not launch Chromium. Run: npx playwright install chromium\n${lastErr?.message?.split('\n')[0]}`);
}

let OUTPUT = 'png';
async function openPage(browser, cfg, scale = 1) {
  const ctx = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    deviceScaleFactor: scale,
  });
  // The runtime adds `knack-render` and `knack-out-<ext>` classes to <html>, so CSS can adapt
  // per format (e.g. `.knack-out-gif .grain { display: none }`: grain bloats GIFs).
  await ctx.addInitScript((out) => { window.__KNACK_RENDER__ = true; window.__KNACK_OUTPUT__ = out; }, OUTPUT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__KNACK_READY__ === true, null, { timeout: 30000 }).catch(() => {
    die('Composition never became ready. Does it load motion.js and contain a #stage element?\n' + errors.join('\n'));
  });
  return { page, ctx, errors };
}

async function readConfig(browser) {
  const { page, ctx, errors } = await openPage(browser, { width: 1920, height: 1080 });
  const cfg = await page.evaluate(() => window.Motion.getConfig());
  await ctx.close();
  if (errors.length) console.warn('\x1b[33m⚠ page errors:\x1b[0m\n  ' + errors.join('\n  '));
  return cfg;
}

const shot = (page, cfg, o = {}) =>
  page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cfg.width, height: cfg.height }, omitBackground: !!o.transparent, animations: 'allow', caret: 'hide' });

function hasFfmpeg() { return spawnSync('ffmpeg', ['-version']).status === 0; }

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.split('\n').slice(-15).join('\n')))));
  });
}

// ---------------------------------------------------------------- color
// Chromium captures sRGB. Convert with the BT.709 matrix into limited range and tag
// all three color properties; untagged H.264 is decoded as BT.709 by browsers and
// QuickTime, which shifts saturated colors when ffmpeg's default BT.601 matrix was used.
const TRC = { bt709: 'bt709', srgb: 'iec61966-2-1' };
const colorFilter = (pixFmt) => {
  const trc = TRC[flag('trc', 'bt709')] || die(`--trc must be bt709 or srgb`);
  return `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${pixFmt},setparams=color_primaries=bt709:color_trc=${trc}:colorspace=bt709:range=tv`;
};
const colorTags = () => ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', TRC[flag('trc', 'bt709')], '-color_range', 'tv'];

// --------------------------------------------------------- frame capture
/** Sample times for output frame f. With motion blur: n samples centered on the frame, spread over the shutter. */
function sampleTimes(t, fps, n, shutter) {
  if (n <= 1) return [t];
  const open = (shutter / 360) / fps;
  return Array.from({ length: n }, (_, k) => t + ((k + 0.5) / n - 0.5) * open);
}
/** ffmpeg filter that averages each group of n consecutive sub-frames into one frame at `fps`. */
const blurFilter = (n, fps) => (n > 1 ? `tmix=frames=${n},select='eq(mod(n\\,${n})\\,${n - 1})',setpts=N/(${fps}*TB),` : '');

async function capture(browser, cfg, { times, scale, transparent, workers, dir, label }) {
  const total = times.length;
  let done = 0, lastQuarter = 0;
  const tty = process.stdout.isTTY;
  const progress = () => {
    const pct = Math.round((done / total) * 100);
    if (tty) process.stdout.write(`\r  ${'█'.repeat(Math.floor(pct / 4))}${'░'.repeat(25 - Math.floor(pct / 4))} ${pct}% (${done}/${total} ${label})`);
    else if (Math.floor(pct / 25) > lastQuarter) { lastQuarter = Math.floor(pct / 25); console.log(`  ${pct}% (${done}/${total})`); }
  };
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(workers, total) }, async (_, w) => {
    const { page, ctx, errors: e } = await openPage(browser, cfg, scale);
    // Interleaved frames balance the load: heavy beats (blur, big glows) are spread over all pages.
    for (let i = w; i < total; i += workers) {
      await page.evaluate((t) => window.Motion.seek(t), times[i]);
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(6, '0')}.png`), await shot(page, cfg, { transparent }));
      done++;
      if (done % 5 === 0 || done === total) progress();
    }
    errors.push(...e);
    await ctx.close();
  }));
  if (tty) process.stdout.write('\n');
  if (errors.length) console.warn('\x1b[33m⚠ page errors during render:\x1b[0m\n  ' + [...new Set(errors)].join('\n  '));
}

// ---------------------------------------------------------------- modes
async function still(browser, cfg, t, out, scale) {
  const n = Math.max(1, +flag('motion-blur', 1));
  const transparent = !!flag('transparent');
  if (n === 1) {
    const { page, ctx } = await openPage(browser, cfg, scale);
    await page.evaluate((t) => window.Motion.seek(t), t);
    fs.writeFileSync(out, await shot(page, cfg, { transparent }));
    await ctx.close();
  } else {
    if (!hasFfmpeg()) die('ffmpeg is needed for --motion-blur stills.');
    const dir = mkTmp();
    await capture(browser, cfg, { times: sampleTimes(t, +flag('fps', cfg.fps), n, +flag('shutter', 180)), scale, transparent, workers: 1, dir, label: 'samples' });
    await run('ffmpeg', ['-y', '-framerate', String(n), '-i', path.join(dir, 'f%06d.png'), '-vf', `tmix=frames=${n},select='eq(n\\,${n - 1})'`, '-frames:v', '1', '-update', '1', out])
      .catch((e) => die(`ffmpeg failed:\n${e.message}`));
    cleanup();
  }
  log(`Still @ ${t}s${n > 1 ? ` (motion blur ×${n})` : ''} → ${out}`);
}

async function filmstrip(browser, cfg, n, out) {
  const cols = n <= 6 ? 3 : 4;
  const thumbW = cfg.height > cfg.width ? 300 : 480;
  const scale = thumbW / cfg.width;
  const { page, ctx } = await openPage(browser, cfg, scale);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = +(((cfg.duration - 1 / cfg.fps) * i) / (n - 1)).toFixed(3);
    await page.evaluate((t) => window.Motion.seek(t), t);
    frames.push({ t, src: 'data:image/png;base64,' + (await shot(page, cfg)).toString('base64') });
  }
  await ctx.close();
  const thumbH = Math.round(cfg.height * scale);
  const sheet = await browser.newPage({ viewport: { width: cols * (thumbW + 16) + 16, height: 200 } });
  await sheet.setContent(`<!doctype html><body style="margin:0;background:#16161a;font:600 13px ui-monospace,Menlo,monospace;color:#cfcfd6">
    <div style="padding:12px 16px 0;opacity:.7">${path.basename(path.dirname(compPath))}/${path.basename(compPath)} · ${cfg.width}×${cfg.height} · ${cfg.fps}fps · ${cfg.duration}s</div>
    <div style="display:grid;grid-template-columns:repeat(${cols},${thumbW}px);gap:16px;padding:12px 16px 16px">
    ${frames.map((f) => `<figure style="margin:0"><img src="${f.src}" style="width:${thumbW}px;height:${thumbH}px;display:block;border-radius:6px;outline:1px solid #2a2a30"/><figcaption style="padding-top:6px">${f.t.toFixed(2)}s</figcaption></figure>`).join('')}
    </div></body>`);
  const h = await sheet.evaluate(() => document.body.scrollHeight);
  await sheet.setViewportSize({ width: cols * (thumbW + 16) + 16, height: h });
  await sheet.screenshot({ path: out, fullPage: true });
  await sheet.close();
  log(`Filmstrip (${n} frames) → ${out}`);
}

async function check(browser, cfg) {
  const { page, ctx, errors } = await openPage(browser, cfg);
  const issues = [];
  if (cfg.lastTweenEnd > cfg.duration + 0.01) issues.push(`Animations run until ${cfg.lastTweenEnd.toFixed(2)}s but duration is ${cfg.duration}s; they will be cut off.`);
  if (cfg.duration - cfg.lastTweenEnd > 2.5) issues.push(`Last tween ends at ${cfg.lastTweenEnd.toFixed(2)}s; ${(cfg.duration - cfg.lastTweenEnd).toFixed(1)}s of dead air at the end (fine if CSS/on() animations fill it).`);
  if (Math.abs(cfg.duration * cfg.fps - Math.round(cfg.duration * cfg.fps)) > 1e-6) issues.push(`duration × fps = ${(cfg.duration * cfg.fps).toFixed(2)} is not a whole number of frames; the last frame is rounded.`);
  const samples = 20;
  const seen = new Map();
  for (let i = 0; i <= samples; i++) {
    const t = Math.min(cfg.duration - 1 / cfg.fps, (cfg.duration * i) / samples);
    await page.evaluate((t) => window.Motion.seek(t), t);
    const found = await page.evaluate(({ W, H }) => {
      const out = [];
      const safe = 0.04;
      const visible = (el) => {
        for (let n = el; n && n.id !== 'stage'; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
        }
        return true;
      };
      const stage = document.getElementById('stage');
      const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const boxes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim()) continue;
        const el = node.parentElement;
        // Opt-out for screenshots / UI mockups where small text is content, not typography.
        if (el.closest('[data-knack-ignore]') || !visible(el)) continue;
        range.selectNodeContents(node);
        const rr = range.getBoundingClientRect();
        // Intersect with every clipping ancestor (overflow != visible); text hidden by a mask window is fine.
        let r = { left: rr.left, top: rr.top, right: rr.right, bottom: rr.bottom };
        for (let n = el; n && n !== stage; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') continue;
          const c = n.getBoundingClientRect();
          r = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
        }
        if (r.right - r.left <= 1 || r.bottom - r.top <= 1) continue;
        const label = (el.closest('[aria-label]')?.getAttribute('aria-label') || node.textContent).trim().slice(0, 40);
        const box = el.getBoundingClientRect();
        const scale = el.offsetHeight ? box.height / el.offsetHeight : 1;
        const fs = parseFloat(getComputedStyle(el).fontSize) * scale;
        if (fs < H * 0.02) out.push(['small', `Text "${label}" renders at ${Math.round(fs)}px; below ~${Math.round(H * 0.02)}px it gets hard to read on phones.`]);
        if (r.left < W * safe - 1 || r.top < H * safe - 1 || r.right > W * (1 - safe) + 1 || r.bottom > H * (1 - safe) + 1) {
          const off = r.right < 0 || r.left > W || r.bottom < 0 || r.top > H;
          if (!off) out.push(['edge', `Text "${label}" breaks the ${safe * 100}% safe area (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}).`]);
        }
        const ecs = getComputedStyle(el);
        const fam = ecs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        const generic = ['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'cursive', '-apple-system'];
        if (fam && !generic.includes(fam) && document.fonts && !document.fonts.check(`${ecs.fontStyle} ${ecs.fontWeight} 16px "${fam}"`)) out.push(['font', `Font "${fam}" did not load; text falls back to a default face.`]);
        // Collisions: two separate, fully visible text blocks overlapping each other.
        let op = 1;
        for (let n = el; n && n !== stage; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
        // Line boxes are taller than the ink; inset 12% top and bottom so tight leading isn't flagged.
        const ih = (r.bottom - r.top) * 0.12;
        if (op > 0.6) boxes.push({ block: el, r: { ...r, top: r.top + ih, bottom: r.bottom - ih }, label });
        if (op > 0.3) out.visibleText = true;
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.block === b.block || a.block.contains(b.block) || b.block.contains(a.block)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        const minA = Math.min((a.r.right - a.r.left) * (a.r.bottom - a.r.top), (b.r.right - b.r.left) * (b.r.bottom - b.r.top));
        if (ix > 2 && iy > 2 && ix * iy > 0.15 * minA) out.push(['overlap', `Text "${a.label}" overlaps "${b.label}".`]);
      }
      if (!out.visibleText) out.push(['empty', 'No readable text on screen.']);
      return out;
    }, { W: cfg.width, H: cfg.height });
    for (const [kind, msg] of found) {
      if (kind === 'empty') {
        // Feeds (X, LinkedIn, Reels) show frame 0 as the poster before autoplay; an empty one costs the scroll-stop.
        if (i === 0 && cfg.height >= cfg.width) issues.push('Frame 0 shows no text. Feeds use the first frame as the poster: start the hook mid-entrance (e.g. start: -0.2).');
        continue;
      }
      const key = kind + msg.replace(/\(.*\)/, '').replace(/renders at \d+px/, '');
      if (!seen.has(key)) seen.set(key, { msg, times: [] });
      seen.get(key).times.push(+t.toFixed(2));
    }
  }
  await ctx.close();
  for (const [key, { msg, times }] of seen) if (!(key.startsWith('small') && times.length < 2)) issues.push(`${msg} [at ${times.slice(0, 4).join(', ')}${times.length > 4 ? '…' : ''}s]`);
  errors.forEach((e) => issues.push(`Page error: ${e}`));
  if (!issues.length) log('Check passed: no layout or timing issues found.');
  else { console.log(`\x1b[33m⚠ ${issues.length} issue(s):\x1b[0m`); issues.forEach((i) => console.log('  • ' + i)); }
  return issues.length;
}

async function video(browser, cfg, out) {
  if (!hasFfmpeg()) die('ffmpeg not found. Install it (macOS: brew install ffmpeg · Ubuntu: apt install ffmpeg).');
  const seq = /[\\/]$/.test(out);
  const ext = seq ? 'png' : path.extname(out).slice(1).toLowerCase();
  if (!['mp4', 'webm', 'mov', 'gif', 'png', 'm4v'].includes(ext)) die(`Unknown output format ".${ext}". Use .mp4, .webm, .mov, .gif or a folder/ for PNGs.`);
  OUTPUT = ext;
  const isGif = ext === 'gif';
  const gw = isGif ? +flag('gif-width', Math.min(960, Math.round(cfg.width * +flag('scale', 1)))) : 0;
  // GIFs are captured directly at their final fps and width: faster, and no resampling blur.
  const fps = +flag('fps', isGif ? +flag('gif-fps', 20) : cfg.fps);
  const scale = isGif && !('scale' in opts) ? gw / cfg.width : +flag('scale', 1);
  const t0 = +flag('from', 0);
  const t1 = +flag('to', cfg.duration);
  if (!(t0 >= 0 && t1 > t0 && t1 <= cfg.duration + 1e-9)) die(`Invalid range --from ${t0} --to ${t1} (duration is ${cfg.duration}s).`);
  const total = Math.max(1, Math.round((t1 - t0) * fps));
  const blur = Math.max(1, Math.round(+flag('motion-blur', 1)));
  const shutter = +flag('shutter', 180);
  const workers = Math.max(1, +flag('workers', Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)))));
  const transparent = !!flag('transparent') || ext === 'mov';
  const W = Math.round(cfg.width * scale), H = Math.round(cfg.height * scale);
  const tmp = mkTmp();
  const started = Date.now();
  log(`Rendering ${total} frames${blur > 1 ? ` × ${blur} motion-blur samples` : ''} (${W}×${H} @ ${fps}fps, ${workers} workers)…`);

  const times = [];
  for (let f = 0; f < total; f++) times.push(...sampleTimes(t0 + f / fps, fps, blur, shutter));
  await capture(browser, cfg, { times, scale, transparent, workers, dir: tmp, label: blur > 1 ? 'samples' : 'frames' });
  const captured = Date.now();

  const frames = ['-framerate', String(fps * blur), '-i', path.join(tmp, 'f%06d.png')];
  const pre = blurFilter(blur, fps);
  const even = 'pad=ceil(iw/2)*2:ceil(ih/2)*2,';
  const audio = flag('audio');
  const useAudio = audio && typeof audio === 'string' && !['gif', 'png'].includes(ext);
  if (useAudio && !fs.existsSync(path.resolve(audio))) die(`Audio file not found: ${audio}`);
  const dur = +(total / fps).toFixed(6);
  const fade = Math.min(+flag('audio-fade', 1), dur);
  // Audio starts at --from, is padded with silence if short and trimmed to the video; never -shortest (it would cut video).
  const audioIn = useAudio ? ['-ss', String(t0), '-i', path.resolve(audio)] : [];
  const audioOut = useAudio ? ['-map', '0:v', '-map', '1:a', '-af', `${t0 > 0 ? 'afade=t=in:d=0.03,' : ''}apad,afade=t=out:st=${Math.max(0, dur - fade).toFixed(3)}:d=${fade}`, '-t', String(dur)] : ['-t', String(dur)];
  const crf = String(flag('crf', 18));
  const tenBit = !!flag('10bit');
  // Static (same every frame) noise, so it dithers gradients without costing temporal bits or crawling.
  const dither = flag('dither') && !transparent && !tenBit && ['mp4', 'm4v', 'webm'].includes(ext) ? 'format=rgb24,noise=alls=2:allf=u,' : '';
  let argv;
  if (ext === 'png') {
    fs.mkdirSync(out, { recursive: true });
    argv = ['-y', ...frames, ...(pre ? ['-vf', pre.slice(0, -1)] : []), '-start_number', '0', path.join(out, 'frame-%06d.png')];
  } else if (isGif && flag('gifski')) {
    if (spawnSync('gifski', ['--version']).status !== 0) die('gifski not found (brew install gifski / cargo install gifski), or drop --gifski.');
    let src = tmp;
    if (pre) { src = mkTmp(); await run('ffmpeg', ['-y', ...frames, '-vf', pre.slice(0, -1), path.join(src, 'g%06d.png')]); }
    const pngs = fs.readdirSync(src).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(src, f));
    argv = null;
    log('Encoding GIF with gifski…');
    try { await run('gifski', ['--quiet', '--fps', String(fps), '--quality', String(flag('gif-quality', 100)), '--width', String(gw), '-o', out, ...pngs]); } catch (e) { die(`gifski failed:\n${e.message}`); }
  } else if (isGif) {
    const colors = flag('gif-colors', 256);
    // One palette from every frame (stats_mode=full keeps static backgrounds accurate), sierra2_4a error
    // diffusion, and only the changed rectangle re-encoded per frame. Measured cleaner than per-frame palettes.
    argv = ['-y', ...frames, '-vf', `${pre}scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, '-loop', '0', out];
  } else if (ext === 'webm') {
    argv = ['-y', ...frames, ...audioIn, '-vf', pre + dither + even + colorFilter(transparent ? 'yuva420p' : 'yuv420p'), '-c:v', 'libvpx-vp9', '-crf', String(Math.max(+crf + 12, 24)), '-b:v', '0',
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', ...(transparent ? ['-auto-alt-ref', '0'] : []), ...colorTags(), ...audioOut, ...(useAudio ? ['-c:a', 'libopus', '-b:a', '160k'] : []), out];
  } else if (ext === 'mov') {
    argv = ['-y', ...frames, ...audioIn, '-vf', pre + colorFilter('yuva444p10le'), '-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0', ...colorTags(), ...audioOut, ...(useAudio ? ['-c:a', 'pcm_s16le'] : []), out];
  } else if (tenBit) {
    argv = ['-y', ...frames, ...audioIn, '-vf', pre + even + colorFilter('yuv420p10le'), '-c:v', 'libx265', '-preset', 'slow', '-crf', String(+crf + 2), '-tag:v', 'hvc1',
      '-x265-params', `log-level=error:colorprim=bt709:transfer=${TRC[flag('trc', 'bt709')]}:colormatrix=bt709:range=limited`, ...colorTags(), '-movflags', '+faststart', ...audioOut, ...(useAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), out];
  } else {
    // aq-mode 3 biases bits toward dark, flat areas, which is where gradients band.
    argv = ['-y', ...frames, ...audioIn, '-vf', pre + dither + even + colorFilter('yuv420p'), '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-profile:v', 'high', '-x264-params', 'aq-mode=3:aq-strength=0.8',
      ...colorTags(), '-movflags', '+faststart', ...audioOut, ...(useAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), out];
  }
  if (argv) {
    log(`Encoding ${seq ? 'PNG sequence' : ext.toUpperCase()} with ffmpeg…`);
    try { await run('ffmpeg', argv); } catch (e) { die(`ffmpeg failed:\n${e.message}`); }
  }
  cleanup();
  const size = seq ? fs.readdirSync(out).reduce((s, f) => s + fs.statSync(path.join(out, f)).size, 0) : fs.statSync(out).size;
  const secs = (Date.now() - started) / 1000;
  log(`Done in ${secs.toFixed(1)}s (capture ${((captured - started) / 1000).toFixed(1)}s, ${(times.length / ((captured - started) / 1000)).toFixed(1)} shots/s) → ${out} (${(size / 1e6).toFixed(2)} MB, ${total} frames, ${dur}s)`);
}

// ------------------------------------------------------------------ main
const chromium = await loadPlaywright();
const browser = await launch(chromium);
try {
  const cfg = await readConfig(browser);
  const base = compPath.replace(/\.html?$/i, '');
  if (flag('check')) {
    process.exitCode = (await check(browser, cfg)) ? 2 : 0;
  } else if (flag('still') !== undefined) {
    const t = flag('still') === true ? cfg.duration / 2 : +flag('still');
    await still(browser, cfg, t, outFlag || `${base}-${t}s.png`, +flag('scale', 1));
  } else if (flag('filmstrip') !== undefined) {
    const n = flag('filmstrip') === true ? 12 : Math.max(3, +flag('filmstrip'));
    await filmstrip(browser, cfg, n, outFlag || `${base}-filmstrip.png`);
  } else {
    await video(browser, cfg, outFlag || `${base}.mp4`);
  }
} finally {
  await browser.close();
  cleanup();
}
