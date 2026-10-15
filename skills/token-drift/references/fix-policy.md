# Fix policy: what `--fix` rewrites, and why

The goal: every automatic rewrite leaves the rendered UI **pixel-identical** (EXACT) or **imperceptibly different** (NEAR, opt-in). Anything that could change layout, theming or tooling behavior without the user noticing is reported and left alone.

## Levels

| Mode | Rewrites | Visual change |
|---|---|---|
| `--fix` | EXACT only: the raw value equals the token's resolved value (same 8-bit sRGB + alpha; same px after rem→px; same ms) | None in the base theme |
| `--fix=near` | EXACT + NEAR: within threshold (ΔE2000 ≤ 4 with alpha within ~25% of the token's alpha; ≤ 2px and ≤ 25%, or ≤ 10%; durations ≤ 30 ms or ≤ 15%; weights ≤ 50) | Small and deliberate: the value snaps to the system |
| OFF-SCALE | Never | Needs a human decision: add a token, or keep it as a one-off |

Always run `--dry-run` first. It prints a unified diff, writes `.knack/token-drift/fix.diff`, and changes nothing.

## What each context becomes

| Where the value lives | Rewrite | Example |
|---|---|---|
| `.css`, `<style>` blocks, CSS-in-JS templates | `var(--token)` | `padding: 16px 24px` → `padding: var(--space-4) var(--space-6)` |
| `.scss` with an SCSS token of that value | `$token` (a CSS var otherwise) | `color: #111827` → `color: $color-ink` |
| `.less` with a LESS token | `@token` | `margin: 12px` → `margin: @gap` |
| Tailwind arbitrary value, token has a class | canonical class, keeping variants, `!` and `-` | `md:px-[16px]` → `md:px-4`, `-mt-[8px]` → `-mt-2`, `text-[13px]/5` → `text-sm/5` |
| Tailwind arbitrary value, token is CSS-only | arbitrary var with a type hint for ambiguous utilities | `text-[#374151]` → `text-[color:var(--color-gray-700)]` |
| JSX `style={{ … }}` | a string with the CSS var | `padding: 16` → `padding: 'var(--space-4)'`, `color: '#dc2626'` → `color: 'var(--color-danger)'` |
| HTML/Vue/Svelte `style="…"` | `var(--token)` | `style="margin: 32px"` → `style="margin: var(--space-8)"` |
| Tailwind v4 spacing scale in CSS | `calc(var(--spacing) * n)` | `gap: 12px` → `gap: calc(var(--spacing) * 3)` |

## Never auto-fixed (report-only), and why

- **OFF-SCALE values.** Picking a token for a far value is a design decision.
- **Negative lengths** (`margin-top: -16px`). The safe form is `calc(-1 * var(--space-4))`, which is easy to get subtly wrong in SCSS (`0 -$x` parses as subtraction). Tailwind negatives that have a canonical class (`-mt-2`) are fixed.
- **Plain JS string literals** (`const COLORS = ['#2563eb']`). These usually feed canvas, chart or WebGL APIs that can't resolve `var()`.
- **Files whose renderer has no CSS variables:** email HTML, OG images (`next/og`, satori), React Native, `@react-email`, `mjml`, `@react-pdf`. `var()` would silently break them.
- **Tailwind classes with a `/modifier` on colors** (`bg-[#2563eb]/50`). Opacity modifiers on var-backed colors only work if the color was defined with channels. Font-size `/line-height` modifiers are kept.
- **Tailwind `shadow-[…]` that would become `shadow-[var(--x)]`.** Tailwind can't reliably tell a var() shadow from a shadow color. The token is suggested and you rewrite by hand.
- **DTCG / Style Dictionary tokens with no generated CSS variable in the repo**, unless you pass `--json-vars`.
- **Tailwind v3 theme tokens in CSS files** with no CSS variable behind them. A `theme('…')` suggestion is shown instead, since it only works where Tailwind's PostCSS plugin runs.
- **SCSS/LESS tokens in files of another language.** `.css` can't see `$x`.
- **Anything inside comments, `var()` fallbacks, `url()`, SVG path data, or token definition files.**

## Safety rails in the writer

1. Edits are computed from exact source offsets and applied from the end of the file backwards. Overlapping edits are dropped.
2. Before writing, each file is checked: the text at every offset must still match what was scanned, the bracket balance of `{} () []` must be unchanged, and the line count must be unchanged. If a check fails, the whole file is left untouched and reported as skipped.
3. Replacements never add or remove lines, so diffs stay small and reviewable.
4. **Theme-aware tokens are flagged.** If a token has a dark-mode override, the fixed color will now follow the theme. `--fix` lists every such replacement so the user can confirm that's intended. It usually is, since the hard-coded value was a dark-mode bug.

## Reviewing NEAR in batches

NEAR rewrites change pixels slightly. Work through them in reviewable chunks:

```bash
node scan.mjs . --fix=near --dry-run --include "src/components/**"
node scan.mjs . --fix=near --include "src/components/**"   # after the user approves
```

For colors, show the user the swatch table in `report.md` ("Near-miss colors": left is the found value, right is the token) before applying. Tighten or loosen with `--threshold color=2` / `--threshold size=1,pct=5`.

## Verifying after a fix

- Re-run `scan.mjs`: the score should rise and EXACT should drop to only report-only items.
- Run the project's own build or typecheck (`npm run build`, `tsc --noEmit`, `stylelint`). In testing, every rewritten file still parsed with esbuild, sass, postcss and @vue/compiler-sfc, and every rewritten Tailwind class compiled in Tailwind 3.4.
- Spot-check a page visually if NEAR fixes touched prominent components.
