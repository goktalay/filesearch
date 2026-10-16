'use strict';

// Kayıt formu (Yeni / Kayıt ayarları) — ana pencere ve kayıt penceresi ortak.
// "Yeni": önce klasör sorulur, sonra ad, renk, hariç tutma kalıpları ve boyut sınırı.

async function newRecord() {
  const dir = await window.api.pickFolder();
  if (!dir) return null;
  return editRecord(null, { path: dir });
}

const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

async function editRecord(rec, { path: presetPath } = {}) {
  const isNew = !rec;
  const r = rec || { name: baseName(presetPath), color: FORMATS.COLORS[Math.floor(Math.random() * 6)], excludes: FORMATS.DEFAULT_EXCLUDES, maxFileMB: 0, path: presetPath || '' };
  let color = r.color || FORMATS.COLORS[0];
  const body = h(`<div class="pf">
    <div class="field"><label>${esc(t('rf.folder'))}</label>
      <div class="src-pick"><input class="input" id="rf-path" spellcheck="false" value="${esc(r.path || '')}" placeholder="${esc(t('rf.folderPh'))}">
        <button class="btn" type="button" id="rf-pick">${icon('folderOpen')}${esc(t('common.choose'))}</button></div>
      <small class="set-hint">${esc(t('rf.folderHint'))}</small></div>
    <div class="field"><label>${esc(t('rf.name'))}</label><input class="input" id="rf-name" value="${esc(r.name || '')}" placeholder="${esc(t('rf.namePh'))}"></div>
    <div class="field"><label>${esc(t('rf.color'))}</label><div class="swatches" id="rf-colors"></div></div>
    <div class="row" style="grid-template-columns: 2fr 1fr">
      <div class="field"><label>${esc(t('rf.excludes'))}</label>
        <textarea class="input" id="rf-ex" rows="4" spellcheck="false">${esc((r.excludes || []).join('\n'))}</textarea>
        <small class="set-hint">${esc(t('rf.excludesHint'))}</small></div>
      <div class="field"><label>${esc(t('rf.maxFile'))}</label>
        <div class="unit-wrap"><input class="input" id="rf-max" type="number" min="0" max="4096" value="${r.maxFileMB ? esc(r.maxFileMB) : ''}" placeholder="${esc(t('rf.maxFileDefault'))}"><span>MB</span></div>
        <small class="set-hint">${esc(t('rf.maxFileHint'))}</small></div>
    </div>
    <div class="info-note">${icon('eyeScan')}<span>${esc(t('rf.watchNote'))}</span></div>
  </div>`);
  const q = (s) => body.querySelector(s);
  const paintColors = () => {
    const el = q('#rf-colors');
    el.innerHTML = '';
    for (const c of FORMATS.COLORS) {
      const b = h(`<button type="button" class="swatch ${c === color ? 'on' : ''}" style="--c:${c}" title="${c}"></button>`);
      b.onclick = () => { color = c; paintColors(); };
      el.appendChild(b);
    }
  };
  paintColors();
  let nameTouched = !isNew;
  q('#rf-name').addEventListener('input', () => { nameTouched = true; });
  q('#rf-pick').onclick = async () => {
    const p = await window.api.pickFolder({ defaultPath: q('#rf-path').value || undefined });
    if (!p) return;
    q('#rf-path').value = p;
    q('#rf-path').classList.remove('invalid');
    if (!nameTouched || !q('#rf-name').value.trim()) q('#rf-name').value = baseName(p);
  };
  return openModal({
    title: isNew ? t('rf.titleNew') : t('rf.titleEdit', { name: r.name }), iconName: isNew ? 'plus' : 'gear', width: 620, body,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.save'), cls: 'primary',
        onClick: async () => {
          const p = q('#rf-path').value.trim();
          if (!p) { q('#rf-path').classList.add('invalid'); q('#rf-path').focus(); return false; }
          const id = await window.api.saveRecord({
            id: rec && rec.id, path: p, name: q('#rf-name').value.trim() || baseName(p), color,
            excludes: q('#rf-ex').value, maxFileMB: Number(q('#rf-max').value) || 0, notes: (rec && rec.notes) || '',
          });
          return id;
        },
      },
    ],
  });
}
