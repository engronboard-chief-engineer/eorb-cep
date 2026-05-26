// activation.src.js
// Two activation paths share this module:
//
//  (A) CEP installer build (legacy, machine-locked, offline-HMAC):
//      User enters (key, email). Key is recomputed from email + master secret
//      and compared. Sealed license.dat lives in app.getPath('userData') and
//      is encrypted with the machine fingerprint.
//      Entry points: activate(), loadLicense(), hasValidLicense(), clearLicense().
//
//  (B) Portable build (online activation, USB-locked):
//      User completes the identity + agreement + signature wizard. Payload is
//      posted to the n8n /webhook/orb-agreement-activate. n8n returns a signed
//      token + license_id + activation_id. Sealed license.dat lives next to
//      the .exe on the USB and is encrypted with the USB volume hash.
//      Entry points: activateOnline(), loadPortableLicense(),
//                    hasValidPortableLicense(), clearPortableLicense().

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const wm = require('../_watermark');
const enc = require('./crypto');
const machine = require('./machine');
const usb = require('./usb');

// ============================================================
// LEGACY CEP-INSTALLER PATH (machine-locked, offline-HMAC)
// ============================================================

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
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return crypto.timingSafeEqual(a, b);
}

function licensePath(dir) {
  return path.join(dir, 'license.dat');
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
    expiry: null
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
    return null;
  }
  if (lic.machine_hash !== machine.getFingerprint()) return null;
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

// ============================================================
// PORTABLE PATH (online activation, USB-locked)
// ============================================================

const ORB_AGREEMENT_ACTIVATE_URL = 'https://n8n.srv1083339.hstgr.cloud/webhook/orb-agreement-activate';

function _httpsPostJson(urlStr, payload, timeoutMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; resolve({ ok: false, error: 'timeout' }); }, timeoutMs || 12000);
    try {
      const u = new URL(urlStr);
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const req = https.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'User-Agent': 'eORB-Portable-Electron'
        }
      }, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(t);
          if (timedOut) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}
          if (!parsed) return resolve({ ok: false, error: 'bad_response', status: res.statusCode, raw });
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ ok: true, body: parsed });
          }
          resolve({ ok: false, error: parsed.error || 'http_' + res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => { clearTimeout(t); if (!timedOut) resolve({ ok: false, error: 'network', detail: err.message }); });
      req.write(body);
      req.end();
    } catch (err) {
      clearTimeout(t);
      resolve({ ok: false, error: 'request_failed', detail: err.message });
    }
  });
}

function portableLicensePath(usbDataDir) {
  return path.join(usbDataDir, 'license.dat');
}

// activateOnline({ identity, agreement, signatureDataUrl, usbHash, clientVersion })
// Posts to the n8n agreement-activate webhook. Returns the server response
// on success without writing the license file yet -- the caller (agreement
// module) writes it AFTER the PDF has been generated, so we don't end up
// with a sealed license but no receipt.
async function activateOnline({ identity, agreement, signatureHash, usbHash, clientVersion }) {
  if (!identity || !identity.email || !identity.email.includes('@')) {
    return { ok: false, error: 'invalid_email' };
  }
  if (!identity.fullName || !identity.fullName.trim()) {
    return { ok: false, error: 'missing_name' };
  }
  if (!agreement || agreement.accepted !== true) {
    return { ok: false, error: 'agreement_not_accepted' };
  }
  if (!signatureHash) {
    return { ok: false, error: 'missing_signature' };
  }
  if (!usbHash) {
    return { ok: false, error: 'missing_usb_hash' };
  }

  const payload = {
    email: String(identity.email).toLowerCase().trim(),
    fullName: String(identity.fullName || '').trim(),
    country: String(identity.country || '').trim(),
    rank: String(identity.rank || '').trim(),
    company: String(identity.company || '').trim(),
    vessel: String(identity.vessel || '').trim(),
    agreementAccepted: true,
    agreementVersion: agreement.version || '1.0',
    agreementAcceptedAt: agreement.acceptedAt || new Date().toISOString(),
    signatureHash: String(signatureHash),
    usbHash: String(usbHash),
    fp8: String(usbHash).slice(0, 8),
    appVersion: 'orb-portable-electron',
    clientVersion: clientVersion || ''
  };

  const resp = await _httpsPostJson(ORB_AGREEMENT_ACTIVATE_URL, payload, 15000);
  if (!resp.ok) {
    return { ok: false, error: resp.error || 'network', detail: resp.detail };
  }
  const b = resp.body || {};
  if (!b.success || !b.token || !b.license_id) {
    return { ok: false, error: b.error || 'server_rejected', body: b };
  }
  return {
    ok: true,
    token: b.token,
    license_id: b.license_id,
    activation_id: b.activation_id || null,
    tier: b.tier || null
  };
}

// Seal and write the portable license file to the USB-side data dir.
// keyMaterial = usbHash (license decrypts ONLY on this USB).
function writePortableLicense({ usbDataDir, usbHash, identity, agreement, signatureHash, server }) {
  const lic = {
    edition: 'portable',
    license_id: server.license_id,
    activation_id: server.activation_id,
    token: server.token,
    customer_id: wm.customerId,
    build_id: wm.buildId,
    watermark: wm.watermark,
    email: String(identity.email).toLowerCase().trim(),
    full_name: identity.fullName,
    country: identity.country,
    rank: identity.rank,
    company: identity.company || '',
    vessel: identity.vessel || '',
    agreement_version: agreement.version || '1.0',
    agreement_accepted_at: agreement.acceptedAt,
    signature_hash: signatureHash,
    usb_hash: usbHash,
    tier: server.tier || null,
    activation_date: new Date().toISOString(),
    expiry: null
  };
  const blob = enc.encryptJSON(lic, usbHash);
  if (!fs.existsSync(usbDataDir)) fs.mkdirSync(usbDataDir, { recursive: true });
  fs.writeFileSync(portableLicensePath(usbDataDir), blob, 'utf8');
  return lic;
}

function loadPortableLicense(usbDataDir, usbHash) {
  const p = portableLicensePath(usbDataDir);
  if (!fs.existsSync(p)) return null;
  if (!usbHash) return null;
  try {
    const blob = fs.readFileSync(p, 'utf8');
    const lic = enc.decryptJSON(blob, usbHash);
    // Defense-in-depth: confirm the embedded usb_hash matches the current USB.
    // The decrypt itself would already have failed if the key didn't match,
    // but verify anyway.
    if (lic.usb_hash !== usbHash) return null;
    return lic;
  } catch (_) {
    return null;
  }
}

function hasValidPortableLicense(usbDataDir, usbHash) {
  return loadPortableLicense(usbDataDir, usbHash) !== null;
}

function clearPortableLicense(usbDataDir) {
  const p = portableLicensePath(usbDataDir);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); return true; } catch (_) { return false; }
  }
  return true;
}

module.exports = {
  // legacy CEP installer path
  expectedLicenseKeyFor,
  validateKey,
  activate,
  loadLicense,
  hasValidLicense,
  clearLicense,
  // portable USB path
  activateOnline,
  writePortableLicense,
  loadPortableLicense,
  hasValidPortableLicense,
  clearPortableLicense
};
