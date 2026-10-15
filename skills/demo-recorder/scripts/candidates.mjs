// In-page helper (serialised into the browser by page.evaluate): lists visible
// interactive elements with a robust suggested selector. With `query`, ranks
// them by similarity so a failed step can say "did you mean ...".
export function candidatesInPage({ query = '', limit = 60 } = {}) {
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[data-testid],[onclick]';
  const q = String(query)
    .replace(/^(text|css|xpath|id|data-testid)=/i, '')
    .replace(/^role=\w+\[name=(["'])(.*)\1\]$/i, '$2')
    .replace(/^["'#.]|["']$/g, '')
    .replace(/[-_]/g, ' ')
    .toLowerCase().trim();
  const qTokens = q.split(/\s+/).filter(Boolean);
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight * 3) return false;
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !hiddenByAncestorOpacity(el);
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  };
  const hiddenByAncestorOpacity = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (+getComputedStyle(n).opacity < 0.05) return true;
    return false;
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'range') return 'slider';
      return ty === 'search' ? 'searchbox' : 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return t;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    const byId = lb && lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' ');
    const forLabel = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText;
    return clean(el.getAttribute('aria-label') || byId || forLabel || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' ? el.innerText : '') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (el.type === 'submit' || el.type === 'button' ? el.value : '')).slice(0, 80);
  };
  const unique = (css) => { try { return document.querySelectorAll(css).length === 1; } catch { return false; } };
  const q2 = (s) => JSON.stringify(s);
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      if (n.id && /^[a-z][\w-]*$/i.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };
  const selectorFor = (el, role, name) => {
    for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(a);
      if (v && unique(`[${a}=${q2(v)}]`)) return `[${a}=${q2(v)}]`;
    }
    if (el.id && /^[a-z][\w-]{1,40}$/i.test(el.id) && !/\d{3,}|^(radix|headlessui|react|mui|:r)/i.test(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const ph = el.getAttribute('placeholder');
    if (ph && unique(`[placeholder=${q2(ph)}]`)) return `[placeholder=${q2(ph)}]`;
    if (name && name.length <= 80 && ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'textbox', 'combobox', 'searchbox'].includes(role)) return `role=${role}[name=${q2(name)}]`;
    // Plain elements: match on their own (direct) text, which is stabler than the
    // full innerText (counters and badges change while the demo runs).
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => clean(n.textContent).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).sort((a, b) => b.length - a.length)[0];
    if (own && own.length <= 40) {
      const lc = own.toLowerCase();
      const hits = [...document.body.querySelectorAll('*')].filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.toLowerCase().includes(lc))).length;
      if (hits === 1) return `text=${own}`;
      const cls = [...el.classList].find((c) => /^[a-z][\w-]*$/i.test(c));
      if (cls) {
        const css = `${el.tagName.toLowerCase()}.${cls}`;
        if ([...document.querySelectorAll(css)].filter((n) => n.innerText.toLowerCase().includes(lc)).length === 1) return `${css}:has-text(${q2(own)})`;
      }
    }
    if (name && name.length <= 40 && !name.includes('"')) return `text=${q2(name)}`;
    return cssPath(el);
  };
  const seen = new Set();
  const out = [];
  // Also pick up plain elements styled as clickable (cursor:pointer), outermost only.
  const pool = new Set(document.querySelectorAll(SEL));
  let scanned = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (++scanned > 6000) break;
    if (pool.has(el) || getComputedStyle(el).cursor !== 'pointer') continue;
    const p = el.parentElement;
    if (p && getComputedStyle(p).cursor === 'pointer') continue;
    if (el.closest(SEL)) continue;
    pool.add(el);
  }
  for (const el of pool) {
    if (el.closest('knack-overlay') || !vis(el)) continue;
    // Skip wrappers whose only purpose is an inner control we also list.
    if (el.tagName === 'LABEL' && el.control && vis(el.control)) continue;
    const role = roleOf(el), name = nameOf(el);
    const selector = selectorFor(el, role, name);
    if (seen.has(selector)) continue;
    seen.add(selector);
    const r = el.getBoundingClientRect();
    let score = 0;
    if (q) {
      const hay = (name + ' ' + selector + ' ' + (el.id || '') + ' ' + (el.className?.baseVal ?? el.className ?? '')).toLowerCase().replace(/[-_]/g, ' ');
      if (name.toLowerCase() === q) score += 5;
      if (hay.includes(q)) score += 3;
      score += qTokens.filter((t) => hay.includes(t)).length / Math.max(1, qTokens.length) * 2;
      if (score <= 0) continue;
    }
    out.push({ selector, role, name, score, box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, inView: r.top >= 0 && r.bottom <= innerHeight });
  }
  if (q) out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
