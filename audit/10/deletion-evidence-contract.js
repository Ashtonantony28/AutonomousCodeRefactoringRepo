'use strict';

// AUDIT-10 M4: since SG18 the executor's commit bar reads
// `proposal.diff_test.deletions_observed` (agents/executor.js
// mutationEvidence): a deletion-only hunk is kept only when it is `true`.
// The field is not in the DiffTest contract (src/contracts.js, PLAN
// "Interface contracts"), assertDiffTest does not know it, and nothing
// documents who must set it. Two DiffTests that are equally valid under the
// contract give opposite commit decisions for the same edit and suite; a
// contract-conforming producer (e.g. the SG19 Python diff test now being
// written) makes every deletion `tests_insensitive`.
//
//   node audit/10/deletion-evidence-contract.js

const { makeRepo, noTestCtx, quiet, report, exitCode } = require('./lib');
const { runExecutor } = require('../../src/agents/executor');
const { assertDiffTest } = require('../../src/contracts');
const diffTesting = require('../../src/validation/diff-testing');
const fs = require('fs');
const path = require('path');

const CUR = 'function inc(x) {\n  const unused = x * 2;\n  return x + 1;\n}';
const NEW = 'function inc(x) {\n  return x + 1;\n}';
const FILE_SRC = `'use strict';\n${CUR}\nmodule.exports = { inc };\n`;

async function execWith(dt) {
  const repo = makeRepo({
    'src/inc.js': FILE_SRC,
    'test/inc.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { inc } = require('../src/inc');\n" +
      "test('inc', () => { assert.strictEqual(inc(1), 2); assert.strictEqual(inc(-1), 0); });\n"
  }, { pkg: { name: 'a10d', version: '0.0.0', private: true, scripts: { test: 'node --test test/inc.test.js' } } });
  const proposal = { issue_id: 'del', file: 'src/inc.js', current_code: CUR, proposed_code: NEW, diff_test: dt };
  const out = await quiet(() => noTestCtx(() => runExecutor({ proposal, repoRoot: repo })));
  const kept = fs.readFileSync(path.join(repo, 'src/inc.js'), 'utf8') !== FILE_SRC;
  return { out, kept };
}

(async () => {
  const real = diffTesting.run({ currentSrc: CUR, proposedSrc: NEW, fileSrc: FILE_SRC });
  console.log(`   producer (diff-testing.run): verdict=${real.verdict} runs=${real.runs} deletions_observed=${real.deletions_observed}`);
  const contractOnly = { applicable: true, verdict: 'equivalent', runs: real.runs, duration_ms: real.duration_ms };
  const withField = { ...contractOnly, deletions_observed: true };
  assertDiffTest(contractOnly);
  assertDiffTest(withField);
  const a = await execWith(contractOnly);
  const b = await execWith(withField);
  console.log(`   contract-only DiffTest:            ${a.out.status}${a.out.reason ? ' ' + a.out.reason : ''} (edit kept: ${a.kept})`);
  console.log(`   same + deletions_observed: true:   ${b.out.status}${b.out.reason ? ' ' + b.out.reason : ''} (edit kept: ${b.kept})`);
  report('M4 the commit bar reads DiffTest.deletions_observed, which the DiffTest contract does not have',
    a.out.status === b.out.status,
    `both DiffTests pass assertDiffTest; the edit is ${a.out.status}/${a.out.reason || '-'} with one and ${b.out.status} with the other`,
    'deletions_observed (boolean, set when the DiffTest has deleted statements, required for verdict equivalent to vouch for a deletion) added to the DiffTest contract and assertDiffTest, or the executor derives the decision from contract fields only');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
