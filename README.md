<div align="center">

<img src="site/assets/favicon.svg" width="64" height="64" alt="Knack logo" />

# Knack

**Agent skills that show their work.**

Open-source agent skills for developers and designers. Each one ships real tooling (Playwright, axe-core, ffmpeg, pixel diffs) so your agent can see its own output and fix it before you ever look.

[Website](https://knack.mayankbuilds.com/) · [Skills](#skills) · [Install](#install) · [Contributing](CONTRIBUTING.md)

[![Validate skills](https://github.com/mayank2424/knack/actions/workflows/validate.yml/badge.svg)](https://github.com/mayank2424/knack/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff5a1f.svg)](LICENSE)
[![Agent Skills](https://img.shields.io/badge/format-Agent%20Skills-111?logo=anthropic)](https://agentskills.io)

<img src="site/assets/knack-promo.gif" width="720" alt="Knack promo video, made with the motion-video skill" />

<sub>This video was made by the <a href="skills/motion-video">motion-video</a> skill. <a href="skills/motion-video/examples/knack-promo">See its source.</a></sub>

</div>

---

## Skills

| Skill | What it does | Category |
|---|---|---|
| [**Motion Video**](skills/motion-video) | Storyboard → HTML composition → frame-accurate MP4, GIF, WebM or transparent MOV. Reviews its own filmstrips. Pinned to Claude Opus. | media |
| [**Demo Recorder**](skills/demo-recorder) | Records polished GIF/MP4 demos of real app flows, with a smooth synthetic cursor, for READMEs, PRs and social. | media |
| [**Responsive QA**](skills/responsive-qa) | Sweeps breakpoints and auto-detects overflow, clipped text, overlaps and tiny tap targets, then fixes the root causes. | design |
| [**A11y Audit**](skills/a11y-audit) | Runs axe-core and a keyboard pass, annotates violations, fixes them in source, and checks contrast with suggested colors. | design |
| [**Token Drift**](skills/token-drift) | Finds hard-coded colors and spacing that bypass your design tokens, maps them to the nearest token, and auto-fixes safely. | design |
| [**PR Visual Diff**](skills/pr-visual-diff) | Captures before/after screenshots for a frontend PR, pixel-diffs them, and writes the PR description section. | dev |

Every skill follows the same loop: **act → measure → look at the evidence → fix → repeat**. That loop is the difference between "the agent says it's done" and "it's done".

## Install

### Claude Code (plugin)

```text
/plugin marketplace add mayank2424/knack
/plugin install knack@knack
```

Skills are then available as `/knack:motion-video`, `/knack:a11y-audit` and so on. Claude also picks them up automatically when your request matches.

### Any agent (`npx skills`)

Works with Claude Code, Codex, Cursor, Gemini CLI, OpenCode and 40+ other agents:

```bash
npx skills add mayank2424/knack                        # all skills
npx skills add mayank2424/knack --skill motion-video   # just one
```

### Manual

```bash
git clone https://github.com/mayank2424/knack
cp -r knack/skills/motion-video ~/.claude/skills/      # or .claude/skills/ inside a project
```

### Requirements

- **Node 18+** for all skills.
- **Chromium via Playwright** for the browser-based skills. Each skill's `scripts/setup.sh` installs it on first use.
- **ffmpeg** for `motion-video` and `demo-recorder`: `brew install ffmpeg` on macOS, `apt install ffmpeg` on Ubuntu.

## Try it

Once installed, just ask:

> *"Make a 12-second launch video for our v2 release using our brand colors."*
> *"Record a GIF of the signup flow for the README."*
> *"Check the landing page on mobile and fix anything that breaks."*
> *"Audit the dashboard for accessibility and fix the serious issues."*
> *"How much of our CSS actually uses the design tokens?"*
> *"Add before/after screenshots to this PR."*

## How a Knack skill is built

```
skills/<name>/
├── SKILL.md        ← instructions the agent follows (workflow, rules, commands)
├── scripts/        ← deterministic tooling: renders, audits, diffs, scanners
├── references/     ← deep-dive docs loaded only when needed
├── examples/       ← a tiny fixture you can run the skill on
└── README.md       ← for humans
```

Skills use the open [Agent Skills](https://agentskills.io) format. Plain Markdown with YAML frontmatter, plus scripts. No SDK, no runtime, no telemetry. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full conventions.

## Popular skills from the ecosystem

The [website](https://knack.mayankbuilds.com/#community) also keeps a curated, star-ranked list of the best third-party skills: Anthropic's official set, Superpowers, Vercel, Remotion, HyperFrames and more. The list lives in [`catalog/community.json`](catalog/community.json), and PRs to add great skills are welcome.

## Repository layout

```
.claude-plugin/marketplace.json   Claude Code plugin marketplace manifest
skills/                           the skills
catalog/community.json            curated third-party skills for the website
site/                             GitHub Pages website (static, no framework)
tools/validate.mjs                spec + convention checks (runs in CI)
tools/build-site.mjs              builds site data from SKILL.md and README files
```

Develop the site locally:

```bash
npm install
npm run dev        # builds catalog + serves site/ on http://localhost:3150
npm run validate
```

## Contributing

New skills are welcome if they **verify their own work**. Read [CONTRIBUTING.md](CONTRIBUTING.md), then open a PR or a [skill request](https://github.com/mayank2424/knack/issues/new?template=skill-request.yml).

## License

[MIT](LICENSE) © Mayank Gupta
