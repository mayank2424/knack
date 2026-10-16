# Fix policy: what `--fix` rewrites, and why

The goal: every automatic rewrite leaves the rendered UI **pixel-identical** in the base theme (EXACT) or **imperceptibly different** (NEAR, opt-in), and points at a token that means the right thing. Anything that could change layout, theming, compilation or meaning without the user noticing is reported and left alone.

## Levels

| Mode | Rewrites | Visual change |
|---|---|---|
| `--fix` | EXACT only: the raw value equals the token's resolved value (same 8-bit sRGB + alpha; same px after rem→px; same ms) | None in the base theme. Theme-aware tokens are listed for confirmation |
| `--fix=near` | EXACT + NEAR: ΔE2000 ≤ 4 (≤ 2 against framework-default palette colors; never for pure `#fff`/`#000` beyond ΔE 1) with alpha within ~25% of the token's; spacing/radius within 2px and 25%, or 5%; offsets (`top`/`left`/`inset`) within 2px; font sizes within 1px or 5%; durations within 10 ms or 15%; weights within 50 | Small and deliberate: the value snaps to the system |
| OFF-SCALE | Never, including values exactly midway between two steps | Needs a human decision: add a token, or keep it as a one-off |

Always run `--dry-run` first. It prints a unified diff, writes `.knack/token-drift/fix.diff`, and changes nothing.

## What each context becomes

| Where the value lives | Rewrite | Example |
|---|---|---|
| `.css`, `<style>` blocks, CSS-in-JS templates | `var(--token)` (or `hsl(var(--x))` for channel tokens) | `padding: 16px 24px` → `padding: var(--space-4) var(--space-6)` |
| `.scss` with an SCSS token in scope | `$token`, or `ns.$token` for a namespaced `@use` (a CSS var otherwise) | `color: #111827` → `color: $color-ink` |
| `.less` with a LESS token in scope | `@token` | `margin: 12px` → `margin: @gap` |
| Tailwind arbitrary value, token has a class | canonical class, keeping variants, `!` and the sign | `md:px-[16px]` → `md:px-4`, `mt-[-8px]` and `-mt-[8px]` → `-mt-2`, `text-[13px]/5` → `text-sm/5` |
| Tailwind arbitrary font size without a pinned line height | the theme variable, font size only | `text-[14px]` → `text-[length:var(--text-sm)]` (v4); left alone in v3 |
| Tailwind arbitrary value, token is CSS-only | arbitrary var with a type hint for ambiguous utilities | `text-[#374151]` → `text-[color:var(--color-gray-700)]` |
| JSX `style={{ … }}` with a literal | a string with the CSS var | `padding: 16` → `padding: 'var(--space-4)'`, `color: '#dc2626'` → `color: 'var(--color-danger)'` |
| HTML/Vue/Svelte `style="…"` | `var(--token)` | `style="margin: 32px"` → `style="margin: var(--space-8)"` |
| Tailwind v4 spacing scale, or a spacing unit token, in CSS | `calc(var(--spacing) * n)` / `calc(var(--space-factor) * n)` | `gap: 12px` → `gap: calc(var(--spacing) * 3)` |

## Never auto-fixed (report-only), and why

- **OFF-SCALE values**, including midway values (`10px` between 8 and 12). Picking a token for them is a design decision.
- **Ambiguous tokens.** The same name has different values in packages this file can see (`--radius` in two apps of a monorepo).
- **Tokens from elsewhere.** A token defined inside a component root (`.excalidraw { … }`) used from another package, a token that only exists in alternative themes, a Tailwind v4 class whose `@theme` isn't included by the entry compiling this file, or a Tailwind v3/v4 token offered to code compiled by the other major version (these are filtered out before matching).
- **Semantic mismatches.** A token whose name or alias says it's for another role (a border token for a `background`, `--color-emphasis: var(--cal-bg-emphasis)` for a border), and named z-index layers (`--z-modal`, `--zIndex-sticky`) unless the name is a plain scale step. The value matches; the meaning might not.
- **`text-[size]` → `text-*` in Tailwind v3 without a `leading-*` class.** `text-sm` also sets a line height; the original doesn't. In v4 the font-size-only `text-[length:var(--text-sm)]` is written instead.
- **Negative lengths in CSS** (`margin-top: -16px`). The safe form is `calc(-1 * var(--space-4))`, which is easy to get subtly wrong in SCSS (`0 -$x` parses as subtraction). Tailwind negatives that have a canonical class (`-mt-2`) are fixed.
- **Sass/LESS arithmetic and functions** (`16px * 2`, `$a + 4px`, `math.div(32px, 2)`, `darken(#fff, 10%)`, `rgba($c, .5)`). They need real numbers and colors; `var()` either fails to compile or silently concatenates.
- **Preprocessor variables that aren't in scope.** `$color-blue-4` isn't written into a file that doesn't `@import` / `@use` its file.
- **Values computed in JS** (`color: isDark ? '#fff' : '#000'`, `padding: getPad()`). Reported, never rewritten.
- **Plain JS string literals** (`const COLORS = ['#2563eb']`). These usually feed canvas, chart or WebGL APIs that can't resolve `var()`. Listed, not scored.
- **Files whose renderer has no CSS variables:** email templates and HTML, OG images (`next/og`, satori), React Native / Expo, `@react-email`, `jsx-email`, `mjml`, `@react-pdf`. `var()` would silently break them. Listed, not scored.
- **Tailwind classes with a `/modifier` on colors** (`bg-[#2563eb]/50`). Opacity modifiers on var-backed colors only work if the color was defined with channels. Font-size `/line-height` modifiers are kept.
- **Tailwind `shadow-[…]` that would become `shadow-[var(--x)]`.** Tailwind can't reliably tell a var() shadow from a shadow color. The token is suggested and you rewrite by hand.
- **Inline styles matching a Tailwind v3 theme value** (no CSS variable behind it). The suggestion is to use the class instead.
- **DTCG / Style Dictionary tokens with no generated CSS variable in the repo**, unless you pass `--json-vars`.
- **Tailwind v3 theme tokens in CSS files** with no CSS variable behind them. A `theme('…')` suggestion is shown instead, since it only works where Tailwind's PostCSS plugin runs.
- **Anything inside comments, `var()` fallbacks, `url()`, SVG path data, `@font-face` descriptors, transition delays, token definition files, generated files, or lines marked `token-drift-ignore` / `stylelint-disable-line`.**

The scan prints these as a grouped "Not auto-fixable" list, and `report.md` has the same table.

## Safety rails in the writer

1. Edits are computed from exact source offsets and applied from the end of the file backwards. Overlapping edits are dropped.
2. Before writing, each file is checked: the text at every offset must still match what was scanned, the bracket balance of `{} () []` must be unchanged, and the line count must be unchanged. If a check fails, the whole file is left untouched and reported as skipped.
3. Replacements never add or remove lines, so diffs stay small and reviewable.
4. **Theme-aware tokens are flagged.** If a token has a dark-mode or other-theme value, or is defined through one that does, the fixed value will now follow the theme. `--fix` lists every such replacement so the user can confirm that's intended. It usually is, since the hard-coded value was a theming bug.

## Reviewing NEAR in batches

NEAR rewrites change pixels slightly. Work through them in reviewable chunks:

```bash
node scan.mjs . --fix=near --dry-run --include "src/components/**"
node scan.mjs . --fix=near --include "src/components/**"   # after the user approves
```

For colors, show the user the swatch table in `report.md` ("Near-miss colors": left is the found value, right is the token) before applying. Tighten or loosen with `--threshold color=2` / `--threshold size=1,pct=3,font=0.5`.

## Verifying after a fix

- Re-run `scan.mjs`: the score should rise and EXACT should drop to only report-only items.
- Run the project's own build or typecheck (`npm run build`, `tsc --noEmit`, `stylelint`).
- Spot-check a page visually if NEAR fixes touched prominent components.

How this policy was checked: `--fix` and `--fix=near` were applied to copies of shadcn-ui, cal.com, documenso, Mastodon, Excalidraw and Primer React (about 2,000 EXACT and 2,500 EXACT+NEAR edits). Every changed file still parsed (TypeScript, PostCSS, postcss-scss), every SCSS file that compiled before still compiled with Dart Sass, every rewritten Tailwind class generated CSS in the right major version (Tailwind 4.1 compiler with the project's own `@theme`, or Tailwind 3.4 with its config), and every EXACT class rewrite was compiled old-vs-new and produced the same computed declarations, except where the token changes per theme, which `--fix` lists.
