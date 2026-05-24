# eORB CEP — Rebuild COMPLETED (2026-05-24)

Original rebuild plan is in [project_eorb-electron memory](../../../.claude/projects/c--Users-Roy-Joseph-Alim-Documents-n8n-builder/memory/project_eorb-electron.md). This file kept as a historical record of what happened.

## Outcome

- Product renamed: eORB Premium → **eORB CEP**.
- Source rebuilt in `electron-src/**/*.src.js`; old obfuscated `electron/*.js` deleted.
- `scripts/obfuscate.js` rewritten so it never touches source paths (Rule #16 added to CLAUDE.md).
- `git init`'d inside this directory + initial commit before any code touched.
- Fingerprint algorithm fixed (stable inputs only).
- ELECTRON_RUN_AS_NODE silent-exit fixed via `@electron/fuses` `RunAsNode=false` flip in `scripts/after-pack.js`.
- License algorithm preserved — existing key `8F88-2003-2A7A-CBF8` still validates against `.secrets/master.txt`.
- Windows .exe (83 MB) built + verified end-to-end. macOS .dmg added to `package.json` + CI workflow at `.github/workflows/build.yml`.

## What happened the night of 2026-05-24 (original)

1. First .exe built + activation flow verified yesterday (TEST-0001 + key `8F88-2003-2A7A-CBF8`).
2. Today: tried to fix "inner email activation gate still showing after Electron activation."
3. Edited `scripts/prepare-ui.mjs` to bypass inner gate — that part is fine.
4. **But** a second build was run, and `scripts/obfuscate.js` overwrote `electron/*.js` IN PLACE.
5. Every relaunch then failed: license validation runs, returns invalid, main process exits with no window. Activation succeeds (writes license.dat) but next launch can't read it.
6. We could not fix it by inspecting source — `electron/security/machine.js`, `activation.js`, etc. were all 80KB+ obfuscated blobs with no `.src` backup and no git history.

## The lessons (recorded in memory)

- **Never run an in-place obfuscator on plaintext source** ([feedback_electron-obfuscate-in-place](../../../.claude/projects/c--Users-Roy-Joseph-Alim-Documents-n8n-builder/memory/feedback_electron-obfuscate-in-place.md))
- **Stable fingerprint inputs only** — no MACs, no memory, no time (in `electron-src/security/machine.src.js`)
- **`ELECTRON_RUN_AS_NODE=1` kills the packaged .exe silently** — fix via `RunAsNode` fuse flip ([feedback_electron-build-windows](../../../.claude/projects/c--Users-Roy-Joseph-Alim-Documents-n8n-builder/memory/feedback_electron-build-windows.md))
- **Always verify unobfuscated first** — phase 3 gate in rebuild plan
- **`git init` before any code changes** — never lose source again
