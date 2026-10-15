---
name: a11y-audit
description: >-
  Runs a real accessibility audit on a web page or local app and fixes the
  findings in source. Injects axe-core (WCAG 2.0/2.1/2.2 A+AA) with Playwright,
  then does what axe cannot: a keyboard pass that Tabs through the page to
  record focus order, detect focus traps, missing visible focus indicators,
  clickable divs that keyboard users cannot reach, and focus landing on hidden
  elements. Produces report.md grouped by impact with fix recipes, report.json,
  and an annotated screenshot. Includes a contrast checker that suggests the
  nearest passing color. Use when the user asks to "audit my app for
  accessibility", "check a11y", "is this WCAG AA compliant?", "fix contrast
  issues", "make this keyboard accessible", "check focus states", "run axe",
  "screen reader friendly?", or after generating or redesigning UI that should
  be accessible.
license: MIT
argument-hint: "[url-or-file] [--pages /a,/b]"
metadata:
  title: A11y Audit
  category: design
  tags: accessibility, a11y, wcag, axe-core, keyboard, contrast, playwright
  version: 0.1.0
  author: Mayank Gupta
---

# A11y Audit

Measure first, fix in source, re-measure. Never declare a page accessible from reading code alone.

Scripts live in `${CLAUDE_SKILL_DIR}/scripts/` (below: `$S`). Output goes to `./.knack/a11y-audit/` in the user's project.

## 1. Setup (once)

```bash
bash "$S/setup.sh"        # installs playwright 1.63.0 + axe-core 4.13.0 next to the scripts, plus Chromium
```

If Chromium download is blocked, the audit falls back to installed Chrome or Edge.

## 2. Get a URL

- User gave a URL or an `.html` file path: use it.
- Otherwise find the dev server: check `package.json` scripts (`dev`, `start`, `preview`), the framework default port (Vite 5173, Next 3000, Astro 4321, SvelteKit 5173, Angular 4200, CRA 3000), and whether something already listens: `lsof -iTCP -sTCP:LISTEN -nP | grep node`.
- Not running? Start it in the background yourself (e.g. `npm run dev`), wait for the port, then audit. Static build output (`dist/index.html`) also works directly.
- Pick the 1–5 pages that matter (home, a form, a list/detail, auth). Use `--pages` for the rest.

## 3. Run the audit

```bash
node "$S/audit.mjs" http://localhost:5173 --pages /pricing,/login
```

Useful flags (full list: `--help`):

| Flag | Use |
|---|---|
| `--state "#menu-btn"` | Also audit after clicking something (menu, modal, accordion). Repeatable. |
| `--mobile` | Phone viewport + touch (catches target-size, hidden mobile menus). |
| `--viewport 320x800` | Approximates 400% zoom reflow. |
| `--fail-on serious` | Exit 2 if any critical/serious remain (CI, or your own loop). |
| `--exclude "#intercom"` | Skip third-party widgets you cannot change. |
| `--tags wcag2a,wcag2aa` | Narrow the rule set (default adds WCAG 2.1/2.2 AA + best-practice). |
| `--json` | report.json to stdout. |

The run prints a one-line summary per page and the paths of `report.md`, `report.json`, and `<page>.annotated.png`.

## 4. Read the evidence (required)

1. Read `report.md`. Rules are grouped critical → serious → moderate → minor and deduplicated; each has the failing selectors, HTML snippet, why it failed, and a one-line fix.
2. **Look at `<page>.annotated.png`** with the Read tool. Solid boxes = axe findings, dashed = keyboard pass, blue numbered badges = focus order, magenta badges = focused but no visible indicator, "Page-level" line = rules about the whole document. Check that the focus order follows the visual reading order; the numbers make jumps obvious.
3. The keyboard table in `report.md` lists every focus stop. A trap shows which elements can never be reached.

## 5. Map each finding to source

Reports show the rendered DOM, so find the component that renders it:

- Search for the most specific thing in the snippet: an `id`, unusual class, visible text, `aria-*` value, `placeholder`, `href`. `rg -n "Start free trial|btn-ghost" src/`.
- **React/Next/JSX**: `className` not `class`, `htmlFor` not `for`; the element is often inside a shared component (`Button`, `Card`, `Input`). Fix the shared component once, not every call site. Check UI kits (shadcn/ui, Radix, MUI, Headless UI) for the prop that does it (e.g. `DialogTitle`, `aria-label` passthrough).
- **Vue/Nuxt**: `.vue` single-file components; `:for`, `@click`. **Svelte/SvelteKit**: `on:click`/`onclick` on a `<div>` is the usual kbd-unreachable culprit (Svelte's own a11y warnings point at it too).
- **Tailwind**: colors come from classes (`text-gray-400`) or theme tokens (`--muted-foreground`, `tailwind.config` / `@theme`). Fix the token when many elements share it. `outline-none`/`focus:outline-none` without a `focus-visible:ring-*` replacement causes kbd-focus-not-visible.
- **CSS-in-JS / global CSS**: grep for `outline: none`, `outline: 0`, `:focus {`.

## 6. Fix, in priority order

Work critical → serious → moderate. For each rule, open `references/fix-recipes.md#<rule-id>` (before/after for HTML, JSX, Tailwind) when the one-line fix is not enough.

Principles:

1. **Semantic HTML first.** `<button>` for actions, `<a href>` for navigation, `<label for>` for fields, `<header>/<nav>/<main>/<footer>` landmarks, `<dialog>` for modals, real heading levels. These fix role, name, keyboard, and focus at once.
2. **No ARIA is better than bad ARIA.** Add ARIA only when no native element fits, and then keep its state in sync (`aria-expanded={open}`). Never put `role="button"` on a div you could make a button.
3. **Contrast**: run `node "$S/contrast.mjs" "<fg>" "<bg>"` (the report prints the exact command per failing node). It returns the nearest passing color with the same hue (OKLCH lightness only). Prefer changing the design token. Use `--large` for ≥24px (or ≥18.66px bold) text and `--target 3` for focus rings, borders, and icons (WCAG 1.4.11).
4. **Focus**: never just delete `outline`; give `:focus-visible` a 2–3px ring with 3:1 contrast.
5. Keep visual design intact. If a fix needs a visible change (darker text, visible label), make the smallest change that passes and mention it.
6. Do not invent alt text you cannot infer. Write the best alt you can from context and list it for the human to confirm.

## 7. Re-run until clean

```bash
node "$S/audit.mjs" <same args> --fail-on serious
```

Loop steps 4–7 until zero critical and serious issues (exit code 0). Re-read the annotated screenshot after the final run to confirm the focus order and that every badge is blue. Moderate/minor: fix the cheap ones; list the rest.

Heuristic checks can misfire. If you believe a finding is a false positive (e.g. a focus indicator the pixel diff missed), verify by looking at it, say why in the hand-off, and do not hack around the detector.

## 8. Report back

Tell the user, briefly:

- **Before → after**: counts by impact from the first and last runs, and the pages/states covered.
- **What changed**: files touched and the kind of fix (e.g. "4 div buttons → `<button>` in `Nav.tsx`", "muted text token #a3a8b5 → #727683").
- **Needs human judgment**: alt text you wrote (confirm meaning), reading order, captions/transcripts, copy changes, anything excluded, and axe "needs review" items.
- **Honesty line**: automated checks catch roughly 30–50% of issues. Give them the short manual checklist from `references/manual-checks.md`: screen reader smoke test (VoiceOver: Cmd+F5 / NVDA), keyboard-only walk-through, zoom to 200% and 400% (reflow), reduced motion, captions. Say which of these you could not do yourself.

## What the tools check

- **axe-core 4.13** (injected, CSP bypassed): ~90 rules for names, labels, contrast, ARIA validity, landmarks, headings, lang, viewport zoom, target size.
- **Keyboard pass**: real Tab presses (up to `--max-tabs`), focus order, traps (cycle that never reaches the rest of the page; open modal dialogs are reported as intended), visible focus (screenshot of each control before vs after focus, pixel diff, with an ancestor fallback for card/`:has()` rings), focus on invisible elements, clickable-but-unfocusable elements (cursor:pointer, onclick, interactive role, or a real click listener via DevTools protocol), backwards focus jumps.
- **Extra**: inputs labelled only by a placeholder (axe accepts these; WCAG 3.3.2 does not).

## Limits

- One browser engine (Chromium). Safari/VoiceOver quirks need a manual check.
- Cross-origin iframes are only partly covered; closed shadow roots not at all.
- Click-handler detection is heuristic: delegated handlers with no pointer cursor are missed.
- No check for meaning (good alt text, logical reading order, clear errors) or for media captions. That is the human part.
