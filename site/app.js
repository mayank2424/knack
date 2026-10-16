(() => {
  document.documentElement.classList.add('js');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  // Copy buttons: copy the sibling <code>, or data-copy.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const text = btn.dataset.copy || btn.parentElement.querySelector('code')?.textContent || '';
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const icon = btn.classList.contains('icon');
    const label = btn.textContent;
    if (!icon) btn.textContent = 'Copied';
    btn.dataset.done = '';
    setTimeout(() => { if (!icon) btn.textContent = label; delete btn.dataset.done; }, 1400);
  });

  // Install tabs with roving tabindex.
  const tabs = $$('.tabs [role=tab]');
  const select = (tab) => tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
  });
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next); next.focus();
    });
  });

  // Evidence videos: play only while visible, never when reduced motion is set.
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vids = $$('video[data-autoplay]');
  if (!reduced && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
      if (isIntersecting) target.play().catch(() => {}); else target.pause();
    }), { threshold: 0.35 });
    vids.forEach((v) => io.observe(v));
  } else vids.forEach((v) => { v.controls = true; });

  // Sound toggle for evidence videos that carry audio.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.sound');
    if (!b) return;
    const v = b.parentElement.querySelector('video');
    v.muted = !v.muted;
    if (!v.muted) v.play().catch(() => {});
    b.setAttribute('aria-pressed', String(!v.muted));
  });

  // Catalog filter + search (rows are server-rendered; this only hides).
  const table = $('#catalogTable');
  if (table) {
    const rows = $$('tbody tr', table);
    const empty = $('#catalogEmpty');
    let cat = 'all', q = '';
    const apply = () => {
      const needle = q.trim().toLowerCase();
      let shown = 0;
      rows.forEach((r) => {
        const ok = (cat === 'all' || r.dataset.cat === cat) && (!needle || r.dataset.search.includes(needle));
        r.hidden = !ok; if (ok) shown++;
      });
      empty.hidden = shown > 0;
    };
    $('#q').addEventListener('input', (e) => { q = e.target.value; apply(); });
    $$('.seg button').forEach((b) => b.addEventListener('click', () => {
      $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      cat = b.dataset.cat; apply();
    }));
  }


  // ── Hero: replay of real agent runs (commands, numbers and images all come from real skill runs).
  const agent = $('#agent');
  if (agent) {
    const base = document.querySelector('link[href$="styles.css"]').getAttribute('href').replace('styles.css', '');
    const SCENARIOS = [
      {
        skill: 'responsive-qa', phone: true,
        prompt: 'Check the landing page on mobile and fix what breaks.',
        before: 'assets/evidence/responsive-before.png', after: 'assets/evidence/responsive-after.png',
        tagBefore: '375px · 12 errors', tagAfter: '375px · 0 errors',
        steps: [
          { t: 'Skill', a: 'responsive-qa', ms: 500 },
          { t: 'Bash', a: 'node sweep.mjs broken-page.html --widths 375,1280', ms: 1500, out: ['bad', '✖ 12 errors  ⚠ 7 warnings  scrolls sideways +409px'], d: '3.5s' },
          { t: 'Read', a: 'shots/broken-page/375x812.png', ms: 900, view: 'before' },
          { t: 'Edit', a: 'broken-page.html  +44 −51', ms: 1100 },
          { t: 'Bash', a: 'node sweep.mjs fixed-page.html --widths 375,1280', ms: 1400, out: ['good', '✓ No errors  no warnings  2 viewports'], d: '3.4s', view: 'after' },
        ],
        done: '<b>✓</b> Fixed 12 layout bugs. Verified at 375px and 1280px.',
        stat: ['12 errors', '0 errors'], tool: '6.9s of tool time · 2 viewports',
      },
      {
        skill: 'a11y-audit', phone: false,
        prompt: 'Audit the page for accessibility and fix the serious issues.',
        before: 'assets/evidence/a11y.png', after: 'assets/evidence/a11y-after.png',
        tagBefore: '4 critical · 12 serious', tagAfter: '0 critical · 0 serious',
        steps: [
          { t: 'Skill', a: 'a11y-audit', ms: 500 },
          { t: 'Bash', a: 'node audit.mjs inaccessible-page.html', ms: 1700, out: ['bad', '✖ 4 critical · 12 serious · keyboard trap at #news-name'], d: '6.8s' },
          { t: 'Read', a: 'report.md, inaccessible-page.annotated.png', ms: 900, view: 'before' },
          { t: 'Edit', a: 'accessible-page.html  +125 −107', ms: 1200 },
          { t: 'Bash', a: 'node audit.mjs accessible-page.html --fail-on serious', ms: 1600, out: ['good', '✓ 0 issues · 29 focus stops, all visible'], d: '7.0s', view: 'after' },
        ],
        done: '<b>✓</b> No critical or serious issues left. Keyboard pass completes.',
        stat: ['16 critical + serious', '0'], tool: '13.8s of tool time · 29 focus stops',
      },
    ];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let visible = true, token = 0;
    const gate = () => new Promise((res) => { const check = () => (visible && !document.hidden ? res() : setTimeout(check, 200)); check(); });
    const sleep = async (ms, my) => { const end = Date.now() + ms; while (Date.now() < end) { if (my !== token) throw 0; await gate(); await new Promise((r) => setTimeout(r, Math.min(50, end - Date.now()))); } };
    const steps = $('#agentSteps'), view = $('#agentView'), done = $('#agentDone');
    const typeInto = async (el, text, cps, my) => { el.textContent = ''; for (let i = 1; i <= text.length; i++) { el.textContent = text.slice(0, i); await sleep(1000 / cps, my); } };
    const li = (st) => {
      const el = document.createElement('li');
      el.className = 'step';
      el.innerHTML = `<span class="st" aria-hidden="true"></span><span class="tool" data-t="${st.t}">${st.t}</span><span class="arg"></span><span class="dur"></span>`;
      steps.appendChild(el);
      return el;
    };
    const setScene = (sc) => {
      $('#agentSkill').textContent = sc.skill;
      $('#viewBefore').src = base + sc.before; $('#viewAfter').src = base + sc.after;
      view.classList.toggle('phone', sc.phone);
      view.classList.remove('show', 'fixed');
      $('#viewTag').textContent = sc.tagBefore;
      steps.innerHTML = ''; done.classList.remove('show'); done.innerHTML = '';
    };
    const finish = (sc) => {
      setScene(sc); $('#agentPrompt').textContent = sc.prompt;
      sc.steps.forEach((st) => { const el = li(st); el.classList.add('done'); el.style.animation = 'none'; el.querySelector('.arg').textContent = st.a; el.querySelector('.dur').textContent = st.d || ''; if (st.out) el.insertAdjacentHTML('beforeend', `<span class="out ${st.out[0]}">${st.out[1]}</span>`); });
      view.classList.add('show', 'fixed'); $('#viewTag').textContent = sc.tagAfter; done.innerHTML = sc.done; done.classList.add('show');
    };
    // Run cards beside the panel: one per scenario, the playing one highlighted; click to replay it.
    const runsEl = $('#agentRuns');
    const cards = SCENARIOS.map((sc, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'run-card'; b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="rc-top"><span class="rc-skill">${sc.skill}</span><span class="rc-state"></span></span>
        <span class="rc-prompt">“${sc.prompt}”</span>
        <span class="rc-stat"><s>${sc.stat[0]}</s><span aria-hidden="true">→</span><b>${sc.stat[1]}</b></span>
        <span class="rc-tool">${sc.tool}</span><span class="rc-bar"></span>`;
      b.addEventListener('click', () => { agent.classList.remove('running'); reduced ? (mark(i, 'done'), finish(sc)) : loop(i); });
      runsEl && runsEl.appendChild(b);
      return b;
    });
    const mark = (i, state) => cards.forEach((c, j) => {
      c.setAttribute('aria-pressed', String(i === j));
      c.dataset.state = i === j ? state : '';
      c.querySelector('.rc-state').textContent = i === j ? (state === 'done' ? '✓ verified' : 'running') : '';
    });
    const play = async (sc, my) => {
      const idx = SCENARIOS.indexOf(sc);
      mark(idx, 'run');
      setScene(sc);
      agent.classList.add('running');
      await typeInto($('#agentPrompt'), sc.prompt, 55, my);
      await sleep(350, my);
      for (const st of sc.steps) {
        const el = li(st);
        await typeInto(el.querySelector('.arg'), st.a, 70, my);
        await sleep(st.ms, my);
        el.classList.add('done');
        el.querySelector('.dur').textContent = st.d || '';
        if (st.out) el.insertAdjacentHTML('beforeend', `<span class="out ${st.out[0]}">${st.out[1]}</span>`);
        if (st.view === 'before') view.classList.add('show');
        if (st.view === 'after') { view.classList.add('fixed'); $('#viewTag').textContent = sc.tagAfter; }
        await sleep(260, my);
      }
      done.innerHTML = sc.done; done.classList.add('show');
      agent.classList.remove('running');
      mark(idx, 'done');
      await sleep(3200, my);
    };
    const loop = async (from = 0) => {
      const my = ++token;
      try { for (let i = from; ; i = (i + 1) % SCENARIOS.length) await play(SCENARIOS[i], my); } catch (_) { /* restarted */ }
    };
    if (reduced) { mark(0, 'done'); finish(SCENARIOS[0]); }
    else {
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0.15 }).observe(agent);
      loop();
      $('#agentReplay').addEventListener('click', () => { agent.classList.remove('running'); loop(Math.max(0, cards.findIndex((c) => c.getAttribute('aria-pressed') === 'true'))); });
    }
    if (reduced) $('#agentReplay').addEventListener('click', () => finish(SCENARIOS[0]));
  }

  // Light up each agent trail once it scrolls into view.
  if ('IntersectionObserver' in window) {
    const tio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); tio.unobserve(e.target); } }), { threshold: 0.6 });
    $$('.trail').forEach((t) => tio.observe(t));
  } else $$('.trail').forEach((t) => t.classList.add('in'));

  // ── Navigation: compact on scroll, sliding hover pill, scroll-spy, mobile menu
  const head = $('#siteHead'), nav = $('#siteNav');
  if (head && nav) {
    const onScroll = () => head.classList.toggle('scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    const pill = nav.querySelector('.nav-pill'), links = $$('#siteNav a');
    const moveTo = (a) => {
      if (!a || matchMedia('(max-width: 860px)').matches) { pill.style.opacity = '0'; return; }
      pill.style.width = `${a.offsetWidth}px`; pill.style.transform = `translateX(${a.offsetLeft}px)`; pill.style.opacity = '1';
    };
    links.forEach((a) => { a.addEventListener('mouseenter', () => moveTo(a)); a.addEventListener('focus', () => moveTo(a)); });
    nav.addEventListener('mouseleave', () => (pill.style.opacity = '0'));
    // scroll-spy (home page only: the targets exist there)
    const targets = links.map((a) => document.getElementById(a.dataset.spy)).filter(Boolean);
    if (targets.length && 'IntersectionObserver' in window) {
      const seen = new Map();
      const spy = new IntersectionObserver((es) => {
        es.forEach((e) => seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0));
        let best = null, br = 0; seen.forEach((r, id) => { if (r > br) { br = r; best = id; } });
        links.forEach((a) => a.classList.toggle('is-active', a.dataset.spy === best));
      }, { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.01, 0.5, 1] });
      targets.forEach((t) => spy.observe(t));
    }
    const menu = $('.nav-menu');
    const setOpen = (o) => { nav.classList.toggle('open', o); menu.setAttribute('aria-expanded', String(o)); };
    menu && menu.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    links.forEach((a) => a.addEventListener('click', () => setOpen(false)));
    addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    document.addEventListener('click', (e) => { if (!head.contains(e.target)) setOpen(false); });
  }

  // Live star count for this repo, shown only once there are stars.
  const gh = $('[data-gh]');
  if (gh) fetch('https://api.github.com/repos/mayank2424/knack').then((r) => (r.ok ? r.json() : null)).then((j) => {
    const n = j && j.stargazers_count;
    if (n > 0) gh.insertAdjacentHTML('beforeend', `<span class="stars">${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n}</span>`);
  }).catch(() => {});
})();
