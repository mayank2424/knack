#!/usr/bin/env node
/**
 * Builds the static website into site/:
 *   site/index.html            from site/index.template.html
 *   site/skills/<name>/        one page per skill, from its README.md
 *   site/assets/skills/<name>/ copies of each skill's assets/
 * Inputs: skills/*\/SKILL.md, README.md, catalog/site.json (evidence + checks)
 * and catalog/community.json (refreshes GitHub stars when online; set
 * GITHUB_TOKEN to avoid rate limits; cached counts are the fallback).
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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const copyIcon = (label) => `<button class="copy icon" type="button" aria-label="${label}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg></button>`;
const KIND = { media: 'Media', design: 'Design', dev: 'Dev', docs: 'Docs', productivity: 'Productivity' };

const siteData = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'site.json'), 'utf8')).skills;
const order = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
  .plugins.flatMap((p) => p.skills).map((s) => path.basename(s));

// ── Shared chrome
const logo = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="#111214"/><path d="M8.2 6v12M16.4 6.4 10 12l6.4 5.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ghIcon = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
const header = (base, current = '') => `<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="wrap">
  <a class="brand" href="${base}">${logo}Knack</a>
  <nav class="nav" aria-label="Primary">
    <a href="${base}#skills"${current === 'skills' ? ' aria-current="page"' : ''}>Skills</a>
    <a href="${base}#catalog">Catalog</a>
    <a href="${GH}/blob/main/CONTRIBUTING.md">Contribute</a>
    <a class="gh" data-gh href="${GH}">${ghIcon}GitHub</a>
  </nav>
</div></header>`;
const footer = (base) => `<footer class="site-foot"><div class="wrap">
  <span>Knack is MIT licensed. Made by <a href="https://github.com/mayank2424">Mayank Gupta</a>.</span>
  <nav aria-label="Footer"><a href="${base}#skills">Skills</a><a href="${base}#catalog">Catalog</a><a href="https://agentskills.io">Agent Skills spec</a><a href="${GH}">Source</a></nav>
</div></footer>`;

// ── Skills
const skills = [];
for (const name of order) {
  const dir = path.join(root, 'skills', name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
  const { data } = readSkill(dir);
  const md = data.metadata || {};
  const extra = siteData[name] || {};

  const assetsOut = path.join(site, 'assets', 'skills', name);
  fs.rmSync(assetsOut, { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'assets'))) fs.cpSync(path.join(dir, 'assets'), assetsOut, { recursive: true });

  let readme = fs.existsSync(path.join(dir, 'README.md')) ? fs.readFileSync(path.join(dir, 'README.md'), 'utf8') : '';
  const tagline = (readme.match(/^>\s*(.+)$/m) || [, ''])[1].trim();
  readme = readme.replace(/^# .*\n+/, '').replace(/^>\s*.+\n+/m, '');
  // Detail pages live at /skills/<name>/, two levels below the site root.
  let html = marked.parse(readme, { gfm: true }).replace(/(src|href)="(?!https?:|#|mailto:)([^"]+)"/g, (_, attr, url) => {
    const clean = url.replace(/^\.\//, '');
    if (clean.startsWith('assets/')) return `${attr}="../../assets/skills/${name}/${clean.slice(7)}"`;
    return `${attr}="${GH}/blob/main/skills/${name}/${clean}"`;
  });
  const scripts = fs.existsSync(path.join(dir, 'scripts'))
    ? fs.readdirSync(path.join(dir, 'scripts')).filter((f) => /\.(mjs|js|sh|py)$/.test(f)).sort() : [];

  // When the site shows real evidence, drop the README's lead preview image so it isn't shown twice.
  html = html.replace(/<pre>/g, '<pre tabindex="0">'); // scrollable code must be keyboard-reachable
  const body = extra.evidence ? html.replace(/^\s*<p><img [^>]*preview\.png[^>]*><\/p>\s*/, '') : html;
  skills.push({ name, title: md.title || name, tagline, kind: md.category, version: md.version, model: data.model, scripts, html: body, ...extra });
}

const evidence = (s, base) => {
  const e = s.evidence;
  if (!e) return '';
  if (e.type === 'terminal') {
    return `<figure class="evidence"><pre class="terminal" tabindex="0" aria-label="Terminal output"><span class="prompt">$ ${esc(e.command)}</span>\n${e.lines.map(esc).join('\n')}</pre><figcaption>${esc(e.caption)}</figcaption></figure>`;
  }
  if (e.type === 'video') {
    return `<figure class="evidence"><video src="${base}${e.src}" poster="${base}${e.poster}" muted loop playsinline preload="none" data-autoplay aria-label="${esc(e.caption)}"></video><figcaption>${esc(e.caption)}</figcaption></figure>`;
  }
  return `<figure class="evidence"><img src="${base}${e.src}" alt="${esc(e.caption)}" loading="lazy" /><figcaption>${esc(e.caption)}</figcaption></figure>`;
};

const skillRows = skills.map((s) => `
    <article class="skill" id="${s.name}">
      <div>
        <span class="skill-kind">${KIND[s.kind] || s.kind}${s.model === 'opus' ? ' · runs on Claude Opus' : ''}</span>
        <h3><a href="skills/${s.name}/">${esc(s.title)}</a></h3>
        <p class="skill-summary">${esc(s.summary || s.tagline)}</p>
        <ul class="checks">${(s.checks || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        <div class="cmd"><code>npx skills add ${REPO} --skill ${s.name}</code>${copyIcon('Copy install command')}</div>
        <p class="skill-links"><a href="skills/${s.name}/">Read the docs</a><a href="${GH}/tree/main/skills/${s.name}">Source</a></p>
      </div>
      ${evidence(s, '')}
    </article>`).join('');

// ── Community catalog
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
const fmtStars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n || 0));
const catalogRows = community.skills.map((s) => `
          <tr data-cat="${esc(s.category)}" data-search="${esc([s.name, s.author, s.description, s.category].join(' ').toLowerCase())}">
            <td class="name"><a href="${esc(s.url)}">${esc(s.name)}</a>${s.official ? '<span class="tag-official">Official</span>' : ''}<p>${esc(s.description)}</p></td>
            <td class="who">${esc(s.author)}</td>
            <td class="cat">${KIND[s.category] || esc(s.category)}</td>
            <td class="num" title="${(s.stars || 0).toLocaleString('en-US')} stars on ${esc(s.repo)}">${fmtStars(s.stars)}</td>
            <td><button class="copy" type="button" data-copy="${esc(s.install)}" aria-label="Copy install command for ${esc(s.name)}">Copy install</button></td>
          </tr>`).join('');
const lists = (community.lists || []).map((l) => `<a href="${esc(l.url)}">${esc(l.name)}</a>`).join('');

// ── Write index
const tpl = fs.readFileSync(path.join(site, 'index.template.html'), 'utf8');
const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
fs.writeFileSync(path.join(site, 'index.html'), fill(tpl, { base: '', header: header(''), footer: footer(''), skills: skillRows, catalog: catalogRows, lists }));

// ── Write skill pages
fs.rmSync(path.join(site, 'skills'), { recursive: true, force: true });
for (const s of skills) {
  const base = '../../';
  const out = path.join(site, 'skills', s.name);
  fs.mkdirSync(out, { recursive: true });
  const others = skills.filter((o) => o.name !== s.name).map((o) => `<li><a href="../${o.name}/">${esc(o.title)}</a></li>`).join('');
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(s.title)} · Knack</title>
<meta name="description" content="${esc(s.summary || s.tagline)}" />
<meta property="og:title" content="${esc(s.title)} · Knack" />
<meta property="og:description" content="${esc(s.summary || s.tagline)}" />
<meta property="og:image" content="https://mayank2424.github.io/knack/assets/og.png" />
<meta name="theme-color" content="#fafafa" />
<link rel="icon" href="${base}assets/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="${base}styles.css" />
</head>
<body>
${header(base, 'skills')}
<main id="main">
  <header class="doc-head"><div class="wrap">
    <p class="crumbs"><a href="${base}#skills">Skills</a> / ${esc(s.title)}</p>
    <h1>${esc(s.title)}</h1>
    <p class="lede">${esc(s.tagline || s.summary)}</p>
  </div></header>
  <div class="wrap doc-grid">
    <article class="prose">
      ${s.evidence ? evidence(s, base) : ''}
      ${s.html}
    </article>
    <aside class="doc-aside" aria-label="Install and details">
      <section>
        <h2>Install</h2>
        <div class="cmd"><code>npx skills add ${REPO} --skill ${s.name}</code>${copyIcon('Copy install command')}</div>
        <div class="cmd"><code>/plugin install knack@knack</code>${copyIcon('Copy install command')}</div>
      </section>
      <section>
        <h2>Details</h2>
        <dl>
          <dt>Category</dt><dd>${KIND[s.kind] || s.kind}</dd>
          <dt>Version</dt><dd>${esc(s.version)}</dd>
          ${s.model ? `<dt>Model</dt><dd>${s.model === 'opus' ? 'Claude Opus' : esc(s.model)}</dd>` : ''}
          <dt>Scripts</dt><dd>${s.scripts.map((f) => `<code>${esc(f)}</code>`).join(' ')}</dd>
          <dt>License</dt><dd>MIT</dd>
        </dl>
      </section>
      <section>
        <h2>Links</h2>
        <ul><li><a href="${GH}/tree/main/skills/${s.name}">Source on GitHub</a></li><li><a href="${GH}/blob/main/skills/${s.name}/SKILL.md">SKILL.md</a></li></ul>
      </section>
      <section>
        <h2>Other skills</h2>
        <ul>${others}</ul>
      </section>
    </aside>
  </div>
</main>
${footer(base)}
<script src="${base}app.js" defer></script>
</body>
</html>
`);
}

// Old client-rendered data file is no longer used.
fs.rmSync(path.join(site, 'data'), { recursive: true, force: true });
console.log(`◆ Built site/index.html + ${skills.length} skill pages (${community.skills.length} catalog entries)`);
