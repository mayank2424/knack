#!/usr/bin/env node
/**
 * Builds site/data/catalog.js (window.KNACK) from skills/*\/SKILL.md, each
 * skill's README.md, and catalog/community.json. Copies skill assets into
 * site/assets/skills/<name>/. Refreshes GitHub star counts when online
 * (set GITHUB_TOKEN to avoid rate limits; falls back to cached counts).
 *
 *   node tools/build-site.mjs [--offline]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { readSkill } from './validate-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const REPO = 'mayank2424/knack';
const GH = `https://github.com/${REPO}`;
const offline = process.argv.includes('--offline');

const skillsDir = path.join(root, 'skills');
const order = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
  .plugins.flatMap((p) => p.skills).map((s) => path.basename(s));

const skills = [];
for (const name of order) {
  const dir = path.join(skillsDir, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
  const { data } = readSkill(dir);
  const md = data.metadata || {};

  // Copy assets/ so README images resolve on the site.
  const assetsOut = path.join(site, 'assets', 'skills', name);
  fs.rmSync(assetsOut, { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'assets'))) fs.cpSync(path.join(dir, 'assets'), path.join(assetsOut), { recursive: true });

  let readme = fs.existsSync(path.join(dir, 'README.md')) ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8') : '';
  const tagline = (readme.match(/^>\s*(.+)$/m) || [, ''])[1].trim();
  readme = readme.replace(/^# .*\n+/, '').replace(/^>\s*.+\n+/m, ''); // the drawer renders its own title + tagline
  let html = marked.parse(readme, { gfm: true });
  // Rewrite relative links: assets → site copy; everything else → GitHub.
  html = html.replace(/(src|href)="(?!https?:|#|mailto:)([^"]+)"/g, (_, attr, url) => {
    const clean = url.replace(/^\.\//, '');
    if (clean.startsWith('assets/')) return `${attr}="assets/skills/${name}/${clean.slice(7)}"`;
    return `${attr}="${GH}/blob/main/skills/${name}/${clean}"`;
  });

  const scripts = fs.existsSync(path.join(dir, 'scripts'))
    ? fs.readdirSync(path.join(dir, 'scripts')).filter((f) => /\.(mjs|js|sh|py)$/.test(f)) : [];
  skills.push({
    name,
    title: md.title || name,
    description: data.description.trim(),
    tagline,
    category: md.category,
    tags: (md.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    version: md.version,
    model: data.model || null,
    preview: fs.existsSync(path.join(dir, 'assets', 'preview.png')) ? `assets/skills/${name}/preview.png` : null,
    scripts,
    url: `${GH}/tree/main/skills/${name}`,
    install: {
      npx: `npx skills add ${REPO} --skill ${name}`,
      manual: `cp -r knack/skills/${name} ~/.claude/skills/`,
    },
    readmeHtml: html,
  });
}

// Community catalog with live star counts.
const community = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'community.json'), 'utf8'));
if (!offline) {
  const repos = [...new Set(community.skills.map((s) => s.repo).filter(Boolean))];
  const headers = { 'User-Agent': 'knack-site-builder', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const stars = {};
  await Promise.all(repos.map(async (r) => {
    try {
      const res = await fetch(`https://api.github.com/repos/${r}`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) stars[r] = (await res.json()).stargazers_count;
    } catch (_) { /* keep cached */ }
  }));
  community.skills.forEach((s) => { if (stars[s.repo] != null) s.stars = stars[s.repo]; });
  console.log(`◆ Refreshed stars for ${Object.keys(stars).length}/${repos.length} repos`);
}
community.skills.sort((a, b) => (b.stars || 0) - (a.stars || 0));

const out = { repo: REPO, github: GH, builtAt: new Date().toISOString(), skills, community };
fs.mkdirSync(path.join(site, 'data'), { recursive: true });
fs.writeFileSync(path.join(site, 'data', 'catalog.js'), `window.KNACK = ${JSON.stringify(out)};\n`);
console.log(`◆ Wrote site/data/catalog.js (${skills.length} Knack skills, ${community.skills.length} community)`);
