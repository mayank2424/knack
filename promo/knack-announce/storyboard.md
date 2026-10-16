# Knack: 10-second announcement

**Goal:** In 10 seconds, a developer on X or the website gets the one idea (agent skills that check their own work), sees the real evidence, and knows where to get it.
**Platform:** X, website hero/README. 1920×1080, 60fps, 10s, with sound.
**Concept, one thread:** the green tick from the Knack logo. Every skill's check turns green, the six green dots fly together into one big tick, and that tick shrinks into its place as the leg of the K.
**Look:** the site's palette. Paper `#fafafa`, ink `#111214`, rules `#e6e6e8`; red `#c42f1f` only for the struck claim, green `#16793c` / `#3ee07a` only for verified. IBM Plex Sans 600 for display, Plex Mono for labels. Faint dot grid as the one texture. No glows, one confident spring at most.
**Assets:** real output only: responsive-qa, a11y-audit, pr-visual-diff and demo-recorder evidence images, a frame from the Copse launch film (motion-video), and token-drift's real terminal output.
**Audio:** synthesized, 120 BPM, A major, `driving`. Filtered intro, kit enters on the swap, full on the evidence wall, breakdown + riser into the logo, impact on the logo.

Beat = 0.5s.

| # | Beats | Time | On screen | Motion | Sound |
|---|---|---|---|---|---|
| 1 | 0–2.5 | 0.0–1.25 | "Agent skills that / say they're done." | Words rise from masks in 0.55s; slow push-in | filtered pad, bass |
| 2 | 2.5–3.5 | 1.25–1.75 | A red line strikes "say they're done." | Strike draws in 0.3s | `hit` |
| 3 | 3.5–7 | 1.75–3.5 | "show their work." drops in, green scribble underlines it | Struck words fall out (inCubic), new line drops from above (strong), scribble draws | `whoosh`, kit enters, `tick` |
| 4 | 7–13 | 3.5–6.5 | "Every skill checks its own work." + six cards of real output, each with a status chip | Cards land every quarter-beat; each chip flips from running to its real result in green; camera pushes 1→1.05 | `whoosh`, a `tick` per chip |
| 5 | 13–14 | 6.5–7.0 | Cards fall away; six green dots fly to the centre and draw one big tick | Edge-first stagger, inCubic; tick draws | `whoosh`, breakdown, `riser` ends on 14 |
| 6 | 14–20 | 7.0–10.0 | The tick shrinks into the K; "Knack", "Agent skills that show their work.", `npx skills add mayank2424/knack` · knack.mayankbuilds.com | Logo scales 3.2→1 (strongInOut), K strokes draw, lines rise; settled by 8.05s, holds 1.95s | `impact`, `pop`, `tick` |

**Reading-time check:** shot 3 line (6 words, 2.6s needed) is on screen from 0.55s, complete by 2.3s, cut at 3.5s. Shot 4 heading (6 words) holds 3.0s. End card: 9 words, held ~2s after settling (plus the tagline repeats shot 3).

**Claims:** every number is the skill's own result from `catalog/site.json` and the skills' example runs.
