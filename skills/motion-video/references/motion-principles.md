# Motion design principles for code-driven video

Good motion is *communication*: it directs attention, explains change, and gives a brand a personality. Use this when choreographing scenes beyond the templates.

## 1. Purpose first

Every movement should do one of these jobs:
1. **Direct attention.** "Look here now."
2. **Show a relationship.** "This came from that." "These belong together."
3. **Explain change.** A state transition, cause and effect, a before and after.
4. **Express personality.** Calm and precise, playful and bouncy, bold and kinetic.

If an animation does none of these, cut it, or make it ambient and subtle.

## 2. Timing table

| Element | Entrance | Exit | Hold |
|---|---|---|---|
| Small UI (chip, badge, icon) | 250–400ms | 150–250ms | Not applicable |
| Headline (word stagger) | 600–900ms total | 300–450ms | ≥ 0.3s × words + 0.8s |
| Card or panel | 600–1000ms | 350–500ms | Long enough for its message |
| Camera move or zoom | 900–1400ms | Not applicable | ≥ 1s settled before the next move |
| Full-scene transition | 400–700ms | Not applicable | Not applicable |
| Logo lockup / end card | 800–1200ms | Not applicable | ≥ 2s (CTA ≥ 2.5s) |

Scale durations with distance and size. Large elements that travel far take longer. Viewers notice timing that is too *fast* far more than timing that is slightly slow, except for exits.

## 3. Easing as personality

- **Deceleration (out-curves).** Things arriving should brake. This is the most natural entrance.
- **Acceleration (in-curves).** Things leaving should speed away.
- **In-out.** Anything moving between two visible positions, and every camera move.
- **Strong ease-out.** `strong` (`0.16, 1, 0.3, 1`) is the premium default for entrances: it covers most of the distance immediately, then lands softly. Built-in CSS-style curves (`out`, `inOut`) are too weak for video.
- **Springs.** Physical, friendly, tactile. One overshoot reads as confident; three reads as a toy. Viewers single out bounce as the fastest way to look cheap.
- **Linear.** Machines only: progress, rotation, marquee, loops.

Brand mapping:
- Enterprise or finance → `smooth` and `outCubic`, no overshoot.
- Consumer or social → springs at damping 14–18.
- Developer tools → `snappy`, crisp and fast, 60fps.
- Luxury or editorial → long `outExpo`, slow holds, minimal movement.

## 4. Choreography

- **Lead and follow.** The hero moves first and furthest. Supporting elements follow with 40–90ms stagger and travel 30–60% of the hero's distance.
- **Overlapping action.** Start the next element before the previous one settles, with 20–40% overlap. Strict sequencing feels robotic.
- **Direction consistency.** Choose a flow, for example in from below and out through the top. Reversing direction signals going back.
- **Spatial continuity.** If something leaves to the left, the next scene's content enters from the right.
- **Focal point.** At any moment, one thing is clearly the subject. Squint at a still: you should spot it instantly.
- **Group by motion.** Elements that animate together are read as related (Gestalt common fate).

## 5. Transitions catalog

| Transition | How (in this runtime) | When |
|---|---|---|
| Hard cut | Exit ends exactly where the entrance begins | Energetic, rhythmic edits |
| Crossfade with drift | Opacity 1→0 with small `y` while the next goes 0→1 | Calm, default |
| Push | Both scenes `x` move together by the frame width | Sequences, carousels |
| Mask wipe | `clip-path: inset()` driven by a CSS variable | Reveals, before/after |
| Scale-through | The outgoing scene scales to 1.2 and fades; the incoming one scales from 0.9 | Zooming into detail |
| Match cut | A shape in scene A morphs or moves into the position of a shape in scene B | Premium continuity |
| Zoom-through | Outgoing scales 1→1.12 with blur 0→10 and opacity out over ~0.3s (`inCubic`); incoming lands from 1.12 with blur 10→0 (`strong`) | The premium default seam between scenes |
| Blur dissolve | `blur` 0→10 with opacity out, reverse for in | Dreamy, soft brands |

## 6. Typography in motion

- **Size.** Headlines ≥ 6% of frame height (≈ 64px at 1080p). Body text ≥ 2.2% (≈ 24px). Vertical video needs bigger: headlines ≥ 100px at 1080×1920.
- **Text length.** At most 7 words per beat, and at most two lines for headlines.
- **What to split.** Animate words, not characters, for anything longer than about 3 words. Per-character animation is for short, punchy words.
- **Weight.** Tight tracking (−0.02 to −0.05em) and heavy weights read best in motion.
- **Contrast.** Keep text ≥ 4.5:1 against its background *on every frame*, including during gradient or video backgrounds.
- **Placement.** Keep text inside the safe area, 4% margins at minimum. See `formats.md` for platform UI zones.

## 7. Color, depth and texture

- Use 2–3 brand colors with one accent for the focal element.
- Create depth with subtle scale (0.96–1.04), blur on background layers, and soft large shadows.
- Use ambient life, such as a drifting gradient, film grain or slow parallax, to keep static holds from feeling frozen. Keep it under 5% visual weight.
- Avoid pure `#000` and `#fff` for large areas. Slightly tinted darks and lights look more premium.

## 8. Rhythm and music

- Cut on beats. At 120 BPM a beat is every 0.5s, so align major entrances to multiples of the beat.
- Leave the first 0.2s and last 0.5s of audio for fades. The renderer fades the last 1s by default.
- Without music, rhythm comes from consistent intervals, for example a new beat every 2.4s.

## 9. Common mistakes (and fixes)

| Mistake | Fix |
|---|---|
| Everything enters at once | Stagger, and lead with the hero |
| Linear easing on UI | Use `snappy` or `outCubic` |
| Text gone before it can be read | Apply the reading formula, then add 20% |
| Bounce on every element | Springs only on 1–2 hero moments |
| Dead air between beats | Overlap beats by 100–200ms, and add ambient motion |
| Busy background behind text | Add a scrim, blur it or darken it |
| Ending on motion | End on a still, held lockup |
| Inconsistent directions | Define the flow in the storyboard |
| Tiny UI screenshots | Push in with a camera move; don't shrink the screenshot to fit. Keep zoom ≤ 2× on screenshots captured at 1× |
| Scaling from 0 | Start at 0.5–0.95 with opacity 0; nothing in the real world grows from nothing |
| Slow pan or drift late in a scene to "add life" | Hold still. Stillness beats filler motion |
| Gradient text, purple-cyan glows, centered everything | One neutral palette + one accent; left-aligned editorial layouts read as designed |
