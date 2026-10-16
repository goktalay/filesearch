'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // arayüz dili (açılışta senkron alınır ki ilk çizim doğru dilde olsun)
  lang: ipcRenderer.sendSync('app:lang'),
  version: ipcRenderer.sendSync('app:version'),

  // Mastertool hesabı ve senkron
  accountState: () => ipcRenderer.invoke('account:state'),
  login: (email, password, remember) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('account:logout'),
  syncNow: () => ipcRenderer.invoke('account:syncNow'),
  setSyncEnabled: (on) => ipcRenderer.invoke('account:setSync', on),
  deleteRemoteLibrary: () => ipcRenderer.invoke('account:deleteRemote'),
  openWeb: (page) => ipcRenderer.invoke('account:openWeb', page), // 'forgot' | 'register' | 'account' | 'about'
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  onLibraryBackup: on('account:backup'),
  openMastertool: () => ipcRenderer.invoke('app:openMastertool'),
  about: () => ipcRenderer.invoke('app:about'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openLicenses: () => ipcRenderer.invoke('app:openLicenses'),
  showMain: () => ipcRenderer.invoke('app:showMain'),

  // depo ve ayarlar
  getStore: () => ipcRenderer.invoke('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // kayıtlar
  saveRecord: (form) => ipcRenderer.invoke('record:save', form),
  deleteRecord: (id) => ipcRenderer.invoke('record:delete', id),
  pauseRecord: (id, paused) => ipcRenderer.invoke('record:pause', { id, paused }),
  openRecord: (id, opts = {}) => ipcRenderer.invoke('record:open', { id, ...opts }),
  rescan: (id) => ipcRenderer.invoke('record:rescan', id),
  retryErrors: (id) => ipcRenderer.invoke('record:retry', id),
  openRecordFolder: (id) => ipcRenderer.invoke('record:openFolder', id),
  pickFolder: (opts) => ipcRenderer.invoke('dialog:pickFolder', opts || {}),
  recordStats: () => ipcRenderer.invoke('records:stats'),
  onRecordStats: on('records:stats'),
  onRecordInfo: on('record:info'),
  onRecordChanged: on('record:changed'),
  onRecordReveal: on('record:reveal'),
  onIndexChanged: on('index:changed'),

  // arama, ağaç, belge, kelime bulutu
  search: (opts) => ipcRenderer.invoke('ix:search', opts),
  cloud: (opts) => ipcRenderer.invoke('ix:cloud', opts),
  recent: (opts) => ipcRenderer.invoke('ix:recent', opts),
  children: (record, rel, dirsOnly) => ipcRenderer.invoke('ix:children', { record, rel, dirsOnly }),
  rootInfo: (record) => ipcRenderer.invoke('ix:root', record),
  doc: (id) => ipcRenderer.invoke('ix:doc', id),
  nodeAt: (record, rel) => ipcRenderer.invoke('ix:nodeAt', { record, rel }),
  openFile: (id) => ipcRenderer.invoke('file:open', id),
  revealFile: (id) => ipcRenderer.invoke('file:reveal', id),
  copyPath: (id) => ipcRenderer.invoke('file:copyPath', id),

  // OCR / konuşma verileri ve depolama
  speechStatus: () => ipcRenderer.invoke('speech:status'),
  speechDownload: (model) => ipcRenderer.invoke('speech:download', model),
  speechCancelDownload: (model) => ipcRenderer.invoke('speech:cancelDownload', model),
  speechDeleteModel: (model) => ipcRenderer.invoke('speech:deleteModel', model),
  onSpeechDownload: on('speech:download'),
  onEngineFailed: on('engine:failed'),
  ocrStatus: () => ipcRenderer.invoke('ocr:status'),
  ocrDownload: (lang) => ipcRenderer.invoke('ocr:download', lang),
  ocrCancelDownload: (lang) => ipcRenderer.invoke('ocr:cancelDownload', lang),
  ocrDelete: (lang) => ipcRenderer.invoke('ocr:delete', lang),
  storageInfo: () => ipcRenderer.invoke('ix:storage'),
  clearIndex: () => ipcRenderer.invoke('ix:clear'),
  openStorage: () => ipcRenderer.invoke('storage:open'),
});
