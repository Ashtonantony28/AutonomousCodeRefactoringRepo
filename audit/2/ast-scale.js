#!/usr/bin/env node
'use strict';

// AST stage (runChecks, budget p95 300 ms) under load:
//  (a) a behaviour-preserving edit in files of growing size (no drift), and
//  (b) a signature change of a helper referenced from K other files: the
//      signature_drift check parses every repo file whose text contains the
//      name (src/validation/ast-checker.js findCallSites, up to 500 files).
//  (c) the same drift proposal through the full runHybridValidator.
//
// usage: node audit/2/ast-scale.js [--reps 5]

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const REPS = Number((args[args.indexOf('--reps') + 1]) || 5) || 5;

L.isolateState('ast');
const { runChecks } = require(L.src('validation/ast-checker'));
const { runHybridValidator } = require(L.src('validation/hybrid-validator'));

const stubCritic = async ({ proposal }) => {
  const v = { persona: 'strict', preserves_semantics: true, p_preserves: 0.8, edge_cases: [], hallucination_flags: [], reasoning: 'stub' };
  return { proposal_id: proposal.issue_id, panel: [v], p_preserves: 0.8, claude_confidence: 0.8, preserves_semantics: true, agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0 } };
};

function median(fn) {
  const xs = [];
  for (let i = 0; i < REPS; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
  return L.summarize(xs);
}

async function main() {
  // (a) file size sweep, edit in the middle of a single file
  console.log('(a) runChecks, inline-temporary edit, no signature change');
  console.log('file_KB   p50_ms   p95_ms   budget');
  const dir = L.tmpDir('ast-size');
  for (const kb of [10, 50, 100, 150, 199]) {
    let body = "'use strict';\n";
    let j = 0;
    while (body.length + 200 < kb * 1000) body += L.fnText(0, j++);
    fs.writeFileSync(path.join(dir, `f${kb}.js`), body);
    const p = L.inlineProposal({ i: 0, rel: `f${kb}.js` }, Math.floor(j / 2));
    const s = median(() => runChecks({ proposal: p, repoRoot: dir }));
    console.log(`${String(kb).padStart(7)} ${L.fmt(s.p50).padStart(8)} ${L.fmt(s.p95).padStart(8)}      300`);
  }

  // (b) drift with K referencing files (generated repo; first K files kept)
  console.log('\n(b) runChecks, signature change of normalize() referenced from K files (50 of them ~197 KB)');
  console.log('    K  repo_MB   p50_ms   p95_ms   budget');
  for (const K of [0, 10, 50, 100, 250, 500]) {
    const { dir: repo, meta } = L.genRepo({ files: Math.max(K, 1), bigFiles: Math.min(50, K) });
    if (K === 0) fs.rmSync(path.join(repo, meta[0].rel));
    const mb = K ? meta.reduce((a, m) => a + m.bytes, 0) / 1e6 : 0;
    const s = median(() => runChecks({ proposal: L.driftProposal(), repoRoot: repo }));
    console.log(`${String(K).padStart(5)} ${mb.toFixed(1).padStart(8)} ${L.fmt(s.p50).padStart(8)} ${L.fmt(s.p95).padStart(8)}      300`);
    if (K === 500) {
      const xs = [];
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        await runHybridValidator({ proposal: L.driftProposal(), repoRoot: repo, runCritic: stubCritic });
        xs.push(performance.now() - t);
      }
      const v = L.summarize(xs);
      console.log(`\n(c) runHybridValidator (stub critic) on the K=500 drift proposal: p50 ${L.fmt(v.p50)} ms, max ${L.fmt(v.max)} ms (budget 2500)`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
