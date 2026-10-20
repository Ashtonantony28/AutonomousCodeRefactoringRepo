'use strict';

// Shared harness for AUDIT-5 repros. Builds on audit/1/lib.js (temp repo,
// stub critic, real processProposal; temp REFACTOR_STATE_DIR via
// test/helpers/env.js). Never touches state/, dashboard/ or the live API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const base = require('../1/lib');

const v = (preserves, p, reasoning) => ({ preserves_semantics: preserves, p_preserves: p, edge_cases: [], hallucination_flags: [], reasoning });

// Most favourable critic: every persona approves.
const UNANIMOUS = base.APPROVE;
// A split jury (2 of 3 approve, mean p 0.6): enough for an `equivalent` edit.
// (Distinct reasoning per persona: identical strings can make verbal_entropy
// -2e-16 and trip the JuryVerdict contract; AUDIT-2 L6, still open.)
const MAJORITY = ({ cacheTag }) => (/strict/.test(cacheTag)
  ? v(false, 0.2, 'may change behaviour for some inputs')
  : v(true, 0.8, `${cacheTag}: behaviour preserved`));

// Witness: load both versions of the module in a real node process and
// evaluate `expr` (an expression over `m`, may be a promise). Returns
// { cur, prop } as JSON strings; a throw becomes "throw:<Name>:<message>".
function witness({ files, file, cur, prop, expr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit5-w-'));
  try {
    const out = {};
    for (const [side, code] of [['cur', cur], ['prop', prop]]) {
      const root = path.join(dir, side);
      for (const [rel, src] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), rel === file ? src.replace(cur, () => code) : src);
      }
      const script = `const m = require(${JSON.stringify(path.join(root, file))});
Promise.resolve().then(() => (${expr})).then(
  (v) => process.stdout.write(JSON.stringify(v === undefined ? '<undefined>' : v)),
  (e) => process.stdout.write(JSON.stringify('throw:' + (e && e.name) + ':' + (e && e.message))));`;
      try {
        out[side] = execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        out[side] = `harness-error:${(e.stderr || e.message).split('\n')[0]}`;
      }
    }
    return out;
  } finally {
    base.rm(dir);
  }
}

function pyWitness({ files, file, cur, prop, expr }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit5-pw-'));
  try {
    const out = {};
    const mod = file.replace(/\.py$/, '').split('/').join('.');
    for (const [side, code] of [['cur', cur], ['prop', prop]]) {
      const root = path.join(dir, side);
      for (const [rel, src] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), rel === file ? src.replace(cur, () => code) : src);
      }
      const script = `import json, importlib\nm = importlib.import_module(${JSON.stringify(mod)})\ntry:\n    r = repr(${expr})\nexcept Exception as e:\n    r = 'throw:' + type(e).__name__\nprint(r, end='')`;
      try {
        out[side] = execFileSync('python3', ['-c', script], { cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        out[side] = `harness-error:${String(e.stderr || e.message).split('\n').slice(-2).join(' ')}`;
      }
    }
    return out;
  } finally {
    base.rm(dir);
  }
}

// Find the pytest that has coverage.py next to it (the runner looks it up the
// same way, through pytest's shebang). -> directory to prepend to PATH, or null.
function pytestWithCoverageDir() {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    let head;
    try { head = fs.readFileSync(path.join(dir, 'pytest'), 'utf8').slice(0, 256); } catch { continue; }
    const m = head.match(/^#!\s*(\S+)/);
    if (!m) continue;
    try { execFileSync(m[1], ['-m', 'coverage', '--version'], { stdio: 'ignore' }); return dir; } catch { return null; }
  }
  return null;
}

// Non-dry e2e: worktree, tests, commit. -> { proposal, wt, committedFile }
async function e2e({ files, pkg, file, cur, prop, critic = UNANIMOUS }) {
  const repo = base.makeRepo(files, { pkg, git: true });
  let wt;
  try {
    const { proposal, work } = await base.throughGate({ repo, file, current: cur, proposed: prop, critic, dryRun: false });
    wt = work && work.info;
    const commit = proposal.test_outcome && proposal.test_outcome.commit;
    let committedFile = null;
    let committedDiff = null;
    if (commit) {
      committedFile = base.gitIn(wt.path, 'show', `${commit}:${file}`);
      committedDiff = base.gitIn(wt.path, 'show', '--format=', commit, '--', file);
    }
    return { proposal, repo, wt, commit, committedFile, committedDiff };
  } finally {
    if (wt && wt.path) { try { base.gitIn(repo, 'worktree', 'remove', '--force', wt.path); } catch { /* */ } }
    base.rm(repo);
  }
}

function line(p) {
  const s = base.summary(p);
  return `status=${s.status} combined=${s.combined} dt=${s.diff_test} failed_checks=[${s.failed_checks}]` +
    (p.test_outcome && p.test_outcome.reason ? ` reason=${p.test_outcome.reason}` : '');
}

module.exports = { ...base, UNANIMOUS, MAJORITY, witness, pyWitness, e2e, line, pytestWithCoverageDir };
