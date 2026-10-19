'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { featuresFor, summarizeRun, runPipeline } = require('../src/orchestrator');
const { extractFeatures } = require('../src/rl/features');
const { fakeProposals } = require('./helpers/factories');

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
