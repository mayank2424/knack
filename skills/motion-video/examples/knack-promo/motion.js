/*!
 * Knack Motion runtime: a tiny, deterministic, seekable animation timeline.
 * MIT License. No dependencies.
 *
 * Every frame is a pure function of time `t` (seconds). The renderer calls
 * Motion.seek(t) for each frame; the preview player calls it from rAF.
 * Never read the wall clock (Date.now, performance.now) in a composition.
 */
(function (global) {
  'use strict';

  const RENDER = !!global.__KNACK_RENDER__;
  const cfg = { width: 1920, height: 1080, fps: 30, duration: 6, background: '#0b0b10' };

  // ---------------------------------------------------------------- easing
  const bezier = (x1, y1, x2, y2) => {
    // Newton-Raphson + bisection solver, same approach browsers use.
    const A = (a, b) => 1 - 3 * b + 3 * a, B = (a, b) => 3 * b - 6 * a, C = (a) => 3 * a;
    const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
    const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-6) break;
        t -= (calc(t, x1, x2) - x) / s;
      }
      if (t < 0 || t > 1 || Math.abs(calc(t, x1, x2) - x) > 1e-5) {
        let lo = 0, hi = 1; t = x;
        for (let i = 0; i < 30; i++) {
          const v = calc(t, x1, x2);
          if (Math.abs(v - x) < 1e-6) break;
          v < x ? (lo = t) : (hi = t);
          t = (lo + hi) / 2;
        }
      }
      return calc(t, y1, y2);
    };
  };

  // Damped harmonic oscillator, normalised so the spring settles at p = 1.
  const spring = ({ stiffness = 170, damping = 26, mass = 1, velocity = 0 } = {}) => {
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const v0 = -velocity;
    const at = (t) => {
      if (zeta < 1) {
        const wd = w0 * Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 - v0) / wd) * Math.sin(wd * t));
      }
      return 1 - Math.exp(-w0 * t) * (1 + (w0 - v0) * t);
    };
    // Find settle time: last moment the value is outside a 0.1% band.
    let settle = 0;
    for (let t = 0; t < 10; t += 1 / 240) if (Math.abs(at(t) - 1) > 0.001) settle = t;
    settle = Math.max(settle, 1 / 60);
    return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : at(p * settle));
  };

  const ease = {
    linear: (p) => p,
    in: bezier(0.42, 0, 1, 1),
    out: bezier(0, 0, 0.58, 1),
    inOut: bezier(0.42, 0, 0.58, 1),
    inQuad: (p) => p * p,
    outQuad: (p) => 1 - (1 - p) * (1 - p),
    inOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    inCubic: (p) => p * p * p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outQuart: (p) => 1 - Math.pow(1 - p, 4),
    inOutQuart: (p) => (p < 0.5 ? 8 * p ** 4 : 1 - Math.pow(-2 * p + 2, 4) / 2),
    inExpo: (p) => (p === 0 ? 0 : Math.pow(2, 10 * p - 10)),
    outExpo: (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inOutExpo: (p) => (p === 0 ? 0 : p === 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
    outBack: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
    inBack: (p) => { const c1 = 1.70158, c3 = c1 + 1; return c3 * p * p * p - c1 * p * p; },
    inOutBack: (p) => {
      const c2 = 1.70158 * 1.525;
      return p < 0.5 ? (Math.pow(2 * p, 2) * ((c2 + 1) * 2 * p - c2)) / 2 : (Math.pow(2 * p - 2, 2) * ((c2 + 1) * (p * 2 - 2) + c2) + 2) / 2;
    },
    // Named curves used by motion designers.
    snappy: bezier(0.2, 0.9, 0.1, 1),      // fast out, long settle: UI entrances
    smooth: bezier(0.65, 0, 0.35, 1),      // symmetric: camera moves, morphs
    anticipate: bezier(0.36, -0.3, 0.3, 1.2),
    strong: bezier(0.16, 1, 0.3, 1),       // strong ease-out (long, soft landing): premium entrances
    strongInOut: bezier(0.77, 0, 0.175, 1), // decisive on-screen moves: selection, swaps, camera cuts
    outQuint: (p) => 1 - Math.pow(1 - p, 5),
    inQuint: (p) => p ** 5,
    bezier,
    spring,
  };

  const resolveEase = (e) => {
    if (typeof e === 'function') return e;
    if (typeof e === 'string' && ease[e]) return ease[e];
    if (Array.isArray(e) && e.length === 4) return bezier(...e);
    if (e && typeof e === 'object') return spring(e);
    return ease.outCubic;
  };

  // ------------------------------------------------------------- utilities
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, p) => a + (b - a) * p;

  /** Map t through input/output ranges (multi-stop), Remotion-style. */
  const interpolate = (t, input, output, opts = {}) => {
    const e = resolveEase(opts.ease || 'linear');
    const clampIt = opts.clamp !== false;
    if (t <= input[0]) return clampIt ? output[0] : lerp(output[0], output[1], e((t - input[0]) / (input[1] - input[0])));
    for (let i = 0; i < input.length - 1; i++) {
      if (t <= input[i + 1]) return lerp(output[i], output[i + 1], e((t - input[i]) / (input[i + 1] - input[i])));
    }
    const n = input.length - 1;
    return clampIt ? output[n] : lerp(output[n - 1], output[n], e((t - input[n - 1]) / (input[n] - input[n - 1])));
  };

  /** Seeded PRNG (mulberry32). Use instead of Math.random for determinism. */
  const random = (seed = 1) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  const parseColor = (c) => {
    if (typeof c !== 'string') return null;
    c = c.trim();
    let m = c.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map((x) => x + x).join('');
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
    }
    m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2], p[3] == null ? 1 : p[3]];
    }
    return null;
  };

  const els = (target) => {
    if (!target) return [];
    if (typeof target === 'string') return Array.from(document.querySelectorAll(target));
    if (target instanceof Element) return [target];
    // Arrays may mix elements and selectors: ['#a', '#b', el].
    return Array.from(target).flatMap((t) => (typeof t === 'string' ? Array.from(document.querySelectorAll(t)) : [t]));
  };

  // --------------------------------------------------------- tween engine
  // Transform-ish props are composed into one `transform`, in this order.
  const TRANSFORM = { x: 'px', y: 'px', z: 'px', rotate: 'deg', rotateX: 'deg', rotateY: 'deg', skewX: 'deg', skewY: 'deg', scale: '', scaleX: '', scaleY: '' };
  const DEFAULTS = { x: 0, y: 0, z: 0, rotate: 0, rotateX: 0, rotateY: 0, skewX: 0, skewY: 0, scale: 1, scaleX: 1, scaleY: 1, opacity: 1, blur: 0 };

  const tracks = new Map(); // element -> Map(prop -> [tween segments])
  let lastEnd = 0;

  const splitValue = (v) => {
    if (typeof v === 'number') return { n: v, unit: null };
    const m = String(v).match(/^(-?[\d.]+)([a-z%]*)$/i);
    return m ? { n: parseFloat(m[1]), unit: m[2] || null } : null;
  };

  /**
   * Motion.to(target, { start, duration, ease, from: {...}, to: {...} })
   * or the shorthand Motion.to(target, { opacity: 1, y: 0 }, { start, duration, ease, from }).
   */
  function to(target, a, b) {
    let opts;
    if (b) opts = { ...b, to: a };
    else opts = a;
    const { start = 0, duration = 0.6, from = {}, to: dest = {} } = opts;
    const e = resolveEase(opts.ease);
    const list = els(target);
    const stagger = opts.stagger || 0;
    list.forEach((el, i) => {
      const s = start + i * stagger;
      lastEnd = Math.max(lastEnd, s + duration);
      if (!tracks.has(el)) tracks.set(el, new Map());
      const props = new Set([...Object.keys(from), ...Object.keys(dest)]);
      props.forEach((prop) => {
        const track = tracks.get(el);
        if (!track.has(prop)) track.set(prop, []);
        track.get(prop).push({ start: s, duration, ease: e, from: from[prop], to: dest[prop] });
        track.get(prop).sort((p, q) => p.start - q.start);
      });
    });
    return api;
  }

  /** Shorthand for an entrance: from the given state to the element's natural state. */
  function from(target, fromState, opts = {}) {
    const dest = {};
    Object.keys(fromState).forEach((k) => (dest[k] = k in DEFAULTS ? DEFAULTS[k] : undefined));
    return to(target, { ...opts, from: fromState, to: { ...dest, ...(opts.to || {}) } });
  }

  const valueAt = (el, prop, segs, t) => {
    // Fill missing from/to by chaining: a segment's `from` defaults to the
    // previous segment's `to`, then the element's default.
    let prev = prop in DEFAULTS ? DEFAULTS[prop] : null;
    let current = null;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const f = s.from !== undefined ? s.from : prev;
      const d = s.to !== undefined ? s.to : (prop in DEFAULTS ? DEFAULTS[prop] : f);
      if (i === 0 && t < s.start) return f;
      if (t >= s.start) current = { s, f, d };
      prev = d;
    }
    if (!current) return null;
    const { s, f, d } = current;
    const p = s.duration <= 0 ? 1 : clamp((t - s.start) / s.duration);
    return mix(f, d, s.ease(p));
  };

  const mix = (a, b, p) => {
    if (a == null) return b;
    if (b == null) return a;
    const ca = parseColor(a), cb = parseColor(b);
    if (ca && cb) {
      const c = ca.map((v, i) => lerp(v, cb[i], p));
      return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
    }
    const sa = splitValue(a), sb = splitValue(b);
    if (sa && sb) {
      const n = lerp(sa.n, sb.n, p);
      const unit = sb.unit || sa.unit;
      return unit ? n + unit : n;
    }
    return p < 1 ? a : b;
  };

  const applyTracks = (t) => {
    tracks.forEach((track, el) => {
      const tf = {};
      let hasTf = false, filter = null;
      track.forEach((segs, prop) => {
        const v = valueAt(el, prop, segs, t);
        if (v == null) return;
        if (prop in TRANSFORM) { tf[prop] = v; hasTf = true; }
        else if (prop === 'blur') filter = `blur(${typeof v === 'number' ? v + 'px' : v})`;
        else if (prop.startsWith('--')) el.style.setProperty(prop, typeof v === 'number' ? String(v) : v);
        else if (prop === 'text') el.textContent = v;
        else el.style[prop] = typeof v === 'number' && prop !== 'opacity' && prop !== 'zIndex' ? v + 'px' : v;
      });
      if (hasTf) {
        const px = (v) => (typeof v === 'number' ? v + 'px' : v);
        const tx = tf.x ?? 0, ty = tf.y ?? 0, tz = tf.z ?? 0;
        const full = 'rotateX' in tf || 'rotateY' in tf || 'skewX' in tf || 'skewY' in tf;
        if (full) {
          // 3D rotation/skew have no individual CSS property, so this path
          // owns `transform` (and overrides any transform set in CSS).
          const parts = [];
          for (const k of Object.keys(TRANSFORM)) {
            if (!(k in tf) || k === 'x' || k === 'y' || k === 'z') continue;
            const raw = tf[k];
            parts.push(`${k}(${typeof raw === 'number' ? raw + TRANSFORM[k] : raw})`);
          }
          el.style.transform = `translate3d(${px(tx)},${px(ty)},${px(tz)}) ` + parts.join(' ');
        } else {
          // Individual transform properties compose with a CSS `transform`
          // (e.g. translate(-50%,-50%) centering) instead of replacing it.
          if ('x' in tf || 'y' in tf || 'z' in tf) el.style.translate = `${px(tx)} ${px(ty)}${'z' in tf ? ' ' + px(tz) : ''}`;
          if ('rotate' in tf) el.style.rotate = typeof tf.rotate === 'number' ? tf.rotate + 'deg' : tf.rotate;
          if ('scale' in tf || 'scaleX' in tf || 'scaleY' in tf) {
            const s = tf.scale ?? 1;
            el.style.scale = `${s * (tf.scaleX ?? 1)} ${s * (tf.scaleY ?? 1)}`;
          }
        }
      }
      if (filter) el.style.filter = filter;
    });
  };

  // --------------------------------------------------------------- helpers
  /** Split text into spans: 'chars' | 'words'. Returns the span elements. */
  function split(target, mode = 'words') {
    const out = [];
    els(target).forEach((el) => {
      const text = el.textContent;
      el.textContent = '';
      el.setAttribute('aria-label', text);
      const parts = mode === 'chars' ? Array.from(text) : text.split(/(\s+)/);
      parts.forEach((part) => {
        if (/^\s+$/.test(part)) { el.appendChild(document.createTextNode(part)); return; }
        if (mode === 'chars' && part === ' ') { el.appendChild(document.createTextNode(' ')); return; }
        const span = document.createElement('span');
        span.className = mode === 'chars' ? 'char' : 'word';
        span.style.display = 'inline-block';
        span.style.willChange = 'transform, opacity';
        span.textContent = part;
        span.setAttribute('aria-hidden', 'true');
        el.appendChild(span);
        out.push(span);
      });
    });
    return out;
  }

  const renderers = [];
  /** Register a per-frame callback: fn(t) => void. Must be pure in t. */
  const on = (fn) => { renderers.push(fn); return api; };

  /** Animated number. format: (n) => string */
  function counter(target, { from: a = 0, to: b = 100, start = 0, duration = 1.2, ease: e = 'outCubic', format } = {}) {
    const f = format || ((n) => Math.round(n).toLocaleString('en-US'));
    const ez = resolveEase(e);
    lastEnd = Math.max(lastEnd, start + duration);
    els(target).forEach((el) => on((t) => { el.textContent = f(lerp(a, b, ez(clamp((t - start) / duration)))); }));
    return api;
  }

  /** Draw SVG strokes (path, line, circle, polyline...). */
  function draw(target, { start = 0, duration = 1, ease: e = 'inOutCubic', reverse = false } = {}) {
    const ez = resolveEase(e);
    lastEnd = Math.max(lastEnd, start + duration);
    els(target).forEach((el) => {
      const len = el.getTotalLength ? el.getTotalLength() : 1000;
      el.style.strokeDasharray = `${len} ${len}`;
      on((t) => {
        const p = ez(clamp((t - start) / duration));
        el.style.strokeDashoffset = String(len * (reverse ? p : 1 - p));
      });
    });
    return api;
  }

  /** Typewriter reveal at `cps` characters per second. */
  function type(target, { start = 0, cps = 24, cursor = false } = {}) {
    els(target).forEach((el) => {
      const text = el.textContent;
      lastEnd = Math.max(lastEnd, start + text.length / cps);
      on((t) => {
        const n = Math.floor(clamp((t - start) * cps, 0, text.length));
        const blink = cursor && Math.floor(t * 2) % 2 === 0 ? '▍' : cursor ? ' ' : '';
        el.textContent = text.slice(0, n) + blink;
      });
    });
    return api;
  }

  // ------------------------------------------------------------- seek core
  let time = 0;
  async function seek(t) {
    time = clamp(t, 0, cfg.duration);
    applyTracks(time);
    for (const fn of renderers) fn(time);
    // CSS animations / transitions / WAAPI become seekable too.
    if (document.getAnimations) {
      for (const a of document.getAnimations()) {
        try { a.pause(); a.currentTime = time * 1000; } catch (_) {}
      }
    }
    // <video data-start="2"> elements are synced to the timeline.
    const vids = Array.from(document.querySelectorAll('video'));
    await Promise.all(vids.map((v) => new Promise((res) => {
      v.pause();
      const target = Math.max(0, time - parseFloat(v.dataset.start || '0'));
      if (Math.abs(v.currentTime - target) < 1e-3) return res();
      v.addEventListener('seeked', res, { once: true });
      v.currentTime = target;
      setTimeout(res, 2000);
    })));
  }

  // ---------------------------------------------------------------- config
  function config(c = {}) {
    Object.assign(cfg, c);
    const apply = () => {
      const root = document.documentElement;
      root.style.setProperty('--w', cfg.width + 'px');
      root.style.setProperty('--h', cfg.height + 'px');
      const stage = document.getElementById('stage');
      if (stage) {
        stage.style.width = cfg.width + 'px';
        stage.style.height = cfg.height + 'px';
        // Only paint the config background when CSS didn't style #stage itself
        // (a CSS gradient on #stage must win over the default color).
        const cs = getComputedStyle(stage);
        const cssBg = cs.backgroundImage !== 'none' || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor);
        if (cfg.background && !stage.style.background && !cssBg) stage.style.background = cfg.background;
      }
    };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', apply) : apply();
    return api;
  }

  // --------------------------------------------------------- base styles
  const baseCss = `
    html,body{margin:0;padding:0;background:#000;overflow:hidden}
    #stage{position:relative;overflow:hidden;transform-origin:0 0}
    .knack-render,.knack-render body{background:transparent}
    .knack-render #stage{position:absolute;left:0;top:0}
  `;

  // ------------------------------------------------------- preview player
  function mountPlayer() {
    const stage = document.getElementById('stage');
    if (!stage) return console.warn('[motion] No #stage element found.');
    const bar = document.createElement('div');
    bar.id = 'knack-player';
    bar.innerHTML = `
      <button data-k="play" title="Play/Pause (space)">❚❚</button>
      <input data-k="scrub" type="range" min="0" max="1000" value="0" />
      <span data-k="time">0.00s</span>
      <button data-k="loop" title="Loop (L)" aria-pressed="true">⟲</button>`;
    const css = document.createElement('style');
    css.textContent = `
      body{display:grid;place-items:center;height:100vh;background:#111}
      #knack-player{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;
        background:rgba(20,20,24,.9);backdrop-filter:blur(8px);padding:8px 14px;border-radius:999px;font:12px/1 ui-monospace,Menlo,monospace;color:#ddd;z-index:99999;box-shadow:0 8px 30px rgba(0,0,0,.4)}
      #knack-player button{all:unset;cursor:pointer;width:22px;text-align:center;color:#fff}
      #knack-player button[aria-pressed=false]{opacity:.35}
      #knack-player input{width:min(52vw,560px);accent-color:#7c5cff}
      #knack-player span{min-width:96px;text-align:right}`;
    document.head.appendChild(css);
    document.body.appendChild(bar);

    const fit = () => {
      const s = Math.min((innerWidth - 32) / cfg.width, (innerHeight - 90) / cfg.height, 1);
      stage.style.transform = `scale(${s})`;
      stage.style.margin = `${(cfg.height * s - cfg.height) / 2}px ${(cfg.width * s - cfg.width) / 2}px`;
      stage.style.transformOrigin = 'center center';
    };
    fit();
    addEventListener('resize', fit);

    const q = (k) => bar.querySelector(`[data-k=${k}]`);
    let playing = true, loop = true, t0 = null, base = 0;
    const show = () => {
      q('time').textContent = `${time.toFixed(2)}s / ${cfg.duration}s`;
      q('scrub').value = String(Math.round((time / cfg.duration) * 1000));
      q('play').textContent = playing ? '❚❚' : '▶';
    };
    const tick = (now) => {
      if (playing) {
        if (t0 == null) t0 = now;
        let t = base + (now - t0) / 1000;
        if (t >= cfg.duration) {
          if (loop) { base = 0; t0 = now; t = 0; } else { t = cfg.duration; playing = false; }
        }
        seek(t);
        show();
      }
      requestAnimationFrame(tick);
    };
    const toggle = () => { playing = !playing; base = time; t0 = null; if (playing && time >= cfg.duration) base = 0; show(); };
    q('play').onclick = toggle;
    q('loop').onclick = () => { loop = !loop; q('loop').setAttribute('aria-pressed', String(loop)); };
    q('scrub').oninput = (e) => { playing = false; seek((e.target.value / 1000) * cfg.duration); show(); };
    addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      if (e.key === 'l' || e.key === 'L') q('loop').click();
      const step = (e.shiftKey ? 10 : 1) / cfg.fps;
      if (e.key === 'ArrowRight') { playing = false; seek(time + step); show(); }
      if (e.key === 'ArrowLeft') { playing = false; seek(time - step); show(); }
      if (e.key === 'Home') { playing = false; seek(0); show(); }
    });
    // ?t=2.5 opens paused at a given time; handy for reviewing one beat.
    const qt = new URLSearchParams(location.search).get('t');
    if (qt != null) { playing = false; seek(parseFloat(qt)); show(); }
    requestAnimationFrame(tick);
  }

  const style = document.createElement('style');
  style.textContent = baseCss;
  (document.head || document.documentElement).appendChild(style);

  const boot = async () => {
    if (RENDER) document.documentElement.classList.add('knack-render');
    if (RENDER && global.__KNACK_OUTPUT__) document.documentElement.classList.add('knack-out-' + global.__KNACK_OUTPUT__);
    // Load every declared font face (all weights and unicode-range subsets), not just
    // the ones frame 0 happens to use, so no later frame flashes a fallback font
    // (e.g. a counter or typewriter that reveals new glyphs mid-video).
    if (document.fonts) {
      await Promise.all(Array.from(document.fonts, (f) => (f.status === 'unloaded' ? f.load().catch(() => {}) : null)));
      await document.fonts.ready;
    }
    // Decode images up front so the first frame that shows one never paints it blank.
    await Promise.all(Array.from(document.images, (img) => (img.decode ? img.decode().catch(() => {}) : null)));
    await seek(0);
    global.__KNACK_READY__ = true;
    if (!RENDER) mountPlayer();
  };
  // Defer so composition scripts (which run after this file) register first.
  addEventListener('load', () => setTimeout(boot, 0));

  const api = {
    config, to, from, on, split, counter, draw, type, seek,
    interpolate, clamp, lerp, random, ease,
    get time() { return time; },
    getConfig: () => ({ ...cfg, lastTweenEnd: lastEnd }),
    _tracks: tracks,
  };
  global.Motion = api;
})(window);
