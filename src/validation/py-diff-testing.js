'use strict';

// Differential testing for Python edits: py_diff_harness.py runs the current
// and the proposed module in forked, resource-limited children of one
// isolated `python3 -I` process (temp cwd, empty env, network/process/ctypes
// refused by an audit hook, non-stdlib imports stubbed, killed at the hard
// kill) and compares every changed callable on shaped inputs. Same result
// shape as diff-testing.js (src/contracts.js DiffTest + legacy fields).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { changeHunks } = require('../utils/hunks');

const HARNESS = path.join(__dirname, 'py_diff_harness.py');
const PYTHON = 'python3';
const HARD_KILL_MS = 3000;
const BUDGET_MS = 1500;
const CALL_TIMEOUT_MS = 250;

// UTF-16 offsets -> code point offsets (Python string indices), in one pass
// over the sorted offsets.
function cpOffsets(s, offsets) {
  if (!/[\ud800-\udfff]/.test(s)) return offsets.map(i => Math.min(i, s.length));
  const out = new Array(offsets.length);
  let k = 0, n = 0;
  for (const i of offsets.map((_, j) => j).sort((x, y) => offsets[x] - offsets[y])) {
    for (const stop = Math.min(offsets[i], s.length); k < stop; k++) {
      const c = s.charCodeAt(k);
      if (c < 0xdc00 || c > 0xdfff) n++;
    }
    out[i] = n;
  }
  return out;
}

function finish(t0, fields) {
  const out = { ...fields, duration_ms: Number((performance.now() - t0).toFixed(3)) };
  out.applicable = out.verdict !== 'inconclusive';
  out.score = out.verdict === 'equivalent' ? 1 : out.verdict === 'divergent' ? 0 : 0.5;
  out.mismatches = out.verdict === 'divergent' ? 1 : 0;
  if (out.verdict === 'inconclusive' && !out.reason) out.reason = 'inconclusive';
  return out;
}

function run(opts) {
  const t0 = performance.now();
  const { currentSrc, proposedSrc, fileSrc, file } = opts;
  const hardKillMs = opts.hardKillMs || HARD_KILL_MS;
  if (typeof currentSrc !== 'string' || typeof proposedSrc !== 'string') {
    return finish(t0, { verdict: 'inconclusive', reason: 'currentSrc and proposedSrc must be strings', runs: 0, lang: 'python' });
  }
  const at = typeof fileSrc === 'string' && currentSrc ? fileSrc.indexOf(currentSrc) : -1;
  const mode = at >= 0 ? 'file' : 'snippet';
  const current = at >= 0 ? fileSrc : currentSrc;
  const proposed = at >= 0 ? fileSrc.slice(0, at) + proposedSrc + fileSrc.slice(at + currentSrc.length) : proposedSrc;
  const base = Math.max(at, 0);
  let deleted = [];
  try {
    const flat = changeHunks(currentSrc, proposedSrc, 'edit.py').flatMap(h => h.deleted).flat().map(i => i + base);
    const cp = cpOffsets(current, flat);
    for (let i = 0; i < cp.length; i += 2) deleted.push([cp[i], cp[i + 1]]);
  } catch { deleted = []; }
  if (performance.now() - t0 >= hardKillMs) {
    return finish(t0, { verdict: 'inconclusive', runs: 0, reason: `hard kill: input preparation did not finish within ${Math.round(hardKillMs)} ms`, mode, lang: 'python' });
  }
  const rel = typeof file === 'string' ? file.replace(/\\/g, '/') : 'module.py';
  const modname = rel.replace(/\.py$/i, '').split('/').filter(Boolean).join('.').replace(/[^\w.]/g, '_') || '__dt_mod__';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydt-'));
  let res;
  try {
    const payload = {
      current, proposed, snippet: mode === 'snippet', modname, basename: path.basename(rel), deleted, workdir: dir,
      budget_ms: opts.budgetMs || BUDGET_MS, call_timeout_ms: opts.callTimeoutMs || CALL_TIMEOUT_MS
    };
    const r = spawnSync(opts.python || PYTHON, ['-I', '-B', HARNESS], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: Math.max(1, Math.round(hardKillMs - (performance.now() - t0))),
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: dir, TMPDIR: dir }
    });
    if (r.error && r.error.code === 'ENOENT') res = { verdict: 'inconclusive', runs: 0, reason: 'python3 is not available' };
    else if (r.error || r.signal) res = { verdict: 'inconclusive', runs: 0, reason: `hard kill: python sandbox did not finish within ${Math.round(hardKillMs)} ms` };
    else {
      const line = String(r.stdout || '').trim().split('\n').pop();
      try { res = JSON.parse(line); } catch { res = { verdict: 'inconclusive', runs: 0, reason: `python sandbox error: ${String(r.stderr || '').trim().split('\n').pop() || 'no result'}` }; }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  if (deleted.length) res.deletions_observed = res.verdict === 'equivalent' && res.deletions_observed === true;
  else delete res.deletions_observed;
  return finish(t0, { function_name: '', arity: 0, ...res, mode, lang: 'python' });
}

module.exports = { run, HARD_KILL_MS };
