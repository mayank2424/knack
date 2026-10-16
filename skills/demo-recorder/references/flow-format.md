# Flow file format

A flow is a JSON file (comments and trailing commas allowed) that describes one demo clip.
`record.mjs` runs it in headless Chromium with virtual time, draws a synthetic cursor and
overlays, and captures every frame.

```jsonc
{
  "url": "http://localhost:3000/projects",   // opened before step 1 (not recorded)
  "viewport": "1280x800",                     // CSS px; 1024x680 or 1280x800 read well as GIFs
  "format": ["mp4", "gif"],                   // or "mp4"; CLI --format / -o wins
  "frame": { "background": "aurora", "title": "acme.app/projects" },
  "setup": [ { "click": "text=Dismiss" } ],   // runs before recording starts, never captured
  "steps": [
    { "click": "role=button[name=\"New project\"]" },
    { "type": "Q4 launch plan", "into": "#project-name" },
    { "press": "Enter" },
    { "wait": "text=Project created" }
  ]
}
```

## Top-level options

| Key | Default | Notes |
| --- | --- | --- |
| `url` | none | First page. Absolute URL, `localhost:3000`, or a path to an HTML file relative to the flow file. Relative `goto` values resolve against it. |
| `viewport` | `"1280x800"` | `"WxH"` string or `{ "width", "height" }`. Smaller viewports make bigger, more legible UI in the clip. |
| `scale` | `2` | Device scale factor. 2 gives retina-sharp text; 1 halves capture time. |
| `fps` | `30` | Capture rate. GIFs are resampled to `gifFps`. |
| `format` | `"mp4"` | `"mp4"`, `"gif"`, `"webm"`, or an array. |
| `name` | flow file name | Output base name in `.knack/demo-recorder/`. |
| `frame` | off | `true` or `{ background, title, theme, padding, radius }`. Backgrounds: `aurora`, `sunset`, `ocean`, `mint`, `mono`, `midnight`, or any CSS background. `theme`: `light`/`dark` title bar (defaults to `colorScheme`). |
| `cursor` | visible | `false` to hide, or `{ size, color, speed, blur, start: [x, y] }`. `size` defaults to 1.35 (a macOS-size arrow is hard to follow once the clip is scaled down). `color` tints click ripples and highlights (default `#6366f1`); `speed` > 1 moves faster; `blur` is the motion-blur shutter as a fraction of a frame (default 0.5 = 180°, 0 = off). |
| `typeDelay` | `55` | Base ms per character; each keystroke gets human-like jitter, longer after spaces and punctuation. |
| `pauses` | see below | Override the default pause after each step type, e.g. `{ "click": 800 }`. |
| `leadIn` / `tail` | `400` / `1200` | Still time before the first step and after the last (a calm end frame loops better). |
| `trimIdle` | `0` | Cut runs of identical frames longer than this many ms. Same as `--trim-idle`. |
| `maxSeconds` | none | Hard cap; the end gets cut with a warning. |
| `speed` | `1` | Playback speed multiplier applied at encode time. |
| `maxWidth` / `gifWidth` / `gifFps` / `crf` | 1920 / 960 / 15 / 20 | Encoding knobs (also CLI flags). |
| `colorScheme` | page default | `"light"` or `"dark"` (prefers-color-scheme). |
| `locale`, `userAgent` | browser default | Passed to the browser context. |
| `storageState` | none | Playwright storage-state JSON (cookies + localStorage) to start logged in. Path relative to the flow file. |
| `hide` | `[]` | CSS selectors to hide: cookie banners, dev toolbars, Next.js/Vite badges, chat widgets. |
| `css` | none | Extra CSS injected into every page. |
| `hideScrollbars` | `true` | Hides all scrollbars. |
| `timeout` | `8000` | Default ms a step waits for its target to appear (virtual time). |
| `realtime` | `false` | Turn off virtual time (see Limitations). Same as `--realtime`. |
| `zoom` | `true` | `false` skips every `zoom` step (a reduced-motion take). Same as `--no-zoom`. |
| `idleSkip` | `true` | Reuse the previous frame when nothing changed (no DOM mutation, scroll, load, running animation, visible canvas/video/iframe, input, or overlay change). Every 15th reuse is checked against a real screenshot; a mismatch turns reuse off for the rest of the take. `false` / `--no-idle-skip` screenshots every frame. |
| `seed` | `7` | Seed for typing jitter, so re-recordings are identical. |
| `sheet` | `12` | Frames in the contact sheet. |

Strings anywhere may contain `${env:NAME}`; the value comes from the environment and the run
fails if it is unset. Use it for local test credentials, never for real secrets.

## Targets (selectors)

Anything Playwright's `page.locator()` accepts:

- CSS: `#save`, `.card:nth-child(2) button`, `[data-testid="submit"]`
- Text: `text=Save changes` (substring, case-insensitive) or `text="Save"` (exact)
- Role: `role=button[name="Save"]`, `role=link[name="Pricing"]`, `role=textbox[name="Email"]`
- Combined: `.sidebar >> text=Settings`, `li:has-text("Invoices") >> role=button`
- Coordinates: `[640, 400]` (CSS px in the viewport) for `click`, `hover`, `drag.to`, `cursor`

The first visible match is used; add `"nth": 2` to pick another. Prefer `data-testid`, ids and
role+name over long CSS paths. `inspect.mjs <url>` prints a robust selector for every
interactive element.

Off-screen targets are scrolled into view smoothly (nearest scrollable container first),
then the cursor travels to the element centre. Adjust the landing point with
`"offset": [dx, dy]` or `"position": "left" | "right"`.

## Common step fields

| Field | Meaning |
| --- | --- |
| `pause` | ms to hold after the step. Defaults: goto 700, click 650, type 450, press 650, hover 500, scroll 450, drag 600, select 600, zoom 200, others 0. |
| `timeout` | Override how long to wait for the target. |
| `nth` | Use the nth match (0-based) instead of the first. |
| `moveDuration` | Force cursor travel time in ms (normally derived from distance, Fitts-style: 320 to 1050 ms). |

## Steps

### goto
```json
{ "goto": "/settings" }
{ "goto": "http://localhost:5173/pricing", "waitUntil": "networkidle" }
```
Navigates (a hard cut in the video). `waitUntil`: `load` (default), `domcontentloaded`, `networkidle`.

### click
```json
{ "click": "role=button[name=\"Create\"]" }
{ "click": ".row:nth-child(3)", "double": true }
{ "click": "#menu", "button": "right" }
{ "click": [880, 120] }
```
Slightly curved cursor travel with a human velocity profile (minimum-jerk, peaking early
at ~1.8x average speed, then settling gently onto the target) and motion blur while it
moves, a press-down squish, real mouse events (hover and `:active` styles show), and a
ripple at the click point.

### type
```json
{ "type": "hello@acme.dev", "into": "#email" }
{ "type": "Ship it", "clear": true, "delay": 40 }
```
`into` clicks the field first (with cursor travel). Without it, keys go to the focused
element. `clear` selects all and deletes before typing. `\n` presses Enter.

### press
```json
{ "press": "Enter" }
{ "press": "Meta+K" }
{ "press": ["ArrowDown", "ArrowDown", "Enter"], "gap": 300 }
{ "press": "Escape", "hud": false }
```
Playwright key names. Aliases: `Cmd`/`Command` → Meta, `Ctrl` → Control, `Option` → Alt,
`ControlOrMeta` (⌘ on macOS, Ctrl elsewhere). A letter in a combo is sent lowercase unless
Shift is part of it (`Meta+K` arrives as `key: "k"`, like a real keyboard; palettes such as
DocSearch ignore an uppercase `K`). Combos (anything with `+`), Escape and Tab show
a keystroke HUD (`⌘ K`) at the bottom; force with `"hud": true` / `false`, length with
`hudDuration` (default 1000 ms).

### hover
```json
{ "hover": ".chart-bar:nth-child(4)" }
```
Moves the cursor there and holds, so tooltips and hover states show.

### scroll
```json
{ "scroll": 600 }
{ "scroll": -300 }
{ "scroll": "bottom" }
{ "scroll": "#pricing" }
{ "scroll": { "to": "#faq", "duration": 1200 } }
{ "scroll": { "by": 400, "in": ".sidebar" } }
```
Smooth eased scrolling computed per frame (it ignores CSS `scroll-behavior`). `in` takes a
CSS selector of the scroll container; without it the page scrolls.

### wait
```json
{ "wait": 800 }
{ "wait": "text=Saved" }
{ "wait": { "for": "#results li", "timeout": 15000 } }
{ "wait": { "gone": ".spinner" } }
```
Waiting is recorded (spinners stay visible). Use `--trim-idle` to cut long still stretches.

### drag
```json
{ "drag": ".card#c42", "to": ".column#done" }
{ "drag": ".slider-thumb", "to": [180, 0] }
{ "drag": "#box", "to": [900, 300], "absolute": true }
```
Press, eased move, release. A coordinate pair is relative to the start unless `absolute`.
Works with mouse/pointer-based drag libraries; native HTML5 drag-and-drop also works in
Chromium for most apps.

### select
```json
{ "select": "#country", "value": "IN" }
```
Cursor travels to the `<select>`, ripples, and the option is set (native dropdown menus do
not render in headless screenshots, so it is not opened).

### zoom
```json
{ "zoom": { "to": "#chart", "scale": 1.8 } }
{ "zoom": { "to": ".editor", "scale": 1.5, "follow": true, "duration": 900 } }
{ "zoom": 1.6 }
{ "zoom": "out" }
```
Smooth camera zoom that re-renders at higher resolution (sharp text, not upscaled pixels).
`to` centres on a target (default: the cursor); without `scale` it fits the target to ~80%
of the width / 70% of the height (1.25x to 2.2x). Zoom is interpolated in log space and,
when one view contains the other, around their shared fixed point, so the target scales
straight in instead of sliding sideways; the easing commits quickly and settles softly.
`follow: true` keeps the cursor in frame, panning gently when it nears the edge (it can
crop the far side of a wide row; prefer a plain zoom on a container). Stays zoomed until
`"zoom": "out"`. Scale 1 to 4. `duration` defaults to 800 ms.

### highlight
```json
{ "highlight": "#plan-pro", "duration": 1500 }
{ "highlight": ".total", "dim": true, "color": "#22c55e", "padding": 10 }
{ "highlight": "#x", "block": false }
{ "highlight": false }
```
Ring around an element (tracks it if it moves); `dim` darkens everything else. Blocks for
`duration` by default; `"block": false` lets the next steps run while it shows.

### caption
```json
{ "caption": "Invite your team in one click", "duration": 2400 }
{ "caption": "Step 2: review", "position": "top", "duration": 0 }
{ "caption": false }
```
Pill-shaped text overlay. Non-blocking by default (shows while the following steps run);
`"block": true` holds for its duration. `duration: 0` keeps it until `"caption": false`.

### cursor
```json
{ "cursor": [900, 560] }
{ "cursor": false }
{ "cursor": true }
```
Move the cursor somewhere neutral (park it before opening a menu so it does not hover an
item), or hide/show it.

### js
```json
{ "js": "localStorage.setItem('onboarded', '1')" }
{ "js": "document.querySelector('#chat-widget')?.remove()" }
```
Runs an expression in the page. Best in `setup`.

## Output encoding

- **MP4** (H.264 High, yuv420p, `+faststart`, even dimensions) and **WebM** (VP9) are
  converted with the BT.709 matrix and tagged BT.709 primaries/matrix, sRGB transfer,
  limited range. Measured on a swatch chart, rendered in Chrome: mean ΔE 0.3 (untagged
  BT.601, the ffmpeg default, gave 5.6, max 12.4). Tagging the transfer as bt709 instead
  makes Safari wash colours out (ΔE 3.8), so sRGB is used.
- **GIF**: one palette built from every pixel of the clip (`stats_mode=full`),
  Floyd-Steinberg dithering, only changed rectangles re-encoded. Compared with the common
  `stats_mode=diff` recipe: PSNR 35.7 → 43.3 dB and ~8% smaller on the bundled example;
  window chrome and wallpaper gradients no longer speckle.
- Zoomed frames are captured a few pixels oversize and cropped exactly (Chrome truncates
  fractional-scale clips by 1 to 3 px; rescaling those made zooms wobble).

## Recipes

**Logged-in app.** Put the login in `setup` (not recorded) using a seeded test account and
`${env:...}` for its password, or record against a dev build with auth bypassed, or export a
Playwright `storageState` once and reference it.

**Long page tour.** `scroll` to each section with a `caption`, `pause` 900+ on each, and end
with `{ "scroll": "top" }` so the GIF loops cleanly.

**Keyboard-first feature.** `press` combos get the HUD automatically; add a `caption` naming
the shortcut so it reads without sound.

**Detail shot.** `zoom` to the element, act, `zoom` out. Keep zoomed segments short (2 to 4 s)
and scale ≤ 2 so context stays readable.
