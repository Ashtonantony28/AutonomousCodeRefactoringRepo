'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_STATE_DIR = path.resolve(__dirname, '..', '..', 'state');

function stateDir() {
  return process.env.REFACTOR_STATE_DIR ? path.resolve(process.env.REFACTOR_STATE_DIR) : DEFAULT_STATE_DIR;
}

function sessionPath() {
  return path.join(stateDir(), 'session.json');
}

function stateDirFor(targetRepo) {
  const key = crypto.createHash('sha256').update(path.resolve(targetRepo)).digest('hex');
  return path.join(stateDir(), 'targets', key);
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

function loadSession() {
  ensureStateDir();
  const p = sessionPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[checkpoint] failed to parse session.json: ${err.message}`);
    return null;
  }
}

function saveSession(session) {
  ensureStateDir();
  session.updated_at = new Date().toISOString();
  const p = sessionPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, p);
}

function loadOrInit(targetRepo, { resume = false } = {}) {
  const existing = loadSession();
  if (resume && existing) return existing;
  const session = freshSession(targetRepo);
  saveSession(session);
  return session;
}

module.exports = {
  DEFAULT_STATE_DIR,
  stateDir,
  stateDirFor,
  sessionPath,
  ensureStateDir,
  freshSession,
  loadSession,
  saveSession,
  loadOrInit
};
Object.defineProperty(module.exports, 'STATE_DIR', { enumerable: true, get: stateDir });
Object.defineProperty(module.exports, 'SESSION_PATH', { enumerable: true, get: sessionPath });
