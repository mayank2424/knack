# Token Drift

> Finds hard-coded colors and spacing that bypass your design tokens, maps each to the right token, and fixes the safe ones.

Design systems rot quietly. A `#2563ea` here, a `padding: 15px` there, `p-[13px]` in a hurry, and six months later "brand blue" exists in nine shades. Most design-token tools *generate* tokens. **Token Drift audits them.** It finds every raw color, spacing, font size, radius, shadow, z-index and duration that bypasses your tokens, tells you which token it should have been, and rewrites the safe ones for you.

![Token Drift report preview](assets/preview.png)

## What it does

- **Finds your tokens automatically.** It reads CSS custom properties (with dark-mode overrides), Tailwind v4 `@theme`, Tailwind v3 `tailwind.config.*` (read statically by default, never executed), W3C DTCG / Style Dictionary JSON, and SCSS / LESS variables.
- **Scans the code** in `.css .scss .less .js .jsx .ts .tsx .vue .svelte .astro .html`: declarations, `<style>` blocks, styled-components templates, Tailwind arbitrary values (`p-[13px]`, `text-[#333]`), JSX `style={{ padding: 13 }}` and inline `style=""` attributes. It respects `.gitignore` and skips comments, SVG paths, hairlines and token definitions.
- **Matches each value to the nearest token.** Colors use CIEDE2000 (plus OKLab distance), sizes use px and percent. Each value is classified:
  - **EXACT**: equals a token. Swap it in.
  - **NEAR**: within threshold. Almost certainly drift.
  - **OFF-SCALE**: far from everything. Add a token or accept it as a one-off.
- **Scores it.** The drift score is the % of design values that already use tokens, broken down by category and file. `--fail-under 90` turns it into a CI guard.
- **Fixes conservatively.** `--fix` rewrites only EXACT matches, using the reference each file type needs: `var(--x)` in CSS, `$x` in SCSS, a canonical class like `p-4` for Tailwind, `'var(--x)'` in JSX. `--dry-run` shows the unified diff first. NEAR fixes are opt-in (`--fix=near`) and meant for batch review.
- **Proposes tokens.** `--propose` clusters off-scale leftovers (say, 13 near-identical grays) into a minimal set of new tokens, or bootstraps a whole token set when you don't have one.

It has no dependencies (plain Node 18+), makes no network calls, and runs in about a second on a 600-file monorepo.

## Example prompts

- "Find hardcoded colors that should use our tokens"
- "Audit design system drift in this repo"
- "How consistent is our spacing?"
- "Replace the hex values in src/components with our CSS variables"
- "Clean up the Tailwind arbitrary values like `p-[13px]`"
- "We don't have tokens yet. Suggest a palette and spacing scale from what the code already uses"
- "Add a CI check so nobody adds new magic numbers"

## Sample output

Run on the bundled fixture (`examples/acme-dashboard`):

```text
token-drift · acme-dashboard/  8 files scanned · 135 tokens from 4 sources

  Drift score   13%  ███░░░░░░░░░░░░░░░░░░░░░  11 of 87 design values use tokens

  EXACT       50  equals a token → swap in the token (45 auto-fixable)
  NEAR        16  within threshold of a token → likely drift (16 fixable with --fix=near)
  OFF-SCALE   10  far from every token → new token or deliberate one-off

  By category            tokens  exact  near   off  score
    color                      6     17     6     5    18%
    space                      4     12     6     1    17%
    radius                     1      6     1     0    13%
    ...

  Near misses (first 6)
    src/components/Button.jsx:7  hover:bg-[#1e4fd6] → hover:bg-brand-600  ΔE 0.41
    src/components/Card.scss:17  #6c7280 → var(--color-gray-500)  ΔE 0.51
    src/components/Card.scss:18  11px → var(--space-3)  Δ1px (8.3%)
```

`--fix --dry-run` shows exactly what would change:

```diff
-    'inline-flex items-center gap-2 rounded-[8px] px-[16px] py-[10px] text-[14px] font-[600] transition duration-[150ms]';
+    'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition duration-150';
-      <span style={{ fontSize: 12, color: '#6b7280', letterSpacing: 0.4 }}>{label}</span>
+      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-gray-500)', letterSpacing: 0.4 }}>{label}</span>
-  padding: 15px 24px;
+  padding: 15px var(--space-6);
```

Applying `--fix`, then `--fix=near`, takes the fixture from **13% → 64% → 83%**. The remaining 17% is off-scale values and report-only cases (a negative margin, canvas chart colors) that need a human decision. Every rewritten file still parses, and every rewritten Tailwind class compiles in Tailwind 3.4.

## Try it

```bash
node skills/token-drift/scripts/tokens.mjs skills/token-drift/examples/acme-dashboard
node skills/token-drift/scripts/scan.mjs   skills/token-drift/examples/acme-dashboard
node skills/token-drift/scripts/scan.mjs   skills/token-drift/examples/acme-dashboard --fix --dry-run
node skills/token-drift/scripts/scan.mjs   skills/token-drift/examples/acme-dashboard --propose
```

Reports land in `./.knack/token-drift/` (`report.md` with color swatches, `report.json`, `fix.diff`, `proposed-tokens.css`).

The fixture has planted drift in five flavors: near-miss hex colors, `15px` vs a `16px` token, Tailwind arbitrary values, JSX inline styles and an `oklch()` near-match. It also includes traps the scanner must ignore: comments, SVG path data, a commented-out `<div>`, and JSX text with apostrophes.

## Limitations

- Static analysis only. Values computed at runtime (`padding: ${size * 4}px`, `cn(isBig ? 'p-[13px]' : …)` built from variables) aren't followed.
- Tailwind's default *color palette* isn't embedded. Colors are matched against your own tokens, or against the full theme when you use `--exec-config` with `tailwindcss` installed.
- SCSS maps (`map-get($spacers, 3)`), the `font` shorthand, `line-height`, `letter-spacing` and width/height aren't audited.
- Style objects outside `style={{ }}` (e.g. `const styles = { padding: 13 }`, React Native `StyleSheet.create`) aren't scanned.
- It doesn't render the page, so NEAR fixes are imperceptible by threshold, not verified pixel by pixel.

See [`references/token-sources.md`](references/token-sources.md) for supported formats and [`references/fix-policy.md`](references/fix-policy.md) for exactly what gets auto-fixed and why.
