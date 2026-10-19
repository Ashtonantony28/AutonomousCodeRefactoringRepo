'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { featuresFor, summarizeRun, summarizeProposal, runPipeline } = require('../src/orchestrator');
const { extractFeatures } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

test('summarizeProposal trims to keys', () => {
  const s = summarizeProposal(fakeProposals()[0]);
  assert(s.file && typeof s.risk_estimate === 'number');
});

test('featuresFor returns 5 numbers', () => {
  const p = fakeProposals()[0];
  const f = featuresFor(p);
  assert.strictEqual(f.length, 5);
  assert.deepStrictEqual(f, extractFeatures(p));
});

test('summarizeRun counts statuses', () => {
  const props = fakeProposals();
  assert.strictEqual(summarizeRun({ proposals: props }).total, props.length);
});

test('runPipeline rejects a missing repo without exiting the process', async () => {
  await assert.rejects(runPipeline({ repo: '/nonexistent/refactor-repo-xyz', cache: 'off' }), (e) => e.code === 'ENOREPO');
});
