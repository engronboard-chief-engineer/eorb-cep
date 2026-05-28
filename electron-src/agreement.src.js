// agreement.src.js
// First-activation ceremony for the Portable Edition.
//
// Flow when the renderer (ui/activation.html) calls window.eORB.agreement.submit(payload):
//   1. Compute the USB hash of the directory the .exe is running from.
//   2. Call activation.activateOnline() to hit the n8n agreement webhook.
//      n8n: validates membership, generates signed token + license_id, writes
//      a row to the ORB_Activations sheet with full identity + signature hash.
//   3. Render the signed PDF in a hidden BrowserWindow and grab the buffer via
//      webContents.printToPDF() -- no physical printer, no dialog.
//   4. Write the sealed license.dat to USB (key = usb_hash), and write the PDF
//      to BOTH (a) eorb-data/agreement.pdf and (b) USB-root/License Agreement.pdf
//      for the user-facing copy.
//   5. POST the PDF (base64) to the n8n /webhook/orb-agreement-upload workflow,
//      which uploads to Google Drive and back-fills pdf_drive_url on the sheet.
//   6. Resolve to the renderer with { ok: true, license_id }.
//
// Failure modes:
//   - Step 2 fails (no internet / non-member / revoked) -> nothing is written.
//   - Step 3 fails (PDF render error) -> nothing is written; user retries.
//   - Step 4 succeeds, Step 5 fails -> license activates anyway; the Drive
//     upload is best-effort and silently retried on next launch if internet
//     is available. (Out of scope for v1 -- log only.)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { BrowserWindow, app } = require('electron');

const usb = require('./security/usb');
const activation = require('./security/activation');

const ORB_AGREEMENT_UPLOAD_URL = 'https://n8n.srv1083339.hstgr.cloud/webhook/orb-agreement-upload';

// resolveUsbContext({ usbRoot })
//   Computes the USB hash and resolves the eorb-data directory next to the .exe.
function resolveUsbContext(usbRoot) {
  const r = usb.computeUsbHash(usbRoot);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    usbRoot,
    usbDataDir: path.join(usbRoot, 'eorb-data'),
    usbHash: r.hash
  };
}

function hashSignature(dataUrl) {
  return crypto.createHash('sha256').update(String(dataUrl || '')).digest('hex');
}

const AGREEMENT_TEXT = [
  'I confirm this license is for my personal authorized use.',
  'I agree not to redistribute, clone, upload, resell, reverse engineer, ' +
    'or share unauthorized copies of this software or my license key.',
  'I understand the software may include license verification, telemetry, ' +
    'watermarking, and anti-piracy mechanisms.',
  'I acknowledge that unauthorized redistribution may result in revocation ' +
    'of my license without refund or notice.'
];

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Hidden-window renderer of the A4 agreement page. We don't load a file from
// disk -- we inject the rendered HTML directly via loadURL(data:) so the PDF
// template is self-contained and not subject to integrity-manifest concerns.
async function renderAgreementPdf({ identity, agreement, signatureDataUrl, licenseId, activationId, usbHash, timestamp }) {
  const html = buildAgreementHtml({
    identity, agreement, signatureDataUrl, licenseId, activationId, usbHash, timestamp
  });

  const win = new BrowserWindow({
    width: 800,
    height: 1100,
    show: false,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
      // offscreen removed: printToPDF fails on offscreen-rendered windows.
      // webSecurity:false lets the inline base64 signature <img> load when
      // the page itself is served from a data: URL (some Electron builds
      // otherwise block the nested data:image resource).
    }
  });

  try {
    // Write HTML to a temp file instead of a data: URL. Large base64 data
    // URLs (signature image inside the HTML) can exceed Chromium's URL
    // length limits in packaged builds and cause loadURL to silently fail.
    const tmpDir = app.getPath('temp');
    const tmpFile = path.join(tmpDir, `eorb-agreement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
    fs.writeFileSync(tmpFile, html, 'utf8');

    const fileUrl = 'file:///' + tmpFile.replace(/\\/g, '/');
    try {
      await win.loadURL(fileUrl);
    } catch (loadErr) {
      throw new Error('loadURL failed: ' + loadErr.message);
    }

    // Wait for fonts AND the signature image to be fully decoded before we
    // call printToPDF. document.fonts.ready resolves once webfonts settle;
    // the image check resolves once <img> is naturalWidth>0.
    try {
      await win.webContents.executeJavaScript(`(async () => {
        try { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } } catch(_) {}
        const imgs = Array.from(document.images || []);
        await Promise.all(imgs.map(img => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise(res => {
            const done = () => res();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 2500);
          });
        }));
        return true;
      })()`, true);
    } catch (waitErr) {
      // Don't abort -- some renderer envs reject executeJavaScript but the
      // page is still printable. Fall through to printToPDF.
    }

    // Belt-and-suspenders: a small fixed delay covers any tail layout work
    // (CSS grid, gradient backgrounds) that finishes after image-load fires.
    await new Promise(r => setTimeout(r, 400));

    let pdf;
    try {
      pdf = await win.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        landscape: false,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
      });
    } catch (pdfErr) {
      throw new Error('printToPDF failed: ' + pdfErr.message);
    }

    // Clean up the temp HTML.
    try { fs.unlinkSync(tmpFile); } catch (_) {}

    return pdf;
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

function buildAgreementHtml({ identity, agreement, signatureDataUrl, licenseId, activationId, usbHash, timestamp }) {
  const id = identity || {};
  const sigImgTag = signatureDataUrl
    ? `<img src="${escapeHtml(signatureDataUrl)}" alt="Signature" />`
    : '<em style="color:#888">— no signature captured —</em>';
  const watermark = `${escapeHtml(licenseId)}.${escapeHtml(String(usbHash || '').slice(0, 12))}.${escapeHtml(activationId || '')}`;
  const dt = timestamp ? new Date(timestamp) : new Date();
  const dateStr = dt.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');
  const agreementHtml = AGREEMENT_TEXT.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>eORB Pro Portable — License Agreement</title>
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', -apple-system, system-ui, Arial, sans-serif;
    color: #14181f;
    background: #ffffff;
    padding: 40px 48px 36px;
    line-height: 1.45;
    font-size: 11.5pt;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 18px; border-bottom: 2px solid #c9a227; }
  .brand { font-weight: 700; font-size: 16pt; letter-spacing: 0.02em; color: #0a0d12; }
  .brand .accent { color: #c9a227; }
  .doc-meta { font-size: 9pt; color: #5a6373; text-align: right; line-height: 1.4; }
  h1 { font-size: 18pt; margin: 26px 0 4px; letter-spacing: -0.01em; }
  .subtitle { color: #5a6373; font-size: 10.5pt; margin: 0 0 22px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 22px; }
  .field { border-bottom: 1px solid #d8dde6; padding: 8px 0 4px; }
  .field .lbl { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #7a8497; margin-bottom: 2px; }
  .field .val { font-size: 11.5pt; color: #14181f; font-weight: 600; }
  .agreement-block { background: #f7f8fb; border: 1px solid #e3e7ee; border-radius: 6px; padding: 16px 18px; margin: 14px 0 22px; }
  .agreement-block p { margin: 0 0 8px; font-size: 10.5pt; line-height: 1.5; }
  .agreement-block p:last-child { margin-bottom: 0; }
  .sig-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 18px; }
  .sig-box { border: 1px solid #d8dde6; border-radius: 6px; padding: 14px; min-height: 140px; display: flex; flex-direction: column; }
  .sig-box .lbl { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #7a8497; }
  .sig-box .img-wrap { flex: 1; display: grid; place-items: center; padding: 8px 0; }
  .sig-box img { max-width: 100%; max-height: 110px; }
  .sig-box .meta { font-size: 9pt; color: #5a6373; border-top: 1px dashed #d8dde6; padding-top: 6px; margin-top: auto; }
  .ids { margin-top: 22px; font-size: 9pt; color: #5a6373; line-height: 1.55; word-break: break-all; }
  .ids .row { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 3px 0; border-bottom: 1px solid #eef0f5; }
  .ids .row:last-child { border-bottom: none; }
  .ids .row .k { color: #7a8497; }
  .ids .row .v { color: #14181f; font-family: 'Consolas', 'Menlo', monospace; }
  footer { margin-top: 28px; padding-top: 14px; border-top: 1px solid #d8dde6; font-size: 8.5pt; color: #7a8497; line-height: 1.5; }
  .watermark { position: fixed; bottom: 6px; right: 8px; font-size: 6pt; color: #cfd4dd; }
</style>
</head>
<body>
  <header>
    <div class="brand">Chief Engineer Pro <span class="accent">·</span> eORB Pro Portable</div>
    <div class="doc-meta">
      <div>License Agreement</div>
      <div>${escapeHtml(dateStr)}</div>
    </div>
  </header>

  <h1>End-User License &amp; Anti-Piracy Acknowledgement</h1>
  <p class="subtitle">This document records the activation of one Portable USB license, accepted and digitally signed by the licensee named below.</p>

  <div class="grid">
    <div class="field"><div class="lbl">Full Name</div><div class="val">${escapeHtml(id.fullName)}</div></div>
    <div class="field"><div class="lbl">Email</div><div class="val">${escapeHtml(id.email)}</div></div>
    <div class="field"><div class="lbl">Country</div><div class="val">${escapeHtml(id.country)}</div></div>
    <div class="field"><div class="lbl">Rank</div><div class="val">${escapeHtml(id.rank)}</div></div>
    <div class="field"><div class="lbl">Company</div><div class="val">${escapeHtml(id.company) || '<span style="color:#999">—</span>'}</div></div>
    <div class="field"><div class="lbl">Vessel</div><div class="val">${escapeHtml(id.vessel) || '<span style="color:#999">—</span>'}</div></div>
  </div>

  <div class="agreement-block">
    ${agreementHtml}
  </div>

  <div class="sig-row">
    <div class="sig-box">
      <div class="lbl">Licensee Signature</div>
      <div class="img-wrap">${sigImgTag}</div>
      <div class="meta">Signed ${escapeHtml(dateStr)}</div>
    </div>
    <div class="sig-box">
      <div class="lbl">Issued By</div>
      <div class="img-wrap" style="font-weight:700;font-size:13pt;color:#0a0d12;">Chief Engineer Pro</div>
      <div class="meta">chiefengineerpro.com · support@chiefengineerpro.com</div>
    </div>
  </div>

  <div class="ids">
    <div class="row"><div class="k">License ID</div><div class="v">${escapeHtml(licenseId)}</div></div>
    <div class="row"><div class="k">Activation ID</div><div class="v">${escapeHtml(activationId || '—')}</div></div>
    <div class="row"><div class="k">USB Hash</div><div class="v">${escapeHtml(String(usbHash || '').slice(0, 16))}…</div></div>
    <div class="row"><div class="k">Signature Hash</div><div class="v">${escapeHtml(hashSignature(signatureDataUrl).slice(0, 24))}…</div></div>
    <div class="row"><div class="k">Agreement Version</div><div class="v">${escapeHtml((agreement && agreement.version) || '1.0')}</div></div>
  </div>

  <footer>
    This agreement is generated and stored automatically on first activation. A copy is saved to the licensee's USB drive and uploaded to Chief Engineer Pro's secure records. The signature image, identity fields, and document hash are bound to license <strong>${escapeHtml(licenseId)}</strong>. Tampering with or redistributing this license is detectable through embedded watermarks and may result in revocation.
  </footer>
  <div class="watermark">${watermark}</div>
</body></html>`;
}

// Best-effort POST of the PDF to the Drive-upload workflow.
function uploadAgreementPdf({ licenseId, activationId, email, pdfBuffer }) {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        license_id: licenseId,
        activation_id: activationId,
        email: email,
        pdf_base64: pdfBuffer.toString('base64'),
        filename: `Agreement-${licenseId}-${email}.pdf`
      });
      const u = new URL(ORB_AGREEMENT_UPLOAD_URL);
      const req = https.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
          'User-Agent': 'eORB-Portable-Electron'
        },
        timeout: 30000
      }, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.write(payload);
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

// Main IPC entrypoint. Called from main.src.js when the renderer invokes
// window.eORB.agreement.submit(payload).
async function submitAgreement({ usbRoot, identity, agreement, signatureDataUrl, clientVersion }) {
  const ctx = resolveUsbContext(usbRoot);
  if (!ctx.ok) {
    return { ok: false, error: 'usb_unreadable', detail: ctx.error };
  }
  if (!signatureDataUrl || !signatureDataUrl.startsWith('data:image/')) {
    return { ok: false, error: 'invalid_signature' };
  }

  const signatureHash = hashSignature(signatureDataUrl);
  const acceptedAt = new Date().toISOString();
  const agreementMeta = { accepted: true, version: agreement && agreement.version || '1.0', acceptedAt };

  // 1) Online activation
  const server = await activation.activateOnline({
    identity,
    agreement: agreementMeta,
    signatureHash,
    usbHash: ctx.usbHash,
    clientVersion
  });
  if (!server.ok) {
    return { ok: false, error: server.error || 'activation_failed', detail: server.detail || server.body };
  }

  // 2) Render PDF
  let pdfBuffer;
  try {
    pdfBuffer = await renderAgreementPdf({
      identity,
      agreement: agreementMeta,
      signatureDataUrl,
      licenseId: server.license_id,
      activationId: server.activation_id,
      usbHash: ctx.usbHash,
      timestamp: acceptedAt
    });
  } catch (err) {
    return { ok: false, error: 'pdf_render_failed', detail: err.message };
  }

  // 3) Write license.dat and PDFs to USB
  try {
    if (!fs.existsSync(ctx.usbDataDir)) fs.mkdirSync(ctx.usbDataDir, { recursive: true });
    activation.writePortableLicense({
      usbDataDir: ctx.usbDataDir,
      usbHash: ctx.usbHash,
      identity,
      agreement: agreementMeta,
      signatureHash,
      server
    });
    // PDF copy 1: internal audit copy (alongside license.dat).
    fs.writeFileSync(path.join(ctx.usbDataDir, 'agreement.pdf'), pdfBuffer);
    // PDF copy 2: user-facing copy at USB root.
    try {
      fs.writeFileSync(path.join(ctx.usbRoot, 'License Agreement.pdf'), pdfBuffer);
    } catch (_) {
      // Read-only USB root is fine; the in-data copy is the canonical one.
    }
  } catch (err) {
    return { ok: false, error: 'write_failed', detail: err.message };
  }

  // 4) Fire-and-forget Drive upload. Failure here doesn't block activation;
  //    the n8n sheet row already captured the identity + signature hash.
  uploadAgreementPdf({
    licenseId: server.license_id,
    activationId: server.activation_id,
    email: String(identity.email).toLowerCase().trim(),
    pdfBuffer
  }).then((r) => {
    if (!r.ok) console.warn('[agreement] Drive upload failed (non-fatal):', r.error || r.status);
  }).catch(() => {});

  return {
    ok: true,
    license_id: server.license_id,
    activation_id: server.activation_id,
    usb_hash_short: ctx.usbHash.slice(0, 8)
  };
}

module.exports = { submitAgreement, resolveUsbContext };
