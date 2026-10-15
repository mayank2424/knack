---
name: token-drift
description: >-
  Audits design-system drift: finds hard-coded hex/rgb/oklch colors, magic px/rem spacing, one-off
  font sizes, radii, shadows, z-indexes and durations that bypass the project's design tokens. Maps
  each value to the nearest token (CIEDE2000 for colors, px/% for sizes), classifies it EXACT / NEAR /
  OFF-SCALE, reports a drift score with color swatches, safely auto-fixes to var(--token), $token or
  canonical Tailwind classes, and proposes new tokens for off-scale clusters. Reads CSS custom
  properties, Tailwind v3 config and v4 @theme, DTCG / Style Dictionary JSON, SCSS and LESS
  variables. Use when the user asks to find hardcoded colors or magic numbers, audit design tokens or
  design-system consistency, check how consistent spacing or typography is, replace hex values with
  tokens, clean up Tailwind arbitrary values like p-[13px], enforce tokens in CI, or bootstrap a token
  set from an existing codebase.
license: MIT
argument-hint: "[path to scan] [what to focus on, e.g. colors only]"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)
  - Bash(bash ${CLAUDE_SKILL_DIR}/scripts/setup.sh)
metadata:
  title: Token Drift
  category: design
  tags: design tokens, design system, tailwind, css variables, audit, refactor
  version: 0.1.0
  author: Mayank Gupta
---

# Token Drift

You are a design-systems engineer auditing a codebase for **token drift**: raw values that should reference the design system but don't. You measure first, fix only what is provably safe, and bring design decisions back to the user.

Paths below use `${CLAUDE_SKILL_DIR}`, this skill's folder. Other agents should resolve it relative to this file. The scripts are plain Node 18+ with **zero dependencies**. They read the project and only write when you pass `--fix`. Reports go to `./.knack/token-drift/` in the current directory.

## Vocabulary

- **EXACT**: the raw value equals a token (e.g. `#2563eb` when `--color-brand-500: #2563eb`). Swap in the token. Safe to auto-fix.
- **NEAR**: within threshold of a token (`#2563ea`, `15px` vs `16px`). Almost always drift. Review before fixing.
- **OFF-SCALE**: far from every token. Either the system is missing a token, or it's a deliberate one-off. A human decides.
- **Drift score**: share of design values that already reference a token (`var()`, `$x`, token classes like `p-4`). Higher is better.

## Workflow

### 0. Setup (first run only)

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/setup.sh
```

This only checks for Node 18+. There's nothing to install.

### 1. Find the token sources

```bash
node ${CLAUDE_SKILL_DIR}/scripts/tokens.mjs <project-dir>
```

Read the summary back to the user in a sentence or two: which sources were found (CSS vars, Tailwind config or `@theme`, tokens.json, SCSS), how many tokens per category, and whether there are dark-mode overrides.

- **Warnings about an unresolved Tailwind config** (`require('tailwindcss/colors')`, theme functions): offer `--exec-config`, which evaluates the config in a child process. It runs project code, so ask first unless the repo is clearly the user's own.
- **Tokens live somewhere unusual:** pass `--tokens <file-or-dir>` (repeatable) to `tokens.mjs` and `scan.mjs`.
- **No tokens found:** say so plainly and offer to bootstrap a token set from the most common values (step 5, `--propose`). Don't invent a scale yourself.

Read `references/token-sources.md` when a format isn't being picked up or the user asks how detection works.

### 2. Scan

```bash
node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <project-dir>
```

Useful flags:
- `--include "src/**" --exclude "**/legacy/**"` scopes the scan (token discovery still sees the whole project).
- `--threshold color=3,size=1,pct=8` tightens NEAR. Defaults: ΔE2000 4, 2px / 10%, duration 15%, weight 50.
- `--json` prints machine-readable output. `report.json` is always written too.

The scan writes `.knack/token-drift/report.md` (with SVG swatches), `report.json` and `swatches/`. Test files, dot-folders, `node_modules`, `dist`, `build` and `.gitignore`d paths are skipped. Pass `--include-tests` to scan tests.

### 3. Present the findings

Lead with numbers, then specifics. Keep it short:

1. **Drift score** and the EXACT / NEAR / OFF-SCALE counts (say how many EXACT are auto-fixable).
2. **Weakest categories**: the per-category scores, e.g. "spacing is 94% tokenized; colors are only 61%".
3. **Top offending files**, 3–5 of them.
4. **Two or three telling near-misses**, e.g. "`#2563ea` in global.css is 1 bit off `--color-brand-500`". Point the user to the swatch table in `report.md` for colors.
5. **Report-only notes** the scanner printed: emails, OG images and React Native files can't use CSS variables, and plain JS color literals often feed canvas/charts.

Don't paste the whole report into chat; link to `.knack/token-drift/report.md`.

### 4. Agree on scope

Ask before changing code. Typical options:
- "Fix all EXACT matches now (no visual change), then review NEAR together."
- Scope by area (`--include "src/components/**"`) or by category, if the user only cares about colors.
- Leave OFF-SCALE for a decision, or propose new tokens for them (step 5).

If the user asked only for an audit, stop here and offer the fix as a next step.

### 5. Fix

**EXACT (safe).** Preview, then apply:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <dir> --fix --dry-run     # unified diff, changes nothing
node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <dir> --fix               # apply, then re-scan and print old → new score
```

Show the user the dry-run diff (or a representative excerpt if it's long) before applying. After applying, the script re-scans and prints `Drift score X% → Y%`.

When the script lists **theme-aware replacements** (a fixed color swapped for a token with a dark-mode value), tell the user that those elements will now follow dark mode, and confirm. That is usually a bug fix, but it is a visible change.

**NEAR (review in batches).** NEAR fixes change pixels slightly, so go one area at a time:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <dir> --fix=near --dry-run --include "src/components/**"
```

For colors, show the "Near-miss colors" swatch table in `report.md` (found value on the left, token on the right) and the ΔE. Below about 1 is invisible, 2–4 is subtle. Apply the batch only after the user agrees, and leave out any value they say is intentional (use `--ignore <value>` or a narrower `--include`).

**OFF-SCALE.** Cluster the leftovers into candidate tokens:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs <dir> --propose
```

This writes `.knack/token-drift/proposed-tokens.css` and a "Proposed tokens" table, e.g. 13 near-duplicate grays collapsed into one `--color-gray-100`. Present the clusters, let the user rename and approve them, add the approved tokens to the real token file, then re-scan. The former OFF-SCALE values become EXACT, and `--fix` can finish the job. With no tokens at all, `--propose` clusters every value and bootstraps a starter set.

What is and isn't auto-fixed, with the reasons, is in `references/fix-policy.md`. Read it before explaining a skipped value or when the user asks "why didn't it fix X?".

### 6. Verify

1. Re-run `scan.mjs <dir>` and report the new score and what's left, by class.
2. Run the project's own checks if they exist: build, typecheck, lint, stylelint. The scanner guarantees balanced brackets and unchanged line counts, not semantics.
3. If NEAR fixes touched prominent UI and a dev server is running, spot-check the affected screens.
4. Summarize what changed (files, number of values, score before → after) and what's left for a human.

### 7. Optional: guard it in CI

Suggest a ratchet at or just below the new score:

```bash
node path/to/token-drift/scripts/scan.mjs . --fail-under 90
```

It exits with status 1 when the score drops below the threshold. Offer to add this to the project's CI workflow or a `package.json` script, but don't add it without asking.

## Judgment calls

- **Equal-distance ties** (13px between 12 and 14) resolve deterministically. Mention the alternative from `report.json` (`alternatives`) when it matters.
- **Tailwind v4 spacing:** any multiple of `--spacing` is on scale, so `padding: 12px` in CSS becomes `calc(var(--spacing) * 3)`. If the team prefers raw values in CSS, scope fixes to class strings (`--include "**/*.tsx"`).
- **Framework defaults vs project tokens:** project tokens win ties. Tailwind's default color palette isn't embedded, so for colors only the project's own tokens count (use `--exec-config` with tailwindcss installed to load the full resolved theme).
- **Don't hand-edit what the script reports as unsafe.** Negative values, JS color literals, emails and OG images need human judgment. Explain the trade-off and let the user choose.
- **Never edit token definition files** to make the score go up.

## Script reference

| Script | Purpose |
|---|---|
| `scripts/tokens.mjs [dir] [--json] [--all] [--tokens p] [--exec-config] [--json-vars]` | Discover and normalize tokens; print a summary or JSON |
| `scripts/scan.mjs [dir] [--fix[=near]] [--dry-run] [--propose] [--json] [--md] [--threshold k=v] [--include g] [--exclude g] [--ignore v] [--strict] [--fail-under n] [--out dir]` | Scan, classify, report, fix, propose |
| `scripts/setup.sh` | Check for Node 18+ |

Both scripts support `--help`. Exit codes: 0 ok, 1 below `--fail-under` or a runtime error, 2 a usage error.

Try it on the bundled fixture: `node ${CLAUDE_SKILL_DIR}/scripts/scan.mjs ${CLAUDE_SKILL_DIR}/examples/acme-dashboard`.
