#!/usr/bin/env node
// launch-dev.js
// Spawns Electron with ELECTRON_RUN_AS_NODE explicitly cleared so the binary
// runs as Electron (window + DOM) instead of plain Node.
// Some shells inherit ELECTRON_RUN_AS_NODE=1 from prior tooling — this
// guarantees a clean launch.

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env,
  cwd: path.resolve(__dirname, '..')
});

child.on('close', (code) => process.exit(code || 0));
