#!/usr/bin/env node
'use strict';

// signature_drift repo scan after SG9 (src/validation/ast-checker.js
// findCallSites: word-boundary prefilter, 200-file parse cap, stop at the
// first call site, per-process parse cache) and its polyglot twin
// (src/validation/polyglot-ast.js findCallSites, which SG9 did not change).
//
//  (a) JS: the drifted name is common. Every file defines and calls its own
//      local `normalize` without importing the edited module, so no file is a
//      call site, nothing stops the scan, and the 200-file cap is reached.
//      cold = first runChecks in the process; warm = parse cache hit.
//  (b) Python: same repo shape in .py; every file imports and calls the
//      helper. The polyglot scan has no cap, no early stop and no cache:
//      every file whose text contains the name (substring) is stripped and
//      regex-scanned.
//  (c) runHybridValidator (stub critic) on (a) and (b), budget 2,500 ms.
//  (d) the cap as a false pass: the (a) repo plus one module that imports
//      the edited helper and calls it with the old arity, placed where the
//      scan reaches it after 200 other files mentioning the name.
//
// usage: node audit/6/drift-scan.js [--files 500] [--reps 3]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : Number(args[i + 1]); };
const FILES = opt('--files', 500);
const REPS = opt('--reps', 3);

L.isolateState('drift');

function genJs(dir, n) {
  fs.mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"d","version":"1.0.0"}');
  fs.writeFileSync(path.join(dir, 'src', 'core', 'normalize.js'),
    "'use strict';\nfunction normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}\nmodule.exports = { normalize };\n");
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const sub = path.join(dir, 'src', `d${i % 12}`, `e${i % 7}`);
    fs.mkdirSync(sub, { recursive: true });
    const target = i < 50 ? 197_000 : 1000 + ((i * 7919) % 40_000);
    let body = `'use strict';\nfunction normalize(x) { return String(x).trim(); }\nfunction use${i}(a) { return normalize(a); }\n`;
    let j = 0;
    while (body.length + 200 < target) body += L.fnText(i, j++);
    body += `module.exports = { use${i} };\n`;
    fs.writeFileSync(path.join(sub, `m${i}.js`), body);
    bytes += body.length;
  }
  return bytes;
}

function genPy(dir, n) {
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'core', 'util.py'), 'def normalize(a, b):\n    s = float(a) + float(b)\n    return s\n');
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const sub = path.join(dir, `p${i % 12}`, `q${i % 7}`);
    fs.mkdirSync(sub, { recursive: true });
    const target = i < 50 ? 197_000 : 1000 + ((i * 7919) % 40_000);
    let body = `from core.util import normalize\n\n\ndef use${i}(a, b):\n    return normalize(a, b) + ${i}\n\n\n`;
    let j = 0;
    while (body.length + 200 < target) { body += `def f${i}_${j}(a, b):\n    t${j} = a * ${j} + b\n    return t${j}\n\n\n`; j++; }
    fs.writeFileSync(path.join(sub, `m${i}.py`), body);
    bytes += body.length;
  }
  return bytes;
}

const jsProposal = () => ({
  issue_id: 'drift-js', file: 'src/core/normalize.js',
  current_code: 'function normalize(a, b) {\n  const s = Number(a) + Number(b);\n  return s;\n}',
  proposed_code: 'function normalize(a, b, c) {\n  return Number(a) + Number(b) + (c ? 0 : 0);\n}',
  reasoning: 'x', risk_estimate: 0.3, critic_verdict: null, pattern_check_results: [], diff_test: null, combined_confidence: null, test_outcome: null, decision_trace: []
});
const pyProposal = () => ({
  issue_id: 'drift-py', file: 'core/util.py',
  current_code: 'def normalize(a, b):\n    s = float(a) + float(b)\n    return s',
  proposed_code: 'def normalize(a, b, c=0):\n    return float(a) + float(b) + c',
  reasoning: 'x', risk_estimate: 0.3, critic_verdict: null, pattern_check_results: [], diff_test: null, combined_confidence: null, test_outcome: null, decision_trace: []
});

const stubCritic = async ({ proposal }) => {
  const v = (persona) => ({ persona, preserves_semantics: true, p_preserves: 0.8, edge_cases: [], hallucination_flags: [], reasoning: `${persona} ok` });
  return { proposal_id: proposal.issue_id, panel: [v('a'), v('b'), v('c')], p_preserves: 0.8, agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0.5 } };
};

async function main() {
  // Fresh process state matters for the cold number: load the checker here.
  const { runChecks } = require(L.src('validation/ast-checker'));
  const { runHybridValidator } = require(L.src('validation/hybrid-validator'));
  console.log(L.row(['case', 'repo_MB', 'cold_ms', 'warm_p50', 'warm_max', 'drift check', 'budget'], [34, 8, 9, 9, 9, 60, 6]));
  for (const [lang, gen, mk] of [['js', genJs, jsProposal], ['python', genPy, pyProposal]]) {
    const dir = L.tmpDir(`drift-${lang}`);
    const bytes = gen(dir, FILES);
    const cold = L.time(() => runChecks({ proposal: mk(), repoRoot: dir }));
    const warm = [];
    for (let i = 0; i < REPS; i++) warm.push(L.time(() => runChecks({ proposal: mk(), repoRoot: dir })).ms);
    const s = L.summarize(warm);
    const d = cold.r.checks.find(c => c.check_name === 'signature_drift');
    console.log(L.row([`(${lang === 'js' ? 'a' : 'b'}) ${lang} runChecks, ${FILES} files`, (bytes / 1e6).toFixed(1), L.fmt(cold.ms, 0), L.fmt(s.p50, 0), L.fmt(s.max, 0), `${d.passed ? 'pass' : 'FAIL'} ${d.detail.slice(-58)}`, 300], [34, 8, 9, 9, 9, 60, 6]));
    const v = [];
    for (let i = 0; i < REPS; i++) v.push((await L.timeAsync(() => runHybridValidator({ proposal: mk(), repoRoot: dir, runCritic: stubCritic }))).ms);
    const sv = L.summarize(v);
    console.log(L.row([`(c) ${lang} runHybridValidator`, '', '', L.fmt(sv.p50, 0), L.fmt(sv.max, 0), '', 2500], [34, 8, 9, 9, 9, 60, 6]));
    if (lang === 'js') {
      // (d) src/aa/ is popped last by collectRepoFiles' directory stack
      fs.mkdirSync(path.join(dir, 'src', 'aa'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'aa', 'caller.js'), "'use strict';\nconst { normalize } = require('../core/normalize');\nmodule.exports = (x) => normalize(x, 1);\n");
      const d = runChecks({ proposal: mk(), repoRoot: dir }).checks.find(c => c.check_name === 'signature_drift');
      console.log(L.row(['(d) js: real caller after the cap', '', '', '', '', `${d.passed ? 'pass (call site missed)' : 'FAIL (call site found)'}: ${d.detail.slice(-40)}`, ''], [34, 8, 9, 9, 9, 60, 6]));
      fs.rmSync(path.join(dir, 'src', 'aa'), { recursive: true });
    }
    L.rm(dir);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
