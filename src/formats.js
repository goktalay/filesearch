// Dosya türleri: uzantı → tür. Ana süreç, dizinleyici ve pencereler ortak kullanır.
(function (root) {
  'use strict';

  const KINDS = {
    text: { color: '#94a3b8', exts: ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'properties', 'srt', 'vtt', 'tex', 'rst', 'nfo', 'env'] },
    code: { color: '#a78bfa', exts: ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'cmd', 'ps1', 'sql', 'css', 'scss', 'less', 'vue', 'svelte', 'kt', 'swift', 'm', 'r', 'pl', 'lua', 'dart', 'scala', 'vb', 'vbs', 'asm', 'gradle', 'make', 'cmake', 'dockerfile'] },
    pdf: { color: '#f87171', exts: ['pdf'] },
    word: { color: '#60a5fa', exts: ['docx', 'docm', 'dotx', 'odt', 'rtf'] },
    excel: { color: '#34d399', exts: ['xlsx', 'xlsm', 'xltx', 'ods'] },
    powerpoint: { color: '#fb923c', exts: ['pptx', 'pptm', 'potx', 'odp'] },
    html: { color: '#22d3ee', exts: ['html', 'htm', 'xhtml', 'mht'] },
    email: { color: '#fbbf24', exts: ['eml'] },
    image: { color: '#f472b6', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'svg', 'ico', 'avif'] },
    audio: { color: '#2dd4bf', exts: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr'] },
    video: { color: '#c084fc', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'flv', '3gp', 'ts', 'mts'] },
    archive: { color: '#a8a29e', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab'] },
    other: { color: '#64748b', exts: [] },
  };

  // .ts hem kod (TypeScript) hem video (MPEG-TS) olabilir; kod sayılır
  const EXT_KIND = {};
  for (const k of ['archive', 'video', 'audio', 'image', 'email', 'html', 'powerpoint', 'excel', 'word', 'pdf', 'text', 'code']) {
    for (const e of KINDS[k].exts) EXT_KIND[e] = k;
  }

  // İçeriği metin olarak okunan türler
  const TEXT_KINDS = ['text', 'code', 'pdf', 'word', 'excel', 'powerpoint', 'html', 'email'];
  // OCR'nin okuyabildiği resimler (Tesseract: PNG, JPEG, BMP, TIFF, GIF, WebP)
  const OCR_EXTS = ['jpg', 'jpeg', 'png', 'bmp', 'tif', 'tiff', 'gif', 'webp'];
  // Konuşmadan metne: ses ve video
  const SPEECH_KINDS = ['audio', 'video'];
  // Pencerede doğrudan gösterilebilen/oynatılabilenler (Chromium)
  const PREVIEW = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif'],
    audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus'],
    video: ['mp4', 'webm', 'm4v', 'mov', 'ogv'],
  };

  const OCR_LANGS = ['tur', 'eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'rus', 'ara', 'chi_sim', 'jpn', 'kor'];
  const OCR_ISO = { tur: 'tr', eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', rus: 'ru', ara: 'ar', chi_sim: 'zh', jpn: 'ja', kor: 'ko' };
  const SPEECH_MODELS = {
    tiny: { file: 'ggml-tiny.bin', mb: 75 },
    base: { file: 'ggml-base.bin', mb: 142 },
    small: { file: 'ggml-small.bin', mb: 466 },
    'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547 },
  };
  const SPEECH_LANGS = ['auto', 'tr', 'en', 'de', 'fr', 'es', 'it', 'ar', 'ru', 'zh'];

  // Kayıt renk paleti
  const COLORS = ['#22d3ee', '#6366f1', '#a855f7', '#f472b6', '#f87171', '#fb923c', '#fbbf24', '#34d399', '#2dd4bf', '#60a5fa', '#94a3b8'];

  // Yeni kayıtta önerilen hariç tutma kalıpları
  const DEFAULT_EXCLUDES = ['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information', '~$*', '*.tmp', 'Thumbs.db', 'desktop.ini'];

  function extOf(name) {
    const s = String(name);
    const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
    const i = base.lastIndexOf('.');
    if (i <= 0) return base.toLowerCase() === 'dockerfile' || base.toLowerCase() === 'makefile' ? 'make' : '';
    return base.slice(i + 1).toLowerCase();
  }
  const kindOf = (name) => EXT_KIND[extOf(name)] || 'other';

  const api = { KINDS, EXT_KIND, TEXT_KINDS, OCR_EXTS, SPEECH_KINDS, PREVIEW, OCR_LANGS, OCR_ISO, SPEECH_MODELS, SPEECH_LANGS, COLORS, DEFAULT_EXCLUDES, extOf, kindOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FORMATS = api;
})(typeof self !== 'undefined' ? self : this);
