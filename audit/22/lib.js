'use strict';

// Shared helpers for the AUDIT-22 scripts: audit/17/lib.js (which loads
// test/helpers/env.js first, so REFACTOR_STATE_DIR / REFACTOR_DASHBOARD_DIR
// point at a temp dir before any src module loads) plus timing helpers.
// Fixtures are generated under os.tmpdir() at runtime; no live API call.

const L17 = require('../17/lib');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const list = (k, d) => String(opt(k, d)).split(',').filter(Boolean);
const nums = (k, d) => list(k, d).map(Number);

// Time `fn` reps times -> { r (last result), ms: stats }.
function timeIt(fn, reps = 3) {
  const ms = [];
  let r;
  for (let k = 0; k < reps; k++) { const t0 = performance.now(); r = fn(); ms.push(performance.now() - t0); }
  return { r, ms: L17.stats(ms) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// pids whose cwd is under one of `dirs` (pid + command line).
function procsUnder(dirs) {
  const out = [];
  for (const pid of L17.fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    let cwd;
    try { cwd = L17.fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (dirs.some(d => cwd === d || cwd.startsWith(d + '/'))) {
      let cmd = '';
      try { cmd = L17.fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* */ }
      out.push(`${pid} ${cmd.slice(0, 70)}`);
    }
  }
  return out;
}

// With TMPDIR pointed at a fresh private dir for the duration of `fn`.
async function withTmp(fn) {
  const tmp = L17.fs.mkdtempSync(L17.path.join(L17.os.tmpdir(), 'a22-tmp-'));
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try { return await fn(tmp); } finally { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; }
}

// pytest + coverage.py on PATH (audit/5 helper), for Python probes.
function pyPath() {
  const d = L17.pytestWithCoverageDir();
  if (d && !process.env.PATH.startsWith(d)) process.env.PATH = `${d}:${process.env.PATH}`;
  return !!d;
}

module.exports = { ...L17, opt, list, nums, timeIt, sleep, procsUnder, withTmp, pyPath };
