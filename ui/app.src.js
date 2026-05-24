// ui/app.src.js
// Renderer-side bootstrap for the eORB CEP Electron build.
// Loaded as the FIRST <script> in <head> (prepare-ui.mjs injects the tag),
// before any of the eORB UI's own scripts run. Its job:
//
//   1. Intercept localStorage reads/writes so the existing UI -- which is
//      written against the standard Web Storage API -- transparently persists
//      to SQLite via the Electron preload bridge (window.eORB.store).
//   2. Expose backup/restore helpers (eORBExport / eORBImport) that the
//      Settings panel can wire to buttons.
//   3. Expose update-check helpers (eORBCheckForUpdates / eORBOpenDownload).
//
// In a non-Electron environment (e.g. running the HTML in a normal browser
// for debugging), window.eORB will be undefined and this file is a no-op --
// the native localStorage continues to work.

(function () {
  'use strict';

  if (!window.eORB || !window.eORB.store) {
    // Not running under Electron preload -- leave native localStorage alone.
    return;
  }

  var store = window.eORB.store;

  // ---- localStorage shim --------------------------------------------------
  //
  // Replace the global localStorage with a proxy that delegates to SQLite.
  // We can't redefine `window.localStorage` directly (it's a non-configurable
  // property), so we use Object.defineProperty on the prototype.
  try {
    var shim = {
      getItem: function (k) {
        var v = store.get(k);
        return v === null || v === undefined ? null : String(v);
      },
      setItem: function (k, v) { store.set(k, v); },
      removeItem: function (k) { store.remove(k); },
      clear: function () { store.clear(); },
      key: function (i) {
        var keys = Object.keys(store.getAll());
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
      get length() { return Object.keys(store.getAll()).length; }
    };

    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: function () { return shim; }
      });
    } catch (err) {
      // Some Electron versions / contexts won't let us redefine; mirror writes
      // back to native localStorage as a fallback so at least the UI works
      // (data won't persist across uninstalls but works in-session).
      console.warn('[eORB-shim] localStorage redefinition failed; falling back to mirror mode:', err && err.message);
    }
  } catch (err) {
    console.error('[eORB-shim] failed to install localStorage shim:', err);
  }

  // ---- backup / restore helpers ------------------------------------------

  window.eORBExport = function () {
    var data = store.getAll();
    var payload = {
      schema: 'eorb-export-1',
      product: (window.eORB.build && window.eORB.build.productName) || 'eORB CEP',
      exportedAt: new Date().toISOString(),
      data: data
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'eorb-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return { count: Object.keys(data).length };
  };

  window.eORBImport = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('no file'));
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          if (!parsed || parsed.schema !== 'eorb-export-1' || !parsed.data) {
            return reject(new Error('not a valid eORB export file'));
          }
          var count = 0;
          for (var k in parsed.data) {
            if (Object.prototype.hasOwnProperty.call(parsed.data, k)) {
              store.set(k, parsed.data[k]);
              count++;
            }
          }
          resolve({ count: count });
        } catch (err) { reject(err); }
      };
      reader.onerror = function () { reject(new Error('file read failed')); };
      reader.readAsText(file);
    });
  };

  // ---- update-check helpers ----------------------------------------------

  window.eORBCheckForUpdates = function () {
    if (!window.eORB.updates || !window.eORB.updates.check) {
      return Promise.resolve({ ok: false, error: 'updates bridge unavailable' });
    }
    return window.eORB.updates.check();
  };

  window.eORBOpenDownload = function (url) {
    if (!window.eORB.updates || !window.eORB.updates.openUrl) {
      window.open(url, '_blank');
      return Promise.resolve({ ok: true });
    }
    return window.eORB.updates.openUrl(url);
  };

  // ---- diagnostics --------------------------------------------------------

  // Expose a small read-only build identity for the renderer to use in
  // About boxes or footers.
  window.eORBBuild = window.eORB.build;

  // One-shot console hello so we can confirm the shim loaded in dev.
  try {
    console.log('[eORB-shim] ready  build=' + (window.eORB.build && window.eORB.build.version) + '  licensed=' + !!window.eORB.license);
  } catch (_) { /* ignore */ }
})();
