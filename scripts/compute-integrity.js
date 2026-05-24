#!/usr/bin/env node
// compute-integrity.js
// Generates build/integrity-manifest.json with SHA-256 hashes for files that
// must not be tampered with. Read at runtime by electron/security/integrity.js.
// Run AFTER obfuscation, BEFORE packaging.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'integrity-manifest.json');

const TARGETS = [
  'ui/index.html',
  'ui/app.js',
  'ui/activation.html',
  'electron/main.js',
  'electron/preload.js',
  'electron/db.js',
  'electron/security/crypto.js',
  'electron/security/machine.js',
  'electron/security/activation.js',
  'electron/security/integrity.js'
];

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function main() {
  const manifest = {};
  const missing = [];
  for (const rel of TARGETS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    manifest[rel] = hashFile(abs);
  }

  if (missing.length) {
    console.warn('[integrity] missing files (skipped):');
    missing.forEach(m => console.warn('  ' + m));
  }

  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[integrity] wrote ' + path.relative(ROOT, OUT) + ' (' + Object.keys(manifest).length + ' entries)');
  for (const [f, h] of Object.entries(manifest)) {
    console.log('  ' + h.slice(0, 16) + '…  ' + f);
  }
}

main();
