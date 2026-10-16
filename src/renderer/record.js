'use strict';

// Kayıt penceresi: solda klasör ağacı (tüm alt klasörler, boyutlarıyla), ortada seçili klasörün dosyaları
// (ya da bu kayıttaki arama sonuçları), sağda önizleme; altta canlı durum çubuğu. Değişiklikler izlendikçe
// ağaç ve liste kendiliğinden yenilenir.

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const RID = params.get('id');

let rec = null;
let settings = {};
let stats = null;
let current = params.get('rel') || '';  // listedeki klasör
let selectedRel = null;                  // listede seçili öğe
const open = new Set(['']);              // ağaçta açık klasörler
let listRows = [];
let sort = { key: 'name', dir: 1 };
let query = '';
let searchSeq = 0;
const LIST_LIMIT = 3000;

const fmtNum = (n) => Number(n || 0).toLocaleString(LANG);

// --- Üst çubuk ------------------------------------------------------------------
$('.search-ico').innerHTML = icon('search');
$('#searchClear').innerHTML = icon('x');
$('#search').placeholder = t('rw.searchPh');
$('#btnRescan').innerHTML = icon('refresh');
$('#btnRescan').title = t('app.rescan');
$('#btnFolder').innerHTML = icon('folderOpen');
$('#btnFolder').title = t('app.openFolder');
$('#btnEdit').innerHTML = icon('gear');
$('#btnEdit').title = t('app.recordSettings');
const paintThemeBtn = themeButton($('#btnTheme'), () => settings);
mountMastertool($('.topbar .actions'));

$('#btnRescan').onclick = () => { window.api.rescan(RID); toast(t('rw.rescanStarted'), { type: 'ok' }); };
$('#btnFolder').onclick = () => window.api.openRecordFolder(RID);
$('#btnEdit').onclick = async () => { if (await editRecord(rec)) toast(t('common.saved'), { type: 'ok' }); };

function paintHeader() {
  if (!rec) return;
  document.title = `${rec.name} — File Search`;
  $('#recAvatar').innerHTML = icon(rec.network ? 'drive' : 'folder');
  $('#recAvatar').style.setProperty('--c', rec.color || '#22d3ee');
  $('#recName').textContent = rec.name;
  $('#recPath').textContent = rec.path || t('rec.noPathShort');
  $('#recPath').title = rec.path || '';
}

// --- Ağaç -------------------------------------------------------------------------
async function renderTree() {
  const host = $('#tree');
  const root = await window.api.rootInfo(RID).catch(() => null);
  if (!root) { host.innerHTML = ''; return; }
  const frag = document.createDocumentFragment();
  frag.appendChild(treeNode({ ...root, name: rec ? rec.name : root.name }, 0));
  if (open.has('')) await appendChildren(frag, '', 1);
  host.innerHTML = '';
  host.appendChild(frag);
  const sel = host.querySelector('.tnode.on');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function appendChildren(frag, rel, depth) {
  const kids = await window.api.children(RID, rel, true).catch(() => []);
  for (const k of kids) {
    frag.appendChild(treeNode(k, depth));
    if (open.has(k.rel)) await appendChildren(frag, k.rel, depth + 1);
  }
}

function treeNode(n, depth) {
  const isOpen = open.has(n.rel);
  const el = h(`<div class="tnode ${current === n.rel && !query ? 'on' : ''}" style="--d:${depth}" data-rel="${esc(n.rel)}">
    <span class="tw ${n.hasDirs ? '' : 'leaf'}">${n.hasDirs ? icon(isOpen ? 'chevronDown' : 'chevronRight') : ''}</span>
    <span class="tico">${icon(n.rel === '' ? (rec && rec.network ? 'drive' : 'hdd') : isOpen ? 'folderOpen' : 'folder')}</span>
    <span class="tname" title="${esc(n.name)}">${esc(n.name)}</span>
    <span class="tsize">${formatSize(n.size)}</span>
  </div>`);
  el.querySelector('.tw').onclick = (e) => {
    e.stopPropagation();
    if (!n.hasDirs) return;
    if (isOpen) open.delete(n.rel); else open.add(n.rel);
    renderTree();
  };
  el.onclick = () => { if (query) clearSearch(); goTo(n.rel); };
  el.ondblclick = () => { if (!n.hasDirs) return; if (open.has(n.rel)) open.delete(n.rel); else open.add(n.rel); renderTree(); };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'folderOpen', action: () => withNode(n.rel, (d) => window.api.openFile(d.node.id)) },
      { label: t('pv.copyPath'), icon: 'copy', action: () => withNode(n.rel, (d) => window.api.copyPath(d.node.id).then(() => toast(t('pv.copied'), { type: 'ok' }))) },
    ]);
  };
  return el;
}

async function withNode(rel, fn) {
  const d = await window.api.nodeAt(RID, rel).catch(() => null);
  if (d) fn(d).catch?.((e) => toast(e.message, { type: 'err' }));
}

// Bir klasöre git: üst klasörleri ağaçta aç, listeyi yükle
async function goTo(rel, { select = null } = {}) {
  current = rel;
  let p = rel;
  while (p) { p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; open.add(p); }
  selectedRel = select;
  await Promise.all([renderTree(), loadList()]);
  if (select) previewRel(select); else previewRel(rel);
}

// --- Liste ------------------------------------------------------------------------
async function loadList() {
  if (query) return;
  listRows = await window.api.children(RID, current, false).catch(() => []);
  renderCrumbs();
  renderList();
}

function renderCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  if (query) {
    el.appendChild(h(`<span class="crumb current">${icon('search')} ${esc(t('rw.results', { q: query, n: fmtNum(listRows.length) }))}</span>`));
    const back = h(`<button class="btn sm ghost">${icon('x')}${esc(t('rw.backToFolder'))}</button>`);
    back.onclick = clearSearch;
    el.appendChild(h('<span class="spacer"></span>'));
    el.appendChild(back);
    return;
  }
  const parts = [{ rel: '', name: rec ? rec.name : '' }];
  if (current) current.split('/').forEach((seg, i, arr) => parts.push({ rel: arr.slice(0, i + 1).join('/'), name: seg }));
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    const c = h(`<span class="crumb ${last ? 'current' : ''}">${i === 0 ? icon('home') : icon('folder')}${esc(p.name)}</span>`);
    if (!last) c.onclick = () => goTo(p.rel);
    el.appendChild(c);
    if (!last) el.appendChild(h(`<span class="crumb-sep">${icon('chevronRight')}</span>`));
  });
}

const COLS = [
  { key: 'name', label: () => t('rw.colName') },
  { key: 'size', label: () => t('rw.colSize'), cls: 'num' },
  { key: 'kind', label: () => t('rw.colKind') },
  { key: 'mtime', label: () => t('rw.colModified') },
  { key: 'state', label: () => t('rw.colIndex') },
];

function sorted(rows) {
  const k = sort.key;
  const cmp = (a, b) => {
    if (!query && a.is_dir !== b.is_dir) return b.is_dir - a.is_dir;
    let r;
    if (k === 'name') r = a.name.localeCompare(b.name, LANG, { numeric: true, sensitivity: 'base' });
    else if (k === 'kind') r = (a.kind || '').localeCompare(b.kind || '');
    else r = (a[k] || 0) - (b[k] || 0);
    return r * sort.dir;
  };
  return rows.slice().sort(cmp);
}

function renderList() {
  const el = $('#list');
  el.innerHTML = '';
  const head = h(`<div class="frow fhead">${COLS.map((c) => `<span class="c-${c.key} ${c.cls || ''}" data-k="${c.key}">${esc(c.label())}${sort.key === c.key ? icon(sort.dir > 0 ? 'chevronDown' : 'up') : ''}</span>`).join('')}</div>`);
  head.onclick = (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: k === 'name' || k === 'kind' ? 1 : -1 };
    renderList();
  };
  el.appendChild(head);
  if (!listRows.length) {
    el.appendChild(h(`<div class="empty-note">${esc(query ? t('sr.noResults', { q: query }) : rec && !rec.path ? t('rec.noPath') : t('rw.emptyFolder'))}</div>`));
    return;
  }
  const rows = sorted(listRows).slice(0, LIST_LIMIT);
  const body = h('<div class="fbody"></div>');
  for (const r of rows) body.appendChild(listRow(r));
  el.appendChild(body);
  if (listRows.length > LIST_LIMIT) el.appendChild(h(`<div class="empty-note">${esc(t('rw.limited', { n: fmtNum(LIST_LIMIT), total: fmtNum(listRows.length) }))}</div>`));
}

function listRow(r) {
  const kind = r.is_dir ? 'folder' : r.kind;
  const sub = query && r.rel.includes('/') ? `<small class="fsub">${esc(r.rel.slice(0, r.rel.lastIndexOf('/')).replace(/\//g, ' › '))}</small>` : '';
  const snip = query && r.snippet && r.snippet.length ? `<small class="fsnip">${snippetHtml(r.snippet)}</small>` : '';
  const el = h(`<div class="frow ${selectedRel === r.rel ? 'on' : ''}" data-rel="${esc(r.rel)}" style="--c:${kindColor(kind)}">
    <span class="c-name"><span class="fico">${icon(kindIcon(kind))}</span><span class="fname"><span>${query && r.nameParts ? snippetHtml(r.nameParts) : esc(r.name)}</span>${sub}${snip}</span></span>
    <span class="c-size num">${formatSize(r.size)}</span>
    <span class="c-kind">${esc(r.is_dir ? t('rw.filesIn', { n: fmtNum(r.files || 0) }) : t(`kind.${r.kind}`))}</span>
    <span class="c-mtime">${r.mtime ? esc(formatDate(r.mtime)) : ''}</span>
    <span class="c-state">${r.is_dir ? '' : stateChip(r)}</span>
  </div>`);
  el.onclick = () => { selectedRel = r.rel; document.querySelectorAll('#list .frow.on').forEach((x) => x.classList.remove('on')); el.classList.add('on'); previewRel(r.rel, r.id); };
  el.ondblclick = () => {
    if (r.is_dir) { if (query) clearSearch(); goTo(r.rel); }
    else window.api.openFile(r.id).catch((e) => toast(e.message, { type: 'err' }));
  };
  el.oncontextmenu = (e) => {
    e.preventDefault();
    el.click();
    contextMenu(e.clientX, e.clientY, [
      { label: t('common.open'), icon: 'open', action: () => window.api.openFile(r.id) },
      { label: t('pv.reveal'), icon: 'folderOpen', action: () => window.api.revealFile(r.id) },
      { label: t('pv.copyPath'), icon: 'copy', action: () => window.api.copyPath(r.id).then(() => toast(t('pv.copied'), { type: 'ok' })) },
      ...(query ? ['-', { label: t('rw.goToFolder'), icon: 'folder', action: () => { const p = r.rel.includes('/') ? r.rel.slice(0, r.rel.lastIndexOf('/')) : ''; clearSearch(); goTo(p, { select: r.rel }); } }] : []),
    ]);
  };
  return el;
}

const STATE_CLS = ['run', 'ok', 'muted', 'err', 'muted', 'muted', 'muted'];
function stateChip(r) {
  const label = stateLabel({ ...r, is_dir: 0 });
  const ic = r.state === 1 ? (r.source === 'ocr' ? 'image' : r.source === 'speech' ? 'mic' : 'check') : r.state === 3 ? 'x' : r.state === 0 ? 'history' : 'info';
  return `<span class="schip ${STATE_CLS[r.state] || ''}" title="${esc(label)}">${icon(ic)}<span>${esc(label)}</span></span>`;
}

// --- Önizleme ---------------------------------------------------------------------
let pvSeq = 0;
async function previewRel(rel, id) {
  const seq = ++pvSeq;
  const d = id ? await window.api.doc(id).catch(() => null) : await window.api.nodeAt(RID, rel).catch(() => null);
  if (seq !== pvSeq) return;
  renderPreview($('#preview'), d, { query, onSearch: (term) => { $('#search').value = term; runSearch(term); } });
}

// --- Bu kayıtta arama ----------------------------------------------------------------
let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  const v = e.target.value;
  $('#searchClear').classList.toggle('hidden', !v);
  clearTimeout(searchTimer);
  if (!v.trim()) { clearSearch(); return; }
  searchTimer = setTimeout(() => runSearch(v), 220);
});
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); } });
$('#searchClear').onclick = clearSearch;

async function runSearch(q) {
  query = q.trim();
  $('#searchClear').classList.toggle('hidden', !query);
  if (!query) return clearSearch();
  const seq = ++searchSeq;
  const r = await window.api.search({ q: query, records: [RID], limit: 500 }).catch(() => ({ results: [], total: 0 }));
  if (seq !== searchSeq) return;
  listRows = r.results.map((x) => ({ ...x, is_dir: x.isDir ? 1 : 0 }));
  sort = { key: 'score', dir: 1 };
  selectedRel = null;
  renderCrumbs();
  renderList();
  document.querySelectorAll('#tree .tnode.on').forEach((x) => x.classList.remove('on'));
  if (listRows.length) previewRel(listRows[0].rel, listRows[0].id);
}

function clearSearch() {
  query = '';
  $('#search').value = '';
  $('#searchClear').classList.add('hidden');
  sort = { key: 'name', dir: 1 };
  loadList();
  renderTree();
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (e.key === 'F5') { e.preventDefault(); window.api.rescan(RID); }
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (!inInput && e.key === 'Backspace' && current && !query) goTo(current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '');
  if (!inInput && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const rows = [...document.querySelectorAll('#list .fbody .frow')];
    if (!rows.length) return;
    e.preventDefault();
    let i = rows.findIndex((x) => x.classList.contains('on'));
    i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[i].click();
    rows[i].scrollIntoView({ block: 'nearest' });
  }
  if (!inInput && e.key === 'Enter') { const on = document.querySelector('#list .fbody .frow.on'); if (on) on.dispatchEvent(new MouseEvent('dblclick')); }
});

// --- Durum çubuğu ---------------------------------------------------------------------
function paintStatus() {
  const el = $('#status');
  const s = stats;
  if (!rec) return;
  if (!s) { el.innerHTML = `<span class="spin"></span><span>${esc(t('rec.starting'))}</span>`; return; }
  const st = (() => {
    if (!rec.path) return ['warn', 'alert', t('rec.noPath')];
    if (settings.indexingPaused || rec.paused) return ['muted', 'pause', t('rec.paused')];
    if (s.state === 'missing') return ['err', 'alert', t(rec.network ? 'rec.offline' : 'rec.missing')];
    if (s.state === 'scanning') return ['run', null, t('rec.scanning')];
    if (s.state === 'indexing' || s.running) return ['run', null, t('rec.indexingShort')];
    return ['ok', 'eyeScan', t('rec.watching')];
  })();
  const total = (s.indexed || 0) + (s.pending || 0);
  el.innerHTML = `
    <span class="sb-item ${st[0]}">${st[1] ? icon(st[1]) : '<span class="spin"></span>'}${esc(st[2])}</span>
    <span class="sb-item"><b>${formatSize(s.size)}</b></span>
    <span class="sb-item">${icon('file')}${esc(t('rec.files', { n: fmtNum(s.files) }))}</span>
    <span class="sb-item">${icon('folder')}${esc(t('rec.dirs', { n: fmtNum(s.dirs) }))}</span>
    <span class="sb-item">${icon('check')}${esc(t('rw.indexed', { n: fmtNum(s.indexed), total: fmtNum(total) }))}</span>
    ${s.waiting ? `<span class="sb-item link" data-a="settings">${icon('image')}${esc(t('rec.waiting', { n: fmtNum(s.waiting) }))}</span>` : ''}
    ${s.errors ? `<span class="sb-item err link" data-a="retry">${icon('x')}${esc(t('rec.errors', { n: fmtNum(s.errors) }))}</span>` : ''}
    <span class="spacer"></span>
    <span class="sb-item muted">${icon('image')}${esc(t(settings.ocrEnabled ? 'app.ocrOn' : 'app.ocrOff'))}</span>
    <span class="sb-item muted">${icon('mic')}${esc(t(settings.speechEnabled ? 'app.speechOn' : 'app.speechOff'))}</span>
    ${s.state === 'scanning' || s.state === 'indexing' ? '' : ''}
    ${total ? `<div class="sb-progress"><div style="width:${Math.round(((s.indexed || 0) / total) * 100)}%"></div></div>` : ''}`;
  el.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'retry') { window.api.retryErrors(RID); toast(t('rw.retrying'), { type: 'ok' }); }
    if (a === 'settings') openSettings(settings, 'search');
  };
}

// --- Bölücüler (panel genişlikleri) -----------------------------------------------------
function splitter(id, target, key, { min, max, side }) {
  $(id).addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = $(target).getBoundingClientRect().width;
    const rtl = document.documentElement.dir === 'rtl';
    const sign = (side === 'left' ? 1 : -1) * (rtl ? -1 : 1);
    const move = (ev) => { $(target).style.width = `${Math.max(min, Math.min(max, startW + sign * (ev.clientX - startX)))}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.api.setSettings({ [key]: Math.round($(target).getBoundingClientRect().width) });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
splitter('#splitTree', '#tree', 'treeWidth', { min: 200, max: 600, side: 'left' });
splitter('#splitPreview', '#preview', 'previewWidth', { min: 300, max: 900, side: 'right' });

// --- Olaylar ve başlangıç -------------------------------------------------------------
window.api.onStoreChanged((d) => {
  settings = d.settings;
  rec = d.records.find((r) => r.id === RID) || rec;
  paintHeader();
  paintStatus();
  paintThemeBtn();
});
window.api.onRecordInfo((r) => { if (r) { rec = r; paintHeader(); renderTree(); } });
window.api.onRecordStats((s) => { stats = s[RID] || null; paintStatus(); });

// İzlenen değişiklikler: görünen klasör ya da ağaç etkilendiyse yenile (en çok saniyede bir)
let refreshTimer = null;
window.api.onRecordChanged(() => {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    renderTree();
    if (!query) loadList();
  }, 1000);
});
window.api.onRecordReveal(({ rel, docId }) => reveal(rel, docId));

async function reveal(rel, docId) {
  if (query) { query = ''; $('#search').value = ''; $('#searchClear').classList.add('hidden'); }
  if (docId) {
    const d = await window.api.doc(Number(docId)).catch(() => null);
    if (d) return goTo(d.node.parent, { select: d.node.rel });
  }
  goTo(rel || '');
}

(async () => {
  const [d, s] = await Promise.all([window.api.getStore(), window.api.recordStats()]);
  settings = d.settings;
  rec = d.records.find((r) => r.id === RID);
  stats = (s || {})[RID] || null;
  if (settings.treeWidth) $('#tree').style.width = `${settings.treeWidth}px`;
  if (settings.previewWidth) $('#preview').style.width = `${settings.previewWidth}px`;
  paintHeader();
  paintStatus();
  paintThemeBtn();
  if (params.get('doc')) reveal(current, params.get('doc'));
  else goTo(current);
})();
