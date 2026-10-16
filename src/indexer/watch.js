'use strict';

// Klasör izleme: tek bir yinelemeli fs.watch (Windows'ta ReadDirectoryChangesW — tüm ağaç için tek tanıtıcı).
// Olaylar kısa süre biriktirilir (aynı dosyaya art arda yazma tek değişiklik sayılır) ve göreli yollar
// ("/" ayırıcılı) olarak bildirilir. Hangi değişikliğin ne olduğuna (ekleme/silme/değişme) dizinleyici
// dosyanın o anki durumuna bakarak karar verir; böylece kaçırılan ya da sırası karışan olaylar zarar vermez.
// İzleme düşerse (kök silindi, ağ sürücüsü koptu) onError çağrılır.

const fs = require('fs');
const path = require('path');

function createWatcher(root, { onChanges, onError, debounceMs = 400, maxWaitMs = 3000, filter = () => true } = {}) {
  let w = null;
  let timer = null;
  let firstAt = 0;
  let pending = new Set();
  let closed = false;

  const flush = () => {
    timer = null;
    firstAt = 0;
    if (!pending.size || closed) return;
    const rels = [...pending];
    pending = new Set();
    try { onChanges(rels); } catch { /* dinleyici hatası izlemeyi durdurmaz */ }
  };

  const push = (rel) => {
    if (closed) return;
    if (!filter(rel)) return;
    pending.add(rel);
    const now = Date.now();
    if (!firstAt) firstAt = now;
    clearTimeout(timer);
    // Sürekli yazılan dosyada bile en geç maxWaitMs içinde bildir
    timer = setTimeout(flush, now - firstAt > maxWaitMs ? 0 : debounceMs);
  };

  try {
    w = fs.watch(root, { recursive: true, persistent: true }, (_ev, name) => {
      if (name == null) { push(''); return; } // ne değiştiği bilinmiyor: kökü yeniden tara
      const rel = String(name).split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
      push(rel);
    });
    w.on('error', (e) => {
      if (closed) return;
      close();
      if (onError) onError(e);
    });
  } catch (e) {
    closed = true;
    if (onError) setImmediate(() => onError(e));
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    if (w) { try { w.close(); } catch { /* kapalı */ } w = null; }
  }

  return { close, flush, get active() { return !closed; } };
}

// Hariç tutma kalıpları → eşleyici. "/" içermeyen kalıp yolun herhangi bir parçasıyla (ad), içeren kalıp
// göreli yolun tamamıyla eşleşir. * → ad içinde her şey, ** → klasörler dahil, ? → tek karakter.
// Büyük/küçük harf duyarsız.
function compileExcludes(patterns) {
  const res = [];
  for (const raw of patterns || []) {
    const p = String(raw).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p || p.startsWith('#')) continue;
    let src = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*' && p[i + 1] === '*') { src += '.*'; i++; if (p[i + 1] === '/') i++; }
      else if (c === '*') src += '[^/]*';
      else if (c === '?') src += '[^/]';
      else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    res.push({ part: !p.includes('/'), re: new RegExp(`^${src}$`, 'i') });
  }
  return (rel) => {
    if (!rel) return false;
    const parts = rel.split('/');
    for (const { part, re } of res) {
      if (part) { if (parts.some((x) => re.test(x))) return true; }
      else {
        // Kalıp bir klasörü gösteriyorsa onun altındakiler de hariç
        for (let i = 1; i <= parts.length; i++) if (re.test(parts.slice(0, i).join('/'))) return true;
      }
    }
    return false;
  };
}

// UNC yolu (\\sunucu\paylaşım) ağ sürücüsüdür. Harfle eşlenmiş ağ sürücüleri dizinleyiciye ayrıca bildirilir.
const isUnc = (p) => /^\\\\[^\\?.]/.test(String(p)) || /^\/\/[^/]/.test(String(p));

module.exports = { createWatcher, compileExcludes, isUnc };
