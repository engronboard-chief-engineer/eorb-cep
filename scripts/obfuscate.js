#!/usr/bin/env node
// obfuscate.js
// Production JS obfuscation pass over electron/ and ui/app.js.
// Shared module: PWA and Portable build scripts import obfuscateString().
//
// Run with: node scripts/obfuscate.js
// Skips _watermark.js (intentionally readable so build-watermark.js can patch it).

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');

// Base options — safe for ALL contexts (main process, renderer, browser, single-file HTML).
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

// Stricter options for browser/renderer JS where we want anti-debugging.
// selfDefending crashes in Node main process (detects non-browser env and bails),
// so it MUST stay false for electron/*.js. Safe in browser/renderer.
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

function obfuscateFile(absPath, extraOptions = {}) {
  const src = fs.readFileSync(absPath, 'utf8');
  const out = obfuscateString(src, extraOptions);
  fs.writeFileSync(absPath, out, 'utf8');
  return { path: absPath, before: src.length, after: out.length };
}

function obfuscateBrowserFile(absPath, extraOptions = {}) {
  const src = fs.readFileSync(absPath, 'utf8');
  const out = obfuscateBrowserString(src, extraOptions);
  fs.writeFileSync(absPath, out, 'utf8');
  return { path: absPath, before: src.length, after: out.length };
}

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

function runStandalone() {
  // electron/*.js → Node main process. MUST use DEFAULT_OPTIONS (selfDefending off).
  const mainTargets = walk(path.join(ROOT, 'electron'), p =>
    p.endsWith('.js') && !p.endsWith('_watermark.js')
  );
  // ui/app.js → browser renderer. Can use stronger BROWSER_OPTIONS.
  const rendererTargets = [path.join(ROOT, 'ui', 'app.js')];

  let totalBefore = 0, totalAfter = 0;
  for (const t of mainTargets) {
    if (!fs.existsSync(t)) {
      console.warn('[obfuscate] skip (missing):', path.relative(ROOT, t));
      continue;
    }
    const r = obfuscateFile(t);
    totalBefore += r.before; totalAfter += r.after;
    console.log(`[obfuscate:main]    ${path.relative(ROOT, t).padEnd(46)} ${r.before} → ${r.after}`);
  }
  for (const t of rendererTargets) {
    if (!fs.existsSync(t)) {
      console.warn('[obfuscate] skip (missing):', path.relative(ROOT, t));
      continue;
    }
    const r = obfuscateBrowserFile(t);
    totalBefore += r.before; totalAfter += r.after;
    console.log(`[obfuscate:browser] ${path.relative(ROOT, t).padEnd(46)} ${r.before} → ${r.after}`);
  }
  console.log(`[obfuscate] total ${totalBefore} → ${totalAfter} bytes`);
}

module.exports = {
  obfuscateString,
  obfuscateBrowserString,
  obfuscateFile,
  obfuscateBrowserFile,
  DEFAULT_OPTIONS,
  BROWSER_OPTIONS
};

if (require.main === module) {
  runStandalone();
}
