'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, nativeTheme, protocol, net, Tray, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const I18N = require('./i18n');
const FORMATS = require('./formats');
const { createAccount, apiBase } = require('./account');
const { createSso } = require('./sso');
const { IndexerClient } = require('./indexer/client');
const { createSpeech } = require('./speech');
const { createOcr } = require('./ocr');

// Arayüz dili: ayarlarda seçilen ya da sistem dili (desteklenmiyorsa İngilizce)
let t = I18N.createT('en');
const currentLang = () => (store && store.settings.language) || I18N.resolveLanguage(app.getLocale());
function applyLanguage() { t = I18N.createT(currentLang()); }

const APP_NAME = 'File Search';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const userDir = (...p) => path.join(app.getPath('userData'), ...p);

// Veriler Mastertool ailesinin klasöründe: %APPDATA%\Mastertool\File Search
app.setPath('userData', path.join(app.getPath('appData'), 'Mastertool', APP_NAME));

// Önizleme için özel şema (Range destekli; ses/video ileri-geri sarılabilir)
protocol.registerSchemesAsPrivileged([{ scheme: 'fsr', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

// ---------------------------------------------------------------------------
// Kalıcı depo (userData/store.json)
// ---------------------------------------------------------------------------
const storePath = () => userDir('store.json');

const defaultStore = () => ({
  records: [],   // kayıt tanımları (senkronlanır): { id, name, color, excludes, maxFileMB, notes, createdAt }
  local: {},     // cihaza özgü: kayıtId -> { path, paused, network }
  syncMeta: {},  // senkron: öğe id -> { kind, hash, updated_at, rev, device, deleted }
  settings: {
    appTheme: 'system',        // 'dark' | 'light' | 'system'
    language: null,            // null = sistem dili
    openAtLogin: true,         // Windows oturumu açılınca tepside başlat (cihaza özgü)
    showTray: true,            // sistem tepsisinde dur
    minimizeToTray: false,     // küçültülünce tepsiye gizle
    closeToTray: true,         // kapat (X): pencere kapanır, izleme tepside sürer
    checkUpdates: true,        // açılışta yeni sürümü denetle
    // Arama
    ocrEnabled: false,         // resimlerde metin oku (OCR)
    ocrLanguages: ['tur', 'eng'],
    speechEnabled: false,      // ses/videoda konuşmayı metne çevir
    speechModel: 'base',
    speechLanguage: 'auto',
    concurrency: 2,            // aynı anda metni çıkarılan dosya
    maxFileMB: 50,             // içeriği okunacak en büyük dosya (kayıtta ayrıca belirtilebilir)
    fuzzy: true,               // yazım hatasına dayanıklı arama
    indexingPaused: false,     // tüm kayıtlarda izleme/dizinleme duraklatıldı (cihaza özgü)
    // görünüm (cihaza özgü, sessiz kaydedilir)
    treeWidth: 300,
    previewWidth: 420,
    searchSort: 'relevance',
  },
});

let store = null;
const uid = () => crypto.randomBytes(8).toString('hex');

function loadStore() {
  applyLanguage();
  try {
    store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
    store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
    if (!store.syncMeta) store.syncMeta = {};
    if (!store.local) store.local = {};
    if (!Array.isArray(store.records)) store.records = [];
  } catch {
    store = defaultStore();
  }
  applyAppTheme();
  applyLanguage();
}

function applyAppTheme() {
  const v = store.settings.appTheme;
  nativeTheme.themeSource = v === 'dark' || v === 'light' ? v : 'system';
}
const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

let saveTimer = null;
// Kütüphane değişikliği kaydedilir ve (3 sn sonra) senkron tetiklenir; cihaza özgü kayıtlar için { sync: false }
function saveStore({ sync = true } = {}) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 150);
  if (sync && account) account.onLocalChange();
}
function writeStore() {
  saveTimer = null;
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, storePath());
}

function encrypt(text) {
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
  return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
}
function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  return value;
}

const getLocal = (id) => store.local[id] || (store.local[id] = { path: '', paused: false, network: false });

function publicStore() {
  return {
    settings: store.settings,
    records: store.records.map((r) => ({ ...r, path: getLocal(r.id).path || '', paused: !!getLocal(r.id).paused, network: !!getLocal(r.id).network })),
  };
}

function broadcastStore() {
  refreshTray();
  const data = publicStore();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('store:changed', data);
}

// ---------------------------------------------------------------------------
// Dizinleyici (ayrı süreç)
// ---------------------------------------------------------------------------
let indexer = null;
let lastStats = {};

function indexerRecords() {
  return store.records.map((r) => {
    const loc = getLocal(r.id);
    return {
      id: r.id, name: r.name, path: loc.path || '', excludes: r.excludes || [],
      maxFileMB: r.maxFileMB || 0, paused: !!loc.paused, network: !!loc.network,
    };
  });
}

function indexerSettings() {
  const s = store.settings;
  return {
    concurrency: s.concurrency, maxFileMB: s.maxFileMB, fuzzy: s.fuzzy !== false, paused: !!s.indexingPaused,
    ocr: { enabled: !!s.ocrEnabled, languages: s.ocrLanguages && s.ocrLanguages.length ? s.ocrLanguages : ['tur', 'eng'] },
    speech: { enabled: !!s.speechEnabled, model: s.speechModel || 'base', language: s.speechLanguage || 'auto' },
  };
}

function startIndexer() {
  if (indexer) return;
  // FSR_NODE: geliştirmede dizinleyiciyi sistemdeki Node ile çalıştırmak için (better-sqlite3 Node için derliyse)
  indexer = new IndexerClient({
    dataDir: app.getPath('userData'), resourcesDir: app.isPackaged ? process.resourcesPath : null,
    execPath: (!app.isPackaged && process.env.FSR_NODE) || process.execPath,
  });
  indexer.on('stats', (s) => {
    lastStats = s;
    refreshTrayLater();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('records:stats', s);
  });
  indexer.on('changed', (d) => {
    for (const [rid, w] of recordWindows) if (d[rid] && !w.isDestroyed()) w.webContents.send('record:changed', d[rid]);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('index:changed', d);
  });
  indexer.on('log', (l) => { if (!app.isPackaged) console.warn('[indexer]', l.where, l.message); });
  indexer.start(indexerRecords(), indexerSettings()).catch((e) => console.warn('indexer start', e));
}

async function stopIndexer() {
  if (!indexer) return;
  const ix = indexer;
  indexer = null;
  lastStats = {};
  await ix.stop().catch(() => {});
}

const syncIndexerRecords = () => indexer && indexer.setRecords(indexerRecords());
const syncIndexerSettings = () => indexer && indexer.setSettings(indexerSettings());
const ix = (m, a) => {
  if (!indexer) throw new Error(t('main.errNotReady'));
  return indexer.call(m, a);
};

// ---------------------------------------------------------------------------
// Mastertool hesabı (mastertool.download) ve uçtan uca şifreli senkron
// ---------------------------------------------------------------------------
let account = null;
let loginWindow = null;
let loginNotice = null;

function initAccount() {
  // Mastertool ortak oturumu: kimlik Windows Kimlik Bilgisi Yöneticisi'nde, durum işareti %APPDATA%\Mastertool altında
  let sso = null;
  try { sso = createSso({ stateDir: path.join(app.getPath('appData'), 'Mastertool') }); } catch { sso = null; }
  account = createAccount({
    sso,
    onSharedLogin: (r) => enterApp(r.backupFile),
    onSharedLogout: () => sharedLogout(),
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    encrypt,
    decrypt,
    getStore: () => store,
    replaceLibrary: ({ records, settings, syncMeta }) => {
      const prevLang = currentLang();
      Object.assign(store, { records, syncMeta });
      Object.assign(store.settings, settings);
      writeStore();
      applyAppTheme();
      applyLanguage();
      broadcastStore();
      syncIndexerRecords();
      syncIndexerSettings();
      for (const [rid, w] of recordWindows) {
        if (!store.records.some((r) => r.id === rid)) w.destroy(); // başka cihazda silindi
        else w.webContents.send('record:info', recordFor(rid));
      }
      if (currentLang() !== prevLang && mainWindow) mainWindow.webContents.reload();
    },
    persistStore: writeStore,
    backupAndClearLibrary: () => {
      const hasData = store.records.length;
      let file = null;
      if (hasData) {
        file = userDir(`store-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
      }
      Object.assign(store, { records: [], local: {}, syncMeta: {} });
      writeStore();
      syncIndexerRecords();
      return file;
    },
    onStatus: (st) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('account:status', st);
    },
    onSessionExpired: (code) =>
      showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
    onUpdate: (info) => mainWindow && mainWindow.webContents.send('app:update', info),
    autoCheckUpdate: () => store.settings.checkUpdates !== false,
  });
}

// Giriş tamam (şifreyle ya da ortak oturumla): dizinleyiciyi başlat, ana pencereyi aç
function enterApp(backupFile, { hidden = false } = {}) {
  loginNotice = null;
  const fresh = !mainWindow;
  if (fresh && !hidden) createMainWindow();
  if (loginWindow) loginWindow.destroy();
  if (backupFile && mainWindow) {
    const send = () => mainWindow && mainWindow.webContents.send('account:backup', backupFile);
    if (fresh) mainWindow.webContents.once('did-finish-load', send); else send();
  }
  if (!fresh) broadcastStore();
  startIndexer();
  refreshTray();
  account.start();
}

// Başka bir Mastertool uygulamasında çıkış yapıldı: dizin ve kayıtlar silinmez, izleme durur
function sharedLogout() {
  account.endLocal('signed_out_elsewhere');
  showLogin(t('auth.signedOutElsewhere'));
}

// ---------------------------------------------------------------------------
// Pencereler
// ---------------------------------------------------------------------------
let mainWindow = null;
const recordWindows = new Map(); // kayıtId -> BrowserWindow
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false };

function createLoginWindow({ show = true } = {}) {
  loginWindow = new BrowserWindow({
    width: 440, height: 640, resizable: false, maximizable: false, backgroundColor: windowBg(), show,
    title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => (loginWindow = null));
}

// Oturum yoksa ya da düştüyse: giriş ekranını aç, diğer pencereleri kapat, izlemeyi durdur
function showLogin(notice) {
  loginNotice = notice || null;
  if (!loginWindow) createLoginWindow();
  else { loginWindow.show(); loginWindow.focus(); }
  stopIndexer();
  for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) { w.forceClose = true; w.destroy(); }
  recordWindows.clear();
  mainWindow = null;
  refreshTray();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 820, minHeight: 540, backgroundColor: windowBg(),
    title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('minimize', (e) => {
    if (!store.settings.minimizeToTray) return;
    e.preventDefault();
    hideToTray(mainWindow);
  });
  mainWindow.on('close', (e) => {
    if (store.settings.closeToTray && !isQuitting) {
      e.preventDefault();
      hideToTray(mainWindow);
    }
  });
  mainWindow.on('show', refreshTray);
  mainWindow.on('closed', () => (mainWindow = null));
}

// ---------------------------------------------------------------------------
// Sistem tepsisi: arka planda izleme sürerken uygulamanın görünen yüzü
// ---------------------------------------------------------------------------
let tray = null;
let isQuitting = false;
let trayTimer = null;

function hideToTray(win) {
  ensureTray();
  win.hide();
  if (!store.settings.trayHintShown && tray) {
    store.settings.trayHintShown = true;
    saveStore({ sync: false });
    tray.displayBalloon({ iconType: 'info', title: t('main.balloonTitle'), content: t('main.balloonBody') });
  }
}

const fmtSize = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};

function buildTrayMenu() {
  const logged = account && account.isLoggedIn();
  const records = store.records.slice().sort((a, b) => a.name.localeCompare(b.name, currentLang()))
    .map((r) => {
      const st = lastStats[r.id];
      return { label: st ? `${r.name}  —  ${fmtSize(st.size || 0)}` : r.name, click: () => openRecordWindow(r.id) };
    });
  const paused = !!store.settings.indexingPaused;
  return Menu.buildFromTemplate([
    { label: t('main.trayShow'), click: showMainWindow },
    { type: 'separator' },
    ...(logged ? [
      { label: t('main.trayRecords'), submenu: records.length ? records : [{ label: t('main.trayNone'), enabled: false }] },
      { label: paused ? t('main.trayResume') : t('main.trayPause'), click: () => setSettings({ indexingPaused: !paused }) },
      { type: 'separator' },
    ] : []),
    { label: t('main.trayQuit'), click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function trayTooltip() {
  if (!account || !account.isLoggedIn()) return APP_NAME;
  const all = Object.values(lastStats);
  const busy = all.some((s) => ['scanning', 'indexing'].includes(s.state));
  if (store.settings.indexingPaused) return `${APP_NAME} — ${t('main.tipPaused')}`;
  return `${APP_NAME} — ${busy ? t('main.tipIndexing') : t('main.tipWatching', { n: store.records.length })}`;
}

function ensureTray() {
  if (tray) return refreshTray();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' }));
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function refreshTray() {
  const want = store && (store.settings.showTray || (mainWindow && !mainWindow.isVisible()));
  if (!want) { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) return ensureTray();
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(trayTooltip());
}
// İstatistik olayları sık gelir: tepsi menüsü en çok 3 sn'de bir yenilenir
function refreshTrayLater() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => { trayTimer = null; refreshTray(); }, 3000);
}

// Tepsiden, Master Tool tepsi uygulamasından ya da ikinci kez çalıştırılınca: pencereyi göster
function showMainWindow() {
  if (!account || !account.isLoggedIn()) {
    if (!loginWindow) return showLogin(loginNotice);
    if (loginWindow.isMinimized()) loginWindow.restore();
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function recordFor(id) {
  const r = store.records.find((x) => x.id === id);
  if (!r) return null;
  const loc = getLocal(id);
  return { ...r, path: loc.path || '', paused: !!loc.paused, network: !!loc.network };
}

function openRecordWindow(id, { rel = null, docId = null } = {}) {
  if (!account || !account.isLoggedIn()) return;
  const r = store.records.find((x) => x.id === id);
  if (!r) return;
  const existing = recordWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (rel !== null || docId) existing.webContents.send('record:reveal', { rel, docId });
    return;
  }
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 940, minHeight: 560, backgroundColor: windowBg(),
    title: `${r.name} — ${APP_NAME}`, icon: ICON, autoHideMenuBar: true, webPreferences,
  });
  win.setMenuBarVisibility(false);
  const query = { id };
  if (rel !== null) query.rel = rel;
  if (docId) query.doc = String(docId);
  win.loadFile(path.join(__dirname, 'renderer', 'record.html'), { query });
  recordWindows.set(id, win);
  win.on('closed', () => recordWindows.delete(id));
}

// ---------------------------------------------------------------------------
// Önizleme: fsr://media/<anahtar> → yalnız belge ayrıntısı istenmiş, kayıt içindeki dosyalar
// ---------------------------------------------------------------------------
const mediaTokens = new Map(); // anahtar -> mutlak yol
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml',
};

function mediaUrl(abs, mtime) {
  const key = crypto.createHash('sha1').update(abs).digest('hex');
  mediaTokens.set(key, abs);
  if (mediaTokens.size > 2000) mediaTokens.delete(mediaTokens.keys().next().value);
  return `fsr://media/${key}/${encodeURIComponent(path.basename(abs))}?v=${mtime || 0}`;
}

function registerMediaProtocol() {
  protocol.handle('fsr', async (req) => {
    const u = new URL(req.url);
    const key = u.pathname.split('/')[1];
    const abs = mediaTokens.get(key);
    if (u.host !== 'media' || !abs) return new Response('not found', { status: 404 });
    let st;
    try { st = await fs.promises.stat(abs); } catch { return new Response('not found', { status: 404 }); }
    // SVG betik çalıştırmasın
    const type = MIME[FORMATS.extOf(abs)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
    if (range && st.size) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), {
        status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(abs)), { status: 200, headers: { ...headers, 'Content-Length': String(st.size) } });
  });
}

// Belge ayrıntısına önizleme adresi ekler (yalnız pencerede gösterilebilen türler)
function withMedia(d) {
  if (!d || !d.node || d.node.is_dir) return d;
  const kind = d.node.kind;
  if (FORMATS.PREVIEW[kind] && FORMATS.PREVIEW[kind].includes(d.node.ext)) d.mediaUrl = mediaUrl(d.path, d.node.mtime);
  return d;
}

// ---------------------------------------------------------------------------
// İndirmeler (OCR dil verileri, konuşma motoru ve modelleri) — yalnız ilgili seçenek açıkken
// ---------------------------------------------------------------------------
let speech = null;
let ocr = null;
const downloads = new Map(); // anahtar -> AbortController
const sendDl = (x) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('speech:download', x); };

async function downloadOcr(lang) {
  const key = `ocr:${lang}`;
  if (downloads.has(key)) return { ok: true };
  const ctl = new AbortController();
  downloads.set(key, ctl);
  try {
    await ocr.ensureLanguage(lang, { signal: ctl.signal, onProgress: (p, got, total) => sendDl({ what: 'ocr', lang, progress: p, got, total }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: ctl.signal.aborted ? t('err.canceled') : errText(e) };
  } finally {
    downloads.delete(key);
    sendDl(null);
    syncIndexerSettings(); // dizinleyici bekleyen resimlere başlasın
  }
}

async function downloadSpeech(model) {
  if (downloads.has(model)) return { ok: true };
  const ctl = new AbortController();
  downloads.set(model, ctl);
  try {
    await speech.ensureEngine({ signal: ctl.signal, onProgress: (p) => sendDl({ what: 'engine', progress: p }) });
    await speech.ensureModel(model, { signal: ctl.signal, onProgress: (p, got, total) => sendDl({ what: 'model', model, progress: p, got, total }) });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: ctl.signal.aborted ? t('err.canceled') : errText(e) };
  } finally {
    downloads.delete(model);
    sendDl(null);
    syncIndexerSettings();
  }
}

// Seçenek açılınca eksik veriyi arka planda indir (sonuç pencerelere bildirilir)
function ensureEnginesForSettings() {
  const s = store.settings;
  if (s.ocrEnabled) {
    for (const l of s.ocrLanguages || []) {
      if (!ocr.installed(l)) downloadOcr(l).then((r) => { if (!r.ok) notifyAll('engine:failed', { what: 'ocr', message: r.message }); });
    }
  }
  if (s.speechEnabled && !speech.ready(s.speechModel) && (speech.binPath() || process.platform === 'win32')) {
    downloadSpeech(s.speechModel).then((r) => { if (!r.ok) notifyAll('engine:failed', { what: 'speech', message: r.message }); });
  }
}
const notifyAll = (ch, d) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, d); };

function errText(err) {
  const code = err && err.code;
  const map = {
    canceled: 'err.canceled', engine_missing: 'err.engineMissing', download_failed: 'err.download',
    ENOENT: 'err.notFound', EACCES: 'err.access', EPERM: 'err.access', EBUSY: 'err.busy', ENOSPC: 'err.noSpace',
  };
  if (map[code]) return t(map[code], { msg: (err && err.message) || '' });
  return String((err && err.message) || err || 'error');
}

// ---------------------------------------------------------------------------
// IPC — hesap
// ---------------------------------------------------------------------------
ipcMain.handle('account:state', () => ({ ...account.state(), notice: loginNotice, appVersion: app.getVersion() }));

ipcMain.handle('account:login', async (_e, { email, password, remember }) => {
  try {
    const { backupFile } = await account.login(email, password, remember);
    enterApp(backupFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || 'error', message: e.message };
  }
});

ipcMain.handle('account:logout', async () => {
  await account.logout(); // ortak kimliği siler: diğer Mastertool uygulamalarında da çıkış yapılır
  showLogin();
});
ipcMain.handle('account:syncNow', () => account.syncNow());
ipcMain.handle('account:setSync', async (_e, on) => {
  try { await account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});
ipcMain.handle('account:deleteRemote', async () => {
  try { await account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
});

// Mastertool düğmesi: portal, uygulamanın dili ve o anki gece/gündüz temasıyla tarayıcıda açılır
ipcMain.handle('app:openMastertool', () => {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  shell.openExternal(`https://mastertool.download/?lang=${encodeURIComponent(currentLang())}&theme=${theme}`);
});

// Hesap ve tanıtım sayfaları varsayılan tarayıcıda açılır (yalnız bu adresler)
ipcMain.handle('account:openWeb', (_e, page) => {
  const allowed = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim', about: '/araclar/file-search' };
  if (!allowed[page]) return;
  const q = new URLSearchParams({ lang: currentLang(), theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', app: 'fs' });
  shell.openExternal(`${apiBase()}${allowed[page]}?${q}`);
});

// Windows oturumu açılınca başlat (yalnız paketlenmiş uygulamada; geliştirmede electron.exe kaydedilmesin)
function applyOpenAtLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.openAtLogin, args: ['--hidden'] });
}

ipcMain.handle('app:about', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  openAtLogin: app.isPackaged ? app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin : !!store.settings.openAtLogin,
}));

ipcMain.handle('app:checkUpdate', async () => {
  try {
    return { ok: true, ...(await account.checkUpdate({ manual: true })) };
  } catch (e) {
    return { ok: false, code: e.code || 'error', message: e.message };
  }
});

// Chromium/Electron lisans dosyaları kurulum klasöründe durur
ipcMain.handle('app:openLicenses', () => {
  const file = path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
  if (fs.existsSync(file)) return shell.openPath(file);
  return shell.openExternal('https://www.electronjs.org/docs/latest#license');
});
ipcMain.on('app:lang', (e) => { e.returnValue = currentLang(); });
ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('app:showMain', () => showMainWindow());

// ---------------------------------------------------------------------------
// IPC — depo, kayıtlar, ayarlar
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', () => publicStore());
ipcMain.handle('records:stats', () => lastStats);

const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

// Windows'ta harfle eşlenmiş ağ sürücüsü mü? ("net use" listesinde)
function isNetworkPath(p) {
  return new Promise((resolve) => {
    if (/^\\\\/.test(p)) return resolve(true);
    if (process.platform !== 'win32' || !/^[a-z]:/i.test(p)) return resolve(false);
    execFile('net', ['use'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(false);
      const drive = p.slice(0, 2).toUpperCase();
      resolve(String(out).toUpperCase().split(/\r?\n/).some((l) => new RegExp(`\\s${drive}\\s`).test(` ${l} `)));
    });
  });
}

const cleanExcludes = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/))
  .map((x) => String(x).trim()).filter(Boolean).slice(0, 200).map((x) => x.slice(0, 200));

ipcMain.handle('record:save', async (_e, form) => {
  let r = form.id ? store.records.find((x) => x.id === form.id) : null;
  if (!r) {
    r = { id: uid(), createdAt: Date.now() };
    store.records.push(r);
  }
  const loc = getLocal(r.id);
  const newPath = typeof form.path === 'string' ? form.path.trim() : loc.path;
  Object.assign(r, {
    name: String(form.name || '').trim().slice(0, 120) || path.basename(newPath || '') || t('main.untitled'),
    color: FORMATS.COLORS.includes(form.color) ? form.color : r.color || FORMATS.COLORS[0],
    excludes: cleanExcludes(form.excludes),
    maxFileMB: num(form.maxFileMB, 0, 0, 4096),
    notes: String(form.notes || '').slice(0, 2000),
  });
  if (newPath !== loc.path) {
    loc.path = newPath;
    loc.network = newPath ? await isNetworkPath(newPath) : false;
  }
  saveStore();
  broadcastStore();
  syncIndexerRecords();
  const w = recordWindows.get(r.id);
  if (w) { w.setTitle(`${r.name} — ${APP_NAME}`); w.webContents.send('record:info', recordFor(r.id)); }
  return r.id;
});

ipcMain.handle('record:delete', async (_e, id) => {
  const w = recordWindows.get(id);
  if (w) { w.forceClose = true; w.destroy(); }
  store.records = store.records.filter((r) => r.id !== id);
  delete store.local[id];
  saveStore();
  broadcastStore();
  syncIndexerRecords(); // dizinleyici kaydın dizin satırlarını siler (dosyalarınıza dokunulmaz)
});

ipcMain.handle('record:pause', (_e, { id, paused }) => {
  getLocal(id).paused = !!paused;
  saveStore({ sync: false });
  broadcastStore();
  syncIndexerRecords();
});

ipcMain.handle('record:open', (_e, { id, rel, docId }) => openRecordWindow(id, { rel: rel ?? null, docId: docId || null }));
ipcMain.handle('record:rescan', (_e, id) => ix('rescan', id || null));
ipcMain.handle('record:retry', (_e, id) => ix('retryErrors', id || null));

// Görünüm ve cihaza özgü ayarlar sessizce kaydedilir ve senkronlanmaz
const QUIET_SETTINGS = ['treeWidth', 'previewWidth', 'searchSort', 'openAtLogin', 'showTray', 'minimizeToTray', 'closeToTray', 'trayHintShown', 'indexingPaused'];
const INDEXER_SETTINGS = ['ocrEnabled', 'ocrLanguages', 'speechEnabled', 'speechModel', 'speechLanguage', 'concurrency', 'maxFileMB', 'fuzzy', 'indexingPaused'];

function setSettings(patch) {
  if ('concurrency' in patch) patch.concurrency = num(patch.concurrency, 2, 1, 8);
  if ('maxFileMB' in patch) patch.maxFileMB = num(patch.maxFileMB, 50, 1, 4096);
  if ('ocrLanguages' in patch) patch.ocrLanguages = (patch.ocrLanguages || []).filter((l) => FORMATS.OCR_LANGS.includes(l)).slice(0, 6);
  if ('speechModel' in patch && !FORMATS.SPEECH_MODELS[patch.speechModel]) delete patch.speechModel;
  Object.assign(store.settings, patch);
  const loud = Object.keys(patch).some((k) => !QUIET_SETTINGS.includes(k));
  saveStore({ sync: loud });
  if ('appTheme' in patch) applyAppTheme();
  if ('openAtLogin' in patch) applyOpenAtLogin();
  if (Object.keys(patch).some((k) => INDEXER_SETTINGS.includes(k))) {
    syncIndexerSettings();
    ensureEnginesForSettings();
  }
  if ('language' in patch) {
    applyLanguage();
    refreshTray();
    if (mainWindow) mainWindow.webContents.reload();
    if (loginWindow) loginWindow.webContents.reload();
    for (const w of recordWindows.values()) w.webContents.reload();
    return;
  }
  if (loud || ['showTray', 'minimizeToTray', 'closeToTray', 'indexingPaused'].some((k) => k in patch)) broadcastStore();
}
ipcMain.handle('settings:set', (_e, patch) => setSettings({ ...patch }));

ipcMain.handle('dialog:pickFolder', async (event, { defaultPath } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showOpenDialog(win, { title: t('main.pickFolder'), defaultPath: defaultPath || os.homedir(), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------------------
// IPC — arama, ağaç, belge, kelime bulutu
// ---------------------------------------------------------------------------
const wrap = (fn) => async (event, arg) => {
  try {
    return await fn(event, arg);
  } catch (err) {
    throw new Error(errText(err));
  }
};

ipcMain.handle('ix:search', wrap((_e, opts) => ix('search', opts)));
ipcMain.handle('ix:cloud', wrap((_e, opts) => ix('cloud', opts)));
ipcMain.handle('ix:children', wrap((_e, a) => ix('children', a)));
ipcMain.handle('ix:root', wrap((_e, id) => ix('rootInfo', id)));
ipcMain.handle('ix:doc', wrap(async (_e, id) => withMedia(await ix('doc', id))));
ipcMain.handle('ix:nodeAt', wrap(async (_e, a) => withMedia(await ix('nodeAt', a))));
ipcMain.handle('ix:storage', wrap(async () => {
  const dirSize = async (dir) => {
    let n = 0;
    try {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        n += e.isDirectory() ? await dirSize(p) : (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
      }
    } catch { /* yok */ }
    return n;
  };
  const s = indexer ? await ix('storage') : { index: 0 };
  return { index: s.index, models: (await dirSize(userDir('models'))) + (await dirSize(userDir('ocr'))) + (await dirSize(userDir('engines'))), dir: app.getPath('userData') };
}));
ipcMain.handle('ix:clear', wrap(() => ix('clear')));

// Dosya işlemleri: yalnız dizindeki bir belge kimliğiyle (yol pencereden alınmaz)
async function docPath(id) {
  const d = await ix('doc', id);
  if (!d) throw new Error(t('err.notFound', { msg: '' }));
  return d.path;
}
ipcMain.handle('file:open', wrap(async (_e, id) => {
  const err = await shell.openPath(await docPath(id));
  if (err) throw new Error(err);
}));
ipcMain.handle('file:reveal', wrap(async (_e, id) => shell.showItemInFolder(await docPath(id))));
ipcMain.handle('file:copyPath', wrap(async (_e, id) => clipboard.writeText(await docPath(id))));
ipcMain.handle('record:openFolder', wrap(async (_e, id) => {
  const loc = getLocal(id);
  if (loc.path) { const err = await shell.openPath(loc.path); if (err) throw new Error(err); }
}));

// ---------------------------------------------------------------------------
// IPC — OCR ve konuşma verileri, depolama (ayarlar)
// ---------------------------------------------------------------------------
ipcMain.handle('speech:status', () => ({ ...speech.status(), downloading: [...downloads.keys()].filter((k) => !k.startsWith('ocr:')) }));
ipcMain.handle('speech:download', (_e, model) => downloadSpeech(model));
ipcMain.handle('speech:cancelDownload', (_e, model) => downloads.get(model)?.abort());
ipcMain.handle('speech:deleteModel', (_e, model) => speech.deleteModel(model));
ipcMain.handle('ocr:status', () => ({ ...ocr.status(), downloading: [...downloads.keys()].filter((k) => k.startsWith('ocr:')).map((k) => k.slice(4)) }));
ipcMain.handle('ocr:download', (_e, lang) => downloadOcr(lang));
ipcMain.handle('ocr:cancelDownload', (_e, lang) => downloads.get(`ocr:${lang}`)?.abort());
ipcMain.handle('ocr:delete', (_e, lang) => ocr.deleteLanguage(lang));
ipcMain.handle('storage:open', async () => shell.openPath(app.getPath('userData')));

// ---------------------------------------------------------------------------
app.setAppUserModelId('com.mastertool.filesearch');

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => e.preventDefault());
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.on('before-quit', () => (isQuitting = true));

  app.whenReady().then(async () => {
    registerMediaProtocol();
    loadStore();
    // İlk açılışta "Windows ile başlat" varsayılanı uygulanır (kurulumla birlikte arka planda izleme)
    if (!store.settings.loginItemApplied) { applyOpenAtLogin(); store.settings.loginItemApplied = true; saveStore({ sync: false }); }
    speech = createSpeech({
      dataDir: app.getPath('userData'),
      resourcesDir: app.isPackaged ? process.resourcesPath : null,
      devDir: path.join(__dirname, '..', 'vendor', 'whisper'),
      fetch: (url, opts) => net.fetch(url, opts), // sistem proxy ayarlarına uyar
    });
    ocr = createOcr({ dataDir: app.getPath('userData'), download: speech.download });
    initAccount();
    const hidden = process.argv.includes('--hidden');
    // Uygulama girişsiz açılmaz. "Beni hatırla" ile saklı oturum varsa doğrudan açılır (Windows ile
    // başlatıldıysa yalnız tepside, izleme arka planda); oturum yoksa giriş ekranı.
    if (account.sharedEndedWhileClosed()) loginNotice = t('auth.signedOutElsewhere');
    let backupFile = null;
    if (!account.isLoggedIn()) {
      const r = await account.loginWithShared();
      if (r.ok) backupFile = r.backupFile;
      else if (r.code === 'app_disabled') loginNotice = t('auth.errAppDisabled');
    }
    account.watchShared();
    if (account.isLoggedIn()) {
      enterApp(backupFile, { hidden });
      if (hidden) ensureTray();
      ensureEnginesForSettings();
    } else if (hidden) {
      ensureTray(); // girişi tepsiden açar
    } else {
      createLoginWindow();
    }
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && showMainWindow());
  });

  // Pencereler kapansa da uygulama tepside çalışmayı sürdürür; yalnız "Çıkış" ile kapanır
  app.on('window-all-closed', () => {
    if (!isQuitting && tray && account && account.isLoggedIn()) return;
    app.quit();
  });

  let quitting = false;
  app.on('will-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    if (tray) { tray.destroy(); tray = null; }
    if (account) account.stopShared();
    if (saveTimer) { clearTimeout(saveTimer); writeStore(); }
    stopIndexer().finally(() => app.exit(0));
  });
}
