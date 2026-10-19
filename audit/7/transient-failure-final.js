'use strict';

// AUDIT-7 M1: infrastructure failures are recorded as verdicts on the edit.
//  a) every critic call fails (API outage, rate limit after the retry): each
//     persona becomes a malformed reject, the jury is a unanimous reject and
//     the proposal is `vetoed` - the same status as a divergent diff test.
//  b) the validator throws: combined_confidence = 0 and the proposal is
//     `critic_rejected`.
// The contract has `error` for this. Because --resume only processes
// proposals without a test_outcome, neither is ever retried.
//
//   node audit/7/transient-failure-final.js

require('../../test/helpers/env');
// hybrid-validator binds runChecks when it loads: wrap it before the pipeline does.
const ast = require('../../src/validation/ast-checker');
const realRunChecks = ast.runChecks;
let boom = false;
ast.runChecks = (...a) => { if (boom) throw new Error('EMFILE: too many open files'); return realRunChecks(...a); };
const { env, gitInit, runWith, report, exitCode } = require('./lib');
const { loadFixtureResponses } = require('../../test/helpers/stub-client');

(async () => {
  // a) critic outage, then resume with a healthy critic
  const repo = gitInit(env.copyFixture('js-basic'));
  const down = loadFixtureResponses('js-basic');
  down.critic = () => { throw Object.assign(new Error('529 overloaded'), { status: 529 }); };
  const r1 = await runWith(repo, down);
  const st1 = r1.s.proposals.map(p => `${p.issue_id.slice(0, 8)}:${p.test_outcome.status}`);
  const r2 = await runWith(repo, loadFixtureResponses('js-basic'), { resume: true });
  const st2 = r2.s.proposals.map(p => `${p.issue_id.slice(0, 8)}:${p.test_outcome.status}`);
  const why = r1.s.proposals[0].test_outcome.reasons || [];
  console.log(`a) outage run: ${st1.join(', ')} (${String(why[0]).slice(0, 110)})`);
  console.log(`a) --resume with the critic back: ${st2.join(', ')}; critic calls on resume: ${r2.stub.count('critic')}`);
  report('M1a a critic outage is recorded as a hard veto and never retried',
    !st1.every(s => s.endsWith(':vetoed')) || r2.stub.count('critic') > 0,
    `all proposals vetoed by "unanimous_reject" built from API errors; resume made ${r2.stub.count('critic')} critic calls and kept them vetoed`,
    'status error (contract) for a jury made only of malformed verdicts, and --resume retries error outcomes');

  // b) validator exception
  const repo2 = gitInit(env.copyFixture('js-basic'));
  boom = true;
  let r3;
  try { r3 = await runWith(repo2, loadFixtureResponses('js-basic')); } finally { boom = false; }
  const o = r3.s.proposals[0].test_outcome;
  console.log(`b) validator threw: status=${o.status} reason=${o.reason}`);
  report('M1b a validator exception is recorded as critic_rejected',
    o.status === 'error',
    `status=${o.status} ("${o.reason}"), indistinguishable from a jury rejection in the summary, dashboard and resume`,
    'status error with the exception message, retried on --resume');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
