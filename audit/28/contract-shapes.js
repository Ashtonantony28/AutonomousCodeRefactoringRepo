'use strict';

// AUDIT-28: shapes and field consistency after SG33-SG35.
//   a  editMutants element keys = its documented shape (ok expected)
//   M1 a site survives after an earlier site was killed: TestOutcome.mutation
//      says killed=null but keeps killed_test / killed_line of the earlier
//      kill (executor.js "`killed` / `killed_test` name the last killing
//      mutant" - one record, two answers)
//   M2 a Python file that starts with a UTF-8 BOM: pyShape's ast.parse
//      rejects U+FEFF, editMutants returns `unchecked`, and every edit ends
//      `mutation_budget`, documented as "the mutants' parse check did not
//      finish in 10 s" (it finished; the file loads fine under Python)
//   L1 src/contracts.js still names none of the TestOutcome.mutation fields
//      (control_failed, uncovered_token, unmutated_ref, collection_errors,
//      killed_test) - A24-L3, contracts part, still open
// Executor on temp git repos plus direct calls; no API calls.
//   node audit/28/contract-shapes.js

const L = require('./lib');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { editMutants } = require('../../src/rl/bug-injector');

const ROOT = path.resolve(__dirname, '../..');

(async () => {
  // a
  const before = "'use strict';\nfunction f(n) {\n  return n;\n}\nmodule.exports = f;\n";
  const ms = editMutants(before.replace('return n;', 'return n + 1;'), { file: 'a.js', before, max: 3 });
  const keys = [...new Set(ms.flatMap(m => Object.keys(m)))].sort();
  const doc = /-> \[\{ ([^}]*) \}\]/.exec(fs.readFileSync(path.join(ROOT, 'src/rl/bug-injector.js'), 'utf8'))[1].split(',').map(s => s.trim().replace(/\?$/, ''));
  console.log(`   a keys=${keys} documented=${doc}`);
  L.report('a editMutants element keys within the documented shape', keys.every(k => doc.includes(k)) && ['src', 'env', 'span'].every(k => keys.includes(k)), `keys=${keys}`, `subset of ${doc}`);

  // M1: two hunks, the first value-tested, the second only executed.
  const M = "'use strict';\n\nfunction label(n) {\n  return 'n=' + n;\n}\n\nfunction tag(n) {\n  return 't=' + n;\n}\n\nmodule.exports = { label, tag };\n";
  const T = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label, tag } = require('../src/m');\n" +
    "test('label', () => { assert.strictEqual(label(1), 'n=1!'); });\ntest('tag runs', () => { tag(1); });\n";
  const edit = { file: 'src/m.js', current_code: "function label(n) {\n  return 'n=' + n;\n}\n\nfunction tag(n) {\n  return 't=' + n;\n}", proposed_code: "function label(n) {\n  return 'n=' + n + '!';\n}\n\nfunction tag(n) {\n  return 't=' + n + '?';\n}" };
  const { o } = await L.execCommit({ 'src/m.js': M, 'test/m.test.js': T }, edit);
  const mu = o.mutation || {};
  console.log(`   M1 status=${o.status} reason=${o.reason || '(none)'} killed=${mu.killed} killed_test=${mu.killed_test} killed_line=${mu.killed_line} surviving_site_line=${mu.surviving_site_line}`);
  L.report('M1 a surviving site leaves killed_test / killed_line of an earlier kill beside killed=null',
    !(mu.killed === null && (mu.killed_test || mu.killed_line)), `killed=${mu.killed} killed_test=${mu.killed_test} killed_line=${mu.killed_line}`,
    'killed, killed_test and killed_line agree (all null, or a separate field for the sites that were killed)');

  // M2: BOM-prefixed Python module.
  const B = '﻿';
  const PY = B + "def label(n):\n    return 'n=' + str(n)\n";
  const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'audit28-bom-')), 'm.py');
  fs.writeFileSync(tmp, PY);
  const loads = spawnSync('python3', ['-I', '-c', 'import sys; compile(open(sys.argv[1], "rb").read(), "m", "exec")', tmp], { encoding: 'utf8' }).status === 0;
  const files = { 'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '', 'app/m.py': PY,
    'tests/test_m.py': "from app.m import label\n\n\ndef test_label():\n    assert label(1) == 'n=1!'\n" };
  const r = await L.execCommit(files, { file: 'app/m.py', current_code: "return 'n=' + str(n)", proposed_code: "return 'n=' + str(n) + '!'" }, { pkg: null });
  const m2 = r.o.mutation || {};
  console.log(`   M2 python3 compiles the BOM file=${loads}; status=${r.o.status} reason=${r.o.reason || '(none)'} parse_check_failed=${!!m2.parse_check_failed} mutants=${m2.mutants} duration_ms=${m2.duration_ms}`);
  L.report('M2 a BOM-prefixed Python module: every edit ends mutation_budget (parse check "did not finish") in well under 10 s',
    !(r.o.reason === 'mutation_budget' && m2.parse_check_failed && m2.duration_ms < 10_000),
    `reason=${r.o.reason} parse_check_failed=${!!m2.parse_check_failed} duration_ms=${m2.duration_ms}`, 'mutants built (BOM is legal), or a reason that says the file was not parsed');

  // L1
  const contracts = fs.readFileSync(path.join(ROOT, 'src/contracts.js'), 'utf8');
  const fields = ['control_failed', 'uncovered_token', 'unmutated_ref', 'collection_errors', 'killed_test'];
  const named = fields.filter(f => contracts.includes(f));
  console.log(`   L1 contracts.js names [${named}] of [${fields}]`);
  L.report('L1 src/contracts.js documents no TestOutcome.mutation field', named.length === fields.length, `named=[${named}]`, 'TestOutcome.mutation documented');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
