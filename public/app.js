/* Search Checker — front-end. No framework, no build step. */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };

  const flag = (code) =>
    code && /^[A-Z]{2}$/i.test(code)
      ? String.fromCodePoint(...code.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0)))
      : '🌐';
  const fmtBytes = (b) => {
    if (b == null) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
    return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  };
  const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  const timeAgo = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const shortUrl = (u) => {
    try {
      const x = new URL(u);
      const rest = (x.pathname === '/' ? '' : x.pathname) + x.search;
      return x.hostname.replace(/^www\./, '') + (rest.length > 60 ? rest.slice(0, 57) + '…' : rest);
    } catch {
      return u;
    }
  };
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`sc:${k}`);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`sc:${k}`, JSON.stringify(v));
      } catch {
        /* private mode etc. */
      }
    },
  };
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
    return data;
  }
  function toast(msg, kind = '') {
    const el = h('div', { class: `toast ${kind}`, text: msg });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    status: null,
    countries: [],
    countryByCode: new Map(),
    selected: store.get('countries', ['']), // '' = any location
    mode: store.get('mode', 'url'),
    cards: new Map(), // jobId -> { el, job, es }
    batch: [], // jobIds in the current batch (display order)
    batchOptions: null,
    history: [],
    viewer: { ids: [], index: -1, job: null, text: null, html: null },
  };

  const countryName = (code) => (code ? (state.countryByCode.get(code) || { name: code }).name : 'Any location');

  // ------------------------------------------------------------------
  // Connection status
  // ------------------------------------------------------------------
  function setConn(kind, text, title = '') {
    const btn = $('#connBtn');
    btn.className = `conn ${kind}`;
    $('#connText').textContent = text;
    btn.title = title || text;
  }

  async function loadStatus() {
    const data = await api('/api/status');
    state.status = data.settings;
    const plan = new Map((data.settings.planCountries || []).map((c) => [c.code, c.count]));
    state.countries = data.countries.map((c) => ({ ...c, count: plan.get(c.code) }));
    for (const [code, count] of plan) {
      if (!state.countries.some((c) => c.code === code)) state.countries.push({ code, name: code, locale: 'en-US', count });
    }
    state.countries.sort((a, b) => (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name));
    state.countryByCode = new Map(state.countries.map((c) => [c.code, c]));
    state.selected = state.selected.filter((c) => c === '' || state.countryByCode.has(c));
    if (!state.selected.length) state.selected = [''];
    renderLanguageOptions();
    renderChips();
    $('#setupBanner').hidden = data.settings.configured;
    if (!data.settings.configured) setConn('warn', 'Not connected', 'Add your Webshare credentials');
    return data;
  }

  async function checkConnection({ force = false } = {}) {
    if (!state.status || !state.status.configured) return;
    const cached = sessionCache('conn');
    if (cached && !force) return showConnResult(cached);
    setConn('', 'Testing proxy…');
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: {} });
      sessionCache('conn', r, 10 * 60 * 1000);
      showConnResult(r);
      return r;
    } catch (err) {
      setConn('err', 'Connection check failed', err.message);
    }
  }
  function showConnResult(r) {
    if (r.ok) {
      const loc = [r.ip.city, r.ip.country].filter(Boolean).join(', ');
      setConn('ok', `Connected · ${flag(r.ip.country)} ${r.ip.ip}`, `Webshare is working. Sample exit IP ${r.ip.ip}${loc ? ` (${loc})` : ''}${r.ip.org ? ` — ${r.ip.org}` : ''}`);
    } else {
      setConn('err', 'Proxy error', `${r.error} ${r.hint || ''}`);
    }
  }
  function sessionCache(key, value, ttl) {
    try {
      if (value === undefined) {
        const v = JSON.parse(sessionStorage.getItem(`sc:${key}`) || 'null');
        return v && v.exp > Date.now() ? v.value : null;
      }
      if (value === null) sessionStorage.removeItem(`sc:${key}`);
      else sessionStorage.setItem(`sc:${key}`, JSON.stringify({ value, exp: Date.now() + ttl }));
    } catch {
      return null;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Composer: mode, segmented controls, options
  // ------------------------------------------------------------------
  const form = $('#viewForm');
  const urlInput = $('#url');

  function setMode(mode) {
    state.mode = mode;
    store.set('mode', mode);
    $$('.composer .mode-switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    $('#engine').hidden = mode !== 'search';
    urlInput.placeholder =
      mode === 'search' ? 'Type a search query — e.g. best running shoes' : 'Paste a URL — e.g. https://www.google.com/search?q=coffee+near+me';
    urlInput.setAttribute('aria-label', mode === 'search' ? 'Search query' : 'URL to view');
    urlInput.setAttribute('inputmode', mode === 'search' ? 'search' : 'url');
  }
  $$('.composer .mode-switch button').forEach((b) => b.addEventListener('click', () => {
    setMode(b.dataset.mode);
    urlInput.focus();
  }));

  function segValue(name) {
    const btn = $(`.segmented[data-name="${name}"] [aria-checked="true"]`);
    return btn ? btn.dataset.value : null;
  }
  function setSeg(name, value) {
    $$(`.segmented[data-name="${name}"] button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === value)));
  }
  $$('.segmented[data-name]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      setSeg(seg.dataset.name, b.dataset.value);
      saveOptions();
    });
  });

  $('#moreBtn').addEventListener('click', () => {
    const panel = $('#moreOptions');
    panel.hidden = !panel.hidden;
    $('#moreBtn').setAttribute('aria-expanded', String(!panel.hidden));
    store.set('moreOpen', !panel.hidden);
  });
  $('#moreOptions').addEventListener('change', saveOptions);
  $('#engine').addEventListener('change', saveOptions);

  function readOptions() {
    const f = form.elements;
    return {
      device: segValue('device'),
      ipMode: segValue('ipMode'),
      waitUntil: f.waitUntil.value,
      extraWaitMs: Number(f.extraWaitMs.value),
      language: f.language.value,
      bandwidth: f.bandwidth.value,
      retries: Number(f.retries.value),
      fullPage: f.fullPage.checked,
      retryOnBlock: f.retryOnBlock.checked,
      matchTimezone: f.matchTimezone.checked,
    };
  }
  function saveOptions() {
    store.set('options', { ...readOptions(), engine: $('#engine').value });
  }
  function restoreOptions() {
    const o = store.get('options', null);
    if (!o) return;
    const f = form.elements;
    if (o.device) setSeg('device', o.device);
    if (o.ipMode) setSeg('ipMode', o.ipMode);
    for (const k of ['waitUntil', 'extraWaitMs', 'bandwidth', 'retries']) if (o[k] != null && f[k]) f[k].value = String(o[k]);
    for (const k of ['fullPage', 'retryOnBlock', 'matchTimezone']) if (typeof o[k] === 'boolean') f[k].checked = o[k];
    if (o.engine) $('#engine').value = o.engine;
    state.pendingLanguage = o.language;
  }

  function renderLanguageOptions() {
    const sel = $('#languageSelect');
    const current = state.pendingLanguage || sel.value;
    const seen = new Set();
    sel.replaceChildren(h('option', { value: 'auto', text: 'Match location' }));
    const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(undefined, { type: 'language' }) : null;
    const locales = state.countries.map((c) => c.locale).filter((l) => l && !seen.has(l) && seen.add(l));
    locales.sort();
    for (const l of locales) {
      let label = l;
      try {
        if (names) label = `${names.of(l)} (${l})`;
      } catch {
        /* ignore */
      }
      sel.append(h('option', { value: l, text: label }));
    }
    sel.value = [...sel.options].some((o) => o.value === current) ? current : 'auto';
    delete state.pendingLanguage;
  }

  // ------------------------------------------------------------------
  // Country picker
  // ------------------------------------------------------------------
  const popover = $('#countryPopover');
  const countrySearch = $('#countrySearch');
  const countryList = $('#countryList');
  let activeIndex = 0;

  function renderChips() {
    const wrap = $('#countryChips');
    wrap.replaceChildren(
      ...state.selected.map((code) =>
        h(
          'span',
          { class: 'chip' },
          h('span', { text: flag(code) }),
          h('span', { text: code ? countryName(code) : 'Any location' }),
          h(
            'button',
            {
              type: 'button',
              class: 'x',
              'aria-label': `Remove ${countryName(code)}`,
              onclick: () => toggleCountry(code, false),
            },
            '×'
          )
        )
      )
    );
    store.set('countries', state.selected);
    const n = state.selected.filter(Boolean).length;
    $('#submitBtn .label').textContent = n > 1 ? `View in ${n} countries` : 'View';
  }

  function toggleCountry(code, force) {
    const has = state.selected.includes(code);
    const on = force === undefined ? !has : force;
    if (code === '') {
      state.selected = [''];
    } else if (on && !has) {
      state.selected = state.selected.filter(Boolean).concat(code);
      if (state.selected.length > 12) {
        state.selected.pop();
        toast('Up to 12 locations at once.');
      }
    } else if (!on && has) {
      state.selected = state.selected.filter((c) => c !== code);
    }
    if (!state.selected.length) state.selected = [''];
    renderChips();
    if (!popover.hidden) renderCountryList();
  }

  function filteredCountries() {
    const q = countrySearch.value.trim().toLowerCase();
    const all = [{ code: '', name: 'Any location', locale: '' }, ...state.countries];
    if (!q) return all;
    return all.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q || (c.code === '' && 'any random'.includes(q)));
  }

  function renderCountryList() {
    const items = filteredCountries();
    activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
    countryList.replaceChildren(
      ...items.map((c, i) =>
        h(
          'li',
          {
            role: 'option',
            'aria-selected': String(state.selected.includes(c.code)),
            class: i === activeIndex ? 'active' : '',
            'data-code': c.code,
            onmousedown: (e) => e.preventDefault(),
            onclick: () => {
              toggleCountry(c.code);
              countrySearch.focus();
            },
          },
          h('span', { class: 'check', text: state.selected.includes(c.code) ? '✓' : '' }),
          h('span', { text: flag(c.code) }),
          h('span', { text: c.name }),
          h('span', { class: 'cc', text: c.count ? `${c.code} · ${c.count.toLocaleString()}` : c.code })
        )
      )
    );
    if (!items.length) countryList.append(h('li', { class: 'muted', text: 'No matching country' }));
    const active = countryList.children[activeIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function openPopover() {
    popover.hidden = false;
    $('#addCountryBtn').setAttribute('aria-expanded', 'true');
    countrySearch.value = '';
    activeIndex = 0;
    renderCountryList();
    countrySearch.focus();
  }
  function closePopover() {
    popover.hidden = true;
    $('#addCountryBtn').setAttribute('aria-expanded', 'false');
  }
  $('#addCountryBtn').addEventListener('click', () => (popover.hidden ? openPopover() : closePopover()));
  countrySearch.addEventListener('input', () => {
    activeIndex = 0;
    renderCountryList();
  });
  countrySearch.addEventListener('keydown', (e) => {
    const items = filteredCountries();
    if (e.key === 'ArrowDown') {
      activeIndex = Math.min(items.length - 1, activeIndex + 1);
      renderCountryList();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      activeIndex = Math.max(0, activeIndex - 1);
      renderCountryList();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[activeIndex]) toggleCountry(items[activeIndex].code);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
      $('#addCountryBtn').focus();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!popover.hidden && !e.target.closest('.country-picker')) closePopover();
  });

  // ------------------------------------------------------------------
  // Submitting views
  // ------------------------------------------------------------------
  const ENGINES = {
    google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    yahoo: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
  };

  function showFormError(msg) {
    const el = $('#formError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function targetUrl() {
    const raw = urlInput.value.trim();
    if (!raw) throw new Error(state.mode === 'search' ? 'Type something to search for.' : 'Paste a URL to view.');
    if (state.mode === 'search') return ENGINES[$('#engine').value](raw);
    let s = raw;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      // Looks like a search, not a URL? Be helpful.
      if (/\s/.test(s) || !/\./.test(s)) throw new Error('That looks like a search query — switch to “Search query”, or paste a full URL.');
      s = `https://${s}`;
    }
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      return u.toString();
    } catch {
      throw new Error("That doesn't look like a valid web address.");
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFormError('');
    if (!state.status || !state.status.configured) {
      openSettings();
      return;
    }
    let url;
    try {
      url = targetUrl();
    } catch (err) {
      showFormError(err.message);
      urlInput.focus();
      return;
    }
    rememberUrl(state.mode === 'search' ? null : url);
    await startBatch({ url, countries: state.selected.slice(), ...readOptions() });
  });

  async function startBatch(options) {
    const btn = $('#submitBtn');
    btn.disabled = true;
    try {
      const { jobs } = await api('/api/views', { method: 'POST', body: options });
      state.batchOptions = options;
      clearCards();
      state.batch = jobs.map((j) => j.id);
      renderBatchBar(options);
      for (const job of jobs) addCard(job);
      $('#results').classList.toggle('single', jobs.length === 1);
      $('#emptyState').hidden = true;
      refreshHistorySoon();
      $('#batchBar').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (err.data && err.data.code === 'NOT_CONFIGURED') openSettings();
      showFormError(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function renderBatchBar(options) {
    $('#batchBar').hidden = false;
    $('#batchTitle').textContent = shortUrl(options.url);
    $('#batchTitle').title = options.url;
  }

  $('#rerunBatchBtn').addEventListener('click', () => state.batchOptions && startBatch(state.batchOptions));
  $('#clearBatchBtn').addEventListener('click', () => {
    clearCards();
    $('#batchBar').hidden = true;
    $('#emptyState').hidden = false;
  });

  $$('.example').forEach((b) =>
    b.addEventListener('click', () => {
      setMode('url');
      urlInput.value = b.dataset.url;
      state.selected = b.dataset.countries ? b.dataset.countries.split(',') : [''];
      renderChips();
      if (b.dataset.device) setSeg('device', b.dataset.device);
      form.requestSubmit();
    })
  );

  function rememberUrl(url) {
    if (!url) return;
    const list = [url, ...store.get('urls', []).filter((u) => u !== url)].slice(0, 15);
    store.set('urls', list);
    renderUrlHistory();
  }
  function renderUrlHistory() {
    $('#urlHistory').replaceChildren(...store.get('urls', []).map((u) => h('option', { value: u })));
  }

  // ------------------------------------------------------------------
  // Result cards
  // ------------------------------------------------------------------
  const STEP_ORDER = ['connecting', 'navigating', 'settling', 'capturing'];

  function clearCards() {
    for (const { es } of state.cards.values()) if (es) es.close();
    state.cards.clear();
    state.batch = [];
    $('#results').replaceChildren();
  }

  function addCard(job, replaceEl) {
    const el = $('#cardTpl').content.firstElementChild.cloneNode(true);
    el.dataset.id = job.id;
    const entry = { el, job, es: null };
    state.cards.set(job.id, entry);
    el.querySelector('.shot').addEventListener('click', () => entry.job.hasScreenshot && openViewer(entry.job.id, state.batch));
    el.querySelector('[data-act="open"]').addEventListener('click', () => openViewer(entry.job.id, state.batch));
    el.querySelector('[data-act="retry"]').addEventListener('click', () => retryJob(entry.job.id));
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => api(`/api/jobs/${entry.job.id}/cancel`, { method: 'POST' }).catch(() => {}));
    if (replaceEl) replaceEl.replaceWith(el);
    else $('#results').append(el);
    renderCard(entry);
    if (job.status === 'queued' || job.status === 'running') subscribe(entry);
    return entry;
  }

  function subscribe(entry) {
    const es = new EventSource(`/api/jobs/${entry.job.id}/events`);
    entry.es = es;
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      const j = entry.job;
      switch (ev.type) {
        case 'phase':
          j.phase = ev.phase;
          j.message = ev.message;
          if (ev.phase !== 'queued' && j.status === 'queued') j.status = 'running';
          if (!j.startedAt && ev.phase === 'connecting') j.startedAt = new Date(ev.t).toISOString();
          break;
        case 'attempt':
          j.attempt = ev.attempt;
          j.maxAttempts = ev.maxAttempts;
          break;
        case 'ip':
          j.exitIp = ev;
          break;
        case 'preview':
          j.previewUrl = ev.url;
          break;
        case 'snapshot':
          entry.job = ev.job;
          es.close();
          entry.es = null;
          refreshHistorySoon();
          if (state.viewer.job && state.viewer.job.id === ev.job.id) openViewer(ev.job.id, state.viewer.ids);
          break;
        default:
          break;
      }
      renderCard(entry);
    };
    es.onerror = () => {
      // Browser auto-reconnects; if the job finished meanwhile, fetch the final state.
      if (es.readyState === EventSource.CLOSED) {
        api(`/api/jobs/${entry.job.id}`)
          .then((full) => {
            entry.job = full;
            renderCard(entry);
          })
          .catch(() => {});
      }
    };
  }

  function renderCard({ el, job }) {
    const o = job.options || {};
    const device = job.device || o.device;
    el.className = `card ${job.status} ${device || ''}`;
    el.querySelector('.flag').textContent = flag(job.country);
    el.querySelector('.loc').textContent = countryName(job.country);
    el.querySelector('.sub').textContent = [cap(device), job.ipMode === 'sticky' ? 'Sticky IP' : 'Rotating IP'].join(' · ');

    // State badge
    const badge = el.querySelector('.state');
    let cls = 'run';
    let text = job.phase === 'queued' ? 'Queued' : 'Working';
    if (job.status === 'running' && job.attempt > 1) text = `Attempt ${job.attempt}/${job.maxAttempts}`;
    if (job.status === 'done') {
      const s = job.httpStatus;
      if (job.blocked) {
        cls = 'warn';
        text = 'Blocked';
      } else if (s && s >= 400) {
        cls = 'err';
        text = `HTTP ${s}`;
      } else {
        cls = 'ok';
        text = s ? `HTTP ${s}` : 'Loaded';
      }
    } else if (job.status === 'error') {
      cls = 'err';
      text = 'Failed';
    } else if (job.status === 'cancelled') {
      cls = '';
      text = 'Cancelled';
    }
    badge.className = `badge state ${cls}`;
    badge.textContent = text;

    // Screenshot / placeholder
    const img = el.querySelector('.shot img');
    const src = job.status === 'done' ? `/api/jobs/${job.id}/screenshot.jpg` : job.previewUrl;
    if (src && img.getAttribute('src') !== src) {
      const probe = new Image();
      probe.onload = () => {
        img.src = src;
        img.hidden = false;
      };
      probe.src = src;
    }
    img.classList.toggle('preview', job.status !== 'done');
    img.alt = job.title ? `Screenshot: ${job.title}` : 'Screenshot';
    el.querySelector('.phase-msg').textContent = job.message || 'Starting…';
    const idx = STEP_ORDER.indexOf(job.phase);
    $$('.steps span', el).forEach((s) => {
      const i = STEP_ORDER.indexOf(s.dataset.step);
      s.className = i < idx ? 'past' : i === idx ? 'on' : '';
    });

    // IP line
    const ipLine = el.querySelector('.ip-line');
    const ip = job.exitIp;
    if (ip) {
      const loc = [ip.city, ip.region && ip.region !== ip.city ? ip.region : '', ip.country].filter(Boolean).join(', ');
      ipLine.replaceChildren(
        h('span', {}, 'IP ', h('span', { class: 'mono', text: ip.ip })),
        loc ? h('span', {}, flag(ip.country), ' ', loc) : null,
        ip.org ? h('span', { title: ip.org, text: ip.org.replace(/^AS\d+\s*/, '').slice(0, 36) }) : null
      );
      if (job.country && ip.country && ip.country.toUpperCase() !== job.country.toUpperCase()) {
        ipLine.append(h('span', { class: 'badge warn', text: `IP is in ${ip.country}` }));
      }
    } else {
      ipLine.replaceChildren(job.status === 'running' || job.status === 'queued' ? h('span', { text: 'Finding exit IP…' }) : '');
    }

    // Meta line
    const meta = el.querySelector('.meta-line');
    if (job.status === 'done') {
      meta.replaceChildren(
        job.title ? h('b', { text: job.title.length > 70 ? `${job.title.slice(0, 67)}…` : job.title, title: job.title }) : h('span', { text: 'Untitled page' }),
        h('span', { text: fmtMs(job.totalMs) }),
        h('span', { text: `${fmtBytes(job.bytes)} via proxy`, title: 'Approximate residential bandwidth used' })
      );
    } else meta.replaceChildren();

    // Alerts
    const alert = el.querySelector('.alert');
    if (job.status === 'done' && job.blocked) {
      alert.hidden = false;
      alert.className = 'alert warn';
      alert.replaceChildren(
        h('b', { text: job.blocked.reason }),
        h('span', { class: 'hint', text: `Shown after ${job.maxAttempts > 1 ? `${job.attempt} IPs` : '1 IP'}. Try “New IP”, Sticky mode, or a different location.` })
      );
    } else if (job.status === 'error' && job.error) {
      alert.hidden = false;
      alert.className = 'alert err';
      alert.replaceChildren(h('b', { text: job.error.message }), job.error.hint ? h('span', { class: 'hint', text: job.error.hint }) : null);
    } else if (job.status === 'done' && job.finalUrl && hostOf(job.finalUrl) !== hostOf(job.url)) {
      alert.hidden = false;
      alert.className = 'alert';
      alert.replaceChildren(h('span', { class: 'muted', text: `Redirected to ${shortUrl(job.finalUrl)}` }));
    } else alert.hidden = true;

    // Actions
    const active = job.status === 'queued' || job.status === 'running';
    el.querySelector('[data-act="cancel"]').hidden = !active;
    el.querySelector('[data-act="open"]').hidden = active && !job.previewUrl;
    el.querySelector('[data-act="open"]').disabled = active;
    el.querySelector('[data-act="retry"]').hidden = active;
    updateElapsed(el, job);
  }

  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  function updateElapsed(el, job) {
    const span = el.querySelector('.elapsed');
    if (job.status === 'running' || job.status === 'queued') {
      const start = new Date(job.startedAt || job.createdAt).getTime();
      span.textContent = `${((Date.now() - start) / 1000).toFixed(0)}s`;
    } else if (job.status === 'done' && job.attempt > 1) {
      span.textContent = `${job.attempt} attempts`;
    } else span.textContent = '';
  }
  setInterval(() => {
    for (const { el, job } of state.cards.values()) if (job.status === 'running' || job.status === 'queued') updateElapsed(el, job);
  }, 1000);

  async function retryJob(id) {
    const entry = state.cards.get(id);
    let job = entry ? entry.job : null;
    if (!job || !job.options) job = await api(`/api/jobs/${id}`);
    const opts = { ...job.options, countries: [job.options.country || ''] };
    delete opts.country;
    try {
      const { jobs } = await api('/api/views', { method: 'POST', body: opts });
      const fresh = jobs[0];
      if (entry) {
        if (entry.es) entry.es.close();
        state.cards.delete(id);
        state.batch = state.batch.map((x) => (x === id ? fresh.id : x));
        addCard(fresh, entry.el);
      } else {
        clearCards();
        state.batchOptions = { ...opts };
        state.batch = [fresh.id];
        renderBatchBar(opts);
        addCard(fresh);
        $('#results').classList.add('single');
        $('#emptyState').hidden = true;
      }
      refreshHistorySoon();
      return fresh;
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ------------------------------------------------------------------
  // History
  // ------------------------------------------------------------------
  let historyTimer = null;
  function refreshHistorySoon() {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(loadHistory, 300);
  }
  async function loadHistory() {
    try {
      const { jobs } = await api('/api/jobs?limit=100');
      state.history = jobs;
      renderHistory();
    } catch {
      /* ignore */
    }
  }
  function renderHistory() {
    const q = $('#historyFilter').value.trim().toLowerCase();
    const items = state.history.filter(
      (j) => !q || j.url.toLowerCase().includes(q) || (j.title || '').toLowerCase().includes(q) || countryName(j.country).toLowerCase().includes(q)
    );
    const list = $('#historyList');
    list.replaceChildren(
      ...items.map((j) => {
        const statusText =
          j.status === 'done'
            ? j.blocked
              ? `⚠ ${j.blocked.reason}`
              : `HTTP ${j.httpStatus ?? '—'}${j.title ? ` · ${j.title}` : ''}`
            : j.status === 'error'
              ? `✕ ${j.error ? j.error.message : 'Failed'}`
              : j.status === 'cancelled'
                ? 'Cancelled'
                : j.message || 'Working…';
        return h(
          'li',
          {
            tabindex: '0',
            onclick: (e) => {
              if (e.target.closest('.h-del')) return;
              openViewer(j.id, items.map((x) => x.id));
            },
            onkeydown: (e) => {
              if (e.key === 'Enter') openViewer(j.id, items.map((x) => x.id));
            },
          },
          h('span', { class: 'h-flag', text: flag(j.country), title: countryName(j.country) }),
          h(
            'div',
            { class: 'h-main' },
            h('div', { class: 'h-url', text: shortUrl(j.url), title: j.url }),
            h('div', { class: 'h-sub', text: `${countryName(j.country)} · ${cap(j.device)}${j.exitIp ? ` · ${j.exitIp.ip}` : ''} · ${statusText}` })
          ),
          h('span', { class: 'h-time', text: timeAgo(j.createdAt), title: new Date(j.createdAt).toLocaleString() }),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn h-del',
              'aria-label': 'Delete',
              title: 'Delete',
              onclick: async () => {
                await api(`/api/jobs/${j.id}`, { method: 'DELETE' }).catch(() => {});
                state.history = state.history.filter((x) => x.id !== j.id);
                renderHistory();
              },
            },
            '×'
          )
        );
      })
    );
    $('#historyEmpty').hidden = items.length > 0;
    $('#historyEmpty').textContent = state.history.length ? 'No views match that filter.' : 'Nothing yet — your views will show up here.';
    $('#clearHistoryBtn').hidden = !state.history.length;
  }
  $('#historyFilter').addEventListener('input', renderHistory);
  $('#clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Delete all saved views and screenshots?')) return;
    await api('/api/jobs', { method: 'DELETE' });
    loadHistory();
  });

  // ------------------------------------------------------------------
  // Viewer
  // ------------------------------------------------------------------
  const viewer = $('#viewer');
  let lastFocus = null;

  async function openViewer(id, ids) {
    let job;
    try {
      job = await api(`/api/jobs/${id}`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    const v = state.viewer;
    v.ids = ids && ids.length ? ids : [id];
    v.index = v.ids.indexOf(id);
    v.job = job;
    v.text = null;
    v.html = null;
    if (viewer.hidden) lastFocus = document.activeElement;
    viewer.hidden = false;
    document.body.style.overflow = 'hidden';
    renderViewer();
    const preferred = store.get('tab', 'screenshot');
    selectTab(job.result || ['details', 'log'].includes(preferred) ? preferred : 'log');
    $('#viewerClose').focus({ preventScroll: true });
  }

  function closeViewer() {
    viewer.hidden = true;
    document.body.style.overflow = '';
    state.viewer.job = null;
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }

  function renderViewer() {
    const { job, ids, index } = state.viewer;
    const r = job.result;
    $('#viewerTitle').textContent = (r && r.title) || shortUrl(job.options.url);
    $('#viewerSub').textContent = [
      `${flag(job.options.country)} ${countryName(job.options.country)}`,
      cap(job.options.device),
      r ? `HTTP ${r.status ?? '—'}` : job.status === 'error' ? 'Failed' : cap(job.status),
      r && r.exitIp ? `IP ${r.exitIp.ip}` : '',
      r ? (r.finalUrl || job.options.url) : job.options.url,
    ]
      .filter(Boolean)
      .join('  ·  ');
    $('#viewerPrev').disabled = index <= 0;
    $('#viewerNext').disabled = index < 0 || index >= ids.length - 1;
    $('#viewerOpen').href = (r && r.finalUrl) || job.options.url;

    // Screenshot
    const img = $('#shotImg');
    const scroll = $('#shotScroll');
    if (r) {
      img.src = `/api/jobs/${job.id}/screenshot.jpg`;
      img.hidden = false;
      $('#downloadShot').href = `/api/jobs/${job.id}/screenshot.jpg?download=1`;
      $('#downloadShot').hidden = false;
      const s = r.screenshot || {};
      $('#shotInfo').textContent = [
        `${r.viewport.width}px wide`,
        s.fullPage ? (s.truncated ? `first ${(16000).toLocaleString()}px of ${s.pageHeight.toLocaleString()}px` : 'full page') : 'viewport only',
      ].join(' · ');
      scroll.classList.toggle('fit-mobile', job.options.device !== 'desktop' && !scroll.classList.contains('actual'));
      $('#netCount').textContent = r.network.length;
      $('#consoleCount').textContent = r.console.length || '';
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      $('#downloadShot').hidden = true;
      $('#shotInfo').textContent = job.status === 'error' ? 'No screenshot — this view failed.' : 'Still loading…';
      $('#netCount').textContent = '';
      $('#consoleCount').textContent = '';
    }
    renderDetails(job);
    renderLog(job);
    renderNetwork();
    renderConsole();
    $('#textBody').textContent = '';
    $('#sourceBody').textContent = '';
    $('#textSearch').value = '';
    $('#textMatches').textContent = '';
    $('#downloadText').href = `/api/jobs/${job.id}/page.txt?download=1`;
    $('#downloadSource').href = `/api/jobs/${job.id}/page.html?download=1`;
  }

  function dl(pairs) {
    const d = h('dl', { class: 'kv' });
    for (const [k, v, cls] of pairs) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      d.append(h('dt', { text: k }), h('dd', { class: cls || '' }, v instanceof Node ? v : String(v)));
    }
    return d;
  }

  function renderDetails(job) {
    const r = job.result;
    const body = $('#detailsBody');
    body.replaceChildren();
    if (job.error) {
      body.append(
        h('div', { class: 'dcard' }, h('h3', { text: 'Error' }), dl([['Problem', job.error.message], ['What to try', job.error.hint], ['Technical', job.error.raw, 'mono']]))
      );
    }
    if (r && r.blocked) {
      body.append(h('div', { class: 'dcard' }, h('h3', { text: 'Block detected' }), dl([['Looks like', r.blocked.reason], ['HTTP status', r.blocked.status]])));
    }
    if (r) {
      const redirects = r.redirects.length
        ? h('ol', { class: 'redirects' }, ...r.redirects.map((x) => h('li', {}, `${x.status ?? ''} ${x.url}`)), h('li', {}, `${r.status ?? ''} ${r.finalUrl}`))
        : null;
      body.append(
        h(
          'div',
          { class: 'dcard' },
          h('h3', { text: 'Page' }),
          dl([
            ['Title', r.title],
            ['Description', r.description],
            ['H1', r.h1 && r.h1.join(' | ')],
            ['Requested', r.requestedUrl, 'mono'],
            ['Final URL', r.finalUrl, 'mono'],
            ['Canonical', r.canonical, 'mono'],
            ['Robots', r.robots],
            ['HTML lang', r.lang],
            ['Status', `${r.status ?? '—'} ${r.statusText || ''}`],
            ['Redirects', redirects],
            ['Links', r.links],
          ])
        )
      );
      const ip = r.exitIp || {};
      body.append(
        h(
          'div',
          { class: 'dcard' },
          h('h3', { text: 'Connection' }),
          dl([
            ['Exit IP', ip.ip ? `${ip.ip}${job.options.ipMode === 'rotate' ? ' (sample — rotating IPs can vary per connection)' : ''}` : 'Unknown'],
            ['Location', [ip.city, ip.region, ip.country].filter(Boolean).join(', ')],
            ['Network', ip.org],
            ['IP timezone', ip.timezone],
            ['Requested from', `${flag(job.options.country)} ${countryName(job.options.country)}`],
            ['IP mode', job.options.ipMode === 'sticky' ? `Sticky (session ${r.session})` : 'Rotating'],
            ['Attempts', `${r.attempts} of ${job.maxAttempts || r.attempts}`],
            ['Timing', `${fmtMs(r.timings.navigationMs)} to first load · ${fmtMs(r.timings.totalMs)} total`],
            ['Bandwidth', `${fmtBytes(r.bytes)} · ${r.requests} requests${r.failedRequests ? ` · ${r.failedRequests} failed` : ''}`],
          ])
        )
      );
      body.append(
        h(
          'div',
          { class: 'dcard' },
          h('h3', { text: 'Browser' }),
          dl([
            ['Device', cap(job.options.device)],
            ['Viewport', `${r.viewport.width} × ${r.viewport.height}`],
            ['Locale', r.locale],
            ['Timezone', r.timezoneId || 'Server default'],
            ['User agent', r.userAgent, 'mono'],
            ['Waited for', ({ domcontentloaded: 'HTML ready', load: 'Page load + settle', networkidle: 'Network idle' }[job.options.waitUntil] || job.options.waitUntil) + (job.options.extraWaitMs ? ` + ${job.options.extraWaitMs / 1000}s` : '')],
            ['Bandwidth mode', { full: 'Everything', 'no-media': 'Skip video & audio', 'text-only': 'Data saver' }[job.options.bandwidth]],
          ])
        )
      );
      const headers = Object.entries(r.headers || {}).sort(([a], [b]) => a.localeCompare(b));
      if (headers.length) {
        body.append(h('div', { class: 'dcard' }, h('h3', { text: 'Response headers' }), dl(headers.map(([k, v]) => [k, v, 'mono']))));
      }
    } else if (!job.error) {
      body.append(h('div', { class: 'empty-pane', text: 'This view is still running…' }));
    }
  }

  function renderLog(job) {
    const t0 = job.events.length ? job.events[0].t : 0;
    $('#logBody').replaceChildren(
      ...job.events
        .filter((e) => ['phase', 'log', 'ip', 'attempt'].includes(e.type))
        .map((e) => {
          let msg = e.message;
          if (e.type === 'ip') msg = `Exit IP ${e.ip} ${[e.city, e.country].filter(Boolean).join(', ')} ${e.org || ''}`;
          if (e.type === 'attempt') msg = `— Attempt ${e.attempt} of ${e.maxAttempts} —`;
          return h('li', { class: e.level || '' }, h('span', { class: 't', text: `+${((e.t - t0) / 1000).toFixed(1)}s` }), h('span', { text: msg || e.phase }));
        })
    );
  }

  function renderNetwork() {
    const r = state.viewer.job && state.viewer.job.result;
    const tbody = $('#netBody');
    if (!r) {
      tbody.replaceChildren();
      $('#netSummary').textContent = '';
      return;
    }
    const q = $('#netFilter').value.trim().toLowerCase();
    const type = $('#netType').value;
    const rows = r.network.filter(
      (n) => (!q || n.url.toLowerCase().includes(q)) && (!type || n.type === type || (type === 'other' && !['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch', 'media'].includes(n.type)))
    );
    const total = rows.reduce((s, n) => s + (n.size || 0), 0);
    $('#netSummary').textContent = `${rows.length} requests · ${fmtBytes(total)}`;
    tbody.replaceChildren(
      ...rows.map((n) => {
        const st = n.error ? n.error.replace('net::', '') : n.status ?? '';
        const cls = n.error ? 'st-err' : n.status >= 400 ? 'st-err' : n.status >= 300 ? 'st-redir' : 'st-ok';
        return h(
          'tr',
          { class: n.error ? 'failed' : '' },
          h('td', { class: cls, text: st }),
          h('td', { text: n.type }),
          h('td', { class: 'url', text: n.url.length > 300 ? `${n.url.slice(0, 300)}…` : n.url, title: n.url }),
          h('td', { class: 'num', text: n.size ? fmtBytes(n.size) : '' })
        );
      })
    );
  }
  $('#netFilter').addEventListener('input', renderNetwork);
  $('#netType').addEventListener('change', renderNetwork);

  function renderConsole() {
    const r = state.viewer.job && state.viewer.job.result;
    const list = $('#consoleBody');
    if (!r || !r.console.length) {
      list.replaceChildren(h('li', { class: 'empty-pane', text: r ? 'No console errors or warnings. 🎉' : '' }));
      return;
    }
    list.replaceChildren(...r.console.map((c) => h('li', { class: c.type, text: `[${c.type}] ${c.text}` })));
  }

  async function loadFileText(kind) {
    const v = state.viewer;
    if (!v.job || !v.job.result) return '';
    if (v[kind] != null) return v[kind];
    const res = await fetch(`/api/jobs/${v.job.id}/${kind === 'text' ? 'page.txt' : 'page.html'}`);
    v[kind] = res.ok ? await res.text() : '';
    return v[kind];
  }

  async function selectTab(tab) {
    store.set('tab', tab);
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $$('.pane').forEach((p) => (p.hidden = p.dataset.pane !== tab));
    const job = state.viewer.job;
    if (tab === 'text') {
      const body = $('#textBody');
      if (!job.result) return body.replaceChildren(h('div', { class: 'empty-pane', text: 'No text captured.' }));
      if (!body.dataset.loaded || body.dataset.loaded !== job.id) {
        body.textContent = 'Loading…';
        const t = await loadFileText('text');
        body.dataset.loaded = job.id;
        highlightText();
        if (!t) body.replaceChildren(h('div', { class: 'empty-pane', text: 'The page has no visible text.' }));
      }
      $('#textSearch').focus();
    } else if (tab === 'source') {
      const body = $('#sourceBody');
      if (!job.result) return body.replaceChildren(h('div', { class: 'empty-pane', text: 'No HTML captured.' }));
      if (body.dataset.loaded !== job.id) {
        body.textContent = 'Loading…';
        const html = await loadFileText('html');
        body.textContent = html;
        body.dataset.loaded = job.id;
        $('#sourceInfo').textContent = `${fmtBytes(new Blob([html]).size)} · rendered DOM after JavaScript`;
      }
    }
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  // Text search with highlighting
  let matchIndex = 0;
  function highlightText() {
    const text = state.viewer.text || '';
    const q = $('#textSearch').value.trim();
    const body = $('#textBody');
    if (!q) {
      body.textContent = text;
      $('#textMatches').textContent = text ? `${text.length.toLocaleString()} characters` : '';
      return;
    }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const frag = document.createDocumentFragment();
    let last = 0;
    let count = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index), h('mark', { text: m[0] }));
      last = m.index + m[0].length;
      if (++count > 5000) break;
    }
    frag.append(text.slice(last));
    body.replaceChildren(frag);
    $('#textMatches').textContent = count ? `${count.toLocaleString()} match${count === 1 ? '' : 'es'} · Enter for next` : 'Not found on this page';
    matchIndex = 0;
    focusMatch();
  }
  function focusMatch() {
    const marks = $$('#textBody mark');
    marks.forEach((m) => m.classList.remove('current'));
    if (!marks.length) return;
    const m = marks[((matchIndex % marks.length) + marks.length) % marks.length];
    m.classList.add('current');
    m.scrollIntoView({ block: 'center' });
  }
  let searchTimer;
  $('#textSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(highlightText, 120);
  });
  $('#textSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      matchIndex += e.shiftKey ? -1 : 1;
      focusMatch();
    }
  });

  $('#copySource').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(await loadFileText('html'));
      toast('HTML copied to clipboard');
    } catch {
      toast('Could not copy — use Download instead.', 'err');
    }
  });

  $('#zoomSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#zoomSeg button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    const scroll = $('#shotScroll');
    scroll.classList.toggle('actual', b.dataset.zoom === 'actual');
    scroll.classList.toggle('fit-mobile', b.dataset.zoom === 'fit' && state.viewer.job && state.viewer.job.options.device !== 'desktop');
  });
  $('#shotImg').addEventListener('click', () => {
    const actual = !$('#shotScroll').classList.contains('actual');
    $(`#zoomSeg [data-zoom="${actual ? 'actual' : 'fit'}"]`).click();
  });

  function stepViewer(delta) {
    const v = state.viewer;
    const next = v.index + delta;
    if (next < 0 || next >= v.ids.length) return;
    openViewer(v.ids[next], v.ids);
  }
  $('#viewerPrev').addEventListener('click', () => stepViewer(-1));
  $('#viewerNext').addEventListener('click', () => stepViewer(1));
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerRetry').addEventListener('click', async () => {
    const id = state.viewer.job.id;
    closeViewer();
    await retryJob(id);
  });

  // ------------------------------------------------------------------
  // Settings dialog
  // ------------------------------------------------------------------
  const dialog = $('#settingsDialog');
  const sform = $('#settingsForm');
  let authMode = 'apikey';

  function setAuthMode(mode) {
    authMode = mode;
    $$('[data-auth]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.auth === mode)));
    $$('[data-auth-pane]').forEach((p) => (p.hidden = p.dataset.authPane !== mode));
  }
  $$('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));

  function openSettings() {
    const s = state.status || {};
    const f = sform.elements;
    f.apiKey.value = '';
    f.apiKey.placeholder = s.hasApiKey ? 'Saved — paste a new key to replace it' : 'Paste your Webshare API key';
    f.username.value = s.username || '';
    f.password.value = '';
    f.password.placeholder = s.hasPassword ? 'Saved — leave blank to keep' : 'Your proxy password';
    f.host.value = s.host || '';
    f.port.value = s.port || '';
    f.rotateTemplate.value = s.rotateTemplate || '';
    f.stickyTemplate.value = s.stickyTemplate || '';
    if (s.defaults) {
      f.host.placeholder = s.defaults.host;
      f.port.placeholder = String(s.defaults.port);
      f.rotateTemplate.placeholder = s.defaults.rotateTemplate;
      f.stickyTemplate.placeholder = s.defaults.stickyTemplate;
    }
    setAuthMode(s.configured && !s.hasApiKey ? 'userpass' : 'apikey');
    $('#disconnectBtn').hidden = !s.configured;
    $('#testBtn').hidden = !s.configured;
    $('#testResult').hidden = true;
    renderUsernamePreview();
    dialog.showModal();
    setTimeout(() => (authMode === 'apikey' ? f.apiKey : f.username).focus(), 30);
  }
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#connBtn').addEventListener('click', () => {
    if (state.status && state.status.configured) {
      sessionCache('conn', null);
      checkConnection({ force: true });
    } else openSettings();
  });
  $$('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  // Mirror of the server's template renderer so users can see the exact username we'll send.
  function renderTemplate(template, vars) {
    return template
      .replace(/\[([^\]]*)\]/g, (_, group) => {
        const keys = [...group.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        return keys.every((k) => vars[k]) ? group.replace(/\{(\w+)\}/g, (__, k) => vars[k]) : '';
      })
      .replace(/\{(\w+)\}/g, (_, k) => vars[k] || '');
  }
  function renderUsernamePreview() {
    const f = sform.elements;
    const user = f.username.value.trim() || (state.status && state.status.username) || 'USERNAME';
    const rt = f.rotateTemplate.value.trim() || f.rotateTemplate.placeholder;
    const st = f.stickyTemplate.value.trim() || f.stickyTemplate.placeholder;
    const ex = state.selected.find(Boolean) || 'US';
    $('#usernamePreview').replaceChildren(
      h('div', {}, 'Rotating, any country → ', h('code', { text: renderTemplate(rt, { user }) })),
      h('div', {}, `Rotating, ${ex} → `, h('code', { text: renderTemplate(rt, { user, country: ex }) })),
      h('div', {}, `Sticky, ${ex} → `, h('code', { text: renderTemplate(st, { user, country: ex, session: '48213' }) }))
    );
  }
  ['username', 'rotateTemplate', 'stickyTemplate'].forEach((n) => sform.elements[n].addEventListener('input', renderUsernamePreview));

  function showTest(kind, main, hint) {
    const el = $('#testResult');
    el.hidden = false;
    el.className = `test-result ${kind}`;
    el.replaceChildren(h('div', {}, main), hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  async function runTest() {
    showTest('pending', 'Connecting through Webshare…');
    $('#testBtn').disabled = true;
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: {} });
      sessionCache('conn', r, 10 * 60 * 1000);
      showConnResult(r);
      if (r.ok) {
        const loc = [r.ip.city, r.ip.country].filter(Boolean).join(', ');
        showTest('ok', `✓ Working! Exit IP ${r.ip.ip} ${flag(r.ip.country)} ${loc} — ${fmtMs(r.ms)}`, r.ip.org || '');
      } else showTest('err', `✕ ${r.error}`, [r.hint, r.raw].filter(Boolean).join(' — '));
      return r;
    } catch (err) {
      showTest('err', `✕ ${err.message}`);
    } finally {
      $('#testBtn').disabled = false;
    }
  }
  $('#testBtn').addEventListener('click', runTest);

  sform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = sform.elements;
    const body = {
      host: f.host.value.trim(),
      port: f.port.value.trim(),
      rotateTemplate: f.rotateTemplate.value.trim(),
      stickyTemplate: f.stickyTemplate.value.trim(),
    };
    if (authMode === 'apikey') {
      if (f.apiKey.value.trim()) body.apiKey = f.apiKey.value.trim();
      else if (!(state.status && state.status.hasApiKey)) {
        showTest('err', 'Paste your API key, or switch to “Username & password”.');
        f.apiKey.focus();
        return;
      }
    } else {
      if (!f.username.value.trim()) {
        showTest('err', 'Enter your proxy username.');
        f.username.focus();
        return;
      }
      if (!f.password.value && !(state.status && state.status.hasPassword)) {
        showTest('err', 'Enter your proxy password.');
        f.password.focus();
        return;
      }
      body.username = f.username.value.trim();
      if (f.password.value) body.password = f.password.value;
      if (state.status && state.status.hasApiKey) body.apiKey = ''; // switching away from API key
    }
    const btn = $('#saveBtn');
    btn.disabled = true;
    showTest('pending', authMode === 'apikey' && body.apiKey ? 'Fetching your proxy credentials from Webshare…' : 'Saving…');
    try {
      await api('/api/settings', { method: 'POST', body });
      await loadStatus();
      $('#disconnectBtn').hidden = false;
      $('#testBtn').hidden = false;
      f.apiKey.value = '';
      f.password.value = '';
      const r = await runTest();
      if (r && r.ok) {
        toast('Webshare connected');
        setTimeout(() => dialog.open && dialog.close(), 1400);
        urlInput.focus();
      }
    } catch (err) {
      showTest('err', `✕ ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('#disconnectBtn').addEventListener('click', async () => {
    if (!confirm('Remove the saved Webshare credentials from this app?')) return;
    await api('/api/settings', { method: 'POST', body: { clear: true } });
    sessionCache('conn', null);
    await loadStatus();
    dialog.close();
    toast('Disconnected');
  });

  // ------------------------------------------------------------------
  // Keyboard shortcuts
  // ------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (!viewer.hidden) {
      if (e.key === 'Escape') return closeViewer();
      if (!typing && e.key === 'ArrowLeft') return stepViewer(-1);
      if (!typing && e.key === 'ArrowRight') return stepViewer(1);
      return;
    }
    if (e.key === 'Escape' && !popover.hidden) return closePopover();
    if (e.key === '/' && !typing && !dialog.open) {
      e.preventDefault();
      urlInput.focus();
      urlInput.select();
    }
  });

  // Pasting a URL while in search mode (or vice versa) switches mode automatically.
  urlInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/^https?:\/\//i.test(text.trim()) && state.mode === 'search') setMode('url');
  });
  urlInput.addEventListener('input', () => showFormError(''));

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  async function boot() {
    setMode(state.mode);
    restoreOptions();
    if (store.get('moreOpen', false)) $('#moreBtn').click();
    renderUrlHistory();
    try {
      await loadStatus();
    } catch (err) {
      setConn('err', 'Server offline', err.message);
      return;
    }
    await loadHistory();
    // Resume any views that are still running (e.g. after a page reload).
    const active = state.history.filter((j) => j.status === 'running' || j.status === 'queued');
    if (active.length) {
      const full = await Promise.all(active.map((j) => api(`/api/jobs/${j.id}`).catch(() => null)));
      const jobs = full.filter(Boolean).map((j) => ({ ...j, options: j.options }));
      if (jobs.length) {
        state.batchOptions = { ...jobs[0].options, countries: jobs.map((j) => j.options.country || '') };
        state.batch = jobs.map((j) => j.id).reverse();
        renderBatchBar(jobs[0].options);
        jobs.reverse().forEach((j) => addCard(j));
        $('#results').classList.toggle('single', jobs.length === 1);
        $('#emptyState').hidden = true;
      }
    }
    const params = new URLSearchParams(location.search);
    if (params.get('url')) {
      urlInput.value = params.get('url');
      setMode('url');
    }
    if (state.status.configured) checkConnection();
    else setTimeout(openSettings, 400);
    if (!active.length) urlInput.focus();
  }
  boot();
})();
