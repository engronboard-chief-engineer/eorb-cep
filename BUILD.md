# eORB CEP — Build & Release

Internal docs. Not shipped to customers.

## CRITICAL one-time prerequisite: Enable Windows Developer Mode

Without this, `npm run dist` will fail with `Cannot create symbolic link` errors
when electron-builder extracts the `winCodeSign` toolkit (it contains macOS
dylib symlinks that require symlink-creation privilege).

**Open PowerShell as Administrator and run:**

```powershell
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name 'AllowDevelopmentWithoutDevLicense' -Value 1
```

Or GUI: **Settings → Privacy & Security → For developers → Developer Mode → On**.
Reboot or restart your shell after enabling.

Verify it's on:

```powershell
Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name 'AllowDevelopmentWithoutDevLicense'
```

Should show `AllowDevelopmentWithoutDevLicense : 1`.

Everything else (obfuscation, integrity, license generation, `npm run dev`)
works WITHOUT Developer Mode — it's only required for the final `dist` step
that packages the `.exe` installer.

## One-time setup

```powershell
cd "Ship Application/eORB-Electron"
npm install

# Generate and store the master secret (32 bytes hex). NEVER commit. Back it up.
# The same value must be configured in the n8n key-gen workflow.
New-Item -ItemType Directory -Force .secrets | Out-Null
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > .secrets/master.txt
```

After this, `.secrets/master.txt` holds the master secret. Keep it private.
If lost, every license you've ever issued becomes unverifiable; if leaked,
attackers can forge license keys. Roy keeps an offline backup.

## Per-customer build

```powershell
cd "Ship Application/eORB-Electron"

# 1) Patch _watermark.js with this customer's identity + secrets
npm run watermark -- --customer-id CEP-2026-0001 --email buyer@example.com

# 2) Compute the license key for this customer (give this to them in email)
npm run genkey -- --customer-id CEP-2026-0001 --email buyer@example.com

# 3) Build: prep UI -> obfuscate -> compute integrity manifest
npm run build

# 4) Package as Windows installer (.exe)
npm run dist

# Output: dist/eORB CEP-1.0.0-x64.exe
# Rename if desired: eORB-Premium-CEP-2026-0001.exe
```

## Dev workflow (no obfuscation, no per-customer secrets)

```powershell
npm run dev
# This runs prepare-ui first, then launches Electron unobfuscated.
# DevTools are still disabled in production mode; for dev debugging, edit
# electron/main.js and temporarily set IS_DEV to true behavior.
```

## License key validation

The key for customer `(customerId, email)` is:

```
key = HMAC-SHA256(customerId + '|' + email.toLowerCase().trim(), masterSecret)
key = first 16 hex chars, uppercased, dashed every 4 chars
```

n8n workflow ("CEP — eORB Electron Migration Blast" or per-sale workflow)
runs the same algorithm in a Code node:

```javascript
const crypto = require('crypto');
const master = $env.EORB_MASTER_SECRET; // set in n8n credentials
const norm = email.toLowerCase().trim();
const h = crypto.createHmac('sha256', master)
  .update(customerId + '|' + norm).digest('hex');
const block = h.slice(0, 16).toUpperCase();
const key = `${block.slice(0,4)}-${block.slice(4,8)}-${block.slice(8,12)}-${block.slice(12,16)}`;
```

## What the customer receives

1. **Installer .exe** — uploaded to Google Drive, link shared via email
2. **License key** — `XXXX-XXXX-XXXX-XXXX`, emailed separately by n8n

## Activation flow on customer's machine

1. Customer runs installer → installs to Program Files (or per-user)
2. Customer launches → `activation.html` shown
3. Customer enters license key → `activation.js` validates against the
   customerId/email baked into THIS build → creates `license.dat` in
   `%APPDATA%/eORB CEP/` encrypted with this machine's hardware fingerprint
4. App relaunches into `ui/index.html` (the eORB simulator)
5. Forever after: validates `license.dat` on every startup, runs fully offline

## Updating customers

When a new version ships:

1. Update `APP_VERSION` in `electron/main.js`
2. Update `version` in `package.json`
3. For each customer who paid for updates: rebuild their .exe (or just notify
   them via the Check for Updates flow)
4. Update `website/orb/electron-version.json` with the new version + new
   download link
5. Next time customers click "Check for Updates", they see the new version

## Files NOT to ship

- `.secrets/` — master secret + builds ledger
- `electron/_watermark.js` (raw form) — gets baked into obfuscated build
- `node_modules/` — bundled by electron-builder into asar automatically

## Files that ARE in the .exe

- `app.asar` containing: obfuscated `electron/*.js`, `ui/index.html`, `ui/app.js`, `ui/activation.html`
- `node_modules/better-sqlite3/` (unpacked, native module)
- `build/icon.ico`
- `build/integrity-manifest.json`

## Troubleshooting

**"License invalid" on customer's machine after they enter a valid key:**
- Confirm `_watermark.js` was patched for THIS customer before `npm run build`
- Confirm the license key was generated with the SAME master secret as the build
- Each customer build only accepts the key for THAT customer's email+id

**"Integrity violation detected":**
- The `integrity-manifest.json` was generated AT BUILD TIME — if you modify any
  watched file after building but before packaging, the manifest will be wrong
- Always run `npm run build` (which runs integrity LAST) before `npm run dist`

**better-sqlite3 build fails on install:**
- `npm install --build-from-source` if pre-built binary mismatch
- Electron rebuilds it via `postinstall` script (`electron-builder install-app-deps`)
