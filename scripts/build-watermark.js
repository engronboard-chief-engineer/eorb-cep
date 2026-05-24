#!/usr/bin/env node
// build-watermark.js
// Patches electron/_watermark.js with per-customer constants before obfuscation.
// Each customer gets a unique build with their customerId + masterSecret +
// perBuildSecret baked in. Two customers will produce different obfuscated
// binaries → enables leak tracing.
//
// Usage:
//   node scripts/build-watermark.js \
//     --customer-id CEP-2026-0001 \
//     --email buyer@example.com \
//     [--build-id <uuid>] \
//     [--master-secret <secret>] \
//     [--per-build-secret <secret>]
//
// If --master-secret is omitted, this script reads it from .secrets/master.txt
// (gitignored). The same value MUST be used in the n8n key-gen workflow for
// keys to validate.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
// SOURCE watermark file (plaintext, hand-edited or patched per-customer).
// Build pipeline copies this to electron/_watermark.js unchanged (not obfuscated).
const WATERMARK_FILE = path.join(ROOT, 'electron-src', '_watermark.js');
const SECRETS_DIR = path.join(ROOT, '.secrets');
const MASTER_SECRET_FILE = path.join(SECRETS_DIR, 'master.txt');

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

function loadMasterSecret(override) {
  if (override) return override;
  if (fs.existsSync(MASTER_SECRET_FILE)) {
    return fs.readFileSync(MASTER_SECRET_FILE, 'utf8').trim();
  }
  console.error('[watermark] FATAL: no master secret.');
  console.error('  Either pass --master-secret, or create .secrets/master.txt');
  console.error('  with a strong random string (32+ bytes hex).');
  console.error('  Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

function main() {
  const args = parseArgs();
  if (!args.customerId || !args.email) {
    console.error('[watermark] Usage: --customer-id <id> --email <email> [--build-id <uuid>] [--master-secret <s>] [--per-build-secret <s>]');
    process.exit(1);
  }

  const masterSecret = loadMasterSecret(args.masterSecret);
  const perBuildSecret = args.perBuildSecret || crypto.randomBytes(24).toString('hex');
  const buildId = args.buildId || crypto.randomBytes(8).toString('hex');
  const emailHash = crypto.createHash('sha256').update(args.email.toLowerCase().trim()).digest('hex');
  const watermark = `${args.customerId}|${emailHash.slice(0, 12)}|${buildId}`;

  const content = `module.exports = {
  customerId: ${JSON.stringify(args.customerId)},
  email: ${JSON.stringify(args.email.toLowerCase().trim())},
  buildId: ${JSON.stringify(buildId)},
  masterSecret: ${JSON.stringify(masterSecret)},
  perBuildSecret: ${JSON.stringify(perBuildSecret)},
  watermark: ${JSON.stringify(watermark)}
};
`;

  fs.writeFileSync(WATERMARK_FILE, content, 'utf8');

  const ledgerDir = path.join(ROOT, '.secrets');
  if (!fs.existsSync(ledgerDir)) fs.mkdirSync(ledgerDir);
  const ledger = path.join(ledgerDir, 'builds-ledger.jsonl');
  const ledgerLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    customerId: args.customerId,
    email: args.email,
    buildId,
    watermark,
    perBuildSecret
  }) + '\n';
  fs.appendFileSync(ledger, ledgerLine);

  console.log('[watermark] patched ' + path.relative(ROOT, WATERMARK_FILE));
  console.log('  customer:    ' + args.customerId);
  console.log('  email:       ' + args.email);
  console.log('  build-id:    ' + buildId);
  console.log('  watermark:   ' + watermark);
  console.log('[watermark] ledger appended:  ' + path.relative(ROOT, ledger));
  console.log('[watermark] next: npm run build && npm run dist');
}

main();
