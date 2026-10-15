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

`target` is a selector, an Element, or an array or NodeList of elements.

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
| `snappy` | Fast start, long soft settle | UI and text entrances (the default choice) |
| `smooth` | Symmetric ease-in-out | Camera moves, morphs, position-to-position moves |
| `outCubic`, `outQuart`, `outExpo` | Decelerate (gentle → strong) | Entrances |
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

**Masked text rise.** Put each word in an `overflow: hidden` wrapper and tween the inner span from `y: '110%'` to `0`. See `templates/kinetic-type.html`.

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

## Preview player

When you open the HTML in a browser, a control bar is added:
- play/pause button and a scrub bar
- `Space` toggles play, `←` / `→` step one frame (add `Shift` for 10 frames), `Home` jumps to the start, `L` toggles loop
- the `?t=3.5` query parameter opens paused at that time

## Renderer CLI

```
node scripts/render.mjs comp.html [-o out.mp4|.webm|.gif|.mov]
  --still [t]          one PNG frame (default: middle)
  --filmstrip [n]      contact sheet of n frames (default 12)
  --check              layout + timing lint (exit code 2 if issues)
  --fps N  --scale N  --from S  --to S  --workers N  --crf N
  --audio file.mp3  --audio-fade S  --transparent  --gif-fps N  --gif-width N
```

| Output | Codec | Notes |
|---|---|---|
| `.mp4` | H.264 yuv420p, CRF 18, faststart | Universal default. |
| `.webm` | VP9 | Use with `--transparent` to get alpha. |
| `.mov` | ProRes 4444 + alpha | For editors (Premiere, Final Cut, Resolve). Large files. |
| `.gif` | Two-pass palette | Defaults to 20fps and ≤ 960px wide. Keep READMEs under ~10 MB. |

What the `--check` lint reports:
- tweens that run past `duration`
- more than 2.5s of dead air at the end
- text below 2% of frame height (with camera scale accounted for)
- text that breaks the 4% safe margin
- fonts that failed to load
- page errors

Text inside `[data-knack-ignore]` is skipped.
