'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_STATE_DIR = path.resolve(__dirname, '..', '..', 'state');

function stateDir() {
  return process.env.REFACTOR_STATE_DIR ? path.resolve(process.env.REFACTOR_STATE_DIR) : DEFAULT_STATE_DIR;
}

function stateDirFor(targetRepo) {
  const key = crypto.createHash('sha256').update(path.resolve(targetRepo)).digest('hex');
  return path.join(stateDir(), 'targets', key);
}

// Older versions kept one global session; it moves to its target dir on first read.
function legacySessionPath() {
  return path.join(stateDir(), 'session.json');
}

// Per-target session. Without a target: the most recently written one (for
// the standalone dashboard), else the legacy global file.
function sessionPath(targetRepo = null) {
  if (targetRepo) return path.join(stateDirFor(targetRepo), 'session.json');
  const dir = path.join(stateDir(), 'targets');
  let best = null;
  let bestMtime = -Infinity;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* none yet */ }
  for (const name of names) {
    const p = path.join(dir, name, 'session.json');
    try {
      const m = fs.statSync(p).mtimeMs;
      if (m > bestMtime) { best = p; bestMtime = m; }
    } catch { /* */ }
  }
  return best || legacySessionPath();
}

// Pre-edit snapshot of the executor's in-flight file (restored on start-up
// after a crash, and by the signal handlers).
function inflightPath(targetRepo) {
  return path.join(stateDirFor(targetRepo), 'inflight.json');
}

function worktreesDir(targetRepo) {
  return path.join(stateDirFor(targetRepo), 'worktrees');
}

function ensureStateDir(dir = stateDir()) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function freshSession(targetRepo) {
  return {
    run_id: uuidv4(),
    target_repo: targetRepo,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    proposals: [],
    test_results: [],
    rl_samples: [],
    token_usage: { analyzer: 0, critic: 0, executor: 0 },
    context_saturation: { analyzer: 0.0, critic: 0.0, executor: 0.0 }
  };
}

function readSession(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[checkpoint] failed to parse ${p}: ${err.message}`);
    return null;
  }
}

// The legacy global session is moved into its target's dir (so it is read
// once) only when it belongs to `targetRepo`.
function migrateLegacy(targetRepo) {
  const legacy = legacySessionPath();
  const old = readSession(legacy);
  if (!old || !old.target_repo || path.resolve(old.target_repo) !== path.resolve(targetRepo)) return null;
  const dest = sessionPath(targetRepo);
  ensureStateDir(path.dirname(dest));
  fs.renameSync(legacy, dest);
  return old;
}

function loadSession(targetRepo = null) {
  ensureStateDir();
  if (!targetRepo) return readSession(sessionPath());
  return readSession(sessionPath(targetRepo)) || migrateLegacy(targetRepo);
}

function saveSession(session) {
  session.updated_at = new Date().toISOString();
  const p = session.target_repo ? sessionPath(session.target_repo) : legacySessionPath();
  ensureStateDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, p);
}

function loadOrInit(targetRepo, { resume = false } = {}) {
  const existing = loadSession(targetRepo);
  if (resume && existing) return existing;
  const session = freshSession(targetRepo);
  saveSession(session);
  return session;
}

module.exports = {
  DEFAULT_STATE_DIR,
  stateDir,
  stateDirFor,
  inflightPath,
  worktreesDir,
  sessionPath,
  legacySessionPath,
  ensureStateDir,
  freshSession,
  loadSession,
  saveSession,
  loadOrInit
};
Object.defineProperty(module.exports, 'STATE_DIR', { enumerable: true, get: stateDir });
Object.defineProperty(module.exports, 'SESSION_PATH', { enumerable: true, get: sessionPath });
