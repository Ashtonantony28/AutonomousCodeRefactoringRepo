'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point every state/dashboard write at a temp dir before any src module loads.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-test-'));
process.env.REFACTOR_STATE_DIR = path.join(root, 'state');
process.env.REFACTOR_DASHBOARD_DIR = path.join(root, 'dashboard');

function copyFixture(name) {
  const src = path.join(__dirname, '..', 'fixtures', name);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `refactor-fx-${name}-`));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

process.on('exit', () => rm(root));

module.exports = { root, stateDir: process.env.REFACTOR_STATE_DIR, dashboardDir: process.env.REFACTOR_DASHBOARD_DIR, copyFixture, rm };
