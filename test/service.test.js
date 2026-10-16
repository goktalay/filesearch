'use strict';

// Dizinleyici süreci (arka plan hizmeti): ayrı Node sürecinde başlar, istekleri yanıtlar, olay gönderir,
// çökerse son kayıt listesiyle yeniden başlar ve düzgün kapanır

const test = require('node:test');
const assert = require('node:assert');
const { IndexerClient } = require('../src/indexer/client');
const { tmp, writeTree, waitFor } = require('./helpers');

test('istemci ↔ hizmet: init, arama, olaylar, çökme sonrası yeniden başlama, kapanış', async () => {
  const root = tmp('svc');
  writeTree(root, { 'a.txt': 'hizmet sürecinde dizinlenen ahududu' });
  const c = new IndexerClient({ dataDir: tmp('svc-data'), timeoutMs: 20000 });
  let stats = null;
  c.on('stats', (s) => { stats = s; });
  await c.start([{ id: 'r', name: 'R', path: root }], {});
  assert.strictEqual(await c.call('ping'), 'pong');
  await waitFor(() => stats && stats.r && stats.r.state === 'watching', 15000);
  assert.strictEqual(stats.r.files, 1);
  assert.strictEqual((await c.call('search', { q: 'ahududu' })).total, 1);
  assert.strictEqual((await c.call('children', { record: 'r', rel: '' })).length, 1);
  await assert.rejects(c.call('yok'), (e) => e.code === 'bad_method');
  // Süreç beklenmedik biçimde ölürse yeniden başlar ve dizin kaldığı yerden sürer
  const pid = c.child.pid;
  c.child.kill('SIGKILL');
  await waitFor(() => c.child && c.child.pid !== pid && c.child.connected, 15000);
  await c.ready;
  assert.strictEqual((await c.call('search', { q: 'ahududu' })).total, 1);
  await c.stop();
  assert.strictEqual(c.child, null);
});
