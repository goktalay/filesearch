'use strict';

// Dizin ve akıllı arama: kök bulma (Türkçe/İngilizce), aksan ve büyük/küçük harf, önek, tam ifade, hariç tutma,
// yazım hatasına dayanıklılık, dosya adı, filtreler, vurgulu parça ve sıralama

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('./fixtures');
const Q = require('../src/indexer/query');
const T = require('../src/indexer/text');
const { tmp, writeTree, indexer, names } = require('./helpers');

let ix;
let root;
let root2;
test.before(async () => {
  root = tmp('src');
  root2 = tmp('src2');
  writeTree(root, {
    'notlar/toplantı.txt': 'İstanbul şehirlerindeki depolarımızı ziyaret ettik. Raporları hazırladık ve yöneticilere sunduk.',
    'notlar/liste.md': '# Alışveriş\nElma, armut ve muz alınacak. Kitaplık için raf bakılacak.',
    'teklif/Liman Deposu Teklifi.docx': F.docx(['Liman deposu için yangın algılama sistemi teklif edilmektedir.', 'Bakım iki yılda bir yapılır.']),
    'english/report.txt': 'The quarterly reports were indexed by the connection manager. Running totals are attached.',
    'english/budget.pdf': F.pdf(['Annual budget planning for warehouse renovation']),
    'kod/servis.js': "// stok servisi\nfunction stokGuncelle(miktar) { return miktar; }\n",
    'Rapor_2024-final.txt': 'kısa',
  });
  // Tarih ve boyut filtreleri için
  const old = path.join(root, 'notlar', 'liste.md');
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  writeTree(root2, { 'diğer.txt': 'Başka kayıtta şehir planlaması belgesi.' });
  ix = await indexer([{ id: 'a', name: 'Arşiv', path: root }, { id: 'b', name: 'Diğer', path: root2 }]);
});
test.after(() => ix.close());

test('metin işleme: katlama, kökler, dil', () => {
  assert.strictEqual(T.fold('ŞEHİR Işık çığ'), 'sehir isik cig');
  assert.strictEqual(T.stem('kitaplarımızdan', 'tr'), 'kitap');
  assert.strictEqual(T.stem('reports', 'en'), 'report');
  assert.strictEqual(T.detectLanguage('Bu bir deneme metnidir ve Türkçe yazılmıştır, çünkü bu dil için test ediyoruz.'), 'tr');
  assert.strictEqual(T.detectLanguage('This is a sample text that is written in English for the test of the detector.'), 'en');
});

test('sorgu ayrıştırma ve mesafe', () => {
  assert.deepStrictEqual(Q.parse('elma "yangın algılama" -muz armut'), { terms: ['elma', 'armut'], phrases: [['yangın', 'algılama']], excludes: ['muz'] });
  assert.strictEqual(Q.distance('kitap', 'ktiap', 2), 1, 'komşu harf yer değişimi tek düzenleme');
  assert.strictEqual(Q.distance('rapor', 'raporlar', 2), 3);
});

test('Türkçe kök: çekimli kelimeler ve aksansız yazım bulunur', () => {
  for (const q of ['şehir', 'sehir', 'ŞEHİRLER', 'depolar', 'raporlarda', 'yönetici', 'ziyaret']) {
    const n = names(ix.search({ q, records: ['a'] }));
    assert.ok(n.includes('toplantı.txt') && !n.includes('liste.md'), `${q}: ${n}`);
  }
});

test('İngilizce kök', () => {
  for (const q of ['report', 'index', 'connect', 'run']) assert.ok(names(ix.search({ q })).includes('report.txt'), q);
});

test('önek araması ve kod', () => {
  assert.deepStrictEqual(names(ix.search({ q: 'stokGun' })), ['servis.js']);
  assert.deepStrictEqual(names(ix.search({ q: 'kitapl' })), ['liste.md']);
});

test('dosya adı da aranır (camelCase, alt çizgi ve tire bölünür)', () => {
  assert.ok(names(ix.search({ q: 'liman teklifi' })).includes('Liman Deposu Teklifi.docx'));
  assert.deepStrictEqual(names(ix.search({ q: 'final' })), ['Rapor_2024-final.txt']);
});

test('tırnakla tam ifade: kelimeler yan yana ve sırasıyla', () => {
  assert.deepStrictEqual(names(ix.search({ q: '"yangın algılama"' })), ['Liman Deposu Teklifi.docx']);
  assert.strictEqual(ix.search({ q: '"algılama yangın"' }).total, 0);
});

test('hariç tutma ve VE bağlacı', () => {
  assert.deepStrictEqual(names(ix.search({ q: 'elma armut' })), ['liste.md']);
  assert.strictEqual(ix.search({ q: 'elma -muz' }).total, 0);
  assert.strictEqual(ix.search({ q: 'elma yangın' }).total, 0);
});

test('yazım hatasına dayanıklı: yakın yazımlar önerilir ve bulunur', () => {
  const r = ix.search({ q: 'ziyeret' });
  assert.deepStrictEqual(names(r), ['toplantı.txt']);
  assert.ok(Object.keys(r.fuzzy).length === 1);
  const r2 = ix.search({ q: 'quartely' });
  assert.deepStrictEqual(names(r2), ['report.txt']);
  ix.setSettings({ fuzzy: false });
  assert.strictEqual(ix.search({ q: 'ziyeret' }).total, 0);
  ix.setSettings({ fuzzy: true });
});

test('PDF ve Word içeriği aranır', () => {
  assert.deepStrictEqual(names(ix.search({ q: 'renovation' })), ['budget.pdf']);
  assert.deepStrictEqual(names(ix.search({ q: 'bakım' })), ['Liman Deposu Teklifi.docx']);
});

test('filtreler: kayıt, tür, tarih, boyut', () => {
  assert.deepStrictEqual(names(ix.search({ q: 'şehir' })), ['diğer.txt', 'toplantı.txt']);
  assert.deepStrictEqual(names(ix.search({ q: 'şehir', records: ['b'] })), ['diğer.txt']);
  assert.strictEqual(ix.search({ q: 'yangın', kinds: ['text'] }).total, 0);
  assert.strictEqual(ix.search({ q: 'yangın', kinds: ['word'] }).total, 1);
  assert.strictEqual(ix.search({ q: 'elma', from: Date.parse('2021-01-01') }).total, 0, 'eski dosya tarih filtresine takılır');
  assert.strictEqual(ix.search({ q: 'elma', to: Date.parse('2021-01-01') }).total, 1);
  assert.strictEqual(ix.search({ q: 'şehir', minSize: 1000 }).total, 0);
});

test('vurgulu parça ve sonuç alanları', () => {
  const r = ix.search({ q: 'şehir rapor' });
  const x = r.results.find((y) => y.name === 'toplantı.txt');
  const marked = x.snippet.filter((p) => p.m).map((p) => p.t);
  assert.deepStrictEqual(marked, ['şehirlerindeki', 'Raporları']);
  assert.strictEqual(x.recordName, 'Arşiv');
  assert.strictEqual(x.rel, 'notlar/toplantı.txt');
  assert.ok(x.path.endsWith(path.join('notlar', 'toplantı.txt')));
  assert.ok(x.size > 0 && x.mtime > 0);
});

test('sıralama: ada ve boyuta göre', () => {
  const s = ix.search({ q: 'şehir', sort: 'name' });
  assert.deepStrictEqual(s.results.map((x) => x.name), ['diğer.txt', 'toplantı.txt']);
  const z = ix.search({ q: 'şehir', sort: 'size' });
  assert.ok(z.results[0].size >= z.results[1].size);
});

test('boş ve anlamsız sorgu güvenle boş döner', () => {
  assert.strictEqual(ix.search({ q: '' }).total, 0);
  assert.strictEqual(ix.search({ q: '"' }).total, 0);
  assert.strictEqual(ix.search({ q: '*** ((( )))' }).total, 0);
});

test('ağaç ve belge ayrıntısı', () => {
  const kids = ix.children('a', '');
  assert.deepStrictEqual(kids.filter((k) => k.is_dir).map((k) => k.name), ['english', 'kod', 'notlar', 'teklif']);
  const notlar = kids.find((k) => k.name === 'notlar');
  assert.strictEqual(notlar.files, 2);
  assert.ok(notlar.size > 100);
  const d = ix.nodeAt('a', 'notlar/toplantı.txt');
  assert.match(d.text, /İstanbul/);
  assert.strictEqual(d.node.lang, 'tr');
  assert.ok(d.terms.some((t) => t.term === 'şehirlerindeki'));
  const dir = ix.nodeAt('a', 'notlar');
  assert.strictEqual(dir.node.files, 2);
  assert.strictEqual(ix.rootInfo('a').files, 7);
});
