#!/usr/bin/env node
/**
 * Scaffold a composition from a template.
 *   node new.mjs <template> <out-dir> [--size 1920x1080] [--duration 8] [--fps 30]
 *   node new.mjs --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tdir = path.join(root, 'templates');
const templates = fs.readdirSync(tdir).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(`--${k}`); return i === -1 ? undefined : a[i + 1]; };

if (!a.length || a.includes('--list')) {
  console.log('Templates:\n' + templates.map((t) => {
    const head = fs.readFileSync(path.join(tdir, t + '.html'), 'utf8').match(/<meta name="description" content="([^"]+)"/);
    return `  ${t.padEnd(22)} ${head ? head[1] : ''}`;
  }).join('\n'));
  process.exit(0);
}
const [name, outDir] = a.filter((x, i) => !x.startsWith('--') && !(a[i - 1] || '').startsWith('--'));
if (!templates.includes(name)) { console.error(`Unknown template "${name}". Use --list.`); process.exit(1); }
const dest = path.resolve(outDir || name);
fs.mkdirSync(dest, { recursive: true });
let html = fs.readFileSync(path.join(tdir, name + '.html'), 'utf8');
const size = opt('size');
if (size) {
  const [w, h] = size.split('x').map(Number);
  html = html.replace(/width:\s*\d+/, `width: ${w}`).replace(/height:\s*\d+/, `height: ${h}`);
}
if (opt('duration')) html = html.replace(/duration:\s*[\d.]+/, `duration: ${opt('duration')}`);
if (opt('fps')) html = html.replace(/fps:\s*\d+/, `fps: ${opt('fps')}`);
const target = path.join(dest, 'index.html');
if (fs.existsSync(target)) { console.error(`${target} exists; refusing to overwrite.`); process.exit(1); }
fs.writeFileSync(target, html);
fs.copyFileSync(path.join(root, 'runtime', 'motion.js'), path.join(dest, 'motion.js'));
console.log(`◆ Created ${path.relative(process.cwd(), target)} (+ motion.js)`);
console.log(`  Preview: open ${path.relative(process.cwd(), target)}`);
console.log(`  Render:  node ${path.relative(process.cwd(), path.join(here, 'render.mjs'))} ${path.relative(process.cwd(), target)}`);
