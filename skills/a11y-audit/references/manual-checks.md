# Manual checks

Automated tools find only part of the real accessibility problems: in GDS's test page with 142 known barriers the best tool found 40% (axe 29%), and Deque's own study puts axe at 57% when counting by issue volume. This skill's keyboard pass adds behavior axe does not test, but the rest still needs a person. Run this list after the audit is clean, or hand it to the user as the remaining work. Each check takes a few minutes.

## 1. Screen reader smoke test (10 min)

Pick one; you do not need all of them.

| Platform | Reader | Start / stop | Read next | Headings list | Landmarks / rotor |
|---|---|---|---|---|---|
| macOS | VoiceOver | Cmd+F5 | VO (Ctrl+Opt) + → | VO+U, then ←/→ to "Headings" | VO+U |
| Windows | NVDA (free) | Ctrl+Alt+N / Insert+Q | ↓ | H / Insert+F7 | D (landmarks) |
| iOS | VoiceOver | Settings → Accessibility, or triple-click side button | swipe right | rotor: two-finger twist | rotor |
| Android | TalkBack | volume up+down 3 s | swipe right | reading controls | reading controls |

Listen for:

- [ ] Page title is announced and makes sense.
- [ ] Headings list reads like a table of contents (no "heading level 4" with nothing above it).
- [ ] Every button and link says what it does ("Delete project", not "button" or "click here").
- [ ] Form fields announce their label, required state, and errors when you submit with mistakes.
- [ ] Opening a menu/dialog moves you into it; closing returns you to the trigger.
- [ ] Dynamic updates (toast, "saved", search results count) are announced (`role="status"` / `aria-live="polite"`).
- [ ] Images: alt text is *meaningful* in context, decorative images are silent.

## 2. Keyboard only (5 min)

Unplug the mouse (or don't touch the trackpad).

- [ ] Tab reaches every control; Shift+Tab goes back the same way (the audit only Tabs forwards).
- [ ] Focus is always visible and never hidden behind a sticky header or cookie banner (WCAG 2.4.11). The audit catches bars that cover focus while Tabbing forwards; check Shift+Tab under sticky headers yourself.
- [ ] Enter activates links and buttons; Space activates buttons, checkboxes; arrows move within radio groups, tabs, menus, sliders.
- [ ] Escape closes dialogs, popovers, menus.
- [ ] No hover-only content: tooltips and menus also open on focus and can be dismissed (1.4.13).
- [ ] Custom widgets (combobox, date picker, drag-and-drop) have a keyboard path. Drag needs a non-drag alternative (2.5.7).

## 3. Zoom and reflow (5 min)

- [ ] Browser zoom 200%: nothing overlaps or gets cut off; text is not clipped inside fixed-height boxes (1.4.4).
- [ ] Zoom 400% on a 1280px window (≈ 320 CSS px wide): content reflows into one column with no horizontal scrolling, except for tables, maps, and code (1.4.10). Shortcut: `node scripts/audit.mjs <url> --viewport 320x800` and look at the screenshot.
- [ ] Text spacing override (line-height 1.5, letter-spacing .12em, word-spacing .16em, paragraph spacing 2em) does not break layout (1.4.12). Bookmarklet: "text spacing bookmarklet" by Steve Faulkner.
- [ ] Phone landscape and portrait both work (1.3.4).

## 4. Motion and media

- [ ] With OS "Reduce motion" on (macOS: Accessibility → Display; Windows: Settings → Accessibility → Visual effects), large animations, parallax, and auto-playing carousels stop or simplify. CSS: `@media (prefers-reduced-motion: reduce)`.
- [ ] Anything that moves for more than 5 s has a pause control (2.2.2). Nothing flashes more than 3 times per second (2.3.1).
- [ ] Video has captions (not auto-generated only), audio has a transcript, and important visual-only info in video has audio description (1.2.x).
- [ ] No audio auto-plays for more than 3 s without a stop control (1.4.2).

## 5. Content and meaning (judgment calls the tool cannot make)

- [ ] Reading order (DOM order) matches visual order, especially in grids reordered with CSS.
- [ ] Color is never the only signal: errors have text or icons, charts have labels or patterns, required fields say "required" (1.4.1).
- [ ] Link text makes sense out of context; multiple "Learn more" links are distinguished.
- [ ] Error messages explain how to fix the problem (3.3.3), not just "Invalid".
- [ ] Sessions that time out warn the user and let them extend (2.2.1).
- [ ] Authentication does not require a cognitive test (puzzle, memorized code) without an alternative such as paste or password managers (3.3.8).
- [ ] Language changes inside the page are marked (`<span lang="fr">`) (3.1.2).
- [ ] Dark mode and high-contrast mode (Windows "Contrast themes", `forced-colors: active`) keep focus rings, borders, and icons visible.

## Reporting back

When you hand off, state clearly which of these you could not verify yourself (e.g. "I can't run a screen reader here; please do the 10-minute VoiceOver check in section 1").
