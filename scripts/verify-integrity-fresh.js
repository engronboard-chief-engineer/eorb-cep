#!/usr/bin/env node
// verify-integrity-fresh.js
// Pre-package guard. Aborts `electron-builder` if the integrity manifest is
// stale relative to ANY targeted file. This catches the failure mode where
// `npm run prep` is re-run alone after `npm run integrity`, causing the
// packaged .exe to ship a fresh ui/index.html with a stale manifest hash —
// every launch then fails with "Integrity violation detected".
//
// Run automatically via the `predist:win` / `predist:win:portable` npm hooks.
// Always run `npm run build` before `npm run dist:*`. Never run `npm run prep`
// after `npm run integrity` without re-running the full build.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'build', 'integrity-manifest.json');

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function die(msg) {
  console.error('\n\x1b[31m[verify-integrity-fresh] BLOCKED — ' + msg + '\x1b[0m');
  console.error('\x1b[33mRun `npm run build` (prep -> obfuscate -> integrity) BEFORE `npm run dist:*`.\x1b[0m\n');
  process.exit(1);
}

if (!fs.existsSync(MANIFEST)) die('build/integrity-manifest.json missing. Run `npm run build` first.');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entries = Object.entries(manifest);
if (!entries.length) die('manifest is empty.');

const mismatches = [];
const missing = [];
for (const [rel, expected] of entries) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { missing.push(rel); continue; }
  const actual = hashFile(abs);
  if (actual !== expected) mismatches.push({ rel, expected, actual });
}

if (missing.length) die('files referenced in manifest are missing on disk:\n  ' + missing.join('\n  '));
if (mismatches.length) {
  console.error('\n\x1b[31m[verify-integrity-fresh] BLOCKED — manifest is stale for:\x1b[0m');
  for (const m of mismatches) {
    console.error('  ' + m.rel);
    console.error('    expected: ' + m.expected);
    console.error('    actual:   ' + m.actual);
  }
  die(mismatches.length + ' file(s) changed after integrity was computed.');
}

console.log('[verify-integrity-fresh] OK — ' + entries.length + ' files match manifest. Safe to package.');
