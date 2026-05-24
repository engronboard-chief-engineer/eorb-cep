#!/usr/bin/env node
// obfuscate.js
// Production JS obfuscation pass.
// SOURCE: electron-src/**/*.src.js  (plaintext, hand-edited, in git)
// OUTPUT: electron/**/*.js          (obfuscated, gitignored, regenerated each build)
//
// CRITICAL: never overwrites source. The previous in-place version destroyed
// the entire source tree on 2026-05-24. See feedback_electron-obfuscate-in-place
// in user memory. Source and output paths MUST be distinct.
//
// Also exports obfuscateBrowserString() so the PWA + Portable build scripts can
// share the BROWSER_OPTIONS profile.

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'electron-src');
const OUT_DIR = path.join(ROOT, 'electron');

// Base options - safe for Node main process (Electron's electron/*.js).
// selfDefending + disableConsoleOutput call process.exit() under Node, so they
// MUST stay false here. See feedback_electron-obfuscator-selfdefending memory.
const DEFAULT_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayThreshold: 0.85,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
};

// Stricter options for browser/renderer JS (ui/app.js, PWA, Portable).
// Safe in browser because there's no process.exit().
const BROWSER_OPTIONS = {
  ...DEFAULT_OPTIONS,
  selfDefending: true,
  disableConsoleOutput: true
};

function obfuscateString(code, extraOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...extraOptions };
  return JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
}

function obfuscateBrowserString(code, extraOptions = {}) {
  const opts = { ...BROWSER_OPTIONS, ...extraOptions };
  return JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
}

function walkSrc(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSrc(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function srcToOut(srcAbsPath) {
  const rel = path.relative(SRC_DIR, srcAbsPath);
  // Strip the .src suffix: foo.src.js -> foo.js
  const stripped = rel.replace(/\.src\.js$/, '.js');
  return path.join(OUT_DIR, stripped);
}

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function runStandalone() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('[obfuscate] FATAL: source dir missing:', SRC_DIR);
    process.exit(1);
  }

  // Wipe the output dir so we never carry stale .js files from a removed source.
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allSrc = walkSrc(SRC_DIR);
  let totalIn = 0, totalOut = 0, count = 0;

  for (const srcPath of allSrc) {
    const base = path.basename(srcPath);

    // _watermark.js: copy through plaintext, never obfuscate.
    // build-watermark.js patches it per-customer; obfuscating it would defeat
    // that and could also break the require() shape used by activation.
    if (base === '_watermark.js') {
      const outPath = path.join(OUT_DIR, path.relative(SRC_DIR, srcPath));
      ensureDir(outPath);
      fs.copyFileSync(srcPath, outPath);
      const sz = fs.statSync(outPath).size;
      totalIn += sz; totalOut += sz;
      console.log(`[obfuscate:copy] ${path.relative(ROOT, srcPath).padEnd(50)} -> ${path.relative(ROOT, outPath)}  (${sz} B)`);
      continue;
    }

    // Anything that isn't a .src.js source file is skipped.
    if (!srcPath.endsWith('.src.js')) {
      console.warn('[obfuscate] skip (not .src.js):', path.relative(ROOT, srcPath));
      continue;
    }

    const code = fs.readFileSync(srcPath, 'utf8');
    const obf = obfuscateString(code);
    const outPath = srcToOut(srcPath);
    ensureDir(outPath);
    fs.writeFileSync(outPath, obf, 'utf8');

    totalIn += code.length;
    totalOut += obf.length;
    count++;
    console.log(`[obfuscate:main] ${path.relative(ROOT, srcPath).padEnd(50)} -> ${path.relative(ROOT, outPath)}  ${code.length} -> ${obf.length}`);
  }

  // Renderer-side shim: ui/app.src.js -> ui/app.js (BROWSER_OPTIONS).
  // Source stays in git, build artifact ui/app.js is gitignored.
  const rendererSrc = path.join(ROOT, 'ui', 'app.src.js');
  const rendererOut = path.join(ROOT, 'ui', 'app.js');
  if (fs.existsSync(rendererSrc)) {
    const code = fs.readFileSync(rendererSrc, 'utf8');
    const obf = obfuscateBrowserString(code);
    fs.writeFileSync(rendererOut, obf, 'utf8');
    totalIn += code.length;
    totalOut += obf.length;
    console.log(`[obfuscate:browser] ui/app.src.js -> ui/app.js  ${code.length} -> ${obf.length}`);
  } else {
    console.warn('[obfuscate] ui/app.src.js missing; skipping renderer shim');
  }

  console.log(`[obfuscate] ${count} src files obfuscated, total ${totalIn} -> ${totalOut} bytes`);
}

module.exports = {
  obfuscateString,
  obfuscateBrowserString,
  DEFAULT_OPTIONS,
  BROWSER_OPTIONS
};

if (require.main === module) {
  runStandalone();
}
