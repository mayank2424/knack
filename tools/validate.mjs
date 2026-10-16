#!/usr/bin/env node
/**
 * Validates every skill in skills/ against the Agent Skills spec and Knack's
 * own conventions (see CONTRIBUTING.md). Exits non-zero on any error.
 *
 *   node tools/validate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkill } from './validate-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(root, 'skills');
const CATEGORIES = ['media', 'design', 'dev'];
const errors = [];
const warnings = [];
const err = (skill, msg) => errors.push(`${skill}: ${msg}`);
const warn = (skill, msg) => warnings.push(`${skill}: ${msg}`);


const names = fs.readdirSync(skillsDir).filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory()).sort();

for (const name of names) {
  const dir = path.join(skillsDir, name);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { err(name, 'missing SKILL.md'); continue; }
  let skill;
  try { skill = readSkill(dir); } catch (e) { err(name, e.message); continue; }
  const { data, body, src } = skill;

  // Agent Skills spec
  if (data.name !== name) err(name, `frontmatter name "${data.name}" must match folder name`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name || '') || (data.name || '').length > 64) err(name, 'name must be 1-64 chars of a-z, 0-9 and single hyphens');
  if (typeof data.description !== 'string' || !data.description.trim()) err(name, 'description is required');
  else if (data.description.length > 1024) err(name, `description is ${data.description.length} chars (max 1024)`);
  else if (!/\buse (when|for|this)\b/i.test(data.description)) warn(name, 'description should say when to use the skill (e.g. "Use when ...")');
  if (data.metadata && Object.values(data.metadata).some((v) => typeof v !== 'string')) err(name, 'metadata values must all be strings (spec)');

  // Knack conventions
  const md = data.metadata || {};
  if (!md.title) err(name, 'metadata.title is required (website display name)');
  if (!CATEGORIES.includes(md.category)) err(name, `metadata.category must be one of ${CATEGORIES.join(', ')}`);
  if (!/^\d+\.\d+\.\d+$/.test(md.version || '')) err(name, 'metadata.version must be semver');
  if (data.license !== 'MIT') warn(name, 'license should be MIT');
  const lines = src.split('\n').length;
  if (lines > 500) err(name, `SKILL.md is ${lines} lines (keep it under 500; move detail to references/)`);
  for (const f of ['README.md', 'assets/preview.png']) if (!fs.existsSync(path.join(dir, f))) err(name, `missing ${f}`);

  // Every referenced bundled file must exist.
  const refs = new Set();
  for (const m of body.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/g)) refs.add(m[1].replace(/[.,)]+$/, ''));
  for (const m of body.matchAll(/`((?:references|scripts|templates|examples)\/[\w./-]+)`/g)) refs.add(m[1]);
  for (const r of refs) {
    if (r.includes('*') || r.includes('<')) continue;
    if (!fs.existsSync(path.join(dir, r))) err(name, `SKILL.md references missing file: ${r}`);
  }
  // Worked examples (EXAMPLES_SPEC.md): 2–4 per skill, every media file present and within budget.
  const exFile = path.join(dir, 'examples', 'examples.json');
  if (!fs.existsSync(exFile)) warn(name, 'no examples/examples.json (see EXAMPLES_SPEC.md)');
  else {
    let ex;
    try { ex = JSON.parse(fs.readFileSync(exFile, 'utf8')).examples; } catch (e) { err(name, `examples.json: ${e.message}`); ex = []; }
    if (!Array.isArray(ex) || ex.length < 2 || ex.length > 4) warn(name, `examples.json should list 2–4 examples (has ${ex?.length ?? 0})`);
    const ids = new Set();
    let total = 0;
    for (const e of ex || []) {
      for (const k of ['id', 'title', 'summary', 'media']) if (!e[k]) err(name, `example "${e.id || '?'}" is missing "${k}"`);
      if (ids.has(e.id)) err(name, `duplicate example id "${e.id}"`); ids.add(e.id);
      for (const m of e.media || []) {
        const f = path.join(dir, 'examples', m.src || '');
        if (!m.src || !fs.existsSync(f)) { err(name, `example "${e.id}" media not found: ${m.src}`); continue; }
        const kb = fs.statSync(f).size / 1024; total += kb;
        const limit = m.type === 'video' ? 4096 : m.type === 'gif' ? 3072 : 500;
        if (kb > limit) warn(name, `example media ${m.src} is ${Math.round(kb)} KB (budget ${limit} KB)`);
        if (!m.alt && m.type !== 'video') warn(name, `example media ${m.src} has no alt text`);
      }
      for (const f of e.input || []) if (!fs.existsSync(path.join(dir, 'examples', f))) err(name, `example "${e.id}" input not found: ${f}`);
    }
    const budget = (ex || []).some((e) => (e.media || []).some((m) => m.type === 'video')) && data.metadata?.category === 'media' ? 16384 : 8192;
    if (total > budget) warn(name, `example media totals ${Math.round(total / 1024)} MB (budget ${budget / 1024} MB)`);
  }

  if (fs.existsSync(path.join(dir, 'scripts', 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'scripts', 'package.json'), 'utf8'));
    for (const [dep, v] of Object.entries(pkg.dependencies || {})) if (/^[\^~*]|latest/.test(v)) warn(name, `dependency ${dep}@${v} should be pinned to an exact version`);
  }
}

// Marketplace must list every skill exactly once.
const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const listed = market.plugins.flatMap((p) => p.skills || []).map((s) => path.basename(s));
for (const n of names) if (!listed.includes(n)) errors.push(`marketplace.json: skill "${n}" is not listed in any plugin`);
for (const l of listed) if (!names.includes(l)) errors.push(`marketplace.json: lists "${l}" but skills/${l} does not exist`);

warnings.forEach((w) => console.log(`\x1b[33m⚠\x1b[0m ${w}`));
errors.forEach((e) => console.log(`\x1b[31m✖\x1b[0m ${e}`));
if (errors.length) { console.log(`\n${errors.length} error(s) across ${names.length} skills.`); process.exit(1); }
console.log(`\x1b[32m✓\x1b[0m ${names.length} skills valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
