// Hero: headline entrance (motion.dev) + the agent vision panel. For each skill, a dot matrix
// swirls in and settles into a halftone of that skill's real output; a scan line resolves it into the
// crisp image while the agent's tool calls run; a reticle checks spots on it, the result lands, and the
// dots dissolve and swirl into the next skill.
(() => {
  const M = window.Motion;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = [0.16, 1, 0.3, 1];
  const $ = (s) => document.querySelector(s);
  const base = (document.querySelector('link[href$="styles.css"]') || { getAttribute: () => 'styles.css' }).getAttribute('href').replace('styles.css', '');

  // ── 1 · Headline and copy entrance
  const words = Array.from(document.querySelectorAll('#heroTitle .w'));
  const scribble = $('.scribble path');
  // Attributes, not inline styles: motion.dev animates SVG attributes, and an inline style would win.
  if (scribble) { scribble.setAttribute('pathLength', '1'); scribble.setAttribute('stroke-dasharray', '1'); scribble.setAttribute('stroke-dashoffset', reduced || !M ? '0' : '1'); }
  if (M && !reduced) {
    const { animate, stagger } = M;
    animate(words, { opacity: [0, 1], y: [30, 0], filter: ['blur(8px)', 'blur(0px)'] }, { delay: stagger(0.065, { startDelay: 0.08 }), duration: 0.9, ease });
    animate(scribble, { strokeDashoffset: [1, 0] }, { delay: 0.75, duration: 0.85, ease: [0.65, 0, 0.35, 1] });
    animate('.hero-copy .doing, .hero-copy .lede, .hero-copy .install, .hero-copy .facts', { opacity: [0, 1], y: [16, 0] }, { delay: stagger(0.08, { startDelay: 0.45 }), duration: 0.8, ease });
    animate('.vision-wrap', { opacity: [0, 1], y: [24, 0] }, { delay: 0.3, duration: 1.1, ease });
  }

  // ── 2 · "Right now it …" line, driven by the orbit's calls
  const doing = $('#doing');
  const say = (text) => {
    if (!doing || doing.textContent === text) return;
    if (!M || reduced) { doing.textContent = text; return; }
    M.animate(doing, { opacity: [1, 0], y: [0, -8] }, { duration: 0.22, ease: [0.4, 0, 1, 1] }).finished.then(() => {
      doing.textContent = text;
      M.animate(doing, { opacity: [0, 1], y: [8, 0] }, { duration: 0.45, ease });
    });
  };

  // ── 3 · Agent network: a blueprint grid where signal packets run along the lines, turn at
  // intersections (which flash), and some steer into the agent panel and land on its edge with a pulse.
  // Cells under the cursor light up. Static grid only under reduced motion.
  const shell = $('.hero-shell'), net = $('#heroNet');
  if (shell && net) (() => {
    const g = net.getContext('2d');
    const CELL = 56;
    let W = 0, H = 0, dpr = 1, cols = 0, rows = 0, ox = 0, oy = 0, target = null;
    const size = () => {
      const r = shell.getBoundingClientRect();
      dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; H = r.height;
      net.width = Math.round(W * dpr); net.height = Math.round(H * dpr);
      cols = Math.ceil(W / CELL) + 1; rows = Math.ceil(H / CELL) + 1;
      ox = ((W / 2) % CELL) - CELL; oy = 0;
      const v = $('#vision');
      if (v) { const vr = v.getBoundingClientRect(); target = { x: vr.left - r.left, y: vr.top - r.top, w: vr.width, h: vr.height }; }
    };
    const gx = (c) => ox + c * CELL, gy = (r) => oy + r * CELL;
    const drawGrid = () => {
      g.strokeStyle = '#e4e5e8'; g.lineWidth = 1; g.beginPath();
      for (let c = 0; c <= cols; c++) { const x = Math.round(gx(c)) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
      for (let r = 0; r <= rows; r++) { const y = Math.round(gy(r)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      g.fillStyle = '#d6d7db';                       // small crosses at intersections
      for (let c = 0; c <= cols; c++) for (let r = 0; r <= rows; r++) { const x = Math.round(gx(c)), y = Math.round(gy(r)); g.fillRect(x - 2, y, 5, 1); g.fillRect(x, y - 2, 1, 5); }
    };
    size();
    if (reduced) { g.setTransform(dpr, 0, 0, dpr, 0, 0); drawGrid(); addEventListener('resize', () => { size(); g.setTransform(dpr, 0, 0, dpr, 0, 0); drawGrid(); }); return; }

    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const packets = [], flashes = [], hover = new Map();
    const inPanel = (x, y) => target && x > target.x && x < target.x + target.w && y > target.y && y < target.y + target.h;
    const spawn = () => {
      // start on a random intersection outside the panel, heading anywhere
      let c, r, tries = 0;
      do { c = 1 + Math.floor(rnd() * (cols - 2)); r = 1 + Math.floor(rnd() * (rows - 2)); tries++; } while (inPanel(gx(c), gy(r)) && tries < 20);
      const seek = rnd() < 0.55;                      // some packets carry work to the agent
      packets.push({ c, r, d: Math.floor(rnd() * 4), p: 0, speed: 2.4 + rnd() * 2.2, trail: [], life: 0, max: 5 + rnd() * 4, seek, green: seek && rnd() < 0.6, dead: false });
    };
    const choose = (k) => {
      const opts = [k.d, (k.d + 1) % 4, (k.d + 3) % 4];
      if (k.seek && target) {
        const tx = target.x + target.w / 2, ty = target.y + target.h / 2, x = gx(k.c), y = gy(k.r);
        const want = Math.abs(tx - x) > Math.abs(ty - y) ? (tx > x ? 0 : 2) : (ty > y ? 1 : 3);
        if (rnd() < 0.7) return want;
      }
      return rnd() < 0.68 ? opts[0] : opts[1 + Math.floor(rnd() * 2)];
    };
    shell.addEventListener('pointermove', (e) => {
      const r = shell.getBoundingClientRect();
      const c = Math.floor((e.clientX - r.left - ox) / CELL), rr = Math.floor((e.clientY - r.top - oy) / CELL);
      hover.set(`${c},${rr}`, performance.now());
    });

    let last = performance.now(), running = false, raf = 0, spawnAcc = 0;
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      // hovered cells
      for (const [key, t0] of hover) {
        const a = 1 - (now - t0) / 900; if (a <= 0) { hover.delete(key); continue; }
        const [c, r] = key.split(',').map(Number);
        g.fillStyle = `rgba(17,18,20,${0.045 * a})`; g.fillRect(gx(c) + 1, gy(r) + 1, CELL - 1, CELL - 1);
      }
      drawGrid();
      // spawn to keep ~16 packets alive
      spawnAcc += dt;
      if (packets.length < 26 && spawnAcc > 0.12) { spawn(); spawnAcc = 0; }
      for (const k of packets) {
        k.life += dt; k.p += k.speed * dt;
        while (k.p >= 1 && !k.dead) {
          k.p -= 1; k.c += DIRS[k.d][0]; k.r += DIRS[k.d][1];
          const x = gx(k.c), y = gy(k.r);
          if (k.c < -1 || k.r < -1 || k.c > cols + 1 || k.r > rows + 1 || k.life > k.max) { k.dead = true; break; }
          if (inPanel(x, y)) { k.dead = true; flashes.push({ x: Math.min(Math.max(x, target.x), target.x + target.w), y: Math.min(Math.max(y, target.y), target.y + target.h), t: now, big: true, green: k.green }); break; }
          const nd = choose(k);
          if (nd !== k.d) flashes.push({ x, y, t: now, big: false, green: k.green });
          k.d = nd;
        }
        const x = gx(k.c) + DIRS[k.d][0] * k.p * CELL, y = gy(k.r) + DIRS[k.d][1] * k.p * CELL;
        k.trail.push(x, y); if (k.trail.length > 56) k.trail.splice(0, 2);
        const fade = Math.min(1, k.life / 0.4) * (k.dead ? 0 : 1) * Math.min(1, (k.max - k.life) / 0.6 + 0.001);
        const n = k.trail.length / 2;
        for (let i = 1; i < n; i++) {
          const a = (i / n) * fade;
          g.strokeStyle = k.green ? `rgba(22,121,60,${a})` : `rgba(17,18,20,${a * 0.7})`;
          g.lineWidth = 2; g.beginPath();
          g.moveTo(k.trail[(i - 1) * 2], k.trail[(i - 1) * 2 + 1]); g.lineTo(k.trail[i * 2], k.trail[i * 2 + 1]); g.stroke();
        }
        if (!k.dead) { g.fillStyle = k.green ? `rgba(22,121,60,${fade})` : `rgba(17,18,20,${fade * 0.8})`; g.fillRect(x - 1.5, y - 1.5, 3, 3); }
      }
      for (let i = packets.length - 1; i >= 0; i--) if (packets[i].dead) packets.splice(i, 1);
      // intersection flashes and landing pulses
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i], u = (now - f.t) / (f.big ? 700 : 450);
        if (u >= 1) { flashes.splice(i, 1); continue; }
        const col = f.green ? '22,121,60' : '17,18,20';
        if (f.big) {
          g.strokeStyle = `rgba(${col},${(1 - u) * 0.7})`; g.lineWidth = 1.5;
          g.beginPath(); g.arc(f.x, f.y, 4 + u * 18, 0, Math.PI * 2); g.stroke();
          g.fillStyle = `rgba(${col},${1 - u})`; g.beginPath(); g.arc(f.x, f.y, 3, 0, Math.PI * 2); g.fill();
        } else {
          const s = 7 * (1 - u * 0.4);
          g.strokeStyle = `rgba(${col},${(1 - u) * 0.6})`; g.lineWidth = 1;
          g.strokeRect(f.x - s / 2 + 0.5, f.y - s / 2 + 0.5, s, s);
        }
      }
      if (running) raf = requestAnimationFrame(tick);
    };
    const start = () => { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(tick); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    addEventListener('resize', size);
    document.fonts.ready.then(size);
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(shell);
  })();

  // ── 4 · Agent vision
  let data = [];
  try { data = JSON.parse($('#orbit-data').textContent); } catch (_) {}
  const body = $('#vBody'), canvas = $('#vCanvas');
  if (!body || !canvas || !data.length) return;
  const ctx = canvas.getContext('2d');
  const skillEl = $('#vSkill'), statusEl = $('#vStatus'), logEl = $('#vLog'), marksEl = $('#vMarks'), reticle = $('#vReticle'), resultEl = $('#vResult'), tabsEl = $('#vTabs');
  const INK = [17, 18, 20], PAPER = '#dcdde0';
  const T = 7.6;                                   // seconds per skill
  const P = { settle: 1.3, scan0: 1.35, scan1: 2.35, result: 6.0, fade0: 6.75, fade1: 7.05 };
  const STEP0 = 0.25, STEP = 1.1, STEP_RUN = 0.8;  // tool-call log timing
  const VISITS = [2.55, 3.65, 4.75];              // reticle lands
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const sm = (v) => { v = clamp(v); return v * v * (3 - 2 * v); };
  const outC = (v) => 1 - Math.pow(1 - clamp(v), 3);
  const inC = (v) => Math.pow(clamp(v), 3);

  // Layout: a grid of dots over the body. Pitch adapts to width.
  let W = 0, H = 0, dpr = 1, pitch = 7, cols = 0, rows = 0, dots = [];
  const layout = () => {
    const r = body.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    pitch = W < 420 ? 6 : 7;
    cols = Math.floor(W / pitch); rows = Math.floor(H / pitch);
    const ox = (W - (cols - 1) * pitch) / 2, oy = (H - (rows - 1) * pitch) / 2;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    dots = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) dots.push({ hx: ox + x * pitch, hy: oy + y * pitch, a: rnd() * Math.PI * 2, s: 0.35 + rnd() * 0.65 });
    scenes.forEach((sc) => { sc.ready = false; });
    scenes.forEach(prepare);
  };

  // Each scene: a crisp source canvas (the real image, or the terminal lines) + per-dot halftone.
  const scenes = data.map((d) => ({ d, img: null, src: null, r: null, col: null, pts: [], ready: false }));
  scenes.forEach((sc) => {
    if (!sc.d.thumb) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { sc.img = img; if (W) prepare(sc); };
    img.src = base + sc.d.thumb;
  });
  function drawSource(sc, c, w, h) {
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    if (sc.img) {
      const ir = sc.img.width / sc.img.height, br = w / h;
      if (ir > br * 1.25) {                         // very wide: contain, centred, on a light ground
        const dh = w / ir; g.fillStyle = '#f6f6f7'; g.fillRect(0, 0, w, h);
        g.drawImage(sc.img, 0, (h - dh) / 2, w, dh);
      } else {                                      // cover, top-aligned
        const sw = ir > br ? sc.img.height * br : sc.img.width, sh = ir > br ? sc.img.height : sc.img.width / br;
        g.drawImage(sc.img, (sc.img.width - sw) / 2, 0, sw, sh, 0, 0, w, h);
      }
    } else if (sc.d.lines) {                        // terminal evidence
      g.fillStyle = '#111214'; g.fillRect(0, 0, w, h);
      const fs = Math.max(8, Math.round(w / 58)), lh = fs * 1.7;
      g.font = `500 ${fs}px 'IBM Plex Mono', ui-monospace, monospace`; g.textBaseline = 'top';
      sc.d.lines.forEach((l, i) => {
        g.fillStyle = l.startsWith('$') ? '#8fd6a8' : /score|→/.test(l) ? '#ffffff' : '#c8c9ce';
        g.fillText(l, fs * 1.6, fs * 1.6 + i * lh);
      });
    }
  }
  function prepare(sc) {
    if (!W || (sc.d.thumb && !sc.img)) return;
    sc.src = document.createElement('canvas');
    sc.src.width = Math.round(W * dpr); sc.src.height = Math.round(H * dpr);
    drawSource(sc, sc.src, sc.src.width, sc.src.height);
    // Halftone: sample the source at the dot grid.
    const s = document.createElement('canvas'); s.width = cols; s.height = rows;
    const sg = s.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(sc.src, 0, 0, cols, rows);
    const px = sg.getImageData(0, 0, cols, rows).data;
    const rmax = pitch * 0.42;                       // dots never touch, even on dark sources
    sc.r = new Float32Array(cols * rows); sc.col = new Array(cols * rows); sc.L = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      const L = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255, sat = (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
      sc.L[i] = L;
      const ink = Math.pow(1 - L, 0.75);
      sc.r[i] = ink < 0.06 ? 0.75 : Math.max(0.9, rmax * Math.min(1, ink * 1.15 + sat * 0.35));
      sc.col[i] = ink < 0.06 ? PAPER : sat > 0.28 ? `rgb(${R * 0.85 | 0},${G * 0.85 | 0},${B * 0.85 | 0})` : `rgb(${INK[0]},${INK[1]},${INK[2]})`;
    }
    // Reticle targets: the three most detailed spots, spread apart and away from the edges.
    const cand = [];
    for (let y = 3; y < rows - 3; y += 2) for (let x = 4; x < cols - 4; x += 2) {
      let m = 0, v = 0, n = 0;
      for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) { m += sc.L[(y + j) * cols + x + k]; n++; }
      m /= n;
      for (let j = -2; j <= 2; j++) for (let k = -2; k <= 2; k++) v += Math.abs(sc.L[(y + j) * cols + x + k] - m);
      cand.push({ x, y, v });
    }
    cand.sort((a, b) => b.v - a.v);
    sc.pts = [];
    const minD = Math.min(cols, rows) * 0.32;
    for (const c of cand) {
      if (sc.pts.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > minD)) sc.pts.push(c);
      if (sc.pts.length === 3) break;
    }
    sc.pts = sc.pts.map((p) => ({ x: dots[p.y * cols + p.x].hx, y: dots[p.y * cols + p.x].hy })).sort((a, b) => a.y - b.y);
    sc.ready = true;
  }

  // Tabs: one per skill, with a progress bar on the active one. Clicking jumps to that skill.
  const tabs = data.map((d, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${d.name}<span class="bar"></span>`;
    b.addEventListener('click', () => { if (i === idx) return; prevIdx = idx; idx = i; t0 = performance.now(); enter(i); });
    tabsEl.appendChild(b);
    return b;
  });

  const check = '<svg viewBox="0 0 12 12"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>';
  let idx = Math.max(0, data.findIndex((d) => d.name === 'a11y-audit')), prevIdx = -1, t0 = performance.now(), shown = { step: -2, visit: -1, result: false, status: '' };
  function setStatus(text, ok) {
    if (shown.status === text) return;
    shown.status = text;
    statusEl.querySelector('b').textContent = text;
    statusEl.classList.toggle('ok', !!ok);
  }
  function enter(i) {
    const d = data[i];
    skillEl.textContent = d.name;
    tabs.forEach((b, j) => { b.setAttribute('aria-pressed', String(j === i)); b.querySelector('.bar').style.width = '0'; });
    logEl.innerHTML = (d.trail || []).map(([tool, arg]) => `<li><span class="s"></span><b>${tool}</b><span>${arg}</span></li>`).join('');
    marksEl.innerHTML = '';
    resultEl.textContent = d.result;
    resultEl.style.opacity = '0';
    reticle.style.opacity = '0';
    shown = { step: -2, visit: -1, result: false, status: '' };
    say(`${d.title} → ${d.call}`);
  }

  function frame(now) {
    let u = (now - t0) / 1000;
    if (u >= T) { prevIdx = idx; idx = (idx + 1) % data.length; t0 += T * 1000; u -= T; enter(idx); }
    if (prevIdx === -1 && shown.status === '') enter(idx);
    const sc = scenes[idx], prev = prevIdx >= 0 ? scenes[prevIdx] : null;
    tabs[idx].querySelector('.bar').style.width = `${(u / T) * 100}%`;

    // Tool-call log
    const rowsEl = logEl.children;
    for (let k = 0; k < rowsEl.length; k++) {
      const st = u >= STEP0 + k * STEP + STEP_RUN ? 'is-ok' : u >= STEP0 + k * STEP ? 'is-run' : '';
      if (rowsEl[k].className !== st) rowsEl[k].className = st;
    }
    setStatus(u < P.scan0 ? 'reading' : u < P.scan1 ? 'inspecting' : u < P.result ? 'verifying' : 'verified', u >= P.result);

    // Reticle visits + ticks
    if (sc.ready && sc.pts.length) {
      let v = -1; VISITS.forEach((tv, k) => { if (u >= tv - 0.45) v = k; });
      if (v >= 0 && u < P.fade0) {
        const k = v, from = k === 0 ? { x: W / 2, y: H / 2 } : sc.pts[k - 1], to = sc.pts[Math.min(k, sc.pts.length - 1)];
        const e = outC((u - (VISITS[k] - 0.45)) / 0.45);
        const x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e;
        const pulse = u >= VISITS[k] ? 1 + 0.25 * Math.exp(-((u - VISITS[k]) * 9)) : 1;
        reticle.style.transform = `translate(${x}px, ${y}px) scale(${k === 0 ? 0.7 + 0.3 * e : 1}) scale(${2 - pulse})`;
        reticle.style.opacity = String(Math.min(1, (u - (VISITS[0] - 0.45)) / 0.2) * (1 - clamp((u - (P.result - 0.1)) / 0.3)));
      } else reticle.style.opacity = '0';
      VISITS.forEach((tv, k) => {
        if (u >= tv && shown.visit < k && sc.pts[k]) {
          shown.visit = k;
          const m = document.createElement('span');
          m.className = 'v-tick'; m.innerHTML = check;
          m.style.left = `${sc.pts[k].x}px`; m.style.top = `${sc.pts[k].y}px`;
          marksEl.appendChild(m);
          if (M) M.animate(m, { scale: [0.4, 1], opacity: [0, 1] }, { type: 'spring', stiffness: 420, damping: 22 });
        }
      });
    }
    if (u >= P.result && !shown.result) {
      shown.result = true;
      if (M) M.animate(resultEl, { opacity: [0, 1], y: [10, 0] }, { duration: 0.5, ease }); else resultEl.style.opacity = '1';
    }
    if (u >= P.fade0) {
      const f = 1 - clamp((u - P.fade0) / 0.3);
      marksEl.style.opacity = resultEl.style.opacity = String(f);
    } else marksEl.style.opacity = '1';

    // Canvas
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (sc.ready) {
      // swirl amplitude: in at the start (settle), out at the end (dissolve)
      const A = (1 - outC(u / P.settle)) + inC((u - P.fade1) / (T - P.fade1));
      const morph = sm(u / P.settle);
      const scanY = u < P.scan0 ? -1 : H * sm((u - P.scan0) / (P.scan1 - P.scan0));
      const imgA = u < P.fade0 ? 1 : 1 - sm((u - P.fade0) / (P.fade1 - P.fade0));
      const showImg = u >= P.scan0;
      const firstIn = prevIdx === -1 ? clamp(u / 0.8) : 1;
      const cx = W / 2, cy = H / 2, amp = Math.min(W, H) * 0.22, rot = A * 0.55, time = now / 1000;
      // Crisp image above the scan line (and fading out at the end)
      if (showImg && sc.src) {
        ctx.save();
        ctx.globalAlpha = imgA;
        ctx.beginPath(); ctx.rect(0, 0, W, u < P.scan1 ? scanY : H); ctx.clip();
        ctx.drawImage(sc.src, 0, 0, W, H);
        ctx.restore();
      }
      // Dots: hidden where the image is fully shown
      const dotsVisible = !showImg || imgA < 1 || u < P.scan1;
      if (dotsVisible) {
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        for (let i = 0; i < dots.length; i++) {
          const p = dots[i];
          if (showImg && imgA >= 1 && p.hy < scanY - 1) continue;
          let r = sc.r[i];
          if (prev && prev.ready && morph < 1) r = prev.r[i] + (r - prev.r[i]) * morph;
          r *= firstIn * (showImg && imgA < 1 ? 1 - imgA * 0.999 + 0.001 : 1);
          if (r < 0.35) continue;
          let x = p.hx, y = p.hy;
          if (A > 0.001) {
            const dx = x - cx, dy = y - cy;
            const ang = p.a + (p.hx * 0.013 + p.hy * 0.011) * 2.2 + time * 0.7;
            x = cx + dx * cosR - dy * sinR + Math.cos(ang) * amp * A * p.s;
            y = cy + dx * sinR + dy * cosR + Math.sin(ang) * amp * A * p.s;
          }
          ctx.fillStyle = morph < 0.5 && prev && prev.ready ? prev.col[i] : sc.col[i];
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
        }
      }
      // Scan line
      if (u >= P.scan0 && u < P.scan1 + 0.05) {
        const g = ctx.createLinearGradient(0, scanY - 46, 0, scanY);
        g.addColorStop(0, 'rgba(22,121,60,0)'); g.addColorStop(1, 'rgba(22,121,60,0.14)');
        ctx.fillStyle = g; ctx.fillRect(0, scanY - 46, W, 46);
        ctx.fillStyle = '#16793c'; ctx.fillRect(0, scanY - 1, W, 1.5);
      }
    }
    if (running) raf = requestAnimationFrame(frame);
  }

  // Reduced motion: one static, verified frame.
  if (reduced) {
    layout();
    const sc = scenes[idx];
    const still = () => {
      if (!sc.ready) prepare(sc);
      if (!sc.ready) return setTimeout(still, 120);
      enter(idx);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.drawImage(sc.src, 0, 0, W, H);
      [...logEl.children].forEach((li) => (li.className = 'is-ok'));
      resultEl.style.opacity = '1'; setStatus('verified', true);
    };
    still();
    tabs.forEach((b, i) => b.addEventListener('click', () => {
      const s2 = scenes[i]; if (!s2.ready) prepare(s2); if (!s2.ready) return;
      enter(i); ctx.clearRect(0, 0, W, H); ctx.drawImage(s2.src, 0, 0, W, H);
      [...logEl.children].forEach((li) => (li.className = 'is-ok')); resultEl.style.opacity = '1'; setStatus('verified', true);
    }));
    return;
  }

  let raf = 0, running = false;
  const start = () => { if (running) return; running = true; t0 = performance.now() - (lastU || 0) * 1000; raf = requestAnimationFrame(frame); };
  let lastU = 0;
  const stop = () => { if (!running) return; running = false; cancelAnimationFrame(raf); lastU = (performance.now() - t0) / 1000; };
  document.fonts.ready.then(() => {
    layout();
    addEventListener('resize', () => { const w = body.getBoundingClientRect().width; if (Math.abs(w - W) > 1) layout(); });
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(body);
  });
})();
