'use strict';

const env = require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bugInjector = require('../src/rl/bug-injector');
const { loadSamples } = require('../src/rl/collector');
const { assertSample } = require('../src/contracts');
const { fakeProposals, makeTempRepo, makeProposal } = require('./helpers/factories');
const { installStub, resetClient } = require('./helpers/stub-client');

function passing(file, cur, prop, extra = {}) {
  const p = makeProposal(file, cur, prop, { risk: 0.2 });
  p.critic_verdict = { panel: [], p_preserves: 0.9, preserves_semantics: true, agreement: {} };
  p.test_outcome = { status: 'passed' };
  return Object.assign(p, extra);
}

function repoWith(t, file, src) {
  const repo = makeTempRepo();
  fs.writeFileSync(path.join(repo, file), src);
  t.after(() => env.rm(repo));
  return repo;
}

test('injects deterministic mutations into passing code', () => {
  const muts = bugInjector.injectInto('function add(a, b) { return a + b; }');
  assert(muts.length > 0);
  assert(muts.every(m => m.mutated && m.mutated.length));
});

test('emits synthetic negatives for passing proposals only', () => {
  const fp = fakeProposals();
  const passed = { ...fp[1], test_outcome: { status: 'passed' }, proposed_code: 'function f(){ return 1; }' };
  const failed = { ...fp[0], test_outcome: { status: 'failed' } };
  const negs = bugInjector.syntheticNegatives(passed, '/abs/repo', { persist: false, repoRoot: null });
  assert(negs.length > 0);
  assert.strictEqual(bugInjector.syntheticNegatives(failed, '/abs/repo').length, 0);
  for (const s of negs) {
    assertSample(s);
    assert.strictEqual(s.label, 0);
    assert.strictEqual(s.synthetic, true);
  }
});

test('mutants are re-scored by the AST checks with the parent critic features', (t) => {
  const cur = 'function inc(x) {\n  const y = x + 1;\n  return y;\n}';
  const prop = 'function inc(x) {\n  return x + 1;\n}';
  const repo = repoWith(t, 'm.js', cur + '\nmodule.exports = { inc };\n');
  const negs = bugInjector.syntheticNegatives(passing('m.js', cur, prop), repo, { persist: false });
  const byName = Object.fromEntries(negs.map(n => [n.mutation, n.features]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['drop_return', 'numeric_off_by_one']);
  assert.deepStrictEqual(byName.numeric_off_by_one, [0.9, 1, 4, 0.2], 'all checks pass on x + 2');
  assert.strictEqual(byName.drop_return[0], 0.9, 'parent p_preserves, not +0.1');
  assert(byName.drop_return[1] < 1, 'lost return path fails the return check');
});

test('mutants the diff test proves equivalent are dropped', (t) => {
  const cur = "function isStr(x) {\n  if (typeof x === 'string') { return true; }\n  return false;\n}";
  const prop = "function isStr(x) {\n  return typeof x === 'string';\n}";
  const repo = repoWith(t, 'eq.js', cur + '\nmodule.exports = { isStr };\n');
  assert.deepStrictEqual(bugInjector.injectInto(prop).map(m => m.mutation), ['swap_strict_equal', 'drop_return']);
  const negs = bugInjector.syntheticNegatives(passing('eq.js', cur, prop), repo, { persist: false });
  assert.deepStrictEqual(negs.map(n => n.mutation), ['drop_return'], '`typeof x == "string"` is equivalent and dropped');
});

test('uses the original file when the target already holds the edit', (t) => {
  const cur = 'function isNil(v) {\n  if (v === null || v === undefined) { return true; }\n  return false;\n}';
  const prop = 'function isNil(v) {\n  return v == null;\n}';
  const helper = 'const K = 1;\n';
  const repo = repoWith(t, 'n.js', helper + prop + '\nmodule.exports = { isNil };\n');
  const p = passing('n.js', cur, prop);
  assert.strictEqual(bugInjector.originalFileSrc(p, repo), helper + cur + '\nmodule.exports = { isNil };\n');
  const negs = bugInjector.syntheticNegatives(p, repo, { persist: false });
  assert(negs.some(n => n.mutation === 'swap_strict_equal'), '`v === null` diverges on undefined');
});

test('caps at 3 mutants per passing proposal and makes no Claude calls', (t) => {
  const cur = 'async function f(a) {\n  const r = await g(a);\n  if (a === null) return 0;\n  return r === 10 ? true : r;\n}';
  const prop = 'async function f(a) {\n  if (a === null) return 0;\n  const r = await g(a);\n  return r === 10 ? true : r;\n}';
  const repo = repoWith(t, 'c.js', 'function g(x) { return x; }\n' + cur + '\n');
  assert(bugInjector.injectInto(prop).length > 3);
  const stub = installStub({});
  t.after(resetClient);
  const negs = bugInjector.syntheticNegatives(passing('c.js', cur, prop), repo, { persist: false });
  assert(negs.length <= bugInjector.MAX_MUTANTS && negs.length > 0, `got ${negs.length}`);
  assert.strictEqual(bugInjector.MAX_MUTANTS, 3);
  assert.strictEqual(stub.calls.length, 0);
});

test('persists negatives to the target sample store', (t) => {
  const cur = 'function inc(x) {\n  const y = x + 1;\n  return y;\n}';
  const prop = 'function inc(x) {\n  return x + 1;\n}';
  const repo = repoWith(t, 'm.js', cur + '\n');
  const p = passing('m.js', cur, prop);
  const negs = bugInjector.syntheticNegatives(p, repo);
  bugInjector.syntheticNegatives(p, repo);
  const stored = loadSamples(repo);
  assert.strictEqual(stored.length, negs.length, 'de-duplicated across calls');
  stored.forEach(assertSample);
  assert(stored.every(s => s.target_repo === repo && s.synthetic));
});
