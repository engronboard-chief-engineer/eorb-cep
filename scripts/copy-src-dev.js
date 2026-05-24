#!/usr/bin/env node
// copy-src-dev.js
// Dev-mode counterpart to obfuscate.js. Copies electron-src/**/*.src.js to
// electron/**/*.js as PLAINTEXT (no obfuscation). Used by `npm run dev` so
// the app runs unobfuscated for debugging the activation/fingerprint flow.
//
// Production builds use scripts/obfuscate.js instead.
//
// Output path matches obfuscate.js exactly so package.json `main` field
// always points to electron/main.js.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'electron-src');
const OUT_DIR = path.join(ROOT, 'electron');

function walkSrc(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSrc(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

if (!fs.existsSync(SRC_DIR)) {
  console.error('[copy-src-dev] FATAL: source dir missing:', SRC_DIR);
  process.exit(1);
}

if (fs.existsSync(OUT_DIR)) {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
}
fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0, bytes = 0;
for (const srcPath of walkSrc(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, srcPath);
  const stripped = rel.replace(/\.src\.js$/, '.js');
  const outPath = path.join(OUT_DIR, stripped);
  ensureDir(outPath);
  fs.copyFileSync(srcPath, outPath);
  count++;
  bytes += fs.statSync(outPath).size;
  console.log(`[copy-src-dev] ${rel} -> ${path.relative(ROOT, outPath)}`);
}
console.log(`[copy-src-dev] ${count} files, ${bytes} bytes (PLAINTEXT, dev mode)`);
