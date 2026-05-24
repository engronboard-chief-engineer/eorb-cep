// preload.src.js
// Bridge between the renderer (the existing eORB HTML/JS UI) and the Electron
// main process. Runs with Node access but in an isolated context; the only
// things the renderer can call are what contextBridge exposes here.
//
// Renderer-side surface:
//   window.eORB.license        -> object | null  (resolved at preload time)
//   window.eORB.activate(key)  -> Promise<{ok, error?}>
//   window.eORB.store          -> sync KV (hydrated boot, async writes)
//   window.eORB.updates.check  -> Promise<{currentVersion, latestVersion, ...}>

const { contextBridge, ipcRenderer } = require('electron');

// One-shot synchronous hydrate of the SQLite store at preload time. The
// existing UI's localStorage calls in early <script> blocks will be served
// from this snapshot. Subsequent writes are also mirrored back to SQLite
// (handled by ui/app.src.js which the HTML loads first).
let _bootStore = {};
let _license = null;
try {
  const boot = ipcRenderer.sendSync('eorb:boot');
  if (boot && typeof boot === 'object') {
    _bootStore = boot.store || {};
    _license = boot.license || null;
  }
} catch (err) {
  // Boot IPC failed -- preload should still load so the UI can show an error.
  console.error('[preload] boot IPC failed:', err && err.message);
}

contextBridge.exposeInMainWorld('eORB', {
  // License info accessible synchronously by the renderer at any time.
  license: _license,

  // Activation: validates the key in main, writes encrypted license.dat.
  activate: (key) => ipcRenderer.invoke('eorb:activate', key),

  // Sign-out / clear license (for testing or de-activation flows).
  deactivate: () => ipcRenderer.invoke('eorb:deactivate'),

  // Synchronous-feeling store. Reads come from the boot snapshot in memory;
  // writes go to main asynchronously (fire-and-forget; SQLite is fast).
  store: {
    getAll: () => Object.assign({}, _bootStore),
    get: (k) => (k in _bootStore ? _bootStore[k] : null),
    set: (k, v) => {
      _bootStore[k] = String(v);
      ipcRenderer.send('eorb:store:set', { k: String(k), v: String(v) });
    },
    remove: (k) => {
      delete _bootStore[k];
      ipcRenderer.send('eorb:store:remove', { k: String(k) });
    },
    clear: () => {
      _bootStore = {};
      ipcRenderer.send('eorb:store:clear');
    }
  },

  updates: {
    check: () => ipcRenderer.invoke('eorb:updates:check'),
    openUrl: (url) => ipcRenderer.invoke('eorb:updates:openUrl', String(url))
  },

  // Identifying info (no secrets) for the renderer to display in About box.
  build: {
    productName: 'eORB CEP',
    edition: 'CEP Edition',
    version: '1.0.0',
    platform: process.platform
  }
});
