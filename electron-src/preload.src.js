// preload.src.js
// Bridge between the renderer (eORB UI + activation wizard) and main process.
// Runs with Node access but in an isolated context; only contextBridge.exposeInMainWorld
// keys are reachable from the renderer.

const { contextBridge, ipcRenderer } = require('electron');

let _bootStore = {};
let _license = null;
let _isPortable = false;
try {
  const boot = ipcRenderer.sendSync('eorb:boot');
  if (boot && typeof boot === 'object') {
    _bootStore = boot.store || {};
    _license = boot.license || null;
    _isPortable = !!boot.isPortable;
  }
} catch (err) {
  console.error('[preload] boot IPC failed:', err && err.message);
}

contextBridge.exposeInMainWorld('eORB', {
  license: _license,

  // CEP-installer activation (legacy, machine-locked).
  activate: (key, email) => ipcRenderer.invoke('eorb:activate', {
    key: String(key || ''),
    email: String(email || '')
  }),
  deactivate: () => ipcRenderer.invoke('eorb:deactivate'),

  // Portable first-activation ceremony.
  agreement: {
    submit: (payload) => ipcRenderer.invoke('eorb:agreement:submit', payload),
    openApp: () => ipcRenderer.invoke('eorb:agreement:openApp')
  },

  // USB hash (short prefix only -- never the full hash).
  usb: {
    hash: () => ipcRenderer.invoke('eorb:usb:hash')
  },

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
    download: () => ipcRenderer.invoke('eorb:updates:download'),
    install: () => ipcRenderer.invoke('eorb:updates:install'),
    openUrl: (url) => ipcRenderer.invoke('eorb:updates:openUrl', String(url)),
    onEvent: (cb) => {
      if (typeof cb !== 'function') return function noop() {};
      const handler = (_evt, payload) => { try { cb(payload); } catch (_) {} };
      ipcRenderer.on('eorb:updates:event', handler);
      return function off() { ipcRenderer.removeListener('eorb:updates:event', handler); };
    }
  },

  build: {
    productName: _isPortable ? 'eORB Pro Portable' : 'eORB CEP',
    edition: _isPortable ? 'Pro Portable Edition' : 'CEP Edition',
    version: '1.4.6-portable-electron',
    platform: process.platform,
    isPortable: _isPortable
  }
});
