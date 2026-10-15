# Fix patterns for responsive-qa findings

Read the section for the check you are fixing. Each one covers what the detector measures, the usual root causes, the idiomatic fix in CSS and Tailwind, and the false positives to watch for.

**General rule: fix the cause, not the breakpoint.** Prefer layouts that are correct at *every* width (`minmax()`, `clamp()`, `flex-wrap`, `min-width: 0`, `max-width: 100%`) over `@media (max-width: 375px)` patches. A fluid fix also covers the 360, 390 and 430px phones you didn't test.

---

## horizontal-overflow (error)

**Measures:** `document.scrollWidth > viewport` (the page scrolls sideways). It reports the elements whose right edge passes the viewport and that also stick out of a parent that fits. It also reports text runs (long words, `nowrap`) that pass the edge. Anything inside a scroll container (`overflow-x: auto|scroll`) or a clipping container is ignored, because it can't widen the page.

| Root cause (see `details.hints`) | CSS fix | Tailwind |
|---|---|---|
| Hard-coded `width: 760px` / `min-width` | `width: 100%; max-width: 760px` | `w-full max-w-[760px]` |
| Wide table | Wrap: `.table-scroll { overflow-x: auto }`, and the table gets `min-width` | `<div class="overflow-x-auto"><table class="min-w-[640px] w-full">` |
| Flex row that can't wrap | `flex-wrap: wrap` and `gap` | `flex flex-wrap gap-4` |
| Flex item won't shrink (`min-width: auto`) | `min-width: 0` on the item (and `overflow-wrap: anywhere` on its text) | `min-w-0` |
| Grid item wider than its track | `grid-template-columns: repeat(3, minmax(0, 1fr))`, or `repeat(auto-fit, minmax(min(100%, 16rem), 1fr))` | `grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))]` |
| `width: 100vw` (includes the scrollbar) | `width: 100%` | `w-full` (not `w-screen`) |
| Negative margins / full-bleed hacks | `margin-inline: calc(50% - 50vw)` only inside `overflow-x: clip` ancestors, or use padding | `-mx-4` only matched by `px-4` on the parent |
| Off-canvas menu parked with `transform: translateX(100%)` | Hide it while closed: `visibility: hidden` or `display: none` (or `inset-inline-end: 0` + `translate` inside a `position: fixed; overflow: hidden` wrapper) | `invisible` / `hidden` when closed |
| Long URL / email / hash | `overflow-wrap: anywhere` (or `word-break: break-word`) | `break-words` / `[overflow-wrap:anywhere]` |
| `white-space: nowrap` on headings/buttons | Remove it, or add `text-overflow: ellipsis; overflow: hidden; min-width: 0` | `truncate min-w-0` |

**Do not** "fix" it with `body { overflow-x: hidden }`. The content is still cut off (the detector then reports `hidden-overflow`), `position: sticky` can stop working inside it, and some mobile browsers still let the page be dragged sideways. If you must clip a decorative bleed, use `overflow-x: clip` on the *section* that owns it.

**False positives:** carousels, code blocks and tables inside an `overflow-x: auto` container are not flagged. If an intentional strip *is* flagged, it is missing its scroll container: add `overflow-x: auto` (plus `scroll-snap-type` and `tabindex="0"` for keyboard users) rather than ignoring it.

## hidden-overflow (warn)

Something passes the viewport but `overflow-x: hidden` on `<html>`/`<body>` hides it. Users see cropped content, and some mobile browsers still let the page be dragged sideways. Find the element (same hints as above), fix its width, then remove the root `overflow-x: hidden`.

## image-overflow (error)

An `<img>`/`<video>` wider than the viewport. It either scrolls the page or is cropped by an `overflow: hidden` ancestor (the message names which).

```css
img, video, svg, canvas, iframe { max-width: 100%; height: auto; }
```
Tailwind's preflight already sets this. If you still see the issue, an explicit `w-[640px]` or a `width` style is overriding it: use `w-full max-w-[640px]`. Keep the `width`/`height` attributes (they prevent CLS); `height: auto` keeps the ratio.

## text-overflow (error)

Text extends past its own block box and the overflow is visible: a long word sticking out of a card, a button label running past the button, or copy spilling below a box whose height is too small. Glyph overhang from tight line-heights is ignored.

| Cause | Fix |
|---|---|
| Long unbroken token (URL, email, ID, German compound) | `overflow-wrap: anywhere` on the text block (`break-words`, or `[overflow-wrap:anywhere]` in Tailwind) |
| `white-space: nowrap` label in a fixed-width button | Let it wrap, or give the button `min-width: 0; max-width: 100%` and use `text-overflow: ellipsis` |
| `height: 120px` on a text box | `min-height: 120px` (`min-h-[120px]`) |
| Flex child text not wrapping | `min-width: 0` on the flex child (`min-w-0`) |

## text-clipped (warn)

Text that is **partly** hidden by an `overflow: hidden|clip` ancestor with no `text-overflow: ellipsis` (horizontal) or `line-clamp` (vertical). Fully hidden text (inactive slides, collapsed accordions, `.sr-only`) is skipped on purpose.

- Intentional truncation: make it explicit and accessible:
  `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;` (`truncate`), or `display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;` (`line-clamp-3`). Put the full text in `title` or reveal it on expand.
- Unintentional: remove the fixed `width`/`height`; use `max-width`/`min-height` so the box grows.
- Often it's a *symptom*: a hero with `overflow: hidden` crops its text because a child (image, grid) made the content wider than the screen. Fix the wide child first, then re-run.

## overlap (error / warn)

Two visible text boxes or controls intersect, confirmed against paint order with `elementsFromPoint`. Overlaps hidden behind a third opaque layer, and labels completely covered by an opaque control, are skipped. Ancestor/descendant pairs (text inside its button) never count. Fixed/sticky elements are excluded (see fixed-cover). Text inside `aria-hidden="true"` subtrees is ignored, so decorative background words don't count.

| Cause | Fix |
|---|---|
| `position: absolute` header CTA / badge with fixed offsets | Put it back in flow: flex container + `margin-left: auto` (`ml-auto`), and `gap` |
| Logo + nav that don't fit | `flex-wrap: wrap`, collapse nav into a menu button below the width where it fits, `min-width: 0` on the logo so it can shrink |
| Negative margins pulling a block over text | Remove them, or reserve space with padding |
| Fixed `height` on a container with growing content below it | `min-height` |
| Overlapping grid areas | Check `grid-area`/`grid-row` assignments at that width |

Intentional overlaps (a "NEW" ribbon on a card, an avatar stack): mark the decorative part `aria-hidden="true"` if it carries no information, or add `data-responsive-qa="ignore"` to it.

## tap-target (error) and tap-target-44 (warn)

Checked at touch widths (≤ 768px) on links, buttons, inputs, `summary`, ARIA widgets and focusable elements.

- **tap-target (error):** smaller than **24×24px**, *and* a 24px square centred on it hits a neighbour. That fails WCAG 2.2 SC 2.5.8 (AA). Small but well-spaced targets pass AA through the spacing exception and appear only as `tap-target-44`.
- **tap-target-44 (warn):** smaller than **44×44px**, the WCAG 2.5.5 (AAA) and Apple HIG size. Treat as polish unless the user asked for mobile/accessibility quality.
- Skipped: links inside a sentence (WCAG inline exception), visually hidden skip links, and checkboxes/radios whose `<label>` gives a bigger hit area.

Grow the hit area without changing the look:
```css
.icon-link { display: inline-grid; place-items: center; min-width: 44px; min-height: 44px; } /* icon stays 18px */
.footer a  { display: inline-flex; align-items: center; min-height: 44px; padding-inline: 8px; }
```
Tailwind: `inline-grid place-items-center size-11` (44px), or `min-h-11 px-2 inline-flex items-center`. A transparent `::after { content:""; position:absolute; inset:-12px }` on a `position: relative` control also works when layout space is tight.

## tiny-text (warn)

Text under 12px at widths below 768px. Body copy should be ≥ 16px on phones, secondary text ≥ 14px, legal/captions ≥ 12px. Use `font-size: clamp(0.875rem, 0.8rem + 0.3vw, 1rem)` instead of shrinking type in mobile media queries. Tailwind: `text-sm` (14px) minimum for UI copy, `text-xs` (12px) only for captions.

## long-lines (warn)

Desktop widths (≥ 1024px): paragraphs averaging over ~90 characters per line. Aim for 45–75.
```css
.prose p, article p { max-width: 65ch; }
```
Tailwind: `max-w-prose` (65ch) or `max-w-[65ch]`. Constrain the text block, not the whole section, so backgrounds can still run full-bleed.

## image-distorted (error)

The rendered content box's aspect ratio differs > 5% from the image's natural ratio while `object-fit` is `fill` (the default). SVGs are skipped (they letterbox via `preserveAspectRatio`).

- Fixed box (avatars, cards): `object-fit: cover` (`object-cover`), plus `object-position` if faces get cut.
- Flowing image: set only one dimension: `width: 100%; height: auto` (`w-full h-auto`).
- Need a specific ratio: `aspect-ratio: 16 / 9; object-fit: cover` (`aspect-video object-cover`).

## image-dimensions (info)

`<img>` without `width`/`height` attributes or CSS `aspect-ratio` causes layout shift (CLS) while loading. Add the intrinsic `width` and `height` attributes. CSS `max-width: 100%; height: auto` keeps it responsive. Next.js `<Image>` does this for you.

## fixed-cover (warn > 30%, error > 50%)

At touch widths, a `position: fixed|sticky` element covering a large share of the first screen (cookie banners, app-install prompts, chat widgets, tall sticky headers). A combined warning fires when all bars together cover > 40%.

- Cookie/consent: one compact row, `flex-wrap: wrap`, short copy plus 1–2 buttons, `max-height: 30vh; overflow: auto` as a safety net.
- Sticky header: keep it ≤ 64px on phones, hide secondary rows, or use a hide-on-scroll pattern.
- Full-screen modals that open on load are flagged on purpose: don't block first paint on phones.

## viewport-meta (error / warn)

Missing `<meta name="viewport" content="width=device-width, initial-scale=1">` makes phones render a 980px desktop layout scaled down. Everything else in the report assumes it's there (the sweep lays out at the true width). A `user-scalable=no` or `maximum-scale=1` warning means zoom is blocked; remove those (WCAG 1.4.4). Next.js/Nuxt/SvelteKit add the tag by default: check the root layout/`app.html`.

---

## Mapping an issue to source

1. `selector` is built from id → `data-testid` → stable class names → `:nth-of-type`. Hashed CSS-in-JS classes and utilities with special characters (`md:flex`, `w-[600px]`) are skipped in the selector. They are still listed raw in `element.classes`.
2. Search in this order: the id or `data-testid`, then distinctive classes from `element.classes` (for Tailwind, grep a combination like `w-\[760px\]`), then the `element.text` snippet (works for JSX and CMS templates).
3. In component frameworks the culprit's styles may come from a shared component (`Button`, `Card`). Fix the component once rather than at each call site, and re-run all pages that use it.

## When a finding is wrong

- Third-party widgets you can't change: `--ignore "#intercom-container,.cookie-vendor"`.
- A specific element in your code: `data-responsive-qa="ignore"` on it (applies to its subtree).
- A whole check that doesn't apply (e.g. a dense admin tool): `--skip tap-target-44,long-lines`.
- Say in your summary what you ignored and why. Never ignore an `error` just to reach zero.
