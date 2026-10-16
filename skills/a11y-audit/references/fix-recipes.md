# Fix recipes

Concrete before/after fixes for the rules `audit.mjs` reports most often. Each heading is the rule id from `report.md`, so `fix-recipes.md#color-contrast` jumps straight to it.

Order of preference for every fix:

1. **Native HTML element** (`<button>`, `<a href>`, `<label>`, `<nav>`, `<dialog>`). It brings keyboard support, role, and state for free.
2. **Visible text** over hidden labels. Voice-control users say what they see.
3. **ARIA only when there is no native option.** No ARIA is better than bad ARIA: a wrong `role` or a stale `aria-expanded` is worse than none.

Contents: [Keyboard pass](#keyboard-pass-rules) ([kbd-focus-removed](#kbd-focus-removed) · [kbd-focus-obscured](#kbd-focus-obscured) · [kbd-hover-only](#kbd-hover-only) · [kbd-change-on-input](#kbd-change-on-input) · [kbd-dialog-escape](#kbd-dialog-escape)) · [color-contrast](#color-contrast) · [image-alt](#image-alt) · [svg-img-alt](#svg-img-alt) · [label](#label) · [placeholder-label](#placeholder-label) · [select-name](#select-name) · [button-name](#button-name) · [link-name](#link-name) · [html-has-lang](#html-has-lang) · [document-title](#document-title) · [heading-order](#heading-order) · [page-has-heading-one](#page-has-heading-one) · [landmark-one-main](#landmark-one-main) · [region](#region) · [bypass](#bypass) · [list](#list) · [listitem](#listitem) · [duplicate-id-aria](#duplicate-id-aria) · [aria-hidden-focus](#aria-hidden-focus) · [aria-required-attr](#aria-required-attr) · [aria-valid-attr-value](#aria-valid-attr-value) · [nested-interactive](#nested-interactive) · [tabindex](#tabindex) · [meta-viewport](#meta-viewport) · [frame-title](#frame-title) · [scrollable-region-focusable](#scrollable-region-focusable) · [target-size](#target-size) · [aria-dialog-name](#aria-dialog-name) · [link-in-text-block](#link-in-text-block)

---

## Keyboard pass rules

These come from the keyboard pass, not axe. Their ids start with `kbd-`.

## kbd-unreachable

Something looks clickable (cursor:pointer, onclick, click listener, interactive role) but Tab never reaches it.

```html
<!-- before -->
<div class="nav-item" onclick="go('/pricing')">Pricing</div>
<div class="btn" onclick="signIn()">Sign in</div>

<!-- after: navigation is a link, an action is a button -->
<a class="nav-item" href="/pricing">Pricing</a>
<button class="btn" type="button" onclick="signIn()">Sign in</button>
```

```jsx
// before
<div className="card" onClick={() => router.push(`/p/${id}`)}>…</div>
// after: the heading link is the target; ::after stretches the hit area over the card
<article className="card relative">
  <h3><a href={`/p/${id}`} className="after:absolute after:inset-0">{title}</a></h3>
  <p>{summary}</p>
</article>
```

Reset button styles instead of avoiding `<button>`: `className="appearance-none bg-transparent border-0 p-0 text-left"` (Tailwind) or `all: unset` plus a focus style.

Last resort only (when the element really cannot change): `role="button" tabindex="0"` plus `onKeyDown` handling **Enter and Space**. You now own everything the native element did for free.

## kbd-focus-not-visible

The element got focus but nothing on screen changed.

```css
/* before */
*:focus { outline: none; }

/* after: keyboard users get a ring, mouse users do not */
:focus-visible { outline: 3px solid #4f2fd8; outline-offset: 2px; }
```

```jsx
// Tailwind: remove `outline-none` / `focus:outline-none` without a replacement, add:
<button className="… focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">
```

The ring needs 3:1 contrast against the background next to it (`node scripts/contrast.mjs <ring> <bg> --target 3`). For card links, put the ring on the card: `.card:has(a:focus-visible) { outline: 3px solid … }` or Tailwind `has-[a:focus-visible]:ring-2`.

## kbd-focus-trap

Tab cycles inside a widget and never leaves it.

```js
// before: swallows Tab
input.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); other.focus(); } });
// after: delete the handler. Let the browser move focus.
```

A real modal *should* contain focus. Use `<dialog>` with `showModal()`: the browser makes the rest inert, Escape closes it, and you return focus to the trigger on close.

```jsx
const ref = useRef(null);
<button onClick={() => ref.current.showModal()}>Settings</button>
<dialog ref={ref} aria-labelledby="dlg-title" onClose={() => triggerRef.current?.focus()}>
  <h2 id="dlg-title">Settings</h2> …
  <button onClick={() => ref.current.close()}>Close</button>
</dialog>
```

## kbd-focus-hidden

Focus lands on something invisible: an off-screen drawer, an `opacity:0` menu, a collapsed accordion.

```html
<!-- before: moved off-screen but still focusable -->
<div class="mobile-menu" style="position:absolute;left:-9999px"><a href="/a">A</a></div>
<!-- after -->
<div class="mobile-menu" hidden><a href="/a">A</a></div>
```

React: render conditionally (`{open && <Menu/>}`) or add `inert={!open}` (React 19) / `inert={open ? undefined : ''}` (React 18). Tailwind: `invisible` (visibility:hidden) removes it from the tab order; `opacity-0` and `-translate-x-full` do not.

## kbd-focus-order

Focus jumps backwards on screen. Usually CSS `order`, `flex-direction: row-reverse`, grid placement, or a positive `tabindex` moved things visually without changing the DOM. Fix the DOM order to match what users see. Do not "fix" it with tabindex values.

## kbd-positive-tabindex

See [tabindex](#tabindex).

## kbd-focus-removed

Tab reaches the element, then a script throws focus away (`onfocus="blur()"`, `onFocus={e => e.target.blur()}`, a focus handler that calls `.focus()` on something else). Keyboard users lose their place and never see where they are (WCAG failure F55: 2.1.1, 2.4.7, 3.2.1). Usually written to hide the focus ring.

```html
<!-- before -->
<a href="/news" onfocus="blur()">News</a>
<!-- after: keep focus; hide the ring from mouse users only -->
<a href="/news">News</a>
<style> a:focus:not(:focus-visible) { outline: none; } a:focus-visible { outline: 3px solid #1d4ed8; } </style>
```

## kbd-focus-obscured

When focused, the control is completely hidden under a sticky header, cookie bar, or chat widget (WCAG 2.2 SC 2.4.11). Two causes:

1. The page scrolls the control under the layer. Fix with scroll padding equal to the layer's height:

```css
html { scroll-padding-top: 80px; scroll-padding-bottom: 96px; } /* sticky header / bottom bar heights */
```

2. The control is at the very end of the page and cannot scroll above a bottom bar at all. Scroll padding cannot help; leave room for the bar: `body { padding-bottom: 96px; }`, or make the banner non-fixed / dismissible and move focus into it first.

Tailwind: `scroll-pt-20 scroll-pb-24` on `<html>`, `pb-24` on `<body>`. The audit Tabs forwards only; also Shift+Tab backwards through the page yourself, since a sticky *header* usually hides focus on the way up.

## kbd-hover-only

A submenu opens on mouse hover but there is no keyboard way to open it, so its links are unreachable (2.1.1).

```css
/* before */ .menu li:hover > ul { display: block; }
/* after  */ .menu li:hover > ul, .menu li:focus-within > ul { display: block; }
```

Better for anything more than a couple of links: a disclosure button (APG "disclosure navigation menu").

```jsx
<li>
  <a href="/products">Products</a>
  <button aria-expanded={open} aria-controls="products-menu" onClick={() => setOpen(!open)}>
    <span className="sr-only">Products submenu</span>▾
  </button>
  <ul id="products-menu" hidden={!open}>…</ul>
</li>
```

Close it on Escape and when focus leaves. Tailwind: pair `group-hover:block` with `group-focus-within:block`.

## kbd-change-on-input

Choosing an option immediately navigates, submits, or opens a window (3.2.2 On Input). Keyboard users arrow through options and get taken away on the first keypress.

```html
<!-- before -->
<select onchange="location.href = this.value">…</select>
<!-- after -->
<form action="/go">
  <label for="dest">Go to</label>
  <select id="dest" name="dest">…</select>
  <button type="submit">Go</button>
</form>
```

Filtering a list in place (no page load, focus stays put) is fine; announce the result count with `role="status"`.

## kbd-dialog-escape

The open modal ignores Escape. Not a WCAG failure by itself while a Close button is reachable, but every user expects it (APG dialog pattern). Native `<dialog>` opened with `showModal()` closes on Escape for free; custom modals need a keydown handler. In UI kits look for the prop that disables it (`disableEscapeKeyDown` in MUI, `onEscapeKeyDown={e => e.preventDefault()}` in Radix).

## kbd-dialog-focus-return

After the dialog closes, focus lands on `<body>` (or elsewhere) instead of the button that opened it, so keyboard and screen-reader users start over from the top (2.4.3).

```js
const trigger = document.activeElement;   // before opening
dialog.showModal();
dialog.addEventListener('close', () => trigger.focus(), { once: true });
```

---

## color-contrast

Text needs 4.5:1 against its background (3:1 if ≥24px, or ≥18.66px bold). Get the nearest passing color that keeps your hue:

```bash
node scripts/contrast.mjs "#a3a8b5" "#ffffff"
#  Nearest fg for 4.5:1 (same hue; ΔE = OKLab distance, 0.02 ≈ just noticeable):
#    #727684  4.52:1  darker  ΔE 0.164
```

```css
/* before */ .lede { color: #a3a8b5; }
/* after  */ .lede { color: #727684; }
```

Tailwind: on white, `text-gray-400` fails (≈2.5:1); `text-gray-500` passes on white (≈4.8:1), `text-gray-600` passes on `bg-gray-50`/`bg-gray-100`. Check dark mode separately (`dark:text-gray-400` on `gray-900` passes, `gray-500` on `gray-800` does not). Prefer fixing the design token (`--muted-foreground`) over individual classes. Disabled controls are exempt, placeholder text is not.

## image-alt

```html
<!-- informative --> <img src="chart.png" alt="Signups doubled from March to June">
<!-- decorative  --> <img src="swoosh.svg" alt="">
<!-- logo next to the brand name: the text already names it --> <img src="logo.svg" alt=""> Brightly
<!-- logo alone in a link: describe the destination --> <a href="/"><img src="logo.svg" alt="Brightly home"></a>
```

```jsx
<Image src={hero} alt="" />            {/* next/image: alt is required; "" when decorative */}
<img src={avatar} alt={`${user.name}`} />
```

Alt text is a judgment call: describe the purpose, not the pixels. Flag ones you are unsure about for the human.

## svg-img-alt

```html
<!-- decorative icon inside a labelled button -->
<svg aria-hidden="true" focusable="false">…</svg>
<!-- meaningful standalone graphic -->
<svg role="img" aria-labelledby="t1"><title id="t1">Uptime 99.9%</title>…</svg>
```

Icon libraries: `lucide-react`/`heroicons` render `aria-hidden="true"` by default; pass `aria-label` only on standalone meaningful icons.

## label

```html
<!-- before --> <input type="email" placeholder="Email">
<!-- after  -->
<label for="email">Work email</label>
<input id="email" type="email" autocomplete="email" placeholder="you@company.com">
```

```jsx
const id = useId();
<label htmlFor={id}>Work email</label>
<input id={id} type="email" autoComplete="email" />
```

Vue: `<label :for="id">` with a unique `id`. Svelte: `<label for={id}>` or wrap the input: `<label>Email <input type="email"></label>`. Visually hidden labels (`sr-only`) are acceptable only when the purpose is visually obvious (e.g. a search field next to a magnifier button).

## placeholder-label

A placeholder is not a label: it vanishes as soon as the user types, is usually low contrast, and some assistive tech ignores it. axe accepts it as a name; this audit does not. Fix exactly as in [label](#label) and keep the placeholder only as an example value.

## select-name

```html
<label for="size">Team size</label>
<select id="size"><option>1–5</option><option>6–20</option></select>
```

Do not use a fake first option ("Team size") as the label.

## button-name

```html
<!-- before --> <button class="icon-btn"><svg>…</svg></button>
<!-- after  -->
<button class="icon-btn" type="button" aria-label="Toggle dark mode" aria-pressed="false">
  <svg aria-hidden="true" focusable="false">…</svg>
</button>
```

```jsx
<button aria-label="Close dialog"><X aria-hidden /></button>
// or keep text for sighted users too:
<button><X aria-hidden /><span className="sr-only">Close dialog</span></button>
```

## link-name

```html
<!-- before --> <a href="/customers"><img src="logos.png"></a>
<!-- after  --> <a href="/customers"><img src="logos.png" alt="See all customer stories"></a>
<!-- icon link --> <a href="https://github.com/acme" aria-label="Acme on GitHub"><svg aria-hidden="true">…</svg></a>
```

Avoid "click here" / "read more": the link text should make sense out of context, or add `<span class="sr-only"> about pricing</span>`.

## html-has-lang

```html
<html lang="en">
```

Next.js app router: `<html lang="en">` in `app/layout.tsx`. Vite/CRA: `index.html`. Nuxt: `app.head.htmlAttrs.lang` in `nuxt.config`. SvelteKit: `src/app.html`.

## document-title

```html
<title>Pricing · Brightly</title>
```

Next.js: `export const metadata = { title: 'Pricing · Brightly' }`. React SPA: React 19 `<title>` in the component, or `document.title` in an effect. Vue: `useHead({ title })`. Each route gets its own title.

## heading-order

```html
<!-- before --> <h1>Plan less</h1> … <h4>Roadmaps</h4>
<!-- after  --> <h1>Plan less</h1> <h2 class="sr-only">Features</h2> <h3>Roadmaps</h3>
```

Pick the level by document structure, then style it: `<h3 className="text-lg font-semibold">`. Never pick a heading level for its default size.

## page-has-heading-one

Each page needs one `<h1>` naming it. If the design has no visible title, `<h1 class="sr-only">Dashboard</h1>` is acceptable.

## landmark-one-main

```html
<body>
  <header>…<nav aria-label="Main">…</nav></header>
  <main id="main">…</main>
  <footer>…</footer>
</body>
```

React: replace the outer `<div className="content">` with `<main>`. Only one `<main>` per page (not one per component).

## region

All visible content should live inside a landmark. Usually fixed by [landmark-one-main](#landmark-one-main): move stray banners, toasts and cookie bars into `<header>`, `<main>`, `<footer>`, or give them `role="region" aria-label="…"`.

## bypass

```html
<a class="skip-link" href="#main">Skip to main content</a>
…
<main id="main" tabindex="-1">
```

```css
.skip-link { position: absolute; left: 1rem; top: -3rem; }
.skip-link:focus { top: 1rem; }
```

Tailwind: `className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4"`.

## list

```html
<!-- before --> <ul><div class="item">A</div></ul>
<!-- after  --> <ul><li class="item">A</li></ul>
```

In React, a mapped component that renders a `<div>` inside `<ul>` triggers this: make the component render `<li>`.

## listitem

`<li>` must be a child of `<ul>`, `<ol>` or `<menu>`. Wrap stray `<li>`s or change them to `<div>`.

## duplicate-id-aria

ids referenced by `for`, `aria-labelledby`, `aria-describedby` must be unique. Reused components with hard-coded ids are the usual cause.

```jsx
// before: id="email" inside a component rendered twice
// after
const id = useId();
<label htmlFor={id}>Email</label><input id={id} />
```

## aria-hidden-focus

```html
<!-- before: hidden from screen readers but still in the tab order -->
<div aria-hidden="true"><a href="/case-study">Read the case study</a></div>
<!-- after: either it is content (remove aria-hidden) ... -->
<div><a href="/case-study">Read the case study</a></div>
<!-- ... or it is truly inactive (inert removes it from focus and the a11y tree) -->
<div inert><a href="/case-study">Read the case study</a></div>
```

## aria-required-attr

```html
<!-- before --> <div role="checkbox">Remember me</div>
<!-- after (native, preferred) -->
<label><input type="checkbox"> Remember me</label>
```

If a custom widget is unavoidable it needs every required state (`aria-checked`, `aria-expanded`, `aria-valuenow` …) kept in sync with the UI.

## aria-valid-attr-value

```html
<!-- before --> <button aria-expanded="yes" aria-controls="menu-1">Menu</button>  <!-- and no #menu-1 -->
<!-- after  --> <button aria-expanded="false" aria-controls="menu">Menu</button><ul id="menu" hidden>…</ul>
```

React: `aria-expanded={open}` renders `"true"`/`"false"` correctly; `aria-expanded={open ? 'yes' : undefined}` does not.

## nested-interactive

```jsx
// before: button inside a link (or a link inside a button)
<a href="/post/1"><h3>Title</h3><button onClick={save}>Save</button></a>
// after: siblings, with the stretched-link pattern for the card
<article className="relative">
  <h3><a href="/post/1" className="after:absolute after:inset-0">Title</a></h3>
  <button onClick={save} className="relative z-10">Save</button>
</article>
```

## tabindex

```html
<!-- before --> <input type="email" tabindex="1">
<!-- after  --> <input type="email">        <!-- and move it in the DOM if it should come first -->
```

Allowed values: `0` (make a custom element focusable in DOM order) and `-1` (focusable by script only, e.g. a `<main>` skip-link target).

## meta-viewport

```html
<!-- before --> <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<!-- after  --> <meta name="viewport" content="width=device-width, initial-scale=1">
```

Next.js: check `export const viewport` in `app/layout.tsx` for `maximumScale`/`userScalable`.

## frame-title

```html
<iframe src="https://www.youtube.com/embed/…" title="Product demo video (2 minutes)"></iframe>
```

## scrollable-region-focusable

```html
<div class="overflow-x-auto" tabindex="0" role="region" aria-label="Pricing comparison table">
  <table>…</table>
</div>
```

## target-size

WCAG 2.2 (2.5.8) wants interactive targets at least 24×24 CSS px, or enough spacing. 44×44 is the comfortable touch size.

```jsx
// before: 16px icon button
<button className="p-0"><Trash className="h-4 w-4" /></button>
// after
<button className="inline-grid place-items-center h-10 w-10" aria-label="Delete"><Trash aria-hidden className="h-4 w-4" /></button>
```

## aria-dialog-name

```html
<dialog aria-labelledby="dlg-title"><h2 id="dlg-title">Delete project?</h2>…</dialog>
```

Radix/shadcn: keep `<DialogTitle>` (wrap in `VisuallyHidden` if the design hides it). Headless UI: `<DialogTitle>`.

## link-in-text-block

Links inside paragraphs must be distinguishable without color: keep the underline (`underline underline-offset-2`), or give the link 3:1 contrast against the surrounding text *and* a non-color cue on hover/focus.

```css
/* before */ .prose a { text-decoration: none; color: #3b82f6; }
/* after  */ .prose a { text-decoration: underline; text-underline-offset: 2px; }
```
