// scripts/after-pack.js
// electron-builder afterPack hook. Runs once per platform unpacked output,
// BEFORE the installer is built. We use it to disable the RunAsNode fuse
// (and a couple of related debug fuses) so the packaged binary refuses to
// behave as a plain Node interpreter -- which both leaks our code as a tool
// and causes silent exits when ELECTRON_RUN_AS_NODE=1 is set in the user
// environment.
//
// See feedback_electron-build-windows.md in user memory.

module.exports = async function afterPack(context) {
  const path = require('path');
  const fs = require('fs');
  const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

  const appOutDir = context.appOutDir;
  const productName = context.packager.appInfo.productFilename;

  let target;
  if (context.electronPlatformName === 'win32') {
    target = path.join(appOutDir, productName + '.exe');
  } else if (context.electronPlatformName === 'darwin') {
    target = path.join(appOutDir, productName + '.app');
  } else if (context.electronPlatformName === 'linux') {
    target = path.join(appOutDir, productName);
  } else {
    console.warn('[afterPack] unknown platform, skipping fuse flip: ' + context.electronPlatformName);
    return;
  }

  if (!fs.existsSync(target)) {
    console.warn('[afterPack] target not found, skipping fuse flip: ' + target);
    return;
  }

  console.log('[afterPack] flipping fuses on ' + target);
  await flipFuses(target, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  });
  console.log('[afterPack] fuses flipped (RunAsNode + NODE_OPTIONS + inspect = disabled)');
};
