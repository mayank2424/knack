# Self-review checklist (run against every filmstrip)

Read the filmstrip PNG, and stills at the transitions. Score each item pass or fail, and fix every fail before the final render.

## Composition
- [ ] **One focal point per frame.** Squint at each thumbnail: is the subject obvious?
- [ ] **No collisions.** Text never overlaps other text or busy imagery, including mid-transition.
- [ ] **Balance.** Frames aren't lopsided or empty unless that's intentional. Negative space looks designed.
- [ ] **Safe area.** Nothing important within 4% of an edge, and platform UI zones respected for 9:16.
- [ ] **No accidental empty frames,** except a deliberate open at t=0 that lasts under 0.3s.

## Typography
- [ ] Headlines are big enough to read on a phone (≥ 6% of frame height).
- [ ] Every text block is readable for long enough. Check its hold time against the storyboard.
- [ ] Contrast holds on every frame, including over gradients and imagery.
- [ ] Fonts actually loaded. A fallback face means `--check` reports a font issue.
- [ ] No widows or orphans. Line breaks are deliberate (use `<br>`).

## Motion
- [ ] Entrances decelerate and exits accelerate. Linear only where it should be.
- [ ] Stagger leads with the most important element.
- [ ] Directions are consistent across beats.
- [ ] Beats overlap slightly. No dead gaps longer than about 0.4s between scenes.
- [ ] No "pop": compare stills two frames apart at each transition to look for sudden jumps.
- [ ] Springs are limited to hero moments, and nothing bounces more than once (unless the brand is playful).
- [ ] Ambient motion is subtle and never distracts.

## Craft (the "made by AI" tells)
- [ ] No purple-to-cyan gradient text or backdrop glow, unless it's the brand.
- [ ] Not everything is centered, and not every element uses the same fade-up.
- [ ] Real copy or real UI, no skeleton bars posing as a product.
- [ ] Nothing scales from 0; at most one spring overshoot in the piece.
- [ ] Scene seams are a zoom-through or an overlapping hand-off, not a slow crossfade.
- [ ] One accent color, and type weights with clear contrast.

## Story and brand
- [ ] The first 1–2 seconds deliver the hook. On social, frame 0 already shows it (it's the poster).
- [ ] Each beat carries exactly one idea and matches the storyboard.
- [ ] Colors and fonts match the brand, or the stated look.
- [ ] The end card shows a clear brand or CTA, held still for at least 2s.
- [ ] Without sound, the message still lands.

## Technical
- [ ] `--check` passes, or each warning has a written justification.
- [ ] Duration matches the platform target.
- [ ] File size suits the destination (GIF ≤ 10 MB for GitHub, MP4 ≤ ~20 MB for most social).
- [ ] Fast moves (whip pans, stings, flying elements) are rendered at 60fps or with `--motion-blur`.
- [ ] Large dark gradients checked for banding; use `--dither` or `--10bit` if you see steps.
