// integrity.src.js
// Startup tamper-detection. Reads build/integrity-manifest.json (written by
// scripts/compute-integrity.js after obfuscation) and SHA-256 verifies every
// listed file against the on-disk content.
//
// Skipped during `npm run dev` because the manifest doesn't exist yet and the
// files aren't obfuscated.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

// rootDir = the unpacked app root inside asar (process.resourcesPath/app.asar
// is opaque, but in main.js we'll pass app.getAppPath()).
function verify(rootDir) {
  const manifestPath = path.join(rootDir, 'build', 'integrity-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'manifest missing at ' + manifestPath };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: 'manifest unreadable: ' + err.message };
  }
  for (const rel of Object.keys(manifest)) {
    const expected = manifest[rel];
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) {
      return { ok: false, reason: 'file missing: ' + rel };
    }
    let got;
    try { got = sha256File(abs); }
    catch (err) { return { ok: false, reason: 'hash failed for ' + rel + ': ' + err.message }; }
    if (got !== expected) {
      return { ok: false, reason: 'hash mismatch: ' + rel };
    }
  }
  return { ok: true, count: Object.keys(manifest).length };
}

module.exports = { verify };
