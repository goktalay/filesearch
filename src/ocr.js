'use strict';

// Resimlerde metin okuma (OCR): tesseract.js 7 (Tesseract 5, WebAssembly) bu bilgisayarda, çevrimdışı.
// Convert Master'daki modülün uyarlaması. Yalnız Ayarlar › Arama › "Resimlerde metin oku (OCR)" açıkken
// kullanılır; dil verileri (her dil ~2–15 MB) ilk açılışta ana süreç tarafından indirilir (ensureLanguage),
// dizinleyici süreci yalnız yüklü dillerle tanıma yapar (recognize).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { OCR_LANGS } = require('./formats');

const LANG_URL = (lang) => `${process.env.FSR_OCR_LANG_BASE || 'https://cdn.jsdelivr.net/npm/@tesseract.js-data'}/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
const IDLE_MS = 60 * 1000;

class OcrError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Paketlenmiş uygulamada tesseract.js'in çalışan (worker) betiği app.asar.unpacked altındadır
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function createOcr({ dataDir, download }) {
  const dir = path.join(dataDir, 'ocr');
  const file = (lang) => path.join(dir, `${lang}.traineddata`);
  const installed = (lang) => fs.existsSync(file(lang));

  function status() {
    const langs = {};
    for (const l of OCR_LANGS) {
      let size = 0;
      try { size = fs.statSync(file(l)).size; } catch { /* yok */ }
      langs[l] = { installed: size > 0, size };
    }
    return { langs, dir };
  }

  // Dil verisini indirir (.gz) ve açar. Yerel klasör de verilebilir (testler: FSR_OCR_LANG_BASE=node_modules/@tesseract.js-data)
  async function ensureLanguage(lang, { onProgress, signal } = {}) {
    if (!OCR_LANGS.includes(lang)) throw new OcrError('bad_lang', lang);
    if (installed(lang)) return;
    await fs.promises.mkdir(dir, { recursive: true });
    const gz = `${file(lang)}.gz`;
    const url = LANG_URL(lang);
    if (/^https?:/i.test(url)) await download(url, gz, { onProgress, signal });
    else await fs.promises.copyFile(url, gz);
    const data = zlib.gunzipSync(await fs.promises.readFile(gz));
    await fs.promises.writeFile(`${file(lang)}.part`, data);
    await fs.promises.rename(`${file(lang)}.part`, file(lang));
    await fs.promises.rm(gz, { force: true });
  }

  async function deleteLanguage(lang) {
    if (!OCR_LANGS.includes(lang)) return;
    await fs.promises.rm(file(lang), { force: true });
    await fs.promises.rm(`${file(lang)}.gz`, { force: true });
    await fs.promises.rm(`${file(lang)}.gz.part`, { force: true });
  }

  // Aynı dil kümesi için çalışan yeniden kullanılır; boşta kalınca kapatılır
  let current = null; // { key, worker, timer }
  async function workerFor(langs) {
    const key = langs.join('+');
    if (current && current.key === key) { clearTimeout(current.timer); return current; }
    if (current) { clearTimeout(current.timer); current.worker.terminate().catch(() => {}); current = null; }
    const T = require('tesseract.js');
    const workerPath = unpacked(path.join(path.dirname(require.resolve('tesseract.js')), 'worker-script', 'node', 'index.js'));
    const entry = { key };
    entry.worker = await T.createWorker(langs, 1 /* LSTM */, {
      workerPath, langPath: dir, cachePath: dir, cacheMethod: 'readOnly', gzip: false, errorHandler: () => {},
    });
    current = entry;
    return entry;
  }

  function release() {
    if (!current) return;
    clearTimeout(current.timer);
    const c = current;
    current.timer = setTimeout(() => { if (current === c) { current = null; c.worker.terminate().catch(() => {}); } }, IDLE_MS);
    if (current.timer.unref) current.timer.unref();
  }

  // Yalnız yüklü dillerle tanır; hiçbiri yüklü değilse 'engine_missing'
  async function recognize(src, { langs = ['tur', 'eng'] } = {}) {
    const list = [...new Set(langs.filter((l) => OCR_LANGS.includes(l) && installed(l)))];
    if (!list.length) throw new OcrError('engine_missing', 'OCR dil verisi yok');
    const buf = await fs.promises.readFile(src);
    const w = await workerFor(list);
    try {
      const { data } = await w.worker.recognize(buf);
      const text = String(data.text || '').replace(/[ \t]+\n/g, '\n').trim();
      return { text, languages: list, confidence: Math.round(data.confidence || 0) };
    } finally {
      if (current === w) release();
    }
  }

  const ready = (langs) => (langs || []).some((l) => installed(l));

  async function close() {
    if (current) { clearTimeout(current.timer); await current.worker.terminate().catch(() => {}); current = null; }
  }

  return { status, ensureLanguage, deleteLanguage, recognize, installed, ready, close, dir };
}

module.exports = { createOcr, OcrError };
