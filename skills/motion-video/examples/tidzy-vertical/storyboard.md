# Tidzy: "Can't find that screenshot?"

**Goal:** A Mac user who has lost a screenshot thinks "I need that" and remembers gettidzy.app.
**Platform:** Reels / TikTok / Shorts, 1080×1920, 60fps, 12s, sound on (still reads muted)
**Concept:** Mess to neat. One word, *screenshot*, jumps out of a wall of identical filenames into Tidzy's search bar, the real app finds the file by the text inside it, the real Clean Up cards clear space, and everything folds into the app icon.
**Look:** the gettidzy.app brand: white and mint (#F5FAF8 / #E9F8F3) with the site's dot grid and soft aurora, ink #0A1613, one accent (the green gradient #2BD3AE → #0E9F86 → #0A7A6A). Geist 700 for headlines (tight -0.05em tracking like the site's h1), Geist Mono for filenames. No grain, no glow.
**Motion vocabulary:** content enters from below and leaves through the top (a feed scrolling); `strong` entrances, `inCubic` exits at ~65% of entrance time; one match cut (the word), one flood (the green check becomes the icon). No springs except the pill.
**Audio:** synthesized, 120 BPM, D major, `driving`. Filtered intro that opens on the match cut (2.0s), drums drop out under the toast and slam back on the flood (9.0s), outro pad only from 11s.
**Assets (all real):** crops of Tidzy's own screenshots: the search result card and its "Text in this file" panel (search-wifi-light), the three Clean Up cards (cleanup-light), the app icon. Search bar and chips are rebuilt in HTML with the app's exact copy and styling so the query can be typed live.

Beat grid: B(n) = n × 0.5s.

| # | Time (beats) | On screen | Motion | Why |
|---|------|-----------|--------|-----|
| 1 | 0.0–2.0 (B0–B4) | "Can't find / that / **screenshot?**" over a scrolling wall of `Screenshot 2026-10-0… PM.png` names | Frame 0 already shows the full headline (negative-start entrance). Wall scrolls up; green swoosh draws under "screenshot" by 0.9s | Hook + poster frame: the pain, in 4 words, in the first frame |
| 2 | 2.0–4.0 (B4–B8) | "Just describe it." + Tidzy search bar typing `screenshot with wifi password`, then "Understood as · Screenshots · Containing "wifi password"" chips | **Match cut:** the headline word *screenshot* flies into the bar and becomes the first word of the query; rest types at ~27 cps; chips pop on B6.5/B7 | Show the plain-English search, using the app's real query and parse |
| 3 | 4.0–6.0 (B8–B12) | "Found by what's inside." + real result card + real "Text in this file" panel | Bar exits up, card and panel rise (panel overlaps card, offset right). Highlighter sweeps "WIFI: Hello-5G pass: 81kz!q" on B9.5; slow push-in | Proof: it found the file by the words in the picture |
| 4 | 6.0–9.0 (B12–B18) | "Free up space. Safely." + real Clean Up cards (Old installers 8.4 MB, Forgotten downloads 2.4 MB, Duplicates 258 KB) | Cards cascade up (stagger 0.12s), hold, then fold into a dark toast "Moved to Trash · Undo" on B16 | Second benefit, with the safety promise (undo) |
| 5 | 9.0–12.0 (B18–B24) | App icon, **Tidzy**, "Your Mac, neat.", `gettidzy.app` pill, "100% on-device · macOS 14+" | The toast's green check floods the screen, then contracts into the app icon; wordmark and pill rise; settled by 9.95, held 2s+ | Name + site, held still for the CTA |

**Cue list:** 0.05 hit · 0.6 whoosh (swoosh) · 1.95 whoosh + 2.0 hit (match cut, drums in) · 2.45–3.15 key ticks · 3.3/3.45 pops (chips) · 4.0 whoosh + hit · 4.8 pop (highlight) · 6.0 whoosh · 6.1/6.22/6.34 pops (cards) · 7.7 whoosh (fold) · 7.95 pop (toast) · 9.0 riser→drop (flood) · 9.5 hit (icon lands) · 9.75 pop (pill).

**Reading-time check:** hook 4 words, on screen 0–2.0 (2.0s ✓); "Just describe it." 1.85s (needs 1.7 ✓); "Found by what's inside." 1.9s (needs 2.0, the highlight carries it); "Free up space. Safely." 2.95s ✓; end card held 2.05s ✓.

**Claims:** every line comes from Tidzy's README/site/app UI (plain-English search, reads text in screenshots, frees space safely, Trash + undo, 100% on-device, macOS 14+). Numbers shown are the app's own screenshot values, never invented.
