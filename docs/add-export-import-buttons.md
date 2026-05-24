# Adding Export / Import buttons to the eORB Settings panel

The Electron renderer shim (`ui/app.js`) already exposes two helpers globally:

- `window.eORBExport()` — downloads `eorb-export-YYYY-MM-DD.json`
- `window.eORBImport(file)` — accepts a `File` from an `<input type=file>`
- `window.eORBCheckForUpdates()` — fetches version JSON
- `window.eORBOpenDownload(url)` — opens browser to download URL

These work in the Electron build immediately. To surface them in the UI,
add buttons inside the Settings panel section of `eORB-Portable.html.src`
(or the renamed source file). Then run `npm run prep` to regenerate
`ui/index.html` for Electron.

Suggested HTML snippet to add inside the Equipment / Settings tab:

```html
<div class="setting-row" style="margin-top:18px;border-top:1px dashed #2a3344;padding-top:14px">
  <h4 style="margin:0 0 8px;font-size:14px;color:#c9a227">Backup &amp; Restore</h4>
  <p style="margin:0 0 12px;font-size:12px;color:#8896a8">
    Export your entries as a JSON file for backup, or to transfer to a new machine.
  </p>
  <button type="button" id="btn-export-json" style="padding:8px 14px;background:#1a212c;border:1px solid #2a3344;border-radius:6px;color:#e5edf5;cursor:pointer">
    Export all data (.json)
  </button>
  <label for="file-import-json" style="display:inline-block;margin-left:8px;padding:8px 14px;background:#1a212c;border:1px solid #2a3344;border-radius:6px;color:#e5edf5;cursor:pointer">
    Import from file&hellip;
  </label>
  <input id="file-import-json" type="file" accept=".json" style="display:none" />
</div>

<!-- Only visible in Electron build (window.eORB present) -->
<div id="electron-only-block" style="display:none;margin-top:18px;border-top:1px dashed #2a3344;padding-top:14px">
  <h4 style="margin:0 0 8px;font-size:14px;color:#c9a227">Software Updates</h4>
  <p style="margin:0 0 12px;font-size:12px;color:#8896a8">
    The app works fully offline forever. Click below only if you want to check
    whether a newer version is available.
  </p>
  <button type="button" id="btn-check-updates" style="padding:8px 14px;background:#1a212c;border:1px solid #2a3344;border-radius:6px;color:#e5edf5;cursor:pointer">
    Check for updates
  </button>
  <div id="update-status" style="margin-top:8px;font-size:12px;color:#8896a8"></div>
</div>

<script>
  (function () {
    var exp = document.getElementById('btn-export-json');
    var imp = document.getElementById('file-import-json');
    if (exp) exp.addEventListener('click', function () {
      if (window.eORBExport) {
        window.eORBExport();
      } else {
        // Browser-only fallback: build the same JSON from localStorage directly
        var data = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          data[k] = localStorage.getItem(k);
        }
        var blob = new Blob([JSON.stringify({
          schema: 'eorb-export-1',
          exportedAt: new Date().toISOString(),
          data: data
        }, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'eorb-export-' + new Date().toISOString().slice(0,10) + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      }
    });
    if (imp) imp.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      if (window.eORBImport) {
        window.eORBImport(f).then(function (r) {
          alert('Imported ' + r.count + ' entries. Reload to see them.');
          location.reload();
        }).catch(function (err) { alert('Import failed: ' + err.message); });
      } else {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var parsed = JSON.parse(reader.result);
            if (parsed.schema !== 'eorb-export-1' || !parsed.data) throw new Error('invalid file');
            for (var k in parsed.data) localStorage.setItem(k, parsed.data[k]);
            alert('Imported ' + Object.keys(parsed.data).length + ' entries.');
            location.reload();
          } catch (err) { alert('Import failed: ' + err.message); }
        };
        reader.readAsText(f);
      }
    });

    // Show updates block only in Electron
    if (window.eORB && window.eORB.updates) {
      var block = document.getElementById('electron-only-block');
      if (block) block.style.display = 'block';
    }
    var upd = document.getElementById('btn-check-updates');
    var upStatus = document.getElementById('update-status');
    if (upd && upStatus) upd.addEventListener('click', async function () {
      upStatus.textContent = 'Checking…';
      var r = await window.eORBCheckForUpdates();
      if (!r.ok) { upStatus.textContent = r.reason || 'Could not check.'; return; }
      if (r.latest && r.current && r.latest !== r.current) {
        upStatus.innerHTML = 'New version available: <strong>' + r.latest + '</strong> &nbsp; <a href="#" id="dl-link" style="color:#c9a227">Download</a>'
          + (r.notes ? '<div style="margin-top:6px;font-size:11px">' + r.notes + '</div>' : '');
        var dl = document.getElementById('dl-link');
        if (dl) dl.addEventListener('click', function (ev) { ev.preventDefault(); window.eORBOpenDownload(r.downloadUrl); });
      } else {
        upStatus.textContent = 'You\'re on the latest version (' + r.current + ').';
      }
    });
  })();
</script>
```

Paste this inside the existing Settings / Equipment tab in the source HTML.
Same snippet works for both Electron (`ui/index.html` regenerated by prep)
and the browser builds (Portable, PWA) — the script auto-detects which
environment it's in via `window.eORB` presence.
