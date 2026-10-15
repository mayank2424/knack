import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** Parse a skill folder's SKILL.md into { data (frontmatter), body, src }. */
export function readSkill(dir) {
  const src = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md has no YAML frontmatter');
  return { data: YAML.parse(m[1]) || {}, body: m[2], src };
}
