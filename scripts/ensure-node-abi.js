// Testlerden önce: better-sqlite3 bu Node sürümü için derli mi? Değilse (ör. "npm start" öncesi Electron için
// yeniden derlendiyse) Node için yeniden derler. CI'da "npm ci" sonrası zaten uyumludur.
'use strict';

const { execSync } = require('child_process');

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (e) {
  if (!/NODE_MODULE_VERSION|was compiled against|invalid ELF|not a valid Win32/i.test(String(e && e.message))) throw e;
  console.log('better-sqlite3 Node için yeniden derleniyor…');
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
}
