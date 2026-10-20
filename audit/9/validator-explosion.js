#!/usr/bin/env node
'use strict';

// End-to-end view of audit/9/diff-explosion.js: runHybridValidator (stub
// critic, unanimous approve) on the behaviour-preserving matrix edit, with a
// 10 ms main-thread ticker. Reports the outcome the orchestrator would act on.
//
// usage: node audit/9/validator-explosion.js [--lit 1999] [--params 1]

const L = require('./lib');
const { runHybridValidator, unconfirmedBlock } = require(L.src('validation/hybrid-validator'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LIT = Number(opt('--lit', 1999));
const PARAMS = Number(opt('--params', 1));

const ps = Array.from({ length: PARAMS }, (_, i) => `m${i}`);
const body = (op) => `function sum(${ps.join(', ')}) {\n  let s = 0;\n${ps.map(p => `  for (const row of ${p}) for (let i = 0; i < row.length; i++) s ${op} row[i];\n`).join('')}  if (s > ${LIT}) return ${LIT};\n  return s;\n}`;
const dir = L.tmpDir('vexp');
L.write(dir, 'package.json', '{"name":"v","version":"1.0.0"}');
L.write(dir, 'src/sum.js', `${body('+=')}\nmodule.exports = { sum };\n`);
const proposal = {
  issue_id: 'vexp', file: 'src/sum.js', current_code: body('+='), proposed_code: body('= s +'),
  reasoning: 'expand compound assignment', risk_estimate: 0.1, critic_verdict: null, pattern_check_results: [],
  diff_test: null, combined_confidence: null, test_outcome: null, decision_trace: []
};
const stubCritic = async ({ proposal: p }) => {
  const v = (persona) => ({ persona, preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: `${persona} ok` });
  return { proposal_id: p.issue_id, panel: [v('a'), v('b'), v('c')], p_preserves: 0.9, agreement: { std: 0, unanimous: true, approval_rate: 1, verbal_entropy: 0.5 } };
};

(async () => {
  let last = performance.now(), stall = 0;
  const tick = setInterval(() => { const n = performance.now(); stall = Math.max(stall, n - last - 10); last = n; }, 10);
  const t0 = performance.now();
  const r = await runHybridValidator({ proposal, repoRoot: dir, runCritic: stubCritic });
  const ms = performance.now() - t0;
  await new Promise(res => setTimeout(res, 30));
  clearInterval(tick);
  const dt = r.diff_test || proposal.diff_test || {};
  const out = { lit: LIT, params: PARAMS, validator_ms: Math.round(ms), max_stall_ms: Math.round(stall), diff_verdict: dt.verdict, diff_runs: dt.runs,
    combined: r.combined, gate_block: String(unconfirmedBlock({ jury: r.verdict, checks: (r.ast && r.ast.checks) || [], dt, file: proposal.file }) || 'none (proceeds)').slice(0, 120), peakMB: Math.round(L.hwmMb()) };
  console.log(JSON.stringify(out));
  L.rm(dir);
})();
