// test/*.test.js dosyalarını node:test ile çalıştırır (Node 20'de --test kabuk desenini açmaz; tüm sürümlerde aynı davranış)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...files], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status == null ? 1 : r.status);
