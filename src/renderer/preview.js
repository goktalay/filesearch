'use strict';

// Belge önizleme paneli (ana penceredeki arama ve kayıt penceresi ortak):
// başlık ve işlemler, bilgiler, resim/ses/video, belgenin kelime (etiket) bulutu ve vurgulu metin.

// Pencerede katlama (dizinleyicideki text.fold ile aynı kural): küçük harf, aksansız, ı → i
const FOLD_EXTRA = { ı: 'i', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd', ł: 'l', ß: 'ss', þ: 'th', ð: 'd' };
const foldText = (s) => String(s).replace(/İ/g, 'i').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[ıøæœđłßþð]/g, (c) => FOLD_EXTRA[c]);
const WORD_RE_UI = /[\p{L}\p{M}\p{N}_]+/gu;

// Sorgudan vurgulanacak kelimeler (tırnaklar ve -hariç kelimeler ayıklanır); ≥3 harflide önek eşleşmesi
function queryMatcher(q) {
  const ws = [];
  String(q || '').replace(/-("[^"]*"|\S+)/g, ' ').replace(WORD_RE_UI, (w) => { ws.push(foldText(w)); return w; });
  if (!ws.length) return null;
  return (raw) => {
    const f = foldText(raw);
    return ws.some((w) => (w.length >= 3 ? f.startsWith(w) || (f.length >= 4 && w.startsWith(f.slice(0, Math.max(4, w.length - 3)))) : f === w));
  };
}

// Vurgulu HTML (yalnız ilk maxChars karakter taranır)
function highlightHtml(text, isMatch, maxChars = 120000) {
  if (!isMatch) return esc(text);
  const head = text.slice(0, maxChars);
  let out = '';
  let pos = 0;
  head.replace(WORD_RE_UI, (w, i) => {
    if (isMatch(w)) {
      out += `${esc(head.slice(pos, i))}<mark>${esc(w)}</mark>`;
      pos = i + w.length;
    }
    return w;
  });
  return out + esc(head.slice(pos)) + esc(text.slice(maxChars));
}

const snippetHtml = (parts) => (parts || []).map((p) => (p.m ? `<mark>${esc(p.t)}</mark>` : esc(p.t))).join('');

const STATE_KEYS = ['pending', 'indexed', 'skipped', 'error', 'waitOcr', 'waitSpeech', 'empty'];
function stateLabel(n) {
  const k = STATE_KEYS[n.state] || 'pending';
  if (n.is_dir) return '';
  if (k === 'skipped' && n.err === 'too_large') return t('st.tooLarge');
  if (k === 'error') return t('st.error', { msg: errLabel(n.err) });
  return t(`st.${k}`);
}
function errLabel(code) {
  const map = { encrypted: 'err.encrypted', corrupt: 'err.corrupt', binary: 'err.binary', EACCES: 'err.access', EPERM: 'err.access', EBUSY: 'err.busy', no_audio: 'err.noAudio' };
  return map[code] ? t(map[code], { msg: '' }) : String(code || '');
}

// Kelime bulutu (2B): sıklığa göre boyut, karışık sıra; tıklanınca o kelimeyle arama
const CLOUD_COLORS = ['#22d3ee', '#818cf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#60a5fa', '#2dd4bf'];
function tagCloud(terms, onPick, { max = 40 } = {}) {
  const box = h('<div class="tagcloud"></div>');
  const list = (terms || []).slice(0, max);
  if (!list.length) { box.appendChild(h(`<div class="empty-note">${esc(t('pv.noTerms'))}</div>`)); return box; }
  const hi = list[0].n;
  const lo = list[list.length - 1].n;
  // Kararlı karıştırma: aynı belge her açılışta aynı görünsün
  const order = list.map((x, i) => ({ x, k: (Math.sin((i + 1) * 12.9898 + x.term.length * 78.233) * 43758.5453) % 1 })).sort((a, b) => a.k - b.k).map((o) => o.x);
  for (const it of order) {
    const r = hi === lo ? 0.5 : (Math.log(it.n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    const size = 11 + Math.round(r * 17);
    const color = CLOUD_COLORS[Math.abs([...it.term].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % CLOUD_COLORS.length];
    const b = h(`<button type="button" class="tag-w" style="font-size:${size}px;--c:${color};opacity:${(0.65 + r * 0.35).toFixed(2)}" title="${esc(t('pv.termCount', { n: it.n }))}">${esc(it.term)}</button>`);
    b.onclick = () => onPick && onPick(it.term);
    box.appendChild(b);
  }
  return box;
}

// Önizleme panelini çiz. d: window.api.doc() sonucu; opts: { query, onSearch, showRecordLink, onClose }
function renderPreview(el, d, opts = {}) {
  el.innerHTML = '';
  if (!d) {
    el.appendChild(h(`<div class="pv-empty">${icon('eyeScan')}<span>${esc(opts.emptyText || t('pv.empty'))}</span></div>`));
    return;
  }
  const n = d.node;
  const color = kindColor(n.is_dir ? 'folder' : n.kind);
  const head = h(`<div class="pv-head" style="--c:${color}">
    <div class="pv-ico">${icon(kindIcon(n.is_dir ? 'folder' : n.kind))}</div>
    <div class="pv-titles"><div class="pv-name" title="${esc(n.name)}">${esc(n.rel ? n.name : d.recordName)}</div>
      <div class="pv-path" title="${esc(d.path)}">${esc(d.path)}</div></div>
  </div>`);
  const actions = h(`<div class="pv-actions">
    <button class="btn sm" data-a="open">${icon('open')}${esc(t('common.open'))}</button>
    <button class="btn sm ghost" data-a="reveal">${icon('folderOpen')}${esc(t('pv.reveal'))}</button>
    <button class="btn sm ghost" data-a="copy">${icon('copy')}${esc(t('pv.copyPath'))}</button>
    ${opts.showRecordLink ? `<button class="btn sm ghost" data-a="record">${icon('tree')}${esc(t('pv.showInRecord'))}</button>` : ''}
  </div>`);
  actions.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    try {
      if (a === 'open') await window.api.openFile(n.id);
      if (a === 'reveal') await window.api.revealFile(n.id);
      if (a === 'copy') { await window.api.copyPath(n.id); toast(t('pv.copied'), { type: 'ok' }); }
      if (a === 'record') window.api.openRecord(d.record, { rel: n.parent, docId: n.id });
    } catch (err) { toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), { type: 'err' }); }
  });
  el.appendChild(head);
  el.appendChild(actions);

  const meta = [
    [t('pv.size'), formatSize(n.size)],
    [t('pv.modified'), n.mtime ? formatDate(n.mtime) : ''],
    [t('pv.kind'), n.is_dir ? `${t('kind.folder')}${n.files != null ? ` · ${t('rw.filesIn', { n: n.files.toLocaleString(LANG) })}` : ''}` : `${t(`kind.${n.kind}`)}${n.ext ? ` · .${n.ext}` : ''}`],
    [t('pv.state'), stateLabel(n)],
    [t('pv.source'), n.source ? t(`src.${n.source}`) : ''],
    [t('pv.lang'), n.lang ? langName(n.lang) : ''],
    [t('pv.words'), n.words ? n.words.toLocaleString(LANG) : ''],
    [t('pv.title'), n.title || ''],
  ].filter(([, v]) => v);
  el.appendChild(h(`<dl class="pv-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`));

  if (d.mediaUrl) {
    const kind = n.kind;
    const media = kind === 'image' ? h(`<div class="pv-media"><img src="${esc(d.mediaUrl)}" alt=""></div>`)
      : kind === 'audio' ? h(`<div class="pv-media audio"><audio controls preload="metadata" src="${esc(d.mediaUrl)}"></audio></div>`)
        : h(`<div class="pv-media"><video controls preload="metadata" src="${esc(d.mediaUrl)}"></video></div>`);
    el.appendChild(media);
  }

  if (!n.is_dir) {
    el.appendChild(h(`<div class="pv-section">${icon('cloudTags')}<span>${esc(t('pv.cloud'))}</span></div>`));
    el.appendChild(tagCloud(d.terms, opts.onSearch));
    if (d.text) {
      const isMatch = queryMatcher(opts.query);
      el.appendChild(h(`<div class="pv-section">${icon('text')}<span>${esc(t(n.source === 'ocr' ? 'pv.textOcr' : n.source === 'speech' ? 'pv.textSpeech' : 'pv.text'))}</span>
        ${d.textLength > d.text.length ? `<small>${esc(t('pv.truncated', { n: d.text.length.toLocaleString(LANG) }))}</small>` : ''}</div>`));
      const pre = h(`<pre class="pv-text">${highlightHtml(d.text, isMatch)}</pre>`);
      el.appendChild(pre);
      const first = pre.querySelector('mark');
      if (first) requestAnimationFrame(() => { pre.scrollTop = Math.max(0, first.offsetTop - pre.offsetTop - 60); });
    } else if (n.state === 1 || n.state === 6) {
      el.appendChild(h(`<div class="empty-note">${esc(t('pv.noText'))}</div>`));
    } else if (n.state === 4 || n.state === 5) {
      const hint = h(`<div class="pv-hint">${icon('info')}<span>${esc(t(n.state === 4 ? 'pv.ocrOff' : 'pv.speechOff'))}</span>
        <button class="btn sm" type="button">${icon('gear')}${esc(t('pv.openSearchSettings'))}</button></div>`);
      hint.querySelector('button').onclick = () => window.api.getStore().then((s) => openSettings(s.settings, 'search'));
      el.appendChild(hint);
    }
  }
}
