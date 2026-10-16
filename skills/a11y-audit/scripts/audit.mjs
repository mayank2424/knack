#!/usr/bin/env node
/**
 * Knack a11y-audit: axe-core + a real keyboard pass, with an annotated screenshot.
 *
 *   node audit.mjs http://localhost:3000
 *   node audit.mjs http://localhost:3000 --pages /pricing,/login --fail-on serious
 *   node audit.mjs ./dist/index.html --mobile --out ./a11y
 *   node audit.mjs http://localhost:5173 --state "#menu-button" --state "[data-open-dialog]"
 *
 * Input:  a URL, host:port, or a local .html file path.
 * Output (default ./.knack/a11y-audit/): report.md, report.json, <page>.annotated.png (+ .partN.png slices)
 *
 * Options:
 *   --pages a,b,c        Extra paths/URLs resolved against the first URL
 *   --tags list          axe tags (default wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice)
 *   --viewport WxH       Viewport size (default 1280x800)
 *   --mobile             Phone emulation (390x844, touch, DPR 2)
 *   --out dir            Output directory (default ./.knack/a11y-audit)
 *   --json               Print report.json to stdout (logs go to stderr)
 *   --fail-on impact     Exit 2 if any issue at/above: critical|serious|moderate|minor
 *   --state selector     Also audit after clicking selector (repeatable; --states a,b)
 *   --exclude selector   Skip a region in axe (repeatable), e.g. third-party widgets
 *   --wait ms            Extra settle time after load (default 500)
 *   --no-keyboard        Skip the keyboard pass
 *   --max-tabs N         Upper bound on Tab presses per page (default 400)
 *   --max-height px      Crop annotated screenshot height (default 6000; long pages also get .partN.png slices)
 *   --verbose            Log each phase with timings to stderr
 *   --help               Show this help
 *
 * Keyboard pass (what axe cannot check): real Tab presses for focus order and traps; visible focus by pixel
 * diff (own box, ancestor, label, or a change next to it); focus removed by script (onfocus=blur); focus
 * entirely hidden under fixed/sticky layers (2.4.11, forward Tab only); clickable-but-unfocusable elements;
 * menus that open on hover but not from the keyboard; <select>s that navigate on change (3.2.2, navigations
 * are blocked); with --state on a modal: Escape closes it and focus returns to the trigger.
 *
 * Exit codes: 0 done, 1 error, 2 --fail-on threshold hit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
const DEFAULT_TAGS = 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice';

// ------------------------------------------------------------------ args
const VALUE = new Set(['pages', 'tags', 'viewport', 'out', 'fail-on', 'wait', 'max-tabs', 'max-height']);
const MULTI = new Set(['state', 'states', 'exclude']);
const opts = { state: [], exclude: [] };
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-o') opts.out = argv[++i];
  else if (a.startsWith('--')) {
    let [k, inline] = a.slice(2).split(/=(.*)/s);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (VALUE.has(k)) opts[k] = val();
    else if (MULTI.has(k)) {
      const v = val();
      if (v === undefined) die(`--${k} needs a value`);
      if (k === 'states') opts.state.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
      else opts[k].push(v);
    } else opts[k] = true;
  } else positional.push(a);
}

function usage(code) {
  const txt = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n', '').replace('/**', '').replace(/^ \* ?/gm, '');
  (code ? console.error : console.log)(txt.trim());
  process.exit(code);
}
if (opts.help) usage(0);
if (!positional.length) usage(1);

const JSON_MODE = !!opts.json;
const TTY = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = JSON_MODE ? console.error : console.log;
const log = (msg) => out(`${c(35, '◆')} ${msg}`);
const vlog = (msg) => { if (opts.verbose) console.error(`${c(90, '·')} ${((Date.now() - T0) / 1000).toFixed(1)}s ${msg}`); };
const T0 = Date.now();
const warn = (msg) => console.error(`${c(33, '⚠')} ${msg}`);
function die(msg) { console.error(`${c(31, '✖')} ${msg}`); process.exit(1); }

const failOn = opts['fail-on'];
if (failOn && !IMPACTS.includes(failOn)) die(`--fail-on must be one of ${IMPACTS.join(', ')}`);
const tags = (opts.tags || DEFAULT_TAGS).split(',').map((s) => s.trim()).filter(Boolean);
const mobile = !!opts.mobile;
let [vw, vh] = (opts.viewport || (mobile ? '390x844' : '1280x800')).split('x').map(Number);
if (!vw || !vh) die('--viewport must look like 1280x800');
const settle = opts.wait !== undefined ? +opts.wait : 500;
const maxTabs = +(opts['max-tabs'] || 400);
const maxHeight = +(opts['max-height'] || 6000);
const outDir = path.resolve(opts.out || '.knack/a11y-audit');
const keyboard = !opts['no-keyboard'];

function toUrl(input) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith('about:') || input.startsWith('data:')) return input;
  if (fs.existsSync(input)) return pathToFileURL(path.resolve(input)).href;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|[\w.-]+\.(local|localhost|test))(:\d+)?(\/|$)/i.test(input) || /^[\w.-]+:\d+/.test(input)) return 'http://' + input;
  if (/^[\w-]+(\.[\w-]+)+/.test(input)) return 'https://' + input;
  die(`Not a URL or an existing file: ${input}`);
}
const baseUrl = toUrl(positional[0]);
const targets = [baseUrl];
for (const p of (opts.pages || '').split(',').map((s) => s.trim()).filter(Boolean)) targets.push(new URL(p, baseUrl).href);
for (const extra of positional.slice(1)) targets.push(toUrl(extra));

// ------------------------------------------------------------ playwright
async function loadPlaywright() {
  for (const mod of ['playwright', 'playwright-core']) {
    try { return (await import(mod)).chromium; } catch (_) {}
  }
  die(`Playwright is not installed. Run: bash "${path.join(SCRIPT_DIR, 'setup.sh')}"`);
}
function axeSource() {
  try { return fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); }
  catch (_) { die(`axe-core is not installed. Run: bash "${path.join(SCRIPT_DIR, 'setup.sh')}"`); }
}
async function launch(chromium) {
  const tries = [{}, { channel: 'chrome' }, { channel: 'msedge' }];
  let lastErr;
  for (const t of tries) {
    try { return await chromium.launch({ ...t, args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'] }); }
    catch (e) { lastErr = e; }
  }
  die(`Could not launch Chromium. Run: npx playwright install chromium\n${lastErr?.message?.split('\n')[0]}`);
}

// --------------------------------------------------------- WCAG metadata
const SC = {
  '1.1.1': 'Non-text Content', '1.2.2': 'Captions (Prerecorded)', '1.3.1': 'Info and Relationships', '1.3.2': 'Meaningful Sequence',
  '1.3.4': 'Orientation', '1.3.5': 'Identify Input Purpose', '1.4.1': 'Use of Color', '1.4.2': 'Audio Control', '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text', '1.4.6': 'Contrast (Enhanced)', '1.4.10': 'Reflow', '1.4.11': 'Non-text Contrast', '1.4.12': 'Text Spacing',
  '1.4.13': 'Content on Hover or Focus', '2.1.1': 'Keyboard', '2.1.2': 'No Keyboard Trap', '2.1.4': 'Character Key Shortcuts',
  '2.2.1': 'Timing Adjustable', '2.2.2': 'Pause, Stop, Hide', '2.4.1': 'Bypass Blocks', '2.4.2': 'Page Titled', '2.4.3': 'Focus Order',
  '2.4.4': 'Link Purpose (In Context)', '2.4.6': 'Headings and Labels', '2.4.7': 'Focus Visible', '2.4.11': 'Focus Not Obscured (Minimum)',
  '2.4.13': 'Focus Appearance', '2.5.3': 'Label in Name', '2.5.8': 'Target Size (Minimum)', '3.1.1': 'Language of Page',
  '3.1.2': 'Language of Parts', '3.2.1': 'On Focus', '3.2.2': 'On Input', '3.3.1': 'Error Identification', '3.3.2': 'Labels or Instructions',
  '4.1.1': 'Parsing', '4.1.2': 'Name, Role, Value', '4.1.3': 'Status Messages',
};
const wcagFromTags = (tagList) => tagList.map((t) => t.match(/^wcag(\d)(\d)(\d+)$/)).filter(Boolean).map((m) => `${m[1]}.${m[2]}.${m[3]}`);
const scLabel = (sc) => (SC[sc] ? `${sc} ${SC[sc]}` : sc);

// One-line fixes; full before/after recipes live in references/fix-recipes.md (#<rule-id>).
const FIX = {
  'color-contrast': 'Darken/lighten the text or background until it reaches 4.5:1 (3:1 for ≥24px or ≥18.66px bold). Use scripts/contrast.mjs <fg> <bg> to get the nearest passing color.',
  'color-contrast-enhanced': 'AAA target: 7:1 for body text, 4.5:1 for large text. Use scripts/contrast.mjs to find a passing shade.',
  'image-alt': 'Add alt text that says what the image communicates; use alt="" for purely decorative images.',
  'input-image-alt': 'Give <input type="image"> an alt that names the action ("Search"), not the picture.',
  'svg-img-alt': 'Give role="img" SVGs a <title> or aria-label; hide decorative SVGs with aria-hidden="true".',
  'role-img-alt': 'Elements with role="img" need aria-label or aria-labelledby.',
  'label': 'Associate a visible <label for> with every input (placeholder is not a label). Wrap or use for/id.',
  'select-name': 'Give the <select> a visible <label for>.',
  'button-name': 'Buttons need an accessible name: visible text, or aria-label for icon-only buttons (hide the icon with aria-hidden).',
  'link-name': 'Links need text. For icon links add aria-label or visually-hidden text; for image links give the img an alt.',
  'html-has-lang': 'Add lang to <html>, e.g. <html lang="en">.',
  'html-lang-valid': 'Use a valid BCP 47 tag in <html lang>, e.g. "en", "en-GB", "fr".',
  'document-title': 'Add a unique, descriptive <title> (framework: metadata/head API).',
  'heading-order': 'Do not skip heading levels (h1 → h2 → h3). Pick the level by structure, style with CSS.',
  'page-has-heading-one': 'Give every page one <h1> that names the page.',
  'empty-heading': 'Remove empty headings or give them text.',
  'landmark-one-main': 'Wrap the primary content in a single <main>.',
  'region': 'Put all content inside landmarks: <header>, <nav>, <main>, <footer> (or <aside>).',
  'landmark-unique': 'When a landmark type repeats (e.g. two <nav>), give each a distinct aria-label.',
  'landmark-banner-is-top-level': 'Keep <header> (banner) out of <main>/<section>/<article>.',
  'landmark-contentinfo-is-top-level': 'Keep the page <footer> (contentinfo) at the top level.',
  'landmark-no-duplicate-banner': 'Only one top-level <header> per page.',
  'landmark-no-duplicate-contentinfo': 'Only one top-level <footer> per page.',
  'landmark-main-is-top-level': '<main> must not be nested in another landmark.',
  'bypass': 'Add a "Skip to main content" link as the first focusable element, plus landmarks.',
  'list': '<ul>/<ol> may only contain <li> (and script/template).',
  'listitem': '<li> must be inside <ul>, <ol> or <menu>.',
  'definition-list': '<dl> may only contain <dt>/<dd> groups.',
  'duplicate-id': 'Make every id unique (generated ids: React useId, Vue/Svelte unique ids).',
  'duplicate-id-aria': 'ids referenced by aria-labelledby/for/aria-describedby must be unique.',
  'duplicate-id-active': 'Focusable elements must have unique ids.',
  'aria-allowed-attr': 'Remove ARIA attributes the role does not support.',
  'aria-required-attr': 'Add required ARIA states (e.g. role="checkbox" needs aria-checked) or use the native element.',
  'aria-required-children': 'Roles like list/menu/tablist need the right child roles, or use native elements.',
  'aria-required-parent': 'Roles like listitem/tab/option must sit inside their required parent role.',
  'aria-valid-attr': 'Fix misspelled aria-* attributes.',
  'aria-valid-attr-value': 'Fix invalid ARIA values (ids must exist; true/false must be strings).',
  'aria-roles': 'Use valid ARIA roles only, or better, the native element.',
  'aria-hidden-focus': 'aria-hidden content must not contain focusable elements: add inert, or remove aria-hidden.',
  'aria-hidden-body': 'Never put aria-hidden on <body>.',
  'aria-command-name': 'role="button"/"link"/"menuitem" needs an accessible name.',
  'aria-input-field-name': 'ARIA input widgets need aria-label or aria-labelledby.',
  'aria-toggle-field-name': 'ARIA toggles (checkbox/switch/radio) need a name.',
  'aria-dialog-name': 'Dialogs need aria-labelledby pointing at their heading.',
  'aria-prohibited-attr': 'Do not use aria-label on generic elements (div/span); use a real role or visible text.',
  'nested-interactive': 'Do not nest interactive controls (button in link, link in button). Restructure.',
  'frame-title': 'Give every <iframe> a title describing its content.',
  'meta-viewport': 'Remove maximum-scale / user-scalable=no so users can zoom.',
  'meta-refresh': 'Do not auto-refresh/redirect with <meta http-equiv="refresh">.',
  'tabindex': 'Remove positive tabindex; fix DOM order instead. Use tabindex="0" or "-1" only.',
  'scrollable-region-focusable': 'Make scrollable containers keyboard-reachable: tabindex="0" plus a role/label.',
  'target-size': 'Make touch targets at least 24×24 CSS px (44×44 recommended) or space them out.',
  'autocomplete-valid': 'Use valid autocomplete tokens (email, given-name, street-address, one-time-code...).',
  'link-in-text-block': 'Links in body text need a non-color cue (underline) or 3:1 contrast with surrounding text.',
  'video-caption': 'Provide captions via <track kind="captions">.',
  'object-alt': 'Give <object> a text alternative.',
  'avoid-inline-spacing': 'Do not use !important on inline letter/word/line spacing.',
  'label-title-only': 'Use a visible label, not only title/aria-describedby.',
  'label-content-name-mismatch': 'aria-label must contain the visible text (voice control users say what they see).',
  'p-as-heading': 'Use real <h2>/<h3> instead of bold paragraphs.',
  'presentation-role-conflict': 'Elements with role="none"/"presentation" must not be focusable or carry global ARIA.',
  'server-side-image-map': 'Use client-side image maps or links instead.',
  'kbd-focus-trap': 'Keyboard focus gets stuck. Remove keydown handlers that swallow Tab, or (for real modals) make sure Escape closes it and focus returns to the trigger.',
  'kbd-unreachable': 'Clickable but not keyboard-reachable. Use a native <button> or <a href>. Only if impossible: role + tabindex="0" + Enter/Space handlers.',
  'kbd-focus-not-visible': 'No visible focus indicator. Remove outline:none, or add a :focus-visible style (2px+ outline/ring at 3:1 contrast).',
  'kbd-focus-hidden': 'Focus lands on something invisible (off-screen menu, opacity:0). Hide it with display:none/hidden/inert when closed.',
  'kbd-focus-order': 'Focus jumps backwards on screen. Make DOM order match visual order; avoid CSS order/positive tabindex reshuffles.',
  'kbd-positive-tabindex': 'Positive tabindex overrides the natural order. Use 0 or -1 and fix DOM order.',
  'kbd-focus-removed': 'Delete the focus handler that calls blur() or moves focus away (onfocus="blur()", onFocus={e => e.target.blur()}). To hide rings for mouse users only, style :focus-visible instead.',
  'kbd-focus-obscured': 'Reserve room for the sticky/fixed layer: html { scroll-padding-top: <header height>; scroll-padding-bottom: <bottom bar height> } (or scroll-margin on the targets). Controls at the very end of the page cannot scroll above a bottom bar at all: also add body { padding-bottom: <bar height> }, or make the layer static, smaller, or dismissible.',
  'kbd-change-on-input': 'Do not navigate or submit on change. Add an explicit "Go"/submit button (form + <button type="submit">), or tell users beforehand what selecting an option will do.',
  'kbd-dialog-escape': 'Users expect Escape to close a modal (APG dialog pattern; not a WCAG failure by itself while a Close button is reachable). Close modals on Escape. Native <dialog> opened with showModal() does it for free; custom modals need a keydown handler for Escape (UI kits: Radix/Headless UI/MUI Dialog do this; check you did not disable it).',
  'kbd-dialog-focus-return': 'On close, move focus back to the element that opened the dialog (store document.activeElement before opening, call .focus() on it after closing). Native <dialog> and most UI-kit dialogs restore it automatically.',
  'kbd-hover-only': 'Open the submenu from the keyboard too: CSS: add :focus-within next to :hover (li:hover > ul, li:focus-within > ul). JS: give the parent a <button aria-expanded> that toggles the submenu on click/Enter, and close it on Escape (APG disclosure navigation pattern).',
  'placeholder-label': 'Placeholder text disappears on input and is often low contrast. Add a visible <label for> (keep the placeholder only as an example value).',
};

const KBD_RULES = {
  'kbd-focus-trap': { impact: 'critical', help: 'Keyboard focus is trapped', wcag: ['2.1.2'] },
  'kbd-unreachable': { impact: 'serious', help: 'Clickable element cannot be reached with the keyboard', wcag: ['2.1.1'] },
  'kbd-focus-not-visible': { impact: 'serious', help: 'Focused element shows no visible focus indicator', wcag: ['2.4.7'] },
  'kbd-focus-hidden': { impact: 'serious', help: 'Keyboard focus lands on an invisible element', wcag: ['2.4.7', '2.4.3'] },
  'kbd-focus-order': { impact: 'moderate', help: 'Focus order jumps backwards visually (review)', wcag: ['2.4.3'] },
  'kbd-positive-tabindex': { impact: 'serious', help: 'Element uses a positive tabindex', wcag: ['2.4.3'] },
  'kbd-focus-removed': { impact: 'serious', help: 'Script removes focus as soon as the element receives it', wcag: ['2.1.1', '2.4.7', '3.2.1'] },
  'kbd-focus-obscured': { impact: 'serious', help: 'Focused element is entirely hidden behind a sticky or fixed element', wcag: ['2.4.11'] },
  'kbd-change-on-input': { impact: 'serious', help: 'Changing a form control navigates away without warning', wcag: ['3.2.2'] },
  'kbd-dialog-escape': { impact: 'moderate', help: 'Escape does not close the open modal dialog (ARIA APG dialog pattern)', wcag: [] },
  'kbd-dialog-focus-return': { impact: 'moderate', help: 'Closing the dialog does not return focus to its trigger', wcag: ['2.4.3'] },
  'kbd-hover-only': { impact: 'serious', help: 'Menu opens on mouse hover but not from the keyboard', wcag: ['2.1.1'] },
  'placeholder-label': { impact: 'serious', help: 'Form field is labelled only by its placeholder', wcag: ['3.3.2', '1.3.1'] },
};

// ------------------------------------------------------ in-page helpers
// Installed once per page via evaluate (CSP-proof; context also bypasses CSP).
const PAGE_HELPERS = () => {
  if (window.__knack) return;
  let seq = 0;
  const FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,iframe,summary,[contenteditable]:not([contenteditable=false]),audio[controls],video[controls],[tabindex]';
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const idOf = (el) => { if (!el.dataset.knackId) el.dataset.knackId = String(++seq); return el.dataset.knackId; };
  const selectorOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + cssEsc(n.id)).length === 1) { parts.unshift('#' + cssEsc(n.id)); break; }
      let s = n.localName;
      const cls = [...n.classList].filter((k) => !k.startsWith('knack') && k.length < 32 && !/[:[\]/]/.test(k)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(cssEsc).join('.');
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((x) => x.localName === n.localName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(s);
      if (n.localName === 'body') break;
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (_) {}
    }
    return parts.join(' > ');
  };
  const nameOf = (el) => {
    const lab = el.getAttribute('aria-label');
    if (lab) return lab.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim();
    if (el.labels && el.labels.length) return [...el.labels].map((l) => l.textContent).join(' ').trim();
    const txt = ['select', 'input', 'textarea'].includes(el.localName) ? '' : (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 80);
    const img = el.querySelector && el.querySelector('img[alt]');
    return (el.getAttribute('alt') || img?.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').toString().slice(0, 80);
  };
  const snippet = (el) => {
    const h = el.outerHTML.replace(/ data-knack-[a-z-]+="[^"]*"/g, '');
    const open = h.slice(0, h.indexOf('>') + 1);
    return (open.length > 220 ? open.slice(0, 217) + '…' : open) + (h.length > open.length ? '…' : '');
  };
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const docW = Math.max(document.documentElement.scrollWidth, innerWidth), docH = Math.max(document.documentElement.scrollHeight, innerHeight);
    const left = r.left + scrollX, top = r.top + scrollY;
    if (left + r.width <= 0 || top + r.height <= 0 || left >= docW || top >= docH) return false;
    const cs = getComputedStyle(el);
    if (cs.clipPath && /inset\(50%|circle\(0/.test(cs.clipPath)) return false;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || (cs.position === 'absolute' && r.width <= 1 && r.height <= 1)) return false;
    return true;
  };
  // Custom checkboxes/radios/file inputs: the native input is opacity:0 on top of a styled label. The control
  // is visible through its label, so judge it by that instead of calling it "invisible".
  const PROXY_TYPES = new Set(['checkbox', 'radio', 'file', 'range', 'color']);
  const proxyOf = (el) => {
    if (el.localName !== 'input' || !PROXY_TYPES.has(el.type)) return null;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;
    const lab = el.labels && [...el.labels].find((l) => visible(l));
    return lab || null;
  };
  const visibleOrProxied = (el) => visible(el) || !!proxyOf(el);
  const tabbable = (el) => {
    if (!el.matches(FOCUSABLE) || el.disabled || el.closest('[inert]')) return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti < 0) return false;
    if (el.localName === 'summary' && el.parentElement?.localName !== 'details') return false;
    return visibleOrProxied(el);
  };
  // WCAG 2.4.11: is the focused element entirely covered by a fixed/sticky layer (header, cookie bar, chat)?
  // Sample 5 points; one uncovered point means "not entirely hidden" (partial cover passes 2.4.11).
  const opaqueBg = (n) => {
    const s = getComputedStyle(n);
    if (s.backgroundImage && s.backgroundImage !== 'none') return true;
    const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const a = m[1].split(/[ ,/]+/).filter(Boolean)[3];
    return a === undefined || +a >= 0.5;
  };
  const obscuredBy = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    let cover = null, inside = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.2], [0.85, 0.2], [0.15, 0.8], [0.85, 0.8]]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      inside++;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
      let layer = null;
      for (let n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') { layer = n; break; }
      }
      if (!layer || layer.contains(el) || +getComputedStyle(layer).opacity < 0.1) return null;
      let opaque = false;
      for (let n = hit; n; n = n.parentElement) { if (opaqueBg(n) || ['img', 'video', 'canvas', 'svg', 'picture'].includes(n.localName)) { opaque = true; break; } if (n === layer) break; }
      if (!opaque) return null;
      cover = layer;
    }
    return inside && cover ? cover : null;
  };
  // Focus events since the last reset: catches scripts that blur() or move focus the moment it arrives.
  // Capture-phase focus/blur, not focusin: Chrome skips focusin when a focus handler blurs synchronously.
  const focusLog = [];
  const target = (e) => (e.composedPath ? e.composedPath()[0] : e.target);
  document.addEventListener('focus', (e) => { const t = target(e); if (t && t.nodeType === 1) focusLog.push({ type: 'in', id: idOf(t) }); }, true);
  document.addEventListener('blur', (e) => { const t = target(e); if (t && t.nodeType === 1) focusLog.push({ type: 'out', id: idOf(t) }); }, true);
  const takeLog = () => focusLog.splice(0, focusLog.length);
  const inModal = (el) => !!el.closest('[aria-modal="true"],dialog[open]') && (el.closest('dialog[open]')?.matches(':modal') || !!el.closest('[aria-modal="true"]'));
  const deepActive = () => {
    let a = document.activeElement;
    while (a) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.localName === 'iframe' || a.localName === 'frame') {
        try { const d = a.contentDocument; if (d && d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; } } catch (_) {}
      }
      break;
    }
    return a;
  };
  const byId = (id) => document.querySelector(`[data-knack-id="${id}"]`);
  const docRect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const focusStyle = (el) => {
    const pick = (n) => { if (!n) return ''; const s = getComputedStyle(n); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.outlineOffset, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.borderBottomWidth, s.backgroundColor, s.color, s.textDecorationLine].join('|'); };
    const ancestors = [];
    for (let n = el.parentElement, i = 0; n && i < 4 && n !== document.body; n = n.parentElement, i++) ancestors.push(pick(n));
    return { self: pick(el), ancestors };
  };
  window.__knack = { FOCUSABLE, idOf, selectorOf, nameOf, snippet, visible, visibleOrProxied, proxyOf, tabbable, inModal, deepActive, byId, docRect, focusStyle, obscuredBy, takeLog };
};

const FOCUS_CHECK_LIMIT = 200; // visible-focus screenshots are the slow part; cap per page

// Kill transitions/animations/caret so before/after focus screenshots are deterministic.
const FREEZE_CSS = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;caret-color:transparent!important;scroll-behavior:auto!important}';

// ------------------------------------------------------------ axe pass
// Lazy iframes/images that never loaded make axe wait on frames that never answer (60 s each) and leave
// holes in the screenshot. Load them all up front, bounded.
async function loadLazy(page) {
  const n = await page.evaluate(() => {
    const lazy = [...document.querySelectorAll('iframe[loading=lazy],img[loading=lazy]')];
    for (const el of lazy) el.loading = 'eager';
    return lazy.length;
  }).catch(() => 0);
  if (!n) return;
  await page.waitForFunction(() => [...document.querySelectorAll('iframe,img')].every((el) => {
    if (el.localName === 'img') return el.complete;
    try {
      const d = el.contentDocument;
      if (!d) return true; // cross-origin: cannot tell; injection below reports it if it never answers
      return d.readyState === 'complete' && !(el.getAttribute('src') && d.location.href === 'about:blank');
    } catch (_) { return true; }
  }), null, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}

async function runAxe(page, src) {
  await loadLazy(page);
  // Inject into every frame; a frame without axe never answers and its content silently drops out of the
  // results, so count those and surface them as a coverage warning.
  let framesMissed = 0;
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) await frame.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    try { await frame.evaluate(src); } catch (_) {}
    if (frame !== page.mainFrame() && frame.url() !== 'about:blank') {
      const ok = await frame.evaluate(() => typeof window.axe?.run === 'function').catch(() => false);
      if (!ok) framesMissed++;
    }
  }
  const ok = await page.evaluate(() => typeof window.axe?.run === 'function');
  if (!ok) throw new Error('axe-core could not be injected into the page (CSP or sandboxed frame?).');
  const run = (iframes) => page.evaluate(async ({ tags, exclude, iframes }) => {
    const ctx = exclude.length ? { include: [document], exclude: exclude.map((s) => [s]) } : document;
    const r = await window.axe.run(ctx, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'], iframes, frameWaitTime: 5000 });
    const node = (n) => ({
      target: n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)),
      html: ((h) => (h.length > 300 ? h.slice(0, 297) + '…' : h))(n.html.replace(/ data-knack-[a-z-]+="[^"]*"/g, '')),
      failureSummary: n.failureSummary || '',
      data: n.any?.find((x) => x.data && typeof x.data === 'object')?.data || null,
    });
    return {
      version: window.axe.version,
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, description: v.description, helpUrl: v.helpUrl, tags: v.tags, nodes: v.nodes.map(node) })),
      incomplete: r.incomplete.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length, nodes: v.nodes.slice(0, 5).map(node) })),
      passes: r.passes?.length || 0,
    };
  }, { tags, exclude: opts.exclude, iframes });
  // A frame that never answers can still stall axe; fall back to the top document rather than hang.
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(null), 90000); });
  const res = await Promise.race([run(true), timeout]);
  clearTimeout(timer);
  if (res) return framesMissed ? { ...res, framesMissed } : res;
  warn('axe did not finish within 90 s with iframes; re-running on the top document only (iframe content not audited).');
  await page.evaluate(() => { if (window.axe) window.axe._running = false; }).catch(() => {});
  return { ...(await run(false)), iframesSkipped: true };
}

// ------------------------------------------------- extra static checks
// axe accepts a placeholder as an accessible name; WCAG 3.3.2 still wants a real label.
async function extraChecks(page) {
  const nodes = await page.evaluate(() => {
    const K = window.__knack;
    return [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]),textarea')]
      .filter((el) => el.getAttribute('placeholder') && !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title') && K.visible(el))
      .map((el) => ({ id: K.idOf(el), selector: K.selectorOf(el), html: K.snippet(el), detail: `Only a placeholder ("${el.getAttribute('placeholder').slice(0, 40)}") names this field.` }));
  });
  return nodes.length ? [{ id: 'placeholder-label', ...KBD_RULES['placeholder-label'], source: 'knack', nodes }] : [];
}

// ------------------------------------------------------- keyboard pass
async function scanClickables(page) {
  // Candidates: cursor:pointer roots, onclick (attr or property), interactive roles; plus CDP click listeners.
  const pre = await page.evaluate(() => {
    const K = window.__knack;
    const roles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'combobox', 'treeitem']);
    const hits = [], probe = [];
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      if (['script', 'style', 'noscript', 'template', 'br', 'option', 'optgroup', 'label', 'svg', 'path', 'html', 'body'].includes(el.localName)) continue;
      if (el.closest('svg') && el.localName !== 'svg') continue;
      if (el.matches(K.FOCUSABLE)) { const ti = el.getAttribute('tabindex'); if (!(ti !== null && +ti < 0) || el.matches('a[href],button,input,select,textarea,summary')) continue; }
      if (el.parentElement?.closest(K.FOCUSABLE.replace(',[tabindex]', '') + ',label,[tabindex]:not([tabindex^="-"])')) continue;
      if (!K.visible(el)) continue;
      const cs = getComputedStyle(el);
      const pointer = cs.cursor === 'pointer' && getComputedStyle(el.parentElement || el).cursor !== 'pointer';
      const onclick = el.hasAttribute('onclick') || typeof el.onclick === 'function' || el.hasAttribute('@click') || el.hasAttribute('v-on:click') || el.hasAttribute('ng-click');
      const role = roles.has(el.getAttribute('role'));
      const why = [pointer && 'cursor:pointer', onclick && 'click handler', role && `role="${el.getAttribute('role')}"`].filter(Boolean);
      if (why.length) hits.push({ id: K.idOf(el), why });
      else if (!el.querySelector(K.FOCUSABLE)) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < innerWidth * innerHeight * 0.5) probe.push(el);
      }
    }
    window.__knackProbe = probe.slice(0, 2500);
    return hits;
  });
  // CDP: elements with their own click/pointer listeners (catches addEventListener on divs).
  try {
    const cdp = await page.context().newCDPSession(page);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__knackProbe' });
    if (result.objectId) {
      const props = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
      const types = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']);
      const found = [];
      for (const p of props.result) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: p.value.objectId });
        if (listeners.some((l) => types.has(l.type))) found.push(+p.name);
      }
      if (found.length) {
        const extra = await page.evaluate((idx) => idx.map((i) => ({ id: window.__knack.idOf(window.__knackProbe[i]), why: ['click listener'] })), found);
        pre.push(...extra);
      }
    }
    await cdp.detach();
  } catch (_) { /* non-Chromium or CDP unavailable: heuristics only */ }
  await page.evaluate(() => { delete window.__knackProbe; });
  return page.evaluate((hits) => hits.map((h) => {
    const el = window.__knack.byId(h.id);
    return { id: h.id, selector: window.__knack.selectorOf(el), html: window.__knack.snippet(el), name: window.__knack.nameOf(el), why: h.why.join(', ') };
  }), pre);
}

async function keyboardPass(page, diffPage, { fromCurrent = false } = {}) {
  const issues = [];
  const add = (rule, nodes) => { if (nodes.length) issues.push({ id: rule, ...KBD_RULES[rule], source: 'keyboard', nodes }); };

  await page.evaluate((css) => { const s = document.createElement('style'); s.dataset.knack = 'freeze'; s.textContent = css; document.head.appendChild(s); }, FREEZE_CSS);

  const expected = await page.evaluate(() => {
    const K = window.__knack;
    const els = [...document.querySelectorAll(K.FOCUSABLE)].filter(K.tabbable);
    const radios = new Set();
    const list = els.filter((el) => { if (el.type === 'radio' && el.name) { if (radios.has(el.name)) return false; radios.add(el.name); } return true; });
    const positive = els.filter((el) => +el.getAttribute('tabindex') > 0).map((el) => ({ id: K.idOf(el), selector: K.selectorOf(el), html: K.snippet(el), detail: `tabindex="${el.getAttribute('tabindex')}"` }));
    return { count: list.length, ids: list.map((el) => K.idOf(el)), positive };
  });

  vlog('scan clickables');
  const unreachable = await scanClickables(page);
  vlog('tab loop');

  // Tab loop
  if (!fromCurrent) await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const seq = [], seen = new Map();
  let completed = false, trap = null, iframeRepeats = 0, bodyHits = 0;
  const limit = Math.min(maxTabs, expected.count * 2 + 25);
  const readActive = () => page.evaluate(() => {
      const K = window.__knack;
      const log = K.takeLog();
      const el = K.deepActive();
      if (!el || el === document.body || el === document.documentElement) {
        // Focus arrived somewhere and was immediately taken away (onfocus="blur()", focus() elsewhere).
        const landed = log.filter((e) => e.type === 'in').map((e) => K.byId(e.id)).filter((n) => n && n !== document.body);
        const last = landed[landed.length - 1];
        if (last) return { body: true, removed: { id: K.idOf(last), tag: last.localName, role: last.getAttribute('role') || '', name: K.nameOf(last), selector: K.selectorOf(last), html: K.snippet(last), visible: K.visibleOrProxied(last), modal: false } };
        return { body: true };
      }
      const framed = el.ownerDocument !== document;
      const cover = !framed && K.visible(el) ? K.obscuredBy(el) : null;
      let pinned = false;
      for (let n = el; n && n.nodeType === 1 && !framed; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') { pinned = true; break; } }
      return { id: K.idOf(el), tag: el.localName, role: el.getAttribute('role') || '', name: K.nameOf(el), selector: K.selectorOf(el), html: K.snippet(el), visible: framed || K.visibleOrProxied(el), framed, pinned, modal: K.inModal(el), tabindex: el.getAttribute('tabindex'), obscuredBy: cover ? K.selectorOf(cover) : null };
  });
  const removed = [];
  if (fromCurrent) {
    // States: start from wherever the app put focus (e.g. inside a just-opened dialog).
    const start = await readActive();
    if (!start.body) { seen.set(start.id, 0); seq.push(start); }
  } else await page.evaluate(() => window.__knack.takeLog());
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const a = await readActive();
    if (a.body && a.removed) {
      // Chrome keeps the sequential-navigation start point on the blurred element, so the next Tab moves on.
      if (seen.has(a.removed.id)) { completed = true; break; }
      seen.set(a.removed.id, seq.length);
      seq.push({ ...a.removed, removedOnFocus: true });
      removed.push(a.removed);
      continue;
    }
    if (a.body) { bodyHits++; if (seq.length) { completed = true; break; } if (bodyHits > 3) break; continue; }
    if (seen.has(a.id)) {
      if (a.tag === 'iframe' || a.tag === 'frame') { if (++iframeRepeats < 60) continue; }
      const idx = seen.get(a.id);
      if (idx === 0 && seq.length >= Math.floor(expected.count * 0.9)) { completed = true; break; }
      const cycle = seq.slice(idx);
      const never = expected.ids.filter((id) => !seen.has(id));
      const neverSel = await page.evaluate((ids) => ids.slice(0, 8).map((id) => window.__knack.selectorOf(window.__knack.byId(id))), never);
      trap = { at: a.selector, cycle: cycle.map((s) => s.selector), reached: seq.length, expected: expected.count, neverReached: never.length, neverReachedSample: neverSel, intended: cycle.every((s) => s.modal), stuck: idx === seq.length - 1 };
      break;
    }
    seen.set(a.id, seq.length);
    seq.push(a);
  }
  if (!completed && !trap && seq.length >= limit) warn(`Stopped after ${limit} Tab presses; raise --max-tabs for very long pages.`);

  // Pass 2: per focus stop, screenshot unfocused vs focused and diff pixels. If the element's own box
  // shows nothing, retry on the nearest ancestor whose styles change on focus (card rings via :has/:focus-within).
  vlog(`focus diff for ${seq.length} stops`);
  const focusStops = [];
  for (const [n, s] of seq.entries()) {
    const stop = { n: n + 1, id: s.id, selector: s.selector, tag: s.tag, role: s.role, name: s.name, html: s.html, visible: s.visible };
    if (s.removedOnFocus) stop.removedOnFocus = true;
    if (s.framed) stop.framed = true;
    if (s.obscuredBy) stop.obscuredBy = s.obscuredBy;
    if (s.pinned) stop.pinned = true;
    focusStops.push(stop);
    // Not measurable here: focus that was taken away (reported separately), elements inside iframes, and
    // the <iframe> stop itself (the ring, if any, is drawn inside the frame's own document).
    if (!s.visible || s.removedOnFocus || s.framed || s.tag === 'iframe' || s.tag === 'frame' || n >= FOCUS_CHECK_LIMIT) continue;
    let r = await diffFocus(page, diffPage, s.id, { level: 0 });
    if (!r) continue;
    let via = null;
    // Fallbacks when the element's own box shows nothing: an ancestor whose style changed (card rings via
    // :has/:focus-within), the label of a visually hidden native input, then anything near it in the viewport
    // (sibling indicators such as input:focus + label::after).
    const tries = [];
    if (r.ancestorChanged > 0) tries.push([{ level: r.ancestorChanged }, `ancestor ${r.ancestorChanged} level(s) up`]);
    tries.push([{ label: true }, 'its <label>'], [{ viewport: true, near: 160 }, 'a change next to it']);
    for (const [region, how] of tries) {
      if (r.visible) break;
      const r2 = await diffFocus(page, diffPage, s.id, region);
      if (r2 && r2.visible) { r = { ...r2, changed: r.changed }; via = how; }
    }
    stop.focus = { changedPixels: r.d.changed, ratio: +(r.d.changed / r.d.total).toFixed(4), maxDelta: r.d.maxDelta, changed: r.changed, ...(via ? { via } : {}) };
    stop.focusVisible = r.visible;
  }

  add('kbd-focus-removed', removed.map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: `Tab reaches this ${s.tag} but a script immediately removes focus (blur() or focus moved elsewhere), so keyboard users never see or keep focus here${s.name ? `: "${s.name.slice(0, 40)}"` : ''}.` })));
  add('kbd-focus-obscured', focusStops.filter((s) => s.obscuredBy).map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: `When focused, this element is entirely covered by the fixed/sticky element \`${s.obscuredBy}\`.` })));
  add('kbd-focus-not-visible', focusStops.filter((s) => s.focusVisible === false).map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: `No visible change when focused (${s.focus.changed.length ? 'computed changes: ' + s.focus.changed.join(', ') + ', but ' + (s.focus.maxDelta > 0 ? `the strongest pixel change is only ${s.focus.maxDelta}/255` : 'no pixels changed') : 'no style change at all'}).` })));
  add('kbd-focus-hidden', focusStops.filter((s) => !s.visible && !s.removedOnFocus).map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: 'Receives focus while invisible, off-screen, or zero-size.' })));
  vlog('hover-only menus');
  add('kbd-hover-only', await hoverOnly(page));
  add('kbd-unreachable', unreachable.map((u) => ({ id: u.id, selector: u.selector, html: u.html, detail: `Looks clickable (${u.why}) but is not focusable${u.name ? `: "${u.name.slice(0, 40)}"` : ''}.` })));
  if (!tags.includes('best-practice')) add('kbd-positive-tabindex', expected.positive);
  if (trap) {
    const node = { selector: trap.at, html: seq.find((s) => s.selector === trap.at)?.html || '', detail: `${trap.stuck ? 'Tab does not move focus.' : `Tab cycles between ${trap.cycle.length} elements.`} Cycle: ${trap.cycle.slice(0, 6).join(' → ')}. ${trap.neverReached ? `${trap.neverReached} tabbable element(s) can never be reached, e.g. ${trap.neverReachedSample.slice(0, 3).join(', ')}.` : ''}`.trim() };
    if (trap.intended) node.detail = 'Inside an open modal dialog (an intentional trap is OK). Verify Escape closes it and focus returns to the trigger. ' + node.detail;
    else add('kbd-focus-trap', [{ id: seq.find((s) => s.selector === trap.at)?.id, ...node }]);
  }

  // Measure everything at scroll 0 in document coordinates for the annotated screenshot.
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const rects = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => { const el = window.__knack.byId(id); return [id, el ? window.__knack.docRect(el) : null]; })), [...new Set([...focusStops.map((s) => s.id), ...issues.flatMap((i) => i.nodes.map((n) => n.id)).filter(Boolean)])]);
  focusStops.forEach((s) => (s.rect = rects[s.id]));
  // Elements that are fixed/sticky now (at scroll 0) have no stable document position either (a back-to-top
  // link that a script pins only after scrolling, for example).
  const pinnedNow = await page.evaluate((ids) => ids.filter((id) => { for (let n = window.__knack.byId(id); n && n.nodeType === 1; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return true; } return false; }), focusStops.map((s) => s.id));
  for (const s of focusStops) if (pinnedNow.includes(s.id)) s.pinned = true;
  issues.forEach((i) => i.nodes.forEach((n) => { if (n.id) n.rect = rects[n.id]; }));

  // Backwards visual jumps (heuristic): next stop is well above and not to the right of the previous one.
  const jumps = [];
  for (let i = 1; i < focusStops.length; i++) {
    const p = focusStops[i - 1].rect, q = focusStops[i].rect;
    // Fixed/sticky elements (back-to-top, sticky headers) have no stable document position: skip them.
    if (!p || !q || !focusStops[i].visible || !focusStops[i - 1].visible || focusStops[i].pinned || focusStops[i - 1].pinned) continue;
    if (q.y + q.h < p.y - 120 && q.x <= p.x + 40) jumps.push({ id: focusStops[i].id, selector: focusStops[i].selector, html: focusStops[i].html, rect: q, detail: `Focus #${i} → #${i + 1} jumps up ${p.y - q.y}px (from ${focusStops[i - 1].selector}).` });
  }
  add('kbd-focus-order', jumps);

  await page.evaluate(() => document.querySelector('style[data-knack="freeze"]')?.remove());
  return {
    focusOrder: focusStops.map(({ id, ...s }) => s),
    expectedTabbable: expected.count,
    completedCycle: completed,
    trap,
    issues,
  };
}

// Menus that open on mouse hover but not for keyboard users (CSS li:hover > ul, JS mouseenter). For each
// hidden group of links, hover its parent: if that reveals it, check whether focusing the parent's own
// controls (and Enter on a disclosure button) reveals it too.
async function hoverOnly(page) {
  const cands = await page.evaluate(() => {
    const K = window.__knack, out = [], seenP = new Set();
    const hiddenGroups = [...document.querySelectorAll('ul,ol,div,section,nav')].filter((h) => !K.visible(h) && h.querySelector('a[href],button') && h.parentElement && K.visible(h.parentElement));
    for (const h of hiddenGroups) {
      const p = h.parentElement;
      if (seenP.has(p) || [...seenP].some((q) => q.contains(p) || p.contains(q)) || p === document.body) continue;
      const r = p.getBoundingClientRect();
      if (r.width * r.height > innerWidth * innerHeight * 0.3) continue;
      seenP.add(p);
      out.push({ pid: K.idOf(p), hid: K.idOf(h), selector: K.selectorOf(p), html: K.snippet(p), links: h.querySelectorAll('a[href],button').length });
      if (out.length >= 15) break;
    }
    return out;
  });
  if (!cands.length) return [];
  const shown = (hid) => page.evaluate((hid) => { const h = window.__knack.byId(hid); return !!h && window.__knack.visible(h); }, hid);
  let nav = false;
  const onRoute = (route) => { const req = route.request(); if (req.isNavigationRequest() && req.frame() === page.mainFrame()) { nav = true; return route.abort('aborted'); } return route.fallback(); };
  await page.route('**/*', onRoute);
  const hits = [];
  try {
    for (const c of cands) {
      const box = await page.evaluate((pid) => { const p = window.__knack.byId(pid); document.activeElement?.blur?.(); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; }, c.pid);
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(350);
      if (!(await shown(c.hid))) { await page.mouse.move(0, 0); continue; }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(350);
      if (await shown(c.hid)) continue; // stays open after hover (click-toggled or sticky): not a hover-only menu
      const controls = await page.evaluate(({ pid, hid }) => {
        const K = window.__knack, p = K.byId(pid), h = K.byId(hid);
        const own = [...p.querySelectorAll(K.FOCUSABLE)].filter((el) => !h.contains(el) && K.tabbable(el));
        if (p.matches(K.FOCUSABLE) && K.tabbable(p)) own.unshift(p);
        return own.slice(0, 4).map((el) => ({ id: K.idOf(el), disclosure: el.hasAttribute('aria-expanded') || (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') }));
      }, c);
      let ok = false;
      for (const ctl of controls) {
        await page.evaluate((id) => window.__knack.byId(id).focus(), ctl.id);
        await page.waitForTimeout(400);
        if (await shown(c.hid)) { ok = true; break; }
        // Disclosure/menu buttons may open on a key instead of on focus (APG: Enter/Space for disclosures,
        // ArrowDown for menubar items). Navigations are blocked by the route above.
        if (ctl.disclosure) {
          for (const key of ['ArrowDown', 'Enter']) {
            await page.evaluate((id) => window.__knack.byId(id).focus(), ctl.id);
            await page.keyboard.press(key);
            await page.waitForTimeout(400);
            if (await shown(c.hid)) { ok = true; break; }
          }
          await page.keyboard.press('Escape').catch(() => {});
          if (ok) break;
        }
      }
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('Escape').catch(() => {});
      if (!ok) hits.push({ id: c.pid, selector: c.selector, html: c.html, detail: controls.length ? `Hovering opens a menu of ${c.links} link(s)/button(s); focusing ${controls.length > 1 ? `any of its ${controls.length} controls` : 'its control'}${controls.some((x) => x.disclosure) ? ' (or pressing Enter/ArrowDown on it)' : ''} does not, so keyboard users cannot reach them.` : `Hovering opens a menu of ${c.links} link(s)/button(s), but there is nothing focusable to open it from the keyboard.` });
    }
  } finally {
    await page.unroute('**/*', onRoute).catch(() => {});
    await page.mouse.move(0, 0).catch(() => {});
  }
  if (nav) warn('A navigation was blocked while testing hover menus.');
  return hits;
}

// WCAG 3.2.2: pick another option in each <select> and watch for navigation, form submission, popups or an
// SPA route change. Navigation requests are aborted, so the page under test stays put and nothing new loads.
async function changeOnInput(page) {
  const sels = await page.evaluate(() => {
    const K = window.__knack;
    return [...document.querySelectorAll('select')].filter((el) => !el.disabled && !el.multiple && el.options.length > 1 && K.visible(el)).slice(0, 8)
      .map((el) => ({ id: K.idOf(el), selector: K.selectorOf(el), html: K.snippet(el), name: K.nameOf(el) }));
  });
  if (!sels.length) return [];
  const pathOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname + x.search; } catch (_) { return u; } };
  const startUrl = page.url(), start = pathOf(startUrl);
  let nav = null;
  // Context-level, so a popup's first navigation is blocked too (nothing new is loaded from the network).
  const onRoute = (route) => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.fallback();
    const popup = req.frame().page() !== page;
    if (popup || req.frame() === page.mainFrame()) {
      if (popup) nav = `popup ${req.url()}`; else nav = nav || `${req.method()} ${req.url()}`;
      return route.abort('aborted');
    }
    return route.fallback();
  };
  const onPopup = (p) => { nav = nav || `popup ${p.url()}`; p.close().catch(() => {}); };
  await page.context().route('**/*', onRoute);
  page.context().on('page', onPopup);
  const hits = [];
  try {
    for (const s of sels) {
      nav = null;
      const pick = await page.evaluate((id) => {
        const el = window.__knack.byId(id);
        const opts = [...el.options];
        const i = opts.findIndex((o, k) => k !== el.selectedIndex && !o.disabled);
        return i < 0 ? null : { index: i, prev: el.selectedIndex, text: opts[i].textContent.trim().slice(0, 40) };
      }, s.id);
      if (!pick) continue;
      await page.evaluate(() => { window.__knackSameDoc = true; });
      try { await page.locator(`[data-knack-id="${s.id}"]`).selectOption({ index: pick.index }, { timeout: 3000 }); } catch (_) { continue; }
      await page.waitForTimeout(700);
      const sameDoc = await page.evaluate(() => window.__knackSameDoc === true).catch(() => false);
      const moved = pathOf(page.url()) !== start ? page.url() : null;
      // A new document (blocked request, or a file:// load that cannot be blocked) or a popup is a change of
      // context. A same-document URL update (history API, e.g. live filters) is not flagged.
      if (nav || (moved && !sameDoc)) hits.push({ ...s, detail: `Selecting "${pick.text}" immediately ${nav?.startsWith('popup') ? `opened a new window (${nav.slice(6)})` : `navigated (${nav || `GET ${moved}`})`}, with no submit button. This fails 3.2.2 unless users are told beforehand.` });
      if (!sameDoc) break; // a new document: later checks would test a different page
      if (moved) await page.evaluate((u) => history.replaceState(history.state, '', u), startUrl).catch(() => {});
      await page.evaluate(({ id, prev }) => { const el = window.__knack.byId(id); if (el) el.selectedIndex = prev; }, { id: s.id, prev: pick.prev }).catch(() => {});
    }
  } finally {
    page.context().off('page', onPopup);
    await page.context().unroute('**/*', onRoute).catch(() => {});
  }
  return hits;
}

// Screenshot a region unfocused vs focused. region: {level: 0} = the element, {level: N} = its Nth ancestor,
// {label: true} = its first visible <label>, {viewport: true, near: px} = whole viewport, but only changes
// within `near` px of the element count.
const STYLE_KEYS = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-bottom-color', 'border-bottom-width', 'background-color', 'color', 'text-decoration'];
async function diffFocus(page, diffPage, id, region) {
  const box = await page.evaluate(({ id, region }) => {
    const K = window.__knack, el = K.byId(id);
    if (!el) return null;
    document.activeElement?.blur?.();
    el.scrollIntoView({ block: 'center', inline: 'center' });
    let t = el;
    if (region.label) t = (el.labels && [...el.labels].find((l) => K.visible(l))) || null;
    else for (let i = 0; i < (region.level || 0) && t.parentElement; i++) t = t.parentElement;
    if (!t) return null;
    const r = (region.viewport ? el : t).getBoundingClientRect();
    // Fixed/sticky layers over the element (cookie bars, sticky headers) would hide the indicator from the
    // screenshot; hide them while measuring (obscuring is reported separately as kbd-focus-obscured).
    const pad = 12;
    for (const n of document.querySelectorAll('body *')) {
      const p = getComputedStyle(n).position;
      if ((p !== 'fixed' && p !== 'sticky') || n.contains(el) || n.closest('[data-knack-hidden]')) continue;
      const q = n.getBoundingClientRect();
      if (q.right < r.left - pad || q.left > r.right + pad || q.bottom < r.top - pad || q.top > r.bottom + pad) continue;
      n.dataset.knackHidden = n.style.visibility || '-';
      n.style.visibility = 'hidden';
    }
    // Screenshots capture the visual viewport; on phones it can be offset from the layout viewport that
    // getBoundingClientRect uses (e.g. when content is wider than the screen), so convert.
    const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
    return { x: r.left - vv.offsetLeft, y: r.top - vv.offsetTop, w: r.width, h: r.height, vw: vv.width, vh: vv.height, before: K.focusStyle(el) };
  }, { id, region });
  const restore = () => page.evaluate(() => { for (const n of document.querySelectorAll('[data-knack-hidden]')) { n.style.visibility = n.dataset.knackHidden === '-' ? '' : n.dataset.knackHidden; delete n.dataset.knackHidden; } });
  if (!box || box.w < 1 || box.h < 1) { await restore(); return null; }
  const pad = 8;
  let clip;
  const VW = Math.floor(box.vw), VH = Math.floor(box.vh);
  if (region.viewport) clip = { x: 0, y: 0, width: VW, height: VH };
  else {
    const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
    clip = { x, y, width: Math.min(VW - x, Math.ceil(box.w + pad * 2)), height: Math.min(VH - y, Math.ceil(box.h + pad * 2)) };
  }
  if (clip.width < 2 || clip.height < 2) { await restore(); return null; }
  const before = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const after = await page.evaluate((id) => { const el = window.__knack.byId(id); el.focus({ focusVisible: true }); return window.__knack.focusStyle(el); }, id);
  const focused = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  await restore();
  const dpr = mobile ? 2 : 1;
  const near = region.viewport ? { x: (box.x - region.near) * dpr, y: (box.y - region.near) * dpr, w: (box.w + region.near * 2) * dpr, h: (box.h + region.near * 2) * dpr } : null;
  const d = await diffPage.evaluate(pixelDiff, { a: before.toString('base64'), b: focused.toString('base64'), near });
  const sa = box.before.self.split('|'), sb = after.self.split('|');
  const changed = STYLE_KEYS.filter((_, i) => sa[i] !== sb[i]);
  const ancestorChanged = box.before.ancestors.findIndex((sig, i) => sig !== after.ancestors[i]) + 1;
  if (ancestorChanged) changed.push(`ancestor ${ancestorChanged} up`);
  // Visible = enough pixels changed: at least 8 px and 0.3% of the region (of the element's own box for viewport mode).
  const area = region.viewport ? (box.w + pad * 2) * (box.h + pad * 2) * dpr * dpr : d.total;
  return { d, changed, ancestorChanged, visible: d.changed >= Math.max(8, area * 0.003) };
}

// Runs inside a blank helper page: decode two PNGs on canvas, count changed pixels.
async function pixelDiff({ a, b, near }) {
  const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
  const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, w, h).data;
  cx.clearRect(0, 0, w, h); cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, w, h).data;
  let changed = 0, maxDelta = 0;
  for (let i = 0; i < da.length; i += 4) {
    if (near) { const p = i / 4, x = p % w, y = (p - x) / w; if (x < near.x || y < near.y || x > near.x + near.w || y > near.y + near.h) continue; }
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    if (d > 32) changed++;
    if (d > maxDelta) maxDelta = d;
  }
  return { changed, total: w * h, maxDelta };
}

// ---------------------------------------------------- annotated screenshot
async function annotate(page, diffPage, pageReport, file) {
  // Page-level rules have no useful box (they flag <html>/<meta> or "everything"); list them in the header instead.
  const PAGE_LEVEL = ['region', 'landmark-one-main', 'page-has-heading-one', 'html-has-lang', 'html-lang-valid', 'document-title', 'meta-viewport', 'meta-refresh', 'bypass', 'landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo'];
  const pageLevel = [...new Set(pageReport.issues.filter((i) => PAGE_LEVEL.includes(i.id)).map((i) => i.id))];
  const boxes = await page.evaluate(({ violations, PAGE_LEVEL }) => {
    const find = (target) => {
      let root = document, el = null;
      for (const part of target.split(' >>> ')) { el = root.querySelector(part); if (!el) return null; root = el.shadowRoot || el; }
      return el;
    };
    const out = [];
    for (const v of violations) {
      if (PAGE_LEVEL.includes(v.id)) continue;
      for (const n of v.nodes) {
        try {
          const last = n.target[n.target.length - 1];
          const el = find(last.includes('>>>') ? last : n.target[0]);
          if (el && !['html', 'body', 'head', 'meta'].includes(el.localName)) out.push({ rule: v.id, impact: v.impact, rect: window.__knack.docRect(el) });
        } catch (_) {}
      }
    }
    return out;
  }, { violations: pageReport.axe.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 40) })), PAGE_LEVEL });
  for (const i of pageReport.issues.filter((x) => x.source !== 'axe')) for (const n of i.nodes) if (n.rect) boxes.push({ rule: i.id, impact: i.impact, rect: n.rect });

  const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
  const H = Math.min(dims.h, maxHeight), W = Math.max(vw, Math.min(dims.w, vw * 2));
  // Bars fixed to the bottom of the viewport (cookie banners, chat launchers) would be painted across the
  // middle of a full-page capture, on top of whatever sits there. Hide them for the picture and say so.
  const hiddenLayers = await page.evaluate((vh) => {
    const out = [];
    for (const n of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(n);
      if (cs.position !== 'fixed' || cs.visibility === 'hidden' || n.parentElement?.closest('[data-knack-shot-hidden]')) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.top < vh * 0.5 || r.height > vh * 0.6) continue;
      n.dataset.knackShotHidden = '1';
      n.style.setProperty('visibility', 'hidden', 'important');
      out.push(window.__knack.selectorOf(n));
    }
    return out;
  }, vh);
  const shot = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: W, height: H }, animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => { for (const n of document.querySelectorAll('[data-knack-shot-hidden]')) { n.style.removeProperty('visibility'); delete n.dataset.knackShotHidden; } });
  const counts = Object.fromEntries(IMPACTS.map((k) => [k, 0]));
  for (const v of pageReport.issues) counts[v.impact] = (counts[v.impact] || 0) + 1;
  const stops = (pageReport.keyboard?.focusOrder || []).filter((s) => s.rect && s.visible);
  const COLORS = { critical: '#e5132b', serious: '#ff5a1f', moderate: '#f59e0b', minor: '#ca8a04' };
  // "No visible focus" is shown by the magenta focus badge; keep its box but skip the label to cut clutter.
  const labelled = dedupeLabels(boxes.filter((b) => b.rule !== 'kbd-focus-not-visible'));
  const GRAY = '#6b7280';
  const badge = (st) => (st.focusVisible === false || st.removedOnFocus ? '#c026d3' : st.focusVisible === true ? '#2563eb' : GRAY);
  const box = (b) => {
    const col = COLORS[b.impact] || COLORS.critical, strong = b.impact === 'critical' || b.impact === 'serious';
    return `<div style="position:absolute;left:${b.rect.x - 2}px;top:${b.rect.y - 2}px;width:${Math.max(b.rect.w, 6) + 4}px;height:${Math.max(b.rect.h, 6) + 4}px;box-sizing:border-box;border:${strong ? 3 : 2}px ${b.rule.startsWith('kbd-') ? 'dashed' : 'solid'} ${col};${strong ? `background:${col}12;` : ''}border-radius:3px"></div>`;
  };
  const chip = (txt, col) => `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">${col}${txt}</span>`;
  await diffPage.setViewportSize({ width: W, height: 200 });
  await diffPage.setContent(`<!doctype html><html><body style="margin:0;background:#0d0d10;font:600 12px/1.25 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif">
    <div style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;padding:12px 16px;color:#e7e7ea;background:#16161b;border-bottom:1px solid #2a2a31">
      <span style="font-weight:800">a11y-audit</span>
      <span style="opacity:.6;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:${Math.round(W * 0.3)}px">${esc(pageReport.url)}${pageReport.state ? ' · after ' + esc(pageReport.state) : ''}</span>
      ${IMPACTS.map((k) => chip(`${counts[k]} ${k}`, `<i style="width:12px;height:12px;border:3px solid ${COLORS[k]};border-radius:2px;display:inline-block;box-sizing:border-box"></i>`)).join('')}
      ${chip(`focus order (${stops.length})`, '<b style="width:18px;height:18px;border-radius:50%;background:#2563eb;color:#fff;display:inline-grid;place-items:center;font-size:10px">1</b>')}
      ${chip('no visible focus', '<b style="width:18px;height:18px;border-radius:50%;background:#c026d3;color:#fff;display:inline-grid;place-items:center;font-size:10px">2</b>')}
      ${stops.some((s) => badge(s) === GRAY) ? chip('not measured (iframe)', `<b style="width:18px;height:18px;border-radius:50%;background:${GRAY};color:#fff;display:inline-grid;place-items:center;font-size:10px">3</b>`) : ''}
      ${chip('dashed = keyboard pass', '')}
      ${pageLevel.length ? `<span style="flex-basis:100%;color:#fca5a5;font-weight:500">Page-level: ${pageLevel.map(esc).join(' · ')}</span>` : ''}
      ${hiddenLayers.length ? `<span style="flex-basis:100%;color:#a1a1aa;font-weight:500">Not drawn (fixed to the viewport bottom): ${hiddenLayers.slice(0, 3).map(esc).join(' · ')}</span>` : ''}
    </div>
    <div id="stage" style="position:relative;width:${W}px;height:${H}px;overflow:hidden"><div id="inner" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px">
      <img src="data:image/png;base64,${shot.toString('base64')}" style="position:absolute;inset:0;width:${W}px;height:${H}px">
      ${boxes.map(box).join('')}
      ${labelled.map((b) => `<div style="position:absolute;left:${b.rect.x + b.rect.w + 2}px;top:${Math.max(0, b.rect.y - 17)}px;transform:translateX(-100%);background:${COLORS[b.impact] || COLORS.critical};color:#fff;font-size:10px;padding:2px 5px;border-radius:3px;white-space:nowrap">${esc(b.rule)}</div>`).join('')}
      ${stops.map((s) => `<div style="position:absolute;left:${s.rect.x - 10}px;top:${s.rect.y - 10}px;min-width:20px;height:20px;padding:0 4px;box-sizing:border-box;border-radius:10px;background:${badge(s)};color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;box-shadow:0 0 0 2px #fff,0 1px 4px #0006">${s.n}</div>`).join('')}
    </div></div></body></html>`);
  await diffPage.waitForFunction(() => [...document.images].every((i) => i.complete));
  const total = await diffPage.evaluate(() => document.body.scrollHeight);
  await diffPage.setViewportSize({ width: W, height: total });
  await diffPage.screenshot({ path: file, fullPage: true });
  // Long pages: image viewers (and the agent's Read tool) shrink a 1280×6000 image until labels are unreadable.
  // Also write readable slices; each keeps the legend header.
  const header = await diffPage.evaluate(() => document.body.firstElementChild.getBoundingClientRect().height);
  const TILE = 1500, tiles = [];
  if (H > TILE * 1.25) {
    for (let y = 0, k = 1; y < H; y += TILE, k++) {
      const h = Math.min(TILE, H - y);
      if (h < 200 && k > 1) break;
      const t = file.replace(/\.png$/, `.part${k}.png`);
      await diffPage.evaluate(({ y, h }) => { document.getElementById('stage').style.height = `${h}px`; document.getElementById('inner').style.top = `-${y}px`; }, { y, h });
      await diffPage.setViewportSize({ width: W, height: Math.ceil(header + h) });
      await diffPage.screenshot({ path: t, clip: { x: 0, y: 0, width: W, height: Math.ceil(header + h) } });
      tiles.push({ file: t, y0: y, y1: y + h });
    }
  }
  return tiles;
}
// One label per box, and skip a label that would sit on top of an identical one (dense lists of the same
// failure, e.g. 30 images missing alt, otherwise become an unreadable smear of tags).
function dedupeLabels(boxes) {
  const placed = [];
  return boxes.filter((b) => {
    const x = b.rect.x + b.rect.w, y = b.rect.y;
    if (placed.some((p) => p.rule === b.rule && Math.abs(p.x - x) < 120 && Math.abs(p.y - y) < 26)) return false;
    placed.push({ rule: b.rule, x, y });
    return true;
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// --------------------------------------------------------------- per page
function slugOf(u, i) {
  try {
    const url = new URL(u);
    const base = (url.protocol === 'file:' ? path.basename(url.pathname) : (url.pathname.replace(/\/$/, '') || '/home')).replace(/\.html?$/, '');
    return (base.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || `page-${i + 1}`).slice(0, 60);
  } catch { return `page-${i + 1}`; }
}

async function openTarget(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: vw, height: vh },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    bypassCSP: true,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (resp && resp.status() >= 400) warn(`${url} responded ${resp.status()}`);
  } catch (e) {
    await ctx.close();
    const m = e.message.split('\n')[0];
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m)) die(`Nothing is listening at ${url}. Start the dev server first (npm run dev) or pass the right port.`);
    if (/ERR_NAME_NOT_RESOLVED/.test(m)) die(`Could not resolve ${url}. Check the hostname.`);
    die(`Could not load ${url}: ${m}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (settle) await page.waitForTimeout(settle);
  await page.evaluate(PAGE_HELPERS);
  return { ctx, page, errors };
}

async function auditOne(browser, diffPage, src, url, slug, state) {
  const { ctx, page, errors } = await openTarget(browser, url);
  if (state) {
    try {
      await page.locator(state).first().evaluate((el) => { el.dataset.knackTrigger = '1'; }, null, { timeout: 5000 });
      await page.click(state, { timeout: 5000 });
    }
    catch (e) { await ctx.close(); warn(`State "${state}": could not click (${e.message.split('\n')[0]}); skipped.`); return null; }
    await page.waitForTimeout(Math.max(400, settle));
    await page.evaluate(PAGE_HELPERS);
  }
  const title = await page.title();
  const stack = await page.evaluate(DETECT_STACK).catch(() => []);
  vlog('axe');
  const axe = await runAxe(page, src);
  vlog('extra');
  const extra = await extraChecks(page);
  const kb = keyboard ? await keyboardPass(page, diffPage, { fromCurrent: !!state }) : null;
  if (extra.length) {
    const rects = await page.evaluate((ids) => ids.map((id) => window.__knack.docRect(window.__knack.byId(id))), extra[0].nodes.map((n) => n.id));
    extra[0].nodes.forEach((n, i) => (n.rect = rects[i]));
  }
  const issues = [
    ...axe.violations.map((v) => ({ id: v.id, impact: v.impact || 'minor', help: v.help, helpUrl: v.helpUrl, wcag: wcagFromTags(v.tags), source: 'axe', nodes: v.nodes })),
    ...[...extra, ...(kb?.issues || [])].map((i) => ({ id: i.id, impact: i.impact, help: i.help, helpUrl: '', wcag: i.wcag, source: i.source, nodes: i.nodes.map(({ id, ...n }) => n) })),
  ];
  // WCAG 3.2.2 on selects, in a throwaway copy of the page: changing a value may leave the page (file://
  // navigations and SPA route changes cannot be blocked), and the audited page must stay as it is.
  if (kb && (await page.evaluate(() => !!document.querySelector('select')))) {
    vlog('change on input');
    const fresh = await openTarget(browser, url);
    let hits = [];
    try {
      if (state) { await fresh.page.click(state, { timeout: 5000 }); await fresh.page.waitForTimeout(Math.max(400, settle)); await fresh.page.evaluate(PAGE_HELPERS); }
      hits = await changeOnInput(fresh.page);
    } catch (e) { warn(`change-on-input check failed: ${e.message.split('\n')[0]}`); }
    await fresh.ctx.close();
    if (hits.length) {
      const rects = await page.evaluate((sels) => sels.map((s) => { try { const el = document.querySelector(s); return el ? window.__knack.docRect(el) : null; } catch (_) { return null; } }), hits.map((h) => h.selector));
      issues.push({ id: 'kbd-change-on-input', ...KBD_RULES['kbd-change-on-input'], helpUrl: '', source: 'keyboard', nodes: hits.map((h, i) => ({ selector: h.selector, html: h.html, detail: h.detail, rect: rects[i] })) });
    }
  }
  const keyboardInfo = kb && { focusOrder: kb.focusOrder, expectedTabbable: kb.expectedTabbable, completedCycle: kb.completedCycle, trap: kb.trap };
  const report = { url, slug, title, state: state || null, stack, axe, keyboard: keyboardInfo, issues, pageErrors: errors };
  vlog('annotate');
  const png = path.join(outDir, `${slug}.annotated.png`);
  const tiles = await annotate(page, diffPage, report, png);
  report.screenshot = png;
  if (tiles.length) report.screenshotParts = tiles.map((t) => ({ file: t.file, y: [t.y0, t.y1], issues: report.issues.reduce((n, i) => n + i.nodes.filter((x) => x.rect && x.rect.y + x.rect.h >= t.y0 && x.rect.y < t.y1).length, 0) }));
  // Open modal: containing focus is fine only if Escape closes it and focus goes back to the trigger.
  if (kb && state) {
    vlog('dialog escape');
    const d = await dialogEscape(page, state);
    if (report.keyboard && d) report.keyboard.dialog = d;
    const mk = (rule, detail) => ({ id: rule, ...KBD_RULES[rule], helpUrl: '', source: 'keyboard', nodes: [{ selector: d.dialog, html: d.html, detail }] });
    if (d && !d.closed) report.issues.push(mk('kbd-dialog-escape', 'Pressing Escape inside the open dialog did not close it.'));
    else if (d && !d.returned) report.issues.push(mk('kbd-dialog-focus-return', `After Escape closed the dialog, focus went to ${d.focusAfter || 'the page body'} instead of the trigger \`${state}\`.`));
  }
  await ctx.close();
  return report;
}

async function dialogEscape(page, trigger) {
  const before = await page.evaluate(() => {
    const K = window.__knack;
    const dlg = [...document.querySelectorAll('dialog[open],[aria-modal="true"]')].find((d) => K.visible(d) && (d.localName !== 'dialog' || d.matches(':modal') || d.getAttribute('aria-modal') === 'true'));
    if (!dlg) return null;
    dlg.dataset.knackDialog = '1';
    // Start from inside the dialog, as a keyboard user would be (the audit blurred focus while measuring).
    const first = [...dlg.querySelectorAll(K.FOCUSABLE)].find(K.tabbable);
    (first || dlg).focus();
    return { dialog: K.selectorOf(dlg), html: K.snippet(dlg) };
  }).catch(() => null);
  if (!before) return null;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const after = await page.evaluate((trigger) => {
    const K = window.__knack, dlg = document.querySelector('[data-knack-dialog]');
    const closed = !dlg || !K.visible(dlg) || (dlg.localName === 'dialog' && !dlg.open);
    const a = K.deepActive();
    let t = document.querySelector('[data-knack-trigger]');
    if (!t) try { t = document.querySelector(trigger); } catch (_) {}
    const returned = !!a && !!t && (a === t || t.contains(a) || a.contains(t));
    return { closed, returned, focusAfter: a && a !== document.body ? K.selectorOf(a) : null };
  }, trigger).catch(() => ({ closed: false, returned: false }));
  return { ...before, ...after };
}

// ----------------------------------------------------------------- report
function summarize(pages) {
  const byImpact = Object.fromEntries(IMPACTS.map((k) => [k, 0]));
  const rules = new Map();
  for (const p of pages) for (const i of p.issues) {
    if (!rules.has(i.id)) { rules.set(i.id, { ...i, pages: new Set(), nodes: [] }); byImpact[i.impact] = (byImpact[i.impact] || 0) + 1; }
    const r = rules.get(i.id);
    r.pages.add(p.state ? `${p.slug}` : p.slug);
    const have = new Set(r.nodes.map((n) => (n.target || [n.selector]).join(' ') + n.page));
    for (const n of i.nodes) {
      const key = (n.target || [n.selector]).join(' ') + p.slug;
      if (!have.has(key)) { r.nodes.push({ ...n, page: p.slug }); have.add(key); }
    }
  }
  return { byImpact, rules: [...rules.values()].sort((a, b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact) || b.nodes.length - a.nodes.length) };
}

// Stack-specific wording for the fixes that differ by framework. Keys match detectStack() names.
const STACK_FIX = {
  'kbd-unreachable': { react: '`<div onClick>` → `<button type="button" onClick>`; navigation → `<a href>` / Next `<Link href>`.', vue: '`<div @click>` → `<button type="button" @click>`; navigation → `<RouterLink to>` / `<NuxtLink>`.', svelte: '`<div on:click>` / `onclick` → `<button on:click>`; svelte-check\'s a11y_click_events_have_key_events / a11y_no_static_element_interactions warnings point at the same spots.', angular: '`<div (click)>` → `<button type="button" (click)>`; navigation → `<a routerLink>`.' },
  'kbd-focus-not-visible': { tailwind: 'Replace `outline-none` / `focus:outline-none` with `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-<color>` (or `focus-visible:ring-2 focus-visible:ring-offset-2`).', mui: 'Do not strip focus styles from MUI components; style the `.Mui-focusVisible` class instead.' },
  'kbd-hover-only': { tailwind: 'Pair every `group-hover:block` with `group-focus-within:block`, or toggle the submenu from a `<button aria-expanded>`.' },
  'kbd-focus-obscured': { tailwind: 'Add `scroll-pt-<n>` to `<html>` matching the sticky header (e.g. `scroll-pt-20` for 80px), `scroll-pb-<n>` for bottom bars.' },
  'kbd-dialog-escape': { radix: 'Radix Dialog closes on Escape by default: look for `onEscapeKeyDown={e => e.preventDefault()}`.', mui: 'MUI Dialog: remove `disableEscapeKeyDown`.', react: 'If hand-rolled, prefer `<dialog>` + `showModal()` or a tested dialog (Radix, React Aria, Headless UI).' },
  'kbd-dialog-focus-return': { radix: 'Radix restores focus automatically unless `onCloseAutoFocus` prevents it.', react: 'Store `document.activeElement` before opening and call `.focus()` on it in the close handler.' },
  'label': { react: '`<label htmlFor={id}>` with `const id = useId()`.', vue: '`<label :for="id">` + matching `:id`.', angular: '`<label for="x">` or `<mat-label>` inside `<mat-form-field>`.', mui: 'Use the TextField `label` prop (it renders a real `<label>`).' },
  'placeholder-label': { react: 'Add `<label htmlFor={id}>`; keep the placeholder only as an example value.', mui: 'Use the TextField `label` prop instead of `placeholder` alone.' },
  'image-alt': { next: '`next/image` requires `alt`: give it real text, or `alt=""` for decoration.' },
  'link-name': { next: 'Icon links: `<Link href="…" aria-label="…">`, icon `aria-hidden`.' },
  'button-name': { react: 'Icon-only: `<button aria-label="Close"><XIcon aria-hidden="true" /></button>`.', mui: '`<IconButton aria-label="…">`.' },
  'color-contrast': { tailwind: 'Change the utility (e.g. `text-gray-400` → `text-gray-600`) or, if many elements share it, the theme token (`@theme` / `tailwind.config` colors).' },
  'document-title': { next: 'App Router: `export const metadata = { title: … }` per route; Pages Router: `<Head><title>`.', nuxt: '`useHead({ title })` / `useSeoMeta`.', svelte: '`<svelte:head><title>…</title></svelte:head>`.', angular: 'Route `title` property or the `Title` service.', astro: '`<title>` in the layout `<head>`.' },
  'html-has-lang': { next: '`<html lang="en">` in `app/layout.tsx` (or `pages/_document.tsx`).', nuxt: '`app.head.htmlAttrs.lang` in `nuxt.config`.', svelte: '`<html lang="en">` in `src/app.html`.', angular: '`<html lang>` in `src/index.html`.', astro: '`<html lang>` in the layout.' },
};
const STACK_NAMES = { next: 'Next.js', react: 'React', nuxt: 'Nuxt', vue: 'Vue', svelte: 'Svelte', angular: 'Angular', astro: 'Astro', tailwind: 'Tailwind', mui: 'MUI', radix: 'Radix UI' };

// Best-effort framework/UI-kit fingerprint from the rendered page (no source access needed).
const DETECT_STACK = () => {
  const f = new Set(), q = (sel) => { try { return !!document.querySelector(sel); } catch (_) { return false; } };
  const sample = [...document.querySelectorAll('body *')].slice(0, 400);
  if (window.__NEXT_DATA__ || q('#__next') || q('script[src*="/_next/"]')) f.add('next');
  if (f.has('next') || q('[data-reactroot]') || sample.some((el) => Object.keys(el).some((k) => k.startsWith('__react')))) f.add('react');
  if (window.__NUXT__ || q('#__nuxt')) f.add('nuxt');
  if (f.has('nuxt') || window.__VUE__ || q('[data-v-app]') || sample.some((el) => el.__vue_app__ || el.__vueParentComponent || [...el.attributes].some((a) => a.name.startsWith('data-v-')))) f.add('vue');
  if (q('[class*="svelte-"]')) f.add('svelte');
  if (q('[ng-version]')) f.add('angular');
  if (q('astro-island') || q('[data-astro-cid]') || [...document.querySelectorAll('[class]')].slice(0, 300).some((el) => [...el.classList].some((c) => c.startsWith('astro-')))) f.add('astro');
  const tw = sample.reduce((n, el) => n + [...(el.classList || [])].filter((c) => /^(?:[a-z0-9-]+:)*-?(?:p[xytrbl]?|m[xytrbl]?|text|bg|gap|rounded|shadow|w|h|font|leading|tracking|border|ring|inset|top|left|space-[xy])-[\w./[\]-]+$/.test(c)).length, 0);
  if (tw > 60) f.add('tailwind');
  if (q('[class*="Mui"]')) f.add('mui');
  if (q('[id^="radix-"]') || q('[data-radix-collection-item]') || q('[data-radix-popper-content-wrapper]')) f.add('radix');
  return [...f];
};

// A grep-able token from a start-tag snippet, to find the component in source.
function searchHint(html) {
  if (!html) return null;
  const attr = (n) => (html.match(new RegExp(`\\s${n}="([^"]{2,60})"`)) || [])[1];
  for (const n of ['id', 'aria-label', 'placeholder', 'alt', 'name', 'data-testid', 'href', 'for']) {
    const v = attr(n);
    if (v && !/^(#|\/)?$/.test(v) && !/^[0-9a-f-]{16,}$/i.test(v) && !/^:r[0-9a-z]+:$/.test(v)) return v;
  }
  const GENERIC = /^(field|input|button|btn|link|card|item|items|list|container|wrapper|wrap|icon|text|title|label|nav|header|footer|main|row|col|content|inner|active|primary|secondary|small|large|hidden|block|flex|grid)$/i;
  const cls = (attr('class') || '').split(/\s+/).filter((c) => (c.length > 3 && !/^(?:[a-z]+:)*-?[a-z]+-[\w./-]+$/.test(c) && !GENERIC.test(c)) || /__|--/.test(c)).sort((x, y) => y.length - x.length)[0];
  if (cls) return cls;
  // First text node only: text split across tags will not match the source as one string.
  const text = html.split(/<[^>]*>/).map((t) => t.replace(/…/g, '').replace(/\s+/g, ' ').trim()).find((t) => t.length >= 3);
  return text ? text.slice(0, 40).trim() : null;
}
// "Fix any of the following:\n  a\n  b" → "Any of: a; b"
function tidySummary(s) {
  const lines = String(s || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return '';
  const head = lines[0].match(/^Fix (any|all) of the following:?$/);
  const items = head ? lines.slice(1) : lines;
  return (head ? (head[1] === 'any' ? 'Any of: ' : 'All of: ') : '') + items.slice(0, 3).join('; ') + (items.length > 3 ? `; (+${items.length - 3} more)` : '');
}
const shortHtml = (h) => h.replace(/(src|href|srcset)="data:([a-z/+.-]+)[^"]*"/g, '$1="data:$2,…"').replace(/`/g, "'").replace(/\s+/g, ' ');

function markdown(report, sum) {
  const recipes = path.join(SCRIPT_DIR, '..', 'references', 'fix-recipes.md');
  const stack = report.stack || [];
  const L = [];
  L.push(`# Accessibility audit`, '');
  L.push(`- **Date:** ${report.date}`, `- **Engine:** axe-core ${report.axeVersion} + Knack keyboard pass (focus order, traps, visible focus, focus removed/obscured, hover-only menus, change-on-input, dialog Escape)`, `- **Tags:** ${report.options.tags.join(', ')}`, `- **Viewport:** ${report.options.viewport}${report.options.mobile ? ' (mobile)' : ''}`);
  L.push(`- **Pages:** ${report.pages.map((p) => `${p.url}${p.state ? ` (after clicking \`${p.state}\`)` : ''}`).join(', ')}`);
  if (stack.length) L.push(`- **Detected stack:** ${stack.map((k) => STACK_NAMES[k] || k).join(', ')} (fix notes below are tailored to it)`);
  L.push('');
  L.push(`| Impact | Rules | Elements |`, `|---|---|---|`);
  for (const k of IMPACTS) L.push(`| ${k} | ${sum.rules.filter((r) => r.impact === k).length} | ${sum.rules.filter((r) => r.impact === k).reduce((n, r) => n + r.nodes.length, 0)} |`);
  L.push('');
  const blocking = sum.byImpact.critical + sum.byImpact.serious;
  const honesty = 'Automated checks find only part of the real barriers (in GDS\'s 142-barrier test the best tool found 40%, axe 29%; Deque measures 57% by issue volume). Finish with references/manual-checks.md.';
  L.push(blocking ? `**${blocking} critical/serious rule(s) to fix.** ${honesty}` : `**No critical or serious issues found.** ${honesty}`, '');
  const warnings = [];
  for (const p of report.pages) {
    if (p.axe.iframesSkipped) warnings.push(`${p.slug}: axe timed out on iframes; iframe content was not audited.`);
    if (p.axe.framesMissed) warnings.push(`${p.slug}: ${p.axe.framesMissed} iframe(s) could not be injected (sandboxed or still loading), so their content was not audited by axe.`);
    if (p.keyboard && !p.keyboard.completedCycle && !p.keyboard.trap) warnings.push(`${p.slug}: the Tab cycle did not complete (raise --max-tabs?), so later elements were not checked.`);
    if (p.pageErrors?.length) warnings.push(`${p.slug}: ${p.pageErrors.length} JavaScript error(s) during load, e.g. "${p.pageErrors[0].slice(0, 100)}".`);
  }
  if (warnings.length) L.push('**Coverage warnings:**', '', ...warnings.map((w) => `- ${w}`), '');
  if (sum.rules.length) {
    L.push('## Fix first', '', 'Highest impact first, then by how many elements one fix touches (fix the shared component or token once).', '');
    sum.rules.slice(0, 8).forEach((r, i) => L.push(`${i + 1}. \`${r.id}\` (${r.impact}, ${r.nodes.length} element${r.nodes.length === 1 ? '' : 's'}${report.pages.length > 1 ? `, ${r.pages.size} page${r.pages.size === 1 ? '' : 's'}` : ''}): ${r.help}`));
    L.push('');
  }
  for (const p of report.pages) {
    L.push(`Annotated screenshot (${p.slug}): \`${p.screenshot}\``);
    if (p.screenshotParts) L.push(`  Readable slices: ${p.screenshotParts.map((t) => `\`${path.basename(t.file)}\` (y ${t.y[0]}–${t.y[1]}${t.issues ? `, ${t.issues} marked` : ''})`).join(', ')}`);
  }
  L.push('');
  for (const k of IMPACTS) {
    const rs = sum.rules.filter((r) => r.impact === k);
    if (!rs.length) continue;
    L.push(`## ${k[0].toUpperCase() + k.slice(1)} (${rs.length})`, '');
    for (const r of rs) {
      L.push(`### \`${r.id}\`: ${r.help}`, '');
      const meta = [`${r.nodes.length} element(s)`, { keyboard: 'keyboard pass', knack: 'Knack check', axe: 'axe-core' }[r.source] || r.source];
      if (r.wcag?.length) meta.push('WCAG ' + r.wcag.map(scLabel).join(', '));
      if (report.pages.length > 1) meta.push('pages: ' + [...r.pages].join(', '));
      L.push(meta.join(' · '), '');
      L.push(`**How to fix:** ${FIX[r.id] || 'See the rule documentation.'}${r.helpUrl ? ` ([rule docs](${r.helpUrl}))` : ''}`);
      const notes = stack.map((fw) => STACK_FIX[r.id]?.[fw] && `**${STACK_NAMES[fw]}:** ${STACK_FIX[r.id][fw]}`).filter(Boolean);
      if (notes.length) L.push('', ...notes.map((n) => `- ${n}`));
      L.push('', `Recipe: \`${recipes}#${r.id}\``, '');
      // Group identical markup (same snippet + same reason): one fix in a shared component usually covers all.
      const groups = new Map();
      for (const n of r.nodes) {
        const why = n.detail || tidySummary(n.failureSummary);
        const key = (n.html || '').replace(/\s+/g, ' ') + '|' + why.replace(/\d+(\.\d+)?/g, '#');
        if (!groups.has(key)) groups.set(key, { n, why, sels: [], pages: new Set() });
        const g = groups.get(key); g.sels.push((n.target || [n.selector]).join(' ')); g.pages.add(n.page);
      }
      const list = [...groups.values()];
      for (const g of list.slice(0, 8)) {
        const n = g.n;
        L.push(`- \`${g.sels[0]}\`${g.sels.length > 1 ? ` **and ${g.sels.length - 1} more with identical markup**` : ''}${report.pages.length > 1 ? ` (${[...g.pages].join(', ')})` : ''}`);
        if (n.html) L.push(`  - \`${shortHtml(n.html)}\``);
        if (g.why) L.push(`  - ${g.why.slice(0, 300)}`);
        if (n.data && n.data.fgColor) L.push(`  - contrast ${n.data.contrastRatio}:1 (needs ${n.data.expectedContrastRatio}), fg ${n.data.fgColor} on bg ${n.data.bgColor}, ${n.data.fontSize} ${n.data.fontWeight}. Nearest passing color: \`node ${path.join(SCRIPT_DIR, 'contrast.mjs')} "${n.data.fgColor}" "${n.data.bgColor}"${n.data.expectedContrastRatio && String(n.data.expectedContrastRatio).startsWith('3') ? ' --large' : ''}\``);
        const hint = searchHint(n.html);
        if (hint) L.push(`  - find in source: \`rg -n -F ${JSON.stringify(hint)}\``);
      }
      if (list.length > 8) L.push(`- …and ${list.length - 8} more distinct element(s) (see report.json)`);
      L.push('');
    }
  }
  const review = new Map();
  for (const p of report.pages) for (const i of p.axe.incomplete) {
    const r = review.get(i.id) || { ...i, count: 0, examples: [] };
    r.count += i.count;
    for (const n of i.nodes || []) if (r.examples.length < 3) r.examples.push(n.target.join(' '));
    review.set(i.id, r);
  }
  if (review.size) {
    L.push('## Needs human review (axe "incomplete")', '', 'axe could not decide these automatically (e.g. text over images/gradients). Check each one by eye.', '');
    for (const r of review.values()) L.push(`- \`${r.id}\` (${r.count}): ${r.help}${r.examples.length ? `, e.g. ${r.examples.map((e) => `\`${e}\``).join(', ')}` : ''}`);
    L.push('');
  }
  for (const p of report.pages) {
    if (!p.keyboard) continue;
    const k = p.keyboard;
    L.push(`## Keyboard: ${p.slug}${p.state ? ` (state: \`${p.state}\`)` : ''}`, '');
    const dlg = k.dialog ? ` Modal \`${k.dialog.dialog}\`: Escape ${k.dialog.closed ? 'closes it' : '**does not close it**'}${k.dialog.closed ? `, focus ${k.dialog.returned ? 'returns to the trigger' : `**goes to ${k.dialog.focusAfter || 'the body'}**`}` : ''}.` : '';
    L.push(`${k.focusOrder.length} focus stops reached of ~${k.expectedTabbable} tabbable elements${p.state ? ' (Tab started from wherever the click left focus, so earlier elements are not revisited)' : ''}. ${k.trap ? (k.trap.intended ? 'Focus is contained in an open modal (intended).' : '**Focus trap detected.**') : k.completedCycle ? 'Tab cycle completed.' : 'Tab cycle did not complete.'}${dlg}`, '');
    if (k.focusOrder.length > FOCUS_CHECK_LIMIT) L.push(`Visible focus was checked for the first ${FOCUS_CHECK_LIMIT} stops only.`, '');
    L.push('| # | Element | Name | Visible focus |', '|---|---|---|---|');
    const status = (s) => (s.removedOnFocus ? '**removed by script**' : !s.visible ? 'hidden element' : s.focusVisible === false ? '**no**' : s.focusVisible ? `yes${s.focus?.via ? ` (via ${s.focus.via})` : ''}` : s.tag === 'iframe' || s.framed ? 'not measured (iframe)' : '?') + (s.obscuredBy ? ` · **covered by \`${s.obscuredBy.replace(/\|/g, '\\|')}\`**` : '');
    for (const s of k.focusOrder.slice(0, 60)) L.push(`| ${s.n} | \`${s.selector.replace(/\|/g, '\\|')}\` | ${(s.name || '').replace(/\|/g, '\\|').slice(0, 40) || '_(none)_'} | ${status(s)} |`);
    if (k.focusOrder.length > 60) L.push(`| … | ${k.focusOrder.length - 60} more | | |`);
    L.push('');
  }
  L.push('## Still needs a human', '', '- Is each alt text *meaningful* (not just present)? Is reading order logical? Are error messages helpful?', '- Shift+Tab backwards (sticky headers can hide focus that way; this run tabbed forwards only), screen reader smoke test (VoiceOver / NVDA), 200%/400% zoom reflow, reduced motion, captions. See references/manual-checks.md.');
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------- main
const chromium = await loadPlaywright();
const src = axeSource();
fs.mkdirSync(outDir, { recursive: true });
const browser = await launch(chromium);
const pages = [];
try {
  const diffCtx = await browser.newContext({ deviceScaleFactor: mobile ? 2 : 1 });
  const diffPage = await diffCtx.newPage();
  for (const [i, url] of targets.entries()) {
    const slug = slugOf(url, i);
    log(`Auditing ${url} (${vw}×${vh}${mobile ? ' mobile' : ''})`);
    const rep = await auditOne(browser, diffPage, src, url, slug);
    pages.push(rep);
    printPage(rep);
    for (const [si, st] of opts.state.entries()) {
      log(`  state ${si + 1}: click ${st}`);
      const r = await auditOne(browser, diffPage, src, url, `${slug}--state-${si + 1}`, st);
      if (r) { pages.push(r); printPage(r); }
    }
  }
  await diffCtx.close();
} finally {
  await browser.close();
}

function printPage(p) {
  const count = (k) => p.issues.filter((i) => i.impact === k).length;
  log(`  axe-core ${p.axe.version}: ${p.axe.violations.length} rule violation(s), ${p.axe.incomplete.length} need review`);
  if (p.keyboard) {
    const k = p.keyboard;
    const nv = k.focusOrder.filter((s) => s.focusVisible === false).length;
    const unreach = p.issues.find((i) => i.id === 'kbd-unreachable')?.nodes.length || 0;
    log(`  keyboard: ${k.focusOrder.length} focus stops${k.trap ? (k.trap.intended ? ', contained in modal' : `, TRAP at ${k.trap.at}`) : ''}; ${nv} without visible focus; ${unreach} clickable-but-unreachable`);
  }
  log(`  issues by impact: ${IMPACTS.map((k) => `${count(k)} ${k}`).join(' · ')}`);
  if (p.pageErrors.length) warn(`  ${p.pageErrors.length} page error(s): ${p.pageErrors[0].slice(0, 120)}`);
}

const report = {
  tool: 'knack/a11y-audit',
  date: new Date().toISOString(),
  axeVersion: pages[0]?.axe.version,
  options: { tags, viewport: `${vw}x${vh}`, mobile, states: opts.state, exclude: opts.exclude },
  stack: [...new Set(pages.flatMap((p) => p.stack || []))],
  summary: null,
  pages,
};
const sum = summarize(pages);
report.summary = { issuesByImpact: sum.byImpact, rules: sum.rules.map((r) => ({ id: r.id, impact: r.impact, source: r.source, elements: r.nodes.length, wcag: r.wcag })) };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report, sum));

if (JSON_MODE) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
const bi = sum.byImpact;
log(`Rules failing: ${bi.critical} critical · ${bi.serious} serious · ${bi.moderate} moderate · ${bi.minor} minor`);
log(`Report → ${path.join(outDir, 'report.md')}`);
log(`JSON   → ${path.join(outDir, 'report.json')}`);
for (const p of pages) log(`Image  → ${p.screenshot}${p.screenshotParts ? ` (+ ${p.screenshotParts.length} readable slices: ${path.basename(p.screenshotParts[0].file).replace(/part1/, 'partN')})` : ''}`);
if (failOn) {
  const hit = IMPACTS.slice(0, IMPACTS.indexOf(failOn) + 1).some((k) => bi[k] > 0);
  if (hit) { console.error(`${c(31, '✖')} Found issues at or above "${failOn}".`); process.exitCode = 2; }
}
