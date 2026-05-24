// crypto.src.js
// AES-256-GCM encryption for license.dat.
// Key is derived from the machine fingerprint, so a license.dat from machine A
// fails to decrypt on machine B (machine-lock enforcement).
//
// File format (base64-encoded):
//   bytes [0..11]   IV (12 bytes, random per encryption)
//   bytes [12..N-17] ciphertext
//   bytes [N-16..N] GCM auth tag (16 bytes)

const crypto = require('crypto');
const machine = require('./machine');

const SALT = 'eorb-cep-v1';     // version bump if key derivation ever changes
const KEY_LEN = 32;             // AES-256
const IV_LEN = 12;              // GCM standard nonce
const TAG_LEN = 16;             // GCM standard tag

function deriveKey() {
  const fp = machine.getFingerprint();
  // scryptSync is slower than pbkdf2 but more memory-hard. License.dat is
  // touched only on launch + activate so the few-hundred-ms cost is fine.
  return crypto.scryptSync(fp, SALT, KEY_LEN);
}

function encryptJSON(obj) {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

function decryptJSON(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encryptJSON, decryptJSON };
