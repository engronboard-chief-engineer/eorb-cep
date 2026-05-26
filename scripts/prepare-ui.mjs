#!/usr/bin/env node
// prepare-ui.mjs
// Pull the source Portable HTML, strip the license/webhook block, inject the
// Electron localStorage shim, and write ui/index.html ready for Electron to load.
//
// Run with: node scripts/prepare-ui.mjs
// Idempotent. Run before `npm run dev` and before any production build.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// In CI the Portable source is bundled inside the repo under portable-src/.
// For local dev it may live in the sibling eORB-Portable-Edition folder instead.
const PORTABLE_BUNDLED_SRC  = resolve(ROOT, 'portable-src', 'eORB-Portable.html.src');
const PORTABLE_SIBLING_SRC  = resolve(ROOT, '..', 'eORB-Portable-Edition', 'eORB-Portable.html.src');
const PORTABLE_SIBLING_BUILT = resolve(ROOT, '..', 'eORB-Portable-Edition', 'eORB-Portable.html');
const PORTABLE = existsSync(PORTABLE_BUNDLED_SRC)  ? PORTABLE_BUNDLED_SRC
               : existsSync(PORTABLE_SIBLING_SRC)  ? PORTABLE_SIBLING_SRC
               : PORTABLE_SIBLING_BUILT;
const UI_DIR = join(ROOT, 'ui');
const OUT_HTML = join(UI_DIR, 'index.html');
const SHIM_SRC = join(UI_DIR, 'app.js');

if (!existsSync(PORTABLE)) {
  console.error('[prepare-ui] FATAL: source Portable HTML not found at:', PORTABLE);
  process.exit(1);
}

console.log('[prepare-ui] reading', PORTABLE);
let html = readFileSync(PORTABLE, 'utf8');
const startedAt = Date.now();

// 1. Override APP_VERSION → '<sim>-electron' to satisfy CLAUDE.md Rule #14:
//    the numeric version must match PWA/Portable; the suffix marks the build.
//    The Electron .exe app version (for self-update checks) is separate and
//    lives in main.src.js APP_VERSION.
html = html.replace(
  /const\s+APP_VERSION\s*=\s*'([^']+?)(?:-portable)?'/,
  (_m, num) => `const APP_VERSION = '${num}-electron' /* electron */`
);

// 2. Override the version chip suffix → 'CEP Edition'
html = html.replace(
  /·\s*Portable Edition/g,
  '· CEP Edition'
);

// 2b. Update the document <title> from the Portable's title to the CEP brand
//     so the window title bar shows "eORB CEP" instead of "...Portable Edition".
html = html.replace(
  /<title>[^<]*<\/title>/i,
  '<title>eORB CEP — Electronic Oil Record Book</title>'
);

// 3. Neutralize the activation webhook URL (kept as a dead constant; never called
//    because the Electron license validation runs in the main process before this
//    HTML is even loaded). This belt-and-suspenders prevents accidental fetches.
html = html.replace(
  /const\s+ORB_ACTIVATE_URL\s*=\s*'[^']+'/,
  "const ORB_ACTIVATE_URL = 'about:blank' /* electron — license handled natively */"
);

// 4. Inject the localStorage→IPC shim AS THE FIRST <script> in <head>.
//    Must run before any other script reads/writes localStorage.
const shimTag = '<script src="./app.js"></script>';
if (!html.includes('./app.js')) {
  html = html.replace(/<head([^>]*)>/i, `<head$1>\n${shimTag}`);
}

// 5. Add a small "this is the Electron build" marker the renderer can detect.
//    Derive sim version from the (now-rewritten) APP_VERSION line above.
{
  const m = html.match(/const\s+APP_VERSION\s*=\s*'([^']+)'/);
  const simVer = m ? m[1] : 'electron';
  html = html.replace(
    /<\/head>/i,
    `<meta name="x-eorb-build" content="${simVer}" />\n</head>`
  );
}

// 6. BYPASS the Portable HTML's inner email-based activation gate.
//    Electron's main process already validated the license before this HTML
//    loaded. Skip the inner gate by short-circuiting init() to bootApp().
//    We do this by transforming `async function init()` into a wrapper that
//    checks for the Electron bridge and jumps straight to bootApp().
{
  const initRx = /async\s+function\s+init\s*\(\s*\)\s*\{\s*\n\s*\/\/\s*Clean up any leftover device-bound/;
  if (initRx.test(html)) {
    html = html.replace(
      initRx,
      `async function init() {
  // [Electron build] License already validated by main process. Skip inner gate.
  if (window.eORB && window.eORB.license) {
    try { hideActivationGate(); } catch(_) {}
    bootApp();
    try { checkForUpdate(); } catch(_) {}
    return;
  }
  // Clean up any leftover device-bound`
    );
    console.log('[prepare-ui] activation bypass patch applied to init()');
  } else {
    console.warn('[prepare-ui] WARNING: could not find init() function — activation bypass NOT applied. Customer will see the inner activation gate.');
  }
}

// 7. Hide the activation-gate div by default so it never flashes on screen
//    while init() runs. The CSS rule .hidden already exists in the source.
html = html.replace(
  '<div id="activation-gate" class="hidden">',
  '<div id="activation-gate" class="hidden" style="display:none">'
);

if (!existsSync(UI_DIR)) mkdirSync(UI_DIR, { recursive: true });

writeFileSync(OUT_HTML, html, 'utf8');

const sizeKB = (html.length / 1024).toFixed(1);
const ms = Date.now() - startedAt;
console.log(`[prepare-ui] wrote ${OUT_HTML}  (${sizeKB} KB, ${ms} ms)`);

// Copy ui/app.src.js -> ui/app.js if needed. In dev runs (no obfuscate pass),
// this is the plaintext shim Electron loads. The obfuscate script overwrites
// ui/app.js with the obfuscated version during production builds.
const SHIM_REAL_SRC = join(UI_DIR, 'app.src.js');
if (existsSync(SHIM_REAL_SRC)) {
  const shimCode = readFileSync(SHIM_REAL_SRC, 'utf8');
  writeFileSync(SHIM_SRC, shimCode, 'utf8');
  console.log(`[prepare-ui] copied app.src.js -> app.js (plaintext, ${shimCode.length} B)`);
} else if (!existsSync(SHIM_SRC)) {
  console.warn('[prepare-ui] NOTE: ui/app.src.js AND ui/app.js missing — Electron will fail to load.');
} else {
  console.log('[prepare-ui] shim present at', SHIM_SRC, '(no .src found, using existing)');
}

// Stage the activation wizard from .src.html -> activation.html. The wizard
// is hand-edited in source; the build copies it through so the integrity
// manifest hashes the same content the obfuscator does NOT touch (it's a
// .html file). If a hand-written activation.html already exists alongside
// the .src (legacy CEP wizard), the .src wins.
{
  const wizardSrc = join(UI_DIR, 'activation.html.src');
  const wizardOut = join(UI_DIR, 'activation.html');
  if (existsSync(wizardSrc)) {
    const wizardHtml = readFileSync(wizardSrc, 'utf8');
    writeFileSync(wizardOut, wizardHtml, 'utf8');
    console.log(`[prepare-ui] staged activation.html.src -> activation.html (${wizardHtml.length} B)`);
  } else {
    console.log('[prepare-ui] note: no activation.html.src found; keeping existing activation.html');
  }
}

console.log('[prepare-ui] done.');
