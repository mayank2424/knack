---
name: demo-recorder
description: >-
  Records a polished GIF, MP4 or WebM of a feature flow in a running web app, for READMEs,
  pull requests, docs, changelogs and X/LinkedIn posts. Drives headless Chromium from a small
  JSON flow (click, type, press, hover, scroll, drag, wait, zoom, highlight, caption) with
  virtual time, so every frame is captured at retina sharpness with a human-feel,
  motion-blurred cursor, click ripples, smooth zoom, keystroke HUD and optional macOS window
  frame, encoded colour-accurate. Verifies itself:
  dry-run screenshots per step, selector suggestions on failure, and a contact sheet of the
  final clip to review. Use when the user says "record a demo", "make a GIF of this feature",
  "screen recording of the signup flow", "demo video for the README", "add a GIF to the PR",
  "show this feature in action", "capture a walkthrough", or wants a product clip of their
  own app. Not for authored motion graphics or explainer animations (use a motion/video skill).
license: MIT
metadata:
  title: Demo Recorder
  category: media
  tags: gif, screen-recording, demo, video, readme, playwright, ffmpeg
  version: 0.1.0
  author: Mayank Gupta
---

# Demo Recorder

Turn "show how X works" into a short, crisp clip of the real app. You script the flow, the
recorder plays it with a human-looking cursor, and you check the result before handing it over.

Scripts live in `${CLAUDE_SKILL_DIR}/scripts/` (Node 18+ ESM, all support `--help`). Output goes to
`./.knack/demo-recorder/` in the current project unless `-o` says otherwise.

## 0. One-time setup

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/setup.sh"     # Playwright 1.63.0 + Chromium + checks ffmpeg; idempotent
```

If it prints a fix (install ffmpeg, Node 18+), relay it to the user and stop.

## 1. Pin down the clip

Get these from the request or ask in one short message (skip what is obvious):

- **What it shows**: one feature, one idea. "Creating an invoice", not "the whole app".
- **Where it goes**: sets format and size.

| Destination | Format | Suggested settings |
| --- | --- | --- |
| README / docs | GIF (and MP4 as backup) | viewport `1024x680`, `--frame`, under 15 s, under 10 MB |
| PR description | MP4 or GIF | no frame, show before/after state, under 20 s |
| X / LinkedIn / changelog | MP4 | `--frame`, captions (autoplay is muted), 1280x800 or 1080x1080 |

- **Light or dark**, and whether demo data exists. Never record real customer data or
  real credentials; use seeded/fake data and test accounts.

## 2. Make sure the app is running

Ask for the URL if the user has not given it. Otherwise detect it:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect.mjs" --find-server      # probes common localhost ports, prints titles
```

If nothing answers, look at `package.json` scripts (`dev`, `start`), start the dev server in
the background, and wait until it responds. Static HTML files work too (pass the path).

## 3. Inspect the page for selectors

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect.mjs" http://localhost:3000/invoices --viewport 1024x680
```

Prints every visible interactive element with a robust selector (data-testid, id,
`role=button[name="…"]`, placeholder, text) and saves an annotated screenshot with numbered
boxes at `.knack/demo-recorder/inspect.png`. Read that image to understand the layout. Use
`--wait <selector>` for pages that load late and `--storage state.json` for logged-in pages.
For elements that only appear mid-flow (modals, menus), write the flow up to that point and
use the dry-run screenshots instead.

## 4. Write the flow

Save it next to where the clip will live (e.g. `docs/demos/invoice.flow.json`) or in
`.knack/demo-recorder/`. Minimal shape:

```jsonc
{
  "url": "http://localhost:3000/invoices",
  "viewport": "1024x680",
  "format": ["gif", "mp4"],
  "frame": { "background": "aurora", "title": "acme.app/invoices" },
  "hide": ["#cookie-banner", "nextjs-portal"],
  "steps": [
    { "caption": "Create an invoice in seconds", "duration": 2400 },
    { "click": "role=button[name=\"New invoice\"]" },
    { "type": "Northwind Traders", "into": "[placeholder=\"Customer\"]" },
    { "press": "Tab" },
    { "type": "1200" },
    { "zoom": { "to": "#total", "scale": 1.6 } },
    { "click": "text=Send invoice", "pause": 900 },
    { "zoom": "out" },
    { "wait": "text=Invoice sent" },
    { "highlight": ".status-badge", "duration": 1200 }
  ]
}
```

Step types: `goto`, `click`, `type`, `press`, `hover`, `scroll`, `wait`, `drag`, `select`,
`zoom`, `highlight`, `caption`, `cursor`, `js`, plus an unrecorded `setup` list for logins
and dismissing banners. **Read `${CLAUDE_SKILL_DIR}/references/flow-format.md`** when you
need options beyond the example (offsets, double click, drag targets, scroll containers,
captions that persist, env-var credentials, frame backgrounds).

Choreography rules that make demos good:

- **Under 15 s, one idea.** Split longer stories into several clips.
- **Breathe.** Each meaningful action gets 600 to 900 ms of `pause` so viewers can read the
  result. Defaults already do this; raise `pause` after big state changes.
- **Start calm, end calm.** The first frame is the thumbnail and the last frame loops; both
  should show a clean, meaningful state.
- **Realistic data.** Names, amounts and copy that look like real use, never lorem ipsum,
  never real customer data or secrets.
- **Captions carry meaning** for muted autoplay. Keep them under ~6 words.
- **Zoom for detail, briefly.** Zoom on small UI, act, zoom out. Omit `scale` and the zoom
  fits the target (80% of the width / 70% of the height, 1.25x to 2.2x). Viewers complain
  about constant zooming: one or two zooms per clip, held 2 to 4 s. Zoom a container that
  includes the heading so nothing is cut mid-word. Captions and the keystroke HUD are drawn
  in screen space, so they keep their size and place through a zoom; no need to time
  around them.
- **Park the cursor** (`{ "cursor": [x, y] }`) before opening menus or palettes so it does
  not hover-select an item.
- **Hide noise**: cookie banners, dev toolbars, framework badges, chat widgets via `hide`.
  Scrollbars are hidden by default.
- Prefer a smaller viewport (1024x680 or 960x600) for GIFs. GitHub shows media at most
  ~880 px wide, so a 1024 px page in a window frame displays body text at ~0.77x. The
  recorder prints this as a `Legibility:` line after each take.

## 5. Dry run: verify every step before recording

```bash
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" path/to/flow.json --dry-run
```

Runs the whole flow without encoding, saves a screenshot after each step (the camera view,
so zooms show, with captions and the keystroke HUD drawn; a blocking `highlight` or caption
is captured while it shows), and builds `<name>-steps.png` (one image, every step labelled,
1600 px wide). **Read it.** Check each step landed on the right element
and the UI reached the expected state.

On failure it exits non-zero and prints the failing step, similar visible elements with
ready-to-paste selectors, and an `-error.png` screenshot. Fix the flow and dry-run again.

## 6. Record

```bash
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" path/to/flow.json                     # formats from the flow (default mp4)
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" path/to/flow.json --format gif,mp4 --frame --trim-idle
node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" path/to/flow.json -o docs/media/invoice.gif
```

Useful flags: `--viewport WxH`, `--frame` / `--background sunset`, `--trim-idle [ms]` (cut
long still stretches), `--speed 1.2`, `--max-seconds 15`, `--gif-width 720 --gif-fps 12`
(smaller GIF), `--crf 24` (smaller MP4), `--scale 1` (faster capture), `--no-zoom`
(reduced-motion take), `--cursor-size 1.6`, `--cursor-blur 0`, `--sheet-width 1200`
(contact-sheet width). `--help` lists all.

It prints each output with size and duration, a `Legibility:` estimate (typical text size
at README and phone width), warns over 10 MB (GitHub's upload limit) or over 15 s, and
writes `<name>-sheet.png` (1600 px wide, 256-colour PNG, typically 100 to 300 KB). MP4/WebM are BT.709-converted and tagged so colours match the
page in Chrome and Safari; GIFs use one full-clip palette with Floyd-Steinberg dithering.

## 7. Review the result (do not skip)

**Read `<name>-sheet.png`**: 12 frames from the encoded file, each labelled with time and the
step that was running. Check:

- Cursor is visible, lands on targets, and click ripples appear where expected (a smeared
  cursor mid-move is the motion blur, not a glitch).
- Text is legible at the delivered size; nothing important is hidden behind captions or the
  keystroke HUD; zoomed shots keep the action in frame.
- No cookie banners, dev overlays, error toasts, real personal data or secrets.
- First and last frames are clean; pacing is not rushed (actions visible for ~1 s).

To inspect one moment at full size:

```bash
ffmpeg -loglevel error -ss 4.2 -i .knack/demo-recorder/invoice.mp4 -frames:v 1 /tmp/peek.png
```

Fix the flow (timing, selectors, zoom, captions) and re-record until the sheet looks right.
Timing is virtual, typing jitter is seeded and the text caret blinks on the virtual clock,
so unchanged steps come out the same on re-record (measured: 98% of frames bit-identical,
the rest differ by at most 7/255 on a few dozen anti-aliased pixels).

## 8. Deliver

Copy the file where it belongs (ask if unclear, e.g. `docs/media/` or `.github/assets/`),
keep the flow file next to it so the demo can be re-recorded after UI changes, and give the
user the embed snippet:

```markdown
![Creating an invoice in Acme](docs/media/invoice.gif)
```

- **GitHub PR / issue / README editor**: dragging the `.mp4` into the editor on github.com
  uploads it and inserts a `user-attachments` URL that plays inline. Free plans cap uploads
  at 10 MB.
- **Docs sites / HTML**: `<video src="invoice.mp4" autoplay loop muted playsinline width="880"></video>`
- **X / LinkedIn**: upload the MP4 directly (not the GIF).

Report: output paths, duration, sizes, and anything you could not show.

## Limitations

- Virtual time freezes JS timers, `requestAnimationFrame` and CSS/Web Animations so frames
  are exact. `<video>`, canvas/WebGL driven by real time and some web workers may misbehave;
  re-run with `--realtime` (frames are timestamped instead, slightly less smooth).
- Network requests run in real time. While any are in flight the virtual clock is not
  allowed to run ahead of real time, so request timeouts do not fire early; slow APIs can
  still look faster in the clip (usually good).
- Native `<select>` menus, browser dialogs, file pickers and OS windows are not rendered.
- Chromium only. Single tab: links that open new tabs are not followed.
