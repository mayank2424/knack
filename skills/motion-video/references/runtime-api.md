# Motion runtime API

`motion.js` is a dependency-free timeline. Every visual state is a pure function of `t` (seconds). The renderer calls `Motion.seek(t)` once per frame. The preview player calls it from `requestAnimationFrame`.

## Composition skeleton

```html
<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;800&display=block" rel="stylesheet" />
  <script src="motion.js"></script>   <!-- must load before your script -->
  <style> #stage { background: #0b0b10; color: #fff; font-family: Inter, sans-serif; } </style>
</head><body>
  <div id="stage">
    <h1 id="title">Hello</h1>
  </div>
  <script>
    Motion.config({ width: 1920, height: 1080, fps: 30, duration: 6 });
    Motion.from('#title', { opacity: 0, y: 40 }, { start: 0.3, duration: 0.8, ease: 'snappy' });
  </script>
</body></html>
```

`#stage` is sized automatically from `config`. Position children absolutely inside it, or use flex or grid.

## `Motion.config(opts)`

| key | default | notes |
|---|---|---|
| `width`, `height` | 1920, 1080 | Pixel size of the output video. |
| `fps` | 30 | 24 is cinematic, 30 is standard, 60 suits fast UI motion and stings. |
| `duration` | 6 | Length in seconds. The lint warns if tweens run past it. |
| `background` | `#0b0b10` | Applied to `#stage` unless CSS already sets a background. Use `'transparent'` for alpha output. |

## Tweens

### `Motion.to(target, opts)`

`target` is a selector, an Element, a NodeList, or an array that mixes elements and selectors (`['#l1', '#l2']`).

```js
Motion.to('#card', {
  start: 1.2,            // seconds
  duration: 0.8,         // seconds
  ease: 'snappy',        // name | [x1,y1,x2,y2] | { stiffness, damping, mass } | (p) => p
  stagger: 0.06,         // per-element delay when target matches several elements
  from: { opacity: 0, y: 60 },
  to:   { opacity: 1, y: 0 },
});
```

There is a shorthand form: `Motion.to(target, toProps, { start, duration, ease, from })`.

**Chaining.** Tweens on the same element and property form a track:
- If a later tween has no `from`, it starts from the previous tween's `to`.
- Before the first tween starts, the property holds that tween's `from` value.
- After the last tween ends, it holds the last `to` value.

So an entrance followed by an exit only needs `to` on the exit.

### `Motion.from(target, fromProps, opts)`

This is an entrance: it animates *from* `fromProps` to the natural state (`opacity: 1`, `x/y: 0`, `scale: 1`, …).

### Animatable properties

| Property | Unit default | Notes |
|---|---|---|
| `x`, `y`, `z` | px | Strings work too: `'110%'` is relative to the element's own size. |
| `scale`, `scaleX`, `scaleY` | – | |
| `rotate` | deg | |
| `rotateX`, `rotateY`, `skewX`, `skewY` | deg | These take over the whole `transform` property. Add `perspective` on a parent for 3D. |
| `opacity` | – | |
| `blur` | px | Writes `filter: blur()`. |
| Colors (`color`, `backgroundColor`, `borderColor`, …) | – | Hex and rgb(a) are interpolated in RGB. |
| Any CSS length (`width`, `height`, `left`, `borderRadius`, `letterSpacing`…) | px for numbers | Strings with units such as `'0.6em'` or `'40%'` are interpolated. |
| CSS variables (`'--progress'`) | as given | Drive `clip-path`, gradients, `background-size` and more from CSS. |
| `text` | – | Swaps `textContent` at the tween's end. Useful for discrete changes. |

### Easing

| Name | Character | Use for |
|---|---|---|
| `strong` | Strong ease-out, long soft landing (`0.16, 1, 0.3, 1`) | Text, cards and lockups: the premium default |
| `strongInOut` | Decisive symmetric (`0.77, 0, 0.175, 1`) | Selection moves, swaps, quick on-screen repositioning |
| `snappy` | Fast start, long soft settle | UI and text entrances |
| `smooth` | Symmetric ease-in-out | Camera moves, morphs, position-to-position moves |
| `outCubic`, `outQuart`, `outQuint`, `outExpo` | Decelerate (gentle → strong) | Entrances |
| `inCubic`, `inQuad` | Accelerate | Exits |
| `inOutCubic`, `inOutQuart`, `inOutExpo` | Symmetric | Loops, transitions |
| `outBack`, `inOutBack` | Slight overshoot | Playful pops, badges |
| `anticipate` | Pulls back, then overshoots | Emphatic hero moments (rarely) |
| `linear` | Constant | Progress bars, tickers, rotations |
| `[x1, y1, x2, y2]` | Custom cubic-bezier | Matching a brand motion spec |
| `{ stiffness, damping, mass }` | Physical spring, stretched to `duration` | Natural settles. Lower damping means more bounce. |

Spring starting points:
- `{ stiffness: 170, damping: 26 }`: smooth, no bounce
- `{ stiffness: 220, damping: 18 }`: one gentle overshoot
- `{ stiffness: 260, damping: 12 }`: bouncy

## Helpers

```js
Motion.split('#headline', 'words' | 'chars')   // wraps pieces in inline-block spans; returns them
Motion.counter('#n', { from, to, start, duration, ease, format: (n) => n.toFixed(1) + '%' })
Motion.draw('svg path', { start, duration, ease, reverse })   // stroke-dash draw-on
Motion.type('#code', { start, cps: 24, cursor: true })        // typewriter
Motion.on((t) => { ... })                                     // custom per-frame function; must be pure in t
Motion.interpolate(t, [0, 1, 2], [0, 100, 50], { ease: 'smooth', clamp: true })
Motion.random(seed)                                           // deterministic PRNG: const r = Motion.random(42); r()
Motion.clamp(v, lo, hi), Motion.lerp(a, b, p), Motion.ease.<name>
Motion.time                                                   // current t (read-only)
```

### Patterns

**Masked text rise.** Put each word or line in an `overflow: hidden` wrapper and tween the inner span from `y: '130%'` to `0` (exit to `'-130%'`). Use 130%, not 100–110%: the glyph box is taller than the line box, so smaller offsets leave ascender or descender slivers visible in the mask. See `templates/kinetic-type.html`.

**Before the first tween.** A property holds its first tween's `from` value until that tween starts. To keep something hidden until a later "flash", add a tiny opacity tween first (see the ring in `templates/logo-sting.html`). A negative `start` begins mid-entrance at frame 0, which is how you make the first frame (the social poster) already show the hook.

**Wipe reveal with a CSS variable:**
```css
.reveal { clip-path: inset(0 calc(100% - var(--r, 100%)) 0 0); }
```
```js
Motion.to('.reveal', { start: 1, duration: 0.8, ease: 'smooth', from: { '--r': '0%' }, to: { '--r': '100%' } });
```

**Highlighter sweep.** Combine `background-size: var(--hl) 100%` with a tween on `--hl`. See `templates/data-story.html`.

**Camera.** Wrap the scene in `#camera { transform-origin: 0 0 }` and tween `{ scale, x, y }` on it. To frame a rectangle `(rx, ry, rw, rh)` so it fills a fraction `f` of the frame:
```js
const s = Math.min(W * f / rw, H * f / rh);
const shot = { scale: s, x: W / 2 - (rx + rw / 2) * s, y: H / 2 - (ry + rh / 2) * s };
```

**Canvas or particles.** Draw inside `Motion.on(t => …)` and derive everything from `t` and a seeded PRNG. Precompute particle seeds once, outside the callback.

**Video clips inside a composition:** `<video src="clip.mp4" data-start="2" muted playsinline>`. Its playback is synced to the timeline, so at `t = 2` it plays from 0s.

**CSS `@keyframes`.** These are paused and seeked automatically, so `animation: spin 2s linear infinite` renders deterministically. Use `animation-delay` to schedule them.

**Per-format CSS.** While rendering, `<html>` has the classes `knack-render` and `knack-out-<ext>` (`mp4`, `gif`, `webm`, `mov`, `png`). Hide grain in GIFs with `.knack-out-gif .grain { display: none; }`.

**Fonts and images.** Before frame 0 the runtime loads every declared `@font-face` (all weights and unicode-range subsets) and decodes every `<img>`. That matters for canvas text in `Motion.on`, which otherwise draws in a fallback font, and for glyphs that only appear later (counters, `type`, `text` swaps).

## Preview player

When you open the HTML in a browser, a control bar is added:
- play/pause button and a scrub bar
- `Space` toggles play, `←` / `→` step one frame (add `Shift` for 10 frames), `Home` jumps to the start, `L` toggles loop
- the `?t=3.5` query parameter opens paused at that time

## Renderer CLI

```
node scripts/render.mjs comp.html [-o out.mp4|.webm|.gif|.mov|frames/]
  --still [t]          one PNG frame (default: middle); add --motion-blur N to preview blur
  --stills a,b,c       several exact moments on one sheet
  --filmstrip [n]      contact sheet of n frames (default 12, ≤1600px wide; --filmstrip-width N)
  --cuts [n]           ±n frames (default 2) around every Motion.cue(), one row per cue
  --score-only         write just the synthesized score (-o score.wav); --no-score renders silent
  --check              layout + timing lint (exit code 2 if issues)
  --fps N  --scale N  --from S  --to S  --workers N  --crf N
  --motion-blur N  --shutter DEG     sub-frame motion blur (default shutter 180)
  --trc bt709|srgb  --dither  --10bit  color tag, anti-banding dither, HEVC Main10
  --audio file.mp3  --audio-fade S  --transparent
  --gif-fps N  --gif-width N  --gif-colors N  --gifski  --gif-quality N
```

| Output | Codec | Notes |
|---|---|---|
| `.mp4` | H.264 High, yuv420p, CRF 18, aq-mode 3, BT.709 matrix + tags, faststart | Universal default. `--10bit` switches to HEVC Main10. |
| `.webm` | VP9, BT.709 tags | Use with `--transparent` to get alpha. |
| `.mov` | ProRes 4444 + alpha, BT.709 tags | For editors (Premiere, Final Cut, Resolve). Large files. |
| `.gif` | Whole-clip palette, sierra2_4a dither, changed-rectangle frames | Captured directly at 20fps and ≤ 960px wide. Keep READMEs under ~10 MB. |
| `dir/` | PNG sequence `frame-000000.png…` | Lossless, for editors or custom encodes. |

What the `--check` lint reports:
- tweens that run past `duration`
- more than 2.5s of dead air at the end
- text below 2% of frame height (with camera scale accounted for)
- text that breaks the 4% safe margin
- two visible text blocks overlapping (including mask slivers)
- an empty first frame on vertical/square video (the feed poster)
- `duration × fps` that isn't a whole number of frames
- fonts that failed to load
- page errors

Text inside `[data-knack-ignore]` is skipped.

## Showreel kit

These helpers are for creative-freedom pieces. See `references/showreel.md` for how to use them together.

| Helper | What it does |
|---|---|
| `Motion.beats({ bpm, offset, perBar })` → `B` | `B(n)` is the time of beat n, `B.bar(n)` the start of bar n, `B.index(t)` the beat position at t, and `B.pulse(t)` an envelope that's 1 on each beat and decays. It also sets the BPM for the score |
| `stagger: { each, from, grid, ease, seed }` | Use in any `Motion.to`. `from`: `'start'`, `'center'`, `'end'`, `'edges'`, `'random'` or a cell index. `grid: [cols, rows]` ripples out by 2D distance. Delay = distance × `each` |
| `Motion.noise(x, y, z)` / `Motion.makeNoise(seed)` | Seeded 3D simplex noise in [-1, 1], for organic drift, blobs and flow fields |
| `Motion.canvas([opts,] (ctx, t, { w, h }) => {})` | Full-stage canvas redrawn every frame at the render's pixel ratio (stays sharp with `--scale 2`). It goes inside `#cam` when that wrapper exists, so camera moves apply to it. `opts`: `parent`, `zIndex`, `id`, `el` (an existing canvas is positioned for you), `width`, `height` |
| `Motion.textPoints(text, { font, cx, cy, step })` | Rasterizes text into an array of `{ x, y }` points, for particles that form type. Call it inside `Motion.ready()` |
| `Motion.morph(target, { start, duration, hold, ease, shapes, points })` | Morphs an SVG `<path>` through any closed shapes, played back to back. Point counts don't need to match |
| `Motion.samplePath(d, n)` | Resamples a path into `n` evenly spaced `[x, y]` points |
| `Motion.ready(fn)` | Runs `fn` once after fonts and images have loaded and before frame 0. Use it for anything that measures text or layout |
| `Motion.score({ bpm, key, scale, mood, drums, start, end, gain, sections })` | Declares the synthesized music bed. `mood`: `driving`, `minimal` or `cinematic`. `sections: [{ at, drums, bass, arp, pad, filter }]` arranges breakdowns, builds (the filter glides into the next section) and drops. `from`/`to` are accepted as aliases for `start`/`end` |
| `Motion.cue(t, type, { gain, length })` | Places a sound effect: `whoosh`, `impact`, `hit`, `drop`, `riser`, `swell`, `pop`, `tick` or `glitch`. Risers and swells end at `t`; `whoosh` peaks just before `t`. Cue times also drive `render.mjs --cuts` |
| `Motion.spring({ stiffness, damping, mass })`, `Motion.resolveEase(e)`, `Motion.bezier(...)` | Ease functions for custom code in `Motion.on()`: each returns `p → value` |

When a composition calls `score()` or `cue()`, `render.mjs` synthesizes the audio with `scripts/score.mjs` and muxes it in. Loudness is measured per ITU-R BS.1770 and normalized to -14 LUFS, with a -1 dBFS sample-peak ceiling. Pass `--no-score` to render silently, or `--audio file` to use your own track.
