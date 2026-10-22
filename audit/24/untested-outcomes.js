'use strict';

// AUDIT-24: the mutation outcomes SG26-SG34 added (`mutation.control_failed`,
// `mutation.uncovered_token`, `mutation.unmutated_ref`) against the contract:
// each must end `reverted` with reason `tests_insensitive` (one of
// collector.UNTESTED_REASONS), so the orchestrator records no sample, reward
// or Reflexion repair (orchestrator.js: `!isLabeled(result)` returns early),
// and the TestOutcome must satisfy src/contracts.js.
//   a  control: `+ '!'`, a test checks the value       -> passed
//   b  control: `+ '!'`, only a source-size test sees `'!'` -> control_failed (SG34)
//   c  uncovered: `typeof n === 'number' ? … : …`      -> uncovered_token
//   d  unmutated: `includes(x)` -> `indexOf(x) !== -1`  -> unmutated_ref
// Executor only (runExecutor on a temp git repo), no API calls.
//   node audit/24/untested-outcomes.js

const { execOn, brief, report, exitCode } = require('./lib');
const { isLabeled, UNTESTED_REASONS } = require('../../src/rl/collector');
const { assertTestOutcome } = require('../../src/contracts');

const M = (body) => `'use strict';\n\nfunction label(n) {\n  ${body}\n}\n\nfunction has(list, x) {\n  return list.includes(x);\n}\n\nmodule.exports = { label, has };\n`;
const OLD = "return 'n=' + n;";
const VALUE_TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label, has } = require('../src/m');\n" +
  "test('label', () => { assert.ok(label(1).startsWith('n=1')); });\ntest('has', () => { assert.strictEqual(has([1, 2], 2), true); assert.strictEqual(has([1], 3), false); });\n";
const sizeTest = (limit) => "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('fs');\nconst path = require('path');\n" +
  `test('module stays small', () => { assert.ok(fs.readFileSync(path.join(__dirname, '../src/m.js'), 'utf8').length <= ${limit}); });\n`;

async function one(id, newBody, { size = false, strict = false, file = 'src/m.js', cur = OLD } = {}) {
  const before = M(OLD);
  const after = before.replace(cur, newBody);
  const files = { 'src/m.js': before, 'test/m.test.js': strict ? VALUE_TEST.replace("assert.ok(label(1).startsWith('n=1'))", "assert.strictEqual(label(1), 'n=1!')") : VALUE_TEST };
  if (size) files['test/size.test.js'] = sizeTest(after.length);
  const { o } = await execOn(files, { file, current_code: cur, proposed_code: newBody });
  let contract = 'ok';
  try { assertTestOutcome(o); } catch (e) { contract = e.message; }
  console.log(`   ${id}: ${brief(o)} labeled=${isLabeled(o)} contract=${contract}`);
  return { o, contract };
}

(async () => {
  const a = await one('a control', "return 'n=' + n + '!';", { strict: true });
  const b = await one('b control_failed', "return 'n=' + n + '!';", { size: true });
  const c = await one('c uncovered', "return typeof n === 'number' ? 'n=' + n : 'n=' + n;");
  const d = await one('d unmutated', 'return list.indexOf(x) !== -1;', { cur: 'return list.includes(x);' });

  report('a control: value-tested insertion commits', a.o.status === 'passed', brief(a.o), 'passed');
  const untested = (r, key) => r.o.status === 'reverted' && r.o.reason === 'tests_insensitive' && UNTESTED_REASONS.includes(r.o.reason) &&
    !isLabeled(r.o) && r.contract === 'ok' && !!(r.o.mutation && r.o.mutation[key]);
  report('b a site only a source-size test notices: mutation.control_failed, untested revert', untested(b, 'control_failed'), brief(b.o),
    'reverted / tests_insensitive, mutation.control_failed > 0, not labelled (no sample, reward or Reflexion), TestOutcome contract ok');
  report('c an inserted keyword no mutant covers: mutation.uncovered_token, untested revert', untested(c, 'uncovered_token'), brief(c.o),
    'reverted / tests_insensitive, mutation.uncovered_token set, not labelled, contract ok');
  report('d a replaced name inside changed code: mutation.unmutated_ref, untested revert', untested(d, 'unmutated_ref'), brief(d.o),
    'reverted / tests_insensitive, mutation.unmutated_ref set, not labelled, contract ok');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
