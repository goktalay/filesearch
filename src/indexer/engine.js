'use strict';

// Dizinleyici çekirdeği: kayıtların klasör ağacını tarar, değişiklikleri izler, belgelerden metin çıkarıp
// yerel FTS5 dizinine yazar ve arama, ağaç, belge ve kelime bulutu sorgularını yanıtlar.
//
// Electron'dan bağımsızdır: ana uygulamada ayrı bir süreçte (service.js) çalışır; ileride bir Windows
// hizmetine taşınabilir. Testler doğrudan bu sınıfı kullanır.
//
// Akış (her kayıt için):
//   1. fark taraması: diskteki ağaç ile dizindeki kayıtlar karşılaştırılır (yeni / değişen / silinen);
//      açılışta, kök yeniden erişilebilir olunca ve ağ sürücülerinde düzenli aralıkla yapılır
//   2. izleme: yinelemeli fs.watch; değişen yolların o anki durumuna bakılarak dizin güncellenir
//   3. içerik kuyruğu: "bekliyor" durumundaki dosyalardan metin çıkarılır (OCR ve konuşma ayrı, yavaş kuyrukta)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { open, STATE } = require('./db');
const T = require('./text');
const Q = require('./query');
const { extractFile, canExtract } = require('./extract');
const { createWatcher, compileExcludes, isUnc } = require('./watch');
const { extOf, kindOf, OCR_EXTS, SPEECH_KINDS, OCR_ISO } = require('../formats');

const BATCH = 400;                 // tarama: tek işlemde yazılan düğüm
const STAT_PARALLEL = 24;          // tarama: aynı anda stat
const RETRY_MISSING_MS = 30000;    // erişilemeyen kök: yeniden deneme
const NETWORK_RESCAN_MS = 10 * 60 * 1000; // ağ sürücüsü: düzenli fark taraması
const STATS_THROTTLE_MS = 400;
const VOCAB_TTL_MS = 60000;
const PREVIEW_CHARS = 300000;

const DEFAULT_SETTINGS = {
  concurrency: 2,                  // aynı anda metni çıkarılan dosya
  maxFileMB: 50,                   // kayıtta belirtilmemişse
  ocr: { enabled: false, languages: ['tur', 'eng'] },
  speech: { enabled: false, model: 'base', language: 'auto' },
  fuzzy: true,
  paused: false,                   // tüm kayıtlar
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yieldNow = () => new Promise((r) => setImmediate(r));
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

class Indexer extends EventEmitter {
  constructor({ dataDir, settings = {}, ocr = null, speech = null, log = () => {} }) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = open(path.join(dataDir, 'index.db'));
    this.settings = mergeSettings(DEFAULT_SETTINGS, settings);
    this.ocr = ocr;
    this.speech = speech;
    this.log = log;
    this.records = new Map(); // id → kayıt durumu
    this.running = new Map(); // düğüm id → AbortController
    this.closed = false;
    this.vocab = null;
    this._prepare();
    this._statsTimer = null;
    this._changed = new Map(); // kayıt → Set(klasör)
    this._changedTimer = null;
  }

  _prepare() {
    const d = this.db;
    this.q = {
      byRel: d.prepare('SELECT id, is_dir, size, mtime, state, kind FROM nodes WHERE record = ? AND rel = ?'),
      insert: d.prepare(`INSERT INTO nodes (record, rel, parent, name, is_dir, size, mtime, ext, kind, state, err)
        VALUES (@record, @rel, @parent, @name, @is_dir, @size, @mtime, @ext, @kind, @state, @err)`),
      update: d.prepare('UPDATE nodes SET is_dir = @is_dir, size = @size, mtime = @mtime, state = @state, err = @err, kind = @kind, ext = @ext WHERE id = @id'),
      ftsInsert: d.prepare('INSERT INTO docs_fts (rowid, name, body, stems) VALUES (?, ?, ?, ?)'),
      ftsDelete: d.prepare('DELETE FROM docs_fts WHERE rowid = ?'),
      textPut: d.prepare('INSERT OR REPLACE INTO texts (id, z, len) VALUES (?, ?, ?)'),
      textGet: d.prepare('SELECT z FROM texts WHERE id = ?'),
      textDel: d.prepare('DELETE FROM texts WHERE id = ?'),
      termsDel: d.prepare('DELETE FROM doc_terms WHERE id = ?'),
      termPut: d.prepare('INSERT INTO doc_terms (id, key, term, n) VALUES (?, ?, ?, ?)'),
      nodeDel: d.prepare('DELETE FROM nodes WHERE id = ?'),
      subtree: d.prepare("SELECT id FROM nodes WHERE record = ? AND (rel = ? OR rel LIKE ? ESCAPE '\\')"),
      allOf: d.prepare('SELECT id, rel, is_dir, size, mtime, state, kind FROM nodes WHERE record = ?'),
      setState: d.prepare('UPDATE nodes SET state = ?, err = ? WHERE id = ?'),
      setDoc: d.prepare('UPDATE nodes SET state = ?, lang = ?, words = ?, title = ?, err = NULL, source = ?, indexed_at = ? WHERE id = ?'),
      get: d.prepare('SELECT * FROM nodes WHERE id = ?'),
      stats: d.prepare(`SELECT COALESCE(SUM(CASE WHEN is_dir = 0 THEN size END), 0) AS size,
          COALESCE(SUM(is_dir = 0), 0) AS files, COALESCE(SUM(is_dir = 1 AND rel <> ''), 0) AS dirs,
          COALESCE(SUM(state = ${STATE.indexed}), 0) AS indexed, COALESCE(SUM(state = ${STATE.pending}), 0) AS pending,
          COALESCE(SUM(state = ${STATE.error}), 0) AS errors, COALESCE(SUM(state IN (${STATE.waitOcr}, ${STATE.waitSpeech})), 0) AS waiting
        FROM nodes WHERE record = ?`),
    };
  }

  // --- Kayıtlar ------------------------------------------------------------------------------
  // list: [{ id, name, path, excludes: [], maxFileMB, paused, network }]
  setRecords(list) {
    const seen = new Set();
    for (const r of list || []) {
      if (!r || !r.id) continue;
      seen.add(r.id);
      const cur = this.records.get(r.id);
      const conf = {
        id: r.id, name: String(r.name || ''), root: r.path ? path.resolve(String(r.path)) : '',
        excludes: Array.isArray(r.excludes) ? r.excludes.map(String) : [],
        maxFileMB: Number(r.maxFileMB) > 0 ? Number(r.maxFileMB) : 0,
        paused: !!r.paused, network: !!r.network || isUnc(r.path || ''),
      };
      if (!cur) {
        const rec = { ...conf, state: 'idle', error: null, stats: null, watcher: null, timer: null, scanning: null, rescan: false, gen: 0 };
        rec.isExcluded = compileExcludes(rec.excludes);
        this.records.set(r.id, rec);
        this._refreshStats(rec);
        this._start(rec);
        continue;
      }
      const rootChanged = cur.root !== conf.root;
      const exclChanged = JSON.stringify(cur.excludes) !== JSON.stringify(conf.excludes) || cur.maxFileMB !== conf.maxFileMB;
      const pausedChanged = cur.paused !== conf.paused;
      Object.assign(cur, conf);
      cur.isExcluded = compileExcludes(cur.excludes);
      if (rootChanged) {
        this._stop(cur);
        this._deleteRecordRows(cur.id); // başka klasör: eski dizin geçersiz
        this._refreshStats(cur);
        this._start(cur);
      } else if (exclChanged || pausedChanged) {
        // Boyut sınırı değiştiyse sınırı aşan dosyalar yeniden değerlendirilir (okunurken sınır yeniden denetlenir)
        this.db.prepare(`UPDATE nodes SET state = ${STATE.pending}, err = NULL WHERE record = ? AND err = 'too_large'`).run(cur.id);
        this._stop(cur);
        this._start(cur);
      }
    }
    for (const [id, rec] of this.records) {
      if (seen.has(id)) continue;
      this._stop(rec);
      this.records.delete(id);
      this._deleteRecordRows(id);
    }
    this._emitStats();
  }

  setSettings(patch) {
    const prev = this.settings;
    this.settings = mergeSettings(this.settings, patch || {});
    const s = this.settings;
    // OCR / konuşma açılınca bekleyen resim ve sesler kuyruğa girer; kapanınca kuyruktakiler bekler
    this.db.transaction(() => {
      if (s.ocr.enabled && !prev.ocr.enabled) this.db.prepare(`UPDATE nodes SET state = ${STATE.pending} WHERE state = ${STATE.waitOcr}`).run();
      if (!s.ocr.enabled && prev.ocr.enabled) this.db.prepare(`UPDATE nodes SET state = ${STATE.waitOcr} WHERE state = ${STATE.pending} AND kind = 'image'`).run();
      if (s.speech.enabled && !prev.speech.enabled) this.db.prepare(`UPDATE nodes SET state = ${STATE.pending} WHERE state = ${STATE.waitSpeech}`).run();
      if (!s.speech.enabled && prev.speech.enabled) this.db.prepare(`UPDATE nodes SET state = ${STATE.waitSpeech} WHERE state = ${STATE.pending} AND kind IN ('audio', 'video')`).run();
    })();
    if (prev.maxFileMB !== s.maxFileMB) this.db.prepare(`UPDATE nodes SET state = ${STATE.pending}, err = NULL WHERE err = 'too_large'`).run();
    if (prev.paused !== s.paused || prev.maxFileMB !== s.maxFileMB) {
      for (const rec of this.records.values()) { this._stop(rec); this._start(rec); }
    }
    for (const rec of this.records.values()) this._refreshStats(rec);
    this._emitStats();
    this._pump();
  }

  _active(rec) { return !this.closed && !this.settings.paused && !rec.paused && !!rec.root; }

  _start(rec) {
    rec.gen++;
    if (!rec.root) { rec.state = 'nopath'; this._emitStats(); return; }
    if (!this._active(rec)) { rec.state = 'paused'; this._emitStats(); return; }
    this._scan(rec).catch((e) => this.log('scan', e));
  }

  _stop(rec) {
    rec.gen++;
    if (rec.watcher) { rec.watcher.close(); rec.watcher = null; }
    clearTimeout(rec.timer);
    rec.timer = null;
    for (const ctl of this.running.values()) if (ctl.record === rec.id) ctl.abort();
  }

  // --- Tarama ------------------------------------------------------------------------------------
  async _scan(rec) {
    const gen = rec.gen;
    if (rec.scanning) { rec.rescan = true; return rec.scanning; }
    const run = (async () => {
      try {
        const st = await fs.promises.stat(rec.root).catch(() => null);
        if (gen !== rec.gen) return;
        if (!st || !st.isDirectory()) return this._missing(rec);
        rec.state = 'scanning';
        rec.error = null;
        this._emitStats();
        this._watch(rec);
        await this._diffScan(rec, '', gen);
        if (gen !== rec.gen) return;
        rec.state = 'indexing';
        rec.lastScan = Date.now();
        this._refreshStats(rec);
        this._emitStats();
        this._invalidateVocab();
        if (rec.network) {
          clearTimeout(rec.timer);
          rec.timer = setTimeout(() => { if (gen === rec.gen) this._scan(rec); }, NETWORK_RESCAN_MS);
          if (rec.timer.unref) rec.timer.unref();
        }
        this._pump();
      } finally {
        rec.scanning = null;
        if (rec.rescan && gen === rec.gen) { rec.rescan = false; this._scan(rec); }
      }
    })();
    rec.scanning = run;
    return run;
  }

  _missing(rec) {
    rec.state = 'missing';
    if (rec.watcher) { rec.watcher.close(); rec.watcher = null; }
    this._emitStats();
    const gen = rec.gen;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => { if (gen === rec.gen && this._active(rec)) this._scan(rec); }, RETRY_MISSING_MS);
    if (rec.timer.unref) rec.timer.unref();
  }

  // Diskteki alt ağaç (base altı) ile dizini karşılaştırır. base '' ise tüm kayıt.
  async _diffScan(rec, base, gen) {
    const known = new Map();
    const rows = base
      ? this.db.prepare(`SELECT id, rel, is_dir, size, mtime, state, kind FROM nodes WHERE record = ? AND (rel = ? OR rel LIKE ? ESCAPE '\\')`).all(rec.id, base, `${likeEscape(base)}/%`)
      : this.q.allOf.all(rec.id);
    for (const r of rows) known.set(r.rel, r);
    const seen = new Set();
    let ops = [];
    let lastFlush = Date.now();

    const flush = async (force) => {
      if (!ops.length) return;
      if (!force && ops.length < BATCH && Date.now() - lastFlush < 500) return;
      const list = ops;
      ops = [];
      this.db.transaction(() => { for (const op of list) this._applyEntry(rec, op, known.get(op.rel)); })();
      lastFlush = Date.now();
      this._refreshStats(rec);
      this._emitStats();
      await yieldNow();
    };

    // Kökün kendisi (base '' ise) her zaman bir klasör düğümüdür
    if (!base) { ops.push({ rel: '', isDir: true, size: 0, mtime: 0 }); seen.add(''); }
    else {
      const st = await fs.promises.lstat(this._abs(rec, base)).catch(() => null);
      if (!st) { this._removeRel(rec, base); return; }
      ops.push({ rel: base, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) });
      seen.add(base);
      if (!st.isDirectory()) { await flush(true); return; }
    }

    const stack = [base];
    while (stack.length) {
      if (gen !== rec.gen || this.closed) return;
      const dirRel = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(this._abs(rec, dirRel), { withFileTypes: true });
      } catch {
        // Erişilemeyen alt klasör (izin): içindekiler bilinmiyor, dizindeki halleri korunur
        if (dirRel) for (const k of known.keys()) if (k.startsWith(`${dirRel}/`)) seen.add(k);
        continue;
      }
      const files = [];
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (rec.isExcluded(rel)) continue;
        if (e.isSymbolicLink()) continue; // döngü ve kayıt dışına taşma olmasın
        if (e.isDirectory()) {
          seen.add(rel);
          const old = known.get(rel);
          if (!old || !old.is_dir) ops.push({ rel, isDir: true, size: 0, mtime: 0 });
          stack.push(rel);
        } else if (e.isFile()) files.push(rel);
      }
      for (let i = 0; i < files.length; i += STAT_PARALLEL) {
        const chunk = files.slice(i, i + STAT_PARALLEL);
        const sts = await Promise.all(chunk.map((rel) => fs.promises.stat(this._abs(rec, rel)).catch(() => null)));
        chunk.forEach((rel, k) => {
          const st = sts[k];
          if (!st) return;
          seen.add(rel);
          const mtime = Math.round(st.mtimeMs);
          const old = known.get(rel);
          if (!old || old.is_dir || old.size !== st.size || old.mtime !== mtime) ops.push({ rel, isDir: false, size: st.size, mtime });
        });
        await flush(false);
      }
    }
    await flush(true);
    if (gen !== rec.gen) return;
    // Diskte artık olmayanlar
    const gone = [];
    for (const [rel, r] of known) if (!seen.has(rel)) gone.push(r);
    for (let i = 0; i < gone.length; i += BATCH) {
      this.db.transaction(() => { for (const r of gone.slice(i, i + BATCH)) this._deleteNode(r.id); })();
      await yieldNow();
    }
    if (gone.length) { this._refreshStats(rec); this._emitStats(); }
    if (ops.length || gone.length) this._markChanged(rec, base || '');
  }

  // Tek bir yol için ekleme / güncelleme (işlem içinde çağrılır)
  _applyEntry(rec, e, old) {
    const name = e.rel ? nameOf(e.rel) : (rec.name || path.basename(rec.root) || rec.root);
    const ext = e.isDir ? '' : extOf(name);
    const kind = e.isDir ? 'folder' : kindOf(name);
    const { state, err } = e.isDir ? { state: STATE.skipped, err: null } : this._initialState(rec, kind, ext, e.size);
    if (old) {
      // Değişmeyen dosyanın içerik durumu korunur; yalnız boyut/tarih değiştiyse yeniden okunur
      const changed = !!old.is_dir !== e.isDir || old.size !== e.size || old.mtime !== e.mtime;
      if (!changed) return;
      const row = { id: old.id, is_dir: e.isDir ? 1 : 0, size: e.size, mtime: e.mtime, state, err, kind, ext };
      this.q.update.run(row);
      if (!old.is_dir) {
        this.q.textDel.run(old.id);
        this.q.termsDel.run(old.id);
        this._writeFts(old.id, name, '', '');
        const ctl = this.running.get(old.id);
        if (ctl) ctl.abort();
      }
      old.size = e.size; old.mtime = e.mtime; old.is_dir = e.isDir ? 1 : 0;
      return;
    }
    const info = this.q.insert.run({
      record: rec.id, rel: e.rel, parent: e.rel ? parentOf(e.rel) : '', name, is_dir: e.isDir ? 1 : 0,
      size: e.size, mtime: e.mtime, ext, kind, state, err,
    });
    this._writeFts(Number(info.lastInsertRowid), e.rel ? name : '', '', '');
  }

  _initialState(rec, kind, ext, size) {
    const s = this.settings;
    const limit = (rec.maxFileMB || s.maxFileMB || 50) * 1024 * 1024;
    if (canExtract(`x.${ext}`)) return size > limit ? { state: STATE.skipped, err: 'too_large' } : { state: STATE.pending, err: null };
    if (kind === 'image' && OCR_EXTS.includes(ext)) {
      if (size > limit) return { state: STATE.skipped, err: 'too_large' };
      return s.ocr.enabled ? { state: STATE.pending, err: null } : { state: STATE.waitOcr, err: null };
    }
    if (SPEECH_KINDS.includes(kind)) return s.speech.enabled ? { state: STATE.pending, err: null } : { state: STATE.waitSpeech, err: null };
    return { state: STATE.skipped, err: null };
  }

  _writeFts(id, name, body, stems) {
    this.q.ftsDelete.run(id);
    const n = name ? T.nameForms(name) : { name: '', stems: '' };
    this.q.ftsInsert.run(id, n.name, body, stems ? `${n.stems} ${stems}` : n.stems);
  }

  _deleteNode(id) {
    const ctl = this.running.get(id);
    if (ctl) ctl.abort();
    this.q.ftsDelete.run(id);
    this.q.textDel.run(id);
    this.q.termsDel.run(id);
    this.q.nodeDel.run(id);
  }

  _removeRel(rec, rel) {
    const ids = this.q.subtree.all(rec.id, rel, `${likeEscape(rel)}/%`).map((r) => r.id);
    if (!ids.length) return 0;
    this.db.transaction(() => { for (const id of ids) this._deleteNode(id); })();
    return ids.length;
  }

  _deleteRecordRows(recordId) {
    const ids = this.db.prepare('SELECT id FROM nodes WHERE record = ?').all(recordId).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 2000) {
      this.db.transaction(() => { for (const id of ids.slice(i, i + 2000)) this._deleteNode(id); })();
    }
    this._invalidateVocab();
  }

  _abs(rec, rel) { return rel ? path.join(rec.root, ...rel.split('/')) : rec.root; }

  // Eksik üst klasörleri ekle (izlemede derin bir yol önce gelirse)
  _ensureParents(rec, rel) {
    let p = parentOf(rel);
    const missing = [];
    while (p && !this.q.byRel.get(rec.id, p)) { missing.push(p); p = parentOf(p); }
    for (const m of missing.reverse()) this._applyEntry(rec, { rel: m, isDir: true, size: 0, mtime: 0 }, null);
  }

  // --- İzleme --------------------------------------------------------------------------------------
  _watch(rec) {
    if (rec.watcher) return;
    const gen = rec.gen;
    rec.watcher = createWatcher(rec.root, {
      filter: (rel) => !rec.isExcluded(rel),
      onChanges: (rels) => { if (gen === rec.gen) this._onChanges(rec, rels).catch((e) => this.log('watch', e)); },
      onError: () => {
        rec.watcher = null;
        if (gen !== rec.gen) return;
        // Kök gitti ya da ağ koptu: erişilebilir olunca fark taramasıyla devam edilir
        this._scan(rec);
      },
    });
  }

  async _onChanges(rec, rels) {
    const gen = rec.gen;
    // Kökün kendisi bildirildiyse (ya da çok sayıda değişiklik) tam fark taraması daha ucuz
    if (rels.includes('') || rels.length > 2000) return this._scan(rec);
    // Üst klasörü de değişenler listesinde olanları ele (alt ağaç zaten taranacak)
    const set = new Set(rels);
    const roots = rels.filter((r) => { let p = parentOf(r); while (p) { if (set.has(p)) return false; p = parentOf(p); } return true; });
    for (const rel of roots) {
      if (gen !== rec.gen) return;
      const st = await fs.promises.lstat(this._abs(rec, rel)).catch(() => null);
      if (!st || st.isSymbolicLink()) {
        if (this._removeRel(rec, rel)) this._markChanged(rec, parentOf(rel));
        continue;
      }
      if (st.isDirectory()) {
        this.db.transaction(() => this._ensureParents(rec, rel))();
        await this._diffScan(rec, rel, gen);
        this._markChanged(rec, parentOf(rel));
      } else if (st.isFile()) {
        const old = this.q.byRel.get(rec.id, rel);
        const mtime = Math.round(st.mtimeMs);
        if (old && !old.is_dir && old.size === st.size && old.mtime === mtime) continue;
        this.db.transaction(() => {
          this._ensureParents(rec, rel);
          if (old && old.is_dir) this._removeRel(rec, rel);
          this._applyEntry(rec, { rel, isDir: false, size: st.size, mtime }, old && !old.is_dir ? old : null);
        })();
        this._markChanged(rec, parentOf(rel));
      }
    }
    this._invalidateVocab();
    this._refreshStats(rec);
    if (rec.state === 'watching') rec.state = 'indexing';
    this._emitStats();
    this._pump();
  }

  // --- İçerik kuyruğu ----------------------------------------------------------------------------
  _activeIds() { return [...this.records.values()].filter((r) => this._active(r) && !['missing', 'nopath'].includes(r.state)).map((r) => r.id); }

  _pump() {
    if (this.closed || this._pumping) return;
    this._pumping = true;
    try {
      const ids = this._activeIds();
      if (!ids.length) return;
      const ph = ids.map(() => '?').join(',');
      const busy = [...this.running.keys()];
      const notIn = busy.length ? `AND id NOT IN (${busy.join(',')})` : '';
      const fastRunning = [...this.running.values()].filter((c) => !c.slow).length;
      const slowRunning = [...this.running.values()].filter((c) => c.slow).length;
      const fastFree = Math.max(0, this.settings.concurrency - fastRunning);
      if (fastFree) {
        const rows = this.db.prepare(`SELECT id, record, rel, kind, ext, size FROM nodes WHERE state = ${STATE.pending} AND record IN (${ph})
          AND kind NOT IN ('image', 'audio', 'video') ${notIn} LIMIT ?`).all(...ids, fastFree);
        for (const r of rows) this._run(r, false);
      }
      // OCR ve konuşma: işlemciyi yoğun kullanır, tek tek; motor/veri hazır değilse beklenir
      const slowKinds = [];
      if (this.settings.ocr.enabled && this.ocr && this.ocr.ready(this.settings.ocr.languages)) slowKinds.push("'image'");
      if (this.settings.speech.enabled && this.speech && this.speech.ready(this.settings.speech.model)) slowKinds.push("'audio'", "'video'");
      if (slowKinds.length && !slowRunning) {
        const rows = this.db.prepare(`SELECT id, record, rel, kind, ext, size FROM nodes WHERE state = ${STATE.pending} AND record IN (${ph})
          AND kind IN (${slowKinds.join(',')}) ${notIn} LIMIT 1`).all(...ids);
        for (const r of rows) this._run(r, true);
      }
      this._updateIdle();
    } finally {
      this._pumping = false;
    }
  }

  _updateIdle() {
    let changed = false;
    for (const rec of this.records.values()) {
      if (rec.state !== 'indexing') continue;
      const busy = [...this.running.values()].some((c) => c.record === rec.id);
      if (busy) continue;
      this._refreshStats(rec, true);
      const s = rec.stats;
      const slowReady = (this.settings.ocr.enabled && this.ocr && this.ocr.ready(this.settings.ocr.languages))
        || (this.settings.speech.enabled && this.speech && this.speech.ready(this.settings.speech.model));
      const pendingFast = this.db.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE record = ? AND state = ${STATE.pending} AND kind NOT IN ('image', 'audio', 'video')`).get(rec.id).n;
      if (!pendingFast && (!s.pending || !slowReady)) { rec.state = 'watching'; changed = true; }
    }
    if (changed) this._emitStats();
  }

  _run(row, slow) {
    const rec = this.records.get(row.record);
    if (!rec) return;
    const limit = (rec.maxFileMB || this.settings.maxFileMB || 50) * 1024 * 1024;
    if (row.kind !== 'audio' && row.kind !== 'video' && row.size > limit) {
      this.q.setState.run(STATE.skipped, 'too_large', row.id);
      return;
    }
    const ctl = new AbortController();
    ctl.slow = slow;
    ctl.record = rec.id;
    this.running.set(row.id, ctl);
    const abs = this._abs(rec, row.rel);
    this._extract(rec, row, abs, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted || this.closed) return;
        this._storeDoc(row.id, r);
      })
      .catch((e) => {
        if (ctl.signal.aborted || this.closed) return;
        const code = (e && e.code) || 'error';
        // Motor yoksa (veri silindi) dosya beklemeye döner
        if (code === 'engine_missing') this.q.setState.run(row.kind === 'image' ? STATE.waitOcr : STATE.waitSpeech, null, row.id);
        else if (code === 'ENOENT') { /* bu arada silindi; izleme kaldıracak */ }
        else this.q.setState.run(STATE.error, String(code === 'error' ? (e && e.message) || code : code).slice(0, 200), row.id);
      })
      .finally(() => {
        this.running.delete(row.id);
        if (this.closed) return;
        this._refreshStats(rec);
        this._emitStats();
        setImmediate(() => this._pump());
      });
  }

  async _extract(rec, row, abs, signal) {
    if (row.kind === 'image') {
      const r = await this.ocr.recognize(abs, { langs: this.settings.ocr.languages, signal });
      const lang = r.languages.length === 1 ? OCR_ISO[r.languages[0]] : '';
      return { text: r.text, source: 'ocr', lang: ['tr', 'en'].includes(lang) ? lang : null };
    }
    if (row.kind === 'audio' || row.kind === 'video') {
      const r = await this.speech.transcribe(abs, {
        model: this.settings.speech.model, language: this.settings.speech.language, workDir: path.join(this.dataDir, 'work'), signal,
      });
      return { text: r.text, source: 'speech', lang: ['tr', 'en'].includes(r.language) ? r.language : null };
    }
    const r = await extractFile(abs, row.rel);
    return { text: r.text, title: r.title, cloudText: r.cloudText, source: 'text' };
  }

  _storeDoc(id, { text, title, source, cloudText, lang: forcedLang }) {
    const node = this.q.get.get(id);
    if (!node) return;
    const body = String(text || '');
    const lang = forcedLang || T.detectLanguage(body) || null;
    // Belge başlığı (PDF/Office özelliği, HTML <title>, e-posta konusu) da aranır
    const forms = T.indexForms(title && !body.startsWith(title) ? `${title}\n${body}` : body, lang || '');
    const terms = T.topTerms(cloudText || body, lang || '', 40);
    const z = zlib.deflateRawSync(Buffer.from(body, 'utf8'), { level: 6 });
    this.db.transaction(() => {
      this._writeFts(id, node.rel ? node.name : '', forms.body, forms.stems);
      this.q.textPut.run(id, z, body.length);
      this.q.termsDel.run(id);
      for (const t of terms) this.q.termPut.run(id, t.key, t.term, t.n);
      this.q.setDoc.run(body.trim() ? STATE.indexed : STATE.empty, lang, forms.count, title ? String(title).slice(0, 300) : null, source, Date.now(), id);
    })();
    this._invalidateVocab();
    this._markChanged({ id: node.record }, node.parent);
  }

  // --- Durum ve olaylar ----------------------------------------------------------------------------
  // Kayıt özeti (toplam boyut, dosya/klasör sayısı, dizin durumu). Sık değişir: kirli işaretlenir,
  // yayınlanırken (en çok 400 ms'de bir) yeniden hesaplanır.
  _refreshStats(rec, now = false) {
    if (now || !rec.stats) { rec.stats = this.q.stats.get(rec.id); rec.dirty = false; } else rec.dirty = true;
  }

  stats() {
    const out = {};
    for (const rec of this.records.values()) {
      if (!rec.stats || rec.dirty) this._refreshStats(rec, true);
      const running = [...this.running.values()].filter((c) => c.record === rec.id).length;
      out[rec.id] = { ...rec.stats, state: rec.state, running, network: rec.network, lastScan: rec.lastScan || null };
    }
    return out;
  }

  _emitStats() {
    if (this._statsTimer || this.closed) return;
    this._statsTimer = setTimeout(() => {
      this._statsTimer = null;
      if (!this.closed) this.emit('stats', this.stats());
    }, STATS_THROTTLE_MS);
  }

  _markChanged(rec, dirRel) {
    let s = this._changed.get(rec.id);
    if (!s) this._changed.set(rec.id, (s = new Set()));
    s.add(dirRel || '');
    if (this._changedTimer || this.closed) return;
    this._changedTimer = setTimeout(() => {
      this._changedTimer = null;
      const out = {};
      for (const [id, set] of this._changed) out[id] = [...set];
      this._changed.clear();
      if (!this.closed) this.emit('changed', out);
    }, 500);
  }

  _invalidateVocab() { if (this.vocab) this.vocab.stale = true; }

  _vocab() {
    const now = Date.now();
    if (!this.vocab || (this.vocab.stale && now - this.vocab.at > VOCAB_TTL_MS)) {
      this.vocab = { list: this.db.prepare('SELECT term, doc FROM vocab WHERE length(term) BETWEEN 3 AND 30').all(), at: now, stale: false };
    }
    return this.vocab.list;
  }

  // --- Sorgular -----------------------------------------------------------------------------------
  // opts: { q, records: [id], kinds: [tür], from, to (ms), minSize, maxSize, limit, offset, sort: 'relevance'|'date'|'size'|'name' }
  search(opts = {}) {
    const t0 = Date.now();
    const parsed = Q.parse(opts.q);
    const empty = { total: 0, results: [], fuzzy: {}, tookMs: 0, query: parsed };
    let expr = Q.build(parsed);
    if (!expr) return empty;
    const { where, params } = this._filters(opts);
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 50));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const order = { date: 'n.mtime DESC', size: 'n.size DESC', name: 'n.name COLLATE NOCASE' }[opts.sort] || 'score';
    const run = (e) => {
      const total = this.db.prepare(`SELECT COUNT(*) AS c FROM docs_fts JOIN nodes n ON n.id = docs_fts.rowid WHERE docs_fts MATCH ? ${where}`).get(e, ...params).c;
      const rows = total ? this.db.prepare(`SELECT n.*, bm25(docs_fts, 8.0, 1.0, 0.7) AS score FROM docs_fts JOIN nodes n ON n.id = docs_fts.rowid
        WHERE docs_fts MATCH ? ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(e, ...params, limit, offset) : [];
      return { total, rows };
    };
    let res;
    try { res = run(expr); } catch (e) { this.log('search', e); return { ...empty, error: 'bad_query' }; }
    // Yazım hatasına dayanıklılık: sonuç yoksa (ya da bir kelime sözlükte yoksa) yakın yazımları ekle
    const fuzzy = {};
    if (this.settings.fuzzy !== false && (res.total === 0 || opts.fuzzy === true)) {
      const vocab = this._vocab();
      const has = (f) => this.db.prepare('SELECT 1 FROM vocab WHERE term = ?').get(f);
      for (const w of parsed.terms) {
        const f = T.fold(w);
        if (f.length < 4 || has(f)) continue;
        const c = Q.fuzzyCandidates(w, vocab);
        if (c.length) fuzzy[f] = c;
      }
      if (Object.keys(fuzzy).length) {
        expr = Q.build(parsed, fuzzy);
        try { res = run(expr); } catch (e) { this.log('search', e); }
      }
    }
    const isMatch = Q.matcher(parsed, fuzzy);
    const results = res.rows.map((n) => this._result(n, isMatch));
    return { total: res.total, results, fuzzy, tookMs: Date.now() - t0, query: parsed };
  }

  _filters(opts) {
    const w = [];
    const p = [];
    const active = [...this.records.keys()];
    const recs = (opts.records && opts.records.length ? opts.records.filter((x) => this.records.has(x)) : active);
    w.push(`n.record IN (${recs.map(() => '?').join(',') || "''"})`);
    p.push(...recs);
    if (opts.kinds && opts.kinds.length) {
      w.push(`n.kind IN (${opts.kinds.map(() => '?').join(',')})`);
      p.push(...opts.kinds);
    }
    if (opts.from) { w.push('n.mtime >= ?'); p.push(Number(opts.from)); }
    if (opts.to) { w.push('n.mtime <= ?'); p.push(Number(opts.to)); }
    if (opts.minSize) { w.push('n.size >= ?'); p.push(Number(opts.minSize)); }
    if (opts.maxSize) { w.push('n.size <= ?'); p.push(Number(opts.maxSize)); }
    if (opts.filesOnly !== false) w.push("n.rel <> ''");
    return { where: w.length ? `AND ${w.join(' AND ')}` : '', params: p };
  }

  _text(id, max = PREVIEW_CHARS) {
    const r = this.q.textGet.get(id);
    if (!r) return '';
    try {
      const s = zlib.inflateRawSync(r.z).toString('utf8');
      return s.length > max ? s.slice(0, max) : s;
    } catch { return ''; }
  }

  _result(n, isMatch) {
    const rec = this.records.get(n.record);
    const text = n.is_dir ? '' : this._text(n.id, 400000);
    const sn = text ? Q.snippet(text, isMatch) : { parts: [], hits: 0 };
    const nm = Q.snippet(n.name, isMatch, { len: 400 });
    return {
      id: n.id, record: n.record, recordName: rec ? rec.name : '', rel: n.rel, name: n.name, nameParts: nm.parts,
      isDir: !!n.is_dir, size: n.size, mtime: n.mtime, kind: n.kind, ext: n.ext, state: n.state, source: n.source,
      title: n.title, lang: n.lang, snippet: sn.parts, hits: sn.hits, score: n.score,
      path: rec ? this._abs(rec, n.rel) : n.rel,
    };
  }

  // Bir klasörün içeriği: klasörler önce; klasör boyutu alt ağaç toplamıdır
  children(recordId, rel = '', { dirsOnly = false } = {}) {
    const rec = this.records.get(recordId);
    if (!rec) return [];
    const rows = this.db.prepare(`SELECT id, rel, name, is_dir, size, mtime, kind, ext, state, err, source, words, lang FROM nodes
      WHERE record = ? AND parent = ? AND rel <> '' ${dirsOnly ? 'AND is_dir = 1' : ''}`).all(recordId, rel);
    const sum = this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS size, COUNT(*) AS files FROM nodes WHERE record = ? AND is_dir = 0 AND rel > ? AND rel < ?`);
    const sub = this.db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE record = ? AND parent = ? AND is_dir = 1`);
    for (const r of rows) {
      if (r.is_dir) {
        const s = sum.get(recordId, `${r.rel}/`, `${r.rel}0`);
        r.size = s.size;
        r.files = s.files;
        r.hasDirs = sub.get(recordId, r.rel).c > 0;
      }
    }
    rows.sort((a, b) => b.is_dir - a.is_dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return rows;
  }

  // Kayıt kökünün özeti (ağacın en üst düğümü)
  rootInfo(recordId) {
    const rec = this.records.get(recordId);
    if (!rec) return null;
    this._refreshStats(rec, true);
    const sub = this.db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE record = ? AND parent = '' AND rel <> '' AND is_dir = 1`).get(recordId).c;
    return { rel: '', name: rec.name || path.basename(rec.root), path: rec.root, size: rec.stats.size, files: rec.stats.files, hasDirs: sub > 0, is_dir: 1 };
  }

  // Belge ayrıntısı: düğüm, mutlak yol, metin (önizleme) ve kelime bulutu
  doc(id) {
    const n = this.q.get.get(Number(id));
    if (!n) return null;
    const rec = this.records.get(n.record);
    if (!rec) return null;
    const terms = this.db.prepare('SELECT term, n FROM doc_terms WHERE id = ? ORDER BY n DESC').all(n.id);
    if (n.is_dir) {
      const s = n.rel
        ? this.db.prepare('SELECT COALESCE(SUM(size), 0) AS size, COUNT(*) AS files FROM nodes WHERE record = ? AND is_dir = 0 AND rel > ? AND rel < ?').get(rec.id, `${n.rel}/`, `${n.rel}0`)
        : this.db.prepare('SELECT COALESCE(SUM(size), 0) AS size, COUNT(*) AS files FROM nodes WHERE record = ? AND is_dir = 0').get(rec.id);
      n.size = s.size;
      n.files = s.files;
    }
    return {
      node: n, record: rec.id, recordName: rec.name, path: this._abs(rec, n.rel),
      text: n.is_dir ? '' : this._text(n.id), textLength: (this.db.prepare('SELECT len FROM texts WHERE id = ?').get(n.id) || {}).len || 0,
      terms,
    };
  }

  // Son değişen dosyalar (ana ekran): tüm kayıtlarda değiştirilme tarihine göre
  recent({ limit = 12 } = {}) {
    const recs = [...this.records.keys()];
    if (!recs.length) return [];
    const rows = this.db.prepare(`SELECT id, record, rel, name, size, mtime, kind, ext, state, source FROM nodes
      WHERE record IN (${recs.map(() => '?').join(',')}) AND is_dir = 0 ORDER BY mtime DESC LIMIT ?`).all(...recs, Math.min(100, Number(limit) || 12));
    return rows.map((r) => ({ ...r, recordName: (this.records.get(r.record) || {}).name || '' }));
  }

  // Göreli yoldan düğüm (kayıt penceresinde)
  nodeAt(recordId, rel) {
    const n = this.db.prepare('SELECT id FROM nodes WHERE record = ? AND rel = ?').get(recordId, rel);
    return n ? this.doc(n.id) : null;
  }

  // Kelime bulutu: kapsam tüm kayıtlar, seçili kayıtlar ya da belge kimlikleri (arama sonuçları)
  cloud({ records, ids, limit = 150 } = {}) {
    limit = Math.min(400, Math.max(10, Number(limit) || 150));
    let where;
    let params;
    if (ids && ids.length) {
      const list = ids.slice(0, 2000).map(Number).filter(Number.isFinite);
      if (!list.length) return [];
      where = `dt.id IN (${list.join(',')})`;
      params = [];
    } else {
      const recs = records && records.length ? records.filter((x) => this.records.has(x)) : [...this.records.keys()];
      if (!recs.length) return [];
      where = `n.record IN (${recs.map(() => '?').join(',')})`;
      params = recs;
    }
    const keys = this.db.prepare(`SELECT dt.key AS key, SUM(dt.n) AS n, COUNT(DISTINCT dt.id) AS docs FROM doc_terms dt JOIN nodes n ON n.id = dt.id
      WHERE ${where} GROUP BY dt.key ORDER BY n DESC LIMIT ?`).all(...params, limit);
    if (!keys.length) return [];
    const forms = this.db.prepare(`SELECT dt.key AS key, dt.term AS term, SUM(dt.n) AS n FROM doc_terms dt JOIN nodes n ON n.id = dt.id
      WHERE ${where} AND dt.key IN (${keys.map(() => '?').join(',')}) GROUP BY dt.key, dt.term`).all(...params, ...keys.map((k) => k.key));
    const best = new Map();
    for (const f of forms) { const b = best.get(f.key); if (!b || f.n > b.n) best.set(f.key, f); }
    return keys.map((k) => ({ term: (best.get(k.key) || { term: k.key }).term, key: k.key, n: k.n, docs: k.docs }));
  }

  // Elle yeniden tarama (kayıt ya da hepsi)
  rescan(recordId) {
    for (const rec of this.records.values()) {
      if (recordId && rec.id !== recordId) continue;
      this._stop(rec);
      this._start(rec);
    }
  }

  // Hatalı dosyaları yeniden dene
  retryErrors(recordId) {
    this.db.prepare(`UPDATE nodes SET state = ${STATE.pending}, err = NULL WHERE state = ${STATE.error} ${recordId ? 'AND record = ?' : ''}`).run(...(recordId ? [recordId] : []));
    this._pump();
  }

  storage() {
    let size = 0;
    for (const f of ['index.db', 'index.db-wal', 'index.db-shm']) { try { size += fs.statSync(path.join(this.dataDir, f)).size; } catch { /* yok */ } }
    return { index: size };
  }

  // Dizini sıfırla ve tüm kayıtları baştan tara
  clear() {
    for (const rec of this.records.values()) this._stop(rec);
    this.db.exec("DELETE FROM docs_fts; DELETE FROM texts; DELETE FROM doc_terms; DELETE FROM nodes; INSERT INTO docs_fts(docs_fts) VALUES('optimize');");
    this.db.exec('VACUUM');
    this._invalidateVocab();
    for (const rec of this.records.values()) { this._refreshStats(rec); this._start(rec); }
    this._emitStats();
  }

  // Tüm kuyruk ve taramalar boşalana dek bekle (testler)
  async idle(timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const busy = [...this.records.values()].some((r) => r.scanning || r.state === 'scanning') || this.running.size > 0;
      if (!busy) {
        this._pump();
        await sleep(30);
        const again = [...this.records.values()].some((r) => r.scanning) || this.running.size > 0;
        if (!again) return;
      }
      if (Date.now() > end) throw new Error('idle timeout');
      await sleep(25);
    }
  }

  async close() {
    this.closed = true;
    for (const rec of this.records.values()) this._stop(rec);
    clearTimeout(this._statsTimer);
    clearTimeout(this._changedTimer);
    for (const ctl of this.running.values()) ctl.abort();
    // Süren çıkarma işlerinin bitmesini kısa süre bekle (yazma yapmazlar; kapalı bayrağına bakarlar)
    const end = Date.now() + 2000;
    while (this.running.size && Date.now() < end) await sleep(20);
    if (this.ocr && this.ocr.close) await this.ocr.close().catch(() => {});
    try { this.db.close(); } catch { /* kapalı */ }
  }
}

function mergeSettings(base, patch) {
  return {
    ...base, ...patch,
    ocr: { ...base.ocr, ...(patch.ocr || {}) },
    speech: { ...base.speech, ...(patch.speech || {}) },
    concurrency: Math.min(8, Math.max(1, Number(patch.concurrency ?? base.concurrency) || 2)),
  };
}

module.exports = { Indexer, STATE, DEFAULT_SETTINGS };
