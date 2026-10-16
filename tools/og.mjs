#!/usr/bin/env node
/**
 * Generates Open Graph images (1200×630 PNG) for the website: one for the home page and one per
 * skill, built from each skill's real evidence image (catalog/site.json). Output: site/assets/og/.
 * Re-run after adding a skill or changing its evidence:   node tools/og.mjs
 * Uses Playwright from skills/motion-video/scripts (run that skill's setup.sh once) or a global one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { readSkill } from './validate-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
for (const p of [path.join(root, 'skills/motion-video/scripts/node_modules/playwright'), 'playwright']) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) { console.error('Playwright not found. Run: bash skills/motion-video/scripts/setup.sh'); process.exit(1); }

const site = path.join(root, 'site');
const out = path.join(site, 'assets', 'og');
fs.mkdirSync(out, { recursive: true });
const siteData = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'site.json'), 'utf8')).skills;
const order = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins.flatMap((p) => p.skills).map((s) => path.basename(s));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fileUrl = (p) => pathToFileURL(path.join(site, p)).href;
const icon = fs.readFileSync(path.join(site, 'assets/brand/knack-icon.svg'), 'utf8');
const KIND = { media: 'Media', design: 'Design', dev: 'Dev' };

const shell = (body) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600&display=block" rel="stylesheet">
<style>
  *{box-sizing:border-box} body{margin:0;width:1200px;height:630px;overflow:hidden;background:#fafafa;font-family:'IBM Plex Sans',sans-serif;color:#111214;position:relative}
  .guides{position:absolute;inset:0;background:
    linear-gradient(#e6e6e8,#e6e6e8) 64px 0/1px 100% no-repeat, linear-gradient(#e6e6e8,#e6e6e8) calc(100% - 64px) 0/1px 100% no-repeat,
    linear-gradient(#e6e6e8,#e6e6e8) 0 56px/100% 1px no-repeat, linear-gradient(#e6e6e8,#e6e6e8) 0 calc(100% - 56px)/100% 1px no-repeat}
  .brand{position:absolute;left:96px;top:92px;display:flex;align-items:center;gap:14px;font-weight:600;font-size:26px;letter-spacing:-.01em}
  .brand svg{width:40px;height:40px}
  .url{position:absolute;left:96px;bottom:88px;font:500 18px 'IBM Plex Mono',monospace;color:#61646b}
  .kind{font:500 17px 'IBM Plex Mono',monospace;color:#61646b;margin:0 0 14px}
  h1{margin:0;font-weight:600;letter-spacing:-.025em;line-height:1.03}
  p.sub{margin:22px 0 0;font-size:24px;line-height:1.4;color:#33353a}
  .ev{position:absolute;right:96px;top:120px;width:470px;height:390px;border-radius:16px;overflow:hidden;background:#fff;border:1px solid #d3d4d8;box-shadow:0 28px 60px -28px rgba(17,18,20,.45)}
  .ev img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
  .ev pre{margin:0;padding:26px 28px;font:500 15.5px/1.75 'IBM Plex Mono',monospace;color:#33353a;white-space:pre}
  .ev.term{width:520px;height:auto;top:150px;background:#111214;border-color:#111214}
  .ev.term .bar{display:flex;gap:7px;padding:14px 18px 0}.ev.term .bar i{width:11px;height:11px;border-radius:50%;background:#3a3c42;display:block}
  .ev.term pre{color:#d9dade;font-size:14px;padding:16px 24px 26px}
  .frames{position:absolute;right:96px;top:110px;width:500px;height:410px}
  .frames .f{position:absolute;overflow:hidden;border-radius:12px;border:1px solid #d3d4d8;background:#fff;box-shadow:0 24px 50px -26px rgba(17,18,20,.5)}
  .frames .f img{width:100%;height:100%;object-fit:cover;display:block}
  .ok{position:absolute;right:120px;bottom:96px;display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:999px;background:#fff;border:1px solid #16793c;font:500 17px 'IBM Plex Mono',monospace;color:#16793c;box-shadow:0 10px 24px -14px rgba(17,18,20,.4)}
  .ok i{width:10px;height:10px;border-radius:50%;background:#16793c;display:block}
</style></head><body><div class="guides"></div>${body}</body></html>`;

// Stills pulled from a skill's real example renders (catalog/site.json → og.frames: [{ src, t }]).
// Layout: two 16:9 frames stacked on the left, one 9:16 frame on the right.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knack-og-'));
function frameCollage(name, frames) {
  const slots = [
    'left:0;top:0;width:290px;height:163px', 'left:0;top:183px;width:290px;height:163px', 'left:310px;top:0;width:190px;height:338px',
  ];
  return `<div class="frames">${frames.slice(0, 3).map((f, i) => {
    const jpg = path.join(tmpDir, `${name}-${i}.jpg`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(f.t), '-i', path.join(root, f.src), '-frames:v', '1', '-q:v', '2', jpg]);
    return `<div class="f" style="${slots[i]}"><img src="${pathToFileURL(jpg).href}"></div>`;
  }).join('')}</div>`;
}

const pages = [];
// Home: headline + a stack of three real evidence cards.
const homeCards = ['assets/evidence/a11y.png', 'assets/evidence/prdiff.png', 'assets/evidence/demo-poster.png'];
pages.push({
  file: 'home.png',
  html: shell(`
    <div class="brand">${icon}Knack</div>
    <div style="position:absolute;left:96px;top:196px;width:540px">
      <h1 style="font-size:70px">Agent skills that show their work.</h1>
      <p class="sub">Open-source skills for Claude Code and any Agent Skills agent. Real tools, real evidence.</p>
    </div>
    ${homeCards.map((src, i) => `<div class="ev" style="width:360px;height:270px;right:${84 + (2 - i) * 30}px;top:${120 + i * 64}px;transform:rotate(${(i - 1) * 2.5}deg)"><img src="${fileUrl(src)}"></div>`).join('')}
    <div class="url">knack.mayankbuilds.com</div>`),
});
// One per skill: title, summary, its real evidence, and its verified result.
for (const name of order) {
  const dir = path.join(root, 'skills', name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
  const { data } = readSkill(dir);
  const md = data.metadata || {};
  const extra = siteData[name] || {};
  const ev = extra.evidence || {};
  const img = ev.type === 'image' ? ev.src : ev.type === 'video' ? ev.poster : null;
  const trail = extra.trail || [];
  const result = (trail.find(([t]) => t === 'Done') || trail[trail.length - 1] || ['', 'verified'])[1];
  const clip = (l) => (l.length > 53 ? l.slice(0, 52) + '…' : l);
  let visual;
  if (extra.og?.frames) visual = frameCollage(name, extra.og.frames);
  else if (img) visual = `<div class="ev"><img src="${fileUrl(img)}"></div>`;
  else visual = `<div class="ev term"><div class="bar"><i></i><i></i><i></i></div><pre>${esc([...(ev.lines || []).filter(Boolean).slice(0, 9).map(clip), ev.command && !(ev.lines || []).some((l) => l.startsWith('$')) ? '$ ' + clip(ev.command) : ''].join('\n'))}</pre></div>`;
  const title = md.title || name;
  pages.push({
    file: `${name}.png`,
    html: shell(`
      <div class="brand">${icon}Knack</div>
      <div style="position:absolute;left:96px;top:196px;width:${extra.og?.frames ? 470 : img ? 500 : 430}px">
        <p class="kind">${KIND[md.category] || md.category} skill</p>
        <h1 style="font-size:${title.length > 10 ? 62 : 76}px;white-space:nowrap">${esc(title)}</h1>
        <p class="sub">${esc(extra.summary || '')}</p>
      </div>
      ${visual}
      <div class="ok"><i></i>${esc(result)}</div>
      <div class="url">knack.mayankbuilds.com/skills/${name}</div>`),
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const p of pages) {
  const tmp = path.join(out, `.${p.file}.html`);
  fs.writeFileSync(tmp, p.html);
  await page.goto(pathToFileURL(tmp).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, p.file) });
  fs.rmSync(tmp);
  console.log(`◆ ${path.relative(root, path.join(out, p.file))}`);
}
await browser.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
