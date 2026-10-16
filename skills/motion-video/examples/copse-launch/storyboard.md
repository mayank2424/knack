# Copse launch film

**Goal:** In 15 seconds a Mac user gets the promise ("everything you copy, one keystroke away"), sees the real panel do it, and leaves knowing the name, the price and the URL.
**Platform:** website hero + X feed, 1920×1080, 60fps, 15s, autoplay (sound on when tapped; the message lands silent).
**Concept:** The tagline is split by the keystroke itself. "Everything you copy." hangs over real clip rows from the app; ⌘ ⇧ V is pressed on three beats; the rows snap into the real panel and the second half lands: "One keystroke away." Every later cut is also a key (letters, ⌘K, ↩). The film ends on the icon's three trees, which grow out of the dark and turn out to be the Copse icon.
**Look:** Copse "Slate" dark tokens from the repo (surface `#141518`, raised `#1B1C20`, hairline `#2A2C31`, ink `#ECEDEF`, secondary `#A3A6AF`, accent `#9BA7DB`), the site's dark accent gradient only on the tagline's second half, Geist + Geist Mono (the site's fonts). Calm and precise: `strong` entrances, `inCubic` exits, `smooth` camera, one spring-like settle (the panel open, 0.965 → 1, from the app's own design spec). No grain.
**Audio:** synthesized, 120 BPM, D dorian, `driving` bed arranged in sections: filtered pad intro → drums and bass drop on the V press → breakdown on the trees → filter opens into the lockup. Cues on every key and cut.
**Real assets (assets/):** `panel.png`, `panel-search.png`, `panel-actions.png` (dark-mode panel snapshots from the app's `--snapshot` tool, 2× retina, used on the Copse website) and `app-icon.png`.
**Copy sources:** README tagline, `web/landing/src/site.config.mjs` (price $2.99 once, macOS 15+, URL), marketing screenshot copy ("Find anything in a few letters."), README positioning ("fast, private", native Swift/AppKit).

Beat grid: B(n) = n × 0.5s.

| # | Time (beats) | On screen | Motion | Why |
|---|------|-----------|--------|-----|
| 1 | 0.0–2.0 (B0–B4) | "Everything / you copy." left; seven real clip rows (code, link, color, note, screenshot, email, shell) float in depth on the right | Headline and three rows already in at frame 0 (poster); the rest arrive one per 8th note with an accent "copied" ring and a tick; depth blur + parallax drift | Hook: promise half-said in 0.3s, real content immediately |
| 2 | 2.0–3.0 (B4–B6) | Big keycaps ⌘ ⇧ V, centred | Headline exits up; rows recede (dim + blur); keys drop and press on B4, B4.5, B5; on V the keys zoom through the camera and the rows fly into their slots | The keystroke is the cut |
| 3 | 3.0–5.5 (B6–B11) | The real panel (right) + "One keystroke away." (brand gradient) and "Press ⌘⇧V in any app." | Panel settles 0.965 → 1; caret blinks in the empty search field; slow camera drift | Tagline completes; first look at the real UI |
| 4 | 5.5–8.0 (B11–B16) | "Find anything / in a few letters." Camera pushes onto the search field | "invoice" types in on 16ths (revealed from the real search screenshot), the list clears and the real best matches stagger in | Search, shown with the app's own pixels |
| 5 | 8.0–9.75 (B16–B19.5) | "Paste it / anywhere." + ⌘K / ↩ keys | ⌘K: the real actions menu grows from its corner (as the app does); camera pushes onto it; ↩ flashes Paste; hard cut (the app closes instantly on paste) | Action and payoff |
| 6 | 9.75–12.0 (B19.5–B24) | A horizon arc; three trees rise from behind it, one per beat: "Fast." "Private." "Native." | Arc draws on, trees rise with `strong`, words rise under them | The three claims the README makes, on the icon's own trees |
| 7 | 12.0–15.0 (B24–B30) | Lockup: icon + "Copse", tagline, "$2.99 once · macOS 15+ · copse.mayankbuilds.com" | The real icon fades in around the trees while the camera pulls back fast to the lockup (lands B25); text rises; holds 2.4s | Brand, price, where to get it |

**Flow:** text enters from below and exits upward; camera only pushes in on the UI and pulls back once, for the lockup.

**Cue list:** ticks on each new row (0.25–1.0s) · riser → V · hit ⌘ (2.0) · hit ⇧ (2.25) · impact + whoosh V (2.5) · whoosh camera push (5.5) · 7 ticks typing (5.75–6.5) · pop results (6.6) · whoosh + pop ⌘K (8.0) · hit ↩ (9.5) · hit cut (9.75) · pops on each tree (10.0, 10.5, 11.0) · whoosh pullback (12.25) · riser + impact lockup (12.5).

**Reading-time check:** "Everything you copy." visible 0–2.0 (1.7 needed) · "One keystroke away." + sub 3.1–5.4 · "Find anything in a few letters." 5.6–8.0 (2.6 needed, 2.4 given; the UI shows the same thing) · "Paste it anywhere." 8.1–9.75 (1.7) · claims build one per beat and all hold 1s · end card still from 12.5 to 15.0.
