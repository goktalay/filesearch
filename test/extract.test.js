'use strict';

// Metin çıkarma: kodlama algılama (UTF-8/UTF-16/Windows-1254), PDF, Word, Excel, PowerPoint, OpenDocument, RTF, HTML, e-posta

const test = require('node:test');
const assert = require('node:assert');
const iconv = require('iconv-lite');
const { zipSync, strToU8 } = require('fflate');
const F = require('./fixtures');
const X = require('../src/indexer/extract');
const { detectEncoding, looksBinary } = require('../src/indexer/encoding');

test('düz metin: UTF-8, BOM, UTF-16 LE/BE ve Windows-1254', async () => {
  const s = 'Türkçe: ığüşöç İĞÜŞÖÇ — rapor';
  assert.strictEqual((await X.extractBuffer(Buffer.from(s), 'a.txt')).text, s);
  assert.strictEqual((await X.extractBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)]), 'a.md')).text, s);
  assert.strictEqual((await X.extractBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]), 'a.txt')).text, s);
  const be = Buffer.from(s, 'utf16le').swap16();
  assert.strictEqual((await X.extractBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'a.txt')).text, s);
  // BOM'suz UTF-16 (sıfır bayt deseninden)
  assert.strictEqual(detectEncoding(Buffer.from('plain ascii text here', 'utf16le')).encoding, 'utf16le');
  const ansi = iconv.encode('Şirket toplantısı ığüşöç', 'windows-1254');
  const r = await X.extractBuffer(ansi, 'eski.txt');
  assert.strictEqual(r.text, 'Şirket toplantısı ığüşöç');
  assert.strictEqual(r.meta.encoding, 'windows-1254');
});

test('kod dosyası okunur, ikili dosya reddedilir', async () => {
  assert.match((await X.extractBuffer(Buffer.from("const x = 'merhaba';\n"), 'a.js')).text, /merhaba/);
  assert.ok(looksBinary(Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01])));
  await assert.rejects(X.extractBuffer(Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02]), 'veri.txt'), (e) => e.code === 'binary');
});

test('Word (docx): paragraflar ve başlık', async () => {
  const r = await X.extractBuffer(F.docx(['Birinci paragraf', 'İkinci paragraf şöyle'], { title: 'Teklif' }), 'teklif.docx');
  assert.strictEqual(r.text, 'Birinci paragraf\nİkinci paragraf şöyle');
  assert.strictEqual(r.title, 'Teklif');
});

test('Excel (xlsx): sayfa adları, paylaşılan metinler ve sayılar', async () => {
  const r = await X.extractBuffer(F.xlsx({ Satışlar: [['Ürün', 'Adet'], ['Çilek', 7]], Özet: [['Toplam', 7]] }), 'a.xlsx');
  assert.strictEqual(r.text, '# Satışlar\nÜrün\tAdet\nÇilek\t7\n# Özet\nToplam\t7');
});

test('PowerPoint (pptx): slayt sırası ve konuşmacı notları', async () => {
  const slides = Array.from({ length: 11 }, (_, i) => ({ title: `Slayt ${i + 1}` }));
  slides[0].notes = 'Not bir';
  const r = await X.extractBuffer(F.pptx(slides), 'a.pptx');
  const lines = r.text.split('\n').filter(Boolean);
  assert.strictEqual(lines[0], 'Slayt 1');
  assert.strictEqual(lines[1], 'Not bir');
  assert.strictEqual(lines[lines.length - 1], 'Slayt 11', 'slide10 slide2\'den sonra gelmeli');
  assert.ok(lines.indexOf('Slayt 2') < lines.indexOf('Slayt 10'));
});

test('OpenDocument (odt)', async () => {
  const odt = Buffer.from(zipSync({
    'content.xml': strToU8('<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text><text:h>Başlık</text:h><text:p>Paragraf<text:tab/>sekme<text:s text:c="2"/>boşluk</text:p></office:text></office:body></office:document-content>'),
  }));
  assert.strictEqual((await X.extractBuffer(odt, 'a.odt')).text, 'Başlık\nParagraf\tsekme  boşluk');
});

test('PDF (pdf.js): sayfa metni ve başlık', async () => {
  const r = await X.extractBuffer(F.pdf(['Quarterly budget report', 'Second line'], { title: 'Budget' }), 'a.pdf');
  assert.strictEqual(r.text, 'Quarterly budget report\nSecond line');
  assert.strictEqual(r.title, 'Budget');
  assert.strictEqual(r.meta.pages, 1);
  await assert.rejects(X.extractBuffer(Buffer.from('%PDF-1.4 bozuk'), 'b.pdf'), (e) => e.code === 'corrupt');
});

test('RTF: Windows-1254 \\\'hh, \\uN ve görünmeyen gruplar', async () => {
  const r = await X.extractBuffer(F.rtf('Şirket toplantısı ğüşıöç\nİkinci satır'), 'a.rtf');
  assert.strictEqual(r.text, 'Şirket toplantısı ğüşıöç\nİkinci satır');
  const raw = Buffer.from("{\\rtf1\\ansi\\ansicpg1254{\\fonttbl{\\f0 Arial;}}{\\*\\generator X;}\\f0 \\'d0\\'fd\\'de ve \\u351? tamam\\par}", 'latin1');
  assert.strictEqual((await X.extractBuffer(raw, 'b.rtf')).text, 'ĞıŞ ve ş tamam');
});

test('HTML: betik/stil atılır, varlıklar çözülür, başlık alınır', async () => {
  const r = await X.extractBuffer(Buffer.from('<html><head><title>Sayfa &amp; Başlık</title><style>p{}</style></head><body><p>Merhaba&nbsp;dünya &#351; &#x11f;</p><script>gizli()</script></body></html>'), 'a.html');
  assert.strictEqual(r.text, 'Merhaba dünya ş ğ');
  assert.strictEqual(r.title, 'Sayfa & Başlık');
});

test('e-posta (eml): RFC 2047 konu, quoted-printable gövde, ekler', async () => {
  const r = await X.extractBuffer(F.eml({ from: 'Deniz Örnek <deniz@example.com>', to: 'ekip@example.com', subject: 'Proje güncellemesi', body: 'Merhaba ekip,\nyarınki toplantı 10\'da.', attachment: 'plan.pdf' }), 'a.eml');
  assert.strictEqual(r.title, 'Proje güncellemesi');
  assert.strictEqual(r.meta.from, 'Deniz Örnek <deniz@example.com>');
  assert.deepStrictEqual(r.meta.attachments, ['plan.pdf']);
  assert.match(r.text, /yarınki toplantı 10'da\./);
  assert.ok(!r.cloudText.includes('example.com'), 'kelime bulutu metninde adres yok');
});

test('desteklenmeyen tür', async () => {
  await assert.rejects(X.extractBuffer(Buffer.from('x'), 'a.zip'), (e) => e.code === 'unsupported');
  assert.strictEqual(X.canExtract('a.docx'), true);
  assert.strictEqual(X.canExtract('a.png'), false);
});
