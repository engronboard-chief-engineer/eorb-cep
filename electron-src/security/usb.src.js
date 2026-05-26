// usb.src.js
// USB volume fingerprint for the Portable Edition.
//
// The Portable license is bound to the USB stick itself, NOT to the host PC.
// That's the whole point: plug the same USB into the cabin PC, the ECR, the
// office desktop, and the app works on all three. Copy the folder to a
// DIFFERENT USB and the license is invalid because the volume serial changed.
//
// Inputs (per platform):
//   Windows: volume serial number (DWORD assigned at format time),
//            volume label, total size in bytes.
//   macOS:   diskutil VolumeUUID + Total Size.
//
// Output: SHA-256 hex digest of the joined stable inputs.
//
// No PC fallback. If we can't read the USB identifiers (network drive,
// virtual mount, sandboxed FS) we return null and the caller must surface
// the "insert a real USB" error.

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let _cached = null;
let _cachedFor = null;

function _hash(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// Win: drive letter that contains absPath. "C:\foo" -> "C:". Null if none.
function _driveLetterFor(absPath) {
  const m = String(absPath || '').match(/^([A-Za-z]):/);
  return m ? (m[1].toUpperCase() + ':') : null;
}

function _readWindowsVolume(driveLetter) {
  const drive = String(driveLetter || '').replace(/[^A-Z:]/gi, '');
  if (!drive) return null;
  // PowerShell -EncodedCommand expects UTF-16LE base64. That's the only
  // shell-quoting-proof way to pass a script with embedded single AND
  // double quotes from Node -> cmd.exe -> powershell.exe.
  // Single quotes around DeviceID value are required because '=' in the
  // -Filter syntax otherwise gets evaluated by PS.
  const script =
    "$ErrorActionPreference='Stop';" +
    "$d = Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='\" + '" + drive + "' + \"'\");" +
    "if (-not $d) { exit 1 };" +
    "$o = [ordered]@{" +
    " serial = ($d.VolumeSerialNumber | Out-String).Trim();" +
    " label  = ($d.VolumeName | Out-String).Trim();" +
    " size   = ($d.Size | Out-String).Trim();" +
    " type   = ($d.DriveType | Out-String).Trim()" +
    " };" +
    "ConvertTo-Json -Compress -InputObject ([pscustomobject]$o)";
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (_) { return null; }
  try {
    const j = JSON.parse(String(out).trim());
    if (!j || !j.serial) return null;
    return {
      serial: String(j.serial).trim().toUpperCase(),
      label:  String(j.label || '').trim(),
      size:   String(j.size || '').trim(),
      type:   String(j.type || '').trim()
    };
  } catch (_) { return null; }
}

function _readMacVolume(absPath) {
  // df -P to resolve mountpoint, then diskutil info for VolumeUUID + size.
  try {
    const dfOut = execFileSync('df', ['-P', absPath], { encoding: 'utf8', timeout: 5000 });
    const lines = String(dfOut).split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    const cols = last.trim().split(/\s+/);
    const mount = cols[cols.length - 1] || absPath;
    const info = execFileSync('diskutil', ['info', '-plist', mount], { encoding: 'utf8', timeout: 5000 });
    const uuidMatch  = info.match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/i);
    const sizeMatch  = info.match(/<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/i);
    const labelMatch = info.match(/<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/i);
    if (!uuidMatch) return null;
    return {
      serial: uuidMatch[1].trim().toUpperCase(),
      label:  labelMatch ? labelMatch[1].trim() : '',
      size:   sizeMatch ? sizeMatch[1].trim() : '',
      type:   'macos-volume'
    };
  } catch (_) { return null; }
}

// computeUsbHash(usbRootDir)
//   Returns { ok:true, hash, inputs } | { ok:false, error }.
function computeUsbHash(usbRootDir) {
  if (_cached && _cachedFor === usbRootDir) {
    return { ok: true, hash: _cached, inputs: { cached: true } };
  }
  if (!usbRootDir || !fs.existsSync(usbRootDir)) {
    return { ok: false, error: 'usb_root_missing' };
  }
  let info = null;
  if (process.platform === 'win32') {
    const letter = _driveLetterFor(usbRootDir);
    if (!letter) return { ok: false, error: 'no_drive_letter' };
    info = _readWindowsVolume(letter);
  } else if (process.platform === 'darwin') {
    info = _readMacVolume(usbRootDir);
  } else {
    return { ok: false, error: 'unsupported_platform' };
  }
  if (!info || !info.serial) return { ok: false, error: 'volume_read_failed' };

  const hash = _hash([info.serial, info.label, info.size, process.platform]);
  _cached = hash;
  _cachedFor = usbRootDir;
  return { ok: true, hash, inputs: info };
}

function shortHash(h) { return String(h || '').slice(0, 8); }

module.exports = { computeUsbHash, shortHash };
