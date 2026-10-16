'use strict';

// Konuşmadan metne (whisper-cli taklidiyle, gerçek ffmpeg): varsayılan kapalı; açılınca ses/video metne çevrilip
// aranır. Model ya da motor yoksa dizinleyici hiçbir şey indirmez, dosya beklemede kalır.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const media = require('../src/media');
const { createSpeech } = require('../src/speech');
const { tmp, indexer, waitFor } = require('./helpers');

process.env.FSR_WHISPER_CLI = path.join(__dirname, 'fake-whisper.js');

async function tone(file, sec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await media.runFfmpeg(['-f', 'lavfi', '-i', `sine=duration=${sec}`, '-c:a', 'libmp3lame', file]);
}

test('transcribe: ses dosyası → WAV → segmentler ve dil', async () => {
  const data = tmp('sp');
  const speech = createSpeech({ dataDir: data, fetch: () => { throw new Error('ağ yok'); } });
  fs.mkdirSync(path.join(data, 'models'), { recursive: true });
  fs.writeFileSync(path.join(data, 'models', 'ggml-base.bin'), 'x');
  const src = path.join(tmp('sp-src'), 'kayıt.mp3');
  await tone(src, 10);
  const r = await speech.transcribe(src, { model: 'base', workDir: path.join(data, 'work') });
  assert.strictEqual(r.language, 'tr');
  assert.strictEqual(r.segments.length, 3);
  assert.deepStrictEqual(r.segments[1], { start: 4, end: 8, text: 'Cümle 2 (4 sn).' });
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'work')), [], 'geçici WAV silinir');
  assert.strictEqual(speech.ready('base'), true);
  assert.strictEqual(speech.ready('small'), false);
});

test('dizinleyici: kapalıyken beklemede, açılınca metne çevrilip aranır; model yoksa indirmez', async () => {
  const root = tmp('sp-root');
  await tone(path.join(root, 'toplantı.mp3'), 6);
  const data = tmp('sp-data');
  let fetched = 0;
  const speech = createSpeech({ dataDir: data, fetch: () => { fetched++; throw new Error('ağ yok'); } });
  const ix = await indexer([{ id: 'r', name: 'R', path: root }], {}, { speech });
  assert.strictEqual(ix.nodeAt('r', 'toplantı.mp3').node.state, 5, 'waitSpeech');
  // Açık ama model yok: beklemede kalır, indirme denenmez
  ix.setSettings({ speech: { enabled: true, model: 'base' } });
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(ix.nodeAt('r', 'toplantı.mp3').node.state, 0);
  assert.strictEqual(fetched, 0);
  // Model "indirildi" (ana süreçte): dosya metne çevrilir
  fs.mkdirSync(path.join(data, 'models'), { recursive: true });
  fs.writeFileSync(path.join(data, 'models', 'ggml-base.bin'), 'x');
  ix.setSettings({ speech: { enabled: true, model: 'base' } });
  await waitFor(() => ix.search({ q: 'cümle' }).total === 1, 30000);
  const d = ix.nodeAt('r', 'toplantı.mp3');
  assert.strictEqual(d.node.source, 'speech');
  assert.strictEqual(d.node.lang, 'tr');
  await ix.close();
});
