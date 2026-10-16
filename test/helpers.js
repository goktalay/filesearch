'use strict';

// Test yardımcıları: geçici klasör, dosya yazma, dizinleyici kurma ve bekleme

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Indexer } = require('../src/indexer/engine');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `fsr-${name}-`));

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

async function indexer(records, settings = {}, extra = {}) {
  const ix = new Indexer({ dataDir: tmp('data'), settings, log: () => {}, ...extra });
  ix.setRecords(records);
  await ix.idle();
  return ix;
}

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 40));
  }
};

const names = (r) => r.results.map((x) => x.name).sort();

module.exports = { tmp, writeTree, indexer, waitFor, names };
