'use strict';

// Ana pencere: kayıt kartları (canlı toplam boyut, dosya/klasör sayısı, dizin durumu), üstte serbest metin
// araması; arama görünümünde filtreler, sonuçlar, önizleme ve "3B kelime bulutu" alt modülü.

let data = { records: [], settings: {} };
let stats = {};
let selectedId = null;

const $ = (s) => document.querySelector(s);

// --- Başlangıç ---------------------------------------------------------------
$('.search-ico').innerHTML = icon('search');
$('#searchClear').innerHTML = icon('x');
$('#searchClear').title = t('common.clear');
$('#searchOpts').innerHTML = icon('filter');
$('#searchOpts').title = t('app.searchSettings');
$('#btnSettings').innerHTML = icon('gear');
$('#btnSettings').title = t('app.settings');
$('#btnNew').innerHTML = icon('plus') + esc(t('common.new'));
$('#btnNew').title = `${t('app.newRecord')} (Ctrl+N)`;
$('#search').placeholder = t('app.searchPh');
const paintThemeBtn = themeButton($('#btnTheme'), () => data.settings || {});
mountMastertool($('.topbar .actions'));

$('#btnSettings').onclick = () => openSettings(data.settings || {});
$('#searchOpts').onclick = () => openSettings(data.settings || {}, 'search');
$('#btnNew').onclick = () => createRecord();
$('#home').addEventListener('mousedown', (e) => {
  if (!e.target.closest('.card, .new-card')) { selectedId = null; updateSelectionUI(); }
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); createRecord(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { setQuery(''); $('#search').blur(); }
  const sel = data.records.find((c) => c.id === selectedId);
  if (sel && !inInput && !search.active) {
    if (e.key === 'Enter') openRecord(sel);
    if (e.key === 'Delete') deleteRecord(sel);
    if (e.key === 'F2') editRecord(sel);
  }
  if (search.active && !inInput && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); }
  if (search.active && e.key === 'ArrowDown' && document.activeElement === $('#search')) { e.preventDefault(); $('#search').blur(); moveSelection(1); }
});

window.api.onStoreChanged((d) => { data = d; render(); paintThemeBtn(); renderFilters(); });
window.api.onRecordStats((s) => { stats = s; renderGrid(); renderStats(); });
window.api.onIndexChanged(() => { if (search.active) scheduleSearch(1500); else loadRecentSoon(); });

// --- Hesap rozeti ve senkron durumu ---------------------------------------------
let lastErrorShown = null;
onAcct((st) => {
  const b = $('#btnAccount');
  const name = (st.user && (st.user.name || st.user.email)) || st.email || '?';
  b.querySelector('.ac-avatar').textContent = name.trim().slice(0, 1).toUpperCase();
  const s = !st.syncEnabled || st.state === 'off' ? 'off' : st.state || 'idle';
  b.className = `account-chip s-${s}`;
  b.querySelector('.ac-sync').innerHTML = s === 'syncing' ? '<span class="spin"></span>' : icon(['off', 'offline', 'error'].includes(s) ? 'cloudOff' : 'cloud');
  b.title = `${(st.user && st.user.email) || st.email || ''}\n${syncText(st)}`;
  if (st.state === 'error' && st.error !== lastErrorShown) {
    lastErrorShown = st.error;
    toast(syncText(st), { type: 'err', timeout: 9000 });
  }
  if (st.state === 'ok') lastErrorShown = null;
});

$('#btnAccount').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.right - 260, r.bottom + 6, [
    { label: (acct.user && acct.user.email) || acct.email || '', icon: 'user', disabled: true, action: () => {} },
    { label: syncText(acct), icon: acct.syncEnabled ? 'cloud' : 'cloudOff', disabled: true, action: () => {} },
    '-',
    { label: t('acct.syncNow'), icon: 'refresh', disabled: !acct.syncEnabled, action: () => window.api.syncNow() },
    { label: t('acct.myAccount'), icon: 'open', action: () => window.api.openWeb('account') },
    { label: t('app.settings'), icon: 'gear', action: () => openSettings(data.settings || {}) },
    '-',
    { label: t('acct.logout'), icon: 'logout', danger: true, action: logout },
  ]);
};

// Yeni sürüm bildirimi: exe hesabın kişiye özel bağlantısından indirilir
window.api.onUpdateAvailable(({ version }) => {
  const bar = $('#updateBar');
  bar.innerHTML = `${icon('download')}<span>${esc(t('update.available', { version }))} — ${esc(t('update.hint'))}</span>
    <button class="btn sm primary" data-a="open">${esc(t('update.open'))}</button>
    <button class="icon-btn" data-a="close" title="${esc(t('common.cancel'))}">${icon('x')}</button>`;
  bar.classList.remove('hidden');
  bar.querySelector('[data-a="open"]').onclick = () => window.api.openWeb('account');
  bar.querySelector('[data-a="close"]').onclick = () => bar.classList.add('hidden');
});

window.api.onLibraryBackup((file) => toast(t('acct.backupNotice'), { sub: file, timeout: 12000 }));
window.api.onEngineFailed(({ what, message }) => toast(t(what === 'ocr' ? 'ocr.downloadFailed' : 'speech.downloadFailed'), { type: 'err', sub: message, timeout: 9000 }));
Promise.all([window.api.getStore(), window.api.recordStats()]).then(([d, s]) => { data = d; stats = s || {}; render(); paintThemeBtn(); renderFilters(); });

// --- Kayıt kartları -------------------------------------------------------------
const sortByName = (a, b) => a.name.localeCompare(b.name, LANG, { sensitivity: 'base' });
const fmtNum = (n) => Number(n || 0).toLocaleString(LANG);

function updateSelectionUI() {
  document.querySelectorAll('.rec-card').forEach((x) => x.classList.toggle('selected', x.dataset.id === selectedId));
}

function render() {
  renderHomeBar();
  renderGrid();
  renderStats();
  loadRecentSoon();
}

// --- Son değişiklikler (izlenen klasörlerde en son değişen dosyalar) ---------------------------
let recentTimer = null;
function loadRecentSoon() {
  if (recentTimer) return;
  recentTimer = setTimeout(async () => {
    recentTimer = null;
    const rows = data.records.length ? await window.api.recent({ limit: 12 }).catch(() => []) : [];
    renderRecent(rows);
  }, 300);
}

function renderRecent(rows) {
  const el = $('#recent');
  el.classList.toggle('hidden', !rows.length);
  if (!rows.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="section-title">${icon('history')}${esc(t('app.recent'))}<span class="hint">${esc(t('app.recentHint'))}</span></div>`;
  const list = h('<div class="recent-list"></div>');
  for (const r of rows) {
    const rec = data.records.find((x) => x.id === r.record);
    const dir = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')).replace(/\//g, ' › ') : '';
    const row = h(`<div class="recent-row" style="--c:${kindColor(r.kind)}">
      <span class="r-ico sm">${icon(kindIcon(r.kind))}</span>
      <span class="rr-name">${esc(r.name)}</span>
      <span class="rr-where"><i class="dot" style="background:${rec ? rec.color : '#888'}"></i>${esc(r.recordName)}${dir ? ` › ${esc(dir)}` : ''}</span>
      <span class="rr-date">${esc(formatDate(r.mtime))}</span>
      <span class="rr-size">${formatSize(r.size)}</span>
    </div>`);
    row.onclick = () => window.api.openRecord(r.record, { rel: r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : '', docId: r.id });
    row.title = t('pv.showInRecord');
    list.appendChild(row);
  }
  el.appendChild(list);
}

function totals() {
  let size = 0;
  let files = 0;
  let busy = false;
  for (const r of data.records) {
    const s = stats[r.id];
    if (!s) continue;
    size += s.size || 0;
    files += s.files || 0;
    if (['scanning', 'indexing'].includes(s.state)) busy = true;
  }
  return { size, files, busy };
}

function renderStats() {
  const n = data.records.length;
  if (!n) { $('#stats').textContent = t('app.welcome'); return; }
  const tt = totals();
  const state = data.settings.indexingPaused ? t('app.paused') : tt.busy ? t('app.indexing') : t('app.watching');
  $('#stats').innerHTML = `${esc(t('app.stats', { c: n }))} · ${formatSize(tt.size)} · ${esc(state)}`;
}

// Kartların üstünde: OCR / konuşma durumu ve 3B bulut kısayolu
function renderHomeBar() {
  const el = $('#homeBar');
  if (!data.records.length) { el.innerHTML = ''; return; }
  const s = data.settings;
  el.innerHTML = `<div class="section-title">${esc(t('app.records'))}<span class="hint">${esc(t('app.dblHint'))}</span></div>
    <span class="spacer"></span>
    <button class="chip-btn ${s.ocrEnabled ? 'on' : ''}" data-a="ocr" title="${esc(t('set.ocrHint'))}">${icon('image')}${esc(t(s.ocrEnabled ? 'app.ocrOn' : 'app.ocrOff'))}</button>
    <button class="chip-btn ${s.speechEnabled ? 'on' : ''}" data-a="speech" title="${esc(t('set.speechHint'))}">${icon('mic')}${esc(t(s.speechEnabled ? 'app.speechOn' : 'app.speechOff'))}</button>
    <button class="chip-btn ${s.indexingPaused ? 'warn' : ''}" data-a="pause">${icon(s.indexingPaused ? 'play' : 'pause')}${esc(t(s.indexingPaused ? 'app.resumeAll' : 'app.pauseAll'))}</button>
    <button class="chip-btn accent" data-a="cloud">${icon('cube')}${esc(t('app.cloud3d'))}</button>`;
  el.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ocr' || a === 'speech') openSettings(data.settings, 'search');
    if (a === 'pause') window.api.setSettings({ indexingPaused: !data.settings.indexingPaused });
    if (a === 'cloud') { search.tab = 'cloud'; showSearchView(true); }
  };
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!data.records.length) {
    const w = h(`<div class="welcome"><div class="new-card">
      <div class="plus">${icon('plus')}</div>
      <div class="lbl">${esc(t('common.new'))}</div>
      <div class="hint">${t('app.welcomeHint')}</div>
    </div></div>`);
    w.querySelector('.new-card').onclick = () => createRecord();
    grid.appendChild(w);
    return;
  }
  for (const r of data.records.slice().sort(sortByName)) grid.appendChild(recordCard(r));
  const n = h(`<div class="new-card"><div class="plus">${icon('plus')}</div><div class="lbl">${esc(t('common.new'))}</div><div class="hint">${esc(t('app.newHint'))}</div></div>`);
  n.onclick = () => createRecord();
  grid.appendChild(n);
  updateSelectionUI();
}

const shortPath = (p) => {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 4 ? `${p.startsWith('\\\\') ? '\\\\' : ''}${parts[0]}\\…\\${parts.slice(-2).join('\\')}` : p;
};

function recordState(r, s) {
  if (!r.path) return { cls: 'warn', icon: 'alert', text: t('rec.noPath') };
  if (data.settings.indexingPaused || r.paused) return { cls: 'muted', icon: 'pause', text: t('rec.paused') };
  if (!s) return { cls: 'run', icon: null, text: t('rec.starting') };
  if (s.state === 'missing') return { cls: 'err', icon: 'alert', text: t(r.network ? 'rec.offline' : 'rec.missing') };
  if (s.state === 'scanning') return { cls: 'run', icon: null, text: t('rec.scanning') };
  if (s.state === 'indexing' || s.running) {
    const total = (s.indexed || 0) + (s.pending || 0);
    const pct = total ? Math.floor((s.indexed / total) * 100) : 0;
    return { cls: 'run', icon: null, text: t('rec.indexing', { pct }) };
  }
  return { cls: 'ok', icon: 'eyeScan', text: t('rec.watching') };
}

function recordCard(r) {
  const s = stats[r.id];
  const st = recordState(r, s);
  const total = s ? (s.indexed || 0) + (s.pending || 0) : 0;
  const pct = s && total ? Math.round((s.indexed / total) * 100) : 0;
  const busy = st.cls === 'run';
  const el = h(`<div class="card rec-card ${selectedId === r.id ? 'selected' : ''}" data-id="${esc(r.id)}" style="--c:${r.color || '#22d3ee'}">
    <div class="card-head">
      <div class="avatar">${icon(r.network ? 'drive' : 'folder')}</div>
      <div style="min-width:0;flex:1">
        <div class="card-title">${esc(r.name)}</div>
        <div class="card-sub" title="${esc(r.path)}">${r.path ? esc(shortPath(r.path)) : `<span style="color:var(--warn)">${esc(t('rec.noPathShort'))}</span>`}</div>
      </div>
    </div>
    <div class="quick">
      <button class="icon-btn" data-a="edit" title="${esc(t('app.recordSettings'))}">${icon('gear')}</button>
      <button class="icon-btn connect" data-a="open" title="${esc(t('common.open'))}">${icon('play')}</button>
    </div>
    <div class="rec-size"><span class="big">${s ? formatSize(s.size || 0) : '—'}</span></div>
    <div class="rec-counts">${s ? `${icon('file')}<span>${esc(t('rec.files', { n: fmtNum(s.files) }))}</span>${icon('folder')}<span>${esc(t('rec.dirs', { n: fmtNum(s.dirs) }))}</span>` : ''}</div>
    <div class="card-foot">
      <span class="tag state ${st.cls}">${st.icon ? icon(st.icon) : '<span class="spin"></span>'}${esc(st.text)}</span>
      ${s && s.errors ? `<span class="tag err" title="${esc(t('rec.errors', { n: s.errors }))}">${icon('x')}${fmtNum(s.errors)}</span>` : ''}
      ${s && s.waiting ? `<span class="tag" title="${esc(t('rec.waiting', { n: s.waiting }))}">${icon('image')}${fmtNum(s.waiting)}</span>` : ''}
    </div>
    ${busy && total ? `<div class="card-progress"><div style="width:${pct}%"></div></div>` : ''}
  </div>`);
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'open') return openRecord(r);
    if (a === 'edit') return editExisting(r);
    selectedId = r.id;
    updateSelectionUI();
  });
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-a]')) openRecord(r); });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectedId = r.id;
    updateSelectionUI();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'play', kbd: 'Enter', action: () => openRecord(r) },
      { label: t('app.searchIn'), icon: 'search', action: () => { search.filters.records = [r.id]; renderFilters(); $('#search').focus(); } },
      { label: t('app.openFolder'), icon: 'folderOpen', disabled: !r.path, action: () => window.api.openRecordFolder(r.id) },
      '-',
      { label: t('app.rescan'), icon: 'refresh', disabled: !r.path, action: () => window.api.rescan(r.id) },
      { label: r.paused ? t('app.resume') : t('app.pause'), icon: r.paused ? 'play' : 'pause', action: () => window.api.pauseRecord(r.id, !r.paused) },
      { label: t('app.retryErrors'), icon: 'reconnect', disabled: !(s && s.errors), action: () => window.api.retryErrors(r.id) },
      '-',
      { label: t('app.recordSettings'), icon: 'gear', kbd: 'F2', action: () => editExisting(r) },
      { label: t('common.delete'), icon: 'trash', danger: true, kbd: 'Del', action: () => deleteRecord(r) },
    ]);
  });
  return el;
}

// Bu bilgisayarda klasörü seçilmemiş kayıt (başka cihazdan senkronlandı): önce klasör sorulur
async function openRecord(r) {
  if (!r.path) {
    const id = await editRecord(r);
    if (!id) return;
  }
  window.api.openRecord(r.id);
}

async function createRecord() {
  const id = await newRecord();
  if (id) {
    toast(t('app.recordSaved'), { type: 'ok', sub: t('app.recordSavedSub') });
    selectedId = id;
  }
}

async function editExisting(r) {
  const id = await editRecord(r);
  if (id) toast(t('common.saved'), { type: 'ok' });
}

async function deleteRecord(r) {
  const ok = await confirmBox(t('app.deleteRecord'), t('app.deleteRecordMsg', { name: esc(r.name) }));
  if (ok) { await window.api.deleteRecord(r.id); if (selectedId === r.id) selectedId = null; }
}

// =====================================================================================
// Arama görünümü
// =====================================================================================
const search = {
  active: false,
  q: '',
  tab: 'results',
  filters: { kinds: [], date: 'any', size: 'any', records: [] },
  results: [],
  total: 0,
  offset: 0,
  selected: -1,
  timer: null,
  seq: 0,
  cloud: null,
  cloudScope: 'results',
};

$('#search').addEventListener('input', (e) => setQuery(e.target.value, { fromInput: true }));
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(search.timer); runSearch(); } });
$('#searchClear').onclick = () => { setQuery(''); $('#search').focus(); };

function setQuery(q, { fromInput = false } = {}) {
  if (!fromInput) $('#search').value = q;
  search.q = q;
  $('#searchClear').classList.toggle('hidden', !q);
  if (q.trim()) {
    showSearchView(true);
    scheduleSearch(220);
  } else if (search.tab !== 'cloud') {
    showSearchView(false);
  } else {
    scheduleSearch(50);
  }
}

function showSearchView(on) {
  search.active = on;
  $('#home').classList.toggle('hidden', on);
  $('#searchView').classList.toggle('hidden', !on);
  if (on) { paintTabs(); renderFilters(); if (search.tab === 'cloud') showCloud(); }
  else { disposeCloud(); }
}

const TAB_LABELS = () => ({ results: `${icon('list')}${esc(t('sr.results'))}${search.q.trim() ? ` <span class="count">${fmtNum(search.total)}</span>` : ''}`, cloud: `${icon('cube')}${esc(t('sr.cloud3d'))}` });
function paintTabs() {
  const labels = TAB_LABELS();
  document.querySelectorAll('#searchTabs button').forEach((b) => {
    b.innerHTML = labels[b.dataset.tab];
    b.classList.toggle('on', b.dataset.tab === search.tab);
    b.onclick = () => {
      search.tab = b.dataset.tab;
      paintTabs();
      $('#results').classList.toggle('hidden', search.tab !== 'results');
      $('#cloudWrap').classList.toggle('hidden', search.tab !== 'cloud');
      $('#sort').classList.toggle('hidden', search.tab !== 'results');
      $('#preview').classList.toggle('hidden', search.tab === 'cloud');
      $('#split').classList.toggle('hidden', search.tab === 'cloud');
      if (search.tab === 'cloud') showCloud(); else { disposeCloud(); if (!search.q.trim()) showSearchView(false); }
    };
  });
  $('#results').classList.toggle('hidden', search.tab !== 'results');
  $('#cloudWrap').classList.toggle('hidden', search.tab !== 'cloud');
  $('#sort').classList.toggle('hidden', search.tab !== 'results');
  $('#preview').classList.toggle('hidden', search.tab === 'cloud');
  $('#split').classList.toggle('hidden', search.tab === 'cloud');
}

// Sıralama
$('#sort').innerHTML = options([['relevance', t('sr.sortRelevance')], ['date', t('sr.sortDate')], ['size', t('sr.sortSize')], ['name', t('sr.sortName')]], 'relevance');
$('#sort').onchange = (e) => { window.api.setSettings({ searchSort: e.target.value }); search.offset = 0; runSearch(); };

// --- Filtreler ---------------------------------------------------------------------
const KIND_FILTERS = ['pdf', 'word', 'excel', 'powerpoint', 'text', 'code', 'html', 'email', 'image', 'audio', 'video', 'archive', 'other'];
const DATE_FILTERS = { any: 0, d7: 7, d30: 30, d365: 365 };
const SIZE_FILTERS = { any: [0, 0], s1: [0, 1 << 20], s10: [1 << 20, 10 << 20], s100: [10 << 20, 100 << 20], big: [100 << 20, 0] };

function renderFilters() {
  if (!search.active) return;
  $('#sort').value = data.settings.searchSort || 'relevance';
  const f = search.filters;
  f.records = f.records.filter((id) => data.records.some((r) => r.id === id));
  const el = $('#filters');
  el.innerHTML = `
    <div class="f-group"><div class="f-title">${icon('folder')}${esc(t('sr.fRecord'))}</div>
      <label class="f-opt"><input type="radio" name="f-rec" value="" ${!f.records.length ? 'checked' : ''}><span>${esc(t('sr.fAll'))}</span></label>
      ${data.records.slice().sort(sortByName).map((r) => `<label class="f-opt"><input type="radio" name="f-rec" value="${esc(r.id)}" ${f.records[0] === r.id ? 'checked' : ''}>
        <i class="dot" style="background:${r.color}"></i><span>${esc(r.name)}</span></label>`).join('')}</div>
    <div class="f-group"><div class="f-title">${icon('layers')}${esc(t('sr.fKind'))}${f.kinds.length ? `<a href="#" data-a="kinds-clear">${esc(t('common.clear'))}</a>` : ''}</div>
      <div class="f-kinds">${KIND_FILTERS.map((k) => `<button type="button" class="f-kind ${f.kinds.includes(k) ? 'on' : ''}" data-k="${k}" style="--c:${kindColor(k)}">${icon(kindIcon(k))}<span>${esc(t(`kind.${k}`))}</span></button>`).join('')}</div></div>
    <div class="f-group"><div class="f-title">${icon('calendar')}${esc(t('sr.fDate'))}</div>
      ${Object.keys(DATE_FILTERS).map((k) => `<label class="f-opt"><input type="radio" name="f-date" value="${k}" ${f.date === k ? 'checked' : ''}><span>${esc(t(`sr.date.${k}`))}</span></label>`).join('')}</div>
    <div class="f-group"><div class="f-title">${icon('hdd')}${esc(t('sr.fSize'))}</div>
      ${Object.keys(SIZE_FILTERS).map((k) => `<label class="f-opt"><input type="radio" name="f-size" value="${k}" ${f.size === k ? 'checked' : ''}><span>${esc(t(`sr.size.${k}`))}</span></label>`).join('')}</div>
    <div class="f-help">${icon('info')}<span>${esc(t('sr.help'))}</span></div>`;
  el.onchange = (e) => {
    const i = e.target;
    if (i.name === 'f-rec') f.records = i.value ? [i.value] : [];
    if (i.name === 'f-date') f.date = i.value;
    if (i.name === 'f-size') f.size = i.value;
    search.offset = 0;
    runSearch();
    if (search.tab === 'cloud') loadCloud();
  };
  el.onclick = (e) => {
    const k = e.target.closest('.f-kind')?.dataset.k;
    if (e.target.closest('[data-a="kinds-clear"]')) { e.preventDefault(); f.kinds = []; }
    else if (k) f.kinds = f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k];
    else return;
    renderFilters();
    search.offset = 0;
    runSearch();
  };
}

function searchOpts() {
  const f = search.filters;
  const o = { q: search.q, records: f.records, kinds: f.kinds, sort: $('#sort').value, limit: 50, offset: search.offset };
  if (DATE_FILTERS[f.date]) o.from = Date.now() - DATE_FILTERS[f.date] * 86400000;
  const [mn, mx] = SIZE_FILTERS[f.size] || [0, 0];
  if (mn) o.minSize = mn;
  if (mx) o.maxSize = mx;
  return o;
}

function scheduleSearch(ms) {
  clearTimeout(search.timer);
  search.timer = setTimeout(runSearch, ms);
}

async function runSearch() {
  clearTimeout(search.timer);
  const q = search.q.trim();
  const seq = ++search.seq;
  if (!q) {
    search.results = []; search.total = 0;
    paintTabs();
    renderResults(null);
    if (search.tab === 'cloud') loadCloud();
    return;
  }
  let r;
  try { r = await window.api.search(searchOpts()); } catch (e) { if (seq === search.seq) renderResults({ error: e.message }); return; }
  if (seq !== search.seq) return;
  if (search.offset) search.results = search.results.concat(r.results); else { search.results = r.results; search.selected = -1; }
  search.total = r.total;
  paintTabs();
  renderResults(r);
  if (search.tab === 'cloud' && search.cloudScope === 'results') loadCloud();
}

function renderResults(r) {
  const el = $('#results');
  const note = $('#fuzzyNote');
  note.classList.add('hidden');
  if (!r) { el.innerHTML = `<div class="empty-big">${icon('search')}<span>${esc(t('sr.typeToSearch'))}</span></div>`; renderPreview($('#preview'), null); return; }
  if (r.error) { el.innerHTML = `<div class="empty-big err">${icon('alert')}<span>${esc(r.error)}</span></div>`; return; }
  const fz = Object.entries(r.fuzzy || {});
  if (fz.length && r.total) {
    note.innerHTML = `${icon('sparkles')}<span>${esc(t('sr.fuzzy'))} ${fz.map(([w, alts]) => `<b>${esc(w)}</b> → ${alts.slice(0, 3).map((a) => `<i>${esc(a)}</i>`).join(', ')}`).join(' · ')}</span>`;
    note.classList.remove('hidden');
  }
  if (!search.results.length) {
    el.innerHTML = `<div class="empty-big">${icon('search')}<span>${esc(t('sr.noResults', { q: search.q.trim() }))}</span><small>${esc(t('sr.noResultsHint'))}</small></div>`;
    renderPreview($('#preview'), null, { emptyText: t('pv.emptySearch') });
    return;
  }
  el.innerHTML = '';
  el.appendChild(h(`<div class="results-meta">${esc(t('sr.found', { n: fmtNum(r.total), ms: r.tookMs }))}</div>`));
  search.results.forEach((x, i) => el.appendChild(resultItem(x, i)));
  if (search.results.length < search.total) {
    const more = h(`<button class="btn more" type="button">${esc(t('sr.more', { n: fmtNum(search.total - search.results.length) }))}</button>`);
    more.onclick = () => { search.offset = search.results.length; runSearch(); };
    el.appendChild(more);
  }
  if (search.selected < 0 && search.results.length) selectResult(0);
  else highlightSelected();
}

function resultItem(x, i) {
  const rec = data.records.find((r) => r.id === x.record);
  const dir = x.rel.includes('/') ? x.rel.slice(0, x.rel.lastIndexOf('/')) : '';
  const badge = x.source === 'ocr' ? `<span class="badge">${icon('image')}OCR</span>` : x.source === 'speech' ? `<span class="badge">${icon('mic')}${esc(t('src.speechShort'))}</span>` : '';
  const el = h(`<div class="result" data-i="${i}" style="--c:${kindColor(x.isDir ? 'folder' : x.kind)}">
    <div class="r-ico">${icon(kindIcon(x.isDir ? 'folder' : x.kind))}</div>
    <div class="r-body">
      <div class="r-name">${snippetHtml(x.nameParts) || esc(x.name)}${badge}</div>
      <div class="r-path"><i class="dot" style="background:${rec ? rec.color : '#888'}"></i>${esc(x.recordName)}${dir ? ` <span class="sep">›</span> ${esc(dir.replace(/\//g, ' › '))}` : ''}</div>
      ${x.snippet && x.snippet.length ? `<div class="r-snip">${snippetHtml(x.snippet)}</div>` : ''}
      <div class="r-meta">${x.isDir ? esc(t('kind.folder')) : `${esc(formatDate(x.mtime))} · ${formatSize(x.size)}`}${x.hits > 1 ? ` · ${esc(t('sr.hits', { n: x.hits }))}` : ''}</div>
    </div>
  </div>`);
  el.onclick = () => selectResult(i);
  el.ondblclick = () => window.api.openFile(x.id).catch((e) => toast(e.message, { type: 'err' }));
  el.oncontextmenu = (e) => {
    e.preventDefault();
    selectResult(i);
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'open', action: () => window.api.openFile(x.id) },
      { label: t('pv.reveal'), icon: 'folderOpen', action: () => window.api.revealFile(x.id) },
      { label: t('pv.copyPath'), icon: 'copy', action: () => window.api.copyPath(x.id).then(() => toast(t('pv.copied'), { type: 'ok' })) },
      '-',
      { label: t('pv.showInRecord'), icon: 'tree', action: () => window.api.openRecord(x.record, { rel: dir, docId: x.id }) },
    ]);
  };
  return el;
}

function highlightSelected() {
  document.querySelectorAll('#results .result').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === search.selected));
}

let previewSeq = 0;
async function selectResult(i) {
  search.selected = i;
  highlightSelected();
  const x = search.results[i];
  if (!x) return;
  const el = document.querySelector(`#results .result[data-i="${i}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
  const seq = ++previewSeq;
  const d = await window.api.doc(x.id).catch(() => null);
  if (seq !== previewSeq) return;
  renderPreview($('#preview'), d, { query: search.q, onSearch: (term) => setQuery(term), showRecordLink: true });
}

function moveSelection(dir) {
  if (!search.results.length) return;
  selectResult(Math.max(0, Math.min(search.results.length - 1, search.selected + dir)));
}

// Önizleme panelinin genişliği (sürükleyerek)
(() => {
  const split = $('#split');
  split.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = $('#preview').getBoundingClientRect().width;
    const rtl = document.documentElement.dir === 'rtl';
    const move = (ev) => { const w = Math.max(300, Math.min(900, startW + (rtl ? ev.clientX - startX : startX - ev.clientX))); $('#preview').style.width = `${w}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.api.setSettings({ previewWidth: Math.round($('#preview').getBoundingClientRect().width) });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  window.api.getStore().then((s) => { if (s.settings.previewWidth) $('#preview').style.width = `${s.settings.previewWidth}px`; });
})();

// --- 3B kelime bulutu (alt modül) --------------------------------------------------------
function cloudBar() {
  const el = $('#cloudBar');
  const hasQ = !!search.q.trim();
  if (!hasQ && search.cloudScope === 'results') search.cloudScope = 'all';
  el.innerHTML = `<span class="cb-title">${icon('cube')}${esc(t('cl.title'))}</span>
    <div class="seg" id="cloudScope">
      <button type="button" data-v="results" ${hasQ ? '' : 'disabled'}>${esc(t('cl.scopeResults'))}</button>
      <button type="button" data-v="all">${esc(search.filters.records.length ? t('cl.scopeRecord') : t('cl.scopeAll'))}</button>
    </div>
    <span class="spacer"></span>
    <label class="cb-count">${esc(t('cl.count'))} <select class="input sm" id="cloudCount">${options([[60, '60'], [120, '120'], [200, '200']], search.cloudCount || 120)}</select></label>
    <button class="btn sm ghost" id="cloudReset">${icon('crosshair')}${esc(t('cl.reset'))}</button>`;
  el.querySelectorAll('#cloudScope button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === search.cloudScope);
    b.onclick = () => { search.cloudScope = b.dataset.v; cloudBar(); loadCloud(); };
  });
  el.querySelector('#cloudCount').onchange = (e) => { search.cloudCount = Number(e.target.value); loadCloud(); };
  el.querySelector('#cloudReset').onclick = () => search.cloud && search.cloud.reset();
  $('#cloudHelp').innerHTML = `${icon('info')}<span>${esc(t('cl.help'))}</span>`;
}

function showCloud() {
  cloudBar();
  loadCloud();
}

async function loadCloud() {
  if (search.tab !== 'cloud' || !search.active) return;
  cloudBar();
  const opts = { limit: search.cloudCount || 120 };
  if (search.cloudScope === 'results' && search.q.trim()) {
    const r = await window.api.search({ ...searchOpts(), limit: 500, offset: 0 }).catch(() => ({ results: [] }));
    opts.ids = r.results.map((x) => x.id);
    if (!opts.ids.length) return paintCloud([]);
  } else if (search.filters.records.length) opts.records = search.filters.records;
  const words = await window.api.cloud(opts).catch(() => []);
  paintCloud(words);
}

function paintCloud(words) {
  const host = $('#cloud3d');
  if (!words.length) {
    disposeCloud();
    host.innerHTML = `<div class="empty-big">${icon('cube')}<span>${esc(t('cl.empty'))}</span></div>`;
    return;
  }
  const ready = () => {
    if (!window.Cloud3D) return setTimeout(ready, 50);
    if (search.cloud) { search.cloud.update(words); return; }
    host.innerHTML = '';
    search.cloud = window.Cloud3D.mount(host, words, {
      onPick: (term) => { search.tab = 'results'; setQuery(term); paintTabs(); },
      onHover: (w, x, y) => {
        const tip = $('#cloudTip');
        if (!w) { tip.classList.add('hidden'); return; }
        tip.innerHTML = `<b>${esc(w.term)}</b><span>${esc(t('cl.tip', { n: fmtNum(w.n), d: fmtNum(w.docs) }))}</span>`;
        tip.style.left = `${x + 14}px`;
        tip.style.top = `${y + 14}px`;
        tip.classList.remove('hidden');
      },
    });
  };
  ready();
}

function disposeCloud() {
  if (search.cloud) { search.cloud.dispose(); search.cloud = null; }
  $('#cloudTip').classList.add('hidden');
}
