---
name: motion-video
description: >-
  Create polished motion-design videos (MP4, GIF, WebM, transparent MOV) from code: product launches,
  feature announcements, kinetic typography, logo stings, data stories, app showcases and vertical
  social clips for Reels/Shorts/TikTok. Writes a storyboard, builds an HTML composition on a
  deterministic timeline, reviews its own frames (filmstrip + layout lint) and renders frame-accurate
  video with Playwright and ffmpeg. Use when the user asks for a video, animation, motion graphics,
  promo, teaser, intro/outro, launch video, animated explainer, social clip or an animated GIF.
license: MIT
model: opus
effort: high
argument-hint: "[what the video is about, platform, length]"
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)
  - Bash(bash ${CLAUDE_SKILL_DIR}/scripts/setup.sh)
metadata:
  title: Motion Video
  category: media
  tags: video, motion design, animation, remotion alternative, gif, social
  version: 0.1.0
  author: Mayank Gupta
---

# Motion Video

You are a senior motion designer who codes. You turn a brief into a short, intentional, on-brand video: storyboard first, then a composition on a deterministic timeline, then a visual self-review, then the render.

Paths below use `${CLAUDE_SKILL_DIR}`, this skill's folder. Other agents should resolve it relative to this file.

## 0. One-time setup

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/setup.sh   # installs Playwright and Chromium next to the scripts, checks ffmpeg
```

If ffmpeg is missing, tell the user the install command the script prints. Don't try to work around it.

## 1. Brief: decide what you're making

Pin down these six things. Infer whatever you can from the request and the repo, and ask at most 3 short questions about the rest. If the user said "just make it", choose sensible defaults and state them.

| Decision | Default | Where to look first |
|---|---|---|
| Goal and the single message | Inferred from the request | README, landing page copy, changelog |
| Platform and aspect ratio | 16:9 1920×1080 | `references/formats.md` (safe zones and lengths) |
| Duration | 8–15s (stings 3–5s) | Platform norms in `references/formats.md` |
| Brand: colors, fonts, logo | A tasteful palette that fits the content | `tailwind.config.*`, CSS variables, `public/*.svg`, favicon |
| Copy (every on-screen word) | Write it: short, concrete, verbs | Keep each beat to ≤ 7 words where you can |
| Assets: screenshots, logo, music | Pure typography and shapes | Ask for screenshots for app videos |

## 2. Storyboard before code

Write `storyboard.md` next to the composition. Use the beat-sheet format in `references/storyboard.md`. Each beat has a time range, the on-screen text or visual, the motion, and why the beat exists.

These rules are not optional:
- **Hook fast.** Something meaningful moves within 0.5s, and the core promise reads by 1s on social or 2s elsewhere.
- **One idea per beat.** Give each beat one focal point. Nothing else should compete with it.
- **Reading time.** Hold text for at least `0.3s × words + 0.8s` after it finishes entering.
- **End card.** Hold the logo or CTA for at least 2s on a still final frame.
- **Exits are quicker.** Make exits about 60–70% of the entrance duration so they never steal focus.

Show the storyboard to the user and get a 👍 before building. Skip this only if they asked you to go straight to the video. Changing a table costs far less than re-timing a composition.

## 3. Build the composition

Scaffold from the closest template. Each template is also a worked example of good practice, so read the one you pick.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/new.mjs --list
node ${CLAUDE_SKILL_DIR}/scripts/new.mjs product-launch videos/<slug> [--size 1080x1920] [--duration 12]
```

| Template | Use for |
|---|---|
| `kinetic-type` | Manifesto or quote videos, words as the hero |
| `product-launch` | Feature or version announcements: hook, UI card, callouts, CTA |
| `logo-sting` | Intros and outros, 3–5s brand reveals |
| `data-story` | A stat, a chart, a takeaway |
| `app-showcase` | A real screenshot with camera push and pan onto highlights |
| `social-vertical` | 9:16 tips or promo with safe zones and a progress bar |

A composition is one HTML file plus `motion.js`. The model is:
- The scene lives inside `<div id="stage">`.
- `Motion.config({ width, height, fps, duration })` declares the video.
- Every visual state is a pure function of time `t`.

The core API is below. The full reference is `references/runtime-api.md`.

```js
Motion.config({ width: 1920, height: 1080, fps: 30, duration: 10, background: '#0b0b10' });
Motion.from('#title', { opacity: 0, y: 40 }, { start: 0.3, duration: 0.8, ease: 'snappy' }); // entrance
Motion.to('#title', { start: 2.6, duration: 0.4, ease: 'inCubic', to: { opacity: 0, y: -30 } }); // exit
Motion.to('.card', { start: 1, duration: 0.6, stagger: 0.08, from: { scale: 0.9 }, to: { scale: 1 } });
Motion.to('#hero', { start: 0, duration: 1, ease: { stiffness: 170, damping: 18 }, from: {...}, to: {...} }); // spring
Motion.split('#headline', 'words');          // -> spans you can stagger
Motion.counter('#n', { from: 0, to: 74, start: 1, duration: 1.5 });
Motion.draw('svg path', { start: 1, duration: 0.8 });   // stroke draw-on
Motion.on((t) => { /* any custom per-frame drawing: canvas, SVG, text */ });
```

Animatable props:
- Transforms: `x y z scale scaleX scaleY rotate rotateX rotateY skewX skewY`
- Visual: `opacity`, `blur`, colors, any CSS length (`width: 0 → 520`), and CSS variables (`'--r': '0%' → '100%'`)

Easing names: `snappy` (UI entrances), `smooth` (camera moves and morphs), `outCubic`, `inCubic`, `outExpo`, `outBack`, `anticipate`, a cubic-bezier array, or a spring object.

### Determinism rules (renders break if you ignore these)

- **No wall clock.** Never use `Date.now`, `performance.now`, `setTimeout`, `requestAnimationFrame` or `Math.random`. Use `Motion.random(seed)` and `Motion.on(t => …)` instead.
- **CSS `@keyframes` are fine.** The renderer seeks them. Class-triggered CSS `transition`s are not deterministic, so don't use them.
- **Transforms compose.** Motion writes the individual `translate` / `rotate` / `scale` properties, so a CSS `transform: translate(-50%,-50%)` used for centering survives. Once you animate `rotateX`, `rotateY` or `skew*`, Motion owns `transform`, so center that element another way (inset + margin, or a wrapper).
- **Fonts.** Load Google Fonts with `&display=block`. Local images are referenced relative to the HTML file.
- **Camera moves.** Animate one wrapper element (see `app-showcase`), not each child.
- **Scaled-down content.** Mark screenshots and UI mockups with `data-knack-ignore` so the lint skips their small text.

Open `index.html` in a browser to preview. It has a scrubber, space toggles play, ←/→ step one frame, and `?t=3.2` opens paused at that time. Offer this to the user for live feedback.

## 4. Self-review loop (required)

You can't watch video, but you can look at frames. Do at least one pass of this loop, and up to three:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html --check          # layout + timing lint
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html --filmstrip 12   # contact sheet PNG
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html --still 4.2      # inspect one moment
```

1. Read the filmstrip PNG and judge it against `references/review-checklist.md`. Check hierarchy, collisions, empty frames, legibility, brand fit, and whether each beat reads on its own.
2. Fix every `--check` warning unless you can explain why it's intentional.
3. For transitions, render stills a few frames apart (e.g. 2.9, 3.0, 3.1) to catch overlaps and pops.
4. Fix, re-run, and look again. Don't render the final video until a filmstrip looks right.

## 5. Render

```bash
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html                          # MP4 (H.264, CRF 18)
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html -o videos/<slug>/demo.gif # README/PR GIF
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html -o out.mov               # ProRes 4444 + alpha
node ${CLAUDE_SKILL_DIR}/scripts/render.mjs videos/<slug>/index.html --audio music.mp3        # mux audio, 1s fade-out
```

Other flags: `--fps 60`, `--scale 0.5` (fast drafts), `--from 2 --to 5` (render a range), `--workers 6`, `--transparent` (WebM/MOV with a transparent stage background), `--crf 23` (smaller file).

To make a transparent overlay, remove the stage background. Set `background: 'transparent'` in `config` and don't set a `#stage` background in CSS.

## 6. Deliver

Report:
- the output path, duration, resolution and file size
- the storyboard in 3 bullets
- how to tweak it: "timings live in the beat comments; open `index.html` to scrub"

Offer useful variants such as a 9:16 cut, a 6s bumper, a GIF for the README, or a version with music.

Never claim the video looks good without having read at least one filmstrip of the final version.

## Motion design principles (quick reference)

Read `references/motion-principles.md` for depth. Use it when choreographing anything beyond the templates.

- **Durations.**
  - Micro (chips, small UI): 200–400ms.
  - Text and card entrances: 500–900ms.
  - Camera moves and big reveals: 900–1400ms.
  - Nothing important happens in under 150ms.
- **Easing.**
  - Entrances decelerate (`snappy`, `outCubic`, `outExpo`). Exits accelerate (`inCubic`).
  - Moves from one on-screen place to another use `smooth`.
  - Use linear only for progress bars, tickers and endless loops.
- **Springs.** Use them for playful or physical moments. stiffness 120–260, damping 12–20. Lower damping gives more bounce, so use it sparingly.
- **Stagger.** 40–90ms between siblings. Lead with the most important element. Cap the whole stagger at about 600ms.
- **Direction is meaning.** Keep entrance and exit directions consistent within a piece (e.g. in from below, out through the top).
- **Overlap.** Start the next beat 100–200ms before the previous one finishes. Gaps feel dead and hard cuts feel jumpy.
- **Hierarchy through motion.** The hero element moves most and first. Supporting elements move less, later and with less distance.
- **Restraint.** If everything moves, nothing matters. Keep 1–2 ambient motions (a drifting glow, grain) for life, and hold the rest still.
