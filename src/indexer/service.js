'use strict';

// Dizinleyici süreci (arka plan hizmeti). Ana uygulama bu dosyayı ayrı bir Node süreci olarak başlatır
// (Electron'un kendi Node'u, ELECTRON_RUN_AS_NODE=1) ve IPC kanalından JSON iletileriyle konuşur:
//
//   ana → hizmet:  { t: 'req', id, m: <yöntem>, a: <argüman> }
//   hizmet → ana:  { t: 'res', id, ok: true, r }  |  { t: 'res', id, ok: false, err: { code, message } }
//                  { t: 'ev', e: 'stats' | 'changed' | 'log', d }
//
// Arayüz kapalıyken de (pencere tepside) çalışmayı sürdürür. Aynı ileti biçimi ileride bir adlandırılmış
// kanal (named pipe) üzerinden bir Windows hizmetine taşınabilir.

const path = require('path');
const { Indexer } = require('./engine');
const { createOcr } = require('../ocr');
const { createSpeech } = require('../speech');

const send = (msg) => { if (process.connected) process.send(msg); };
const log = (where, e) => send({ t: 'ev', e: 'log', d: { where, message: String((e && e.stack) || e) } });

let ix = null;

const METHODS = {
  init({ dataDir, resourcesDir, settings, records }) {
    if (ix) return true;
    const speech = createSpeech({ dataDir, resourcesDir, devDir: path.join(__dirname, '..', '..', 'vendor', 'whisper') });
    const ocr = createOcr({ dataDir, download: speech.download });
    ix = new Indexer({ dataDir, settings, ocr, speech, log });
    ix.on('stats', (d) => send({ t: 'ev', e: 'stats', d }));
    ix.on('changed', (d) => send({ t: 'ev', e: 'changed', d }));
    ix.setRecords(records || []);
    return true;
  },
  setRecords: (list) => ix.setRecords(list),
  setSettings: (s) => ix.setSettings(s),
  stats: () => ix.stats(),
  search: (opts) => ix.search(opts),
  children: ({ record, rel, dirsOnly }) => ix.children(record, rel, { dirsOnly }),
  rootInfo: (record) => ix.rootInfo(record),
  doc: (id) => ix.doc(id),
  nodeAt: ({ record, rel }) => ix.nodeAt(record, rel),
  cloud: (opts) => ix.cloud(opts),
  rescan: (record) => ix.rescan(record),
  retryErrors: (record) => ix.retryErrors(record),
  storage: () => ix.storage(),
  clear: () => ix.clear(),
  ping: () => 'pong',
  async shutdown() {
    if (ix) await ix.close();
    ix = null;
    setTimeout(() => process.exit(0), 50);
    return true;
  },
};

process.on('message', async (msg) => {
  if (!msg || msg.t !== 'req') return;
  const fn = METHODS[msg.m];
  try {
    if (!fn) throw Object.assign(new Error(`unknown method ${msg.m}`), { code: 'bad_method' });
    if (!ix && msg.m !== 'init' && msg.m !== 'ping' && msg.m !== 'shutdown') throw Object.assign(new Error('not initialized'), { code: 'not_ready' });
    const r = await fn(msg.a);
    send({ t: 'res', id: msg.id, ok: true, r: r === undefined ? null : r });
  } catch (e) {
    send({ t: 'res', id: msg.id, ok: false, err: { code: (e && e.code) || 'error', message: String((e && e.message) || e) } });
  }
});

// Ana uygulama kapanınca (kanal koparsa) dizini düzgün kapatıp çık
process.on('disconnect', async () => {
  try { if (ix) await ix.close(); } finally { process.exit(0); }
});
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));
