'use strict';

// ffmpeg yardımcısı: konuşmadan metne için 16 kHz mono WAV çıkarma.
// ffmpeg yalnız "Ses/videoda konuşmayı metne çevir" açıkken çalıştırılır.

const path = require('path');
const { spawn } = require('child_process');

class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Paketlenmiş uygulamada ikili app.asar.unpacked altındadır
function ffmpegPath() {
  if (process.env.FSR_FFMPEG) return process.env.FSR_FFMPEG;
  return require('ffmpeg-static').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new MediaError('canceled'));
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64000) err = err.slice(-32000); });
    child.stdout.on('data', () => {});
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(new MediaError('ffmpeg_missing', e.message)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new MediaError('canceled'));
      if (code === 0) return resolve(err);
      if (/does not contain any stream|Output file #0 does not contain|matches no streams/i.test(err)) return reject(new MediaError('no_audio'));
      const line = err.split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|invalid|failed|unable|no such/i.test(l)).pop();
      reject(new MediaError('ffmpeg_failed', (line || `exit ${code}`).slice(0, 300)));
    });
  });
}

// Ses/videodan whisper.cpp'nin istediği WAV: 16 kHz, mono, 16 bit
function toSpeechWav(src, out, { signal } = {}) {
  return runFfmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', out], { signal });
}

module.exports = { ffmpegPath, runFfmpeg, toSpeechWav, MediaError };
