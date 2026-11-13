/* Label IQ PC Master Dashboard.
 *
 * Read-only view of the telemetry server (the single source of truth). Every PC that opens
 * http://<server-ip>:8080/dashboard/ polls the same server, so all PCs show the same data.
 * The master token lives only in this browser's session storage (or local storage when
 * "Remember on this PC" is ticked) and is only ever sent in the Authorization header.
 * All data is rendered as text nodes, never as HTML.
 */
'use strict';
(() => {
  const REFRESH_MS = 10000;
  const TOKEN_KEY = 'labeliq_master_token';
  const UNITS = ['u10', 'u21', 'u35', 'u44'];
  const FALLBACK_VARIANTS = [
    ['U10', 'U10 PO/Admin'], ['U10-Standalone', 'U10 Standalone'], ['U21', 'U21 PO/Admin'],
    ['U35', 'U35 Scanner'], ['uniqloU35Demo', 'U35 Scanner Demo'], ['uniqloU35Po', 'U35 Scanner PO'],
    ['U44', 'U44'],
  ];

  const COMMON = ['unitId', 'variant', 'installId', 'deviceLabel', 'applicationId', 'flavor',
    'versionName', 'versionCode', 'from', 'to'];
  const VIEW_FILTERS = {
    overview: ['unitId', 'variant', 'from', 'to'],
    reports: ['unitId', 'variant', 'from', 'to'],
    units: ['from', 'to'],
    devices: ['unitId', 'deviceLabel', 'status', 'date', 'variant', 'androidIdHash', 'installId',
      'applicationId', 'flavor', 'versionName', 'versionCode', 'from', 'to'],
    builds: COMMON,
    sessions: [...COMMON, 'kind', 'sessionId', 'po'],
    pos: [...COMMON, 'po', 'poSessionId', 'status'],
    scans: [...COMMON, 'sessionId', 'po', 'result'],
    fleet: ['unitId', 'androidIdHash', 'deviceLabel', 'installId', 'applicationId', 'variant',
      'versionName', 'versionCode', 'status', 'date'],
  };
  // Filters shown first. The rest stay available under "More filters".
  const PRIMARY_FILTERS = {
    overview: ['unitId', 'variant'],
    reports: ['unitId', 'variant', 'from', 'to'],
    devices: ['unitId', 'deviceLabel', 'status', 'date'],
    pos: ['unitId', 'po', 'status'],
    scans: ['unitId', 'deviceLabel', 'result', 'po'],
    fleet: ['unitId', 'deviceLabel', 'status'],
    sessions: ['unitId', 'po', 'kind'],
    builds: ['unitId', 'variant', 'versionName'],
  };
  const STATUS_FILTER = {
    label: 'Status',
    options: () => [['', 'All'], ['ONLINE', 'Active (≤ 5 min)'], ['RECENT', 'Recent (≤ 30 min)'], ['OFFLINE', 'Offline']],
  };
  const DATE_FILTER = { label: 'Day', type: 'date' };
  // Per-view filter definitions that differ from FILTER_DEFS (same API parameter name).
  const VIEW_FILTER_DEFS = {
    fleet: {
      status: STATUS_FILTER,
      versionName: { label: 'Version' },
      date: { label: 'Day', type: 'date' },
    },
    devices: {
      status: STATUS_FILTER,
      date: DATE_FILTER,
      deviceLabel: { label: 'Device' },
      versionName: { label: 'Version' },
    },
    scans: { deviceLabel: { label: 'Device' } },
    pos: { deviceLabel: { label: 'Device' } },
  };
  const FILTER_DEFS = {
    unitId: { label: 'Unit', options: () => [['', 'All'], ...UNITS.map((u) => [u, u.toUpperCase()])] },
    variant: { label: 'Variant (APK)', options: () => [['', 'All'], ...state.variants] },
    installId: { label: 'Device (installId)' },
    androidIdHash: { label: 'Physical tablet (androidIdHash)' },
    deviceLabel: { label: 'Device label' },
    applicationId: { label: 'Application ID' },
    flavor: { label: 'Flavor' },
    versionName: { label: 'Version name' },
    versionCode: { label: 'Version code', type: 'number' },
    from: { label: 'From date', type: 'date' },
    to: { label: 'To date', type: 'date' },
    sessionId: { label: 'Session ID' },
    poSessionId: { label: 'PO session ID' },
    po: { label: 'PO' },
    result: { label: 'Result', options: () => [['', 'All'], ['MATCH', 'MATCH'], ['MISMATCH', 'MISMATCH'], ['INCOMPLETE', 'INCOMPLETE']] },
    status: { label: 'PO status', options: () => [['', 'All'], ['IN_PROGRESS', 'In progress'], ['COMPLETE', 'Complete']] },
    kind: { label: 'Session kind', options: () => [['scanner', 'Scanner'], ['app', 'App']] },
  };

  const state = {
    token: null, paused: false, loading: false, loadSeq: 0, clockOffset: 0,
    activeWindowMs: 30 * 60 * 1000, lastOk: null, view: 'overview',
    variants: FALLBACK_VARIANTS.map(([v, n]) => [v, `${n} (${v})`]),
    variantNames: Object.fromEntries(FALLBACK_VARIANTS),
    expanded: new Set(),
  };

  const $ = (sel) => document.querySelector(sel);

  // --- icons (Lucide, ISC licence; stroke 1.75) and theme -------------------------------------

  const P = (d) => ['path', { d }];
  const ICONS = {
    'layout-dashboard': [['rect', { width: 7, height: 9, x: 3, y: 3, rx: 1 }], ['rect', { width: 7, height: 5, x: 14, y: 3, rx: 1 }],
      ['rect', { width: 7, height: 9, x: 14, y: 12, rx: 1 }], ['rect', { width: 7, height: 5, x: 3, y: 16, rx: 1 }]],
    tablet: [['rect', { width: 16, height: 20, x: 4, y: 2, rx: 2, ry: 2 }], ['line', { x1: 12, x2: 12.01, y1: 18, y2: 18 }]],
    'clipboard-list': [['rect', { width: 8, height: 4, x: 8, y: 2, rx: 1, ry: 1 }],
      P('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'),
      P('M12 11h4'), P('M12 16h4'), P('M8 11h.01'), P('M8 16h.01')],
    'scan-line': [P('M3 7V5a2 2 0 0 1 2-2h2'), P('M17 3h2a2 2 0 0 1 2 2v2'), P('M21 17v2a2 2 0 0 1-2 2h-2'),
      P('M7 21H5a2 2 0 0 1-2-2v-2'), P('M7 12h10')],
    'file-chart': [P('M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'), P('M14 2v4a2 2 0 0 0 2 2h4'),
      P('M8 18v-1'), P('M12 18v-6'), P('M16 18v-3')],
    package: [P('M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z'),
      P('M12 22V12'), P('m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7'), P('m7.5 4.27 9 5.15')],
    activity: [['polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' }]],
    user: [P('M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'), ['circle', { cx: 12, cy: 7, r: 4 }]],
    settings: [P('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'),
      ['circle', { cx: 12, cy: 12, r: 3 }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], P('M12 2v2'), P('M12 20v2'), P('m4.93 4.93 1.41 1.41'), P('m17.66 17.66 1.41 1.41'),
      P('M2 12h2'), P('M20 12h2'), P('m6.34 17.66-1.41 1.41'), P('m19.07 4.93-1.41 1.41')],
    moon: [P('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')],
    'chevron-down': [P('m6 9 6 6 6-6')],
    'chevron-right': [P('m9 18 6-6-6-6')],
    'log-out': [P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), ['polyline', { points: '16 17 21 12 16 7' }],
      ['line', { x1: 21, x2: 9, y1: 12, y2: 12 }]],
    pause: [['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }], ['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }]],
    play: [['polygon', { points: '6 3 20 12 6 21 6 3' }]],
    menu: [['line', { x1: 4, x2: 20, y1: 12, y2: 12 }], ['line', { x1: 4, x2: 20, y1: 6, y2: 6 }], ['line', { x1: 4, x2: 20, y1: 18, y2: 18 }]],
    inbox: [['polyline', { points: '22 12 16 12 14 15 10 15 8 12 2 12' }],
      P('M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z')],
    'alert-triangle': [P('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), P('M12 9v4'), P('M12 17h.01')],
    loader: [P('M21 12a9 9 0 1 1-6.219-8.56')],
    'arrow-right': [P('M5 12h14'), P('m12 5 7 7-7 7')],
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = { class: 'icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, a] of ICONS[name] || []) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
      svg.appendChild(el);
    }
    return svg;
  }
  // Static markup marks icon slots with <i data-icon="name">.
  function hydrateIcons(root) {
    root.querySelectorAll('i[data-icon]').forEach((el) => {
      const svg = icon(el.dataset.icon);
      if (el.id) svg.id = el.id;
      el.replaceWith(svg);
    });
  }

  // Theme is a per-viewer convenience: light / dark / system, kept in local storage when allowed.
  const THEME_KEY = 'labeliq_dashboard_theme';
  function readTheme() {
    try { const v = window.localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; }
  }
  function effectiveTheme(choice) {
    if (choice !== 'system') return choice;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme(choice) {
    if (choice === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', choice);
    try {
      if (choice === 'system') window.localStorage.removeItem(THEME_KEY); else window.localStorage.setItem(THEME_KEY, choice);
    } catch (e) { /* storage blocked: theme lasts for this page only */ }
    const dark = effectiveTheme(choice) === 'dark';
    const btn = $('#theme-toggle');
    if (btn) {
      btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      btn.title = dark ? 'Light theme' : 'Dark theme';
    }
    document.querySelectorAll('[data-theme-choice]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
  }
  applyTheme(readTheme());

  // --- token storage (never rendered) ---------------------------------------------------------

  function storage(kind) {
    try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; }
  }
  function loadToken() {
    for (const kind of ['session', 'local']) {
      try { const v = storage(kind) && storage(kind).getItem(TOKEN_KEY); if (v) return v; } catch (e) { /* blocked */ }
    }
    return null;
  }
  function saveToken(token, remember) {
    try { storage('session').setItem(TOKEN_KEY, token); } catch (e) { /* blocked */ }
    if (remember) { try { storage('local').setItem(TOKEN_KEY, token); } catch (e) { /* blocked */ } }
  }
  function clearToken() {
    for (const kind of ['session', 'local']) {
      try { storage(kind).removeItem(TOKEN_KEY); } catch (e) { /* blocked */ }
    }
  }

  // --- API ------------------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  async function api(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    let res;
    try {
      res = await fetch(path + (q ? `?${q}` : ''), {
        headers: { Authorization: `Bearer ${state.token}`, Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch (e) {
      throw new ApiError(0, 'server unreachable');
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, (body && body.error) || `HTTP ${res.status}`);
    if (body && typeof body.serverTime === 'number') state.clockOffset = body.serverTime - Date.now();
    return body;
  }
  const serverNow = () => Date.now() + state.clockOffset;
  const pick = (params, names) => Object.fromEntries(names.filter((n) => params[n]).map((n) => [n, params[n]]));

  // --- DOM helpers ----------------------------------------------------------------------------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function link(view, arg, params) {
    let s = `#/${view}`;
    if (arg !== undefined && arg !== null) s += `/${encodeURIComponent(arg)}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return q ? `${s}?${q}` : s;
  }

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = Object.fromEntries(new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : ''));
    const parts = pathPart.split('/').filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    return { view: parts[0] || 'overview', arg: parts[1], params };
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    if (ms === null || ms === undefined) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function ago(ms) {
    if (ms === null || ms === undefined) return '—';
    const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    return hr < 48 ? `${hr} h ago` : `${Math.round(hr / 24)} d ago`;
  }
  const timeCell = (ms) => (ms === null || ms === undefined ? h('span', { class: 'muted' }, '—')
    : h('span', { class: 'ts', title: ago(ms) }, fmtTime(ms)));
  const num = (n) => (n === null || n === undefined ? '—' : String(n));
  const short = (id, n = 8) => (!id ? '—' : id.length > n ? `${id.slice(0, n)}…` : id);

  const ID_KIND = {
    install: 'Install identity (installId)', tablet: 'Physical tablet (androidIdHash)',
    build: 'APK/build identity', session: 'Session identity', po: 'PO identity', scan: 'Scan identity (eventId)',
  };
  function idTag(kind, id, href, full) {
    if (!id) return h('span', { class: 'muted' }, '—');
    const t = h('span', { class: `id ${kind}`, title: `${ID_KIND[kind]}: ${id}` }, full ? id : short(id));
    return href ? h('a', { href }, t) : t;
  }
  const badge = (cls, text) => h('span', { class: `badge ${cls}` }, text);
  const resultBadge = (r) => (r ? badge(r, r) : '—');
  const poAdminFlag = (v) => (v === true ? badge('on', 'PO/Admin on') : v === false ? badge('', 'off') : h('span', { class: 'muted' }, '?'));
  const demoFlag = (v) => (v === true ? badge('demo', 'demo') : v === false ? badge('', 'off') : h('span', { class: 'muted' }, '?'));
  const variantName = (v) => state.variantNames[v] || v;
  const variantLink = (v) => (v ? h('a', { href: link('unit', v), title: `variant ${v}` }, variantName(v)) : '—');
  const deviceLink = (installId, label) => (installId
    ? h('a', { href: link('device', installId), title: `installId ${installId}` }, label || short(installId)) : '—');
  const buildText = (b) => (b ? `${b.versionName} (${b.versionCode})` : '—');
  const sameBuild = (a, b) => a && b && ['applicationId', 'flavor', 'buildType', 'versionName', 'versionCode',
    'enablePoAdmin', 'adminDemoMode'].every((k) => a[k] === b[k]);

  function card(k, v, cls, title) {
    return h('div', { class: `card ${cls || ''}`, title }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, num(v)));
  }
  function kv(pairs) {
    return h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
  }
  function panel(title, ...kids) {
    return h('div', { class: 'panel' }, title ? h('h3', null, title) : null, kids);
  }
  function section(title, sub, ...kids) {
    return [h('h2', null, title, sub ? h('span', { class: 'sub' }, sub) : null), kids];
  }
  function pageHead(title, scope) {
    return h('div', { class: 'page-head' },
      h('h1', null, title),
      scope ? h('p', { class: 'scope' }, scope) : null);
  }
  function fold(title, ...kids) {
    return h('details', { class: 'fold' }, h('summary', null, icon('chevron-right'), title), kids);
  }
  const errBox = (text) => h('div', { class: 'err-box', role: 'alert' }, icon('alert-triangle'), h('span', null, text));
  const emptyState = (text) => h('div', { class: 'empty' }, icon('inbox'), text);
  const loadingState = () => h('div', { class: 'state loading', role: 'status' }, icon('loader', 20), 'Loading…');
  function statPanel(groups) {
    return h('div', { class: 'stat-panel' }, groups.map((g) =>
      h('section', { class: 'stat-group' },
        h('h2', null, g.title),
        h('div', { class: 'stat-row' }, g.stats.map((s) =>
          h('div', { class: `stat ${s.cls || ''}`, title: s.title },
            h('div', { class: 'k' }, s.k),
            h('div', { class: 'v' }, num(s.v))))))));
  }
  function twoLine(primary, secondary) {
    return h('span', null, primary, secondary ? h('span', { class: 'small muted' }, secondary) : null);
  }
  function crumbs(items) {
    const out = [];
    items.forEach(([label, href], i) => {
      if (i) out.push(h('span', { class: 'sep' }, icon('chevron-right', 14)));
      out.push(href && i < items.length - 1 ? h('a', { href }, label) : h('span', { class: 'here' }, label));
    });
    return h('div', { class: 'crumbs' }, out);
  }

  function colClass(c) {
    return [c.num ? 'num' : '', c.nowrap ? 'nowrap' : ''].filter(Boolean).join(' ') || null;
  }
  function table(cols, rows, opts = {}) {
    if (!rows || !rows.length) {
      return h('div', { class: 'tablewrap' }, emptyState(opts.empty || 'No data.'));
    }
    const thead = h('thead', null, h('tr', null, cols.map((c) => h('th', { class: colClass(c), title: c.title }, c.label))));
    const tbody = h('tbody');
    for (const r of rows) {
      const tr = h('tr', { class: (opts.detail || opts.open) ? 'clickable' : null },
        cols.map((c) => h('td', { class: colClass(c) }, c.cell(r))));
      tbody.appendChild(tr);
      if (opts.open) {
        tr.addEventListener('click', (ev) => {
          if (ev.target.closest('a,button,summary')) return;
          location.hash = opts.open(r);
        });
      }
      if (opts.detail) {
        const key = opts.key(r);
        const dtr = h('tr', { class: 'detail' }, h('td', { colspan: cols.length }, opts.detail(r)));
        dtr.hidden = !state.expanded.has(key);
        tr.addEventListener('click', (ev) => {
          if (ev.target.closest('a')) return;
          dtr.hidden = !dtr.hidden;
          if (dtr.hidden) state.expanded.delete(key); else state.expanded.add(key);
        });
        tbody.appendChild(dtr);
      }
    }
    return h('div', { class: 'tablewrap' }, h('table', null, thead, tbody));
  }

  function pager(res, view, arg, params) {
    const off = Number(params.offset || 0);
    const prev = off > 0 ? h('a', { href: link(view, arg, { ...params, offset: Math.max(0, off - res.limit) || '' }) }, '‹ Newer') : null;
    const next = res.hasMore ? h('a', { href: link(view, arg, { ...params, offset: off + res.limit }) }, 'Older ›') : null;
    return h('div', { class: 'pager' }, res.count ? `Showing ${off + 1}–${off + res.count}` : 'No rows', prev, next);
  }
  const seeAll = (view, params, text) => h('p', { class: 'note' }, h('a', { href: link(view, undefined, params) }, text || 'See all with filters →'));

  function updateVariants(items) {
    if (!items || !items.length) return;
    state.variants = items.map((i) => [i.variant, i.displayName !== i.variant ? `${i.displayName} (${i.variant})` : i.variant]);
    state.variantNames = Object.fromEntries(items.map((i) => [i.variant, i.displayName]));
  }

  // --- shared column sets ---------------------------------------------------------------------

  const COLS = {
    units: [
      { label: 'Variant (APK)', cell: (r) => h('span', null, variantLink(r.variant), ' ', h('span', { class: 'muted mono' }, r.variant)) },
      { label: 'Unit', cell: (r) => r.unitId.toUpperCase() },
      { label: 'Devices', num: true, cell: (r) => r.devices, title: 'Installs of this variant (installId)' },
      { label: 'Tablets', num: true, cell: (r) => r.physicalTablets, title: 'Distinct physical tablets (androidIdHash)' },
      { label: 'Current builds', cell: (r) => (r.currentBuilds.length
        ? r.currentBuilds.map((b) => `${b.versionName} (${b.versionCode}) ×${b.devices}`).join(', ') : '—') },
      { label: 'Scans', num: true, cell: (r) => r.counts.scans },
      { label: 'MATCH', num: true, cell: (r) => r.counts.match },
      { label: 'MISMATCH', num: true, cell: (r) => r.counts.mismatch },
      { label: 'INCOMPLETE', num: true, cell: (r) => r.counts.incomplete },
      { label: 'Active sessions', num: true, cell: (r) => r.activeSessions },
      { label: 'POs in progress / complete', num: true, cell: (r) => `${r.pos.IN_PROGRESS} / ${r.pos.COMPLETE}` },
      { label: 'Last seen', cell: (r) => (r.lastSeen ? timeCell(r.lastSeen) : h('span', { class: 'muted' }, 'no data yet')) },
    ],
    devices: [
      { label: 'Device label', cell: (d) => deviceLink(d.installId, d.deviceLabel || '(no label)') },
      { label: 'installId', cell: (d) => idTag('install', d.installId, link('device', d.installId)) },
      { label: 'androidIdHash', cell: (d) => idTag('tablet', d.androidIdHash) },
      { label: 'Model', cell: (d) => [d.manufacturer, d.model].filter(Boolean).join(' ') || '—' },
      { label: 'SDK', num: true, cell: (d) => num(d.sdk) },
      { label: 'Unit', cell: (d) => d.unitId.toUpperCase() },
      { label: 'Variant', cell: (d) => variantLink(d.variant) },
      { label: 'applicationId', cell: (d) => h('span', { class: 'mono' }, d.currentBuild.applicationId) },
      { label: 'Flavor', cell: (d) => d.currentBuild.flavor },
      { label: 'Version', cell: (d) => d.currentBuild.versionName },
      { label: 'Code', num: true, cell: (d) => d.currentBuild.versionCode },
      { label: 'PO/Admin', cell: (d) => poAdminFlag(d.currentBuild.enablePoAdmin) },
      { label: 'Demo', cell: (d) => demoFlag(d.currentBuild.adminDemoMode) },
      { label: 'Last seen', cell: (d) => timeCell(d.lastSeen) },
      { label: 'Scans', num: true, cell: (d) => d.counts.scans },
      { label: 'MATCH', num: true, cell: (d) => d.counts.match },
      { label: 'MISMATCH', num: true, cell: (d) => d.counts.mismatch },
    ],
    builds: [
      { label: 'Build', cell: (b) => idTag('build', `#${b.buildId}`, link('build', b.buildId), true) },
      { label: 'Variant', cell: (b) => variantLink(b.variant) },
      { label: 'Unit', cell: (b) => b.unitId.toUpperCase() },
      { label: 'applicationId', cell: (b) => h('span', { class: 'mono' }, b.applicationId) },
      { label: 'Flavor', cell: (b) => b.flavor },
      { label: 'versionName', cell: (b) => b.versionName },
      { label: 'versionCode', num: true, cell: (b) => b.versionCode },
      { label: 'Type', cell: (b) => b.buildType },
      { label: 'PO/Admin', cell: (b) => poAdminFlag(b.enablePoAdmin) },
      { label: 'Demo', cell: (b) => demoFlag(b.adminDemoMode) },
      { label: 'Running on', num: true, title: 'Devices whose latest build is this one', cell: (b) => b.currentDeviceCount },
      { label: 'Devices ever', num: true, title: 'Installs that sent events with this build', cell: (b) => b.deviceCount },
      { label: 'Scans', num: true, cell: (b) => b.counts.scans },
      { label: 'MATCH', num: true, cell: (b) => b.counts.match },
      { label: 'MISMATCH', num: true, cell: (b) => b.counts.mismatch },
      { label: 'Last seen', cell: (b) => timeCell(b.lastSeen) },
    ],
    sessions: [
      { label: 'Status', cell: (s) => sessionBadge(s) },
      { label: 'Session', cell: (s) => idTag('session', s.sessionId, link('session', s.sessionId, { kind: s.kind })) },
      { label: 'Started', cell: (s) => timeCell(s.startedAt ?? s.firstEventAt) },
      { label: 'Last event', cell: (s) => timeCell(s.lastEventAt) },
      { label: 'Variant', cell: (s) => variantLink(s.variant) },
      { label: 'Device', cell: (s) => deviceLink(s.installId, s.deviceLabel) },
      { label: 'Build', cell: (s) => buildText(s.build) },
      { label: 'PO', cell: (s) => (s.po ? poLink(s.unitId, s.variant, s.po) : '—') },
      { label: 'Scans', num: true, cell: (s) => s.counts.scans },
      { label: 'MATCH', num: true, cell: (s) => s.counts.match },
      { label: 'MISMATCH', num: true, cell: (s) => s.counts.mismatch },
      { label: 'INCOMPLETE', num: true, cell: (s) => s.counts.incomplete },
    ],
    pos: [
      { label: 'Status', cell: (p) => badge(p.status, p.status === 'COMPLETE' ? 'COMPLETE' : 'IN PROGRESS') },
      { label: 'PO', cell: (p) => poLink(p.unitId, p.variant, p.po) },
      { label: 'Variant', cell: (p) => variantLink(p.variant) },
      { label: 'Target', num: true, cell: (p) => num(p.targetQuantity) },
      { label: 'Valid MATCH', num: true, title: 'Latest counted MATCH count (MATCH-only, as on the tablet)', cell: (p) => p.validMatchCount },
      { label: 'Remaining', num: true, cell: (p) => num(p.remaining) },
      { label: 'Not counted', num: true, title: 'MISMATCH / INCOMPLETE scans in this PO. Never counted.', cell: (p) => `${p.notCounted.mismatch} / ${p.notCounted.incomplete}` },
      { label: 'Devices', cell: (p) => p.devices.map((d, i) => [i ? ', ' : '', deviceLink(d.installId, d.deviceLabel)]) },
      { label: 'PO sessions', num: true, cell: (p) => p.poSessionIds.length },
      { label: 'First scan', cell: (p) => timeCell(p.firstScanAt) },
      { label: 'Last scan', cell: (p) => timeCell(p.lastScanAt) },
    ],
  };

  const pair = (a, b) => {
    if (!a && !b) return '—';
    return `${a || '—'} / ${b || '—'}`;
  };
  // Canonical SIZE first (what the tablet Admin shows); the printed text is in the row detail.
  const sizeOf = (side) => (side ? side.size || side.sizeDisplay : null);

  COLS.scansFull = [
    { label: 'Time', nowrap: true, cell: (s) => timeCell(s.tsDevice) },
    { label: 'Result', cell: (s) => resultBadge(s.scan.result) },
    { label: 'Variant', cell: (s) => variantLink(s.variant) },
    { label: 'Device', cell: (s) => deviceLink(s.device.installId, s.device.label) },
    { label: 'Build', cell: (s) => buildText(s.build) },
    { label: 'Session', cell: (s) => idTag('session', s.session.scannerSessionId, s.session.scannerSessionId ? link('session', s.session.scannerSessionId, { kind: 'scanner' }) : null) },
    { label: 'PO', cell: (s) => (s.session.po ? poLink(s.unitId, s.variant, s.session.po) : '—') },
    { label: 'SIZE wash / tag', cell: (s) => pair(sizeOf(s.scan.wash), sizeOf(s.scan.tag)) },
    { label: 'Waist', cell: (s) => pair(s.scan.wash.waist, s.scan.tag.waist) },
    { label: 'Hip', cell: (s) => pair(s.scan.wash.hip, s.scan.tag.hip) },
    { label: 'Inseam', cell: (s) => pair(s.scan.wash.inseam, s.scan.tag.inseam) },
    { label: 'Style wash / scan', cell: (s) => pair(s.scan.wash.style, s.scan.styleScan) },
    { label: 'Target', num: true, cell: (s) => num(s.scan.targetQuantity) },
    { label: 'Valid count', num: true, cell: (s) => num(s.scan.validMatchCount) },
    { label: 'Cycle ms', num: true, cell: (s) => num(s.timing.cycleMs) },
    { label: 'Frames', num: true, cell: (s) => num(s.timing.framesToVerdict) },
    { label: 'Wash lock ms', num: true, cell: (s) => num(s.timing.washLockMs) },
    { label: 'Tag lock ms', num: true, cell: (s) => num(s.timing.tagLockMs) },
    { label: 'Scan', cell: (s) => idTag('scan', s.eventId) },
  ];
  COLS.scans = [
    { label: 'Time', nowrap: true, cell: (s) => timeCell(s.tsDevice) },
    { label: 'Unit', cell: (s) => twoLine(s.unitId.toUpperCase(), variantName(s.variant)) },
    { label: 'Device', cell: (s) => deviceLink(s.device.installId, s.device.label) },
    { label: 'Result', cell: (s) => resultBadge(s.scan.result) },
    { label: 'SIZE', title: 'Wash SIZE / tag SIZE', cell: (s) => pair(sizeOf(s.scan.wash), sizeOf(s.scan.tag)) },
    { label: 'PO', cell: (s) => (s.session.po ? poLink(s.unitId, s.variant, s.session.po) : '—') },
    { label: 'APK / version', cell: (s) => buildText(s.build) },
  ];
  COLS.posSimple = [
    { label: 'PO', cell: (p) => poLink(p.unitId, p.variant, p.po) },
    { label: 'Unit', cell: (p) => twoLine(p.unitId.toUpperCase(), variantName(p.variant)) },
    { label: 'Target', num: true, cell: (p) => num(p.targetQuantity) },
    { label: 'Completed', num: true, title: 'Counted MATCH scans. MISMATCH is not counted.', cell: (p) => p.validMatchCount },
    { label: 'Remaining', num: true, cell: (p) => num(p.remaining) },
    { label: 'Status', cell: (p) => badge(p.status, p.status === 'COMPLETE' ? 'COMPLETE' : 'IN PROGRESS') },
    { label: 'Devices', cell: (p) => p.devices.map((d, i) => [i ? ', ' : '', deviceLink(d.installId, d.deviceLabel)]) },
  ];

  function poLink(unitId, variant, po) {
    return h('a', { href: link('po', undefined, { unitId, variant, po }), title: `PO ${po} (${variant})` },
      h('span', { class: 'id po' }, po));
  }

  function sessionBadge(s) {
    if (s.endedAt) return badge('', 'ended');
    if (s.lastEventAt !== null && serverNow() - s.lastEventAt <= state.activeWindowMs) return badge('active', 'active');
    return h('span', { class: 'badge idle', title: 'No end event and no activity inside the active window' }, 'idle');
  }

  const bool = (v) => (v === true ? 'yes' : v === false ? 'no' : '—');
  const list = (a) => (a && a.length ? a.join(', ') : '—');
  function sideKv(side, withStyle) {
    return kv([
      ['SIZE', side.size], ['SIZE as printed', side.sizeDisplay], ['Waist', side.waist],
      ['Hip', side.hip], ['Inseam', side.inseam], withStyle ? ['Style', side.style] : null,
      ['Measurements', list(side.measurements)],
    ]);
  }
  function scanDetail(s) {
    const sc = s.scan; const t = s.timing; const b = s.build;
    return h('div', { class: 'grid2' },
      panel('Scan identity', kv([
        ['eventId', idTag('scan', s.eventId, null, true)], ['Event type', s.eventType], ['seq (per install)', num(s.seq)],
        ['scanCycleId', h('span', { class: 'mono' }, sc.scanCycleId || '—')],
        ['Device time', fmtTime(s.tsDevice)], ['Server received', fmtTime(s.serverReceivedAt)],
      ])),
      panel('Device & build', kv([
        ['Device label', s.device.label], ['installId', idTag('install', s.device.installId, link('device', s.device.installId), true)],
        ['androidIdHash', idTag('tablet', s.device.androidIdHash, null, true)],
        ['Unit / variant', `${s.unitId.toUpperCase()} / ${s.variant}`], ['applicationId', b.applicationId], ['Flavor', b.flavor],
        ['Version', `${b.versionName} (${b.versionCode}) ${b.buildType}`], ['PO/Admin', poAdminFlag(b.enablePoAdmin)], ['Demo', demoFlag(b.adminDemoMode)],
      ])),
      panel('Session & PO', kv([
        ['App session', idTag('session', s.session.appSessionId, null, true)],
        ['Scanner session', idTag('session', s.session.scannerSessionId, s.session.scannerSessionId ? link('session', s.session.scannerSessionId, { kind: 'scanner' }) : null, true)],
        ['PO', s.session.po ? poLink(s.unitId, s.variant, s.session.po) : '—'],
        ['PO session', idTag('po', s.session.poSessionId, null, true)],
        ['Target quantity', num(sc.targetQuantity)], ['Valid MATCH count after this scan', num(sc.validMatchCount)],
        ['PO batch complete', bool(sc.poBatchComplete)],
      ])),
      panel('Result', kv([
        ['Result', resultBadge(sc.result)], ['Mode', sc.mode], ['SIZE ok', bool(sc.sizeOk)], ['Style ok', bool(sc.styleOk)],
        ['Style blocks match', bool(sc.styleBlocksMatch)], ['Template family', sc.templateFamily],
        ['Incomplete at stage', sc.incompleteAtStage], ['Incomplete reason', sc.incompleteReason],
      ])),
      panel('Wash-care', sideKv(sc.wash, true)),
      panel('Tag', sideKv(sc.tag, false), kv([['Style scan', sc.styleScan]])),
      panel('Timing', kv([
        ['Compare ms', num(t.compareMs)], ['Cycle ms', num(t.cycleMs)], ['Frames to verdict', num(t.framesToVerdict)],
        ['Wash lock ms / frames', `${num(t.washLockMs)} / ${num(t.washLockFrames)}`],
        ['Style lock ms / frames', `${num(t.styleLockMs)} / ${num(t.styleLockFrames)}`],
        ['Tag lock ms / frames', `${num(t.tagLockMs)} / ${num(t.tagLockFrames)}`],
      ])));
  }
  const scansTable = (items, empty) => table(COLS.scans, items, { detail: scanDetail, key: (s) => s.eventId, empty: empty || 'No scans.' });

  function legend() {
    const items = [
      ['install', 'Install identity: installId', 'One app package installed on one tablet (a per-package UUID). A reinstall creates a new installId. This is the primary device identity.'],
      ['tablet', 'Physical tablet: androidIdHash', 'A hash of the Android ID. It groups the Label IQ packages installed on the same physical tablet. IP, MAC and serial are never used or stored.'],
      ['build', 'APK/build identity', 'applicationId + flavor + buildType + versionName + versionCode + unit + PO/Admin flag + demo flag. The variant keeps U10 / U10-Standalone and U35 / U35 Demo / U35 PO apart.'],
      ['session', 'Session identity', 'App session = one run of the app process. Scanner session = one opening of the scanner screen.'],
      ['po', 'PO identity', 'Unit + variant + PO number. A PO session is one PO batch run on one tablet; one PO can span several PO sessions.'],
      ['scan', 'Scan identity: eventId', 'One SCAN_RESULT / SCAN_INCOMPLETE event, stored once on the server. seq orders the events of one install.'],
    ];
    return h('div', { class: 'panel legend' },
      items.map(([k, t, w]) => h('div', null, h('span', { class: `id ${k}` }, t), h('span', { class: 'what' }, w))));
  }

  async function viewReports(_, p) {
    const f = pick(p, VIEW_FILTERS.reports);
    const [ov, un, sess] = await Promise.all([
      api('/v1/dashboard/overview', f),
      api('/v1/dashboard/units', pick(p, ['from', 'to'])),
      api('/v1/sessions', { ...pick(p, ['unitId', 'variant', 'from', 'to']), limit: 12 }),
    ]);
    state.activeWindowMs = ov.activeWindowMs;
    updateVariants(un.items);
    let rows = un.items;
    if (f.unitId) rows = rows.filter((r) => r.unitId === f.unitId);
    if (f.variant) rows = rows.filter((r) => r.variant === f.variant);
    const t = ov.totals;
    const range = (f.from || f.to) ? 'Selected dates' : 'All time';
    return [
      pageHead('Reports', range),
      statPanel([{ title: range, stats: [
        { k: 'Scans', v: t.scans },
        { k: 'MATCH', v: t.match, cls: 'match' },
        { k: 'MISMATCH', v: t.mismatch, cls: 'mismatch' },
        { k: 'Incomplete', v: t.incomplete },
        { k: 'Active sessions', v: t.activeSessions, title: 'Scanner sessions with no end event and recent activity' },
        { k: 'POs active', v: t.posInProgress },
        { k: 'POs complete', v: t.posComplete },
      ] }]),
      section('Units', 'each APK stays separate',
        table([
          { label: 'Unit', cell: (r) => r.unitId.toUpperCase() },
          { label: 'APK', cell: (r) => variantLink(r.variant) },
          { label: 'Devices', num: true, cell: (r) => r.devices },
          { label: 'Scans', num: true, cell: (r) => r.counts.scans },
          { label: 'MATCH', num: true, cell: (r) => r.counts.match },
          { label: 'MISMATCH', num: true, cell: (r) => r.counts.mismatch },
          { label: 'POs', num: true, title: 'In progress / complete', cell: (r) => `${r.pos.IN_PROGRESS} / ${r.pos.COMPLETE}` },
          { label: 'Last seen', nowrap: true, cell: (r) => (r.lastSeen ? timeCell(r.lastSeen) : h('span', { class: 'muted' }, 'no data yet')) },
        ], rows, {
          empty: 'No units.',
          detail: (r) => kv([
            ['Variant id', h('span', { class: 'mono' }, r.variant)],
            ['Tablets', r.physicalTablets],
            ['Builds seen', r.builds],
            ['Current builds', r.currentBuilds.length
              ? r.currentBuilds.map((b) => `${b.versionName} (${b.versionCode}) × ${b.devices}`).join(', ') : '—'],
            ['Incomplete', r.counts.incomplete],
            ['Active sessions', r.activeSessions],
          ]),
          key: (r) => `unit:${r.unitId}:${r.variant}`,
        }),
        h('p', { class: 'note' }, h('a', { href: link('units', undefined, pick(p, ['from', 'to'])) }, 'All unit columns'))),
      section('APK / builds in use', null,
        table([
          { label: 'APK', cell: (b) => variantLink(b.variant) },
          { label: 'Version', cell: (b) => h('a', { href: link('build', b.buildId) }, buildText(b)) },
          { label: 'Devices', num: true, cell: (b) => b.currentDeviceCount },
          { label: 'Last seen', nowrap: true, cell: (b) => timeCell(b.lastSeen) },
        ], ov.buildDistribution, { empty: 'No builds reported yet.' })),
      fold('Build details',
        table([
          { label: 'Build', cell: (b) => idTag('build', `#${b.buildId}`, link('build', b.buildId), true) },
          { label: 'Variant', cell: (b) => variantLink(b.variant) },
          { label: 'applicationId', cell: (b) => h('span', { class: 'mono' }, b.applicationId) },
          { label: 'Flavor', cell: (b) => b.flavor },
          { label: 'Version', cell: (b) => buildText(b) },
          { label: 'Type', cell: (b) => b.buildType },
          { label: 'PO/Admin', cell: (b) => poAdminFlag(b.enablePoAdmin) },
          { label: 'Demo', cell: (b) => demoFlag(b.adminDemoMode) },
          { label: 'Devices', num: true, cell: (b) => b.currentDeviceCount },
          { label: 'Last seen', nowrap: true, cell: (b) => timeCell(b.lastSeen) },
        ], ov.buildDistribution, { empty: 'No builds reported yet.' }),
        h('p', { class: 'note' }, h('a', { href: link('builds', undefined, pick(p, ['unitId', 'variant'])) }, 'All APK / builds'))),
      section('Recent sessions', null,
        table([
          { label: 'Status', cell: (s) => sessionBadge(s) },
          { label: 'Started', nowrap: true, cell: (s) => timeCell(s.startedAt ?? s.firstEventAt) },
          { label: 'Unit', cell: (s) => twoLine(s.unitId.toUpperCase(), variantName(s.variant)) },
          { label: 'Device', cell: (s) => deviceLink(s.installId, s.deviceLabel) },
          { label: 'PO', cell: (s) => (s.po ? poLink(s.unitId, s.variant, s.po) : '—') },
          { label: 'Scans', num: true, cell: (s) => s.counts.scans },
          { label: 'MATCH', num: true, cell: (s) => s.counts.match },
        ], sess.items, {
          empty: 'No sessions.',
          open: (s) => link('session', s.sessionId, { kind: s.kind || 'scanner' }),
        }),
        h('p', { class: 'note' }, h('a', { href: link('sessions', undefined, pick(p, ['unitId', 'variant', 'from', 'to'])) }, 'All sessions'))),
      fold('Identity levels', legend()),
    ];
  }

  // --- views ----------------------------------------------------------------------------------

  const activityBrief = [
    { label: 'Time', nowrap: true, cell: (e) => timeCell(e.tsDevice) },
    { label: 'Unit', cell: (e) => e.unitId.toUpperCase() },
    { label: 'Device', cell: (e) => tabletLink(e.androidIdHash || `install:${e.installId}`, e.deviceLabel) },
    { label: 'Activity', cell: (e) => [e.eventType.replace(/_/g, ' '), ' ', activityDetail(e)] },
  ];

  function summaryCard(ov) {
    const t = ov.totals;
    const builds = ov.buildDistribution.map((b) =>
      `${variantName(b.variant)} ${b.versionName} (${b.versionCode}) × ${b.currentDeviceCount}`);
    return h('div', { class: 'panel summary' },
      h('h2', null, 'Units, devices, and builds'),
      h('p', { class: 'summary-line' }, `${t.units} units · ${t.devices} devices · ${t.physicalTablets} tablets`),
      h('div', { class: 'summary-builds' }, builds.length
        ? builds.map((line) => h('div', null, line))
        : 'No builds reported yet.'),
      h('p', { class: 'note' }, h('a', { href: '#/reports' }, 'Open the full report')));
  }

  async function viewOverview(_, p) {
    const f = pick(p, VIEW_FILTERS.overview);
    const scope = pick(p, ['unitId', 'variant']);
    const [ov, un, fl, act] = await Promise.all([
      api('/v1/dashboard/overview', f),
      api('/v1/dashboard/units', pick(p, ['from', 'to'])),
      api('/v1/dashboard/fleet', { ...scope, limit: 1 }),
      api('/v1/dashboard/activity', { ...scope, ...pick(p, ['from', 'to']), limit: 8 }),
    ]);
    state.activeWindowMs = ov.activeWindowMs;
    updateVariants(un.items);
    const t = ov.totals;
    const sc = fl.statusCounts;
    const day = fl.totals;
    const groups = [
      { title: 'Devices', stats: [
        { k: 'Active', v: sc.ONLINE, cls: 'online', title: STATUS_TITLE.ONLINE },
        { k: 'Recent', v: sc.RECENT, title: STATUS_TITLE.RECENT },
        { k: 'Offline', v: sc.OFFLINE, cls: 'offline', title: STATUS_TITLE.OFFLINE },
      ] },
      { title: `Today · ${fl.day}`, stats: [
        { k: 'Scans', v: day.scansToday },
        { k: 'MATCH', v: day.matchToday, cls: 'match' },
        { k: 'MISMATCH', v: day.mismatchToday, cls: 'mismatch' },
      ] },
      { title: 'POs', stats: [
        { k: 'Active', v: t.posInProgress, title: 'IN PROGRESS. MATCH scans count toward the target.' },
        { k: 'Complete', v: t.posComplete },
      ] },
    ];
    const ranged = (f.from || f.to)
      ? h('p', { class: 'note' },
        `Selected dates: ${t.scans} scans, ${t.match} MATCH, ${t.mismatch} MISMATCH, ${t.incomplete} incomplete.`)
      : null;
    return [
      pageHead('Overview'),
      statPanel(groups),
      ranged,
      summaryCard(ov),
      section('Recent activity', null,
        table(activityBrief, act.items, { empty: 'No activity yet.' }),
        h('p', { class: 'note' }, h('a', { href: link('scans', undefined, scope) }, 'All scans'))),
    ];
  }

  async function viewUnits(_, p) {
    const un = await api('/v1/dashboard/units', pick(p, VIEW_FILTERS.units));
    state.activeWindowMs = un.activeWindowMs;
    updateVariants(un.items);
    return [crumbs([['Reports', '#/reports'], ['Units']]),
      pageHead('Units', 'Each APK is its own row. Standalone, demo, and PO builds never mix.'),
      table(COLS.units, un.items)];
  }

  async function viewUnit(variant) {
    const [un, devs, builds, sess, pos, scans] = await Promise.all([
      api('/v1/dashboard/units'), api('/v1/devices', { variant, limit: 500 }), api('/v1/builds', { variant, limit: 200 }),
      api('/v1/sessions', { variant, limit: 20 }), api('/v1/dashboard/pos', { variant, limit: 20 }),
      api('/v1/scans', { variant, limit: 25 })]);
    updateVariants(un.items);
    const u = un.items.find((x) => x.variant === variant);
    const f = { variant };
    return [
      crumbs([['Reports', '#/reports'], ['Units', '#/units'], [`Unit ${variantName(variant)}`]]),
      u ? panel(null, kv([
        ['Variant', `${variantName(variant)} (${variant})`], ['Unit', u.unitId.toUpperCase()],
        ['Devices / tablets', `${u.devices} / ${u.physicalTablets}`], ['Builds seen', u.builds],
        ['Scans (MATCH / MISMATCH / INCOMPLETE)', `${u.counts.scans} (${u.counts.match} / ${u.counts.mismatch} / ${u.counts.incomplete})`],
        ['Active sessions', u.activeSessions], ['POs in progress / complete', `${u.pos.IN_PROGRESS} / ${u.pos.COMPLETE}`],
        ['Last seen', timeCell(u.lastSeen)],
      ])) : errBox(`Unknown variant ${variant}`),
      section('Devices', null, table(COLS.devices, devs.items, { empty: 'No devices for this variant yet.' })),
      section('APK/builds', null, table(COLS.builds, builds.items)),
      section('Recent sessions', null, table(COLS.sessions, sess.items), seeAll('sessions', f)),
      section('POs', 'MATCH-only counting', table(COLS.pos, pos.items, { empty: 'No PO scans.' }), seeAll('pos', f)),
      section('Recent scans', 'click a row for all fields', scansTable(scans.items), seeAll('scans', f)),
    ];
  }

  const FLEET_QUERY = ['unitId', 'variant', 'installId', 'deviceLabel', 'applicationId', 'flavor',
    'versionName', 'versionCode', 'androidIdHash', 'status', 'date'];

  async function viewDevices(_, p) {
    const hasRange = !!(p.from || p.to);
    const fleetParams = pick(p, FLEET_QUERY);
    if (hasRange) fleetParams.limit = 1000;
    else Object.assign(fleetParams, pick(p, ['offset']));
    const actParams = { ...pick(p, ['unitId', 'variant', 'installId', 'deviceLabel', 'applicationId',
      'flavor', 'versionName', 'versionCode', 'androidIdHash', 'from', 'to']), limit: 12 };
    const [fl, act, ranged] = await Promise.all([
      api('/v1/dashboard/fleet', fleetParams),
      api('/v1/dashboard/activity', actParams),
      hasRange ? api('/v1/devices', { ...pick(p, COMMON), limit: 1000 }) : null,
    ]);
    let items = fl.items;
    let page = fl;
    let rangeNote = null;
    if (hasRange) {
      const allowed = new Set(ranged.items.map((d) => d.installId));
      const all = items.filter((i) => allowed.has(i.installId));
      const off = Number(p.offset || 0);
      const limit = 100;
      items = all.slice(off, off + limit);
      page = { count: items.length, limit, offset: off, hasMore: off + limit < all.length };
      const clipped = fl.hasMore || ranged.hasMore;
      rangeNote = h('p', { class: 'note' },
        'This list is limited to devices with events in the selected dates.',
        clipped ? ' More than 1,000 devices matched; narrow the filters to see every one.' : '');
    }
    const day = p.date ? fl.day : 'today';
    return [
      pageHead('Devices', `Active ≤ 5 min · Recent ≤ 30 min · Offline after that. Scans are for ${day}.`),
      rangeNote,
      pager(page, 'devices', undefined, p),
      table([
        { label: 'Unit', cell: (i) => twoLine(i.unitId.toUpperCase(), variantName(i.variant)) },
        { label: 'Device', cell: (i) => twoLine(i.deviceLabel || '(no label)', [i.manufacturer, i.model].filter(Boolean).join(' ')) },
        { label: 'APK / version', cell: (i) => twoLine(buildText(i.currentBuild), i.currentBuild.flavor) },
        { label: 'Status', cell: (i) => statusBadge(i.status) },
        { label: 'Last seen', nowrap: true, cell: (i) => agoCell(i.lastSeen) },
        { label: 'Scans today', num: true, cell: (i) => i.today.scans },
      ], items, {
        empty: 'No devices match these filters.',
        open: (i) => link('installation', i.installId),
      }),
      h('p', { class: 'note' },
        `${fl.totals.tablets} physical tablets · ${fl.totals.installations} installations. `,
        h('a', { href: link('fleet', undefined, pick(p, VIEW_FILTERS.fleet)) }, 'Full device details')),
      fold('Physical tablets',
        h('p', { class: 'note' }, 'Installations on the same androidIdHash are one tablet. A missing hash stays on its own.'),
        table(COLS.tablets, fl.tablets, { empty: 'No tablets match these filters.' })),
      fold('Latest activity', table(COLS.activity, act.items, { empty: 'No events.' })),
      fold('All columns',
        h('p', { class: 'note' }, 'Identity, build flags, and all-time counts for the devices in this list.'),
        table([
        { label: 'Unit', cell: (i) => i.unitId.toUpperCase() },
        { label: 'Device', cell: (i) => i.deviceLabel || '(no label)' },
        { label: 'installId', cell: (i) => idTag('install', i.installId, link('installation', i.installId)) },
        { label: 'androidIdHash', cell: (i) => idTag('tablet', i.androidIdHash, i.tabletKey ? link('tablet', i.tabletKey) : null) },
        { label: 'Model', cell: (i) => [i.manufacturer, i.model].filter(Boolean).join(' ') || '—' },
        { label: 'SDK', num: true, cell: (i) => num(i.sdk) },
        { label: 'applicationId', cell: (i) => h('span', { class: 'mono' }, i.currentBuild.applicationId) },
        { label: 'Flavor', cell: (i) => i.currentBuild.flavor },
        { label: 'Variant', cell: (i) => variantLink(i.variant) },
        { label: 'Version', cell: (i) => h('a', { href: link('build', i.currentBuild.buildId) }, buildText(i.currentBuild)) },
        { label: 'PO/Admin', cell: (i) => poAdminFlag(i.currentBuild.enablePoAdmin) },
        { label: 'Demo', cell: (i) => demoFlag(i.currentBuild.adminDemoMode) },
        { label: 'Status', cell: (i) => statusBadge(i.status) },
        { label: 'Last seen', cell: (i) => agoCell(i.lastSeen) },
        { label: 'Sessions', num: true, title: 'Scanner / app', cell: (i) => `${i.sessions.scanner} / ${i.sessions.app}` },
        { label: 'Scans', num: true, cell: (i) => i.counts.scans },
        { label: 'MATCH', num: true, cell: (i) => i.counts.match },
        { label: 'MISMATCH', num: true, cell: (i) => i.counts.mismatch },
        { label: 'Scans today', num: true, cell: (i) => i.today.scans },
        { label: 'MATCH today', num: true, cell: (i) => i.today.match },
        { label: 'MISMATCH today', num: true, cell: (i) => i.today.mismatch },
      ], items, { empty: 'No devices match these filters.' })),
    ];
  }

  async function viewDevice(installId) {
    const [dres, builds, ssn, apps, pos, scans, all] = await Promise.all([
      api('/v1/devices', { installId }), api('/v1/builds', { installId, limit: 100 }),
      api('/v1/sessions', { installId, limit: 50 }), api('/v1/sessions', { installId, kind: 'app', limit: 20 }),
      api('/v1/dashboard/pos', { installId, limit: 50 }), api('/v1/scans', { installId, limit: 100 }),
      api('/v1/devices', { limit: 1000 })]);
    const d = dres.items[0];
    if (!d) return [crumbs([['Master', '#/overview'], ['Device']]), errBox('No device with this installId.')];
    const b = d.currentBuild;
    const cur = builds.items.find((x) => sameBuild(x, b));
    const siblings = all.items.filter((x) => d.androidIdHash && x.androidIdHash === d.androidIdHash && x.installId !== d.installId);
    return [
      crumbs([['Devices', '#/devices'], [`Unit ${variantName(d.variant)}`, link('unit', d.variant)], [`Device ${d.deviceLabel || short(d.installId)}`]]),
      h('div', { class: 'grid2' },
        panel('Device identity', kv([
          ['Device label', d.deviceLabel || '(no label)'],
          ['installId', idTag('install', d.installId, null, true)],
          ['androidIdHash', idTag('tablet', d.androidIdHash, null, true)],
          ['Model', [d.manufacturer, d.model].filter(Boolean).join(' ')], ['SDK', num(d.sdk)],
          ['Unit', d.unitId.toUpperCase()], ['Variant', variantLink(d.variant)],
          ['First seen', timeCell(d.firstSeen)], ['Last seen (upload)', timeCell(d.lastSeen)],
          ['Last event (device time)', timeCell(d.lastEventAt)], ['Events', d.eventCount],
          ['Scans (MATCH / MISMATCH / INCOMPLETE)', `${d.counts.scans} (${d.counts.match} / ${d.counts.mismatch} / ${d.counts.incomplete})`],
        ])),
        panel('Current APK/build', kv([
          ['Build', cur ? idTag('build', `#${cur.buildId}`, link('build', cur.buildId), true) : '—'],
          ['applicationId', h('span', { class: 'mono' }, b.applicationId)], ['Flavor', b.flavor], ['Variant', d.variant],
          ['versionName', b.versionName], ['versionCode', b.versionCode], ['Build type', b.buildType],
          ['PO/Admin', poAdminFlag(b.enablePoAdmin)], ['Demo mode', demoFlag(b.adminDemoMode)],
        ]))),
      section('Other packages on the same physical tablet', 'same androidIdHash',
        table(COLS.devices, siblings, { empty: 'None reported.' })),
      section('Builds used by this install', null, table(COLS.builds, builds.items)),
      section('Scanner sessions', null, table(COLS.sessions, ssn.items, { empty: 'No scanner sessions.' })),
      section('App sessions', null, table(COLS.sessions, apps.items, { empty: 'No app sessions.' })),
      section('POs', 'MATCH-only counting', table(COLS.pos, pos.items, { empty: 'No PO scans from this device.' })),
      section('Scan history', 'latest 100; click a row for all fields', scansTable(scans.items), seeAll('scans', { installId })),
    ];
  }

  async function viewBuilds(_, p) {
    const f = pick(p, [...VIEW_FILTERS.builds, 'offset']);
    const res = await api('/v1/builds', f);
    return [crumbs([['Reports', '#/reports'], ['APK / builds']]),
      pageHead('APK / builds'),
      pager(res, 'builds', undefined, f),
      table(COLS.builds, res.items, { empty: 'No builds match these filters.' })];
  }

  async function viewBuild(buildId) {
    const all = await api('/v1/builds', { limit: 1000 });
    const b = all.items.find((x) => String(x.buildId) === String(buildId));
    if (!b) return [crumbs([['Master', '#/overview'], ['Build']]), errBox('Unknown build.')];
    const f = { applicationId: b.applicationId, flavor: b.flavor, versionName: b.versionName, versionCode: b.versionCode, buildType: b.buildType };
    const [devs, sess, scans, pos] = await Promise.all([
      api('/v1/devices', { ...f, limit: 1000 }), api('/v1/sessions', { ...f, limit: 20 }),
      api('/v1/scans', { ...f, limit: 50 }), api('/v1/dashboard/pos', { ...f, limit: 20 })]);
    const running = devs.items.filter((d) => sameBuild(d.currentBuild, b));
    return [
      crumbs([['Reports', '#/reports'], ['APK / builds', '#/builds'], [`Build ${b.versionName} (${b.versionCode})`]]),
      panel('APK/build identity', kv([
        ['Build', idTag('build', `#${b.buildId}`, null, true)], ['applicationId', h('span', { class: 'mono' }, b.applicationId)],
        ['Flavor', b.flavor], ['Variant', variantLink(b.variant)], ['Unit', `${b.unitId.toUpperCase()} (${b.unitLabel || '—'})`],
        ['versionName', b.versionName], ['versionCode', b.versionCode], ['Build type', b.buildType],
        ['PO/Admin', poAdminFlag(b.enablePoAdmin)], ['Demo mode', demoFlag(b.adminDemoMode)],
        ['Running on (current build of)', `${b.currentDeviceCount} device(s)`], ['Devices ever', b.deviceCount],
        ['First seen', timeCell(b.firstSeen)], ['Last seen', timeCell(b.lastSeen)], ['Events', b.totalEventCount],
      ])),
      section('Devices running this build', null, table(COLS.devices, running, { empty: 'No device currently reports this build.' })),
      section('Recent sessions', null, table(COLS.sessions, sess.items)),
      b.enablePoAdmin ? section('POs', 'MATCH-only counting', table(COLS.pos, pos.items, { empty: 'No PO scans.' })) : null,
      section('Recent scans', 'click a row for all fields', scansTable(scans.items.filter((s) => sameBuild(s.build, b))), seeAll('scans', f)),
    ];
  }

  async function viewSessions(_, p) {
    const f = pick(p, [...VIEW_FILTERS.sessions, 'offset']);
    const res = await api('/v1/sessions', f);
    const mins = Math.round(state.activeWindowMs / 60000);
    return [crumbs([['Reports', '#/reports'], ['Sessions']]),
      pageHead('Sessions', `Active means no end event and activity in the last ${mins} min. Idle means the session was left open.`),
      pager(res, 'sessions', undefined, f), table(COLS.sessions, res.items, { empty: 'No sessions match these filters.' })];
  }

  async function viewSession(id, p) {
    const kind = p.kind === 'app' ? 'app' : 'scanner';
    const [sres, scans] = await Promise.all([
      api('/v1/sessions', { sessionId: id, kind }), api('/v1/scans', { sessionId: id, limit: 500 })]);
    const s = sres.items.find((x) => x.sessionId === id) || sres.items[0];
    if (!s) return [crumbs([['Master', '#/overview'], ['Session']]), errBox('Unknown session.')];
    return [
      crumbs([['Reports', '#/reports'], ['Sessions', '#/sessions'],
        [`Device ${s.deviceLabel || short(s.installId)}`, link('device', s.installId)], [`${kind === 'app' ? 'App' : 'Scanner'} session`]]),
      panel('Session identity', kv([
        ['Session ID', idTag('session', s.sessionId, null, true)], ['Kind', kind], ['Status', sessionBadge(s)],
        ['Device', deviceLink(s.installId, s.deviceLabel)], ['installId', idTag('install', s.installId, null, true)],
        ['Variant', variantLink(s.variant)], ['Build', `${buildText(s.build)} ${s.build.buildType} · ${s.build.applicationId}`],
        ['PO', s.po ? poLink(s.unitId, s.variant, s.po) : '—'], ['PO session', idTag('po', s.poSessionId, null, true)],
        ['Started', timeCell(s.startedAt)], ['Ended', timeCell(s.endedAt)], ['Last event', timeCell(s.lastEventAt)],
        ['Events', s.eventCount],
        ['Scans (MATCH / MISMATCH / INCOMPLETE)', `${s.counts.scans} (${s.counts.match} / ${s.counts.mismatch} / ${s.counts.incomplete})`],
      ])),
      section('Scans in this session', 'click a row for all fields', scansTable(scans.items)),
    ];
  }

  async function viewPos(_, p) {
    const f = pick(p, [...VIEW_FILTERS.pos, 'offset']);
    const res = await api('/v1/dashboard/pos', f);
    return [
      pageHead('POs', 'Only MATCH scans count. MISMATCH and incomplete scans do not change the target.'),
      pager(res, 'pos', undefined, f),
      table(COLS.posSimple, res.items, {
        empty: 'No PO scans match these filters.',
        open: (row) => link('po', undefined, { unitId: row.unitId, variant: row.variant, po: row.po }),
      }),
      fold('More columns',
        h('p', { class: 'note' }, 'Not counted, PO sessions, and scan times. Open a PO for the full history.'),
        table(COLS.pos, res.items, { empty: 'No PO scans match these filters.' })),
    ];
  }

  async function viewPo(_, p) {
    const key = { unitId: p.unitId, variant: p.variant, po: p.po };
    if (!key.po) return [crumbs([['Master', '#/overview'], ['PO']]), errBox('No PO selected.')];
    const [sum, all] = await Promise.all([
      api('/v1/dashboard/pos', key), api('/v1/scans', { ...key, hasPo: 'true', limit: 1000 })]);
    const po = sum.items[0];
    if (!po) return [crumbs([['Master', '#/overview'], ['PO']]), errBox('No scans for this PO.')];
    const isCounted = (s) => s.eventType === 'SCAN_RESULT' && s.scan.result === 'MATCH' && s.scan.validMatchCount !== null;
    const counted = all.items.filter(isCounted).sort((a, b) => a.tsDevice - b.tsDevice || (a.eventId < b.eventId ? -1 : 1));
    const notCounted = all.items.filter((s) => !isCounted(s));
    const sizes = {};
    for (const s of counted) {
      const size = s.scan.wash.size || s.scan.tag.size;
      if (size) sizes[size] = (sizes[size] || 0) + 1;
    }
    return [
      crumbs([['POs', '#/pos'], [`Unit ${variantName(po.variant)}`, link('unit', po.variant)], [`PO ${po.po}`]]),
      h('div', { class: 'grid2' },
        panel('PO', kv([
          ['PO number', h('span', { class: 'id po' }, po.po)], ['Unit / variant', `${po.unitId.toUpperCase()} / ${variantName(po.variant)}`],
          ['Status', badge(po.status, po.status === 'COMPLETE' ? 'COMPLETE' : 'IN PROGRESS')],
          ['Target quantity', num(po.targetQuantity)], ['Completed MATCH count', po.validMatchCount], ['Remaining', num(po.remaining)],
          ['Not counted (MISMATCH / INCOMPLETE)', `${po.notCounted.mismatch} / ${po.notCounted.incomplete}`],
          ['First scan', timeCell(po.firstScanAt)], ['Last counted MATCH', timeCell(po.lastMatchAt)], ['Last scan', timeCell(po.lastScanAt)],
          ['Builds', list(po.versionNames)],
        ])),
        panel('SIZE breakdown (counted MATCH)', Object.keys(sizes).length
          ? kv(Object.keys(sizes).sort().map((k) => [k, sizes[k]])) : h('p', { class: 'muted' }, 'No counted MATCH yet.')),
        panel('Contributing devices', table([
          { label: 'Device', cell: (d) => deviceLink(d.installId, d.deviceLabel) },
          { label: 'installId', cell: (d) => idTag('install', d.installId) },
          { label: 'Counted MATCH', num: true, cell: (d) => d.countedMatchScans },
          { label: 'All scans', num: true, cell: (d) => d.scans },
        ], po.devices)),
        panel('PO sessions', po.poSessionIds.map((id) => h('div', null,
          idTag('po', id, link('scans', undefined, { sessionId: id }), true),
          id === po.lastPoSessionId ? h('span', { class: 'muted' }, ' (latest counted)') : null)))),
      section('Counted scan history', 'MATCH only, oldest first', table([
        { label: '#', num: true, cell: (s) => num(s.scan.validMatchCount) },
        { label: 'Time (device)', cell: (s) => timeCell(s.tsDevice) },
        { label: 'Result', cell: (s) => resultBadge(s.scan.result) },
        { label: 'SIZE', cell: (s) => s.scan.wash.size || s.scan.tag.size || '—' },
        { label: 'Device', cell: (s) => deviceLink(s.device.installId, s.device.label) },
        { label: 'Build', cell: (s) => buildText(s.build) },
        { label: 'Batch complete', cell: (s) => bool(s.scan.poBatchComplete) },
        { label: 'PO session', cell: (s) => idTag('po', s.session.poSessionId) },
        { label: 'Scan', cell: (s) => idTag('scan', s.eventId) },
      ], counted, { detail: scanDetail, key: (s) => s.eventId, empty: 'No counted MATCH scans yet.' })),
      section('Not counted toward the PO', 'MISMATCH / INCOMPLETE, newest first', scansTable(notCounted, 'None.')),
    ];
  }

  async function viewScans(_, p) {
    const f = pick(p, [...VIEW_FILTERS.scans, 'offset']);
    const res = await api('/v1/scans', f);
    return [
      pageHead('Scans', 'Click a row for wash, tag, timings, and identities.'),
      pager(res, 'scans', undefined, f),
      scansTable(res.items, 'No scans match these filters.'),
      fold('All scan columns',
        table(COLS.scansFull, res.items, { detail: scanDetail, key: (s) => `full:${s.eventId}`, empty: 'No scans match these filters.' })),
    ];
  }

  // --- Device Management: Physical tablet → App installation → APK/build → Session → Scan -----

  const STATUS_TITLE = {
    ONLINE: 'Latest event received by the server within the last 5 min',
    RECENT: 'Latest event received 5–30 min ago',
    OFFLINE: 'No event received for more than 30 min',
  };
  const statusBadge = (s) => h('span', { class: `badge ${s}`, title: STATUS_TITLE[s] }, s);
  const agoCell = (ms) => (ms === null || ms === undefined ? h('span', { class: 'muted' }, '—')
    : h('span', { title: fmtTime(ms) }, ago(ms)));
  const tabletLink = (key, text) => h('a', { href: link('tablet', key), title: `Physical tablet ${key}` }, text || '(no label)');
  const installLink = (id) => idTag('install', id, link('installation', id));
  const latestScanCell = (l) => (l ? [resultBadge(l.result), ' ', pair(l.washSize, l.tagSize), ' ',
    h('span', { class: 'muted' }, ago(l.tsDevice))] : '—');

  function hierarchy() {
    const levels = [['tablet', 'Physical tablet'], ['install', 'App installation'], ['build', 'APK/build'],
      ['session', 'Session'], ['scan', 'Scan']];
    const out = [];
    levels.forEach(([k, t], n) => {
      if (n) out.push(h('span', { class: 'sep' }, icon('arrow-right', 14)));
      out.push(h('span', { class: `id ${k}` }, t));
    });
    return h('div', { class: 'hierarchy' }, out);
  }

  function activityDetail(e) {
    if (e.scan) {
      return [resultBadge(e.scan.result), ' ', pair(e.scan.washSize, e.scan.tagSize),
        e.session.po ? [' · PO ', poLink(e.unitId, e.variant, e.session.po),
          e.scan.validMatchCount !== null ? ` ${e.scan.validMatchCount}/${num(e.scan.targetQuantity)}` : ''] : ''];
    }
    if (e.config) return `${e.config.key}: ${e.config.oldValue ?? '—'} → ${e.config.newValue ?? '—'}`;
    return e.session.po ? ['PO ', poLink(e.unitId, e.variant, e.session.po)] : '—';
  }

  COLS.fleet = [
    { label: 'Unit', cell: (i) => i.unitId.toUpperCase() },
    { label: 'Device', cell: (i) => tabletLink(i.tabletKey, i.deviceLabel) },
    { label: 'Installation', cell: (i) => installLink(i.installId) },
    { label: 'APK', cell: (i) => h('span', null, variantLink(i.variant), ' ', h('span', { class: 'muted mono' }, i.currentBuild.applicationId)) },
    { label: 'Version', cell: (i) => h('a', { href: link('build', i.currentBuild.buildId) }, buildText(i.currentBuild)) },
    { label: 'Status', cell: (i) => statusBadge(i.status) },
    { label: 'Last Seen', cell: (i) => agoCell(i.lastSeen) },
    { label: 'Scans Today', num: true, cell: (i) => i.today.scans },
    { label: 'MATCH', num: true, title: 'MATCH scans today', cell: (i) => i.today.match },
    { label: 'MISMATCH', num: true, title: 'MISMATCH scans today', cell: (i) => i.today.mismatch },
  ];
  COLS.tablets = [
    { label: 'Physical tablet', cell: (t) => idTag('tablet', t.androidIdHash || t.tabletKey, link('tablet', t.tabletKey)) },
    { label: 'Device labels', cell: (t) => list(t.deviceLabels) },
    { label: 'Model', cell: (t) => list(t.models) },
    { label: 'SDK', cell: (t) => list(t.sdks) },
    { label: 'Installations (current build)', cell: (t) => t.installations.map((i) => h('div', null,
      statusBadge(i.status), ' ', h('a', { href: link('installation', i.installId) }, variantName(i.variant)), ' ',
      h('span', { class: 'muted' }, buildText(i.currentBuild)))) },
    { label: 'Status', cell: (t) => statusBadge(t.status) },
    { label: 'Last activity', cell: (t) => agoCell(t.lastSeen) },
    { label: 'Scans today', num: true, cell: (t) => t.today.scans },
  ];
  COLS.installations = [
    { label: 'Installation', cell: (i) => installLink(i.installId) },
    { label: 'Device label', cell: (i) => i.deviceLabel || '(no label)' },
    { label: 'Unit', cell: (i) => i.unitId.toUpperCase() },
    { label: 'APK', cell: (i) => variantLink(i.variant) },
    { label: 'applicationId', cell: (i) => h('span', { class: 'mono' }, i.currentBuild.applicationId) },
    { label: 'Version', cell: (i) => h('a', { href: link('build', i.currentBuild.buildId) }, buildText(i.currentBuild)) },
    { label: 'PO/Admin', cell: (i) => poAdminFlag(i.currentBuild.enablePoAdmin) },
    { label: 'Demo', cell: (i) => demoFlag(i.currentBuild.adminDemoMode) },
    { label: 'Status', cell: (i) => statusBadge(i.status) },
    { label: 'Last seen', cell: (i) => agoCell(i.lastSeen) },
    { label: 'Sessions (scanner / app)', num: true, cell: (i) => `${i.sessions.scanner} / ${i.sessions.app}` },
    { label: 'Scans', num: true, cell: (i) => i.counts.scans },
    { label: 'Scans today', num: true, cell: (i) => i.today.scans },
    { label: 'Latest scan', cell: (i) => latestScanCell(i.latestScan) },
  ];
  COLS.activity = [
    { label: 'Time (device)', cell: (e) => timeCell(e.tsDevice) },
    { label: 'Received', cell: (e) => agoCell(e.serverReceivedAt) },
    { label: 'Event', cell: (e) => h('span', { class: 'mono' }, e.eventType) },
    { label: 'Unit', cell: (e) => e.unitId.toUpperCase() },
    { label: 'APK', cell: (e) => variantLink(e.variant) },
    { label: 'Device', cell: (e) => tabletLink(e.androidIdHash || `install:${e.installId}`, e.deviceLabel) },
    { label: 'Installation', cell: (e) => installLink(e.installId) },
    { label: 'Version', cell: (e) => buildText(e.build) },
    { label: 'Details', cell: (e) => activityDetail(e) },
  ];

  const statusNote = () => h('p', { class: 'note' },
    'Activity status is based on when the server last received an event from each installation (not a network ping): ' +
    'ONLINE ≤ 5 min, RECENT ≤ 30 min, OFFLINE > 30 min. A switched-on tablet that is not being used sends no events, ' +
    'so it moves to RECENT and then OFFLINE.');

  async function viewFleet(_, p) {
    const f = pick(p, [...VIEW_FILTERS.fleet, 'offset']);
    const a = pick(p, ['unitId', 'androidIdHash', 'deviceLabel', 'installId', 'applicationId', 'variant', 'versionName', 'versionCode']);
    const [fl, act] = await Promise.all([
      api('/v1/dashboard/fleet', f), api('/v1/dashboard/activity', { ...a, limit: 30 })]);
    const sc = fl.statusCounts;
    const t = fl.totals;
    const dayText = p.date ? `on ${fl.day}` : 'today';
    return [
      crumbs([['Devices', '#/devices'], ['Full device details']]),
      hierarchy(),
      h('div', { class: 'cards' },
        card('Physical tablets', t.tablets, null, 'Distinct androidIdHash'),
        card('App installations', t.installations, null, 'Distinct installId'),
        card('ONLINE', sc.ONLINE, 'online', STATUS_TITLE.ONLINE),
        card('RECENT', sc.RECENT, 'recent', STATUS_TITLE.RECENT),
        card('OFFLINE', sc.OFFLINE, 'offline', STATUS_TITLE.OFFLINE),
        card(`Scans ${dayText}`, t.scansToday), card(`MATCH ${dayText}`, t.matchToday, 'match'),
        card(`MISMATCH ${dayText}`, t.mismatchToday, 'mismatch')),
      statusNote(),
      section('Installations', `one row per app installation · Scans/MATCH/MISMATCH ${dayText}`,
        pager(fl, 'fleet', undefined, f),
        table(COLS.fleet, fl.items, { empty: 'No installations match these filters.' })),
      section('Physical tablets', 'installations grouped by androidIdHash',
        table(COLS.tablets, fl.tablets, { empty: 'No tablets match these filters.' })),
      section('Latest activity', 'most recent events from every unit and device (tablet event time)',
        table(COLS.activity, act.items, { empty: 'No events.' })),
    ];
  }

  async function viewTablet(key) {
    const [fl, act] = await Promise.all([
      api('/v1/dashboard/fleet', { androidIdHash: key, limit: 1000 }),
      api('/v1/dashboard/activity', { androidIdHash: key, limit: 30 })]);
    const t = fl.tablets[0];
    if (!t) return [crumbs([['Devices', '#/devices'], ['Full device details', '#/fleet'], ['Tablet']]), errBox('No installations reported from this tablet.')];
    return [
      crumbs([['Devices', '#/devices'], ['Full device details', '#/fleet'], [`Tablet ${list(t.deviceLabels)}`]]),
      hierarchy(),
      panel('Physical tablet', kv([
        ['androidIdHash', t.androidIdHash ? idTag('tablet', t.androidIdHash, null, true)
          : h('span', { class: 'muted' }, 'not reported: this installation cannot be grouped with others')],
        ['Device labels', list(t.deviceLabels)], ['Model', list(t.models)], ['SDK', list(t.sdks)],
        ['Units', list(t.units.map((u) => u.toUpperCase()))], ['App installations', t.installationCount],
        ['Activity status', statusBadge(t.status)], ['Last activity (server received)', timeCell(t.lastSeen)],
        ['Last event (device time)', timeCell(t.lastEventAt)],
        [`Scans today (MATCH / MISMATCH)`, `${t.today.scans} (${t.today.match} / ${t.today.mismatch})`],
      ])),
      statusNote(),
      section('App installations on this tablet', 'current/latest build per installation',
        table(COLS.installations, fl.items)),
      section('Latest activity on this tablet', null, table(COLS.activity, act.items, { empty: 'No events.' })),
    ];
  }

  async function viewInstallation(installId) {
    const [fl, sess, apps, scans] = await Promise.all([
      api('/v1/dashboard/fleet', { installId }), api('/v1/sessions', { installId, limit: 20 }),
      api('/v1/sessions', { installId, kind: 'app', limit: 10 }), api('/v1/scans', { installId, limit: 20 })]);
    const i = fl.items[0];
    if (!i) return [crumbs([['Devices', '#/devices'], ['Full device details', '#/fleet'], ['Installation']]), errBox('Unknown installation.')];
    const b = i.currentBuild;
    const c = i.counts;
    const l = i.latestScan;
    return [
      crumbs([['Devices', '#/devices'],
        [`Tablet ${i.deviceLabel || short(i.tabletKey)}`, link('tablet', i.tabletKey)], [`Installation ${short(installId)}`]]),
      hierarchy(),
      h('div', { class: 'grid2' },
        panel('App installation', kv([
          ['installId', idTag('install', i.installId, null, true)], ['Device label', i.deviceLabel || '(no label)'],
          ['Physical tablet', i.androidIdHash ? idTag('tablet', i.androidIdHash, link('tablet', i.tabletKey)) : h('span', { class: 'muted' }, 'not reported')],
          ['Model / SDK', `${[i.manufacturer, i.model].filter(Boolean).join(' ') || '—'} / ${num(i.sdk)}`],
          ['Unit', i.unitId.toUpperCase()], ['Activity status', statusBadge(i.status)],
          ['Last seen (server received)', timeCell(i.lastSeen)], ['Last event (device time)', timeCell(i.lastEventAt)],
          ['First seen', timeCell(i.firstSeen)], ['Events', i.eventCount],
        ])),
        panel('APK/build (current)', kv([
          ['Build', idTag('build', `#${b.buildId}`, link('build', b.buildId), true)],
          ['applicationId', h('span', { class: 'mono' }, b.applicationId)], ['Flavor', b.flavor],
          ['Variant', variantLink(i.variant)], ['versionName', b.versionName], ['versionCode', b.versionCode],
          ['Build type', b.buildType], ['PO/Admin', poAdminFlag(b.enablePoAdmin)], ['Demo mode', demoFlag(b.adminDemoMode)],
        ])),
        panel('Activity counts', kv([
          ['Scanner sessions', i.sessions.scanner], ['App sessions', i.sessions.app],
          ['Scans (all time)', `${c.scans} (MATCH ${c.match} / MISMATCH ${c.mismatch} / INCOMPLETE ${c.incomplete})`],
          [`Scans ${fl.day}`, `${i.today.scans} (MATCH ${i.today.match} / MISMATCH ${i.today.mismatch} / INCOMPLETE ${i.today.incomplete})`],
        ])),
        panel('Latest scan', l ? kv([
          ['Time (device)', timeCell(l.tsDevice)], ['Result', resultBadge(l.result)],
          ['SIZE wash / tag', pair(l.washSize, l.tagSize)], ['Scan', idTag('scan', l.eventId, null, true)],
        ]) : h('p', { class: 'muted' }, 'No scans yet.'))),
      section('Scanner sessions', 'latest 20', table(COLS.sessions, sess.items, { empty: 'No scanner sessions.' })),
      section('App sessions', 'latest 10', table(COLS.sessions, apps.items, { empty: 'No app sessions.' })),
      section('Recent scans', 'latest 20; click a row for all fields', scansTable(scans.items),
        h('p', { class: 'note' }, h('a', { href: link('device', installId) }, 'Full device history (builds, POs, all scans) →'))),
    ];
  }

  const VIEWS = {
    overview: viewOverview, units: viewUnits, unit: viewUnit, devices: viewDevices, device: viewDevice,
    builds: viewBuilds, build: viewBuild, sessions: viewSessions, session: viewSession,
    pos: viewPos, po: viewPo, scans: viewScans, reports: viewReports,
    fleet: viewFleet, tablet: viewTablet, installation: viewInstallation,
  };
  const NAV_OF = {
    unit: 'reports', units: 'reports', build: 'builds', session: 'sessions',
    device: 'devices', fleet: 'devices', tablet: 'devices', installation: 'devices',
    po: 'pos',
  };

  // --- filters, status, loop ------------------------------------------------------------------

  function filterControl(view, name, params) {
    const def = (VIEW_FILTER_DEFS[view] || {})[name] || FILTER_DEFS[name];
    let input;
    if (def.options) {
      const opts = def.options();
      const cur = params[name] || (name === 'kind' ? 'scanner' : '');
      if (!opts.some(([v]) => v === cur)) opts.push([cur, cur]);
      input = h('select', { name }, opts.map(([v, l]) => h('option', { value: v }, l)));
      input.value = cur;
    } else {
      input = h('input', { name, type: def.type || 'text', value: params[name] || '' });
    }
    return h('label', null, def.label, input);
  }

  function renderFilters(view, params) {
    const form = $('#filters');
    const names = VIEW_FILTERS[view];
    form.replaceChildren();
    if (!names) { form.hidden = true; return; }
    form.hidden = false;
    const primary = (PRIMARY_FILTERS[view] || names).filter((n) => names.includes(n));
    const more = names.filter((n) => !primary.includes(n));
    const row = h('div', { class: 'filter-row' });
    for (const n of primary) row.appendChild(filterControl(view, n, params));
    row.appendChild(h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Apply'),
      h('button', { type: 'button', onclick: () => { location.hash = link(view); } }, 'Clear')));
    form.appendChild(row);
    if (!more.length) return;
    const box = h('details', { class: 'more', open: more.some((n) => params[n]) });
    box.appendChild(h('summary', null, icon('chevron-right', 14), 'More filters'));
    const extra = h('div', { class: 'filter-row' });
    for (const n of more) extra.appendChild(filterControl(view, n, params));
    box.appendChild(extra);
    form.appendChild(box);
  }

  function setStatus(kind, text) {
    const dot = $('#status-dot');
    dot.className = `dot ${kind}`;
    $('#status-text').textContent = text;
  }
  function refreshStatus() {
    const at = state.lastOk ? new Date(state.lastOk).toLocaleTimeString() : '—';
    if (state.paused) setStatus('paused', `Paused · last update ${at}`);
    else setStatus('ok', `Live · updated ${at} · every ${REFRESH_MS / 1000} s`);
  }

  // Navigation always loads; a background refresh is skipped while another load is running.
  // Only the newest load may update the page.
  async function load(silent) {
    if (!state.token || (silent && state.loading)) return;
    const mine = ++state.loadSeq;
    state.loading = true;
    const route = parseHash();
    const hash = location.hash;
    const fn = VIEWS[route.view] || viewOverview;
    if (!silent) {
      state.view = route.view;
      renderFilters(route.view, route.params);
      document.querySelectorAll('#nav a').forEach((a) =>
        a.classList.toggle('active', a.dataset.view === (NAV_OF[route.view] || route.view)));
    }
    const content = $('#content');
    if (!silent) {
      $('#page-top').replaceChildren();
      content.replaceChildren(loadingState());
      document.body.classList.remove('nav-open');
    }
    try {
      const nodes = await fn(route.arg, route.params);
      if (mine !== state.loadSeq || location.hash !== hash) return;
      const y = window.scrollY;
      const flat = [nodes].flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
      // Breadcrumbs and the page title sit above the filter card; the rest of the view below it.
      const top = [];
      while (flat.length && flat[0].classList && (flat[0].classList.contains('crumbs') || flat[0].classList.contains('page-head'))) {
        top.push(flat.shift());
      }
      $('#page-top').replaceChildren(...top);
      content.replaceChildren(...flat);
      if (silent) window.scrollTo(0, y);
      state.lastOk = Date.now();
      refreshStatus();
    } catch (e) {
      if (mine !== state.loadSeq) return;
      if (e.status === 401 || e.status === 403) {
        signOut(e.status === 401 ? 'The master token is no longer accepted. Sign in again.'
          : 'This token cannot open the dashboard. A master token is needed.');
        return;
      }
      setStatus('err', `${e.status === 0 ? 'Server unreachable' : `Error: ${e.message}`} · retrying every ${REFRESH_MS / 1000} s`);
      if (!silent) content.replaceChildren(errBox(`Could not load this view: ${e.message}`));
    } finally {
      if (mine === state.loadSeq) state.loading = false;
    }
  }

  function showApp(on) {
    document.body.classList.toggle('in-app', on);
    $('#login').hidden = on;
    $('#app').hidden = !on;
    $('#nav').hidden = !on;
    $('#status').hidden = !on;
    closeMenus();
    let remembered = false;
    try { remembered = !!(storage('local') && storage('local').getItem(TOKEN_KEY)); } catch (e) { /* blocked */ }
    $('#token-scope').textContent = remembered ? 'Token remembered on this PC' : 'Token kept for this browser tab';
  }

  // --- shell: menus, sidebar, theme -----------------------------------------------------------

  const MENUS = [['#user-btn', '#user-menu'], ['#settings-btn', '#settings-menu']];
  function closeMenus(except) {
    for (const [b, m] of MENUS) {
      if (m === except) continue;
      $(m).classList.remove('open');
      $(b).setAttribute('aria-expanded', 'false');
    }
  }
  function toggleMenu(btnSel, menuSel) {
    const open = !$(menuSel).classList.contains('open');
    closeMenus(menuSel);
    $(menuSel).classList.toggle('open', open);
    $(btnSel).setAttribute('aria-expanded', String(open));
  }
  function setPauseUi() {
    $('#pause-label').textContent = state.paused ? 'Resume auto-refresh' : 'Pause auto-refresh';
    $('#pause-icon').replaceWith(Object.assign(icon(state.paused ? 'play' : 'pause'), { id: 'pause-icon' }));
  }
  function wireShell() {
    hydrateIcons(document);
    applyTheme(readTheme());
    $('#theme-toggle').addEventListener('click', () => {
      applyTheme(effectiveTheme(readTheme()) === 'dark' ? 'light' : 'dark');
    });
    document.querySelectorAll('[data-theme-choice]').forEach((b) =>
      b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (readTheme() === 'system') applyTheme('system'); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
    }
    $('#user-btn').addEventListener('click', (ev) => { ev.stopPropagation(); toggleMenu('#user-btn', '#user-menu'); });
    $('#profile-btn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      document.body.classList.remove('nav-open');
      toggleMenu('#user-btn', '#user-menu');
    });
    $('#settings-btn').addEventListener('click', (ev) => { ev.stopPropagation(); toggleMenu('#settings-btn', '#settings-menu'); });
    for (const [, m] of MENUS) $(m).addEventListener('click', (ev) => ev.stopPropagation());
    document.addEventListener('click', () => closeMenus());
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { closeMenus(); document.body.classList.remove('nav-open'); }
    });
    $('#menu-toggle').addEventListener('click', (ev) => { ev.stopPropagation(); document.body.classList.toggle('nav-open'); });
    $('#scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  }

  function signOut(message) {
    clearToken();
    state.token = null;
    $('#page-top').replaceChildren();
    $('#content').replaceChildren();
    showApp(false);
    $('#login-error').textContent = message || '';
    $('#token').focus();
  }

  async function start() {
    showApp(true);
    try { updateVariants((await api('/v1/dashboard/units')).items); } catch (e) { /* load() reports errors */ }
    await load(false);
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireShell();
    $('#login-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#token');
      const token = input.value.trim();
      input.value = '';
      if (!token) return;
      state.token = token;
      try {
        await api('/v1/dashboard/overview');
      } catch (e) {
        state.token = null;
        $('#login-error').textContent = e.status === 401 ? 'Token not accepted.'
          : e.status === 403 ? 'That is a unit token. The dashboard needs a master token.'
            : `Cannot reach the server (${e.message}).`;
        return;
      }
      saveToken(token, $('#remember').checked);
      $('#login-error').textContent = '';
      start();
    });
    $('#filters').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const params = {};
      for (const [k, v] of new FormData(ev.target)) if (String(v).trim()) params[k] = String(v).trim();
      const target = link(state.view, undefined, params);
      if (location.hash === target) load(false); else location.hash = target;
    });
    $('#pause').addEventListener('click', () => {
      state.paused = !state.paused;
      setPauseUi();
      if (!state.paused) load(true); else refreshStatus();
    });
    $('#signout').addEventListener('click', () => signOut('Signed out.'));
    window.addEventListener('hashchange', () => load(false));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.paused) load(true);
    });
    setInterval(() => {
      if (!state.paused && !document.hidden) load(true);
    }, REFRESH_MS);

    state.token = loadToken();
    if (state.token) start(); else showApp(false);
  });
})();
