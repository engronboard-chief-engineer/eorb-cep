// machine.src.js
// Hardware fingerprint for machine-locking the license.
//
// CRITICAL: this hash MUST be deterministic across reboots, Wi-Fi toggles,
// memory pressure, and time. The previous build used unstable inputs (likely
// network interfaces or memory) and drifted on every relaunch -- license.dat
// decryption then failed because the AES key derived from the fingerprint no
// longer matched. Customer saw "activation succeeded once then app refuses
// to open forever."
//
// STABLE inputs only:
//   - node-machine-id (Windows MachineGuid registry value; Mac IOPlatformUUID;
//     Linux /etc/machine-id) -- the canonical "this OS install" identifier
//   - os.hostname() -- machine name, stable unless renamed
//   - os.cpus()[0].model -- CPU model string, stable per hardware
//   - process.platform -- 'win32' / 'darwin' / 'linux'
//
// EXCLUDED on purpose:
//   - MAC addresses / network interfaces (change when Wi-Fi disabled, dock changes)
//   - free / total memory (always different)
//   - disk serial / free space (different libs return different values)
//   - username (can change)
//   - any time-based input

const crypto = require('crypto');
const os = require('os');

let _cached = null;

function getFingerprint() {
  if (_cached) return _cached;

  let machineId = '';
  try {
    // Synchronous read of the OS-managed identifier. The `original: true` flag
    // returns the raw value (not the SHA-256 the library does by default) so
    // we control the hashing.
    machineId = require('node-machine-id').machineIdSync({ original: true }) || '';
  } catch (err) {
    // Fall back to a hostname-derived identifier so we never throw. Less
    // unique but at least stable across reboots on the same machine.
    machineId = 'fallback-' + os.hostname();
  }

  const hostname = os.hostname() || 'unknown-host';
  let cpuModel = 'unknown-cpu';
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) cpuModel = cpus[0].model.trim();
  } catch (_) { /* keep default */ }

  const platform = process.platform;

  const combined = [machineId, hostname, cpuModel, platform].join('|');
  const hash = crypto.createHash('sha256').update(combined).digest('hex');

  _cached = hash;
  return hash;
}

// For debugging only -- never exposed to renderer.
function getFingerprintInputs() {
  let machineId = 'err';
  try { machineId = require('node-machine-id').machineIdSync({ original: true }) || ''; } catch (_) {}
  return {
    machineId,
    hostname: os.hostname(),
    cpuModel: (os.cpus()[0] || {}).model || '',
    platform: process.platform
  };
}

module.exports = { getFingerprint, getFingerprintInputs };
