'use strict';

// Testler ve örnek veri için küçük belge üreticileri (gerçek kişisel veri yok)

const { zipSync, strToU8 } = require('fflate');

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

const core = (title) => `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEsc(title || '')}</dc:title></cp:coreProperties>`;

function docx(paragraphs, { title } = {}) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join('');
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    'docProps/core.xml': core(title),
  });
}

function xlsx(sheets) {
  // sheets: { Ad: [[hücre, ...], ...] } — metinler paylaşılan tabloda, sayılar doğrudan
  const shared = [];
  const idx = (s) => { let i = shared.indexOf(s); if (i < 0) { i = shared.length; shared.push(s); } return i; };
  const files = { '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' };
  const names = Object.keys(sheets);
  names.forEach((name, n) => {
    const rows = sheets[name].map((row, r) => `<row r="${r + 1}">${row.map((v) => (typeof v === 'number' ? `<c><v>${v}</v></c>` : `<c t="s"><v>${idx(String(v))}</v></c>`)).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join('')}</sst>`;
  return zip(files);
}

function pptx(slides) {
  // slides: [{ title, body, notes }]
  const files = { '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' };
  const para = (t) => `<a:p><a:r><a:t>${xmlEsc(t)}</a:t></a:r></a:p>`;
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${para(s.title)}${(s.body || []).map(para).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    if (s.notes) files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = `<?xml version="1.0"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${para(s.notes)}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  });
  return zip(files);
}

// Tek sayfalı, metin içeren geçerli PDF (Helvetica, WinAnsi; yalnız Latin-1 harfler)
function pdf(lines, { title } = {}) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((l) => `(${esc(l)}) '`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${esc(title || '')}) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// RTF: Türkçe harfler \'hh (Windows-1254) ve \uN ile
function rtf(text) {
  const body = [...text].map((c) => {
    const n = c.charCodeAt(0);
    if (c === '\n') return '\\par\n';
    if (n < 128) return c.replace(/[\\{}]/g, (x) => `\\${x}`);
    return `\\u${n > 32767 ? n - 65536 : n}?`;
  }).join('');
  return Buffer.from(`{\\rtf1\\ansi\\ansicpg1254\\deff0{\\fonttbl{\\f0 Calibri;}}{\\*\\generator Test;}\\f0\\fs22 ${body}\\par}`, 'latin1');
}

// E-posta: çok parçalı, quoted-printable gövde, RFC 2047 konu, ek
function eml({ from, to, subject, body, html, attachment }) {
  const b = 'sinir-123';
  const qp = Buffer.from(body, 'utf8').toString('latin1').replace(/[^\x20-\x7e\n]|=/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const subj = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const u8 = (x) => Buffer.from(String(x), 'utf8').toString('latin1'); // 8 bitlik başlık (RFC 6532)
  let s = `From: ${u8(from)}\r\nTo: ${u8(to)}\r\nSubject: ${subj}\r\nDate: Thu, 15 Oct 2026 10:00:00 +0300\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n`;
  s += `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp.replace(/\n/g, '\r\n')}\r\n`;
  if (html) s += `--${b}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
  if (attachment) s += `--${b}\r\nContent-Type: application/pdf; name="${attachment}"\r\nContent-Disposition: attachment; filename="${attachment}"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n`;
  s += `--${b}--\r\n`;
  return Buffer.from(s, 'latin1');
}

module.exports = { docx, xlsx, pptx, pdf, rtf, eml, zip };
