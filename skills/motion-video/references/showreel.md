# Creative-freedom mode: showreels and "go all out" pieces

Read this whole file before planning a creative piece. "Go all out" means the work of a director, not a pile of effects. Viewers remember one idea executed with range, rhythm and polish.

## 1. Concept: one thread

Pick one element that survives every cut and keeps changing role. It gives you:
- **Match cuts for free.** The thread's last position in a shot is its first position in the next.
- **Coherence.** Seven techniques read as one piece, not a sampler.
- **A story.** The thread has a life: it's born, it changes, it ends somewhere meaningful (for example, as the full stop of the title).

Concept seeds. Use one, combine two, or invent your own; the point is a defensible idea.

| Seed | The thread | Techniques it unlocks naturally |
|---|---|---|
| One object, many lives | A square, dot or circle recast every beat | Squash and stretch, extrusion into 3D, morphing, bursting into particles, becoming punctuation |
| The unbroken line | One stroke that never lifts | Line drawing, wiping text out, becoming a graph curve, a flight path, a signature |
| The timeline is the set | Editor UI: playhead, keyframes, curves | The graph editor driving moves, keyframes popping, scrubbing back and forth, onion skins |
| A word that won't sit still | One word re-set in every shot | Kinetic type, a variable-weight sweep, letters as a physics system, letters into particles |
| Grid as an organism | A grid of cells | Ripple staggers, cellular automata, cells becoming pixels of an image, collapsing to one cell |
| Paper and ink | Two colors trading places | Floods, masks, positive/negative swaps, cut-out reveals |
| Physics sandbox | Simple bodies and gravity | Bounces, chain reactions, a Newton's cradle, a pendulum wave settling into a logo |
| Camera as character | One continuous camera move | A dolly through layered planes, a zoom-through into an object, a whip pan to the next world |
| Signal | A waveform or pulse | Audio-reactive shapes, beat pulses, oscilloscope type, a heartbeat into a logo |
| Instruments | Rulers, timecode, crop marks | Measuring, aligning, snapping, a designer's tools becoming the subject |

### Don't make the reel everyone makes

The prompt "make a dynamic 15-second motion graphics video that shows what an incredible motion designer you are…" went viral, so its default answer is everywhere:
- **Look:** near-black background, white Geist or Inter, one orange or neon accent, film grain, vignette, a timecode or HUD in the corners, camera shake on every cut.
- **Shots:** "MOTION", then "PRINCIPLES" words acting out their meaning, a dot bursting into thousands of particles that spell a name, a bezier graph editor, a grid of mini loops, an italic serif role line on the end card.

Each of those can appear in your piece **only if your concept calls for it.** If your shot list could be swapped with that one, start again with a different seed or art direction. Light backgrounds, a single unusual typeface, or a non-default color pair are cheap ways to stand apart.

## 2. Art direction (decide before code)

- **Palette:** two neutrals plus one accent. Write the hex values in the storyboard. Background flips (paper ↔ ink) are allowed as punctuation on big beats.
- **Type:** one family, with two weights or widths that contrast strongly (for example Condensed Bold display with Mono labels). Display tracking −0.02 to −0.04em. No more than two families.
- **Texture rule:** pick one or none (grain, halftone, scanlines, paper). Never stack all of them.
- **Motion personality:** pick one easing family and stick to it: precise (`strong` / `strongInOut`), elastic (springs), or mechanical (linear plus steps). Break it once, on purpose.

## 3. Structure on a beat grid

```js
const B = Motion.beats({ bpm: 124 });   // B(4) = time of beat 4 (≈1.94s); one beat ≈ 0.484s
```

15 seconds at 120–128 BPM is about 30 beats:

| Beats | Role | Notes |
|---|---|---|
| 0–4 | **Hook** | Striking from the first visible frame. The thread is introduced with a physical, satisfying move |
| 4–24 | **5–7 shots** of 3–5 beats each | One named technique per shot. Escalate in scale and complexity. Vary shot lengths so it doesn't feel metronomic |
| ~20 | **Peak** | The biggest moment (the drop): a flood, a particle storm, a camera dive. Put an `impact` or `drop` cue here |
| last 5–6 | **End card** | Lands on a downbeat with the thread finishing its story. Hold still for 2s or more. Name and role, legible at a glance |

Name each shot on screen only if the labels add to the concept (as a reel's lower thirds do). Don't add HUD text by default.

## 4. Technique palette (with runtime recipes)

Each one is a tested pattern. `templates/showreel.html` implements the starred (★) ones.

**★ Squash and stretch with onion skins**
```js
// Fall with inQuad, squash on impact (scaleX up, scaleY down), decaying rebound; draw ghosts 3/6/9 frames behind.
const impact = Math.exp(-(((t - hit) * 7) ** 2));
el.style.transform = `translateY(${y}px) scale(${1 + impact * 0.55}, ${1 - impact * 0.45})`;
```

**★ Grid ripple (systems)**
```js
Motion.to('.cell', { start: B(4), duration: 0.5, ease: 'strong', stagger: { each: 0.035, from: 11, grid: [8, 4] },
  from: { opacity: 0, scale: 0.4, rotate: -30 }, to: { opacity: 1, scale: 1, rotate: 0 } });
// While holding, keep it alive: translate each cell by sin(t*9 - distance*1.1) * 22px.
```

**★ 3D object.** Build the object with a `perspective` wrapper and `transform-style: preserve-3d` faces. Tween `rotateX`/`rotateY` on the beat with `strongInOut`. Add `data-knack-ignore` to the object.

**★ Shape morph.** Point counts don't need to match; the runtime resamples both shapes and aligns their start points.
```js
Motion.morph('#shape', { start: B(12.5), duration: B(1) * 0.9, hold: B(1) * 0.1, shapes: [square, blob, star, circle] });
```
Build organic blobs with `Motion.makeNoise(seed)` around a circle.

**★ Particles (into type, or back into the thread)**
```js
Motion.ready(() => { pts = Motion.textPoints('WORD', { font: "700 300px 'Your Font'", step: 7 }); });
Motion.canvas({ zIndex: 1 }, (ctx, t) => { /* burst outward (outExpo), noise drift, gather with strongInOut, fillRect per point */ });
```
Keep it under about 10k points, and use `fillRect`, not `arc`. Precompute random seeds once. The showreel reference gathers the particles back into the square (the thread) instead of spelling a word, which keeps the technique on-concept.

**★ Graph editor.** Draw the curve (`Motion.draw`), then make an object obey exactly that curve, leaving onion-skin ghosts. Label the curve with its real cubic-bezier.

**★ Color flood transition**
```css
#flood { position: absolute; inset: 0; background: var(--ink); clip-path: circle(var(--fr, 0%) at 50% 50%); }
```
Drive `--fr` from 0% to 120% in about 0.45s with `strongInOut`, starting from where the thread is. Flip the colors of overlaid text with the flood.

**★ Match cut.** End shot A with the thread at position P, and start shot B with the thread at P. For the end card, fly the thread (in an arc) to the exact rect of a glyph measured in `Motion.ready()`, then swap it for the glyph as the word settles. Measure an element *inside* any `overflow: hidden` mask: the mask moves the line's baseline, and a probe outside it can sit about 50px off.

**Kinetic type that acts.** Words do what they mean: "fast" whips in, "heavy" drops and dents the baseline, "split" splits. Rise from masks (±110–130% travel), and use mixed weights in one line.

**Camera.**
- Animate one wrapper: `scale` plus `translate`, with `smooth` easing.
- **Dolly through layers:** move planes at different speeds for parallax.
- **Zoom-through:** scale an object up past the frame until its interior becomes the next shot's background.
- **Whip pan:** move the wrapper about 2000px in 6–8 frames and render with `--motion-blur 12`.

**Generative system.** A flow field or noise lines on canvas (`Motion.noise(x * k, y * k, t * speed)`), cellular patterns, a pendulum wave (phase = `t * (1 + i * 0.05)`).

**Counters and slot reels.** Columns of digits that translate by `−digit × lineHeight` with `strong` easing, staggered per column.

**Line drawing.** Use `Motion.draw` on SVG strokes. Reveal a logo, a signature or a map route; draw-on followed by fill-in reads as craft.

**Time remap.** For one moment, slow time near a peak by mapping the shot's local time through `Motion.interpolate(t, [a, m, b], [a, a + 0.1, b], { ease: 'smooth' })`, then snap back.

**Camera kick on cuts.** For 2–4 frames, apply ±4–8px of noise offset plus 1.2% overscan on the wrapper, decaying fast. Use it at most at the strong cuts, not every one.

## 5. Editing

- **Cut on the beat,** exactly on `B(n)`. Entrances can lead the beat by about 1 frame so they land on it.
- **Transitions are motivated,** best first: match cut, then flood or mask wipe, then zoom-through, then whip pan, then a hard cut. Never use a slow crossfade.
- **Vary shot lengths** (3, 4, 4.5, 3.5 beats…). Identical lengths feel like a slideshow.
- **Holds:** while a shot holds, give it one small living detail (a wave, drift, pulse). The end card is the exception: it holds still.
- **Flash frames:** one white or accent frame on the peak at most.

## 6. Sound design (synthesized automatically)

```js
Motion.score({ bpm: 124, key: 'E', scale: 'minor', mood: 'driving',   // driving | minimal | cinematic
  sections: [
    { at: B(16), drums: false, bass: false, filter: 600 },  // breakdown: strip the kit, close the filter
    { at: B(20), drums: true, bass: true, filter: 20000 },   // the drop: full kit, filter wide open
  ] });
Motion.cue(B(4), 'whoosh');            // every transition
Motion.cue(B(1), 'hit');               // physical impacts
Motion.cue(B(19), 'riser', { length: B(2) }); // ends ON the reveal
Motion.cue(B(20), 'drop');             // the peak
Motion.cue(t, 'pop' | 'tick' | 'swell' | 'glitch' | 'impact', { gain: 0.6 });
```

- The music bed follows the BPM: kick, clap, hats, sidechained bass, pad and arp in the chosen key. Use `mood: 'cinematic'` for drum-less, pad-led pieces.
- **Arrange the bed.** Without `sections` the groove loops unchanged from the first beat to the last, so the peak can't drop. A breakdown 2–4 beats before the peak, with the filter gliding back up, plus the full kit on the peak beat, makes the drop land. Each section part (`drums`, `bass`, `arp`, `pad`) switches from `at` onward, and `filter` glides over the last 40% of the gap before the next section.
- One or two cues per beat at most. Leave air so the music breathes.
- `whoosh` peaks just before `t`, so put it exactly on the cut.
- Risers and swells **end** at their timestamp; put them on the reveal, not before it.
- The render prints the synthesized loudness. Use `--score-only -o score.wav` to check the audio on its own.
- If the user supplies music, use `--audio track.mp3`, set `Motion.beats({ bpm })` to the track's tempo, and keep cues for extra sound effects only if they fit.

## 7. Reel review rubric (score each 1–5; fix anything under 4)

Render `--filmstrip 20` and `--cuts 2` (±2 frames around every cue on one sheet). Use `--stills a,b,c` for match cuts that have no cue.

| Criterion | 5 looks like |
|---|---|
| **Hook** | The first visible frame (about t=0.1s) is already striking; something physical happens in the first beat |
| **Concept** | One thread is obvious across the filmstrip. Shots could not be reordered without breaking the story |
| **Range** | 5 or more genuinely different techniques, escalating to a clear peak |
| **Craft** | Easing feels physical; no pops at cuts; nothing lands early or late; type is crisp and legible on every frame |
| **Rhythm** | Cuts on beats, varied shot lengths, no dead beat longer than 0.5s, the end card lands on a downbeat |
| **Art direction** | Two neutrals and one accent, at most two type families, nothing that reads as a template default |
| **Sound** | Cues on every cut and impact, a riser into the peak, a drop at the peak; nothing clips |
| **Originality** | Not swappable with the viral default reel (§1) |

Iterate at least twice. On the second pass, look for the weakest shot and replace it, not just tweak it.
