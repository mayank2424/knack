# Token sources: supported formats and how detection works

`tokens.mjs` walks the project (respecting `.gitignore`; skipping `node_modules`, `dist`, `build`, dot-folders, and test/story/fixture folders unless `--include-tests`) and turns every source it recognizes into one normalized list:

```
{ category, name, value, usage, refs: { css?, scss?, less?, tw? }, source, file, line, pkg, twv, dark?, themes? }
```

`category` is one of `color`, `space`, `radius`, `font-size`, `font-weight`, `shadow`, `z-index`, `duration`. Tokens that fit none (font families, line heights, breakpoints, easing curves) are ignored. Aliases (`var(--a)`, `$a`, `@a`, `{color.brand}`) are resolved to their final value, so a matcher compares real colors and pixels. `pkg` is the workspace package the token was defined in; `twv` is the Tailwind major version it belongs to (for `@theme` and config tokens).

Pass `--tokens <file|dir>` (repeatable) to skip discovery and use only what you name, e.g. `--tokens node_modules/@primer/primitives/dist/css`.

Compiled Tailwind output committed to the repo (a file starting with `/*! tailwindcss v…`) is neither a token source nor scanned.

## CSS custom properties

Any `.css/.scss/.less/.pcss` file, plus `<style>` blocks in `.vue/.svelte/.astro`.

A custom property is a token when every level of its selector stack is a **token scope**:

| Scope | Examples | Mode |
|---|---|---|
| Root | `:root`, `html`, `:host`, `body`, `:where(:root)`, a plain class listed next to `:root` (`:root, .app`) | base |
| Theme attribute or class, light or default value | `[data-theme="light"]`, `[data-color-mode="auto"][data-light-theme="light"]`, `.light` | base |
| Dark | `.dark`, `[data-theme='dark']`, `[data-mantine-color-scheme=dark]`, `@media (prefers-color-scheme: dark)`, Tailwind `@variant dark { }` | dark |
| Other themes | `.theme-zinc`, `[data-theme="brand"]`, `[data-light-theme="light_high_contrast"]`, `html.todesktop.light`, `.theme-x [data-portal]` (blocks that are only custom properties), `@media (min-width…)`, `@include high-contrast { }` | variant |
| Component roots that are really token scopes | a single class/attribute selector with 8+ custom properties making up most of the block (`.excalidraw { --color-primary: … }`) | base, `scoped` |
| SCSS mixins | `@mixin palette { --color-grey-50: … }` when the mixin is `@include`d inside a token scope (resolved through `@use` namespaces and nested mixins) | from the include site |

Wrappers `@layer`, `@supports` and `@scope` are transparent. `@keyframes`, `@font-face` and `@property` are never token scopes. Component-scoped definitions (`.btn { --btn-bg: … }`) aren't tokens; they get scanned as drift like any other value.

- **Base vs dark vs variants.** Matching always uses the base value. A token that also has a dark or other-theme value is *theme-aware*: when `--fix` swaps a fixed value for it, the replacement is listed for confirmation. A token defined through a themed one (`--radius-sm: calc(var(--radius) * 0.6)` where `--radius` changes per theme) is theme-aware too. A token that only exists inside alternative themes is matched but never auto-fixed.
- **Category** comes from the value first (a color is a color, `ms`/`s` is a duration, `0 1px 2px …` is a shadow). For lengths and bare numbers it comes from the name (camelCase is split, so `--borderRadius-medium` is a radius):

| Name contains | Category |
|---|---|
| `radius`, `rounded`, `corner` | radius |
| `font-size`, `text-`, `fs-`, `type-`, `heading`, `body` | font-size |
| `space`, `spacing`, `gap`, `gutter`, `inset`, `pad`, `margin`, `stack`, or a scale name like `size-4` / `base-size-8` | space |
| `z`, `z-index`, `layer`, `elevation` (integer) | z-index |
| `weight`, `fw` (100–900) | font-weight |

A length whose name matches nothing, or names a component (`--header-height`, `--icon-size`, `--button-size`), is skipped so it can't hijack `padding: 64px`.

- **Channel colors.** `--primary: 222 47% 11%` (shadcn v3) and `--brand-rgb: 13, 110, 253` (Bootstrap) are colors meant for `hsl()` / `rgb()`. They're read as colors, and their CSS reference is `hsl(var(--primary))`, never a bare `var(--primary)`.
- **calc().** `calc(var(--radius) - 2px)`, `calc(var(--radius) * 0.6)` and `calc(1px * infinity)` (a pill) are evaluated to px.
- **Spacing units.** A space token named like a unit (`--space-factor`, `--grid-unit`, `--base-unit`, `…-step`) is treated as a scale: `calc(var(--space-factor) * 2)` … `* 16` are on it.
- **Reference:** `var(--name)` (or the `hsl()`/`rgb()` wrapper above).

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

Tailwind v4's default theme (spacing ×0.5…96, radius, text, font-weight, shadow, z, duration, and the full oklch color palette) is added unless you reset it with `--*: initial` or `--<namespace>-*: initial`. `rounded-full` is a class only: v4 has no `--radius-full` variable. Pass `--tailwind-defaults none` to turn the defaults off. Tailwind v4 only emits a theme variable when something references it, and references in CSS processed by Tailwind and in scanned source files both count, so `var(--color-red-500)` written by a fix exists at runtime.

- **References:** `var(--color-brand-500)` in CSS, `brand-500` as a class fragment.
- **Which code can use a class.** A utility from your `@theme` only exists where the Tailwind entry compiling that code includes the file that defines it. Entries are stylesheets with `@import "tailwindcss"`; an entry compiles its own package and that package's workspace dependencies. A `@theme` class is offered to a file only if every entry that compiles it includes that `@theme` (through `@import`s).

## Tailwind v3 `tailwind.config.{js,cjs,mjs,ts}`

**Default: static read.** The config is parsed as a JS object literal and is never executed. The parser understands `module.exports =` / `export default` / `satisfies Config`, nested objects, strings, numbers, top-level `const` objects referenced by name, spreads (including `...base.theme`), member access (`brand[500]`), `as` casts, and **presets and `require()`/`import` of files inside the repo**, including workspace packages (`presets: [require('@acme/tailwind-config')]`). `tailwindcss/colors` and `tailwindcss/defaultTheme` resolve to the built-in v3 palette and scales. Anything else it can't resolve (theme functions, plugins, packages outside the repo) is skipped with a warning that names it, if it's inside a theme key.

Every `tailwind.config.*` in the repo is read; its tokens belong to its own package. Preset files consumed by a config are treated as token files and not scanned.

**`--exec-config`** evaluates the config in a child Node process with a 15 s timeout. When the project has `tailwindcss` installed, it calls `tailwindcss/resolveConfig`, which returns the full resolved theme. TypeScript configs run with `--experimental-strip-types` on Node 22+. Use this only on repos you trust, because it runs project code.

Merging follows Tailwind: presets first, the config last; the last `theme.X` replaces the default scale for X, and every `theme.extend.X` in the chain is deep-merged on top. Default v3 scales (spacing, radius, font size, weight, shadow, z, duration, and the v3 color palette) are included unless replaced.

Mapped keys: `colors`, `spacing`, `borderRadius`, `fontSize` (first item of `[size, lineHeight]` tuples), `fontWeight`, `boxShadow`, `zIndex`, `transitionDuration`. `DEFAULT` keys map to the bare utility (`rounded`, `shadow`, `bg-brand`).

- **References:** class fragment (`brand-500` → `bg-brand-500`). If the value is `var(--x)` or `hsl(var(--x))` / `rgb(var(--x) / <alpha-value>)`, CSS files can use `var(--x)` / `hsl(var(--x))` too. Otherwise CSS files get a `theme('colors.brand.500')` suggestion and no auto-fix, and inline styles get "use the class instead".
- `prefix: 'tw-'` is honored when reading and writing classes.

## Tailwind version per package

The major version is decided per workspace package: its `package.json` (`tailwindcss`, `@tailwindcss/postcss|vite|cli`), then its CSS (`@import "tailwindcss"` → 4, `@tailwind base` → 3), then a `tailwind.config.*` in the package (→ 3). Packages with no signal inherit from an ancestor package, then from the apps that depend on them (when they agree), then the repo-wide majority. Default scales and config tokens of one major version are never offered to code compiled by the other, so a v3 app never gets `rounded-xs` or `var(--spacing)`.

## W3C DTCG and Style Dictionary JSON

Files named `*token*.json`, `*.tokens`, `*.tokens.json`, or any `.json` under a `tokens/` folder (`package.json`/`tsconfig.json` excluded).

- **DTCG:** leaves have `$value`; `$type` is inherited from groups. Supported values: color strings, 2025.10 color objects (`{ colorSpace, components, alpha, hex }` in `srgb`, `srgb-linear`, `hsl`, `oklch`, `oklab`; other spaces fall back to `hex`), dimension and duration objects (`{ value, unit }`), shadow objects, duration numbers, and `{group.token}` aliases.
- **Style Dictionary:** leaves have `value` (and optional `type` / `attributes.category`), with aliases like `{color.base.red.value}`.
- **Names:** the path in kebab case: `color.brand.500` → `--color-brand-500`.
- **References:** the CSS variable your build presumably emits, `var(--color-brand-500)`. The JSON alone doesn't prove that variable exists at runtime, so:
  - if the repo also contains a CSS file defining that variable, the CSS token takes over and fixes work;
  - otherwise findings are reported but not auto-fixed. Pass `--json-vars` to trust that the build generates them.

## SCSS `$variables` and LESS `@variables`

Top-level `$name: value;` (with `!default` stripped) in `.scss` files and `@name: value;` in `.less` files. Maps and functions aren't read.

- **Shared vs local.** Variables count as project tokens when their file looks like a token file (its name or folder mentions variables, tokens, theme, colors, spacing …) or defines 4+ top-level variables. Otherwise they're local to that file (a component's `$duration: 1.6s`) and only match values in that same file.
- **Reference:** `$name` / `@name`, used only where the variable is actually in scope: the same file, a file that `@import`s it, a file that `@use`s it `as *` (or through `@forward`), or `namespace.$name` for a plain `@use`. A `.css` file can't see SCSS variables, so it gets the CSS variable with the same value instead, or no fix.

## Monorepo visibility

Packages are the folders with a `package.json`. A token defined in package T reaches code in package P when T is P, an ancestor of P, a (transitive) workspace dependency of P (from `package.json` or a stylesheet `@import`), or is shipped by an app that depends on P. Unrelated packages' tokens are ignored, so `apps/docs` can't lend its `--spacing` to `apps/web`.

When one name has different values among the tokens a file can see, the nearest package wins; if the nearest still disagree, the name is ambiguous and is never auto-fixed. `tokens.mjs` warns about such names.

## How the scanner picks between equal tokens

When several tokens are equally close to a raw value, the scanner prefers, in order:

1. a token the file can actually reference (SCSS var in scope in `.scss`, a class fragment in a class string, a CSS variable elsewhere), from the nearest package;
2. the token's own name over an alias pointing at it;
3. project tokens over framework defaults (for colors, a project token beats a palette class even when it needs `bg-[color:var(--x)]`);
4. a semantic role match for colors: `background` → `bg|surface`, `color` → `text|fg|ink`, `border` → `border|line|divider`; a token whose role (or its alias's role) contradicts the property is pushed back; in role-less spots (custom properties) a palette primitive beats someone else's semantic alias;
5. scale tokens (`--radius-*`, `--space-*`) over component tokens (`--avatar-border-radius`).

The runner-up names appear as `alternatives` in `report.json`. A value exactly midway between two different steps (`10px` between 8 and 12) is OFF-SCALE with both names, not NEAR.

## What counts as a design value when scanning

| Category | Where it's read |
|---|---|
| color | hex / `rgb()` / `rgba()` / `hsl()` / `hsla()` / `oklch()` / `oklab()` in any declaration except `mask*` and custom properties named `*mask*` / `*fade*`, inside Tailwind color utilities (`bg-[#…]`), JSX style strings, and JS strings that are exactly a color (listed, not scored) |
| space | `margin*`, `padding*`, `gap`, `row/column-gap`, `inset*`, `top/right/bottom/left`, `scroll-margin/padding*` (`px` and `rem`) |
| font-size | `font-size` (the `font` shorthand isn't read) |
| radius | `border-radius` and its corner longhands |
| font-weight | numeric `font-weight` 100–900 |
| shadow | the whole `box-shadow` value |
| z-index | integer `z-index` |
| duration | `transition-duration` / `animation-duration`, and the first time of each layer in `transition` / `animation` (the second one is a delay) |

**Ignored:** comments, SVG path data and other attributes, values inside `var()`/`url()`/`env()`/`theme()` (including `var(--x, #fff)` fallbacks), `0`, `1px`/`0.5px` hairlines (also as `top-[0px]`), z-index `-1/0/1`, durations under 5 ms, fully transparent colors, `--tw-*` internals, `@font-face`/`@property` descriptors, tests/stories/fixtures, generated files, JS/TS palette or theme objects (12+ color literals in a file named like `colors.ts` / `theme.ts`), token definitions themselves, and lines marked `token-drift-ignore` / `stylelint-disable-line` (or `-next-line` on the line before). `--strict` and `--ignore` tune this.

Files whose renderer can't resolve CSS variables are scanned but listed separately, not scored and never fixed: email templates (an `email/`, `emails/`, `mailers/` or `newsletters/` folder, files named `mailer.*`, HTML with MSO comments, `role="presentation"` or `bgcolor`), OG-image code (`next/og`, `@vercel/og`, `satori`, `ImageResponse`, files named `*opengraph*` / `og-image*`, `og/**/route.*`), React Native / Expo, `@react-email`, `jsx-email`, `mjml` and `@react-pdf`.
