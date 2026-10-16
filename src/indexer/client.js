'use strict';

// Ana süreç tarafı: dizinleyici sürecini başlatır, istekleri iletir, olayları dağıtır ve süreç çökerse
// yeniden başlatır (son kayıt listesi ve ayarlarla).

const { fork } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const SERVICE = path.join(__dirname, 'service.js');

class IndexerClient extends EventEmitter {
  constructor({ dataDir, resourcesDir = null, execPath = process.execPath, env = {}, timeoutMs = 60000 }) {
    super();
    this.opts = { dataDir, resourcesDir, execPath, env, timeoutMs };
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.records = [];
    this.settings = {};
    this.stopped = false;
    this.restarts = 0;
    this.ready = null;
  }

  start(records, settings) {
    this.records = records || [];
    this.settings = settings || {};
    this.stopped = false;
    this._spawn();
    return this.ready;
  }

  _spawn() {
    const child = fork(SERVICE, [], {
      execPath: this.opts.execPath,
      env: { ...process.env, ...this.opts.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      serialization: 'json',
    });
    this.child = child;
    let errTail = '';
    if (child.stderr) child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
    child.on('message', (msg) => this._onMessage(msg));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('indexer stopped'), { code: 'indexer_stopped' })); }
      this.pending.clear();
      if (this.stopped) return;
      this.emit('log', { where: 'exit', message: `code ${code} signal ${signal} ${errTail}` });
      // Çöktü: artan bekleme ile yeniden başlat
      const wait = Math.min(30000, 1000 * 2 ** Math.min(this.restarts++, 5));
      setTimeout(() => { if (!this.stopped) this._spawn(); }, wait).unref();
    });
    this.ready = this._call('init', {
      dataDir: this.opts.dataDir, resourcesDir: this.opts.resourcesDir, settings: this.settings, records: this.records,
    }).then(() => { this.restarts = 0; this.emit('ready'); });
    this.ready.catch(() => {});
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else p.reject(Object.assign(new Error(msg.err.message), { code: msg.err.code }));
    } else if (msg.t === 'ev') {
      this.emit(msg.e, msg.d);
    }
  }

  _call(m, a) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.connected) return reject(Object.assign(new Error('indexer not running'), { code: 'indexer_stopped' }));
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`indexer timeout: ${m}`), { code: 'timeout' }));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ t: 'req', id, m, a });
    });
  }

  // İstek: süreç hazır olana dek bekler
  async call(m, a) {
    if (this.ready) await this.ready.catch(() => {});
    return this._call(m, a);
  }

  setRecords(list) {
    this.records = list || [];
    return this.call('setRecords', this.records).catch(() => {});
  }

  setSettings(s) {
    this.settings = { ...this.settings, ...s };
    return this.call('setSettings', s).catch(() => {});
  }

  async stop() {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    await Promise.race([this._call('shutdown').catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode) return r();
      const t = setTimeout(() => { try { child.kill(); } catch { /* yok */ } r(); }, 2000);
      child.once('exit', () => { clearTimeout(t); r(); });
    });
  }
}

module.exports = { IndexerClient };
