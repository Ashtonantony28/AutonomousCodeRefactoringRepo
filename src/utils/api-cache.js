'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'state', 'cache');

let mode = 'off'; // 'off' | 'read-write' | 'replay'

function setMode(m) {
  if (!['off', 'read-write', 'replay'].includes(m)) throw new Error(`unknown cache mode: ${m}`);
  mode = m;
  if (mode !== 'off') ensureDir();
}

function getMode() { return mode; }

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function hashOf(payload) {
  // Stable hash over the canonicalized payload.
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function pathOf(key) {
  return path.join(CACHE_DIR, key + '.json');
}

function read(key) {
  const p = pathOf(key);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function write(key, entry) {
  ensureDir();
  fs.writeFileSync(pathOf(key), JSON.stringify(entry, null, 2));
}

async function wrap(payload, liveFn) {
  if (mode === 'off') return liveFn();
  const key = hashOf(payload);
  const hit = read(key);
  if (hit) return { ...hit.response, _cache_hit: true, _cache_key: key };
  if (mode === 'replay') {
    const err = new Error(`cache miss in replay mode (key=${key})`);
    err.code = 'CACHE_MISS';
    throw err;
  }
  const response = await liveFn();
  const stored = { request: payload, response, stored_at: new Date().toISOString() };
  // Strip non-serializable fields before persistence.
  try { write(key, stored); } catch (err) { /* persistence is best-effort */ }
  return { ...response, _cache_hit: false, _cache_key: key };
}

function stats() {
  if (!fs.existsSync(CACHE_DIR)) return { entries: 0, bytes: 0 };
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  let bytes = 0;
  for (const f of files) bytes += fs.statSync(path.join(CACHE_DIR, f)).size;
  return { entries: files.length, bytes };
}

module.exports = { setMode, getMode, hashOf, wrap, stats, CACHE_DIR };
