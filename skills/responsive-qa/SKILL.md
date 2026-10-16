---
name: responsive-qa
description: >-
  Sweeps a web page across phone, tablet and desktop widths in a real browser
  (Playwright) and automatically detects responsive layout bugs: horizontal
  scroll and the element causing it, text spilling out of or clipped by its box
  or off its hero image, overlapping text/buttons, tap targets under 24/44px,
  tiny text on mobile, over-long lines on desktop, stretched or oversized images,
  fixed banners/modals covering or overflowing the screen, anchor links landing
  under a sticky header, and a missing viewport meta tag. Produces annotated
  per-viewport screenshots, a contact sheet image and a JSON report, then loops
  fix → re-run until zero errors. Use when the user asks to check a page on
  mobile, test responsiveness or breakpoints, asks why a page scrolls sideways
  on iPhone/Android, says the layout breaks or overlaps on small screens, or
  after you build or restyle UI and need to see it at several screen sizes.
  Works with any dev server URL or a local .html file.
license: MIT
argument-hint: "[url-or-file] [--pages /,/pricing]"
metadata:
  title: Responsive QA
  category: design
  tags: responsive, mobile, layout, css, breakpoints, playwright, accessibility
  version: 0.2.0
  author: Mayank Gupta
---

# Responsive QA

You can't see your UI. This skill can: it loads the page at 8 widths (320 → 1920), measures the live DOM for layout bugs, outlines each one on a screenshot, and tells you which element is to blame. Your job is to look at the evidence, fix the root cause in source, and re-run until the report is clean.

## 0. One-time setup

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/setup.sh"
```
It installs Playwright 1.63.0 next to the scripts and a Chromium build, falling back to installed Chrome/Edge. Re-running it is harmless.

## 1. Find the page to test

- If the user gave a URL or file, use it.
- Otherwise look for a running dev server:
  ```bash
  node "${CLAUDE_SKILL_DIR}/scripts/detect-server.mjs"
  ```
  This lists local ports serving HTML, with their `<title>`, so you can match the right project. Cross-check the port against `package.json` scripts / framework config (Vite 5173, Next 3000, Astro 4321, etc.).
- Nothing running? Start the project's dev script in the background (`npm run dev`, etc.) and wait for it to answer. For static sites, or for a quick check, pass the `.html` path directly. `file://` works.
- If several servers could be the project, ask instead of guessing.

Pick the pages that matter: the one the user mentioned plus any page you just changed. Pass extra paths with `--pages`.

## 2. Run the sweep

```bash
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" http://localhost:5173 --full-page
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" http://localhost:3000 --pages /,/pricing,/blog/hello --full-page
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" ./dist/index.html --full-page
```

Use `--full-page` for landing pages and long content. Without it you only see the first screen (issues below the fold are still in the report). Useful options:

| Option | Use |
|---|---|
| `--widths 360,390,768,1280` | Match the project's real breakpoints or target devices |
| `--compare` | Diff against the previous run in the same `--out` (fixed / new / remaining) |
| `--ignore "#chat-widget"` | Exclude third-party widgets you can't change |
| `--skip long-lines,tiny-text` | Turn off checks that don't apply |
| `--json` | Full report on stdout (logs go to stderr) |
| `--fail-on warn` | Strict mode (exit 2 on warnings too) |
| `--wait 1500` | Pages that animate in or fetch data after load |
| `--scrollbars overlay` | Drop the emulated 15px Windows-style scrollbar at ≥ 1024px (default `classic`, which exposes `width: 100vw` bugs) |
| `--max-height 20000` | Draw issues further down very long pages (default 8000px) |

Output goes to `./.knack/responsive-qa/` in the current project: `contact-sheet.png` (`contact-sheet-<page>.png` with several pages), `shots/<page>/<w>x<h>.png`, `report.json` and `report.prev.json`. Exit code 0 means no errors, 2 means issues at or above `--fail-on`, and 1 means the tool itself failed (the message says how to fix it). Suggest adding `.knack/` to `.gitignore` if it isn't there.

## 3. Look at the evidence (do not skip)

1. **Read the contact sheet image.** Each column is one viewport, labelled with its error/warning counts and `↔ +Npx` when the page scrolls sideways. Red solid boxes are errors, amber dashed boxes are warnings. Numbers match the list under each column.
2. For any viewport with errors, **Read its screenshot** in `shots/` at full size to see exactly what breaks. A `+Npx →` marker on the right edge means the element runs N px off-screen.
3. Read the terminal summary (also printed at the top of the contact sheet), which groups each bug once with the widths where it occurs (`@320–414`) and folds sibling elements into one line (`4× div.social > a`). Read `report.json` for details: each issue has `check`, `severity`, `selector`, `message`, `box` (page coordinates), `element` (tag, id, classes, text) and `details.hints` (the likely cause, such as `min-width: auto`, `width="640" attribute`, or `flex row without flex-wrap`).

Checks and their default severity:

| Check | Sev | Where |
|---|---|---|
| `horizontal-overflow` | error | page scrolls sideways; names the culprit element (or the grid/flex container whose items overflow) |
| `image-overflow` | error/warn | informative image wider than the viewport: scrolls, or is cropped at the screen edge (warn if < 30% is cut) |
| `text-overflow` | error | text spills out of its box (long words, nowrap, more than half a line below a fixed height) |
| `text-over-image` | error | text runs off its photo/gradient backdrop onto a background with < 3:1 contrast |
| `overlap` | error/warn | visible text/controls on the same layer intersect (verified against paint order) |
| `fixed-offscreen` | error | fixed modal/banner sticks out of the screen; that part can never be scrolled to |
| `anchor-hidden` | error/warn | in-page links (`#pricing`) land the heading under a fixed/sticky header (WCAG 2.4.11) |
| `tap-target` | error | < 24×24px and its 24px circle hits a neighbour (WCAG 2.2 AA 2.5.8), touch widths |
| `image-distorted` | error | stretched/squashed `<img>` (no `object-fit`) |
| `viewport-meta` | error | missing `width=device-width` (warn if zoom is blocked) |
| `fixed-cover` | warn/error | fixed/sticky bars cover > 30% (> 50% is an error) of a phone screen |
| `hidden-overflow` | warn | overflow hidden by `overflow-x: hidden` on html/body |
| `text-clipped` | warn | text partly cut off with no ellipsis/line-clamp |
| `tiny-text` | warn | < 12px below 768px wide |
| `long-lines` | warn | > ~90 characters per line at ≥ 1024px |
| `tap-target-44` | info | < 44×44px (AAA / Apple HIG); in `report.json` only |
| `image-dimensions` | info | `<img>` without width/height (layout shift) |

## 4. Triage

- Fix **errors** first. One root cause usually shows up several times: a 640px image makes the hero grid too wide, which then reports `image-overflow` plus `text-clipped` on the hero, at three widths. Fix the image and the others go away.
- Same width at every failing viewport (the hint says so) usually means a hard-coded width. Overflow only at ≥ 1024 with the hint `width: 100vw includes the 15px classic scrollbar` is a Windows/Linux-only bug: real, but invisible on a Mac trackpad.
- Confirm against the screenshot that the issue is real. If it looks intentional (a carousel, a deliberate ribbon), read the false-positive guidance in `references/fix-patterns.md` before ignoring anything.
- Warnings: fix `text-clipped`, `fixed-cover`, `tiny-text`, `hidden-overflow` and `anchor-hidden` when you can. `long-lines` is polish. Info items (`tap-target-44`, `image-dimensions`) are only in `report.json`: act on them when the user cares about mobile/a11y polish or CLS.

## 5. Map issues to source

```bash
grep -rn "compare" src --include=*.{css,scss,tsx,jsx,vue,svelte,astro,html}   # class/id from selector
grep -rn "w-\[760px\]" src                                                    # Tailwind: raw classes from element.classes
grep -rn "Most popular with" src                                              # element.text when classes are hashed
```
Fix the shared component or stylesheet rule, not each call site.

## 6. Fix the root cause

**Read `references/fix-patterns.md`** for the check you're fixing. It has causes, CSS and Tailwind fixes, and false-positive notes. Principles:

- Fluid first: `max-width: 100%`, `minmax(0, 1fr)`, `repeat(auto-fit, minmax(min(100%, 16rem), 1fr))`, `flex-wrap: wrap` + `gap`, `min-width: 0` on flex/grid children, `clamp()` for type and spacing, `overflow-wrap: anywhere` for long tokens, `min-height` instead of `height`.
- Wide content that must stay wide (tables, code, carousels) goes in its own `overflow-x: auto` container. The detector correctly ignores scroll containers. A `<pre>` with `overflow-x: auto` still widens the page if its flex/grid parent has `min-width: auto`: add `min-width: 0` there.
- Sticky/fixed header: `html { scroll-padding-top: <header height + 8px> }` fixes every `anchor-hidden` at once.
- Do **not** hide overflow with `overflow-x: hidden` on `html`/`body` (reported as `hidden-overflow`), add per-device media queries for one width, shrink text to make it fit, or use `--ignore` to silence real bugs.
- Keep the design intent: same content, same hierarchy, just resilient.

## 7. Re-run until clean

```bash
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" <same url + options> --compare
```
`--compare` prints `✓ N fixed · ✖ N new · N remaining` and lists both. Look at the new contact sheet again. A fix at one width can break another (new issues show up as `+`). Repeat steps 3–6 until there are **zero errors** and every remaining warning is fixed or deliberately accepted. If HMR doesn't pick up a change (rare), reload the dev server.

## 8. Report back

Summarize for the user:
- Before → after counts (e.g. `46 errors / 40 warnings → 0 / 2`) and the widths tested.
- Each root cause you fixed, in one line, with the file you changed.
- Remaining warnings, with why they are acceptable or what it would take to fix them.
- Anything ignored via `--ignore`/`--skip`/`data-responsive-qa="ignore"` and why.
- The path to the final contact sheet so they can look themselves.

## Try it on the fixture

```bash
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" "${CLAUDE_SKILL_DIR}/examples/broken-page.html" --full-page   # 11 planted bugs
node "${CLAUDE_SKILL_DIR}/scripts/sweep.mjs" "${CLAUDE_SKILL_DIR}/examples/fixed-page.html" --full-page    # 0 errors, 0 warnings
node "${CLAUDE_SKILL_DIR}/scripts/selftest.mjs"   # all fixtures: planted bugs found, clean pages stay clean
```
`examples/fixtures/` holds AI-style pages with planted bugs (`dashboard`, `blog`, `landing`, each listing its `EXPECT` lines) and `clean-tricky.html`, a page full of deliberate patterns (carousels, off-canvas drawer, decorative bleed, floating labels, rotated ribbons, sticky card stacks, scaled product mocks) that must stay at 0 findings. Run the self-test after changing the detector.

## Limits

- Chromium only, with `deviceScaleFactor` 1 and no mobile user agent. Layout is emulated at each width; browser chrome, safe areas, the iOS dynamic toolbar and Safari-only bugs are not covered. Touch widths use overlay scrollbars; desktop widths emulate a 15px classic scrollbar (`--scrollbars`).
- It checks the page as it is after load (plus jumping to up to 8 in-page anchors): menus, modals, hover and focus states aren't opened. For a specific state, build a URL or fixture that renders it.
- Long pages are scrolled once to trigger lazy loading, up to 30,000px or 8s; infinite feeds are reported in a note and checked as far as they rendered.
- Pages behind login need a URL that works without auth (local dev bypass, preview token, seeded session).
- Overflow caused purely by pseudo-elements or box-shadows is detected as page overflow, but without a named culprit.
- Checks are heuristics tuned to avoid noise. Treat warnings as prompts to look, not verdicts.
