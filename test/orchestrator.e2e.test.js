'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../src/orchestrator');
const { assertProposal, assertSample } = require('../src/contracts');
const { loadSamples } = require('../src/rl/collector');
const { installStub, resetClient, loadFixtureResponses, FIXTURES_DIR } = require('./helpers/stub-client');

// The fixture's own `node --test` run must not inherit this runner's child context.
async function withoutTestContext(fn) {
  const prev = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await fn(); } finally { if (prev !== undefined) process.env.NODE_TEST_CONTEXT = prev; }
}

test('runPipeline on js-basic with the stub client ends with expected statuses', async (t) => {
  const repo = env.copyFixture('js-basic');
  const stub = installStub(loadFixtureResponses('js-basic'));
  t.after(() => { resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));

  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'js-basic', 'proposals.json'), 'utf8'));
  const statuses = Object.fromEntries(session.proposals.map(p => [p.issue_id, p.test_outcome && p.test_outcome.status]));
  assert.deepStrictEqual(statuses, Object.fromEntries(expected.map(p => [p.issue_id, p.expected_status])));

  assert.strictEqual(stub.count('analyzer-propose'), 1);
  assert.strictEqual(stub.count('critic'), 6);
  assert.strictEqual(stub.count('executor'), 1);
  assert.strictEqual(stub.count('reflexion'), 0);

  const src = fs.readFileSync(path.join(repo, 'src', 'math.js'), 'utf8');
  assert(src.includes('function add(a, b) {\n  return a + b;\n}'), 'passing edit is kept');
  assert(src.includes('try {'), 'rejected edit is not applied');

  for (const p of session.proposals) assertProposal(p);
  assert(session.rl_samples.length > 1, 'real sample plus synthetic negatives');
  for (const s of session.rl_samples) {
    assertSample(s);
    assert.strictEqual(s.target_repo, path.resolve(repo));
  }
  for (const s of loadSamples()) assertSample(s);

  const passed = session.proposals.find(p => p.test_outcome.status === 'passed');
  assert(passed.decision_trace.some(s => s.stage === 'ast' && typeof s.duration_ms === 'number'));

  assert(fs.existsSync(path.join(env.stateDir, 'session.json')));
  assert(fs.existsSync(path.join(env.dashboardDir, 'dashboard.html')));
});

test('runPipeline on js-failing-after-edit reverts the failing edit', async (t) => {
  const repo = env.copyFixture('js-failing-after-edit');
  const before = fs.readFileSync(path.join(repo, 'src', 'greet.js'), 'utf8');
  const stub = installStub(loadFixtureResponses('js-failing-after-edit'));
  t.after(() => { resetClient(); env.rm(repo); });

  const session = await withoutTestContext(() => runPipeline({ repo, cache: 'off' }));

  assert.deepStrictEqual(session.proposals.map(p => p.test_outcome.status), ['reverted']);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src', 'greet.js'), 'utf8'), before);
  assert.strictEqual(stub.count('reflexion'), 1);
  for (const p of session.proposals) assertProposal(p);
  for (const s of session.rl_samples) assertSample(s);
});
