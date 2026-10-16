// Injected into the recorded page. Draws the synthetic cursor, click ripples,
// highlight ring, caption and keystroke HUD inside a closed shadow root that
// ignores pointer events. The cursor, ripples and highlight belong to the page
// and zoom with it; the caption and HUD sit in a screen-space layer (.scr) that
// cancels the camera, so a zoom never enlarges or crops them. record.mjs
// computes every value per frame and calls window.__knack.render(state), so
// nothing here depends on timers: output is deterministic.
(() => {
  if (window.__knack) return;
  const ARROW = `<svg viewBox="0 0 28 28" width="28" height="28"><path d="M6 3.5v18.2l4.6-4.3 2.9 6.6 3.3-1.4-2.9-6.5h6.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const HAND = `<svg viewBox="0 0 28 28" width="28" height="28"><path d="M10.6 4.2c0-1 .8-1.7 1.7-1.7s1.7.8 1.7 1.7v6.4l.6-.1V9.6c0-.9.8-1.6 1.6-1.6.9 0 1.6.7 1.6 1.6v1.3l.5.1v-.6c0-.9.7-1.6 1.6-1.6s1.6.7 1.6 1.6v1.2l.4.1c0-.8.7-1.4 1.5-1.4s1.5.7 1.5 1.5v5.4c0 4.3-2.8 7.3-7 7.3h-2.2c-2.3 0-3.9-.9-5.2-2.7L5 16.2c-.6-.8-.4-1.8.4-2.3.7-.5 1.7-.3 2.3.4l2.9 3.2z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/><path d="M14 12.2v4.6M17.2 12.6v4.2M20.4 13.1v3.7" stroke="#111" stroke-width="1.1" stroke-linecap="round"/></svg>`;
  const IBEAM = `<svg viewBox="0 0 28 28" width="28" height="28"><path d="M10 4.5h2.2c.9 0 1.5.4 1.8 1 .3-.6.9-1 1.8-1H18M10 23.5h2.2c.9 0 1.5-.4 1.8-1 .3.6.9 1 1.8 1H18M14 5.5v17M11.8 14h4.4" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M10 4.5h2.2c.9 0 1.5.4 1.8 1 .3-.6.9-1 1.8-1H18M10 23.5h2.2c.9 0 1.5-.4 1.8-1 .3.6.9 1 1.8 1H18M14 5.5v17M11.8 14h4.4" fill="none" stroke="#111" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  // Hotspots (px inside the 28px box) so the tip, not the box corner, sits on the target.
  const HOT = { arrow: [6, 3.5], hand: [12.3, 2.6], ibeam: [14, 14] };
  const SVG = { arrow: ARROW, hand: HAND, ibeam: IBEAM };
  const GHOSTS = 23; // extra motion-blur samples (record.mjs sends up to 23 trail points)
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .cg { position: fixed; left: 0; top: 0; overflow: visible; filter: drop-shadow(0 1.5px 2.5px rgba(0,0,0,.35)); }
    .cur { position: absolute; left: 0; top: 0; width: 28px; height: 28px; will-change: transform; transform-origin: 6px 4px; }
    .cur > div { position: absolute; inset: 0; display: none; }
    .ghost { position: absolute; left: 0; top: 0; width: 28px; height: 28px; display: none; }
    .rip { position: fixed; left: 0; top: 0; width: 0; height: 0; }
    .rip i { position: absolute; border-radius: 50%; transform: translate(-50%,-50%); }
    .hl { position: fixed; display: none; border-radius: 10px; transition: none; }
    .scr { position: absolute; left: 0; top: 0; width: 100%; height: 100%; transform-origin: 0 0; }
    .cap, .keys { position: absolute; left: 50%; transform: translateX(-50%); display: none; white-space: nowrap;
      font: 600 22px/1.25 ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", Inter, Roboto, sans-serif;
      letter-spacing: -.01em; color: #fff; background: rgba(17,17,22,.82); padding: 12px 20px; border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.08);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
    .keys { padding: 10px 14px; display: none; gap: 6px; }
    .keys b { display: inline-block; min-width: 38px; text-align: center; padding: 6px 10px; border-radius: 9px;
      background: rgba(255,255,255,.12); box-shadow: inset 0 -2px 0 rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.14);
      font: 600 20px/1.2 ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", sans-serif; }
  `;
  let host, els;

  function ensure() {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement('knack-overlay');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;margin:0!important;padding:0!important;border:0!important;background:none!important;transform:none!important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style><div class="hl"></div><div class="rip"></div><div class="scr"><div class="cap"></div><div class="keys"></div></div>
      <div class="cg">${'<div class="ghost"></div>'.repeat(GHOSTS)}
      <div class="cur"><div data-k="arrow">${ARROW}</div><div data-k="hand">${HAND}</div><div data-k="ibeam">${IBEAM}</div></div></div>`;
    document.documentElement.appendChild(host);
    els = { cg: root.querySelector('.cg'), ghosts: [...root.querySelectorAll('.ghost')], cur: root.querySelector('.cur'), rip: root.querySelector('.rip'), hl: root.querySelector('.hl'), scr: root.querySelector('.scr'), cap: root.querySelector('.cap'), keys: root.querySelector('.keys'), kinds: {} };
    root.querySelectorAll('[data-k]').forEach((n) => (els.kinds[n.dataset.k] = n));
    return true;
  }

  function cursorKindAt(x, y) {
    let el = document.elementFromPoint(x, y);
    // Descend into open shadow roots so web components report the right cursor.
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    if (!el) return 'arrow';
    const cur = getComputedStyle(el).cursor;
    if (cur === 'pointer') return 'hand';
    if (cur === 'text' || cur === 'vertical-text') return 'ibeam';
    if (cur === 'auto') {
      if (el.isContentEditable) return 'ibeam';
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return 'ibeam';
      if (tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type)) return 'ibeam';
      if (el.closest('a[href],button,summary,label[for]')) return 'hand';
    }
    return 'arrow';
  }

  function render(s) {
    if (!ensure()) return null;
    const out = { kind: 'arrow', sx: window.scrollX, sy: window.scrollY };
    // Cursor
    const c = s.cursor;
    if (c && c.visible) {
      const kind = c.kind || cursorKindAt(c.x, c.y);
      out.kind = kind;
      for (const k in els.kinds) els.kinds[k].style.display = k === kind ? 'block' : 'none';
      const [hx, hy] = HOT[kind];
      const sc = (c.size || 1) * (1 - 0.14 * (c.down || 0));
      // The group (which carries the drop shadow) is sized to the cursor + trail
      // bounding box: a filter on a full-viewport layer made every 2x screenshot
      // ~2.5x slower. Children are positioned relative to the box.
      const trail0 = c.trail || [];
      let x0 = c.x, y0 = c.y, x1 = c.x, y1 = c.y;
      for (const p of trail0) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const bx = Math.floor(x0) - 48, by = Math.floor(y0) - 48;
      Object.assign(els.cg.style, { transform: `translate(${bx}px, ${by}px)`, width: `${Math.ceil(x1 - bx) + 96}px`, height: `${Math.ceil(y1 - by) + 96}px` });
      els.cur.style.transformOrigin = `${hx}px ${hy}px`;
      els.cur.style.transform = `translate(${c.x - hx - bx}px, ${c.y - hy - by}px) scale(${sc})`;
      els.cur.style.display = 'block';
      // Motion blur: stack the trail samples. Each copy gets the same alpha a with
      // 1-(1-a)^n = 0.98, so where all samples overlap the cursor stays solid and
      // the swept area fades out (a cheap, deterministic shutter). One drop shadow
      // for the whole group (.cg) so shadows do not pile up into a smudge.
      const trail = c.trail || [];
      const a = trail.length ? 1 - Math.pow(0.02, 1 / (trail.length + 1)) : 1;
      els.cur.style.opacity = String(a);
      els.ghosts.forEach((g, i) => {
        const p = trail[i];
        if (!p) { g.style.display = 'none'; return; }
        if (g.dataset.k !== kind) { g.innerHTML = SVG[kind]; g.dataset.k = kind; }
        g.style.transformOrigin = `${hx}px ${hy}px`;
        g.style.transform = `translate(${p[0] - hx - bx}px, ${p[1] - hy - by}px) scale(${sc})`;
        g.style.opacity = String(a);
        g.style.display = 'block';
      });
    } else { els.cur.style.display = 'none'; els.ghosts.forEach((g) => (g.style.display = 'none')); }
    // Ripples
    els.rip.innerHTML = (s.ripples || []).map((r) => {
      const e = 1 - Math.pow(1 - r.p, 3);
      const d = 10 + e * (r.size || 46);
      const o = (1 - r.p) * 0.9;
      return `<i style="left:${r.x}px;top:${r.y}px;width:${d}px;height:${d}px;background:${r.color}33;box-shadow:0 0 0 2px ${r.color};opacity:${o}"></i>`;
    }).join('');
    // Highlight ring (+ optional dim)
    const h = s.highlight;
    if (h && h.o > 0.001 && window.__knackHl && window.__knackHl.isConnected) {
      const r = window.__knackHl.getBoundingClientRect();
      const p = h.padding ?? 8;
      Object.assign(els.hl.style, {
        display: 'block', left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px`,
        borderRadius: `${h.radius ?? 12}px`, opacity: String(h.o),
        boxShadow: `0 0 0 3px ${h.color}, 0 0 0 9px ${h.color}33${h.dim ? `, 0 0 0 200vmax rgba(8,8,12,${0.45 * h.o})` : ''}`,
      });
    } else els.hl.style.display = 'none';
    // Screen-space layer. The recorder captures the camera view as a clip of the
    // page at scale v.s, its origin snapped to the output pixel grid (camClip in
    // record.mjs). Moving this layer to that same origin and scaling it by 1/z
    // puts its contents at fixed output pixels and at their normal size, whatever
    // the zoom; the clip's extra resolution keeps the text sharp.
    const v = s.view;
    let scrT = 'none';
    if (v && (v.z !== 1 || v.x || v.y)) {
      const ox = Math.round((v.x + out.sx) * v.s) / v.s - out.sx, oy = Math.round((v.y + out.sy) * v.s) / v.s - out.sy;
      scrT = `translate(${ox}px, ${oy}px) scale(${1 / v.z})`;
    }
    if (els.scr.style.transform !== scrT) els.scr.style.transform = scrT;
    // Caption
    const cap = s.caption;
    if (cap && cap.o > 0.001) {
      if (els.cap.textContent !== cap.text) els.cap.textContent = cap.text;
      const lift = (1 - cap.o) * 10;
      Object.assign(els.cap.style, { display: 'block', opacity: String(cap.o), top: cap.position === 'top' ? `${28 - lift}px` : 'auto', bottom: cap.position === 'top' ? 'auto' : `${32 - lift}px` });
    } else els.cap.style.display = 'none';
    // Keystroke HUD
    const k = s.keys;
    if (k && k.o > 0.001) {
      const html = k.parts.map((p) => `<b>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</b>`).join('');
      if (els.keys.innerHTML !== html) els.keys.innerHTML = html;
      const sc = 0.92 + 0.08 * k.o;
      const bottom = cap && cap.o > 0.001 && cap.position !== 'top' ? 100 : 32;
      Object.assign(els.keys.style, { display: 'flex', opacity: String(k.o), bottom: `${bottom}px`, transform: `translateX(-50%) scale(${sc})` });
    } else els.keys.style.display = 'none';
    return out;
  }

  window.__knack = { render, ensure, cursorKindAt };
})();
