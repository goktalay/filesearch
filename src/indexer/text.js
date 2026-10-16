'use strict';

// Metin işleme: kelimelere ayırma, katlama (büyük/küçük harf ve aksan), kök bulma (Türkçe ve İngilizce,
// Snowball), dil tahmini ve durak kelimeler. Hem dizinleme hem sorgu aynı işlevleri kullanır; böylece
// "şehirlerde" ile dizinlenen belge "sehir", "şehir" ya da "şehirler" yazılınca da bulunur.

const snowball = require('snowball-stemmers');

const trStemmer = snowball.newStemmer('turkish');
const enStemmer = snowball.newStemmer('english');

// Harf, işaret ve rakam dizileri; kesme işaretinde bölünür ("İstanbul'da" → "İstanbul", "da")
const WORD_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const MAX_WORD = 40;

// Türkçe yazımda büyük I/İ harflerini doğru küçült; diğer dillerde I → i
function lower(s, lang) {
  return lang === 'tr' ? s.toLocaleLowerCase('tr') : s.replace(/İ/g, 'i').toLowerCase();
}

// Arama biçimi: küçük harf, aksansız, ı → i ("Şehir" → "sehir", "KİTAPLIK" → "kitaplik")
const EXTRA = { ı: 'i', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd', ł: 'l', ß: 'ss', þ: 'th', ð: 'd' };
const ASCII = /^[\x00-\x7f]*$/;
function fold(s) {
  if (ASCII.test(s)) return s.toLowerCase(); // hızlı yol
  return String(s)
    .replace(/İ/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ıøæœđłßþð]/g, (c) => EXTRA[c]);
}

// Kelimeler: { raw, start, end } (raw orijinal yazım)
function words(text, max = Infinity) {
  const out = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(text)) && out.length < max) {
    const raw = m[0];
    if (raw.length > MAX_WORD) continue;
    out.push({ raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

const isNumber = (w) => /^[\p{N}_]+$/u.test(w);

// Kök (arama biçiminde). Sayılar ve çok kısa kelimeler olduğu gibi kalır. Sık kelimeler önbellekten gelir.
const stemCache = new Map();
function stem(word, lang) {
  const ck = `${lang}|${word}`;
  const hit = stemCache.get(ck);
  if (hit !== undefined) return hit;
  const l = lower(word, lang);
  let r;
  if (l.length < 3 || isNumber(l)) r = fold(l);
  else if (lang === 'tr') r = fold(trStemmer.stem(l));
  else if (lang === 'en') r = enStemmer.stem(fold(l));
  else r = fold(l);
  if (stemCache.size > 100000) stemCache.clear();
  stemCache.set(ck, r);
  return r;
}

// Sorgudaki bir terimin olası kökleri (dil bilinmediği için ikisi de)
function stemsForQuery(word) {
  const set = new Set([stem(word, 'tr'), stem(word, 'en')]);
  return [...set].filter(Boolean);
}

// --- Durak kelimeler ----------------------------------------------------------------
// Kelime bulutunda ve dil tahmininde kullanılır (arama dizininden çıkarılmaz; tırnaklı ifade aramasında gerekir)
const STOP_TR = `acaba ama ancak artık aslında az bana bazen bazı belki ben beni benim beri bile bir birçok biri birkaç birşey biz bize bizi
bizim böyle böylece bu buna bunda bundan bunu bunun burada çok çünkü da daha dahi de defa değil diğer diye dolayı en fakat gibi göre
hala halde hangi hatta hem henüz hep hepsi her herhangi herkes hiç hiçbir için ile ilgili ise işte itibaren kadar karşın kendi kendine
ki kim kime kimi kimse mı mi mu mü nasıl ne neden nedenle nerde nerede nereye niye niçin o olan olarak oldu olduğu olduğunu olduklarını
olmadı olmak olması olmayan olmaz olsa olsun olup olur olursa oluyor on ona ondan onlar onlardan onları onların onu onun orada öyle
pek rağmen sadece sanki şey şeyi şimdi siz size sizi sizin şöyle şu şuna şunda şundan şunu tarafından tüm üzere var vardı ve veya ya
yani yapacak yapılan yapılması yapıyor yapmak yaptı yaptığı yaptığını yerine yine yok yoksa zaten ayrıca bunlar şunlar sonra önce
arasında başka bütün bazıları birlikte gerek gereken içinde dışında üzerinde altında olduğunu ediyor etti eden etmek yapılır edilir
olacak olabilir olmuş idi imiş ise iken diye çok az daha sizler onlara ona bunları şunları kez adet tane ile`;

const STOP_EN = `a about above after again against all am an and any are aren't as at be because been before being below between both but by
can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his
how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over
own same she should so some such than that the their theirs them themselves then there these they this those through to too under
until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also may might
must shall upon us via etc yes one two get got use used using new like within without however therefore thus per`;

const STOP = new Set([...STOP_TR.split(/\s+/), ...STOP_EN.split(/\s+/)].filter(Boolean).map(fold));
const STOP_TR_SET = new Set(STOP_TR.split(/\s+/).filter(Boolean).map(fold));
const STOP_EN_SET = new Set(STOP_EN.split(/\s+/).filter(Boolean).map(fold));

const isStop = (foldedWord) => STOP.has(foldedWord);

// --- Dil tahmini (tr / en / '') -----------------------------------------------------
// İlk ~4000 kelimede durak kelime oranı ve Türkçeye özgü harfler
function detectLanguage(text) {
  const sample = String(text).slice(0, 40000);
  const ws = words(sample, 4000);
  if (ws.length < 5) return /[ğşıİĞŞ]/.test(sample) ? 'tr' : '';
  let tr = 0;
  let en = 0;
  for (const w of ws) {
    const f = fold(w.raw);
    if (STOP_TR_SET.has(f)) tr++;
    if (STOP_EN_SET.has(f)) en++;
  }
  const special = (sample.match(/[ğşıİĞŞ]/g) || []).length;
  tr += special / 4;
  if (tr < 2 && en < 2) return '';
  return tr >= en ? 'tr' : 'en';
}

// --- Dizin biçimleri -----------------------------------------------------------------
// FTS5'e verilecek iki metin: katlanmış kelimeler (önek ve tam ifade araması) ve kökler (çekimden bağımsız arama)
function indexForms(text, lang) {
  const ws = words(text);
  const folded = new Array(ws.length);
  const stems = new Array(ws.length);
  for (let i = 0; i < ws.length; i++) {
    const raw = ws[i].raw;
    folded[i] = fold(raw);
    stems[i] = lang ? stem(raw, lang) : folded[i];
    // Dil bilinmiyorsa iki dilin kökünü de ekle (yalnız farklılarsa)
    if (!lang && folded[i].length >= 4 && !isNumber(folded[i])) {
      const a = stem(raw, 'tr');
      const b = stem(raw, 'en');
      stems[i] = a === b ? a : `${a} ${b}`;
    }
  }
  return { body: folded.join(' '), stems: stems.join(' '), count: ws.length };
}

// Dosya adı: "Rapor_2024-final.docx" → "rapor 2024 final docx" (+ kökler)
function nameForms(name) {
  const base = String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
  const ws = words(base).map((w) => w.raw);
  return {
    name: ws.map(fold).join(' '),
    stems: ws.map((w) => [...new Set([stem(w, 'tr'), stem(w, 'en')])].join(' ')).join(' '),
  };
}

// --- Kelime bulutu ---------------------------------------------------------------------
// Belgenin en sık kelimeleri: kök başına sayılır, gösterilen biçim o kökün en sık yazımıdır.
// Durak kelimeler, sayılar ve 3 harften kısa kelimeler çıkarılır.
function topTerms(text, lang, limit = 40) {
  const counts = new Map(); // kök → { n, forms: Map(biçim → n) }
  // E-posta ve web adresleri sayılmaz (boşlukla ayrılmış parçalar tek tek denetlenir: uzun metinde geri izleme olmaz)
  const clean = String(text).replace(/\S+/g, (tok) => (tok.length < 300 && (tok.includes('@') || /^[("'<]?(?:https?:|ftp:|www\.)/i.test(tok)) ? ' ' : tok));
  for (const w of words(clean, 200000)) {
    const l = lower(w.raw, lang);
    const f = fold(l);
    if (f.length < 3 || isNumber(f) || isStop(f)) continue;
    const key = lang ? stem(w.raw, lang) : f;
    if (key.length < 2 || isStop(key)) continue;
    let e = counts.get(key);
    if (!e) counts.set(key, (e = { n: 0, forms: new Map() }));
    e.n++;
    e.forms.set(l, (e.forms.get(l) || 0) + 1);
  }
  const out = [];
  for (const [key, e] of counts) {
    let best = '';
    let bn = -1;
    for (const [form, n] of e.forms) if (n > bn || (n === bn && form.length < best.length)) { best = form; bn = n; }
    out.push({ key, term: best, n: e.n });
  }
  out.sort((a, b) => b.n - a.n || a.term.localeCompare(b.term));
  return out.slice(0, limit);
}

module.exports = { words, fold, lower, stem, stemsForQuery, detectLanguage, indexForms, nameForms, topTerms, isStop, isNumber };
