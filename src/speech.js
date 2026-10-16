'use strict';

// Konuşmadan metne: whisper.cpp (whisper-cli) yerel ve çevrimdışı çalışır. Convert Master'daki modülün uyarlaması.
// Yalnız Ayarlar › Arama › "Ses/videoda konuşmayı metne çevir" açıkken kullanılır.
// - İkili: kurulumla gelir (resources/whisper; CI'da scripts/fetch-whisper.js indirir). Yoksa ilk açılışta indirilir.
// - Model: ilk açılışta Hugging Face'ten (ggerganov/whisper.cpp) <veri>/models altına indirilir.
// - Giriş: ffmpeg'in çıkardığı 16 kHz mono WAV. Windows'ta whisper-cli ASCII dışı yolları açamayabildiği için
//   çalışma klasöründe göreli ve ASCII adlarla çalışılır.
// İndirme (download/ensureEngine/ensureModel) ana süreçte, tanıma (transcribe) dizinleyici sürecinde yapılır.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { SPEECH_MODELS } = require('./formats');
const { toSpeechWav } = require('./media');

const WHISPER_VERSION = process.env.FSR_WHISPER_VERSION || 'v1.7.6';
const WHISPER_ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const EXE = process.platform === 'win32' ? '.exe' : '';

class SpeechError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function createSpeech({ dataDir, resourcesDir, devDir, fetch: fetchImpl = globalThis.fetch }) {
  const enginesDir = path.join(dataDir, 'engines', 'whisper');
  const modelsDir = path.join(dataDir, 'models');

  // whisper-cli (eski sürümlerde main) dosyasını klasörde özyinelemeli arar
  function findIn(dir, depth = 0) {
    if (!dir || depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const name of [`whisper-cli${EXE}`, `main${EXE}`]) if (entries.some((e) => e.isFile() && e.name === name)) return path.join(dir, name);
    for (const e of entries) if (e.isDirectory()) { const f = findIn(path.join(dir, e.name), depth + 1); if (f) return f; }
    return null;
  }

  function binPath() {
    if (process.env.FSR_WHISPER_CLI) return process.env.FSR_WHISPER_CLI;
    return findIn(resourcesDir && path.join(resourcesDir, 'whisper')) || findIn(devDir) || findIn(enginesDir);
  }

  const modelFile = (name) => path.join(modelsDir, (SPEECH_MODELS[name] || SPEECH_MODELS.base).file);
  const hasModel = (name) => fs.existsSync(modelFile(name));
  const ready = (name) => !!binPath() && hasModel(name);

  function status() {
    const models = {};
    for (const k of Object.keys(SPEECH_MODELS)) {
      let size = 0;
      try { size = fs.statSync(modelFile(k)).size; } catch { /* yok */ }
      models[k] = { installed: size > 0, size };
    }
    return { engine: !!binPath(), canDownloadEngine: process.platform === 'win32', models, modelsDir };
  }

  // URL'yi dosyaya indirir (yarım kalan .part dosyasından devam eder), ilerleme 0..1
  async function download(url, dest, { onProgress, signal } = {}) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* yeni */ }
    const res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
    if (res.status === 416) { await fs.promises.rm(part, { force: true }); return download(url, dest, { onProgress, signal }); }
    if (!res.ok) throw new SpeechError('download_failed', `HTTP ${res.status}`);
    if (res.status !== 206) have = 0; // sunucu devam etmeyi desteklemiyor: baştan
    const len = Number(res.headers.get('content-length')) || 0;
    const total = len ? have + len : 0;
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let got = have;
    let lastTick = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        const now = Date.now();
        if (onProgress && total && now - lastTick > 200) { lastTick = now; onProgress(got / total, got, total); }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && got !== total) throw new SpeechError('download_failed', 'incomplete');
    await fs.promises.rename(part, dest);
    if (onProgress) onProgress(1, got, total || got);
  }

  async function ensureEngine({ onProgress, signal } = {}) {
    if (binPath()) return binPath();
    if (process.platform !== 'win32') throw new SpeechError('engine_missing');
    const zip = path.join(enginesDir, 'whisper-bin-x64.zip');
    await download(WHISPER_ZIP_URL, zip, { onProgress, signal });
    const extract = require('extract-zip');
    await extract(zip, { dir: enginesDir });
    await fs.promises.rm(zip, { force: true });
    const bin = binPath();
    if (!bin) throw new SpeechError('engine_missing');
    return bin;
  }

  async function ensureModel(name, { onProgress, signal } = {}) {
    const file = modelFile(name);
    if (fs.existsSync(file)) return file;
    await download(MODEL_URL((SPEECH_MODELS[name] || SPEECH_MODELS.base).file), file, { onProgress, signal });
    return file;
  }

  async function deleteModel(name) {
    await fs.promises.rm(modelFile(name), { force: true });
    await fs.promises.rm(`${modelFile(name)}.part`, { force: true });
  }

  // Tek whisper-cli çalıştırması; JSON çıktısını döner
  function runWhisper({ bin, model, wav, language, cwd, signal }) {
    return new Promise((resolve, reject) => {
      const threads = String(Math.max(1, Math.min(4, os.cpus().length - 1)));
      const base = path.basename(wav, '.wav');
      const args = ['-m', path.relative(cwd, model), '-f', path.basename(wav), '-l', language || 'auto', '-t', threads, '-oj', '-of', base, '-np'];
      // .js: test için whisper-cli taklidi (Windows .js dosyasını doğrudan çalıştıramaz)
      const child = bin.endsWith('.js')
        ? spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
        : spawn(bin, args, { cwd, windowsHide: true });
      let err = '';
      const onData = (d) => { err += d.toString(); if (err.length > 64000) err = err.slice(-32000); };
      child.stderr.on('data', onData);
      child.stdout.on('data', onData);
      const onAbort = () => child.kill('SIGKILL');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(new SpeechError('engine_missing', e.message)));
      child.on('close', async (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(new SpeechError('canceled'));
        const jsonFile = path.join(cwd, `${base}.json`);
        try {
          if (code !== 0) throw new Error();
          const json = JSON.parse(await fs.promises.readFile(jsonFile, 'utf8'));
          const det = /auto-detected language:\s*([a-z]{2,3})/.exec(err);
          resolve({ json, detected: det ? det[1] : null });
        } catch {
          const lines = err.split(/\r?\n/).filter((l) => /error|failed|unknown|invalid/i.test(l));
          reject(new SpeechError('whisper_failed', (lines.pop() || `exit ${code}`).trim().slice(0, 300)));
        } finally {
          fs.promises.rm(jsonFile, { force: true }).catch(() => {});
        }
      });
    });
  }

  // whisper JSON → [{ start, end, text }] (saniye)
  function segmentsOf(json) {
    const out = [];
    for (const s of json.transcription || []) {
      const text = String(s.text || '').trim();
      if (!text || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(text) || /^\((?:music|silence)\)$/i.test(text)) continue;
      const from = s.offsets ? s.offsets.from / 1000 : 0;
      const to = s.offsets ? s.offsets.to / 1000 : from;
      out.push({ start: +from.toFixed(2), end: +to.toFixed(2), text });
    }
    return out;
  }

  // Ses/video dosyası → { language, text, segments }. workDir: dizinleyicinin geçici klasörü (ASCII yol)
  async function transcribe(src, { model = 'base', language = 'auto', workDir, signal } = {}) {
    const bin = binPath();
    if (!bin || !hasModel(model)) throw new SpeechError('engine_missing');
    await fs.promises.mkdir(workDir, { recursive: true });
    const wav = path.join(workDir, `s${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    try {
      await toSpeechWav(src, wav, { signal });
      const { json, detected } = await runWhisper({ bin, model: modelFile(model), wav, language, cwd: workDir, signal });
      const lang = (json.result && json.result.language) || detected || (language !== 'auto' ? language : '');
      const segments = segmentsOf(json);
      return { language: lang, segments, text: segments.map((s) => s.text).join('\n') };
    } finally {
      await fs.promises.rm(wav, { force: true }).catch(() => {});
    }
  }

  return { download, status, binPath, hasModel, ready, ensureEngine, ensureModel, deleteModel, transcribe, modelFile, _segmentsOf: segmentsOf };
}

module.exports = { createSpeech, SpeechError, WHISPER_ZIP_URL, WHISPER_VERSION };
