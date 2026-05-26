// crypto.src.js
// AES-256-GCM encryption used to seal license.dat.
//
// In the CEP (installer) build the key is derived from the machine
// fingerprint -- license.dat from machine A fails to decrypt on machine B.
// In the Portable (USB) build the key is derived from the USB volume hash --
// license.dat from USB A fails to decrypt on USB B.
//
// To keep one crypto module for both builds, the key source is now passed
// in by the caller. Pass the machine fingerprint for installer mode, or the
// USB hash for portable mode.
//
// File format (base64-encoded):
//   bytes [0..11]    IV (12 bytes, random per encryption)
//   bytes [12..N-17] ciphertext
//   bytes [N-16..N]  GCM auth tag (16 bytes)

const crypto = require('crypto');
const machine = require('./machine');

const SALT = 'eorb-cep-v1';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKeyFrom(keyMaterial) {
  // scryptSync is memory-hard; license.dat is touched only on launch + activate
  // so the few hundred ms is fine.
  return crypto.scryptSync(String(keyMaterial), SALT, KEY_LEN);
}

// Legacy: derive from machine fingerprint. Kept for the CEP installer build.
function deriveKey() {
  return deriveKeyFrom(machine.getFingerprint());
}

function encryptJSON(obj, keyMaterial) {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const key = keyMaterial ? deriveKeyFrom(keyMaterial) : deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

function decryptJSON(b64, keyMaterial) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = keyMaterial ? deriveKeyFrom(keyMaterial) : deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encryptJSON, decryptJSON, deriveKeyFrom };
