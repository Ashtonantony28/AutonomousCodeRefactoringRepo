'use strict';

// AUDIT-18 contract sweep at the stage boundaries of real pipeline runs
// (stub client, temp REFACTOR_STATE_DIR via audit/10/lib.js):
//   js   js-basic, ADD (inline, passes) + a rename of a local (use-site sites)
//   py   py-basic, total -> sum(values) (pytest, JUnit per-test results), when pytest is installed
// Every persisted record is checked against src/contracts.js
// (assertProposal / assertJuryVerdict / assertCheckResult / assertDiffTest /
// assertSample / assertTestOutcome), the session keys against CLAUDE.md's
// schema, every `reverted` reason against CLAUDE.md's five untested reasons,
// and the learned-gate files against the per-target store.
//   node audit/18/contract-sweep.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { env, gitInit, runWith, proposals, report, exitCode } = require('../10/lib');
const C = require('../../src/contracts');
const { stateDirFor } = require('../../src/utils/checkpoint');
const { loadSamples, UNTESTED_REASONS } = require('../../src/rl/collector');

const SESSION_KEYS = ['run_id', 'target_repo', 'started_at', 'updated_at', 'proposals', 'test_results', 'rl_samples', 'token_usage', 'context_saturation'];
const ADD = { file: 'src/math.js', current_code: 'function add(a, b) {\n  const result = a + b;\n  return result;\n}', proposed_code: 'function add(a, b) {\n  return a + b;\n}' };
const RENAME = { file: 'src/math.js', current_code: "  } catch (e) {\n    return null;\n  }", proposed_code: "  } catch (err) {\n    return null;\n  }" };
const PY = { file: 'calc/ops.py', current_code: 'def total(values):\n    result = 0\n    for v in values:\n        result = result + v\n    return result', proposed_code: 'def total(values):\n    return sum(values)' };

const errs = [];
const tryA = (where, fn, v) => { try { fn(v); } catch (e) { errs.push(`${where}: ${e.message}`); } };

function sweep(tag, s, repo) {
  const missing = SESSION_KEYS.filter(k => !(k in s));
  if (missing.length) errs.push(`${tag} session: missing ${missing}`);
  for (const p of s.proposals) {
    const id = `${tag} ${p.issue_id.slice(0, 8)}`;
    tryA(`${id} Proposal`, C.assertProposal, p);
    if (p.critic_verdict) tryA(`${id} JuryVerdict`, C.assertJuryVerdict, p.critic_verdict);
    for (const c of p.pattern_check_results || []) tryA(`${id} CheckResult ${c.check_name}`, C.assertCheckResult, c);
    if (p.diff_test) tryA(`${id} DiffTest`, C.assertDiffTest, p.diff_test);
    const o = p.test_outcome;
    if (o && o.status === 'reverted' && o.reason && !UNTESTED_REASONS.includes(o.reason)) errs.push(`${id}: reverted reason ${o.reason} not in CLAUDE.md's list`);
    console.log(`   ${id} ${p.file}: ${o && o.status}${o && o.reason ? ` (${o.reason})` : ''}${o && o.mutation ? ` mutation keys=[${Object.keys(o.mutation)}]` : ''}`);
  }
  for (const smp of loadSamples(repo)) tryA(`${tag} Sample ${smp.proposal_id}`, C.assertSample, smp);
  const files = fs.readdirSync(stateDirFor(repo)).sort();
  console.log(`   ${tag} state files: [${files}]`);
  if (!files.includes('session.json')) errs.push(`${tag}: no per-target session.json`);
}

(async () => {
  const js = gitInit(env.copyFixture('js-basic'));
  const { s } = await runWith(js, proposals([ADD, RENAME]));
  sweep('js', s, js);

  const hasPytest = spawnSync('pytest', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasPytest) {
    const py = gitInit(env.copyFixture('py-basic'));
    const r = await runWith(py, proposals([PY]));
    sweep('py', r.s, py);
  } else console.log('   py skipped: pytest not installed');

  for (const e of errs) console.log(`   - ${e}`);
  report('contract sweep: every persisted record satisfies src/contracts.js and CLAUDE.md', errs.length === 0,
    `${errs.length} violation(s)`, 'none');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
