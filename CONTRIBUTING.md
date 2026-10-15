# Contributing to Knack

Thanks for helping! Knack skills follow one rule above all others:

> **A skill must verify, not just advise.** Every skill ships deterministic scripts that measure, render, or check something real, so the agent can see its own output and fix it. Pure "best practices" prose belongs in a blog post.

## Skill anatomy

```
skills/<name>/
├── SKILL.md          # Instructions the agent loads (required, < 500 lines)
├── README.md         # For humans browsing GitHub: what, why, example prompts
├── scripts/          # Deterministic tooling the agent runs
│   ├── package.json  # Pinned deps (Playwright 1.63.0, etc.)
│   ├── setup.sh      # Idempotent one-time install; exits non-zero with a clear fix
│   └── *.mjs         # Node 18+ ESM. Every script supports --help.
├── references/       # Deep-dive docs loaded only when needed (progressive disclosure)
├── examples/         # A tiny fixture users can try the skill on
└── assets/preview.png  # 1600×1000 image shown on the website card
```

## SKILL.md frontmatter

```yaml
---
name: a11y-audit                 # a-z, 0-9, hyphens; must match the folder; ≤ 64 chars
description: >-                  # ≤ 1024 chars. What it does + WHEN to use it (trigger phrases).
  Runs a real accessibility audit ...
license: MIT
metadata:                        # string values only (Agent Skills spec)
  title: A11y Audit              # display name on the website
  category: design               # media | design | dev
  tags: accessibility, wcag, playwright
  version: 0.1.0
  author: Mayank Gupta
---
```

Claude Code-specific fields (`model`, `effort`, `allowed-tools`, `argument-hint`) are fine to add; other agents ignore them.

## Writing guidelines

- **Lead with the workflow.** Numbered steps the agent follows, with the exact commands. Reference scripts as `${CLAUDE_SKILL_DIR}/scripts/x.mjs` (Claude Code substitutes the skill directory; other agents resolve it relative to SKILL.md).
- **Close the loop.** After acting, the agent must look at evidence (a screenshot, a contact sheet, a JSON report) and iterate.
- **Progressive disclosure.** Keep SKILL.md tight; push long tables, rubrics, and API docs into `references/` and tell the agent when to read them.
- **Fail loudly and helpfully.** Scripts print a one-line fix when a dependency is missing.
- **No telemetry, no network calls** beyond what the task needs (e.g. loading the page under test).
- **Output location.** Scratch output (reports, frames) goes to `./.knack/<skill>/` in the user's project; deliverables (videos, GIFs) go somewhere visible like `./videos/`. Never write into the skill folder.

## Testing a skill locally

```bash
# Symlink into your personal skills folder
ln -s "$PWD/skills/<name>" ~/.claude/skills/<name>
# Validate metadata for every skill
node tools/validate.mjs
```

Then ask Claude something that should trigger it and check it picks the skill up.

## Pull requests

- One skill (or one fix) per PR.
- Include a screenshot of the skill's output in the PR description.
- Run `node tools/validate.mjs` before pushing; CI runs it too.
