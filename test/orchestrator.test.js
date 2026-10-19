'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { featuresFor, summarizeRun, runPipeline } = require('../src/orchestrator');
const { extractFeatures } = require('../src/rl/features');
const { sessionPath } = require('../src/utils/checkpoint');
const { fakeProposals } = require('./helpers/factories');
const { installStub, resetClient, loadFixtureResponses } = require('./helpers/stub-client');
const { gitInit, branchCommits } = require('./helpers/git');

// The fixture's own `node --test` run must not inherit this runner's child context.
async function withoutTestContext(fn) {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await fn(); } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
}

test('featuresFor returns one number per feature', () => {
  const p = fakeProposals()[0];
  const f = featuresFor(p);
  assert.strictEqual(f.length, require('../src/rl/features').FEATURE_NAMES.length);
  assert.deepStrictEqual(f, extractFeatures(p));
});

test('summarizeRun counts statuses', () => {
  const props = fakeProposals();
  assert.strictEqual(summarizeRun({ proposals: props }).total, props.length);
});

test('runPipeline rejects a missing repo without exiting the process', async () => {
  await assert.rejects(runPipeline({ repo: '/nonexistent/refactor-repo-xyz', cache: 'off' }), (e) => e.code === 'ENOREPO');
});

test('analyzer issue_id is sha256(file NUL current_code)[:16], ignores model ids, suffixes collisions', () => {
  const crypto = require('crypto');
  const { normalizeProposal, proposalId } = require('../src/agents/analyzer');
  const expected = crypto.createHash('sha256').update('a.js\0x = 1').digest('hex').slice(0, 16);
  assert.strictEqual(proposalId('a.js', 'x = 1'), expected);
  const taken = new Set([expected]);
  const raw = { issue_id: 'model-made-this-up', file: 'a.js', current_code: 'x = 1', proposed_code: 'x = 2' };
  assert.strictEqual(normalizeProposal(raw, new Set(['a.js']), taken).issue_id, `${expected}-2`);
  assert.strictEqual(normalizeProposal(raw, new Set(['a.js']), taken).issue_id, `${expected}-3`);
  assert.strictEqual(normalizeProposal(raw, new Set(['a.js'])).issue_id, expected);
});

test('resume after a crash between commit and save takes the outcome from the branch commit', async (t) => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const responses = loadFixtureResponses('js-basic');
  installStub(responses);
  t.after(() => { resetClient(); env.rm(repo); });

  const s1 = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));
  const passed = s1.proposals.find(p => p.test_outcome.status === 'passed');
  const sha = passed.test_outcome.commit;
  assert(sha);

  // The on-disk session a SIGKILL right after the commit leaves behind.
  const saved = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  const p = saved.proposals.find(x => x.issue_id === passed.issue_id);
  p.test_outcome = null;
  p.decision_trace = p.decision_trace.filter(s => s.stage !== 'executor' && s.stage !== 'rl');
  saved.test_results = saved.test_results.filter(x => x.proposal_id !== p.issue_id);
  fs.writeFileSync(sessionPath(repo), JSON.stringify(saved));

  const stub = installStub(responses);
  const s2 = await withoutTestContext(() => runPipeline({ repo, cache: 'off', resume: true }));
  const after = s2.proposals.find(x => x.issue_id === passed.issue_id);
  assert.strictEqual(s2.run_id, s1.run_id);
  assert.strictEqual(after.test_outcome.status, 'passed');
  assert.strictEqual(after.test_outcome.commit, sha);
  assert.strictEqual(stub.count(), 0, 'not re-validated, no repair');
  assert.strictEqual(s2.proposals.length, s1.proposals.length);
  assert.strictEqual(s2.test_results.filter(x => x.proposal_id === p.issue_id).length, 1);
  assert.deepStrictEqual(branchCommits(repo, s2.worktree.branch), [sha]);
});

test('a run on another target does not discard a resumable session', async (t) => {
  const A = gitInit(env.copyFixture('js-basic'));
  const B = env.copyFixture('no-tests');
  t.after(() => { resetClient(); env.rm(A); env.rm(B); });
  installStub(loadFixtureResponses('js-basic'));
  const a1 = await withoutTestContext(() => runPipeline({ repo: A, cache: 'off', dryRun: true }));
  installStub(loadFixtureResponses('no-tests'));
  await withoutTestContext(() => runPipeline({ repo: B, cache: 'off', dryRun: true, resume: true }));
  const stub = installStub(loadFixtureResponses('js-basic'));
  const a2 = await withoutTestContext(() => runPipeline({ repo: A, cache: 'off', dryRun: true, resume: true }));
  assert.strictEqual(a2.run_id, a1.run_id);
  assert.strictEqual(stub.count('analyzer-propose'), 0);
});

test('an edit the diff test could not confirm never reaches the executor (fail-closed gate)', async (t) => {
  const { processProposal } = require('../src/orchestrator');
  const { freshSession } = require('../src/utils/checkpoint');
  const { TokenTracker } = require('../src/utils/token-tracker');
  const { Classifier } = require('../src/rl/classifier');
  const { makeProposal } = require('./helpers/factories');
  const path = require('path');
  const repo = env.copyFixture('js-basic');
  t.after(() => { resetClient(); env.rm(repo); });
  const cur = 'function ext(p) {\n  return path.extname(p);\n}';
  const src = `'use strict';\nconst path = require('path');\n${cur}\nmodule.exports = { ext };\n`;
  fs.writeFileSync(path.join(repo, 'src', 'ext.js'), src);
  installStub({ critic: { preserves_semantics: true, p_preserves: 0.95, edge_cases: [], hallucination_flags: [], reasoning: 'same' } });
  const session = freshSession(repo);
  const proposal = makeProposal('src/ext.js', cur, 'function ext(p) {\n  return path.basename(p);\n}');
  session.proposals.push(proposal);
  await withoutTestContext(() => processProposal({ proposal, session, tracker: new TokenTracker(session), classifier: new Classifier(null), dryRun: false, absRepo: repo, allowRepair: false }));
  assert.strictEqual(proposal.test_outcome.status, 'critic_rejected', JSON.stringify(proposal.test_outcome));
  assert.strictEqual(session.test_results.length, 0);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'ext.js'), 'utf8'), src);
});
