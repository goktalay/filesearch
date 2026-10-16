// 1600×1000 tanıtım görüntüleri (gece + gündüz) ve manifest.json: Türkçe set docs/screenshots/,
// İngilizce set docs/screenshots/en/ (aynı dosya adları).
//
// Arayüz gerçek dosyalardan (src/renderer) yüklenir. window.api, preload.js ile aynı yüzeyde taklit edilir ama
// arkasında GERÇEK dizinleyici çalışır: scripts/sample-data.js'in ürettiği kurgusal belgeler bu betikte dizinlenir
// (PDF/Word/Excel/PowerPoint/RTF/e-posta, resimlerde gerçek Tesseract OCR). Gerçek hesap, sunucu ya da kişisel veri
// kullanılmaz. Yollar Windows biçiminde gösterilir (C:\Users\Ornek\Documents\…). Ağ sürücüsündeki dördüncü kayıt
// yalnız görseldir (dizinleme sürüyor görünümü için örnek sayılar).
//
// Kullanım: npm run screenshots   (Chromium: CHROMIUM_PATH ya da Playwright'ın varsayılanı; playwright-core gerekir)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const I18N = require('../src/i18n');
const { Indexer } = require('../src/indexer/engine');
const { createOcr } = require('../src/ocr');
const { generate } = require('./sample-data');

const ROOT = path.join(__dirname, '..');
const OUT_BASE = path.join(ROOT, 'docs', 'screenshots');
const W = 1600;
const H = 1000;
const GB = 1024 ** 3;

const SAMPLE = {
  tr: { email: 'ornek@example.com', name: 'Örnek Kullanıcı', docs: 'C:\\Users\\Ornek\\Documents', locale: 'tr-TR',
    records: [['Proje Arşivi', '#22d3ee'], ['Teknik Dokümanlar', '#a855f7'], ['Muhasebe', '#34d399']],
    net: { name: 'Ortak Arşiv', path: '\\\\dosya-sunucusu\\arsiv', color: '#fb923c' },
    queries: { main: 'yangın algılama', fuzzy: 'teklf bütçe', record: 'gece vardiyası', ocr: 'acil çıkış' } },
  en: { email: 'sample@example.com', name: 'Sample User', docs: 'C:\\Users\\Sample\\Documents', locale: 'en-US',
    records: [['Project Archive', '#22d3ee'], ['Technical Docs', '#a855f7'], ['Accounting', '#34d399']],
    net: { name: 'Shared Archive', path: '\\\\file-server\\archive', color: '#fb923c' },
    queries: { main: 'fire detection', fuzzy: 'propsal budget', record: 'night shift', ocr: 'emergency exit' } },
};

// Başlık ve açıklamalar (≤ 80 karakter)
const TEXT = {
  tr: {
    home: ['Kayıtlar', 'Her kayıtta canlı toplam boyut, dosya ve klasör sayısı, izleme durumu'],
    newRec: ['Yeni kayıt', 'Önce klasör sorulur; ad, renk, hariç tutma kalıpları ve boyut sınırı'],
    search: ['Akıllı arama', 'Kök, aksan ve yazım hatasına dayanıklı; vurgulu parça, filtreler, önizleme'],
    fuzzy: ['Yazım hatası düzeltme', '“teklf bütçe” → teklif, bütçe; tür filtresi ve belge kelime bulutu'],
    cloud: ['3B kelime bulutu', 'Tüm dizinin kelimeleri üç boyutta; döndür, yakınlaştır, kelimeye tıkla ara'],
    record: ['Kayıt penceresi', 'Klasör ağacı boyutlarıyla, dosya listesi, önizleme ve canlı durum çubuğu'],
    recordSearch: ['Kayıt içinde arama', 'Yalnız bu kayıtta ara; sonuçlar alt klasör yoluyla ve vurgulu'],
    settings: ['Ayarlar › Arama', 'OCR ve konuşmadan metne isteğe bağlı, varsayılan kapalı; sınırlar'],
    ocr: ['Resimde metin (OCR)', 'Fotoğraftaki yazı bu bilgisayarda okunur ve aranır'],
  },
  en: {
    home: ['Records', 'Each record shows its live total size, file and folder count and watch state'],
    newRec: ['New record', 'Pick the folder first; then name, colour, exclude patterns and size limit'],
    search: ['Smart search', 'Stems, accents and typos handled; highlighted snippets, filters, preview'],
    fuzzy: ['Typo correction', '“propsal budget” → proposal, budget; type filter and document word cloud'],
    cloud: ['3D word cloud', 'Every word in the index in 3D; rotate, zoom and click a word to search'],
    record: ['Record window', 'Folder tree with sizes, file list, preview and a live status bar'],
    recordSearch: ['Search within a record', 'Search only this record; results with subfolder path and highlights'],
    settings: ['Settings › Search', 'OCR and speech to text are optional and off by default; limits'],
    ocr: ['Text in images (OCR)', 'Text in a photo is read on this computer and becomes searchable'],
  },
};

// --- Örnek veri ve gerçek dizinleyici ----------------------------------------------------
async function prepare(lang) {
  const S = SAMPLE[lang];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `fsr-shots-${lang}-`));
  const dirs = await generate(path.join(base, 'docs'), lang);
  const data = path.join(base, 'data');
  process.env.FSR_OCR_LANG_BASE = path.join(ROOT, 'node_modules', '@tesseract.js-data');
  const ocr = createOcr({ dataDir: data, download: null });
  await ocr.ensureLanguage('tur');
  await ocr.ensureLanguage('eng');
  const ix = new Indexer({ dataDir: data, settings: { ocr: { enabled: true, languages: ['tur', 'eng'] } }, ocr, log: () => {} });
  const records = S.records.map(([name, color], i) => ({ id: `r${i + 1}`, name, color, path: dirs[i], excludes: ['node_modules', '*.tmp', '~$*'], maxFileMB: 0, createdAt: 1 }));
  ix.setRecords(records.map((r) => ({ id: r.id, name: r.name, path: r.path, excludes: r.excludes })));
  await ix.idle(180000);
  const winPath = (p) => (typeof p === 'string' && p.startsWith(path.join(base, 'docs')) ? S.docs + p.slice(path.join(base, 'docs').length).split('/').join('\\') : p);
  return { ix, records, winPath, base };
}

// window.api taklidi (preload.js ile aynı yüzey); veri istekleri window.__fsr köprüsüyle gerçek dizinleyiciye gider
function stubScript({ lang, settings, store, account }) {
  return `(() => {
    const SETTINGS = ${JSON.stringify(settings)};
    const STORE = ${JSON.stringify(store)};
    const ACCOUNT = ${JSON.stringify(account)};
    const noop = () => () => {};
    const ix = (m, a) => window.__fsr(m, a);
    window.api = {
      lang: ${JSON.stringify(lang)}, version: '1.0.0',
      accountState: async () => ACCOUNT, login: async () => ({ ok: true }), logout: async () => {}, syncNow: async () => {},
      setSyncEnabled: async () => ({ ok: true }), deleteRemoteLibrary: async () => ({ ok: true }), openWeb: async () => {},
      onAccountStatus: noop, onUpdateAvailable: noop, onLibraryBackup: noop, openMastertool: async () => {},
      about: async () => ({ version: '1.0.0', electron: '33.4.11', chrome: '130.0.6723.191', node: '20.18.3', openAtLogin: true }),
      checkUpdate: async () => ({ ok: true, newer: false }), openLicenses: async () => {}, showMain: async () => {},
      getStore: async () => STORE, onStoreChanged: noop, setSettings: async () => {},
      saveRecord: async () => 'x', deleteRecord: async () => {}, pauseRecord: async () => {}, openRecord: async () => {},
      rescan: async () => {}, retryErrors: async () => {}, openRecordFolder: async () => {},
      pickFolder: async () => ${JSON.stringify(SAMPLE[lang].docs + (lang === 'tr' ? '\\Saha Fotoğrafları' : '\\Site Photos'))},
      recordStats: () => ix('stats'), onRecordStats: noop, onRecordInfo: noop, onRecordChanged: noop, onRecordReveal: noop, onIndexChanged: noop,
      search: (o) => ix('search', o), cloud: (o) => ix('cloud', o), recent: (o) => ix('recent', o),
      children: (record, rel, dirsOnly) => ix('children', { record, rel, dirsOnly }), rootInfo: (r) => ix('rootInfo', r),
      doc: (id) => ix('doc', id), nodeAt: (record, rel) => ix('nodeAt', { record, rel }),
      openFile: async () => {}, revealFile: async () => {}, copyPath: async () => {},
      speechStatus: async () => ({ engine: true, canDownloadEngine: true, downloading: [], models: { tiny: { installed: false }, base: { installed: true, size: 147951465 }, small: { installed: false }, 'large-v3-turbo-q5_0': { installed: false } } }),
      speechDownload: async () => ({ ok: true }), speechCancelDownload: async () => {}, speechDeleteModel: async () => {}, onSpeechDownload: noop, onEngineFailed: noop,
      ocrStatus: async () => ({ downloading: [], langs: { tur: { installed: true, size: 2414911 }, eng: { installed: true, size: 4113088 } } }),
      ocrDownload: async () => ({ ok: true }), ocrCancelDownload: async () => {}, ocrDelete: async () => {},
      storageInfo: async () => ({ index: 3421184, models: 154479464, dir: 'C:\\\\Users\\\\Ornek\\\\AppData\\\\Roaming\\\\Mastertool\\\\File Search' }),
      clearIndex: async () => {}, openStorage: async () => {},
    };
  })();`;
}

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  });
  for (const lang of ['tr', 'en']) {
    const S = SAMPLE[lang];
    const T = TEXT[lang];
    const OUT = lang === 'tr' ? OUT_BASE : path.join(OUT_BASE, lang);
    fs.mkdirSync(OUT, { recursive: true });
    const { ix, records, winPath, base } = await prepare(lang);
    // Dördüncü kayıt: ağ sürücüsü, dizinleme sürüyor (yalnız görsel)
    const net = { id: 'r9', name: S.net.name, color: S.net.color, path: S.net.path, network: true, paused: false, excludes: [], maxFileMB: 0, createdAt: 1 };
    const netStats = { size: 18.4 * GB, files: 48213, dirs: 3127, indexed: 29870, pending: 18343, errors: 0, waiting: 0, state: 'indexing', running: 2, network: true };
    const settings = { appTheme: 'system', language: lang, openAtLogin: true, showTray: true, closeToTray: true, minimizeToTray: false, checkUpdates: true,
      ocrEnabled: true, ocrLanguages: ['tur', 'eng'], speechEnabled: false, speechModel: 'base', speechLanguage: 'auto', concurrency: 2, maxFileMB: 50,
      fuzzy: true, indexingPaused: false, treeWidth: 310, previewWidth: 430, searchSort: 'relevance' };
    const store = { settings, records: [...records.map((r) => ({ ...r, path: winPath(r.path), paused: false, network: false })), net] };
    const account = { loggedIn: true, email: S.email, user: { id: 1, name: S.name, email: S.email }, syncEnabled: true, state: 'ok', lastSyncAt: Date.now() - 120000, appVersion: '1.0.0' };

    // Köprü: gerçek dizinleyici; yollar Windows biçimine, önizlenebilir resimler data: adresine çevrilir
    const fix = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'path' ? winPath(x) : x)));
    const handlers = {
      stats: () => ({ ...ix.stats(), r9: netStats }),
      search: (o) => fix(ix.search(o)),
      cloud: (o) => ix.cloud(o),
      recent: (o) => ix.recent(o),
      children: (a) => ix.children(a.record, a.rel, { dirsOnly: a.dirsOnly }),
      rootInfo: (r) => fix(ix.rootInfo(r)),
      doc: (id) => withMedia(ix.doc(id)),
      nodeAt: (a) => withMedia(ix.nodeAt(a.record, a.rel)),
    };
    function withMedia(d) {
      if (!d) return d;
      const out = fix(d);
      if (d.node && d.node.kind === 'image' && ['png', 'jpg', 'jpeg'].includes(d.node.ext)) out.mediaUrl = `data:image/${d.node.ext === 'png' ? 'png' : 'jpeg'};base64,${fs.readFileSync(d.path).toString('base64')}`;
      return out;
    }

    const manifest = [];
    const shot = async (file, theme, [title, caption], page0, run) => {
      if (caption.length > 80) throw new Error(`caption > 80: ${caption}`);
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: theme, locale: S.locale, timezoneId: 'Europe/Istanbul' });
      await ctx.exposeFunction('__fsr', (m, a) => handlers[m](a));
      await ctx.addInitScript(stubScript({ lang, settings, store, account }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.warn('  sayfa hatası:', e.message));
      await page.goto(`file://${path.join(ROOT, 'src', 'renderer', page0)}`);
      await page.waitForTimeout(400);
      await run(page);
      await page.waitForTimeout(450); // animasyonlar otursun
      await page.screenshot({ path: path.join(OUT, file) });
      await ctx.close();
      manifest.push({ file, theme, title, caption });
      console.log('✓', lang, file);
    };
    const search = async (page, q) => {
      await page.fill('#search', q);
      await page.waitForSelector('.result');
      await page.waitForTimeout(500);
    };

    await shot('01-kayitlar-gece.png', 'dark', T.home, 'index.html', async (p) => { await p.waitForSelector('.rec-card'); });
    await shot('02-kayitlar-gunduz.png', 'light', T.home, 'index.html', async (p) => { await p.waitForSelector('.rec-card'); await p.click('.rec-card[data-id="r1"]'); });
    await shot('03-yeni-kayit-gece.png', 'dark', T.newRec, 'index.html', async (p) => { await p.click('#btnNew'); await p.waitForSelector('#rf-path'); await p.evaluate(() => document.activeElement.blur()); });
    await shot('04-arama-gece.png', 'dark', T.search, 'index.html', (p) => search(p, S.queries.main));
    await shot('05-yazim-hatasi-gunduz.png', 'light', T.fuzzy, 'index.html', async (p) => {
      await search(p, S.queries.fuzzy);
      await p.click('.f-kind[data-k="word"]');
      await p.click('.f-kind[data-k="excel"]');
      await p.waitForTimeout(600);
    });
    const cloud = async (p) => {
      await p.click('[data-a="cloud"]');
      await p.waitForSelector('.cloud3d-canvas');
      await p.waitForTimeout(2500);
    };
    await shot('06-kelime-bulutu-3b-gece.png', 'dark', T.cloud, 'index.html', cloud);
    await shot('07-kelime-bulutu-3b-gunduz.png', 'light', T.cloud, 'index.html', cloud);
    const docRel = lang === 'tr' ? 'Teklifler/2026-Q3 Teklif - Liman Deposu.docx' : 'Proposals/2026-Q3 Proposal - Harbour Warehouse.docx';
    const recordWin = async (p) => {
      await p.waitForSelector('.tnode');
      const d = ix.nodeAt('r1', docRel);
      await p.evaluate((x) => reveal(x.parent, x.id), { parent: d.node.parent, id: d.node.id });
      await p.waitForSelector('#list .frow.on');
      await p.evaluate(() => { document.querySelectorAll('.tnode').forEach((n) => { if (n.dataset.rel && !n.dataset.rel.includes('/')) open.add(n.dataset.rel); }); renderTree(); });
      await p.waitForTimeout(500);
    };
    await shot('08-kayit-penceresi-gece.png', 'dark', T.record, 'record.html?id=r1', recordWin);
    await shot('09-kayit-icinde-arama-gunduz.png', 'light', T.recordSearch, 'record.html?id=r1', async (p) => {
      await p.waitForSelector('.tnode');
      await p.fill('#search', S.queries.record);
      await p.waitForSelector('#list .fbody .frow');
      await p.waitForTimeout(600);
    });
    await shot('10-arama-ayarlari-gece.png', 'dark', T.settings, 'index.html', async (p) => {
      await p.click('#searchOpts');
      await p.waitForSelector('.set-wrap');
      await p.waitForTimeout(400);
    });
    await shot('11-ocr-gunduz.png', 'light', T.ocr, 'index.html', (p) => search(p, S.queries.ocr));

    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${manifest.length} görüntü → ${path.relative(ROOT, OUT)}`);
    await ix.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
