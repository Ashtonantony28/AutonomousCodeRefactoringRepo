'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/orchestrator');
const { assertProposal, assertSample } = require('../src/contracts');
const { loadSamples } = require('../src/rl/collector');
const { proposalId } = require('../src/agents/analyzer');
const { sessionPath, inflightPath } = require('../src/utils/checkpoint');
const { installStub, resetClient, loadFixtureResponses, FIXTURES_DIR } = require('./helpers/stub-client');
const { gitInit, treeHash, branchCommits, git } = require('./helpers/git');

// The fixture's own `node --test` run must not inherit this runner's child context.
async function withoutTestContext(fn) {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await fn(); } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
}

function expectedStatuses(name) {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name, 'proposals.json'), 'utf8'));
  return Object.fromEntries(expected.map(p => [proposalId(p.file, p.current_code), p.expected_status]));
}

function statusesOf(session) {
  return Object.fromEntries(session.proposals.map(p => [p.issue_id, p.test_outcome && p.test_outcome.status]));
}

test('js-basic: target untouched, one commit for the passing proposal on the run branch', async (t) => {
  const repo = gitInit(env.copyFixture('js-basic'));
  const before = treeHash(repo);
  const stub = installStub(loadFixtureResponses('js-basic'));
  t.after(() => { resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));

  assert.deepStrictEqual(statusesOf(session), expectedStatuses('js-basic'));
  assert.strictEqual(stub.count('analyzer-propose'), 1);
  assert.strictEqual(stub.count('critic'), 6);
  assert.strictEqual(stub.count('executor'), 0, 'no decorative executor call');
  assert.strictEqual(stub.count('reflexion'), 0);

  assert.deepStrictEqual(treeHash(repo), before, 'target working tree is byte-identical');
  const wt = session.worktree;
  assert.strictEqual(wt.mode, 'worktree');
  assert.strictEqual(wt.branch, `refactor/${session.run_id}`);
  const commits = branchCommits(repo, wt.branch);
  assert.strictEqual(commits.length, 1);
  const passed = session.proposals.find(p => p.test_outcome.status === 'passed');
  const msg = git(repo, ['log', '-1', '--format=%B', commits[0]]);
  assert(msg.includes(passed.issue_id) && msg.includes(passed.file), msg);
  assert.strictEqual(passed.test_outcome.commit, commits[0]);
  assert.deepStrictEqual(git(repo, ['show', '--name-only', '--format=', commits[0]]).split('\n'), ['src/math.js']);

  const src = fs.readFileSync(path.join(wt.root, 'src', 'math.js'), 'utf8');
  assert(src.includes('function add(a, b) {\n  return a + b;\n}'), 'passing edit is kept in the worktree');
  assert(src.includes('try {'), 'rejected edit is not applied');
  assert(!fs.existsSync(inflightPath(repo)), 'no in-flight snapshot left behind');

  for (const p of session.proposals) assertProposal(p);
  assert(session.rl_samples.length > 1, 'real sample plus synthetic negatives');
  for (const s of session.rl_samples) {
    assertSample(s);
    assert.strictEqual(s.target_repo, path.resolve(repo));
  }
  for (const s of loadSamples()) assertSample(s);
  assert(passed.decision_trace.some(s => s.stage === 'ast' && typeof s.duration_ms === 'number'));
  assert(passed.decision_trace.some(s => s.stage === 'executor' && s.outcome === 'passed'));

  assert(fs.existsSync(sessionPath(repo)));
  assert(fs.existsSync(path.join(env.dashboardDir, 'dashboard.html')));
});

test('js-failing-after-edit: target untouched and the run branch has no commits', async (t) => {
  const repo = gitInit(env.copyFixture('js-failing-after-edit'));
  const before = treeHash(repo);
  const stub = installStub(loadFixtureResponses('js-failing-after-edit'));
  t.after(() => { resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));

  assert.deepStrictEqual(session.proposals.map(p => p.test_outcome.status), ['reverted']);
  assert.deepStrictEqual(treeHash(repo), before);
  assert.deepStrictEqual(branchCommits(repo, session.worktree.branch), []);
  assert.strictEqual(
    fs.readFileSync(path.join(session.worktree.root, 'src', 'greet.js'), 'utf8'),
    fs.readFileSync(path.join(repo, 'src', 'greet.js'), 'utf8'),
    'worktree file reverted'
  );
  assert.strictEqual(stub.count('reflexion'), 1);
  for (const p of session.proposals) assertProposal(p);
  for (const s of session.rl_samples) assertSample(s);
});

test('non-git target falls back to in-place edits with a warning', async (t) => {
  const repo = env.copyFixture('js-basic');
  installStub(loadFixtureResponses('js-basic'));
  const logs = [];
  const log = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  t.after(() => { console.log = log; resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));
  console.log = log;

  assert.strictEqual(session.worktree.mode, 'in-place');
  assert(logs.some(l => l.includes('not a git repository') && l.includes('in place')), logs.join('\n'));
  assert.deepStrictEqual(statusesOf(session), expectedStatuses('js-basic'));
  const src = fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8');
  assert(src.includes('function add(a, b) {\n  return a + b;\n}'));
  assert(src.includes('try {'));
});

test('no-tests: skipped_no_tests and the edit is reverted', async (t) => {
  const repo = gitInit(env.copyFixture('no-tests'));
  const before = treeHash(repo);
  installStub(loadFixtureResponses('no-tests'));
  t.after(() => { resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));

  assert.deepStrictEqual(statusesOf(session), expectedStatuses('no-tests'));
  assert.deepStrictEqual(treeHash(repo), before);
  assert.strictEqual(
    fs.readFileSync(path.join(session.worktree.root, 'src', 'util.js'), 'utf8'),
    fs.readFileSync(path.join(repo, 'src', 'util.js'), 'utf8')
  );
  assert.deepStrictEqual(branchCommits(repo, session.worktree.branch), []);
  assert.strictEqual(session.rl_samples.length, 0, 'untested edits produce no sample');
  for (const p of session.proposals) assertProposal(p);
});

test('--cache replay rerun of js-basic makes zero client calls with the same statuses', async (t) => {
  const first = gitInit(env.copyFixture('js-basic'));
  const second = gitInit(env.copyFixture('js-basic'));
  t.after(() => { resetClient(); env.rm(first); env.rm(second); });

  const live = installStub(loadFixtureResponses('js-basic'));
  const s1 = await withoutTestContext(() => runPipeline({ repo: first, cache: 'read-write' }));
  assert(live.count() > 0);

  const replay = installStub({});
  const s2 = await withoutTestContext(() => runPipeline({ repo: second, cache: 'replay' }));
  assert.strictEqual(replay.count(), 0, `replay made calls: ${JSON.stringify(replay.calls)}`);
  assert.deepStrictEqual(statusesOf(s2), statusesOf(s1));
  assert.deepStrictEqual(statusesOf(s2), expectedStatuses('js-basic'));
});

test('--resume skips the analyzer, processes a pending repair once, no duplicates', async (t) => {
  const repo = gitInit(env.copyFixture('js-failing-after-edit'));
  const before = treeHash(repo);
  const responses = loadFixtureResponses('js-failing-after-edit');
  responses.reflexion = {
    file: 'src/greet.js',
    current_code: "console.log('greet', name);",
    proposed_code: "console.log('gr' + 'eet', name);",
    reasoning: 'keep the log message, split it',
    risk_estimate: 0.1
  };
  installStub(responses);
  t.after(() => { resetClient(); env.rm(repo); });

  const s1 = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));
  const repair = s1.proposals.find(p => p.parent_issue_id);
  assert(repair, 'repair was emitted');
  assert.strictEqual(repair.issue_id, `${proposalId('src/greet.js', "console.log('greet', name);")}-2`, 'collision gets a suffix');

  // Simulate a crash right after the repair was saved: rewind the repair to
  // pending and drop the commit it produced.
  const saved = JSON.parse(fs.readFileSync(sessionPath(repo), 'utf8'));
  const r = saved.proposals.find(p => p.parent_issue_id);
  Object.assign(r, { test_outcome: null, critic_verdict: null, combined_confidence: null, diff_test: null, veto: null, pattern_check_results: [] });
  r.decision_trace = r.decision_trace.filter(s => s.stage === 'analyzer');
  saved.test_results = saved.test_results.filter(x => x.proposal_id !== r.issue_id);
  fs.writeFileSync(sessionPath(repo), JSON.stringify(saved));
  git(saved.worktree.path, ['reset', '-q', '--hard', saved.worktree.base]);

  const stub = installStub(responses);
  const s2 = await withoutTestContext(() => runPipeline({ repo, cache: 'off', resume: true }));

  assert.strictEqual(s2.run_id, s1.run_id);
  assert.strictEqual(stub.count('analyzer-propose'), 0, 'analyzer skipped on resume');
  assert.strictEqual(stub.count('reflexion'), 0, 'finished parent is not reprocessed');
  const ids = s2.proposals.map(p => p.issue_id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate proposals');
  assert.strictEqual(ids.length, 2);
  const done = s2.proposals.find(p => p.parent_issue_id);
  assert.strictEqual(done.test_outcome.status, 'passed');
  assert.strictEqual(s2.test_results.filter(x => x.proposal_id === done.issue_id).length, 1);
  assert.strictEqual(branchCommits(repo, s2.worktree.branch).length, 1);
  assert.deepStrictEqual(treeHash(repo), before);
});
