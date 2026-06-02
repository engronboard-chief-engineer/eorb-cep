#!/usr/bin/env node
// fingerprint-probe.js  (v1.4.19 security hotfix — Step 0 stability gate)
//
// READ-ONLY diagnostic. Prints the raw fingerprint inputs, the legacy
// diagnostic fingerprint, and the NEW binding fingerprint that will key the
// CEP license seal. Appends one timestamped line to scripts/fingerprint-probe.log.
//
// Purpose: PROVE the binding fingerprint does not drift on a real machine.
// Run this BEFORE and AFTER each of the following events and diff the
// "binding" value — it MUST stay byte-identical:
//   reboot · Windows Update · Wi-Fi/VPN change · dock/undock ·
//   USB insert/remove · monitor change/unplug
// Also run on a SECOND physical machine — the binding value MUST differ.
//
// Usage:  node scripts/fingerprint-probe.js  [note]
//   (optional free-text note is recorded in the log line, e.g. "after-reboot")

const fs = require('fs');
const path = require('path');
const machine = require('../electron-src/security/machine.src.js');

const note = process.argv.slice(2).join(' ') || '';
const inputs = machine.getFingerprintInputs();
const diagFp = machine.getFingerprint();
const bindFp = machine.getBindingFingerprint();
const ts = new Date().toISOString();

const human = [
  '------------------------------------------------------------',
  'eORB fingerprint probe   ' + ts + (note ? '   [' + note + ']' : ''),
  '------------------------------------------------------------',
  '  machineId (MachineGuid) : ' + inputs.machineId,
  '  hostname                : ' + inputs.hostname,
  '  cpuModel                : ' + inputs.cpuModel,
  '  platform                : ' + inputs.platform,
  '',
  '  diagnostic fingerprint  : ' + diagFp + '   (MachineGuid+hostname+cpu+platform — NOT used for the seal)',
  '  >>> BINDING fingerprint : ' + bindFp + '   (MachineGuid+platform — keys license.dat; must NOT drift)',
  ''
].join('\n');

console.log(human);

const logFile = path.join(__dirname, 'fingerprint-probe.log');
const line = JSON.stringify({
  ts,
  note,
  machineId: inputs.machineId,
  hostname: inputs.hostname,
  cpuModel: inputs.cpuModel,
  platform: inputs.platform,
  diagnosticFingerprint: diagFp,
  bindingFingerprint: bindFp
}) + '\n';

try {
  fs.appendFileSync(logFile, line, 'utf8');
  console.log('[probe] appended to ' + logFile);
} catch (err) {
  console.error('[probe] could not write log:', err.message);
}
