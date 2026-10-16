'use strict';

// Akıllı arama sorgusu: serbest metin → FTS5 ifadesi.
//   kelime          → ad ya da içerikte; önek (≥3 harf), Türkçe/İngilizce kök ve katlanmış biçim ("sehir" = "şehirlerde")
//   "tam ifade"     → içerikte ya da adda, kelimeler yan yana ve bu sırada
//   -kelime         → bu kelimeyi içermeyenler
//   bulanık         → kelime dizinde yoksa sözlükteki yakın yazımlar (Damerau-Levenshtein ≤ 1, uzun kelimede ≤ 2)
// Ayrıca sonuç metninden vurgulu parça (snippet) üretir.

const { words, fold, stemsForQuery, isStop } = require('./text');

// Sorguyu parçala: { terms: [ham], phrases: [[ham...]], excludes: [ham] }
function parse(q) {
  const out = { terms: [], phrases: [], excludes: [] };
  const s = String(q || '').slice(0, 500);
  const re = /(-)?"([^"]*)"?|(-)?(\S+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) {
      const ws = words(m[2]).map((w) => w.raw);
      if (!ws.length) continue;
      if (m[1]) out.excludes.push(...ws);
      else if (ws.length === 1) out.terms.push(ws[0]);
      else out.phrases.push(ws);
    } else {
      const ws = words(m[4]).map((w) => w.raw);
      if (m[3]) out.excludes.push(...ws);
      else out.terms.push(...ws);
    }
  }
  return out;
}

// FTS5 dizgesi: çift tırnak içinde, iç tırnaklar ikilenir
const lit = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Tek kelimenin eşleşme ifadesi (alternatif yazımlar verilirse onlar da eklenir)
function termExpr(raw, alts = []) {
  const f = fold(raw);
  const parts = new Set();
  const prefix = f.length >= 3 && !/^\d+$/.test(f);
  parts.add(`name : ${lit(f)}${prefix ? ' *' : ''}`);
  parts.add(`body : ${lit(f)}${prefix ? ' *' : ''}`);
  for (const st of stemsForQuery(raw)) if (st) parts.add(`stems : ${lit(st)}`);
  for (const a of alts) {
    parts.add(`body : ${lit(a)}`);
    parts.add(`name : ${lit(a)}`);
    parts.add(`stems : ${lit(a)}`);
  }
  return `(${[...parts].join(' OR ')})`;
}

function phraseExpr(ws) {
  const p = lit(ws.map(fold).join(' ')); // tek dizgedeki kelimeler FTS5'te ifade (yan yana) olarak aranır
  return `(body : ${p} OR name : ${p})`;
}

// FTS5 ifadesi. alts: kelime (katlanmış) → bulanık eşleşmeler
function build(parsed, alts = {}) {
  const pos = [];
  for (const t of parsed.terms) pos.push(termExpr(t, alts[fold(t)] || []));
  for (const p of parsed.phrases) pos.push(phraseExpr(p));
  if (!pos.length) return null;
  let expr = pos.join(' AND ');
  for (const x of parsed.excludes) {
    const f = fold(x);
    expr = `(${expr}) NOT (name : ${lit(f)} OR body : ${lit(f)} OR ${stemsForQuery(x).map((s) => `stems : ${lit(s)}`).join(' OR ')})`;
  }
  return expr;
}

// --- Bulanık eşleşme ------------------------------------------------------------------------
// Sınırlı Damerau-Levenshtein (komşu harf yer değiştirme 1 sayılır); max'ı aşınca erken çıkar
function distance(a, b, max) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

const maxEdits = (len) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

// Sözlükte (vocab: [{ term, doc }]) kelimeye yakın yazımlar; en sık geçenler önce
function fuzzyCandidates(word, vocab, limit = 6) {
  const f = fold(word);
  const max = maxEdits(f.length);
  if (!max) return [];
  const out = [];
  for (const v of vocab) {
    if (v.term === f) continue;
    const d = distance(f, v.term, max);
    if (d <= max) out.push({ term: v.term, d, doc: v.doc });
  }
  out.sort((a, b) => a.d - b.d || b.doc - a.doc);
  return out.slice(0, limit).map((x) => x.term);
}

// --- Vurgulu parça ----------------------------------------------------------------------------
// Sorgu kelimelerinin katlanmış ve kök biçimleri (ve bulanık eşleşmeler); bir kelime bunlardan birine
// eşitse ya da (≥3 harfli kelimede) onunla başlıyorsa vurgulanır.
function matcher(parsed, alts = {}) {
  const exact = new Set();
  const prefixes = new Set();
  const stems = new Set();
  const add = (raw) => {
    const f = fold(raw);
    if (!f) return;
    exact.add(f);
    if (f.length >= 3) prefixes.add(f);
    for (const s of stemsForQuery(raw)) if (s.length >= 2) stems.add(s);
    for (const a of alts[f] || []) exact.add(a);
  };
  parsed.terms.forEach(add);
  parsed.phrases.forEach((p) => p.forEach(add));
  const { stem } = require('./text');
  return (raw) => {
    const f = fold(raw);
    if (exact.has(f)) return true;
    for (const p of prefixes) if (f.startsWith(p)) return true;
    if (f.length >= 3 && !isStop(f)) {
      if (stems.has(stem(raw, 'tr')) || stems.has(stem(raw, 'en'))) return true;
    }
    return false;
  };
}

// Metinden ~len karakterlik parça: en çok eşleşme içeren pencere. Dönen: [{ t, m }] (m: vurgulu)
function snippet(text, isMatch, { len = 220, scanLimit = 400000 } = {}) {
  const src = String(text || '');
  const ws = words(src.length > scanLimit ? src.slice(0, scanLimit) : src);
  const hits = [];
  for (let i = 0; i < ws.length; i++) if (isMatch(ws[i].raw)) hits.push(i);
  let start = 0;
  if (hits.length) {
    // En çok farklı eşleşmeyi kapsayan pencereyi bul (iki işaretçi)
    let best = hits[0];
    let bestN = 0;
    let j = 0;
    for (let i = 0; i < hits.length; i++) {
      while (ws[hits[i]].end - ws[hits[j]].start > len) j++;
      if (i - j + 1 > bestN) { bestN = i - j + 1; best = hits[j]; }
    }
    start = Math.max(0, ws[best].start - Math.round(len * 0.25));
    // Kelime ortasından başlama
    while (start > 0 && /[\p{L}\p{N}]/u.test(src[start - 1])) start--;
  }
  let end = Math.min(src.length, start + len);
  while (end < src.length && /[\p{L}\p{N}]/u.test(src[end])) end++;
  const piece = src.slice(start, end);
  const parts = [];
  let pos = 0;
  for (const w of words(piece)) {
    if (!isMatch(w.raw)) continue;
    if (w.start > pos) parts.push({ t: piece.slice(pos, w.start), m: false });
    parts.push({ t: w.raw, m: true });
    pos = w.end;
  }
  if (pos < piece.length) parts.push({ t: piece.slice(pos), m: false });
  const clean = (s) => s.replace(/\s+/g, ' ');
  const out = parts.map((p) => ({ t: clean(p.t), m: p.m }));
  if (start > 0 && out.length) out[0].t = `…${out[0].t.replace(/^\s+/, '')}`;
  if (end < src.length && out.length) out[out.length - 1].t = `${out[out.length - 1].t.replace(/\s+$/, '')}…`;
  return { parts: out, hits: hits.length };
}

// Sorguda en az bir anlamlı (durak olmayan ya da tırnaklı) kelime var mı
const hasContent = (parsed) => parsed.phrases.length > 0 || parsed.terms.some((t) => !isStop(fold(t)) || parsed.terms.length === 1);

module.exports = { parse, build, termExpr, phraseExpr, distance, fuzzyCandidates, matcher, snippet, hasContent, maxEdits, lit };
