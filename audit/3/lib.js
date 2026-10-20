'use strict';

// Shared harness for AUDIT-3 repros. Temp state/dashboard dirs (via the
// repo's env helper), stub Claude client, never touches state/ or the API.
const env = require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInit(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}

function makeRepo(files, { pkg = null, gitRepo = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit3-repo-'));
  if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  if (gitRepo) gitInit(dir);
  return dir;
}

// The fixture's own `node --test` must not inherit a parent test context.
async function noTestCtx(fn) {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await fn(); } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
}

// Silence the orchestrator's console chatter while fn runs.
async function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

let failures = 0;
function report(id, ok, observed, expected) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok      ' : 'FINDING '} ${id}\n         observed: ${observed}\n         expected: ${expected}`);
}
function exitCode() { return failures ? 1 : 0; }

module.exports = { env, git, gitInit, makeRepo, noTestCtx, quiet, report, exitCode };
