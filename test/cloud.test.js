'use strict';

// Kelime (etiket) bulutu: belge başına en sık kelimeler (durak kelimeler, sayılar, adresler hariç; kök başına
// birleştirilir) ve dizin/kayıt/sonuç kapsamında toplam bulut

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/indexer/text');
const { tmp, writeTree, indexer } = require('./helpers');

test('belge bulutu: kök başına sayılır, en sık yazım gösterilir, durak kelimeler çıkar', () => {
  const text = 'Raporlar hazır. Rapor ve raporları inceledik; bu raporlar için de bir kez daha raporlar yazıldı. 2024 2024 ve ve ve ama için. deniz@example.com https://ornek.example/yol';
  const terms = T.topTerms(text, 'tr', 10);
  const top = terms[0];
  assert.strictEqual(top.key, 'rapor');
  assert.strictEqual(top.n, 5);
  assert.strictEqual(top.term, 'raporlar', 'en sık biçim');
  const keys = terms.map((x) => x.key);
  for (const stop of ['ve', 'ama', 'için', 'bir', 'bu', 'de']) assert.ok(!keys.includes(T.fold(stop)), stop);
  assert.ok(!keys.includes('2024'), 'sayılar çıkar');
  assert.ok(!keys.some((k) => /example|ornek|https|deniz/.test(k)), 'e-posta ve web adresleri çıkar');
});

test('İngilizce durak kelimeler ve kökler', () => {
  const terms = T.topTerms('The connection was connected and the connections are connecting to the server servers.', 'en', 5);
  assert.strictEqual(terms[0].key, 'connect');
  assert.strictEqual(terms[0].n, 4);
  assert.ok(!terms.some((x) => ['the', 'and', 'are', 'was', 'to'].includes(x.key)));
});

test('dizin bulutu: tüm dizin, kayıt ve sonuç kapsamı', async () => {
  const a = tmp('ca');
  const b = tmp('cb');
  writeTree(a, { '1.txt': 'liman liman liman depo depo yangın', '2.txt': 'liman vardiya vardiya' });
  writeTree(b, { '3.txt': 'muhasebe fatura fatura fatura fatura fatura' });
  const ix = await indexer([{ id: 'a', name: 'A', path: a }, { id: 'b', name: 'B', path: b }]);
  const all = ix.cloud({});
  assert.strictEqual(all[0].term, 'fatura');
  assert.strictEqual(all[0].n, 5);
  const liman = all.find((x) => x.term === 'liman');
  assert.strictEqual(liman.n, 4);
  assert.strictEqual(liman.docs, 2);
  const onlyA = ix.cloud({ records: ['a'] });
  assert.ok(!onlyA.some((x) => x.term === 'fatura'));
  const ids = ix.search({ q: 'vardiya' }).results.map((x) => x.id);
  const res = ix.cloud({ ids });
  assert.deepStrictEqual(res.map((x) => x.term).sort(), ['liman', 'vardiya']);
  const d = ix.nodeAt('a', '1.txt');
  assert.deepStrictEqual(d.terms.map((x) => [x.term, x.n]), [['liman', 3], ['depo', 2], ['yangın', 1]]);
  await ix.close();
});
