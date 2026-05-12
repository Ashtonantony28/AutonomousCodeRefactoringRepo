'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STATE_DIR = path.resolve(__dirname, '..', '..', 'state');
const SESSION_PATH = path.join(STATE_DIR, 'session.json');

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
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
  if (!fs.existsSync(SESSION_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
  } catch (err) {
    console.error(`[checkpoint] failed to parse session.json: ${err.message}`);
    return null;
  }
}

function saveSession(session) {
  ensureStateDir();
  session.updated_at = new Date().toISOString();
  const tmp = SESSION_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
  fs.renameSync(tmp, SESSION_PATH);
}

function loadOrInit(targetRepo, { resume = false } = {}) {
  const existing = loadSession();
  if (resume && existing) return existing;
  const session = freshSession(targetRepo);
  saveSession(session);
  return session;
}

module.exports = {
  STATE_DIR,
  SESSION_PATH,
  ensureStateDir,
  freshSession,
  loadSession,
  saveSession,
  loadOrInit
};
