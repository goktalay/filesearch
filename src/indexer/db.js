'use strict';

// Yerel dizin: SQLite (better-sqlite3), WAL kipi. Tek dosya: <veri klasörü>/index.db
//
// nodes      kayıtların tüm dosya ve klasörleri (göreli yol, boyut, tarih, tür, dizin durumu)
// docs_fts   FTS5 (içeriksiz): ad, katlanmış içerik ve kökler; rowid = nodes.id
// texts      çıkarılmış metin (deflate), önizleme ve vurgulu parça için
// doc_terms  belge başına en sık kelimeler (kelime bulutu)
// vocab      FTS5 sözlüğü (yazım hatasına dayanıklı arama için)

const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

// Dizin durumu
const STATE = {
  pending: 0,     // içerik bekliyor
  indexed: 1,     // içerik dizinlendi
  skipped: 2,     // içerik okunmaz (tür, boyut sınırı) — adla bulunur
  error: 3,       // okunamadı (bozuk, parola korumalı, erişim)
  waitOcr: 4,     // resim: OCR kapalı
  waitSpeech: 5,  // ses/video: konuşmadan metne kapalı
  empty: 6,       // okundu, metin yok
};

function open(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000');
  db.pragma('foreign_keys = OFF');
  const v = db.pragma('user_version', { simple: true });
  if (v !== SCHEMA_VERSION) {
    // Dizin yeniden oluşturulabilir veridir: şema değişince baştan kurulur
    db.exec(`DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS docs_fts; DROP TABLE IF EXISTS vocab;
      DROP TABLE IF EXISTS texts; DROP TABLE IF EXISTS doc_terms; DROP TABLE IF EXISTS meta;`);
    db.exec(`
      CREATE TABLE nodes (
        id INTEGER PRIMARY KEY,
        record TEXT NOT NULL,
        rel TEXT NOT NULL,          -- kayıt köküne göre, "/" ayırıcılı; kök ""
        parent TEXT NOT NULL,
        name TEXT NOT NULL,
        is_dir INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        ext TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'other',
        state INTEGER NOT NULL DEFAULT 0,
        lang TEXT,
        words INTEGER,
        title TEXT,
        err TEXT,
        source TEXT,                -- metnin kaynağı: text | ocr | speech
        indexed_at INTEGER,
        UNIQUE(record, rel)
      );
      CREATE INDEX nodes_parent ON nodes(record, parent);
      CREATE INDEX nodes_state ON nodes(record, state);
      CREATE INDEX nodes_kind ON nodes(kind);
      CREATE VIRTUAL TABLE docs_fts USING fts5(
        name, body, stems,
        content='', contentless_delete=1,
        tokenize="unicode61 remove_diacritics 2 tokenchars '_'"
      );
      CREATE VIRTUAL TABLE vocab USING fts5vocab(docs_fts, 'row');
      CREATE TABLE texts (id INTEGER PRIMARY KEY, z BLOB NOT NULL, len INTEGER NOT NULL);
      CREATE TABLE doc_terms (id INTEGER NOT NULL, key TEXT NOT NULL, term TEXT NOT NULL, n INTEGER NOT NULL);
      CREATE INDEX doc_terms_id ON doc_terms(id);
      CREATE INDEX doc_terms_key ON doc_terms(key);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

module.exports = { open, STATE, SCHEMA_VERSION };
