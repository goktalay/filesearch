'use strict';

// Belgelerden metin çıkarma. Ağ ya da harici program kullanılmaz; her şey bu süreçte, bellekte yapılır.
//   düz metin / kod  → kodlama algılanarak (UTF-8, UTF-16, Windows-1254)
//   PDF              → pdf.js (pdfjs-dist, legacy derleme)
//   DOCX/XLSX/PPTX   → ZIP içindeki XML (fflate)   ·   ODT/ODS/ODP → content.xml
//   RTF, HTML, EML   → bu dosyadaki küçük ayrıştırıcılar
// Dönen: { text, title?, meta? }. Metin MAX_TEXT karakterde kesilir.

const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');
const iconv = require('iconv-lite');
const { decode, looksBinary, isValidUtf8 } = require('./encoding');
const { extOf, kindOf } = require('../formats');

const MAX_TEXT = 2 * 1024 * 1024; // karakter

class ExtractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// --- XML/HTML yardımcıları -------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', euro: '€', ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', middot: '·', deg: '°', times: '×' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ''; }
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  let s = String(html);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)\s*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: s, title: title ? decodeEntities(title.replace(/<[^>]+>/g, '')).trim() : undefined };
}

// --- Office Open XML ve OpenDocument -----------------------------------------------------
function unzip(buf, filter) {
  try {
    return unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), { filter: (f) => filter(f.name) });
  } catch (e) {
    throw new ExtractError('corrupt', e.message);
  }
}
const xml = (files, name) => (files[name] ? strFromU8(files[name]) : '');
const byNumber = (a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0);

// Word: paragraflar satır, sekmeler boşluk; üst/alt bilgi, dipnot ve yorumlar da eklenir
function wordXmlText(x) {
  return decodeEntities(
    x.replace(/<w:tab\/>|<w:tab [^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>|<w:cr\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
      .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, '')
      .replace(/<[^>]+>/g, '')
  );
}

function docx(buf) {
  const files = unzip(buf, (n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n) || n === 'docProps/core.xml');
  if (!files['word/document.xml']) throw new ExtractError('corrupt', 'word/document.xml yok');
  const parts = [wordXmlText(xml(files, 'word/document.xml'))];
  for (const n of Object.keys(files).sort()) if (n !== 'word/document.xml' && n.startsWith('word/')) parts.push(wordXmlText(xml(files, n)));
  return { text: parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), title: coreTitle(xml(files, 'docProps/core.xml')) };
}

function coreTitle(core) {
  const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core || '');
  return m ? decodeEntities(m[1]).trim() || undefined : undefined;
}

// Excel: paylaşılan metinler + her sayfanın hücreleri (satır başına sekmeyle)
function xlsx(buf) {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n) || n === 'docProps/core.xml');
  const shared = [];
  const ss = xml(files, 'xl/sharedStrings.xml');
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  }
  const names = [...xml(files, 'xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  const sheets = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort(byNumber);
  if (!sheets.length && !files['xl/workbook.xml']) throw new ExtractError('corrupt', 'xl/workbook.xml yok');
  const out = [];
  sheets.forEach((n, i) => {
    if (names[i]) out.push(`# ${names[i]}`);
    for (const row of xml(files, n).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || '';
        const type = (/\bt="(\w+)"/.exec(attrs) || [])[1];
        let v = '';
        if (type === 's') v = shared[parseInt((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1], 10)] ?? '';
        else if (type === 'inlineStr') v = decodeEntities([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        else v = decodeEntities((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
        if (v !== '') cells.push(v);
      }
      if (cells.length) out.push(cells.join('\t'));
    }
  });
  return { text: out.join('\n'), title: coreTitle(xml(files, 'docProps/core.xml')) };
}

// PowerPoint: slayt metinleri (sırayla) ve konuşmacı notları
function pptx(buf) {
  const files = unzip(buf, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n) || n === 'docProps/core.xml');
  const slides = Object.keys(files).filter((n) => n.startsWith('ppt/slides/')).sort(byNumber);
  if (!slides.length) throw new ExtractError('corrupt', 'slayt yok');
  const para = (x) => decodeEntities(x.replace(/<\/a:p>/g, '\n').replace(/<a:br\/>/g, '\n').replace(/<a:t>([\s\S]*?)<\/a:t>|<[^>]+>/g, (m, t) => t || '')).trim();
  const out = [];
  slides.forEach((n, i) => {
    out.push(para(xml(files, n)));
    const notes = files[`ppt/notesSlides/notesSlide${n.replace(/\D+/g, '')}.xml`];
    if (notes) out.push(para(strFromU8(notes)));
    if (i < slides.length - 1) out.push('');
  });
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), title: coreTitle(xml(files, 'docProps/core.xml')) };
}

function odf(buf) {
  const files = unzip(buf, (n) => n === 'content.xml' || n === 'meta.xml');
  const c = xml(files, 'content.xml');
  if (!c) throw new ExtractError('corrupt', 'content.xml yok');
  const text = decodeEntities(
    c.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, n) => ' '.repeat(Number(n) || 1))
      .replace(/<\/(text:p|text:h|table:table-row)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<[^>]+>/g, '')
  );
  const title = (/<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml(files, 'meta.xml')) || [])[1];
  return { text: text.replace(/\t+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), title: title ? decodeEntities(title) : undefined };
}

// --- RTF ---------------------------------------------------------------------------------
// Grup yığını, \'hh (ANSI kod sayfası \ansicpgN), \uN (Unicode, ardından \ucN yedek karakter atlanır),
// görünmeyen hedefler ({\*\...}, fonttbl, colortbl, stylesheet, info, pict…) atlanır.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'xmlnstbl', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'fldinst', 'bkmkstart', 'bkmkend', 'filetbl']);
function rtf(buf) {
  const s = buf.toString('latin1');
  if (!s.startsWith('{\\rtf')) throw new ExtractError('corrupt', 'RTF değil');
  let cp = (/\\ansicpg(\d+)/.exec(s.slice(0, 2000)) || [])[1] || '1254';
  if (!iconv.encodingExists(`windows-${cp}`) && !iconv.encodingExists(`cp${cp}`)) cp = '1252';
  const enc = iconv.encodingExists(`windows-${cp}`) ? `windows-${cp}` : `cp${cp}`;
  const out = [];
  let bytes = [];
  const flush = () => { if (bytes.length) { out.push(iconv.decode(Buffer.from(bytes), enc)); bytes = []; } };
  const stack = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { stack.push({ skip, uc }); i++; continue; }
    if (ch === '}') { const st = stack.pop(); if (st) { skip = st.skip; uc = st.uc; } i++; continue; }
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === "'") {
        const hex = s.substr(i + 2, 2);
        i += 4;
        if (pendingSkip > 0) { pendingSkip--; continue; }
        if (!skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (nx === '*') { skip = true; i += 2; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) { flush(); out.push(nx); } i += 2; continue; }
      if (nx === '~') { if (!skip) { flush(); out.push(' '); } i += 2; continue; }
      if (nx === '-' || nx === '_') { i += 2; continue; }
      if (nx === '\n' || nx === '\r') { if (!skip) { flush(); out.push('\n'); } i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : null;
      if (RTF_SKIP.has(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'uc') { uc = arg ?? 1; continue; }
      if (word === 'u') {
        flush();
        out.push(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        pendingSkip = uc;
        continue;
      }
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') { flush(); out.push('\n'); continue; }
      if (word === 'tab' || word === 'cell') { flush(); out.push('\t'); continue; }
      if (word === 'emdash') { flush(); out.push('—'); continue; }
      if (word === 'endash') { flush(); out.push('–'); continue; }
      if (word === 'bullet') { flush(); out.push('•'); continue; }
      if (word === 'lquote' || word === 'rquote') { flush(); out.push(word === 'lquote' ? '‘' : '’'); continue; }
      if (word === 'ldblquote' || word === 'rdblquote') { flush(); out.push(word === 'ldblquote' ? '“' : '”'); continue; }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (pendingSkip > 0) { pendingSkip--; i++; continue; }
    if (!skip) bytes.push(s.charCodeAt(i));
    i++;
  }
  flush();
  return { text: out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
}

// --- E-posta (.eml, RFC 5322 / MIME) ---------------------------------------------------------
function decodeWords(s) {
  // Kodlanmamış 8 bitlik başlık (RFC 6532): geçerli UTF-8 ise öyle oku
  let v = String(s);
  if (/[\x80-\xff]/.test(v)) {
    const b = Buffer.from(v, 'latin1');
    if (isValidUtf8(b).ok) v = b.toString('utf8');
  }
  // RFC 2047: =?charset?B|Q?...?=
  return v.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (m, cs, enc, data) => {
    try {
      const b = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : qpDecode(data.replace(/_/g, ' '));
      return iconv.encodingExists(cs) ? iconv.decode(b, cs) : b.toString('utf8');
    } catch { return data; }
  });
}

function qpDecode(s) {
  const out = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function parseHeaders(block) {
  const h = {};
  const lines = block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) {
      const k = l.slice(0, i).trim().toLowerCase();
      if (!(k in h)) h[k] = l.slice(i + 1).trim();
    }
  }
  return h;
}
const param = (header, name) => {
  const m = new RegExp(`${name}\\*?=(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header || '');
  return m ? (m[1] ?? m[2]) : '';
};

function mimePart(raw, depth = 0) {
  const sep = /\r?\n\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : raw;
  const body = sep ? raw.slice(sep.index + sep[0].length) : '';
  const h = parseHeaders(head);
  const ctype = (h['content-type'] || 'text/plain').toLowerCase();
  const res = { plain: [], html: [], attachments: [] };
  if (ctype.startsWith('multipart/') && depth < 8) {
    const boundary = param(h['content-type'], 'boundary');
    if (boundary) {
      const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\s*`));
      for (const p of parts.slice(1)) {
        if (!p.trim()) continue;
        const r = mimePart(p, depth + 1);
        res.plain.push(...r.plain); res.html.push(...r.html); res.attachments.push(...r.attachments);
      }
      return res;
    }
  }
  const disp = h['content-disposition'] || '';
  const fname = decodeWords(param(disp, 'filename') || param(h['content-type'], 'name'));
  const cte = (h['content-transfer-encoding'] || '').toLowerCase();
  if (/attachment/i.test(disp) || (fname && !ctype.startsWith('text/'))) {
    if (fname) res.attachments.push(fname);
    return res;
  }
  if (!ctype.startsWith('text/')) return res;
  const bytes = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : cte === 'quoted-printable' ? qpDecode(body) : Buffer.from(body, 'latin1');
  const cs = param(h['content-type'], 'charset') || 'utf-8';
  const text = iconv.encodingExists(cs) ? iconv.decode(bytes, cs) : bytes.toString('utf8');
  if (ctype.startsWith('text/html')) res.html.push(text); else res.plain.push(text);
  return res;
}

function eml(buf) {
  const raw = buf.toString('latin1');
  const sep = /\r?\n\r?\n/.exec(raw);
  const h = parseHeaders(sep ? raw.slice(0, sep.index) : raw);
  const r = mimePart(raw);
  const body = r.plain.length ? r.plain.join('\n\n') : r.html.map((x) => htmlToText(x).text).join('\n\n');
  const meta = {
    from: decodeWords(h.from || ''), to: decodeWords(h.to || ''), subject: decodeWords(h.subject || ''), date: h.date || '',
    attachments: r.attachments,
  };
  const head = [meta.subject, meta.from && `From: ${meta.from}`, meta.to && `To: ${meta.to}`, meta.date && `Date: ${meta.date}`]
    .filter(Boolean).join('\n');
  const att = r.attachments.length ? `\n\n[${r.attachments.join(', ')}]` : '';
  const clean = body.replace(/\r\n/g, '\n').trim();
  // Kelime bulutu başlık satırları (adresler, tarih) olmadan konu ve gövdeden çıkarılır
  return { text: `${head}\n\n${clean}${att}`, cloudText: `${meta.subject}\n${clean}`, title: meta.subject || undefined, meta };
}

// --- PDF (pdf.js) ------------------------------------------------------------------------------
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdf(buf, { maxPages = 2000 } = {}) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice(),
      useSystemFonts: false, disableFontFace: true, isEvalSupported: false, verbosity: 0, stopAtErrors: false,
    }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new ExtractError('encrypted', 'parola korumalı PDF');
    throw new ExtractError('corrupt', e && e.message);
  }
  try {
    const out = [];
    let len = 0;
    const n = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= n && len < MAX_TEXT; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      const pageText = lines.join('\n');
      out.push(pageText);
      len += pageText.length;
      page.cleanup();
    }
    let title;
    try { title = ((await doc.getMetadata()).info || {}).Title || undefined; } catch { /* yok */ }
    return { text: out.join('\n\n').trim(), title, meta: { pages: doc.numPages } };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// --- Giriş noktası -----------------------------------------------------------------------------
async function extractBuffer(buf, name) {
  const ext = extOf(name);
  const kind = kindOf(name);
  let r;
  if (ext === 'pdf') r = await pdf(buf);
  else if (['docx', 'docm', 'dotx'].includes(ext)) r = docx(buf);
  else if (['xlsx', 'xlsm', 'xltx'].includes(ext)) r = xlsx(buf);
  else if (['pptx', 'pptm', 'potx'].includes(ext)) r = pptx(buf);
  else if (['odt', 'ods', 'odp'].includes(ext)) r = odf(buf);
  else if (ext === 'rtf') r = rtf(buf);
  else if (ext === 'eml') r = eml(buf);
  else if (kind === 'html') r = htmlToText(decode(buf).text);
  else if (kind === 'text' || kind === 'code') {
    if (looksBinary(buf)) throw new ExtractError('binary', 'ikili dosya');
    const d = decode(buf);
    r = { text: d.text, meta: { encoding: d.encoding } };
  } else throw new ExtractError('unsupported', ext);
  if (r.text.length > MAX_TEXT) { r.text = r.text.slice(0, MAX_TEXT); r.truncated = true; }
  return r;
}

async function extractFile(abs, name = abs) {
  const buf = await fs.promises.readFile(abs);
  return extractBuffer(buf, name);
}

const canExtract = (name) => {
  const k = kindOf(name);
  return ['text', 'code', 'pdf', 'word', 'excel', 'powerpoint', 'html', 'email'].includes(k);
};

module.exports = { extractFile, extractBuffer, canExtract, htmlToText, rtf, eml, docx, xlsx, pptx, odf, pdf, decodeEntities, ExtractError, MAX_TEXT };
