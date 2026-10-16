---
name: a11y-audit
description: >-
  Runs a real accessibility audit on a web page or local app and fixes the
  findings in source. Injects axe-core (WCAG 2.0/2.1/2.2 A+AA) with Playwright,
  then does what axe cannot: a keyboard pass that Tabs through the page to
  record focus order and traps, measure visible focus by pixel diff, and catch
  focus removed by scripts, focus hidden under sticky bars (2.4.11), clickable
  divs keyboard users cannot reach, hover-only menus, selects that navigate on
  change, and modals that ignore Escape. Produces report.md (prioritized,
  stack-aware fixes, grep hints), report.json, and an annotated screenshot.
  Includes a contrast checker that suggests the nearest passing color. Use when
  the user asks to "audit my app for accessibility", "check a11y", "is this
  WCAG AA compliant?", "fix contrast issues", "make this keyboard accessible",
  "check focus states", "run axe", "screen reader friendly?", or after
  generating or redesigning UI that should be accessible.
license: MIT
argument-hint: "[url-or-file] [--pages /a,/b]"
metadata:
  title: A11y Audit
  category: design
  tags: accessibility, a11y, wcag, axe-core, keyboard, contrast, playwright
  version: 0.2.0
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
| `--verbose` | Phase timings on stderr (when a page seems slow or stuck). |

For a modal, `--state "<button that opens it>"` also checks that Escape closes it and focus returns to that button.

The run prints a one-line summary per page and the paths of `report.md`, `report.json`, and `<page>.annotated.png` (long pages also get readable `<page>.annotated.partN.png` slices).

## 4. Read the evidence (required)

1. Read `report.md`. It opens with **Fix first** (highest impact, most elements per fix) and any **Coverage warnings** (iframes skipped, Tab cycle cut short, page JS errors): mention those in the hand-off. Rules follow critical → minor; identical markup is grouped ("and 12 more with identical markup" = one shared component), each with the HTML snippet, why it failed, the fix, a stack-specific note when the framework was detected, and a `rg` hint.
2. **Look at the annotated screenshot** with the Read tool (the `.partN.png` slices on long pages; the full image is too tall to read). Solid boxes = axe findings, dashed = keyboard pass, blue numbered badges = focus order, magenta = no visible focus (or focus removed by script), gray = not measured (iframe). Check that the numbers follow the visual reading order.
3. The keyboard table lists every focus stop with its visible-focus verdict (`yes (via …)` says where the indicator was found), `removed by script`, and `covered by <selector>` for 2.4.11.
## 5. Map each finding to source

Reports show the rendered DOM, so find the component that renders it:

- Start from the report's `find in source: rg -n -F "…"` hint (an id, aria-label, placeholder, href, distinctive class, or the element's first text). Otherwise search for the most specific thing in the snippet. `rg -n "Start free trial|btn-ghost" src/`.
- **React/Next/JSX**: `className` not `class`, `htmlFor` not `for`; the element is often inside a shared component (`Button`, `Card`, `Input`). Fix the shared component once, not every call site. Check UI kits (shadcn/ui, Radix, MUI, Headless UI) for the prop that does it (e.g. `DialogTitle`, `aria-label` passthrough).
- **Vue/Nuxt**: `.vue` single-file components; `:for`, `@click`. **Svelte/SvelteKit**: `on:click`/`onclick` on a `<div>` is the usual kbd-unreachable culprit (Svelte's own a11y warnings point at it too).
- **Tailwind**: colors come from classes (`text-gray-400`) or theme tokens (`--muted-foreground`, `tailwind.config` / `@theme`). Fix the token when many elements share it. `outline-none`/`focus:outline-none` without a `focus-visible:ring-*` replacement causes kbd-focus-not-visible.
- **CSS-in-JS / global CSS**: grep for `outline: none`, `outline: 0`, `:focus {`.

## 6. Fix, in priority order

Work critical → serious → moderate. For each rule, open `references/fix-recipes.md#<rule-id>` (before/after for HTML, JSX, Tailwind) when the one-line fix is not enough.

Principles:

1. **Semantic HTML first.** `<button>` for actions, `<a href>` for navigation, `<label for>` for fields, `<header>/<nav>/<main>/<footer>` landmarks, `<dialog>` for modals, real heading levels. These fix role, name, keyboard, and focus at once.
2. **No ARIA is better than bad ARIA.** Add ARIA only when no native element fits, and then keep its state in sync (`aria-expanded={open}`). Never put `role="button"` on a div you could make a button.
3. **Contrast**: run `node "$S/contrast.mjs" "<fg>" "<bg>"` (the report prints the exact command per failing node). It returns the nearest passing color that keeps the hue (grays stay gray), with its OKLab distance ΔE (≈0.02 is just noticeable). Ratios are truncated, never rounded up. Prefer changing the design token. Use `--large` for ≥24px (or ≥18.66px bold) text and `--target 3` for focus rings, borders, and icons (WCAG 1.4.11).
4. **Focus**: never just delete `outline`; give `:focus-visible` a 2–3px ring with 3:1 contrast.
5. Keep visual design intact. If a fix needs a visible change (darker text, visible label), make the smallest change that passes and mention it.
6. Do not invent alt text you cannot infer. Write the best alt you can from context and list it for the human to confirm.

## 7. Re-run until clean

```bash
node "$S/audit.mjs" <same args> --fail-on serious
```

Loop steps 4–7 until zero critical and serious issues (exit code 0). Re-read the annotated screenshot after the final run to confirm the focus order and that every badge is blue. Moderate/minor: fix the cheap ones; list the rest.

Heuristic checks can misfire. If you believe a finding is a false positive (e.g. a focus indicator the pixel diff missed), verify by looking at it, say why in the hand-off, and do not hack around the detector (never add a fake focus style or a dummy tabindex just to silence a rule).

## 8. Report back

Tell the user, briefly:

- **Before → after**: counts by impact from the first and last runs, and the pages/states covered.
- **What changed**: files touched and the kind of fix (e.g. "4 div buttons → `<button>` in `Nav.tsx`", "muted text token #a3a8b5 → #727683").
- **Needs human judgment**: alt text you wrote (confirm meaning), reading order, captions/transcripts, copy changes, anything excluded, and axe "needs review" items.
- **Honesty line**: automated checks find only part of the barriers (GDS's 142-barrier test: best tool 40%, axe 29%; Deque counts 57% by issue volume). A clean run is not "WCAG compliant". Give them the short manual checklist from `references/manual-checks.md`: screen reader smoke test (VoiceOver: Cmd+F5 / NVDA), keyboard walk-through including Shift+Tab, zoom to 200% and 400% (reflow), reduced motion, captions. Say which of these you could not do yourself. Never suggest an accessibility overlay widget as a fix.

## What the tools check

- **axe-core 4.13** (injected, CSP bypassed, lazy iframes loaded first): ~90 rules for names, labels, contrast, ARIA validity, landmarks, headings, lang, viewport zoom, target size.
- **Keyboard pass** (real Tab presses, up to `--max-tabs`):
  - focus order, traps (a cycle that never reaches the rest of the page; open modals are reported as intended), positive tabindex, backwards visual jumps;
  - visible focus: screenshot before vs after focus, pixel diff on the element, then a changed ancestor (card rings via `:has`/`:focus-within`), the `<label>` of a visually hidden native input, then any change within 160px (sibling indicators); fixed/sticky layers are hidden while measuring;
  - `kbd-focus-removed`: focus arrives and a script blurs it (F55); the pass continues instead of stopping there;
  - `kbd-focus-obscured` (2.4.11): the focused element is entirely covered by an opaque fixed/sticky layer;
  - `kbd-unreachable`: cursor:pointer, onclick, interactive role, or a real click listener (DevTools protocol) on something Tab never reaches; focus landing on invisible elements;
  - `kbd-hover-only`: hidden link groups that hovering reveals but focusing (or Enter/ArrowDown on a disclosure button) does not;
  - `kbd-change-on-input` (3.2.2): picks another option in each `<select>`; navigations, submits and popups are blocked and reported;
  - with `--state` on a modal: Escape closes it (`kbd-dialog-escape`) and focus returns to the trigger (`kbd-dialog-focus-return`).
- **Extra**: inputs labelled only by a placeholder (axe accepts these; WCAG 3.3.2 wants a visible label).
- **Stack detection** (Next, React, Vue/Nuxt, Svelte, Angular, Astro, Tailwind, MUI, Radix) from the rendered page, used for fix notes.

## Limits

- One browser engine (Chromium). Safari/VoiceOver quirks need a manual check.
- Tab goes forwards only: focus hidden by a sticky *header* while Shift+Tabbing up is not tested.
- Focus inside iframes is followed but not measured for visibility; cross-origin iframe content is only partly covered; closed shadow roots not at all.
- Click-handler detection is heuristic: delegated handlers with no pointer cursor are missed. Hover-menu and change-on-input checks cover hidden link groups and `<select>` only.
- No check for meaning (good alt text, link text, reading order, clear errors), images of text, or media captions. That is the human part.
