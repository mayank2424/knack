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
 * Output (default ./.knack/a11y-audit/): report.md, report.json, <page>.annotated.png
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
 *   --max-height px      Crop annotated screenshot height (default 6000)
 *   --help               Show this help
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
  'placeholder-label': 'Placeholder text disappears on input and is often low contrast. Add a visible <label for> (keep the placeholder only as an example value).',
};

const KBD_RULES = {
  'kbd-focus-trap': { impact: 'critical', help: 'Keyboard focus is trapped', wcag: ['2.1.2'] },
  'kbd-unreachable': { impact: 'serious', help: 'Clickable element cannot be reached with the keyboard', wcag: ['2.1.1'] },
  'kbd-focus-not-visible': { impact: 'serious', help: 'Focused element shows no visible focus indicator', wcag: ['2.4.7'] },
  'kbd-focus-hidden': { impact: 'serious', help: 'Keyboard focus lands on an invisible element', wcag: ['2.4.7', '2.4.3'] },
  'kbd-focus-order': { impact: 'moderate', help: 'Focus order jumps backwards visually (review)', wcag: ['2.4.3'] },
  'kbd-positive-tabindex': { impact: 'serious', help: 'Element uses a positive tabindex', wcag: ['2.4.3'] },
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
    const h = el.outerHTML.replace(/ data-knack-id="\d+"/g, '');
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
  const tabbable = (el) => {
    if (!el.matches(FOCUSABLE) || el.disabled || el.closest('[inert]')) return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti < 0) return false;
    if (el.localName === 'summary' && el.parentElement?.localName !== 'details') return false;
    return visible(el);
  };
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
  window.__knack = { FOCUSABLE, idOf, selectorOf, nameOf, snippet, visible, tabbable, inModal, deepActive, byId, docRect, focusStyle };
};

const FOCUS_CHECK_LIMIT = 200; // visible-focus screenshots are the slow part; cap per page

// Kill transitions/animations/caret so before/after focus screenshots are deterministic.
const FREEZE_CSS = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;caret-color:transparent!important;scroll-behavior:auto!important}';

// ------------------------------------------------------------ axe pass
async function runAxe(page, src) {
  for (const frame of page.frames()) {
    try { await frame.evaluate(src); } catch (_) {}
  }
  const ok = await page.evaluate(() => typeof window.axe?.run === 'function');
  if (!ok) throw new Error('axe-core could not be injected into the page (CSP or sandboxed frame?).');
  return page.evaluate(async ({ tags, exclude }) => {
    const ctx = exclude.length ? { include: [document], exclude: exclude.map((s) => [s]) } : document;
    const r = await window.axe.run(ctx, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations', 'incomplete'], iframes: true });
    const node = (n) => ({
      target: n.target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)),
      html: n.html.length > 300 ? n.html.slice(0, 297) + '…' : n.html,
      failureSummary: n.failureSummary || '',
      data: n.any?.find((x) => x.data && typeof x.data === 'object')?.data || null,
    });
    return {
      version: window.axe.version,
      violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, description: v.description, helpUrl: v.helpUrl, tags: v.tags, nodes: v.nodes.map(node) })),
      incomplete: r.incomplete.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length, nodes: v.nodes.slice(0, 5).map(node) })),
      passes: r.passes?.length || 0,
    };
  }, { tags, exclude: opts.exclude });
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

  const unreachable = await scanClickables(page);

  // Tab loop
  if (!fromCurrent) await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const seq = [], seen = new Map();
  let completed = false, trap = null, iframeRepeats = 0, bodyHits = 0;
  const limit = Math.min(maxTabs, expected.count * 2 + 25);
  const readActive = () => page.evaluate(() => {
      const K = window.__knack;
      const el = K.deepActive();
      if (!el || el === document.body || el === document.documentElement) return { body: true };
      return { id: K.idOf(el), tag: el.localName, role: el.getAttribute('role') || '', name: K.nameOf(el), selector: K.selectorOf(el), html: K.snippet(el), visible: K.visible(el), modal: K.inModal(el), tabindex: el.getAttribute('tabindex') };
  });
  if (fromCurrent) {
    // States: start from wherever the app put focus (e.g. inside a just-opened dialog).
    const start = await readActive();
    if (!start.body) { seen.set(start.id, 0); seq.push(start); }
  }
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const a = await readActive();
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
  const focusStops = [];
  for (const [n, s] of seq.entries()) {
    const stop = { n: n + 1, id: s.id, selector: s.selector, tag: s.tag, role: s.role, name: s.name, html: s.html, visible: s.visible };
    focusStops.push(stop);
    if (!s.visible || n >= FOCUS_CHECK_LIMIT) continue;
    let r = await diffFocus(page, diffPage, s.id, 0);
    if (!r) continue;
    let via = null;
    if (!r.visible && r.ancestorChanged > 0) {
      const r2 = await diffFocus(page, diffPage, s.id, r.ancestorChanged);
      if (r2 && r2.visible) { r = { ...r2, changed: r.changed }; via = `ancestor ${r.ancestorChanged} level(s) up`; }
    }
    stop.focus = { changedPixels: r.d.changed, ratio: +(r.d.changed / r.d.total).toFixed(4), maxDelta: r.d.maxDelta, changed: r.changed, ...(via ? { via } : {}) };
    stop.focusVisible = r.visible;
  }

  add('kbd-focus-not-visible', focusStops.filter((s) => s.focusVisible === false).map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: `No visible change when focused (${s.focus.changed.length ? 'computed changes: ' + s.focus.changed.join(', ') + ', but no visible pixels' : 'no style change at all'}).` })));
  add('kbd-focus-hidden', focusStops.filter((s) => !s.visible).map((s) => ({ id: s.id, selector: s.selector, html: s.html, detail: 'Receives focus while invisible, off-screen, or zero-size.' })));
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
  issues.forEach((i) => i.nodes.forEach((n) => { if (n.id) n.rect = rects[n.id]; }));

  // Backwards visual jumps (heuristic): next stop is well above and not to the right of the previous one.
  const jumps = [];
  for (let i = 1; i < focusStops.length; i++) {
    const p = focusStops[i - 1].rect, q = focusStops[i].rect;
    if (!p || !q || !focusStops[i].visible || !focusStops[i - 1].visible) continue;
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

// Screenshot a region unfocused vs focused. level 0 = the element, N = its Nth ancestor's box.
const STYLE_KEYS = ['outline-style', 'outline-width', 'outline-color', 'outline-offset', 'box-shadow', 'border-top-color', 'border-bottom-color', 'border-bottom-width', 'background-color', 'color', 'text-decoration'];
async function diffFocus(page, diffPage, id, level) {
  const box = await page.evaluate(({ id, level }) => {
    const el = window.__knack.byId(id);
    if (!el) return null;
    document.activeElement?.blur?.();
    el.scrollIntoView({ block: 'center', inline: 'center' });
    let t = el;
    for (let i = 0; i < level && t.parentElement; i++) t = t.parentElement;
    const r = t.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, before: window.__knack.focusStyle(el) };
  }, { id, level });
  if (!box || box.w < 1 || box.h < 1) return null;
  const pad = 8;
  const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
  const clip = { x, y, width: Math.min(vw - x, Math.ceil(box.w + pad * 2)), height: Math.min(vh - y, Math.ceil(box.h + pad * 2)) };
  if (clip.width < 2 || clip.height < 2) return null;
  const before = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const after = await page.evaluate((id) => { const el = window.__knack.byId(id); el.focus({ focusVisible: true }); return window.__knack.focusStyle(el); }, id);
  const focused = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const d = await diffPage.evaluate(pixelDiff, { a: before.toString('base64'), b: focused.toString('base64') });
  const sa = box.before.self.split('|'), sb = after.self.split('|');
  const changed = STYLE_KEYS.filter((_, i) => sa[i] !== sb[i]);
  const ancestorChanged = box.before.ancestors.findIndex((sig, i) => sig !== after.ancestors[i]) + 1;
  if (ancestorChanged) changed.push(`ancestor ${ancestorChanged} up`);
  // Visible = enough pixels changed: at least 8 px and 0.3% of the region.
  return { d, changed, ancestorChanged, visible: d.changed >= Math.max(8, d.total * 0.003) };
}

// Runs inside a blank helper page: decode two PNGs on canvas, count changed pixels.
async function pixelDiff({ a, b }) {
  const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + s; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
  const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, w, h).data;
  cx.clearRect(0, 0, w, h); cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, w, h).data;
  let changed = 0, maxDelta = 0;
  for (let i = 0; i < da.length; i += 4) {
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
  const shot = await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: W, height: H }, animations: 'disabled', caret: 'hide' });
  const counts = Object.fromEntries(IMPACTS.map((k) => [k, 0]));
  for (const v of pageReport.issues) counts[v.impact] = (counts[v.impact] || 0) + 1;
  const stops = (pageReport.keyboard?.focusOrder || []).filter((s) => s.rect && s.visible);
  const COLORS = { critical: '#e5132b', serious: '#ff5a1f', moderate: '#f59e0b', minor: '#ca8a04' };
  // "No visible focus" is shown by the magenta focus badge; keep its box but skip the label to cut clutter.
  const labelled = dedupeLabels(boxes.filter((b) => b.rule !== 'kbd-focus-not-visible'));
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
      ${chip('dashed = keyboard pass', '')}
      ${pageLevel.length ? `<span style="flex-basis:100%;color:#fca5a5;font-weight:500">Page-level: ${pageLevel.map(esc).join(' · ')}</span>` : ''}
    </div>
    <div style="position:relative;width:${W}px;height:${H}px;overflow:hidden">
      <img src="data:image/png;base64,${shot.toString('base64')}" style="position:absolute;inset:0;width:${W}px;height:${H}px">
      ${boxes.map(box).join('')}
      ${labelled.map((b) => `<div style="position:absolute;left:${b.rect.x + b.rect.w + 2}px;top:${Math.max(0, b.rect.y - 17)}px;transform:translateX(-100%);background:${COLORS[b.impact] || COLORS.critical};color:#fff;font-size:10px;padding:2px 5px;border-radius:3px;white-space:nowrap">${esc(b.rule)}</div>`).join('')}
      ${stops.map((s) => `<div style="position:absolute;left:${s.rect.x - 10}px;top:${s.rect.y - 10}px;min-width:20px;height:20px;padding:0 4px;box-sizing:border-box;border-radius:10px;background:${s.focusVisible === false ? '#c026d3' : '#2563eb'};color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;box-shadow:0 0 0 2px #fff,0 1px 4px #0006">${s.n}</div>`).join('')}
    </div></body></html>`);
  await diffPage.waitForFunction(() => [...document.images].every((i) => i.complete));
  const total = await diffPage.evaluate(() => document.body.scrollHeight);
  await diffPage.setViewportSize({ width: W, height: total });
  await diffPage.screenshot({ path: file, fullPage: true });
}
function dedupeLabels(boxes) {
  const seen = new Set();
  return boxes.filter((b) => { const k = `${b.rect.x},${b.rect.y},${b.rule}`; if (seen.has(k)) return false; seen.add(k); return true; });
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
    try { await page.click(state, { timeout: 5000 }); }
    catch (e) { await ctx.close(); warn(`State "${state}": could not click (${e.message.split('\n')[0]}); skipped.`); return null; }
    await page.waitForTimeout(Math.max(400, settle));
    await page.evaluate(PAGE_HELPERS);
  }
  const title = await page.title();
  const axe = await runAxe(page, src);
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
  const keyboardInfo = kb && { focusOrder: kb.focusOrder, expectedTabbable: kb.expectedTabbable, completedCycle: kb.completedCycle, trap: kb.trap };
  const report = { url, slug, title, state: state || null, axe, keyboard: keyboardInfo, issues, pageErrors: errors };
  const png = path.join(outDir, `${slug}.annotated.png`);
  await annotate(page, diffPage, report, png);
  report.screenshot = png;
  await ctx.close();
  return report;
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

function markdown(report, sum) {
  const recipes = path.join(SCRIPT_DIR, '..', 'references', 'fix-recipes.md');
  const L = [];
  L.push(`# Accessibility audit`, '');
  L.push(`- **Date:** ${report.date}`, `- **Engine:** axe-core ${report.axeVersion} + Knack keyboard pass`, `- **Tags:** ${report.options.tags.join(', ')}`, `- **Viewport:** ${report.options.viewport}${report.options.mobile ? ' (mobile)' : ''}`);
  L.push(`- **Pages:** ${report.pages.map((p) => `${p.url}${p.state ? ` (after clicking \`${p.state}\`)` : ''}`).join(', ')}`, '');
  L.push(`| Impact | Rules | Elements |`, `|---|---|---|`);
  for (const k of IMPACTS) L.push(`| ${k} | ${sum.rules.filter((r) => r.impact === k).length} | ${sum.rules.filter((r) => r.impact === k).reduce((n, r) => n + r.nodes.length, 0)} |`);
  L.push('');
  const blocking = sum.byImpact.critical + sum.byImpact.serious;
  L.push(blocking ? `**${blocking} critical/serious rule(s) to fix.** Automated checks catch roughly 30–50% of real issues; finish with references/manual-checks.md.` : '**No critical or serious issues found.** Automated checks catch roughly 30–50% of real issues; finish with references/manual-checks.md.', '');
  for (const p of report.pages) L.push(`Annotated screenshot (${p.slug}): \`${p.screenshot}\``);
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
      L.push(`**How to fix:** ${FIX[r.id] || 'See the rule documentation.'}${r.helpUrl ? ` ([rule docs](${r.helpUrl}))` : ''} Recipe: \`${recipes}#${r.id}\``, '');
      for (const n of r.nodes.slice(0, 8)) {
        const sel = (n.target || [n.selector]).join(' ');
        L.push(`- \`${sel}\`${report.pages.length > 1 ? ` (${n.page})` : ''}`);
        if (n.html) L.push(`  - \`${n.html.replace(/`/g, "'").replace(/\s+/g, ' ')}\``);
        const why = n.detail || (n.failureSummary || '').replace(/\n\s*/g, ' ').replace(/^Fix (any|all) of the following: /, '');
        if (why) L.push(`  - ${why.slice(0, 300)}`);
        if (n.data && n.data.fgColor) L.push(`  - contrast ${n.data.contrastRatio}:1 (needs ${n.data.expectedContrastRatio}), fg ${n.data.fgColor} on bg ${n.data.bgColor}, ${n.data.fontSize} ${n.data.fontWeight}. Try: \`node ${path.join(SCRIPT_DIR, 'contrast.mjs')} "${n.data.fgColor}" "${n.data.bgColor}"\``);
      }
      if (r.nodes.length > 8) L.push(`- …and ${r.nodes.length - 8} more (see report.json)`);
      L.push('');
    }
  }
  const review = new Map();
  for (const p of report.pages) for (const i of p.axe.incomplete) { const r = review.get(i.id) || { ...i, count: 0 }; r.count += i.count; review.set(i.id, r); }
  if (review.size) {
    L.push('## Needs human review (axe "incomplete")', '', 'axe could not decide these automatically (e.g. text over images/gradients). Check each one by eye.', '');
    for (const r of review.values()) L.push(`- \`${r.id}\` (${r.count}): ${r.help}`);
    L.push('');
  }
  for (const p of report.pages) {
    if (!p.keyboard) continue;
    const k = p.keyboard;
    L.push(`## Keyboard: ${p.slug}${p.state ? ` (state: \`${p.state}\`)` : ''}`, '');
    L.push(`${k.focusOrder.length} focus stops reached of ~${k.expectedTabbable} tabbable elements. ${k.trap ? (k.trap.intended ? 'Focus is contained in an open modal (intended?).' : '**Focus trap detected.**') : k.completedCycle ? 'Tab cycle completed.' : 'Tab cycle did not complete.'}`, '');
    if (k.focusOrder.length > FOCUS_CHECK_LIMIT) L.push(`Visible focus was checked for the first ${FOCUS_CHECK_LIMIT} stops only.`, '');
    L.push('| # | Element | Name | Visible focus |', '|---|---|---|---|');
    for (const s of k.focusOrder.slice(0, 60)) L.push(`| ${s.n} | \`${s.selector.replace(/\|/g, '\\|')}\` | ${(s.name || '').replace(/\|/g, '\\|').slice(0, 40) || '_(none)_'} | ${!s.visible ? 'hidden element' : s.focusVisible === false ? '**no**' : s.focusVisible ? 'yes' : '?'} |`);
    if (k.focusOrder.length > 60) L.push(`| … | ${k.focusOrder.length - 60} more | | |`);
    L.push('');
  }
  L.push('## Still needs a human', '', '- Is each alt text *meaningful* (not just present)? Is reading order logical?', '- Screen reader smoke test (VoiceOver / NVDA), 200%/400% zoom reflow, reduced motion, captions. See references/manual-checks.md.');
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
for (const p of pages) log(`Image  → ${p.screenshot}`);
if (failOn) {
  const hit = IMPACTS.slice(0, IMPACTS.indexOf(failOn) + 1).some((k) => bi[k] > 0);
  if (hit) { console.error(`${c(31, '✖')} Found issues at or above "${failOn}".`); process.exitCode = 2; }
}
