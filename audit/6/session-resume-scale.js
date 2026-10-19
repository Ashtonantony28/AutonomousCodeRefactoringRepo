#!/usr/bin/env node
'use strict';

// Per-target session and worktree bookkeeping at scale (SG13):
//  (a) saveSession / loadSession vs proposals in the per-target session
//  (b) sessionPath() without a target (standalone dashboard, every 250 ms
//      watcher tick) vs number of target dirs
//  (c) --resume reconciliation: worktree.committedIssues + reconcileWithBranch
//      vs commits on refactor/<run_id>; `git log` runs through execFileSync
//      with the default 1 MB maxBuffer
//  (d) createWorktree's dirty-file sync vs untracked files in the target
//      (`git status --porcelain -z -uall`, same 1 MB maxBuffer); checks that
//      a modified tracked source file still reaches the worktree
//
// usage: node audit/6/session-resume-scale.js [--parts a,b,c,d]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib');

const args = process.argv.slice(2);
const PARTS = (args.includes('--parts') ? args[args.indexOf('--parts') + 1] : 'a,b,c,d').split(',');

const root = L.isolateState('sessr');
const checkpoint = require(L.src('utils/checkpoint'));
const worktree = require(L.src('runner/worktree'));
const { reconcileWithBranch } = require(L.src('orchestrator'));
const T = require('../2/fixtures/session-template.json');

const ID = ['-c', 'user.name=audit', '-c', 'user.email=audit@localhost', '-c', 'commit.gpgsign=false'];
const git = (cwd, a, opts = {}) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...opts });

function partA() {
  console.log('(a) saveSession / loadSession, per-target session');
  console.log(L.row(['proposals', 'MB', 'save_ms', 'load_ms'], [10, 8, 9, 9]));
  for (const n of [100, 1000, 5000]) {
    const s = checkpoint.freshSession('/tmp/audit6-target');
    for (let k = 0; k < n; k++) {
      const p = JSON.parse(JSON.stringify(T.passed));
      p.issue_id = `${p.issue_id}-${k}`;
      s.proposals.push(p);
      s.test_results.push({ ...T.test_result, proposal_id: p.issue_id });
    }
    const save = L.time(() => checkpoint.saveSession(s)).ms;
    const mb = fs.statSync(checkpoint.sessionPath('/tmp/audit6-target')).size / 1e6;
    const load = L.time(() => checkpoint.loadSession('/tmp/audit6-target')).ms;
    console.log(L.row([n, mb.toFixed(1), L.fmt(save), L.fmt(load)], [10, 8, 9, 9]));
  }
}

function partB() {
  console.log('\n(b) sessionPath() with no target (scan of <state>/targets)');
  console.log(L.row(['targets', 'ms'], [10, 9]));
  let made = 0;
  for (const n of [10, 1000, 5000]) {
    for (; made < n; made++) {
      const d = checkpoint.stateDirFor(`/tmp/audit6-t${made}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'session.json'), '{}');
    }
    const xs = [];
    for (let i = 0; i < 5; i++) xs.push(L.time(() => checkpoint.sessionPath()).ms);
    console.log(L.row([n, L.fmt(L.summarize(xs).p50, 2)], [10, 9]));
  }
}

function mkTarget() {
  const dir = L.tmpDir('target');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","version":"1.0.0","scripts":{"test":"node -e 0"}}');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'function a() {\n  return 1;\n}\nmodule.exports = { a };\n');
  L.gitInit(dir);
  return dir;
}

function partC() {
  console.log('\n(c) --resume reconciliation vs commits on the run branch');
  console.log(L.row(['commits', 'reason_B', 'log_MB', 'committedIssues_ms', 'found', 'reconciled', 'expected'], [8, 9, 7, 19, 7, 11, 9]));
  for (const [n, reasonLen] of [[100, 2000], [400, 2000], [600, 2000], [3000, 200], [6000, 200]]) {
    const target = mkTarget();
    const info = worktree.createWorktree({ targetRepo: target, runId: `r${n}-${reasonLen}`, baseDir: path.join(root, 'wt') });
    // n commits made with the same message shape as commitProposal (fast path:
    // commit-tree on an unchanged tree; only the messages matter here).
    let head = info.base;
    const tree = git(info.path, ['rev-parse', 'HEAD^{tree}']).trim();
    const proposals = [];
    for (let k = 0; k < n; k++) {
      const p = { issue_id: `id${String(k).padStart(14, '0')}`, file: 'src/a.js', reasoning: 'r'.repeat(reasonLen), decision_trace: [], test_outcome: null, critic_verdict: { p_preserves: 0.9, panel: [] }, pattern_check_results: [], current_code: 'x', proposed_code: 'y', risk_estimate: 0.1 };
      proposals.push(p);
      const msg = `refactor: ${p.file} [${p.issue_id}]\n\n${p.reasoning.slice(0, 2000)}\n\nissue_id: ${p.issue_id}\nfile: ${p.file}\n`;
      head = git(info.path, [...ID, 'commit-tree', tree, '-p', head, '-m', msg]).trim();
    }
    git(info.path, ['update-ref', `refs/heads/${info.branch}`, head]);
    const logMb = git(info.path, ['log', '--format=%H%n%B%x00', `${info.base}..${info.branch}`]).length / 1e6;
    const t = L.time(() => worktree.committedIssues(info));
    const session = { run_id: 'x', target_repo: target, proposals, test_results: [], rl_samples: [] };
    const quiet = console.log; console.log = () => {};
    let rec;
    try { rec = reconcileWithBranch({ session, info, absRepo: target }); } finally { console.log = quiet; }
    console.log(L.row([n, reasonLen, logMb.toFixed(2), L.fmt(t.ms), t.r.size, rec, n], [8, 9, 7, 19, 7, 11, 9]));
    L.rm(target);
  }
}

function partD() {
  console.log('\n(d) createWorktree dirty-file sync vs untracked files in the target');
  console.log(L.row(['untracked', 'status_MB', 'createWorktree_ms', 'synced', 'modified src reached worktree'], [10, 10, 18, 8, 30]));
  for (const n of [1000, 10000, 25000]) {
    const target = mkTarget();
    // an un-ignored dependency/build dir, plus one modified tracked file
    for (let i = 0; i < n; i++) {
      const d = path.join(target, 'node_modules', `pkg${i % 400}`, 'lib');
      if (i < 400) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `file_with_a_typical_name_${i}.js`), 'module.exports = 1;\n');
    }
    fs.writeFileSync(path.join(target, 'src', 'a.js'), 'function a() {\n  return 2; // uncommitted edit the Analyzer saw\n}\nmodule.exports = { a };\n');
    const statusMb = git(target, ['status', '--porcelain', '-z', '-uall']).length / 1e6;
    const t = L.time(() => worktree.createWorktree({ targetRepo: target, runId: `d${n}`, baseDir: path.join(root, 'wt') }));
    const info = t.r;
    const got = fs.readFileSync(path.join(info.root, 'src', 'a.js'), 'utf8').includes('return 2');
    console.log(L.row([n, statusMb.toFixed(2), L.fmt(t.ms), (info.dirty_synced || []).length, got ? 'yes' : 'NO (worktree has HEAD version)'], [10, 10, 18, 8, 30]));
    L.rm(target);
  }
}

if (PARTS.includes('a')) partA();
if (PARTS.includes('b')) partB();
if (PARTS.includes('c')) partC();
if (PARTS.includes('d')) partD();
L.rm(root);
