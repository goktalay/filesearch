#!/usr/bin/env node
'use strict';

// Testler için whisper-cli taklidi: aynı bayrakları alır, ilerleme yazar ve -of <ad>.json üretir.
// WAV süresine göre her 4 saniyede bir cümle; dil -l ile verilmezse "tr".

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const wav = get('-f');
const out = get('-of');
const lang = get('-l') === 'auto' ? (process.env.FAKE_WHISPER_LANG || 'tr') : get('-l');
if (!wav || !out || !fs.existsSync(get('-m'))) { console.error('error: failed to open model or input'); process.exit(2); }
const bytes = fs.statSync(wav).size - 44;
const dur = Math.max(0, bytes / 32000);
// FAKE_WHISPER_SENTENCES: örnek cümlelerin JSON dizisi (tanıtım görüntüleri için); yoksa "Cümle n"
let sample = null;
try { sample = JSON.parse(fs.readFileSync(process.env.FAKE_WHISPER_SENTENCES, 'utf8')); } catch { /* yok */ }
const segs = [];
for (let s = 0; s < dur; s += 4) {
  const e = Math.min(dur, s + 4);
  const text = sample ? sample[segs.length % sample.length] : `Cümle ${segs.length + 1} (${s.toFixed(0)} sn).`;
  segs.push({ timestamps: { from: '', to: '' }, offsets: { from: Math.round(s * 1000), to: Math.round(e * 1000) }, text: ` ${text}` });
}
for (const p of [0, 25, 50, 75, 100]) process.stderr.write(`whisper_print_progress_callback: progress = ${String(p).padStart(3)}%\n`);
if (get('-l') === 'auto') process.stderr.write(`whisper_full_with_state: auto-detected language: ${lang} (p = 0.97)\n`);
fs.writeFileSync(path.resolve(out + '.json'), JSON.stringify({ result: { language: lang }, transcription: segs }));
