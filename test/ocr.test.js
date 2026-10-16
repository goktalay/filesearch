'use strict';

// Resimlerde metin (OCR): varsayılan kapalı — kapalıyken hiçbir şey indirilmez ve çalıştırılmaz; açılınca bekleyen
// resimler gerçek Tesseract (tesseract.js 7) ile okunur ve aranabilir olur. Dil verisi yerel paketten (ağsız).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createOcr } = require('../src/ocr');
const { tmp, writeTree, indexer, waitFor } = require('./helpers');

process.env.FSR_OCR_LANG_BASE = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data');

async function sign(file, text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="white"/>
    <text x="30" y="125" font-family="DejaVu Sans, Arial" font-size="60" fill="black">${text}</text></svg>`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(file);
}

test('OCR kapalı: resim beklemede kalır, dil verisi indirilmez', async () => {
  const root = tmp('ocr-off');
  await sign(path.join(root, 'tabela.png'), 'Fatura toplamı 1250 TL');
  let downloads = 0;
  const data = tmp('ocr-data');
  const ocr = createOcr({ dataDir: data, download: async () => { downloads++; } });
  const ix = await indexer([{ id: 'r', name: 'R', path: root }], {}, { ocr });
  const n = ix.nodeAt('r', 'tabela.png').node;
  assert.strictEqual(n.state, 4, 'waitOcr');
  assert.strictEqual(ix.stats().r.waiting, 1);
  assert.strictEqual(ix.search({ q: 'fatura' }).total, 0);
  assert.strictEqual(downloads, 0);
  assert.ok(!fs.existsSync(path.join(data, 'ocr')), 'veri klasörü bile oluşturulmaz');
  await ix.close();
});

test('OCR açılınca bekleyen resimler okunur ve aranır (Türkçe + İngilizce)', async () => {
  const root = tmp('ocr-on');
  await sign(path.join(root, 'tabela.png'), 'Fatura toplamı 1250 TL');
  const data = tmp('ocr-data');
  const ocr = createOcr({ dataDir: data, download: async () => { throw new Error('ağ yok'); } });
  const ix = await indexer([{ id: 'r', name: 'R', path: root }], {}, { ocr });
  // Ana süreç dil verisini indirir (burada yerel paketten kopyalar), sonra seçenek açılır
  await ocr.ensureLanguage('tur');
  await ocr.ensureLanguage('eng');
  ix.setSettings({ ocr: { enabled: true, languages: ['tur', 'eng'] } });
  await waitFor(() => ix.search({ q: 'fatura' }).total === 1, 60000);
  const r = ix.search({ q: 'toplam' });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.results[0].source, 'ocr');
  const d = ix.nodeAt('r', 'tabela.png');
  assert.match(d.text, /Fatura toplamı 1250 TL/);
  // Kapatınca yeni resimler yeniden bekler; okunmuş olanlar dizinde kalır
  ix.setSettings({ ocr: { enabled: false } });
  await sign(path.join(root, 'yeni.png'), 'Ikinci resim');
  await waitFor(() => ix.nodeAt('r', 'yeni.png'));
  assert.strictEqual(ix.nodeAt('r', 'yeni.png').node.state, 4);
  assert.strictEqual(ix.search({ q: 'fatura' }).total, 1);
  await ix.close();
});
