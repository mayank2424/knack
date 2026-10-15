#!/usr/bin/env node
/**
 * Knack demo-recorder page inspector: find the dev server, then list clickable /
 * typeable elements with robust selectors to use in a flow file.
 *
 *   node inspect.mjs --find-server                 # probe common localhost dev ports
 *   node inspect.mjs http://localhost:3000         # numbered elements + annotated screenshot
 *   node inspect.mjs http://localhost:3000/settings --viewport 1024x680 --json
 *
 * Options
 *   --viewport WxH    Viewport in CSS px (default 1280x800)
 *   --out FILE        Annotated screenshot path (default .knack/demo-recorder/inspect.png)
 *   --wait X          Wait for a selector or a number of ms before inspecting
 *   --color-scheme S  light | dark
 *   --storage FILE    Playwright storageState JSON (logged-in cookies/localStorage)
 *   --json            Print JSON instead of a table
 *   --ports LIST      Ports for --find-server (comma list)
 *   -h, --help        Show this help
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, printHelp, loadPlaywright, launch, resolveUrl, log, ok, warn, die } from './lib.mjs';
import { candidatesInPage } from './candidates.mjs';

const opts = parseArgs(process.argv.slice(2), { value: ['viewport', 'out', 'wait', 'color-scheme', 'storage', 'ports'], alias: { '-h': '--help' } });
if (opts.help) printHelp(import.meta.url, 0);

if (opts['find-server']) {
  const ports = opts.ports ? String(opts.ports).split(',').map(Number) : [3000, 3001, 3002, 3003, 3010, 3020, 3030, 3040, 3060, 3080, 3100, 3120, 4000, 4200, 4321, 4173, 5000, 5173, 5174, 5175, 5500, 6006, 8000, 8001, 8080, 8081, 8787, 8888, 9000];
  log(`Probing ${ports.length} localhost ports…`);
  const found = (await Promise.all(ports.map(async (port) => {
    const url = `http://localhost:${port}/`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 800);
    try {
      const r = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      const body = (r.headers.get('content-type') || '').includes('html') ? await r.text() : '';
      return { port, url, status: r.status, title: (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim() };
    } catch { return null; } finally { clearTimeout(timer); }
  }))).filter(Boolean);
  if (!found.length) {
    warn('No dev server answered. Start the app (check package.json "dev"/"start" scripts) and re-run, or pass its URL directly.');
    process.exit(2);
  }
  for (const f of found) ok(`${f.url}  [${f.status}]${f.title ? `  "${f.title}"` : ''}`);
  process.exit(0);
}

if (!opts._[0]) printHelp(import.meta.url, 1);
const url = resolveUrl(opts._[0]);
const [W, H] = String(opts.viewport || '1280x800').split(/[x×,]/).map(Number);
const out = path.resolve(opts.out || '.knack/demo-recorder/inspect.png');
fs.mkdirSync(path.dirname(out), { recursive: true });

const chromium = await loadPlaywright();
const browser = await launch(chromium);
const ctx = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1,
  ...(opts['color-scheme'] ? { colorScheme: opts['color-scheme'] } : {}),
  ...(opts.storage ? { storageState: path.resolve(opts.storage) } : {}),
});
const page = await ctx.newPage();
try { await page.goto(url, { waitUntil: 'load', timeout: 45000 }); }
catch (e) { await browser.close(); die(`Could not open ${url}: ${e.message.split('\n')[0]}\n  Is the dev server running? Try: node inspect.mjs --find-server`); }
if (opts.wait) {
  if (!isNaN(+opts.wait)) await page.waitForTimeout(+opts.wait);
  else await page.locator(opts.wait).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => warn(`"${opts.wait}" never became visible`));
} else await page.waitForTimeout(400);

const items = await page.evaluate(candidatesInPage, { limit: 80 });
// Draw numbered badges for the in-viewport elements, screenshot, then clean up.
await page.evaluate((items) => {
  const layer = document.createElement('div');
  layer.id = '__knack_inspect';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  items.forEach((it, i) => {
    if (!it.inView) return;
    const b = it.box;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;outline:2px solid #e11d48;outline-offset:1px;border-radius:3px`;
    const tag = document.createElement('div');
    tag.textContent = String(i + 1);
    tag.style.cssText = `position:fixed;left:${Math.max(0, b.x - 2)}px;top:${Math.max(0, b.y - 16)}px;background:#e11d48;color:#fff;font:700 11px/14px ui-monospace,Menlo,monospace;padding:0 4px;border-radius:3px`;
    layer.append(box, tag);
  });
  document.documentElement.appendChild(layer);
}, items);
await page.screenshot({ path: out });
const title = await page.title();
await browser.close();

if (opts.json) { console.log(JSON.stringify({ url, title, viewport: { width: W, height: H }, elements: items }, null, 2)); process.exit(0); }
log(`${title || url} · ${W}×${H} · ${items.length} interactive elements`);
items.forEach((it, i) => {
  const where = it.inView ? `${it.box.x},${it.box.y} ${it.box.w}×${it.box.h}` : 'below the fold (recorder scrolls to it)';
  console.log(`${String(i + 1).padStart(3)}. ${it.selector}\n       ${it.role}${it.name ? ` "${it.name}"` : ''} · ${where}`);
});
ok(`Annotated screenshot → ${out}`);
