'use strict';

// İzleme ve fark taraması: yeni / değişen / silinen dosya ve klasörler dizine anında yansır; kapalıyken yapılan
// değişiklikler açılışta yakalanır; hariç tutma kalıpları; toplam boyut ve sayılar canlı güncellenir

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createWatcher, compileExcludes, isUnc } = require('../src/indexer/watch');
const { Indexer } = require('../src/indexer/engine');
const { tmp, writeTree, indexer, waitFor, names } = require('./helpers');

test('hariç tutma kalıpları', () => {
  const ex = compileExcludes(['node_modules', '*.tmp', '~$*', 'Yedekler/**', 'build/cache', '# yorum']);
  assert.ok(ex('node_modules'));
  assert.ok(ex('a/node_modules/x/y.js'));
  assert.ok(ex('belge.TMP'), 'büyük/küçük harf duyarsız');
  assert.ok(ex('klasör/~$rapor.docx'));
  assert.ok(ex('Yedekler/2024/a.txt'));
  assert.ok(ex('build/cache/x.bin'));
  assert.ok(!ex('build/out.txt'));
  assert.ok(!ex('notlar/rapor.docx'));
  assert.ok(!ex(''));
  assert.ok(isUnc('\\\\sunucu\\paylasim'));
  assert.ok(!isUnc('C:\\Belgeler'));
});

test('izleyici: olaylar birleştirilip göreli yollarla bildirilir', async () => {
  const root = tmp('w');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  const got = new Set();
  const w = createWatcher(root, { debounceMs: 150, onChanges: (rels) => rels.forEach((r) => got.add(r)), filter: (r) => !r.endsWith('.tmp') });
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(root, 'a', 'b', 'x.txt'), '1');
  fs.writeFileSync(path.join(root, 'a', 'b', 'x.txt'), '12');
  fs.writeFileSync(path.join(root, 'yoksay.tmp'), '1');
  await waitFor(() => got.has('a/b/x.txt'));
  assert.ok(!got.has('yoksay.tmp'), 'süzgeç uygulanır');
  w.close();
});

test('dizinleyici: ekleme, değiştirme, silme, klasör taşıma ve silme anında yansır', async () => {
  const root = tmp('live');
  writeTree(root, { 'ilk.txt': 'başlangıç belgesi zeytin' });
  const ix = await indexer([{ id: 'r', name: 'Canlı', path: root }]);
  const stats = () => ix.stats().r;
  assert.strictEqual(stats().files, 1);
  assert.strictEqual(stats().state, 'watching');
  // yeni dosya (derin bir klasörde)
  writeTree(root, { 'yeni/alt/derin.txt': 'derin klasördeki portakal' });
  await waitFor(() => ix.search({ q: 'portakal' }).total === 1);
  assert.strictEqual(stats().dirs, 2);
  // değiştirme
  fs.writeFileSync(path.join(root, 'ilk.txt'), 'güncellenmiş belge mandalina ve daha uzun metin');
  await waitFor(() => ix.search({ q: 'mandalina' }).total === 1);
  assert.strictEqual(ix.search({ q: 'zeytin' }).total, 0, 'eski içerik dizinden çıkar');
  // boyut canlı
  await waitFor(() => stats().size === fs.statSync(path.join(root, 'ilk.txt')).size + fs.statSync(path.join(root, 'yeni/alt/derin.txt')).size);
  // klasörü taşı (yeniden adlandır)
  fs.renameSync(path.join(root, 'yeni'), path.join(root, 'taşındı'));
  await waitFor(() => { const r = ix.search({ q: 'portakal' }); return r.total === 1 && r.results[0].rel === 'taşındı/alt/derin.txt'; });
  assert.deepStrictEqual(ix.children('r', '').filter((k) => k.is_dir).map((k) => k.name), ['taşındı']);
  // klasörü sil
  fs.rmSync(path.join(root, 'taşındı'), { recursive: true });
  await waitFor(() => ix.search({ q: 'portakal' }).total === 0 && stats().dirs === 0);
  // dosyayı sil
  fs.rmSync(path.join(root, 'ilk.txt'));
  await waitFor(() => stats().files === 0 && stats().size === 0);
  await ix.close();
});

test('fark taraması: kapalıyken yapılan değişiklikler açılışta yakalanır', async () => {
  const root = tmp('diff');
  writeTree(root, { 'a.txt': 'kiraz', 'b.txt': 'vişne', 'k/c.txt': 'dut' });
  const dataDir = tmp('data');
  let ix = new Indexer({ dataDir, log: () => {} });
  ix.setRecords([{ id: 'r', name: 'R', path: root }]);
  await ix.idle();
  const idBefore = ix.nodeAt('r', 'b.txt').node.id;
  await ix.close();
  // uygulama kapalıyken
  fs.writeFileSync(path.join(root, 'a.txt'), 'karpuz');
  fs.rmSync(path.join(root, 'k'), { recursive: true });
  writeTree(root, { 'yeni.txt': 'kavun' });
  ix = new Indexer({ dataDir, log: () => {} });
  ix.setRecords([{ id: 'r', name: 'R', path: root }]);
  await ix.idle();
  assert.strictEqual(ix.search({ q: 'kiraz' }).total, 0);
  assert.strictEqual(ix.search({ q: 'karpuz' }).total, 1);
  assert.strictEqual(ix.search({ q: 'dut' }).total, 0);
  assert.strictEqual(ix.search({ q: 'kavun' }).total, 1);
  assert.strictEqual(ix.nodeAt('r', 'b.txt').node.id, idBefore, 'değişmeyen dosya yeniden okunmaz');
  assert.strictEqual(ix.stats().r.files, 3);
  await ix.close();
});

test('hariç tutulanlar ve boyut sınırı; kayıt ayarı değişince yeniden taranır', async () => {
  const root = tmp('ex');
  writeTree(root, { 'node_modules/x.js': 'gizli paket', 'iyi.txt': 'görünür metin', 'büyük.txt': 'sonkelime ' + 'b '.repeat(1536 * 1024) });
  const ix = await indexer([{ id: 'r', name: 'R', path: root, excludes: ['node_modules'], maxFileMB: 2 }]);
  assert.strictEqual(ix.search({ q: 'gizli' }).total, 0);
  assert.strictEqual(ix.search({ q: 'görünür' }).total, 1);
  assert.strictEqual(ix.search({ q: 'sonkelime' }).total, 0, 'boyut sınırını aşan dosyanın içeriği okunmaz');
  assert.deepStrictEqual(names(ix.search({ q: 'büyük' })), ['büyük.txt'], 'ama adıyla bulunur');
  assert.strictEqual(ix.nodeAt('r', 'büyük.txt').node.err, 'too_large');
  ix.setRecords([{ id: 'r', name: 'R', path: root, excludes: [], maxFileMB: 10 }]);
  await ix.idle();
  assert.strictEqual(ix.search({ q: 'gizli' }).total, 1);
  assert.strictEqual(ix.search({ q: 'sonkelime' }).total, 1);
  await ix.close();
});

test('erişilemeyen kök "missing"; kayıt silinince dizin satırları gider', async () => {
  const root = tmp('gone');
  writeTree(root, { 'a.txt': 'elma' });
  const ix = await indexer([{ id: 'r', name: 'R', path: root }, { id: 'y', name: 'Yok', path: path.join(root, 'olmayan') }]);
  assert.strictEqual(ix.stats().y.state, 'missing');
  assert.strictEqual(ix.search({ q: 'elma' }).total, 1);
  ix.setRecords([]);
  assert.strictEqual(ix.search({ q: 'elma' }).total, 0);
  assert.strictEqual(ix.db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 0);
  await ix.close();
});

test('duraklatma: izleme durur, sürdürünce fark taramasıyla devam eder', async () => {
  const root = tmp('pause');
  writeTree(root, { 'a.txt': 'birinci' });
  const ix = await indexer([{ id: 'r', name: 'R', path: root }]);
  ix.setRecords([{ id: 'r', name: 'R', path: root, paused: true }]);
  assert.strictEqual(ix.stats().r.state, 'paused');
  writeTree(root, { 'b.txt': 'ikinci' });
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual(ix.search({ q: 'ikinci' }).total, 0);
  ix.setRecords([{ id: 'r', name: 'R', path: root, paused: false }]);
  await ix.idle();
  assert.strictEqual(ix.search({ q: 'ikinci' }).total, 1);
  await ix.close();
});
