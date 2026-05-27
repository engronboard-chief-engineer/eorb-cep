// main.src.js
// Electron main process. Two activation modes:
//   - PORTABLE (USB-locked, online first-activation with signed agreement):
//     activated when running from the electron-builder "portable" .exe
//     (PORTABLE_EXECUTABLE_DIR is set), or when EORB_FORCE_PORTABLE=1.
//   - CEP INSTALLER (machine-locked, offline-HMAC key):
//     activated when running from an NSIS install or DMG bundle.
//
// In both modes the same eORB simulator UI loads from ui/index.html once
// activation succeeds; only the gate and the license storage differ.

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const activation = require('./security/activation');
const integrity = require('./security/integrity');
const machine = require('./security/machine');
const usb = require('./security/usb');
const agreement = require('./agreement');
const db = require('./db');

// electron-updater is optional at dev-time (not installed in CI for the
// renderer) but required for packaged NSIS auto-update. Load defensively
// so dev builds without it still boot.
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) {}

const APP_VERSION = '1.4.7-portable-electron';
const UPDATE_FEED_URL = 'https://www.chiefengineerpro.com/orb/electron-version.json';

const IS_DEV = !app.isPackaged;

// Portable detection: electron-builder's portable target sets
// PORTABLE_EXECUTABLE_DIR to the runtime extract dir. The actual USB-root
// path is the parent of the .exe file. EORB_FORCE_PORTABLE=1 lets us test
// the portable code path in dev.
function isPortableBuild() {
  if (process.env.EORB_FORCE_PORTABLE === '1') return true;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  return false;
}

// USB root resolution:
//   - In a true portable build: directory containing the launched .exe.
//   - In dev with EORB_FORCE_PORTABLE=1: a sandbox dir under the project so
//     we can test write/read without owning a USB stick.
function resolveUsbRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // For electron-builder portable: PORTABLE_EXECUTABLE_DIR is the user-
    // visible directory where the .exe lives (USB root). Files we write
    // there persist; the temporary asar extraction is elsewhere.
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (process.env.EORB_FORCE_PORTABLE === '1') {
    const sandbox = path.join(app.getPath('userData'), 'portable-sandbox');
    if (!fs.existsSync(sandbox)) fs.mkdirSync(sandbox, { recursive: true });
    return sandbox;
  }
  // Not portable -- fall back to userData so the installer build still works.
  return app.getPath('userData');
}

function resolveUsbDataDir(usbRoot) {
  return isPortableBuild() ? path.join(usbRoot, 'eorb-data') : usbRoot;
}

// Register eorb:// for one-click activation in the installer build.
if (!IS_DEV && !isPortableBuild()) app.setAsDefaultProtocolClient('eorb');

function parseEorbProtocolUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname !== '//activate' && u.hostname !== 'activate') return null;
    const key = u.searchParams.get('key');
    const email = u.searchParams.get('email');
    if (!key || !email) return null;
    return { key, email };
  } catch (_) { return null; }
}

async function handleProtocolActivation(rawUrl) {
  // Portable build doesn't use eorb:// links (its flow is the signed-agreement
  // wizard). Ignore the protocol entirely there.
  if (isPortableBuild()) return;
  const params = parseEorbProtocolUrl(rawUrl);
  if (!params) return;
  const result = activation.activate(params.key, params.email, app.getPath('userData'));
  if (result.ok && mainWindow) {
    mainWindow.focus();
    setTimeout(() => {
      mainWindow.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
    }, 200);
  } else if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('eorb:protocol:activate-result', result);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let _usbRoot = null;
let _usbHash = null;

function showFatal(title, message) {
  try { dialog.showErrorBox(title, message); } catch (_) {}
}

function blockDevToolsAccelerators(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (IS_DEV) return;
    const k = (input.key || '').toLowerCase();
    const ctrl = input.control || input.meta;
    const shift = input.shift;
    if (k === 'f12') { event.preventDefault(); return; }
    if (ctrl && shift && (k === 'i' || k === 'j' || k === 'c')) { event.preventDefault(); return; }
    if (ctrl && (k === 'r' || k === 'u')) { event.preventDefault(); return; }
  });
}

function blockContextMenu(win) {
  win.webContents.on('context-menu', (e) => { if (!IS_DEV) e.preventDefault(); });
}

function blockNavigation(win) {
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

function createMainWindow(initialPage) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0a0d12',
    show: false,
    autoHideMenuBar: true,
    icon: process.platform === 'win32'
      ? path.join(app.getAppPath(), 'build', 'icon.ico')
      : path.join(app.getAppPath(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: IS_DEV,
      spellcheck: false
    }
  });

  win.removeMenu();
  Menu.setApplicationMenu(null);

  blockDevToolsAccelerators(win);
  blockContextMenu(win);
  blockNavigation(win);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  win.loadFile(path.join(app.getAppPath(), 'ui', initialPage));
  return win;
}

function applyCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data: blob:;",
          "script-src 'self' 'unsafe-inline';",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;",
          "font-src 'self' https://fonts.gstatic.com data:;",
          "img-src 'self' data: blob:;",
          "connect-src 'self' https://n8n.srv1083339.hstgr.cloud https://chiefengineerpro.com https://www.chiefengineerpro.com;"
        ].join(' ')
      }
    });
  });
}

function registerIpc() {
  // Boot bundle (sync). Returns license snapshot + hydrated KV store.
  ipcMain.on('eorb:boot', (event) => {
    let lic = null;
    try {
      const full = isPortableBuild()
        ? activation.loadPortableLicense(resolveUsbDataDir(_usbRoot), _usbHash)
        : activation.loadLicense(app.getPath('userData'));
      if (full) {
        lic = {
          customer_id: full.customer_id,
          email: full.email,
          full_name: full.full_name || null,
          country: full.country || null,
          rank: full.rank || null,
          company: full.company || null,
          vessel: full.vessel || null,
          activation_date: full.activation_date,
          build_id: full.build_id,
          license_id: full.license_id || null,
          edition: full.edition || 'cep'
        };
      }
    } catch (_) { lic = null; }
    let store = {};
    try {
      const dataDir = resolveUsbDataDir(_usbRoot);
      db.init(dataDir);
      store = db.getAll(dataDir);
    } catch (err) {
      console.error('[main] boot store hydrate failed:', err.message);
    }
    event.returnValue = { license: lic, store, isPortable: isPortableBuild() };
  });

  // --- CEP installer activation (legacy, machine-locked) ---
  ipcMain.handle('eorb:activate', async (_evt, payload) => {
    if (isPortableBuild()) {
      return { ok: false, error: 'wrong_flow_for_portable_build' };
    }
    let key, email;
    if (payload && typeof payload === 'object') { key = payload.key; email = payload.email; }
    else { key = payload; email = ''; }
    try {
      const result = activation.activate(key, email, app.getPath('userData'));
      if (result.ok && mainWindow) {
        setTimeout(() => {
          mainWindow.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
        }, 200);
      }
      return result;
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('eorb:deactivate', async () => {
    try {
      if (isPortableBuild()) {
        activation.clearPortableLicense(resolveUsbDataDir(_usbRoot));
      } else {
        activation.clearLicense(app.getPath('userData'));
      }
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // --- Portable: first-activation agreement ceremony ---
  ipcMain.handle('eorb:agreement:submit', async (_evt, payload) => {
    if (!isPortableBuild()) {
      return { ok: false, error: 'agreement_flow_unavailable' };
    }
    try {
      const res = await agreement.submitAgreement({
        usbRoot: _usbRoot,
        identity: payload && payload.identity,
        agreement: payload && payload.agreement,
        signatureDataUrl: payload && payload.signatureDataUrl,
        clientVersion: APP_VERSION
      });
      if (res.ok) {
        // Refresh USB hash + redirect cached license on next boot read.
        try { _usbHash = (usb.computeUsbHash(_usbRoot).hash) || _usbHash; } catch (_) {}
      }
      return res;
    } catch (err) {
      return { ok: false, error: 'exception', detail: err.message };
    }
  });

  ipcMain.handle('eorb:agreement:openApp', async () => {
    if (!mainWindow) return { ok: false, error: 'no_window' };
    try {
      await mainWindow.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('eorb:usb:hash', async () => {
    if (!isPortableBuild()) return { ok: false, error: 'not_portable' };
    const r = usb.computeUsbHash(_usbRoot);
    if (!r.ok) return r;
    return { ok: true, hash_short: r.hash.slice(0, 12) };
  });

  // --- KV store (DB writes routed to the resolved data dir) ---
  ipcMain.on('eorb:store:set', (_evt, payload) => {
    try { db.set(resolveUsbDataDir(_usbRoot), payload.k, payload.v); } catch (_) {}
  });
  ipcMain.on('eorb:store:remove', (_evt, payload) => {
    try { db.remove(resolveUsbDataDir(_usbRoot), payload.k); } catch (_) {}
  });
  ipcMain.on('eorb:store:clear', () => {
    try { db.clear(resolveUsbDataDir(_usbRoot)); } catch (_) {}
  });

  // --- Update check ---
  // Two paths:
  //   1. NSIS installer build (eORB CEP): electron-updater pulls latest.yml
  //      from GitHub Releases on engronboard-chief-engineer/eorb-cep,
  //      downloads in-app, and silently runs the new installer on quit.
  //   2. Portable build (eORB Pro Portable): no installer to run, so we
  //      keep the legacy fetch-feed + open-browser flow. Users must manually
  //      replace the .exe on their USB stick.
  //
  // Both paths report through the same IPC contract so the renderer banner
  // doesn't care which build it's in.
  const _useAutoUpdater = !!autoUpdater && !isPortableBuild() && !IS_DEV;

  if (_useAutoUpdater) {
    autoUpdater.autoDownload = false;        // user clicks "Update" first
    autoUpdater.autoInstallOnAppQuit = false; // we invoke quitAndInstall ourselves
    autoUpdater.allowDowngrade = false;
    try { autoUpdater.logger = null; } catch (_) {}

    const _emit = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send(channel, payload); } catch (_) {}
      }
    };

    autoUpdater.on('update-available', (info) => {
      _emit('eorb:updates:event', { type: 'available', version: info && info.version });
    });
    autoUpdater.on('update-not-available', () => {
      _emit('eorb:updates:event', { type: 'not-available' });
    });
    autoUpdater.on('download-progress', (p) => {
      _emit('eorb:updates:event', {
        type: 'progress',
        percent: p && typeof p.percent === 'number' ? p.percent : 0,
        bytesPerSecond: p && p.bytesPerSecond || 0,
        transferred: p && p.transferred || 0,
        total: p && p.total || 0
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      _emit('eorb:updates:event', { type: 'downloaded', version: info && info.version });
    });
    autoUpdater.on('error', (err) => {
      _emit('eorb:updates:event', {
        type: 'error',
        message: (err && err.message) || String(err || 'unknown')
      });
    });
  }

  // Renderer asks: is there a new version? Returns the same shape as the
  // legacy feed-fetch so the banner UI is unchanged. For NSIS we also note
  // autoUpdate=true so the banner knows to swap "Open browser" -> "Update".
  ipcMain.handle('eorb:updates:check', async () => {
    if (_useAutoUpdater) {
      try {
        const res = await autoUpdater.checkForUpdates();
        const latest = res && res.updateInfo && res.updateInfo.version;
        return {
          ok: true,
          autoUpdate: true,
          currentVersion: APP_VERSION,
          latestVersion: latest || null,
          sizeMb: null,
          headline: res && res.updateInfo && res.updateInfo.releaseName || null,
          notes: (function(raw) {
            var s = (raw && typeof raw === 'string') ? raw : '';
            return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
          })(res && res.updateInfo && res.updateInfo.releaseNotes),
          urgency: 'recommended'
        };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    // Portable path: fetch the legacy JSON feed and report the download URL
    // for the user to open in their browser (manual replace on USB).
    return await new Promise((resolve) => {
      const fetchFeed = (url, hops) => {
        try {
          https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
              res.resume();
              const next = new URL(res.headers.location, url).toString();
              return fetchFeed(next, hops + 1);
            }
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              try {
                const j = JSON.parse(data);
                const platform = process.platform === 'darwin' ? 'mac' : 'win';
                const downloadUrl = platform === 'mac'
                  ? (j.downloadUrlMac || j.downloadUrl || null)
                  : (j.downloadUrlWin || j.downloadUrl || null);
                resolve({
                  ok: true,
                  autoUpdate: false,
                  currentVersion: APP_VERSION,
                  latestVersion: j.version || j.latest || null,
                  downloadUrl,
                  sizeMb: j.sizeMb || null,
                  headline: j.headline || null,
                  notes: j.notes || '',
                  urgency: j.urgency || 'recommended'
                });
              } catch (err) {
                resolve({ ok: false, error: 'invalid feed: ' + err.message });
              }
            });
          }).on('error', (err) => resolve({ ok: false, error: err.message }));
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      };
      fetchFeed(UPDATE_FEED_URL, 0);
    });
  });

  // Start the in-app download. NSIS only — portable can't auto-install.
  ipcMain.handle('eorb:updates:download', async () => {
    if (!_useAutoUpdater) return { ok: false, error: 'auto_update_unavailable' };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Quit, run the installer silently, relaunch into the new version.
  // The two booleans: isSilent=true, isForceRunAfter=true.
  ipcMain.handle('eorb:updates:install', async () => {
    if (!_useAutoUpdater) return { ok: false, error: 'auto_update_unavailable' };
    try {
      setImmediate(() => {
        try { autoUpdater.quitAndInstall(true, true); }
        catch (err) { console.error('[updates] quitAndInstall failed:', err.message); }
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('eorb:updates:openUrl', async (_evt, url) => {
    try { await shell.openExternal(url); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

app.on('second-instance', (_evt, argv) => {
  const url = argv.find(a => a.startsWith('eorb://'));
  if (url) {
    handleProtocolActivation(url);
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith('eorb://')) handleProtocolActivation(url);
});

app.whenReady().then(() => {
  // 1. Integrity check (production only).
  if (!IS_DEV) {
    const res = integrity.verify(app.getAppPath());
    if (!res.ok) {
      showFatal('Integrity violation detected',
        'eORB failed its integrity check and will now exit.\n\n' +
        'Reason: ' + res.reason + '\n\n' +
        'Please re-download from chiefengineerpro.com.');
      app.quit();
      return;
    }
  }

  applyCSP();

  // 2. Resolve USB root + hash (portable build only).
  _usbRoot = resolveUsbRoot();
  if (isPortableBuild()) {
    const r = usb.computeUsbHash(_usbRoot);
    if (r.ok) {
      _usbHash = r.hash;
    } else {
      showFatal('USB drive not detected',
        'eORB Pro Portable must run from a USB drive.\n\n' +
        'Reason: ' + r.error + '\n\n' +
        'Copy eORB.exe to a real USB stick and launch it from there.');
      app.quit();
      return;
    }
  }

  registerIpc();

  // 3. Open SQLite at the resolved data dir.
  try { db.init(resolveUsbDataDir(_usbRoot)); }
  catch (err) { console.error('[main] db init failed:', err.message); }

  // 4. Route to activation or main UI.
  let hasLic;
  if (isPortableBuild()) {
    hasLic = activation.hasValidPortableLicense(resolveUsbDataDir(_usbRoot), _usbHash);
  } else {
    hasLic = activation.hasValidLicense(app.getPath('userData'));
  }
  mainWindow = createMainWindow(hasLic ? 'index.html' : 'activation.html');
});

app.on('window-all-closed', () => {
  db.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    let hasLic;
    if (isPortableBuild()) {
      hasLic = activation.hasValidPortableLicense(resolveUsbDataDir(_usbRoot), _usbHash);
    } else {
      hasLic = activation.hasValidLicense(app.getPath('userData'));
    }
    mainWindow = createMainWindow(hasLic ? 'index.html' : 'activation.html');
  }
});
