// Testlerden önce: better-sqlite3 bu Node sürümü için derli mi? Değilse (ör. "npm start" ya da paketleme öncesi
// Electron için yeniden derlendiyse) Node için yeniden derler. CI'da "npm ci" sonrası zaten uyumludur.
// Denetim ayrı bir süreçte yapılır: uyumsuz yerel modülü bu sürece yüklemek çıkışta çökmeye yol açabilir.
'use strict';

const { spawnSync, execSync } = require('child_process');

const probe = spawnSync(process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:').close()"], { encoding: 'utf8', cwd: __dirname });
if (probe.status !== 0) {
  if (!/NODE_MODULE_VERSION|was compiled against|invalid ELF|not a valid Win32/i.test(probe.stderr || '')) {
    process.stderr.write(probe.stderr || '');
    process.exit(probe.status || 1);
  }
  console.log('better-sqlite3 Node için yeniden derleniyor…');
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
}
