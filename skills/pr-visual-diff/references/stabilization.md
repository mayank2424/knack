# Stabilizing screenshots

A visual diff is only useful if an unchanged page produces zero changed pixels. This page
lists what `capture.mjs` does by default, how that compares with the hosted tools, the
results it was tested against, and the flag to reach for when something still moves.

## What capture.mjs does by default

| Source of noise | Built-in fix |
|---|---|
| Carousels, rotating banners, typewriters, JS-driven animations (`setTimeout`, `setInterval`, `requestAnimationFrame`) | **Virtual clock.** Playwright's clock is installed and paused before the page loads; JS time only advances in fixed steps (2 s of "settle" time, then small flushes), by the same amounts on both sides, so both land on the same frame. `--settle <ms>` changes the budget. |
| `Date.now()`, "5 minutes ago", copyright year, countdowns | Same clock, starting at today 12:00 UTC (both sides identical, realistic year). `--freeze-time <iso>` picks another start. |
| `Math.random()` (shuffled testimonials, random avatars, A/B buckets) | Seeded PRNG on both sides. |
| Video | Playback is blocked from document start (`play()` is a no-op, `play` events are paused), every video is shown at frame 0 after its data loads. |
| Animated GIFs | Replaced by a canvas snapshot of their first frame (same-origin or CORS-enabled images). |
| SVG (SMIL) animations that repeat forever | Paused at t=0. |
| CSS animations and transitions | From the first byte they last 1ms (so `animationend`/`transitionend` handlers still fire, but nothing runs on wall-clock time during load); capture-time CSS sets 0s and Playwright `animations: "disabled"` finishes the rest. `reducedMotion: "reduce"` for motion-aware code. |
| Web Animations from JS (`element.animate()`, Motion/framer's accelerated path) | Paused at birth and stepped with the virtual clock; finished when they reach their end so `.finished` chains continue in virtual time. |
| Blinking caret, spellcheck squiggles | `caret: "hide"` + `caret-color: transparent`; `spellcheck=false` on inputs/contenteditable. |
| Scrollbars | `--hide-scrollbars` + `::-webkit-scrollbar { display: none }`. |
| Web fonts swapping in late | Waits until `document.fonts.status === "loaded"`. |
| Lazy images, `srcset`, CSS background images | All images switched to `loading=eager` + `decoding=sync` and waited for; CSS `background-image` URLs (also `::before/::after`) are preloaded and waited for. With `--full-page` the page is walked top to bottom first (with JS time advancing) so intersection observers and scroll reveals fire. |
| Skeletons / spinners marked `aria-busy="true"` | Waits until no visible `[aria-busy=true]` remains. |
| Late XHR/fetch content | Waits for `networkidle` (10 s cap, then captures and notes it). |
| Locale/timezone/DPR | `en-US`, `UTC`, fixed `deviceScaleFactor`, sRGB colour profile, LCD text antialiasing off, GPU rasterization off. |
| Dev-tool overlays | Next.js indicator/toasts, Vite error overlay, Astro dev toolbar, webpack/Nuxt overlays hidden (`--no-dev-overlays` keeps them). |
| Something still moving | Stability check: screenshots 250 ms apart until two in a row are byte-identical (max 5). If never stable: "page kept changing". |

Anything still loading after 8 s is listed in the pair's notes ("still loading after 8s: 2
image(s), web fonts"), so a half-loaded capture is never silent.

Opt-in markers your app can use (same names as Argos, so existing markup keeps working):
`data-visual-test="blackout"` (masked), `data-visual-test="transparent"` (invisible, keeps
layout), `data-visual-test="removed"` (`display:none`).

## Compared with the hosted tools

| Technique | capture.mjs | Argos SDK | Playwright `toHaveScreenshot` | Percy | Chromatic |
|---|---|---|---|---|---|
| CSS animations off | yes | yes (via Playwright) | yes (`animations: "disabled"`) | most | yes |
| Caret hidden | yes | yes | yes (`caret: "hide"`) | | |
| Fonts / images / aria-busy waits | yes | yes | fonts | | |
| Background images | whole page, capped | opt-in attribute or whole page | | | |
| GIFs frozen | yes | yes | | yes | |
| SMIL paused | yes | yes | | | |
| Video frozen | yes | | | | |
| JS timers / rAF frozen | **yes (virtual clock)** | no (hide the element) | manual `page.clock` | JS off in renderer | |
| JS Web Animations on virtual time | yes | | | | |
| Seeded `Math.random` | yes | | | | |
| Two-identical-shots check | yes | | yes | | re-renders, auto-ignores flaky |
| AA pixels ignored | yes (pixelmatch) | | yes | | yes (`diffIncludeAntiAliasing` to opt in) |

Sources: the `@argos-ci/browser` stabilization plugins (npm package source),
[Argos flaky-test guide](https://argos-ci.com/docs/learn/reliability-and-flakiness/flaky-tests),
[Playwright `toHaveScreenshot`](https://playwright.dev/docs/api/class-pageassertions#page-assertions-to-have-screenshot-1),
[Percy: freezing animations](https://browserstack.com/docs/percy/stabilize-screenshots/animations),
[Chromatic: threshold and anti-aliasing](https://www.chromatic.com/docs/threshold/),
[Chromatic: flake filter](https://www.chromatic.com/docs/flake-filter/).

## Tested against

Same URL captured as base and head, 375 and 1280 px, viewport and full page (October
2026): playwright.dev, tailwindcss.com (lazy images, JS-animated demos below the fold),
swiperjs.com (autoplay video carousel, rotating banner), animate.style, a local Astro 7
blog (astro-paper, dev server) and a Next.js 16 dev server.

| | Before these defaults | After |
|---|---|---|
| Live-site pairs with any changed pixel | 13 of 32 (up to 12.2%: video frames, a JS-rotated banner, JS-animated sliders) | 4 of 48, all the same widget (see below) |
| Local Astro + Next pairs | 0 of 60 | 0 of 72 |
| Same page, separate runs (byte-identical base.png?) | not measured | identical on every page except the widget below |

Unchanged pairs stay at exactly 0 even with `--pixel-threshold 0 --include-aa`. The one
residual: tailwindcss.com's responsive-design demo at 1280 px full page, whose drag handle
lands in one of two positions (two 8×56 px regions, 4 of 6 runs in the last batch). Its
driver is neither a timer, a CSS animation nor `element.animate()`; mask such widgets.
A synthetic page with a `.finished`-chained `element.animate()` loop, an
`animationiteration` counter and a `performance.now()` rAF loop renders byte-identically
across separate runs (it differed on every run before).

## When it still flakes

| Symptom in compare.png | Likely cause | Fix |
|---|---|---|
| User avatar, Gravatar, map tiles, ads, embeds differ | Third-party content | `--mask ".avatar,.map,iframe"` (magenta box on both sides) |
| Random content differs despite the seeded PRNG | Random calls in a network-dependent order, or `crypto.getRandomValues` | `--mask` / `--hide` that element |
| Canvas / WebGL scene differs | GPU-driven or wall-clock animation | `--mask canvas` |
| Toasts, cookie banners, chat widgets | Timed popups that slipped through, or server-side A/B | `--hide "#intercom-container,.cookie-banner"` |
| Skeleton loaders in one side | Data arrives after network idle (websockets, polling) | `--wait-for ".content-loaded"`, or add `aria-busy` to the loader |
| Content that should appear after a delay is missing on both sides | App waits on a timer longer than the settle budget | `--settle 5000`, or `--wait-for <selector>` (advances JS time while waiting) |
| Different list contents, counts, names | Base and head talk to different data | Point both at the same API/seed, or mask the data region. Diffs here are not UI changes. |
| Whole page shifted by a few px | Font fallback on one side (font 404 in the worktree?) | Check `base.png`; make sure assets build in the worktree. |
| A whole band is light blue in the diff | A real layout change pushed content down | Not noise. `summary.json` `shifts` says where and by how much; describe the cause (the red region above the band), not each moved block. |
| Amber pixels ("faint change") | A colour tweak below the visible threshold, or the edge of a pale element that grew | Real but subtle. The note names the dominant colour pair (`faintColors` in summary.json, e.g. `#6b7280 → #64748b`); check it was intended. Fewer than 40 faint px with nothing visible is ignored. |

Extra CSS for anything else: `--css "selector { ... }"` or `--css path/to/file.css`
(injected on both sides). Turn the virtual clock off with `--no-freeze-time` only if an app
genuinely breaks under it (both sides then run on wall-clock time again).

## Mask vs hide vs freeze

- **freeze** (default) keeps the content real but deterministic.
- **mask** keeps layout (element still occupies space) and paints over it. Good for
  images and embeds whose *size* matters but content doesn't.
- **hide** (`visibility:hidden`) also keeps layout but leaves a blank. Good for overlays.
- Avoid `display:none` via `--css` unless the element is irrelevant: it changes layout and
  can hide real regressions.

Always mention masked regions in the PR section (summary.md lists them) so reviewers know
what wasn't compared.

## Determinism across machines

Screenshots from different OSes differ in font rendering. Capture base and head on the
same machine in the same run (the skill always does). Don't compare against PNGs saved
from another machine or CI image.
