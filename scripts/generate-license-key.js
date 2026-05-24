#!/usr/bin/env node
// generate-license-key.js
// Offline license key generator. Run by Roy at sale time (or by an n8n Code
// node that mirrors this algorithm).
//
// Usage:
//   node scripts/generate-license-key.js --customer-id CEP-2026-0001 --email buyer@example.com
//
// Reads master secret from .secrets/master.txt unless --master-secret is given.
// Output is a single line: XXXX-XXXX-XXXX-XXXX (16 hex chars, dashed).
//
// VALIDATION RULE (must match electron/security/activation.js#expectedLicenseKey):
//   key = first16chars( HMAC-SHA256( customerId + '|' + email.lower().trim(),  masterSecret ) ).upper()

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, '.secrets', 'master.txt');

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (!k || !k.startsWith('--')) continue;
    args[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return args;
}

function loadMaster(override) {
  if (override) return override;
  if (!fs.existsSync(MASTER_FILE)) {
    console.error('[genkey] FATAL: missing master secret at ' + MASTER_FILE);
    console.error('  Create it with a 32-byte random hex string.');
    process.exit(1);
  }
  return fs.readFileSync(MASTER_FILE, 'utf8').trim();
}

function generate(customerId, email, master) {
  const norm = email.toLowerCase().trim();
  const h = crypto.createHmac('sha256', master).update(customerId + '|' + norm).digest('hex');
  const block = h.slice(0, 16).toUpperCase();
  return `${block.slice(0,4)}-${block.slice(4,8)}-${block.slice(8,12)}-${block.slice(12,16)}`;
}

function main() {
  const args = parseArgs();
  if (!args.customerId || !args.email) {
    console.error('Usage: node scripts/generate-license-key.js --customer-id <id> --email <email> [--master-secret <s>]');
    process.exit(1);
  }
  const master = loadMaster(args.masterSecret);
  const key = generate(args.customerId, args.email, master);
  console.log(key);
}

if (require.main === module) main();

module.exports = { generate };
