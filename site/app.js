(() => {
  const data = window.KNACK || { skills: [], community: { skills: [], lists: [] } };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
  const star = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>';

  // ── Copy buttons (event delegation covers dynamic content too)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    e.stopPropagation();
    const text = btn.dataset.copy || btn.parentElement.querySelector('code')?.textContent || '';
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const label = btn.textContent;
    btn.textContent = 'Copied'; btn.classList.add('done');
    setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1400);
  });

  // ── Install tabs (roving tabindex + arrow keys)
  const tabs = $$('.tabs [role=tab]');
  const select = (tab) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next); next.focus();
    });
  });

  // ── Nav border on scroll
  const nav = $('.nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });

  // ── Hero reel: honor reduced motion, allow pause
  const reel = $('#reel'), toggle = $('#reelToggle');
  const setToggle = () => { toggle.textContent = reel.paused ? '▶' : '❚❚'; toggle.setAttribute('aria-label', reel.paused ? 'Play video' : 'Pause video'); };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let userPaused = reduced;
  if (reduced) { reel.removeAttribute('autoplay'); reel.pause(); }
  toggle.addEventListener('click', () => { userPaused = !reel.paused; reel.paused ? reel.play() : reel.pause(); });
  // Autoplay attributes are unreliable (background tabs, embedded views): play when visible, pause off-screen.
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !userPaused) reel.play().catch(() => {});
    else if (!e.isIntersecting) reel.pause();
  }, { threshold: 0.25 }).observe(reel);
  reel.addEventListener('play', setToggle); reel.addEventListener('pause', setToggle);
  setToggle();

  // ── Knack skill cards
  const grid = $('#skillGrid');
  const renderSkills = (cat) => {
    const list = data.skills.filter((s) => cat === 'all' || s.category === cat);
    grid.innerHTML = list.map((s) => `
      <button class="card" data-skill="${esc(s.name)}" aria-haspopup="dialog">
        <div class="thumb">${s.preview ? `<img src="${esc(s.preview)}" alt="" loading="lazy" />` : ''}</div>
        <div class="body">
          <div class="top"><h3>${esc(s.title)}</h3><span class="chip ${esc(s.category)}">${esc(s.category)}</span></div>
          <p>${esc(s.tagline || s.description.split('. ')[0] + '.')}</p>
          <div class="tags">${s.model ? `<span class="badge">${esc(s.model === 'opus' ? 'Claude Opus' : s.model)}</span>` : ''}${s.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        </div>
      </button>`).join('') || '<p class="empty">No skills in this category yet.</p>';
  };

  // ── Community list
  const listEl = $('#communityList');
  let cCat = 'all', q = '';
  const renderCommunity = () => {
    const needle = q.trim().toLowerCase();
    const items = data.community.skills.filter((s) =>
      (cCat === 'all' || s.category === cCat) &&
      (!needle || [s.name, s.author, s.description, s.category].join(' ').toLowerCase().includes(needle)));
    listEl.innerHTML = items.map((s, i) => `
      <li class="item">
        <span class="rank">${String(i + 1).padStart(2, '0')}</span>
        <div class="main">
          <div class="name"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a><span class="by">by ${esc(s.author)}</span><span class="chip ${esc(s.category)}">${esc(s.category)}</span></div>
          <p class="desc">${esc(s.description)}</p>
        </div>
        <span class="stars" title="GitHub stars of ${esc(s.repo)}">${star}${fmt(s.stars || 0)}</span>
        <button class="copy" data-copy="${esc(s.install)}" aria-label="Copy install command for ${esc(s.name)}">Install</button>
      </li>`).join('') || '<li class="empty">No matches. Try another search.</li>';
  };
  $('#q').addEventListener('input', (e) => { q = e.target.value; renderCommunity(); });
  $('#lists').innerHTML = 'Looking for more? ' + (data.community.lists || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>`).join(' · ');

  // ── Filters
  $$('.filters').forEach((group) => group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', group).forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (group.dataset.filter === 'skills') renderSkills(b.dataset.cat);
    else { cCat = b.dataset.cat; renderCommunity(); }
  }));

  // ── Drawer (native <dialog>: focus trap + Esc for free)
  const drawer = $('#drawer');
  const open = (name, push = true) => {
    const s = data.skills.find((x) => x.name === name);
    if (!s) return;
    $('#drawerTitle').textContent = s.title;
    $('#drawerTagline').textContent = s.tagline || '';
    const cat = $('#drawerCat'); cat.textContent = s.category; cat.className = 'chip ' + s.category;
    $('#drawerNpx').textContent = s.install.npx;
    $('#drawerMeta').innerHTML = [
      `<span class="tag">v${esc(s.version)}</span>`,
      s.model ? `<span class="badge">model: ${esc(s.model)}</span>` : '',
      `<span class="tag">${s.scripts.length} script${s.scripts.length === 1 ? '' : 's'}</span>`,
      `<a class="tag" href="${esc(s.url)}" target="_blank" rel="noopener">View source ↗</a>`,
    ].join('');
    $('#drawerBody').innerHTML = s.readmeHtml;
    $$('#drawerBody table').forEach((t) => t.setAttribute('tabindex', '0'));
    drawer.showModal();
    drawer.scrollTop = 0;
    if (push) history.replaceState(null, '', '#skill/' + name);
  };
  grid.addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) open(c.dataset.skill); });
  $('#drawerClose').addEventListener('click', () => drawer.close());
  drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.close(); });
  drawer.addEventListener('close', () => { if (location.hash.startsWith('#skill/')) history.replaceState(null, '', '#skills'); });

  // ── GitHub star count for this repo (best-effort)
  fetch(`https://api.github.com/repos/${data.repo}`).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && j.stargazers_count > 0) $('[data-gh]').insertAdjacentHTML('beforeend', `<span class="count">${fmt(j.stargazers_count)}</span>`);
  }).catch(() => {});

  renderSkills('all');
  renderCommunity();
  const m = location.hash.match(/^#skill\/([\w-]+)/);
  if (m) open(m[1], false);
})();
