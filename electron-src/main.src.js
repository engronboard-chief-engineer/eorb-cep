// main.src.js
// Electron main process. Validates license + integrity before showing any
// window. Routes to activation.html on first launch or invalid license,
// otherwise loads the eORB UI from ui/index.html.

const { app, BrowserWindow, ipcMain, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

const activation = require('./security/activation');
const integrity = require('./security/integrity');
const machine = require('./security/machine');
const db = require('./db');

const APP_VERSION = '1.0.0';
const UPDATE_FEED_URL = 'https://chiefengineerpro.com/orb/electron-version.json';

const IS_DEV = !app.isPackaged;

// Single-instance lock so a second launch focuses the existing window instead
// of spawning another process (which would try to open the same SQLite file).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

function userDataDir() {
  return app.getPath('userData');
}

function showFatal(title, message) {
  try {
    dialog.showErrorBox(title, message);
  } catch (_) { /* may run before app is ready */ }
}

function blockDevToolsAccelerators(win) {
  // Defensive against F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+R / Ctrl+Shift+R / Ctrl+U.
  win.webContents.on('before-input-event', (event, input) => {
    if (IS_DEV) return;  // allow during dev
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
    // Allow only file:// loads within our app dir. Anything else opens
    // externally in the user's browser (license update links etc).
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
      sandbox: false,            // preload uses Node (better-sqlite3 via IPC, fs); sandbox would block it
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
  // Tight CSP for renderer. file:// inline scripts in the eORB UI need
  // 'unsafe-inline' for <script> blocks. No remote script/style allowed.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data: blob:;",
          "script-src 'self' 'unsafe-inline';",
          "style-src 'self' 'unsafe-inline';",
          "img-src 'self' data: blob:;",
          "connect-src 'self';"
        ].join(' ')
      }
    });
  });
}

function registerIpc() {
  // Boot bundle: returns the license (decrypted snapshot of safe fields) plus
  // a hydrated copy of the SQLite KV store. Single sync call from preload.
  ipcMain.on('eorb:boot', (event) => {
    let lic = null;
    try {
      const full = activation.loadLicense(userDataDir());
      if (full) {
        lic = {
          customer_id: full.customer_id,
          email: full.email,
          activation_date: full.activation_date,
          build_id: full.build_id
        };
      }
    } catch (_) { lic = null; }
    let store = {};
    try {
      db.init(userDataDir());
      store = db.getAll(userDataDir());
    } catch (err) {
      console.error('[main] boot store hydrate failed:', err.message);
    }
    event.returnValue = { license: lic, store };
  });

  ipcMain.handle('eorb:activate', async (_evt, key) => {
    try {
      const result = activation.activate(key, userDataDir());
      if (result.ok) {
        // Reload window into the eORB UI.
        if (mainWindow) {
          setTimeout(() => {
            mainWindow.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
          }, 200);
        }
      }
      return result;
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('eorb:deactivate', async () => {
    try { activation.clearLicense(userDataDir()); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.on('eorb:store:set', (_evt, payload) => {
    try { db.set(userDataDir(), payload.k, payload.v); } catch (_) {}
  });
  ipcMain.on('eorb:store:remove', (_evt, payload) => {
    try { db.remove(userDataDir(), payload.k); } catch (_) {}
  });
  ipcMain.on('eorb:store:clear', () => {
    try { db.clear(userDataDir()); } catch (_) {}
  });

  ipcMain.handle('eorb:updates:check', async () => {
    return await new Promise((resolve) => {
      try {
        https.get(UPDATE_FEED_URL, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(data);
              resolve({
                ok: true,
                currentVersion: APP_VERSION,
                latestVersion: j.version || null,
                downloadUrl: j.downloadUrl || null,
                notes: j.notes || ''
              });
            } catch (err) {
              resolve({ ok: false, error: 'invalid feed: ' + err.message });
            }
          });
        }).on('error', (err) => resolve({ ok: false, error: err.message }));
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  });

  ipcMain.handle('eorb:updates:openUrl', async (_evt, url) => {
    try { await shell.openExternal(url); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // 1. Integrity check (production only).
  if (!IS_DEV) {
    const res = integrity.verify(app.getAppPath());
    if (!res.ok) {
      showFatal('Integrity violation detected',
        'eORB CEP failed its integrity check and will now exit.\n\n' +
        'Reason: ' + res.reason + '\n\n' +
        'Please reinstall from the original distribution.');
      app.quit();
      return;
    }
  }

  applyCSP();
  registerIpc();

  // 2. Open SQLite (lazy; just ensures dir exists).
  try { db.init(userDataDir()); } catch (err) {
    console.error('[main] db init failed:', err.message);
  }

  // 3. Route to activation or main UI based on license status.
  const hasLic = activation.hasValidLicense(userDataDir());
  mainWindow = createMainWindow(hasLic ? 'index.html' : 'activation.html');
});

app.on('window-all-closed', () => {
  db.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const hasLic = activation.hasValidLicense(userDataDir());
    mainWindow = createMainWindow(hasLic ? 'index.html' : 'activation.html');
  }
});
