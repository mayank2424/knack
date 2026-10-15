#!/usr/bin/env node
/**
 * Knack Motion renderer: HTML composition -> MP4 / WebM / GIF / MOV / PNG.
 *
 *   node render.mjs comp.html                      # -> comp.mp4
 *   node render.mjs comp.html -o out.webm          # format from extension
 *   node render.mjs comp.html --still 2.5 -o p.png # single frame
 *   node render.mjs comp.html --filmstrip 12       # contact sheet for review
 *   node render.mjs comp.html --check              # lint layout/timing
 *
 * Options: --fps N  --scale N  --from S  --to S  --workers N  --crf N
 *          --audio file  --audio-fade S  --transparent  --gif-fps N  --gif-width N
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VALUE = new Set(['fps', 'scale', 'from', 'to', 'workers', 'crf', 'audio', 'audio-fade', 'gif-fps', 'gif-width', 'out']);
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
const args = opts.help ? ['--help'] : [];
const flag = (name, fallback) => (name in opts ? opts[name] : fallback);

if (!input || args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace('/**', '').replace(/^ \* ?/gm, ''));
  process.exit(input ? 0 : 1);
}

const compPath = path.resolve(input);
if (!fs.existsSync(compPath)) die(`Composition not found: ${compPath}`);
const url = pathToFileURL(compPath).href;

function die(msg) { console.error(`\x1b[31m✖\x1b[0m ${msg}`); process.exit(1); }
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

async function openPage(browser, cfg, scale = 1) {
  const ctx = await browser.newContext({
    viewport: { width: cfg.width, height: cfg.height },
    deviceScaleFactor: scale,
  });
  await ctx.addInitScript(() => { window.__KNACK_RENDER__ = true; });
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

const shot = (page, cfg, opts = {}) =>
  page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cfg.width, height: cfg.height }, omitBackground: !!opts.transparent, animations: 'allow', caret: 'hide' });

function hasFfmpeg() { return spawnSync('ffmpeg', ['-version']).status === 0; }

function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.split('\n').slice(-15).join('\n')))));
  });
}

// ---------------------------------------------------------------- modes
async function still(browser, cfg, t, out, scale) {
  const { page, ctx } = await openPage(browser, cfg, scale);
  await page.evaluate((t) => window.Motion.seek(t), t);
  fs.writeFileSync(out, await shot(page, cfg, { transparent: flag('transparent') }));
  await ctx.close();
  log(`Still @ ${t}s → ${out}`);
}

async function filmstrip(browser, cfg, n, out) {
  const cols = n <= 6 ? 3 : 4;
  const thumbW = 480;
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
    <div style="padding:12px 16px 0;opacity:.7">${path.basename(compPath)} · ${cfg.width}×${cfg.height} · ${cfg.fps}fps · ${cfg.duration}s</div>
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
  const samples = 10;
  const seen = new Map();
  for (let i = 0; i <= samples; i++) {
    const t = (cfg.duration * i) / samples;
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
        const label = (el.getAttribute('aria-label') || node.textContent).trim().slice(0, 40);
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
      }
      return out;
    }, { W: cfg.width, H: cfg.height });
    for (const [kind, msg] of found) {
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
  const ext = path.extname(out).slice(1).toLowerCase();
  const fps = +flag('fps', cfg.fps);
  const scale = +flag('scale', 1);
  const t0 = +flag('from', 0);
  const t1 = +flag('to', cfg.duration);
  const total = Math.max(1, Math.round((t1 - t0) * fps));
  const workers = Math.max(1, Math.min(+flag('workers', Math.min(4, os.cpus().length)), total));
  const transparent = !!flag('transparent') || ext === 'mov';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knack-frames-'));
  const started = Date.now();
  log(`Rendering ${total} frames (${cfg.width * scale}×${cfg.height * scale} @ ${fps}fps, ${workers} workers)…`);

  let done = 0;
  const tty = process.stdout.isTTY;
  let lastQuarter = 0;
  const progress = () => {
    const pct = Math.round((done / total) * 100);
    if (tty) process.stdout.write(`\r  ${'█'.repeat(Math.floor(pct / 4))}${'░'.repeat(25 - Math.floor(pct / 4))} ${pct}% (${done}/${total})`);
    else if (Math.floor(pct / 25) > lastQuarter) { lastQuarter = Math.floor(pct / 25); console.log(`  ${pct}% (${done}/${total})`); }
  };
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const { page, ctx } = await openPage(browser, cfg, scale);
    for (let f = w; f < total; f += workers) {
      await page.evaluate((t) => window.Motion.seek(t), t0 + f / fps);
      fs.writeFileSync(path.join(tmp, `f${String(f).padStart(6, '0')}.png`), await shot(page, cfg, { transparent }));
      done++;
      if (done % 5 === 0 || done === total) progress();
    }
    await ctx.close();
  }));
  if (tty) process.stdout.write('\n');

  const frames = ['-framerate', String(fps), '-i', path.join(tmp, 'f%06d.png')];
  const audio = flag('audio');
  const audioIn = audio && typeof audio === 'string' ? ['-i', path.resolve(audio)] : [];
  const fade = +flag('audio-fade', 1);
  const dur = (t1 - t0).toFixed(3);
  const audioOut = audioIn.length ? ['-map', '0:v', '-map', '1:a', '-af', `afade=t=out:st=${Math.max(0, dur - fade)}:d=${fade}`, '-shortest', '-t', dur] : [];
  const crf = String(flag('crf', 18));
  let argv;
  if (ext === 'gif') {
    const gfps = flag('gif-fps', 20), gw = flag('gif-width', Math.min(960, cfg.width * scale));
    argv = ['-y', ...frames, '-vf', `fps=${gfps},scale=${gw}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`, out];
  } else if (ext === 'webm') {
    argv = ['-y', ...frames, ...audioIn, '-c:v', 'libvpx-vp9', '-crf', String(Math.max(+crf + 12, 24)), '-b:v', '0', '-pix_fmt', transparent ? 'yuva420p' : 'yuv420p', ...audioOut, ...(audioIn.length ? ['-c:a', 'libopus'] : []), out];
  } else if (ext === 'mov') {
    argv = ['-y', ...frames, ...audioIn, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', ...audioOut, ...(audioIn.length ? ['-c:a', 'pcm_s16le'] : []), out];
  } else {
    argv = ['-y', ...frames, ...audioIn, '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', ...audioOut, ...(audioIn.length ? ['-c:a', 'aac', '-b:a', '192k'] : []), out];
  }
  log(`Encoding ${ext.toUpperCase()} with ffmpeg…`);
  try { await run('ffmpeg', argv); } catch (e) { die(`ffmpeg failed:\n${e.message}`); }
  fs.rmSync(tmp, { recursive: true, force: true });
  const mb = (fs.statSync(out).size / 1e6).toFixed(2);
  log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${out} (${mb} MB)`);
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
}
