# A11y Audit

> Runs axe-core and a real keyboard pass, shows the agent what's broken, and keeps it fixing source until the page passes.

![A11y Audit preview](assets/preview.png)

Generated UIs look fine and are often unusable with a keyboard or a screen reader: clickable `<div>`s, `outline: none`, placeholder-only inputs, grey-on-white text. Most accessibility skills just give the agent a list of guidelines. This one **runs real tools**, shows the agent what it found, and keeps it fixing source until the page passes.

## What it does

1. **axe-core audit**: injects axe-core 4.13 into the page with Playwright and runs the WCAG 2.0/2.1/2.2 A + AA and best-practice rules.
2. **Keyboard pass** (things axe can't check): presses Tab through the page for real and records:
   - focus order (numbered on the screenshot)
   - focus traps, and which elements can never be reached because of them
   - controls with **no visible focus indicator** (screenshot before vs. after focus, pixel diff)
   - **clickable elements keyboard users can't reach** (cursor:pointer, `onclick`, interactive roles, real click listeners)
   - focus landing on invisible or off-screen elements, positive `tabindex`, focus jumping backwards on screen
3. **Report**: `report.md` grouped critical → minor, deduplicated by rule, with selectors, HTML snippets, WCAG criteria and a fix for each rule; `report.json` for tooling; an **annotated screenshot** per page.
4. **Fix loop**: the agent maps each finding to your components (React, Vue, Svelte, Tailwind aware), fixes them semantic HTML first, re-runs until there are zero critical/serious issues, then tells you what still needs a human.
5. **Contrast helper**: `contrast.mjs` gives the WCAG ratio, AA/AAA pass/fail, and the **nearest passing color with the same hue**.

## Example prompts

- "Audit my app for accessibility"
- "Is this page WCAG AA compliant? http://localhost:3000/pricing"
- "Fix the contrast issues on the landing page"
- "Make the nav and modal keyboard accessible"
- "Check the signup form with a screen reader in mind"
- "Run an a11y check on dist/index.html and fail if anything serious is left"

## Requirements

- Node.js 18+
- Run `bash scripts/setup.sh` once. It installs Playwright 1.63.0, axe-core 4.13.0, and Chromium (~150 MB). If Chromium can't be downloaded, an installed Chrome or Edge is used.
- A running dev server or a local `.html` file. No network calls except loading the page under test, no telemetry.

## Try it

```bash
bash scripts/setup.sh
node scripts/audit.mjs examples/inaccessible-page.html     # 16 planted bugs
node scripts/audit.mjs examples/accessible-page.html       # same page, fixed: 0 issues
node scripts/contrast.mjs "#777" "#fff"
```

## Sample output

```text
◆ Auditing file:///…/examples/inaccessible-page.html (1280×800)
◆   axe-core 4.13.0: 12 rule violation(s), 1 need review
◆   keyboard: 14 focus stops, TRAP at #news-name; 12 without visible focus; 7 clickable-but-unreachable
◆   issues by impact: 4 critical · 9 serious · 4 moderate · 0 minor
◆ Report → .knack/a11y-audit/report.md
◆ JSON   → .knack/a11y-audit/report.json
◆ Image  → .knack/a11y-audit/inaccessible-page.annotated.png
```

```text
$ node scripts/contrast.mjs "#a3a8b5" "#fff"
#a3a8b5 on #ffffff  →  2.38:1
  FAIL  AA                     needs 4.5:1
  FAIL  AAA                    needs 7:1
  FAIL  UI / large-text (3:1)  needs 3:1

  Nearest fg for 4.5:1 (same hue, OKLCH lightness only):
    #727683  4.53:1  darker  ΔL 0.164  oklch(56.8% 0.020 269.0)
```

`report.md` excerpt:

```markdown
### `kbd-unreachable`: Clickable element cannot be reached with the keyboard
7 element(s) · keyboard pass · WCAG 2.1.1 Keyboard
**How to fix:** Clickable but not keyboard-reachable. Use a native <button> or <a href>. …
- `div.nav-item:nth-of-type(1)`
  - `<div class="nav-item" onclick="location.hash='features'">…`
  - Looks clickable (cursor:pointer, click handler) but is not focusable: "Features".
```

## Files

| Path | What |
|---|---|
| `SKILL.md` | The workflow the agent follows |
| `scripts/audit.mjs` | axe-core + keyboard pass + annotated screenshot + reports |
| `scripts/contrast.mjs` | Contrast ratio and nearest passing color |
| `references/fix-recipes.md` | Before/after fixes (HTML, JSX, Tailwind) for ~30 common rules |
| `references/manual-checks.md` | The checks no tool can do: screen reader, zoom/reflow, motion, captions |
| `examples/` | A page with planted issues and its fixed twin |

## Honest limits

Automated testing finds roughly 30–50% of accessibility problems. This skill covers more than axe alone (keyboard behavior, visible focus), but it can't judge whether alt text is meaningful, whether reading order makes sense, or whether captions are accurate. The agent ends every run with a short manual checklist for you. Chromium only; cross-origin iframes are only partly covered.

## License

MIT
