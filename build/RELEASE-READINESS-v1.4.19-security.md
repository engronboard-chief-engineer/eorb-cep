# eORB CEP — Release-Readiness Report: v1.4.19 Security Hotfix

**Date:** 2026-06-02
**Branch:** `hotfix/v1.4.18.1-security` (off clean `master` = v1.4.17)
**Type:** Emergency standalone production security hotfix — CEP Electron edition only
**Status:** Code complete + logic-validated. **BLOCKED on Clean Machine Validation (separate PC) before publish.**

---

## 1. What this patch is

Closes the proven CEP licensing bypass: a copied install / `database.db` / `%APPDATA%` ran fully activated on another machine because the only enforced gate was a device-less, signature-only `orb_lic_token` in the renderer.

**Fix:** the **main process is now the sole licensing authority**. It gates boot on a **machine-bound, AES-GCM sealed license** (`cep-license.dat`, key = `SHA-256(MachineGuid + platform)`); the renderer cannot unlock the app on its own, and `orb_lic_token` alone no longer boots. Email activation UX is unchanged — main performs the n8n call and seals the result to this machine.

## 2. Scope — included vs excluded

**Included:**
- Licensing remediation (main gate + `eorb:register-email` IPC + machine-sealed `cep-license.dat` + renderer fallback removal + trusted `cep-activate.html`).
- Five v1.4.18 renderer fixes forward-ported onto the clean v1.4.17 renderer:
  1. Export includes crew + equipment + OWS minimum
  2. Import compatibility for older backups (crew/equipment, skip-missing)
  3. Backup `schemaVersion: 2`
  4. Light theme default for new installs
  5. Chronological printed Record Book (print path now sorts like the preview)

**Excluded (verified absent in build):** Vessel Profiles / `ProfileStore`, Phase A features, Diagnostics panel UI, Support Center, `support:capture` IPC + preload bridge, any v1.5 functionality.

## 3. Version decision — ACTION REQUIRED

Shipping as **`1.4.19`**. `1.4.18.1` was requested but is **not valid semver** (4 segments) — electron-builder/electron-updater reject it and auto-update breaks. `1.4.19` is the clean stable version that auto-updates correctly from live `1.4.18`. **The in-progress vessel work must be renumbered `1.4.20`.** Confirm this label before publish (trivial to change; nothing is published yet).

## 4. Validation results

| # | Validation | Method | Result |
|---|------------|--------|--------|
| — | Build pipeline (prep → obfuscate → integrity) | `npm run build` | **PASS** — main-authority gate applied to init(); 13-entry manifest incl. `cep-activate.html` |
| — | Predist integrity guard | `npm run verify-integrity-fresh` | **PASS** — 13/13 match, safe to package |
| — | Source syntax (7 files) | `node --check` | **PASS** all |
| — | Fingerprint stability | analysis + probe | **Conditionally approved** — binding = MachineGuid+platform; invariant to rename/CPU/network/dock/USB/monitor; reboot + Windows-Update persistence to confirm during CMV |
| 1 | Security bypass (orb_lic_token insufficient; main sole authority) | seal harness (11 assertions) | **PASS** |
| 2 | Copy `database.db` to another machine | seal harness (cross-binding-fp) | **PASS** — load returns null → reactivation |
| 3 | Full `%APPDATA%` copy (incl. seal) | seal harness | **PASS** — decrypt fails on machine B |
| 4 | Install-directory copy | code review + #2/#3 logic | **PASS** — no machine-independent unlock path remains |
| 5 | Export/Import (crew+equipment, schemaVersion, old-file compat) | code present in build; logic verified | **Code-verified; GUI confirm in CMV** |
| 6 | Print order (chronological) | 2 sort sites confirmed in build | **Code-verified; GUI confirm in CMV** |
| 7 | **Clean Machine Validation** | fresh Windows PC/VM | **NOT RUN — see §6 (cannot be done on the dev box; this is the release gate)** |

Seal harness covered: orb_lic_token-without-seal → null; seal written + encrypted (not plaintext); loads on same machine; **fails on a different machine**; tampered seal rejected; deactivate clears. 11/11 passed.

## 5. Pre-flight before building the installer — n8n webhook

`registerEmailOnline()` POSTs to the **existing** `/webhook/orb-activate` with the current shape (`email`, `fingerprint:''`, `fp8:''`, `appVersion:'orb-portable'`, `clientVersion`). **Verify with a real member email during CMV that it returns `{success:true, token}`** and is not mis-categorized server-side. If it rejects, adjust the `appVersion` string in `electron-src/security/activation.src.js` (main-only; no n8n change). This is the single biggest unknown — activation fails entirely if the webhook doesn't accept this payload.

## 6. Remaining steps to release (gated)

1. Confirm version label (§3).
2. Build installers **without premature publish**: `npm run build` then `electron-builder --win nsis -c.directories.output=dist-v1419` (do **not** use `dist:win`'s `--publish always` until CMV passes). Portable target is out of scope for this CEP hotfix.
3. **Clean Machine Validation (CLAUDE.md Rule 22)** on a fresh Windows PC/VM — no prior install/dev env:
   - NSIS checklist: install, first launch → `cep-activate.html`, enter email → activates + seals, relaunch boots silently, backup/restore (now carries crew+equipment), print order chronological, update check, uninstall, reinstall.
   - **Copy-bypass on real machines:** activate on PC-A → copy install dir + `%APPDATA%\eORB CEP\` to PC-B → **must land on activation screen, must not open**.
   - n8n pre-flight (§5).
4. RC status table all green → publish GitHub Release, then update `electron-version.json` + `promo-auth.js` download URL in the same commit.
5. Merge the security fix into `wip/v1.4.19-vessel` (it already contains it from the snapshot) and resume vessel dev as **1.4.20**.

### RC status (Rule 22)
```
RC Build Created ............ PENDING (npm run build OK; dist not yet produced)
Integrity Check ............. PASS (13/13)
Security Logic Validation ... PASS (11/11)
NSIS Validation ............. PENDING (clean machine)
Activation Test (live n8n) .. PENDING (clean machine + real email)
Backup/Restore Test ......... PENDING (clean machine)
Print-order Test ............ PENDING (clean machine; code-verified)
Copy-bypass Test (2 PCs) .... PENDING (clean machines; logic PASS)
Regression .................. PENDING
Ready For Publish ........... NO
```

## 7. Residual risks (accepted / flagged)
- **MachineGuid clone collision:** un-sysprepped disk-image clones share a MachineGuid → would share a seal. Negligible for personal-laptop audience; add `cpuModel` to the binding if it ever matters. (Accepted.)
- **Unsigned binary / SmartScreen:** pre-existing; not addressed by this hotfix.
- **v1.4.18.1 → 1.4.19 renaming:** vessel train must move to 1.4.20 to avoid a version clash.

## 8. Rollback
Isolated branch; `git revert` restores instantly. electron-updater won't downgrade, so a field rollback = publish a higher version reverting the gate; keep the 1.4.18 NSIS installer available as manual fallback. Customers who already activated keep working through a rollback (their machine seal persists).

## 9. Branch state
- `wip/v1.4.19-vessel` `c2ce46c` — full snapshot (vessel + Phase A + security). Nothing lost.
- `hotfix/v1.4.18.1-security` — v1.4.17 base + security + 5 forward-ports + version bump. **Uncommitted** (awaiting your go to commit/build the installer).
