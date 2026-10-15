# Token sources: supported formats and how detection works

`tokens.mjs` walks the project (respecting `.gitignore`; skipping `node_modules`, `dist`, `build`, dot-folders) and turns every source it recognizes into one normalized list:

```
{ category, name, value, usage, refs: { css?, scss?, less?, tw? }, source, file, line, mode, dark? }
```

`category` is one of `color`, `space`, `radius`, `font-size`, `font-weight`, `shadow`, `z-index`, `duration`. Tokens that fit none (font families, line heights, breakpoints, easing curves) are ignored. Aliases (`var(--a)`, `$a`, `@a`, `{color.brand}`) are resolved to their final value, so a matcher compares real colors and pixels.

Pass `--tokens <file|dir>` (repeatable) to skip discovery and use only what you name.

## CSS custom properties

Any `.css/.scss/.less/.pcss` file, plus `<style>` blocks in `.vue/.svelte/.astro`.

A custom property counts as a token only when it's defined in a root-like block: `:root`, `html`, `:host`, `body`, `[data-theme…]`, `[data-mode…]`, `.dark`, `.light`, `.theme-*`, optionally wrapped in `@media`, `@supports`, `@layer` or `@container`. Component-scoped definitions (`.btn { --btn-bg: … }`) aren't tokens. They get scanned as drift like any other value.

- **Dark mode.** A definition inside a selector or media query containing `dark` (`[data-theme='dark']`, `.dark`, `@media (prefers-color-scheme: dark)`) becomes the token's `dark` value. Matching always uses the base (light) value. When a fix swaps a fixed color for a themed token, `scan.mjs --fix` lists it, because that color will now change in dark mode.
- **Category** comes from the value first (a color is a color, `ms`/`s` is a duration, `0 1px 2px …` is a shadow). For lengths and bare numbers it comes from the name:

| Name contains | Category |
|---|---|
| `radius`, `rounded`, `corner` | radius |
| `font-size`, `text-`, `fs-`, `type-`, `heading`, `body` | font-size |
| `space`, `spacing`, `gap`, `gutter`, `inset`, `size`, `pad`, `margin` | space |
| `z`, `z-index`, `layer`, `elevation` (integer) | z-index |
| `weight`, `fw` (100–900) | font-weight |

A length whose name matches nothing (`--header-height: 64px`) is skipped, so it can't hijack `padding: 64px`.

- **Reference:** `var(--name)`.

## Tailwind v4 `@theme`

Detected from `@import "tailwindcss"` or any `@theme { … }` block (also `@theme inline`). Namespaces map to categories:

| Namespace | Category | Class fragment |
|---|---|---|
| `--color-*` | color | `bg-brand-500`, `text-brand-500` … |
| `--spacing` (base) and `--spacing-*` | space | `p-4` = `calc(var(--spacing) * 4)` |
| `--radius-*` | radius | `rounded-lg` |
| `--text-*` (not `--text-*--line-height`) | font-size | `text-sm` |
| `--font-weight-*` | font-weight | `font-semibold` |
| `--shadow-*` | shadow | `shadow-md` |

Tailwind v4's default scales (spacing ×0.5…96, radius, text, font-weight, shadow, z, duration, white/black) are added unless you reset them with `--*: initial` or `--<namespace>-*: initial`. The default color palette isn't embedded. Pass `--tailwind-defaults none` to turn the defaults off.

- **References:** `var(--color-brand-500)` in CSS, `brand-500` as a class fragment.

## Tailwind v3 `tailwind.config.{js,cjs,mjs,ts}`

**Default: static read.** The config is parsed as a JS object literal and is never executed. The parser understands `module.exports =` / `export default` / `satisfies Config`, nested objects, strings, numbers, top-level `const` objects referenced by name, spreads, member access (`brand[500]`) and `as` casts. Anything it can't resolve (`require('tailwindcss/colors')`, `theme => …` functions, plugins) is skipped with a warning that names it.

**`--exec-config`** evaluates the config in a child Node process with a 15 s timeout. When the project has `tailwindcss` installed, it calls `tailwindcss/resolveConfig`, which returns the full resolved theme including the default color palette. TypeScript configs run with `--experimental-strip-types` on Node 22+. Use this only on repos you trust, because it runs project code.

Merging follows Tailwind: `theme.X` replaces the default scale for X, and `theme.extend.X` adds to it. Default v3 scales (spacing, radius, font size, weight, shadow, z, duration, white/black) are included unless replaced.

Mapped keys: `colors`, `spacing`, `borderRadius`, `fontSize` (first item of `[size, lineHeight]` tuples), `fontWeight`, `boxShadow`, `zIndex`, `transitionDuration`. `DEFAULT` keys map to the bare utility (`rounded`, `shadow`, `bg-brand`).

- **References:** class fragment (`brand-500` → `bg-brand-500`). If the value is `var(--x)`, CSS files can use `var(--x)` too. Otherwise CSS files get a `theme('colors.brand.500')` suggestion and no auto-fix.
- `prefix: 'tw-'` is honored when reading and writing classes.

## W3C DTCG and Style Dictionary JSON

Files named `*token*.json`, `*.tokens`, `*.tokens.json`, or any `.json` under a `tokens/` folder (`package.json`/`tsconfig.json` excluded).

- **DTCG:** leaves have `$value`; `$type` is inherited from groups. Supported values: color strings, the newer color objects (`{ colorSpace: "srgb", components, hex }`), dimension objects (`{ value, unit }`), shadow objects, duration numbers, and `{group.token}` aliases.
- **Style Dictionary:** leaves have `value` (and optional `type` / `attributes.category`), with aliases like `{color.base.red.value}`.
- **Names:** the path in kebab case: `color.brand.500` → `--color-brand-500`.
- **References:** the CSS variable your build presumably emits, `var(--color-brand-500)`. The JSON alone doesn't prove that variable exists at runtime, so:
  - if the repo also contains a CSS file defining that variable, the CSS token takes over and fixes work;
  - otherwise findings are reported but not auto-fixed. Pass `--json-vars` to trust that the build generates them.

## SCSS `$variables` and LESS `@variables`

Top-level `$name: value;` (with `!default` stripped) in `.scss` files and `@name: value;` in `.less` files. Maps and functions aren't read.

- **Reference:** `$name` / `@name`, used only inside files of the same language. A `.css` file can't see SCSS variables, so it gets the CSS variable with the same value instead, or no fix.

## How the scanner picks between equal tokens

When several tokens are equally close to a raw value, the scanner prefers, in order:

1. a token the file can actually reference (SCSS var in `.scss`, a class fragment in a class string, a CSS variable elsewhere);
2. the token's own name over an alias pointing at it;
3. project tokens over framework defaults (a default that sits on a value the project also tokenized counts as on-scale);
4. a semantic name match for colors: `background` → `bg|surface`, `color` → `text|fg|ink`, `border` → `border|line|divider`.

The runner-up names appear as `alternatives` in `report.json`.

## What counts as a design value when scanning

| Category | Where it's read |
|---|---|
| color | hex / `rgb()` / `rgba()` / `hsl()` / `hsla()` / `oklch()` / `oklab()` in any declaration except `mask*`, inside Tailwind color utilities (`bg-[#…]`), JSX style strings, and JS strings that are exactly a color (report-only) |
| space | `margin*`, `padding*`, `gap`, `row/column-gap`, `inset*`, `top/right/bottom/left`, `scroll-margin/padding*` (`px` and `rem`) |
| font-size | `font-size` (the `font` shorthand isn't read) |
| radius | `border-radius` and its corner longhands |
| font-weight | numeric `font-weight` 100–900 |
| shadow | the whole `box-shadow` value |
| z-index | integer `z-index` |
| duration | times in `transition*` / `animation*` |

**Ignored:** comments, SVG path data and other attributes, values inside `var()`/`url()`/`env()`/`theme()` (including `var(--x, #fff)` fallbacks), `0`, `1px`/`0.5px` hairlines, z-index `-1/0/1`, durations under 5 ms, fully transparent colors, test files, and token definitions themselves. `--strict` and `--ignore` tune this.

Files whose renderer can't resolve CSS variables are scanned but made report-only: email HTML (MSO comments, `role="presentation"`, `bgcolor`, or an `email/` folder), OG-image code (`next/og`, `@vercel/og`, `satori`), React Native, `@react-email`, `mjml` and `@react-pdf`.
