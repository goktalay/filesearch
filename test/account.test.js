'use strict';

// Hesap ve uçtan uca şifreli senkron: test vektörü, şifreleme, iki cihaz arasında kayıt senkronu (sahte sunucuyla)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createMock } = require('./mock-server');

let mock;
test.before(async () => {
  mock = createMock();
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  process.env.FSR_API = `http://127.0.0.1:${mock.server.address().port}`;
});
test.after(() => mock.server.close());

const load = () => {
  delete require.cache[require.resolve('../src/account')];
  return require('../src/account');
};

test('sözleşme test vektörü (authHash ailede ortak, encKey "fsr-enc-v1")', async () => {
  const { deriveKeys, encKeyFromMaster } = load();
  const k = await deriveKeys('Test1234!', { alg: 'PBKDF2-SHA256', iter: 310000, salt: 'AAECAwQFBgcICQoLDA0ODw==' });
  assert.strictEqual(k.authHash, 'mLBQ6HQqD19kX/VavErWYq+7tM4mCmGfic7GuQQlBMY=');
  assert.strictEqual(k.encKey.subarray(0, 8).toString('hex'), '687899da0149e13e');
  const expected = Buffer.from(crypto.hkdfSync('sha256', k.master, Buffer.alloc(0), Buffer.from('fsr-enc-v1'), 32));
  assert.ok(encKeyFromMaster(k.master).equals(expected));
});

test('şifreleme gidiş-dönüş ve bozuk blob', () => {
  const { encryptLibrary, decryptLibrary } = load();
  const key = Buffer.alloc(32, 7);
  const blob = encryptLibrary(key, { schema: 1, items: [{ id: 'a' }] });
  assert.deepStrictEqual(decryptLibrary(key, blob), { schema: 1, items: [{ id: 'a' }] });
  assert.throws(() => decryptLibrary(Buffer.alloc(32, 8), blob), /decrypt_failed/);
});

function device(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fsr-${name}-`));
  const store = { records: [], local: {}, syncMeta: {}, settings: { appTheme: 'dark', language: null, ocrEnabled: false, speechEnabled: false, maxFileMB: 50 } };
  const { createAccount } = load();
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.0.0', encrypt: (s) => s, decrypt: (s) => s,
    getStore: () => store,
    replaceLibrary: ({ records, settings, syncMeta }) => { Object.assign(store, { records, syncMeta }); Object.assign(store.settings, settings); },
    persistStore: () => {}, backupAndClearLibrary: () => null, onStatus: () => {}, onSessionExpired: () => {}, onUpdate: () => {},
  });
  return { store, acc };
}

test('iki cihaz: kayıt adı/rengi/ayarları senkronlanır; klasör yolu ve dizin senkronlanmaz', async () => {
  const A = device('a');
  const B = device('b');
  await A.acc.login('test@example.com', 'Test1234!', true);
  await B.acc.login('test@example.com', 'Test1234!', true);
  A.store.records.push({ id: 'r1', createdAt: 1, name: 'Proje Arşivi', color: '#a855f7', excludes: ['node_modules', '*.tmp'], maxFileMB: 20, notes: '' });
  A.store.local.r1 = { path: 'D:\\Gizli Klasör\\Arşiv', paused: false, network: false };
  A.store.settings.ocrEnabled = true;
  await A.acc.syncNow();
  assert.strictEqual(A.acc.state().state, 'ok');
  await B.acc.syncNow();
  assert.strictEqual(B.store.records.length, 1);
  assert.deepStrictEqual(
    { name: B.store.records[0].name, color: B.store.records[0].color, excludes: B.store.records[0].excludes, maxFileMB: B.store.records[0].maxFileMB },
    { name: 'Proje Arşivi', color: '#a855f7', excludes: ['node_modules', '*.tmp'], maxFileMB: 20 },
  );
  assert.strictEqual(B.store.settings.ocrEnabled, true, 'arama ayarları senkronlanır');
  assert.strictEqual(B.store.local.r1, undefined, 'klasör yolu cihaza özgü kalmalı');
  // Sunucudaki blob açık metin içermez; yol hiç gönderilmez
  const raw = Buffer.from(mock.state.blob, 'base64').toString('latin1');
  assert.ok(!raw.includes('Proje') && !raw.includes('Gizli'));
  // B yeniden adlandırır, A görür ve yolunu korur; B siler, A'dan da gider
  B.store.records[0].name = 'Arşiv 2026';
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.records[0].name, 'Arşiv 2026');
  assert.strictEqual(A.store.local.r1.path, 'D:\\Gizli Klasör\\Arşiv');
  B.store.records = [];
  await B.acc.syncNow();
  await A.acc.syncNow();
  assert.strictEqual(A.store.records.length, 0);
});
