'use strict';

// Metin dosyalarının kodlamasını algılar ve çözer: UTF-8 (BOM'lu/BOM'suz), UTF-16 LE/BE (BOM'lu ya da
// sıfır bayt deseninden), aksi halde Windows-1254 (Türkçe; Batı Avrupa harfleri Windows-1252 ile aynıdır).

const iconv = require('iconv-lite');

function isValidUtf8(buf, limit = buf.length) {
  let i = 0;
  let multi = false;
  const n = Math.min(limit, buf.length);
  while (i < n) {
    const c = buf[i];
    if (c < 0x80) { i++; continue; }
    let need;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else return { ok: false, multi };
    // Örnek sınırında kesilmiş karakter geçersiz sayılmaz
    if (i + need >= n && n < buf.length) return { ok: true, multi: true };
    for (let k = 1; k <= need; k++) {
      if (i + k >= buf.length) return { ok: i + k >= n, multi };
      if ((buf[i + k] & 0xc0) !== 0x80) return { ok: false, multi };
    }
    multi = true;
    i += need + 1;
  }
  return { ok: true, multi };
}

// UTF-16 sezgisi: ASCII ağırlıklı metinde baytların yarısı sıfırdır
function utf16Guess(buf) {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++;
    if (buf[i + 1] === 0) odd++;
  }
  const half = n / 2;
  if (odd > half * 0.4 && even < half * 0.05) return 'utf16le';
  if (even > half * 0.4 && odd < half * 0.05) return 'utf16be';
  return null;
}

function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: 'utf8', bom: 3 };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: 'utf16le', bom: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: 'utf16be', bom: 2 };
  const u16 = utf16Guess(buf);
  if (u16) return { encoding: u16, bom: 0 };
  if (isValidUtf8(buf, 1024 * 1024).ok) return { encoding: 'utf8', bom: 0 };
  return { encoding: 'windows-1254', bom: 0 };
}

function decode(buf, forced) {
  const { encoding, bom } = forced ? { encoding: forced, bom: 0 } : detectEncoding(buf);
  const body = bom ? buf.subarray(bom) : buf;
  let text;
  if (encoding === 'utf8') text = body.toString('utf8');
  else if (encoding === 'utf16le') text = body.toString('utf16le');
  else text = iconv.decode(body, encoding);
  return { text: text.replace(/\u0000/g, ''), encoding };
}

// İkili dosya mı? (ilk 8 KB'ta sıfır bayt ve UTF-16 deseni yok)
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  if (utf16Guess(buf)) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

module.exports = { detectEncoding, decode, looksBinary, isValidUtf8 };
