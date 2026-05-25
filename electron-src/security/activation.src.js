// activation.src.js
// License key validation + license.dat lifecycle.
//
// Key algorithm (must match scripts/generate-license-key.js, the n8n key-gen
// workflow, and /api/promo-auth.js get-electron-key EXACTLY -- otherwise
// customer keys won't validate):
//
//   norm   = email.toLowerCase().trim()
//   hmac   = HMAC_SHA256(masterSecret, customerId + '|' + norm)        // hex
//   block  = hmac.slice(0,16).toUpperCase()                            // 16 chars
//   key    = block[0..4] + '-' + block[4..8] + '-' + block[8..12] + '-' + block[12..16]
//
// Shared-build, per-buyer key model:
//   The build ships with a shared watermark (customerId = "TEST-0001",
//   masterSecret = production secret). The server issues a UNIQUE key per
//   buyer by hashing the buyer's email into the HMAC. So at activation the
//   user supplies BOTH key AND email; we recompute the expected key from
//   their email and compare. The actual buyer email is stored in license.dat
//   so subsequent launches re-validate against the right identity.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wm = require('../_watermark');
const enc = require('./crypto');
const machine = require('./machine');

function expectedLicenseKeyFor(email) {
  const norm = String(email || '').toLowerCase().trim();
  const h = crypto.createHmac('sha256', wm.masterSecret).update(wm.customerId + '|' + norm).digest('hex');
  const b = h.slice(0, 16).toUpperCase();
  return `${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}`;
}

function normalizeUserKey(input) {
  return String(input || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

function validateKey(userInput, email) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm || norm.indexOf('@') < 1) return false;
  const expected = expectedLicenseKeyFor(norm).replace(/-/g, '');
  const got = normalizeUserKey(userInput);
  if (got.length !== 16 || expected.length !== 16) return false;
  // Constant-time compare to avoid trivial timing leaks.
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return crypto.timingSafeEqual(a, b);
}

function licensePath(userDataDir) {
  return path.join(userDataDir, 'license.dat');
}

function activate(userInput, email, userDataDir) {
  const norm = String(email || '').toLowerCase().trim();
  if (!norm || norm.indexOf('@') < 1) {
    return { ok: false, error: 'Email is required to activate.' };
  }
  if (!validateKey(userInput, norm)) {
    return { ok: false, error: 'Invalid license key for this email.' };
  }
  const lic = {
    customer_id: wm.customerId,
    email: norm,
    license_key: expectedLicenseKeyFor(norm),
    activation_date: new Date().toISOString(),
    machine_hash: machine.getFingerprint(),
    build_id: wm.buildId,
    watermark: wm.watermark,
    expiry: null  // permanent, offline forever
  };
  const blob = enc.encryptJSON(lic);
  try {
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(licensePath(userDataDir), blob, 'utf8');
  } catch (err) {
    return { ok: false, error: 'Failed to write license file: ' + err.message };
  }
  return { ok: true, license: { customer_id: lic.customer_id, email: lic.email, activation_date: lic.activation_date } };
}

function loadLicense(userDataDir) {
  const p = licensePath(userDataDir);
  if (!fs.existsSync(p)) return null;
  let lic;
  try {
    const blob = fs.readFileSync(p, 'utf8');
    lic = enc.decryptJSON(blob);
  } catch (_err) {
    // Decrypt failed -- could be machine change, corrupt file, or tampering.
    // Treat as no license; caller will show activation screen.
    return null;
  }
  // Re-verify machine hash matches now (defense-in-depth; the decrypt itself
  // would have failed if the fingerprint had changed, but a sophisticated
  // attacker could in theory swap files).
  if (lic.machine_hash !== machine.getFingerprint()) return null;
  // Re-verify the embedded license_key matches the key derived from the
  // stored buyer email (defense against tampered license.dat with mismatched
  // email/key pair). We trust the stored email because the file was sealed
  // with crypto.encryptJSON tied to machine state.
  if (!lic.email || lic.license_key !== expectedLicenseKeyFor(lic.email)) return null;
  return lic;
}

function hasValidLicense(userDataDir) {
  return loadLicense(userDataDir) !== null;
}

function clearLicense(userDataDir) {
  const p = licensePath(userDataDir);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); return true; } catch (_) { return false; }
  }
  return true;
}

module.exports = {
  expectedLicenseKeyFor,
  validateKey,
  activate,
  loadLicense,
  hasValidLicense,
  clearLicense
};
