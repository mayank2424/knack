# Stabilizing screenshots

A visual diff is only useful if an unchanged page produces zero changed pixels. This page
lists where flakiness comes from, what `capture.mjs` already does about it, and the flag to
reach for when something still moves.

## What capture.mjs does by default

| Source of noise | Built-in fix |
|---|---|
| CSS animations and transitions | Injected CSS sets durations/delays to 0; Playwright `animations: "disabled"` fast-forwards finite animations and cancels infinite ones. |
| `prefers-reduced-motion`-aware code | Context runs with `reducedMotion: "reduce"`. |
| Blinking text caret | `caret: "hide"` + `caret-color: transparent`. |
| Scrollbars (and the width they steal) | `--hide-scrollbars` launch flag + `::-webkit-scrollbar { display: none }`. |
| Web fonts swapping in late | Waits for `document.fonts.ready`. |
| Lazy images | `loading="lazy"` switched to eager, waits up to 5 s for images to finish; with `--full-page` the page is scrolled top to bottom first to trigger observers. |
| Late XHR/fetch content | Waits for `networkidle` (capped at 10 s, then captures anyway and notes it). |
| Smooth scrolling | `scroll-behavior: auto`; page scrolled back to 0 before capture. |
| Locale/timezone differences | `en-US`, `UTC`, fixed `deviceScaleFactor`, sRGB color profile, LCD text antialiasing off. |
| Dev-tool overlays | Next.js dev indicator/toasts, Vite error overlay, Astro dev toolbar, webpack/Nuxt overlays hidden (`--no-dev-overlays` to keep them). |
| Something still moving | Stability check: takes screenshots 250 ms apart until two in a row are identical (max 5 tries). If never stable, the pair is flagged "page kept changing". |
| Anti-aliasing jitter | pixelmatch's anti-aliasing detection ignores AA pixels; `--pixel-threshold` (default 0.1) tolerates tiny color shifts. |

## When it still flakes

| Symptom in compare.png | Likely cause | Fix |
|---|---|---|
| A clock, "5 minutes ago", copyright year, countdown differs | `Date.now()` | `--freeze-time` (pins Date to 2024-01-01T10:00:00Z, or pass an ISO date) |
| Shuffled testimonials, random avatars, A/B buckets | `Math.random()` | `--freeze-time` also seeds `Math.random` |
| User avatar, Gravatar, map tiles, ads, embeds | Third-party content | `--mask ".avatar,.map,iframe"` (paints magenta box on both sides) |
| Carousel/marquee mid-slide, video frame | JS-driven animation | `--hide ".carousel"` or `--mask video`, or `--wait-for 2000` |
| Toasts, cookie banners, chat widgets | Timed popups | `--hide "#intercom-container,.cookie-banner"` |
| Skeleton loaders in one side | Data arrives after network idle (websockets, polling) | `--wait-for ".content-loaded"` (a selector that only exists when ready) |
| Different list contents, counts, names | Base and head talk to different data | Point both at the same API/seed, or mask the data region. Diffs here are not UI changes. |
| Whole page shifted by a few px | Font fallback on one side (font file 404 in worktree?) | Check `base.png` font; make sure assets build in the worktree. |
| Everything below a point is red | A real layout change pushed content down | Not noise. `summary.json` `shift` tells you where and by how much; describe the cause, not each moved block. |
| Tiny scattered dots | Sub-pixel rendering differences | Stays under `--threshold` as "minor". Raise `--pixel-threshold` to 0.2 if it bothers you. |

Extra CSS for anything else: `--css "selector { ... }"` or `--css path/to/file.css`
(injected on both sides).

## Mask vs hide vs freeze

- **freeze** keeps the content real but deterministic. Prefer it for time and randomness.
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
