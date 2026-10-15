# Storyboard (beat sheet) format

Write this to `storyboard.md` next to the composition, then share it with the user before building.

```markdown
# <Video title>

**Goal:** One sentence: what the viewer should think, feel or do afterwards.
**Platform:** X feed, 1920×1080, 30fps, 12s, muted autoplay
**Look:** dark UI, violet→cyan accent, Geist; calm and precise (no bounce)
**Audio:** none (captions carry the message)

| # | Time | On screen | Motion | Why |
|---|------|-----------|--------|-----|
| 1 | 0.0–2.9 | "Your workflow, **10× faster.**" + "Introducing v2.0" pill | Pill fades up, headline rises with blur-in, gradient line wipes L→R | Hook: the promise in 1s |
| 2 | 3.1–5.0 | Product UI card | Card rises in 3D (spring), rows stagger in, latency counter 480→12ms | Show, don't tell |
| 3 | 5.0–8.4 | 3 callouts around the card | Each pops in ~0.9s apart, slow push-in on card | One benefit per beat |
| 4 | 9.1–12.0 | "Try it free today." + URL | Headline rises, URL follows 0.3s later, holds 2.5s | Clear CTA |

**Flow:** content enters from below, exits upward; camera only pushes in.
**Open questions:** final URL? Real screenshot instead of the mock UI?
```

## Checklist before sharing

- [ ] Meaningful motion within 0.5s, and the core message readable by 1–2s.
- [ ] Each beat has exactly one focal point, and its "Why" column is filled in.
- [ ] Hold times meet the reading formula (`0.3s × words + 0.8s`).
- [ ] The end card holds for at least 2s.
- [ ] Beat times add up to the duration, with no beat cut off.
- [ ] The motion vocabulary (directions, easing family, spring or no spring) is stated once and stays consistent.
