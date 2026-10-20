#!/usr/bin/env node
'use strict';

// End-to-end load on a 500-module Python repo (pytest + coverage.py), the
// Python twin of audit/9/pipeline-load.js. Wraps audit/2/pipeline-load.js
// (stub client, seeded proposals, resume: true, per-stage table) and swaps
// its generator for a Python one:
//   - pkg/core/normalize.py: normalize(a, b), imported by every module;
//   - 500 modules under pkg/ (depth up to 3, 50 of ~197 KB, the rest 1-41 KB),
//     each `def f<i>_<j>(a, b): t<j> = a * <j> + b; return t<j>` plus
//     useNormalize<i>(a, b);
//   - tests/test_all.py imports every module and asserts every function's
//     result (f<i>_<j>(1, 2) == j + 2, useNormalize<i>(1, 2) == 3 + i), so
//     mutants of an edit are killed;
//   - proposals: "inline the temporary" in f<i>_<j> (behaviour-preserving),
//     half on the 197 KB modules; --drift adds a signature change of normalize.
// Also reports main vs mutant runTests and the executor's mutation evidence.
//
// usage: node audit/14/pipeline-load-py.js [--files 500] [--proposals 20] [--drift] [--serve]

require('./lib'); // temp REFACTOR_STATE_DIR before any src module loads
const fs = require('fs');
const path = require('path');
const L2 = require('../2/lib');

function genPyRepo({ dir = L2.tmpDir('pyrepo'), files = 500, maxBytes = 197_000, bigFiles = 50, depth = 3 } = {}) {
  let seed = 7;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const w = (rel, s) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  w('pytest.ini', '[pytest]\ntestpaths = tests\n');
  w('pkg/__init__.py', '');
  w('pkg/core/__init__.py', '');
  w('pkg/core/normalize.py', 'def normalize(a, b):\n    s = int(a) + int(b)\n    return s\n');
  w('tests/test_all.py', [
    'import importlib',
    'import os',
    'import re',
    '',
    'ROOT = os.path.join(os.path.dirname(__file__), "..")',
    '',
    '',
    'def modules():',
    '    for d, _, fs in os.walk(os.path.join(ROOT, "pkg")):',
    '        for f in sorted(fs):',
    '            if f.startswith("mod_") and f.endswith(".py"):',
    '                rel = os.path.relpath(os.path.join(d, f[:-3]), ROOT)',
    '                yield rel.replace(os.sep, ".")',
    '',
    '',
    'def test_all():',
    '    n = 0',
    '    for name in modules():',
    '        m = importlib.import_module(name)',
    '        for k in dir(m):',
    '            mm = re.match(r"^f\\d+_(\\d+)$", k)',
    '            if mm:',
    '                assert getattr(m, k)(1, 2) == int(mm.group(1)) + 2, (name, k)',
    '                n += 1',
    '            mm = re.match(r"^useNormalize(\\d+)$", k)',
    '            if mm:',
    '                assert getattr(m, k)(1, 2) == 3 + int(mm.group(1)), (name, k)',
    '                n += 1',
    '    assert n > 0',
    ''
  ].join('\n'));
  const meta = [];
  const dirs = new Set();
  for (let i = 0; i < files; i++) {
    const d = 1 + (i % depth);
    const segs = [];
    for (let k = 0; k < d; k++) segs.push(`d${k}_${(i + k) % 5}`);
    for (let k = 1; k <= segs.length; k++) dirs.add(path.join('pkg', ...segs.slice(0, k)));
    const rel = path.join('pkg', ...segs, `mod_${i}.py`);
    const target = i < bigFiles ? maxBytes : Math.floor(1000 + r() * 40_000);
    let body = `from pkg.core.normalize import normalize\n\n\ndef useNormalize${i}(a, b):\n    return normalize(a, b) + ${i}\n\n\n`;
    let j = 0;
    while (body.length + 120 < target) { body += `def f${i}_${j}(a, b):\n    t${j} = a * ${j} + b\n    return t${j}\n\n\n`; j++; }
    w(rel, body);
    meta.push({ rel: rel.split(path.sep).join('/'), i, fns: j, bytes: body.length });
  }
  for (const d of dirs) w(path.join(d, '__init__.py'), '');
  return { dir, meta };
}

function inlineProposalPy(m, j) {
  return {
    issue_id: `audit-py-${m.i}-${j}`,
    file: m.rel,
    current_code: `def f${m.i}_${j}(a, b):\n    t${j} = a * ${j} + b\n    return t${j}`,
    proposed_code: `def f${m.i}_${j}(a, b):\n    return a * ${j} + b`,
    reasoning: 'inline temporary',
    risk_estimate: 0.1,
    critic_verdict: null, pattern_check_results: [], diff_test: null,
    combined_confidence: null, test_outcome: null, decision_trace: []
  };
}

L2.genRepo = (opts = {}) => genPyRepo({ files: opts.files || 500 });
const origMake = L2.makeProposals;
L2.makeProposals = function (meta, n) {
  return origMake(meta, n).map(p => {
    const mm = /^audit-(\d+)-(\d+)$/.exec(p.issue_id);
    const m = meta.find(x => x.i === Number(mm[1]));
    return inlineProposalPy(m, Number(mm[2]));
  });
};
L2.driftProposal = () => ({
  issue_id: 'audit-py-drift-normalize',
  file: 'pkg/core/normalize.py',
  current_code: 'def normalize(a, b):\n    s = int(a) + int(b)\n    return s',
  proposed_code: 'def normalize(a, b, *rest):\n    return int(a) + int(b)',
  reasoning: 'inline temporary; accept extra arguments',
  risk_estimate: 0.3,
  critic_verdict: null, pattern_check_results: [], diff_test: null,
  combined_confidence: null, test_outcome: null, decision_trace: []
});

// Main vs mutant runTests, patched before the executor binds runTests.
const runner = require(path.join(L2.REPO_ROOT, 'src', 'runner', 'test-runner'));
const RT = { main: [], mutant: [], post: [] };
const origRun = runner.runTests;
runner.runTests = async function (o) {
  const t = performance.now();
  const r = await origRun(o);
  const ms = performance.now() - t;
  (o.edit ? RT.main : RT.mutant).push(ms);
  if (o.edit) RT.post.push(ms - (r.execution_time_ms || 0));
  return r;
};
const executor = require(path.join(L2.REPO_ROOT, 'src', 'agents', 'executor'));
const MUT = { calls: 0, runs: 0, killed: 0, exhausted: 0, outcomes: {}, wall: [] };
const origExec = executor.runExecutor;
executor.runExecutor = async function (o) {
  const t = performance.now();
  const r = await origExec(o);
  MUT.wall.push(performance.now() - t);
  MUT.calls++;
  const m = r.mutation || {};
  MUT.runs += m.run || 0;
  if (m.killed) MUT.killed++;
  if (m.budget_exhausted) MUT.exhausted++;
  const k = `${r.status}${r.reason ? ':' + r.reason : ''}`;
  MUT.outcomes[k] = (MUT.outcomes[k] || 0) + 1;
  return r;
};
// Diff-test verdicts per proposal (the gate's input), by module size.
const hybrid = require(path.join(L2.REPO_ROOT, 'src', 'validation', 'hybrid-validator'));
const DT = { big: {}, small: {}, reasons: {} };
const origHybrid = hybrid.runHybridValidator;
hybrid.runHybridValidator = async function (o) {
  const r = await origHybrid.call(this, o);
  const p = o.proposal;
  let size = 0;
  try { size = fs.statSync(path.join(o.repoRoot, p.file)).size; } catch { /* */ }
  const b = size > 150_000 ? DT.big : DT.small;
  const v = p.diff_test ? p.diff_test.verdict : 'none';
  b[v] = (b[v] || 0) + 1;
  if (v !== 'equivalent' && p.diff_test) { const k = String(p.diff_test.reason || '').replace(/f\d+_\d+/g, 'f').slice(0, 90); DT.reasons[k] = (DT.reasons[k] || 0) + 1; }
  return r;
};
process.on('exit', () => {
  const a = L2.summarize(RT.main), b = L2.summarize(RT.mutant), c = L2.summarize(RT.post), w = L2.summarize(MUT.wall);
  console.log(`runTests main (coverage.py): n=${a.n} p50 ${L2.fmt(a.p50)} p95 ${L2.fmt(a.p95)} max ${L2.fmt(a.max)} ms; post-exit coverage p50 ${L2.fmt(c.p50)} p95 ${L2.fmt(c.p95)} max ${L2.fmt(c.max)} ms`);
  console.log(`runTests mutant runs:        n=${b.n} p50 ${L2.fmt(b.p50)} p95 ${L2.fmt(b.p95)} max ${L2.fmt(b.max)} ms`);
  console.log(`runExecutor wall:            n=${w.n} p50 ${L2.fmt(w.p50)} p95 ${L2.fmt(w.p95)} max ${L2.fmt(w.max)} ms`);
  console.log(`executor: ${MUT.calls} calls, mutant runs ${MUT.runs}, killed ${MUT.killed}, budget_exhausted ${MUT.exhausted}; outcomes ${JSON.stringify(MUT.outcomes)}`);
  console.log(`diff-test verdicts: modules > 150 KB ${JSON.stringify(DT.big)}, smaller ${JSON.stringify(DT.small)}`);
  for (const [k, n] of Object.entries(DT.reasons)) console.log(`  ${n} x ${k}`);
});

if (!process.argv.includes('--proposals')) process.argv.push('--proposals', '20');
require('../2/pipeline-load.js');
