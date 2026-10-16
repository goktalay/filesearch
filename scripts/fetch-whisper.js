// whisper.cpp'nin Windows ikilisini (whisper-cli.exe ve DLL'leri) vendor/whisper altına indirir;
// electron-builder bunu kurulumun resources/whisper klasörüne koyar (package.json → build.extraResources).
// Kaynak: github.com/ggml-org/whisper.cpp releases → whisper-bin-x64.zip (CPU, MIT lisanslı).
// Sürüm FSR_WHISPER_VERSION ile değiştirilebilir; o sürümde dosya yoksa en son sürüm kullanılır.
// Windows dışında (geliştirme) bir şey yapmaz: konuşma için FSR_WHISPER_CLI ile yerel bir whisper-cli gösterin.
'use strict';

const fs = require('fs');
const path = require('path');
const { WHISPER_ZIP_URL } = require('../src/speech');

const dest = path.join(__dirname, '..', 'vendor', 'whisper');
const ASSET = 'whisper-bin-x64.zip';

async function latestUrl() {
  const r = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'file-search', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const j = await r.json();
  const a = (j.assets || []).find((x) => x.name === ASSET);
  if (!a) throw new Error(`${j.tag_name} sürümünde ${ASSET} yok`);
  return a.browser_download_url;
}

(async () => {
  if (process.platform !== 'win32' && !process.env.FSR_FETCH_WHISPER) {
    console.log('fetch-whisper: Windows değil, atlandı');
    return;
  }
  if (fs.existsSync(dest) && fs.readdirSync(dest, { recursive: true }).some((n) => /whisper-cli\.exe$/i.test(n))) {
    console.log('fetch-whisper: zaten var');
    return;
  }
  let res = await fetch(WHISPER_ZIP_URL, { redirect: 'follow' });
  if (!res.ok) {
    console.warn(`fetch-whisper: ${WHISPER_ZIP_URL} → HTTP ${res.status}; en son sürüm deneniyor`);
    res = await fetch(await latestUrl(), { redirect: 'follow' });
  }
  if (!res.ok) throw new Error(`indirme başarısız: HTTP ${res.status}`);
  fs.mkdirSync(dest, { recursive: true });
  const zip = path.join(dest, ASSET);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  await require('extract-zip')(zip, { dir: dest });
  fs.rmSync(zip);
  const found = fs.readdirSync(dest, { recursive: true }).filter((n) => /\.(exe|dll)$/i.test(n));
  if (!found.some((n) => /whisper-cli\.exe$/i.test(n))) throw new Error('whisper-cli.exe bulunamadı: ' + found.join(', '));
  console.log('fetch-whisper:', found.join(', '));
})().catch((e) => { console.error('fetch-whisper:', e.message); process.exit(1); });
