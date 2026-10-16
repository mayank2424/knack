(() => {
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

  // Live star count for this repo, shown only once there are stars.
  const gh = $('[data-gh]');
  if (gh) fetch('https://api.github.com/repos/mayank2424/knack').then((r) => (r.ok ? r.json() : null)).then((j) => {
    const n = j && j.stargazers_count;
    if (n > 0) gh.insertAdjacentHTML('beforeend', `<span class="stars">${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n}</span>`);
  }).catch(() => {});
})();
