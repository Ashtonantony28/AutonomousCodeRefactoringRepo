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

// SG17: a resume whose run worktree is gone never edits the git target in place.
async function crashedRunWithBrokenWorktree(t, breakIt) {
  const { git, treeHash } = require('./helpers/git');
  const repo = gitInit(env.copyFixture('js-basic'));
  const responses = loadFixtureResponses('js-basic');
  installStub(responses);
  t.after(() => { resetClient(); env.rm(repo); });
  const s1 = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));
  const passed = s1.proposals.find(p => p.test_outcome.status === 'passed');
  const saved = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  saved.proposals.find(x => x.issue_id === passed.issue_id).test_outcome = null;
  fs.writeFileSync(sessionPath(repo), JSON.stringify(saved));
  breakIt(repo, s1.worktree, git);
  return { repo, s1, passed, tree: treeHash(repo), treeHash, stub: installStub(responses) };
}

test('resume with the run worktree deleted re-creates it from the branch; target untouched', async (t) => {
  const { repo, s1, passed, tree, treeHash, stub } = await crashedRunWithBrokenWorktree(t, (r, wt) => fs.rmSync(wt.path, { recursive: true, force: true }));
  const s2 = await withoutTestContext(() => runPipeline({ repo, cache: 'off', resume: true }));
  assert.strictEqual(s2.worktree.mode, 'worktree');
  assert.strictEqual(s2.worktree.branch, s1.worktree.branch);
  assert(fs.existsSync(s2.worktree.path));
  const after = s2.proposals.find(x => x.issue_id === passed.issue_id);
  assert.strictEqual(after.test_outcome.commit, passed.test_outcome.commit, 'reconciled from the branch, not re-executed');
  assert.strictEqual(stub.count(), 0);
  assert.deepStrictEqual(treeHash(repo), tree);
});

test('resume with the run branch removed stops with an error; session.worktree kept, target untouched', async (t) => {
  const { repo, s1, passed, tree, treeHash, stub } = await crashedRunWithBrokenWorktree(t, (r, wt, git) => {
    git(r, ['worktree', 'remove', '--force', wt.path]);
    git(r, ['branch', '-D', wt.branch]);
  });
  await assert.rejects(withoutTestContext(() => runPipeline({ repo, cache: 'off', resume: true })),
    (err) => err.code === 'EWORKTREE' && err.message.includes(s1.worktree.branch));
  const kept = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  assert.deepStrictEqual(kept.worktree, s1.worktree);
  assert.strictEqual(kept.proposals.find(x => x.issue_id === passed.issue_id).test_outcome, null);
  assert.strictEqual(stub.count(), 0);
  assert.deepStrictEqual(treeHash(repo), tree);
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

// SG10: the validators judge the region the executor will replace.
async function gateOnly(repo, file, cur, prop, prompts) {
  const { processProposal } = require('../src/orchestrator');
  const { freshSession } = require('../src/utils/checkpoint');
  const { TokenTracker } = require('../src/utils/token-tracker');
  const { Classifier } = require('../src/rl/classifier');
  const { makeProposal } = require('./helpers/factories');
  installStub({ critic: ({ user }) => { prompts.push(user); return { preserves_semantics: true, p_preserves: 0.95, edge_cases: [], hallucination_flags: [], reasoning: 'same' }; } });
  const session = freshSession(repo);
  const proposal = makeProposal(file, cur, prop);
  session.proposals.push(proposal);
  await processProposal({ proposal, session, tracker: new TokenTracker(session), classifier: new Classifier(null), dryRun: true, absRepo: repo, allowRepair: false });
  return proposal;
}

test('a non-verbatim anchor is validated on the matched region: indent-shifted template literal is vetoed', async (t) => {
  const path = require('path');
  const repo = env.copyFixture('js-basic');
  t.after(() => { resetClient(); env.rm(repo); });
  const src = "'use strict';\nfunction greet() {\n  const s = `a\n  b`;\n  return s;\n}\nmodule.exports = { greet };\n";
  fs.writeFileSync(path.join(repo, 'src', 'greet.js'), src);
  const cur = 'const s = `a\nb`;\nreturn s;';
  const prompts = [];
  const proposal = await gateOnly(repo, 'src/greet.js', cur, "const s = 'a\\nb';\nreturn s;", prompts);
  assert.strictEqual(proposal.validated_region.tier, 'indent-shift');
  assert.strictEqual(proposal.validated_region.text, '  const s = `a\n  b`;\n  return s;');
  assert(prompts.some(u => u.includes('  const s = `a\n  b`;')), 'critic saw the matched region');
  assert.strictEqual(proposal.diff_test.verdict, 'divergent', JSON.stringify(proposal.diff_test));
  assert.strictEqual(proposal.test_outcome.status, 'vetoed', JSON.stringify(proposal.test_outcome));
  assert.strictEqual(proposal.current_code, cur);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'greet.js'), 'utf8'), src);
});

test('a reflowed anchor is validated on the file text it maps to, current_code kept', async (t) => {
  const path = require('path');
  const repo = env.copyFixture('js-basic');
  t.after(() => { resetClient(); env.rm(repo); });
  const src = "'use strict';\nfunction twice(x) {\n  const y = x * 2;\n  return y;\n}\nmodule.exports = { twice };\n";
  fs.writeFileSync(path.join(repo, 'src', 'twice.js'), src);
  const cur = 'function twice(x) { const y = x * 2; return y; }';
  const prompts = [];
  const proposal = await gateOnly(repo, 'src/twice.js', cur, 'function twice(x) { return x * 2; }', prompts);
  assert.strictEqual(proposal.validated_region.tier, 'whitespace');
  assert.strictEqual(proposal.validated_region.text, 'function twice(x) {\n  const y = x * 2;\n  return y;\n}');
  assert(prompts.length && prompts.every(u => u.includes('function twice(x) {\n  const y = x * 2;\n  return y;\n}')), 'critic saw the file region');
  assert.strictEqual(proposal.diff_test.verdict, 'equivalent', JSON.stringify(proposal.diff_test));
  assert.strictEqual(proposal.test_outcome.status, 'dry_run', JSON.stringify(proposal.test_outcome));
  assert.strictEqual(proposal.current_code, cur);
});

// ---------- SG14 ----------

test('a proposal to a test file is critic_rejected by the gate without a critic call (AUDIT-5 H6)', async (t) => {
  const path = require('path');
  const { criticGate } = require('../src/orchestrator');
  const repo = env.copyFixture('js-basic');
  t.after(() => { resetClient(); env.rm(repo); });
  const file = 'test/math.test.js';
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  const prompts = [];
  const proposal = await gateOnly(repo, file, '  assert.strictEqual(add(2, 3), 5);', "  assert.ok(typeof add(2, 3) === 'number');", prompts);
  assert.strictEqual(proposal.test_outcome.status, 'critic_rejected');
  assert.match(proposal.test_outcome.reason, /test file test\/math\.test\.js/);
  assert.strictEqual(prompts.length, 0, 'no critic call');
  assert.strictEqual(fs.readFileSync(path.join(repo, file), 'utf8'), src);
  for (const f of ['src/__tests__/a.js', 'lib/a.spec.ts', 'tests/test_paths.py', 'app/paths_test.py']) {
    assert.match(criticGate({ file: f, critic_verdict: null }), /test file/, f);
  }
});

test('the analyzer never proposes edits to test files and does not send them', async (t) => {
  const { runAnalyzer } = require('../src/agents/analyzer');
  const { TokenTracker } = require('../src/utils/token-tracker');
  const { freshSession } = require('../src/utils/checkpoint');
  const users = [];
  const mk = (file) => ({ file, current_code: 'a', proposed_code: 'b', reasoning: 'r', risk_estimate: 0.1 });
  installStub({ 'analyzer-propose': ({ user }) => { users.push(user); return [mk('src/a.js'), mk('test/a.test.js'), mk('lib/b.spec.js')]; } });
  t.after(() => resetClient());
  const files = ['src/a.js', 'test/a.test.js', 'lib/b.spec.js'].map(relative => ({ relative, path: '/x/' + relative, size: 1, content: 'a\n' }));
  const out = await runAnalyzer({ files, tracker: new TokenTracker(freshSession('/x')), hierarchical: false });
  assert.deepStrictEqual(out.map(p => p.file), ['src/a.js']);
  assert(users.length && users.every(u => !u.includes('test/a.test.js') && !u.includes('lib/b.spec.js')));
});

test('a red suite that never ran the edit gives no sample, no reward and no Reflexion repair (AUDIT-7 H2)', async (t) => {
  const path = require('path');
  const { loadSamples } = require('../src/rl/collector');
  const repo = env.copyFixture('js-basic');
  t.after(() => { resetClient(); env.rm(repo); });
  const cur = 'function twice(x) {\n  const r = x * 2;\n  return r;\n}';
  fs.writeFileSync(path.join(repo, 'src', 'twice.js'), `'use strict';\n${cur}\nmodule.exports = { twice };\n`);
  fs.appendFileSync(path.join(repo, 'test', 'math.test.js'), "test('known broken', () => assert.strictEqual(1, 2));\n");
  gitInit(repo);
  const stub = installStub({
    'analyzer-propose': [{ file: 'src/twice.js', current_code: cur, proposed_code: 'function twice(x) {\n  return x * 2;\n}', reasoning: 'inline', risk_estimate: 0.1 }],
    critic: { preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: 'same' },
    reflexion: 'not json'
  });
  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));
  const p = session.proposals[0];
  assert.strictEqual(p.test_outcome.status, 'reverted', JSON.stringify(p.test_outcome));
  assert.strictEqual(p.test_outcome.reason, 'edit_not_exercised');
  assert(p.test_outcome.failed_tests >= 1 || /known broken/.test(p.test_outcome.stdout_tail));
  assert.strictEqual(p.reward, undefined);
  assert.strictEqual(stub.count('reflexion'), 0);
  assert.deepStrictEqual(loadSamples(repo).filter(s => s.proposal_id === p.issue_id), []);
});
