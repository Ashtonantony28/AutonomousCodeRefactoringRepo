'use strict';

// AUDIT-36 H1: an inserted `,` right after a kept operand, followed by
// inserted code, is exempt punctuation. That comma can change what the kept
// code means:
//   - a JS comma operator discards the kept operand (`return a;` ->
//     `return a, b;` returns b);
//   - a Python comma makes a tuple (`if (n > 1):` -> `if (n > 1, log(n)):`
//     is always true).
// CLAUDE.md: "a `;` or `,` that changes structure is not exempt". SG41
// lists only a trailing comma and a comma "between two kept tokens"
// (`6000 - 1` -> `6000, - 1`). A comma between a kept token and an inserted
// one is neither, so it is exempt. The kill of the inserted code's
// use-site mutant (`b`, `log(n)`) then carries the comma, and the executor
// commits.
//   a  control: Python `if (n > 1,):` -> uncovered `,` (SG41)
//   b  JS `return a;` -> `return a, b;`: expected uncovered `,`
//   c  Python `if (n > 1):` -> `if (n > 1, log(n)):`: expected uncovered `,`
//   d  end to end, JS: the executor commits `return a, b;` (pick(1, 2) was 1, is now 2)
//   e  end to end, Python: the executor commits `if (n > 1, log(n)):` (size(0) was 'small', is now 'big')
//   f  the `;` analogue, JS: `const x = a && b;` -> `const x = a; log(b) && b;`
//      (the `;` sits between a kept token and an inserted one, before no
//      continue-into character): exempt, and the executor commits
//      (both(true, false) was false, is now true)
// d, e and f give the executor an `equivalent` diff test, as for any diff-test
// blind spot (the real diff test should see pick(1, 2) / size(0) diverge;
// CLAUDE.md names the executor bar as the backstop for what it misses).
// No API calls; d and e drive runExecutor on temp git repos.
//   node audit/36/comma-demotes-operand.js

const L = require('../28/lib');
const { editMutants } = require('../../src/rl/bug-injector');

const unc = (file, before, after) => {
  const m = editMutants(after, { file, before });
  return { u: m.uncovered ? m.uncovered.text : null, muts: m.map(x => x.mutation + (x.ref ? `:${x.ref}` : '')).join(',') };
};
const committedFile = (repo, f) => { try { return L.gitOut(repo, 'show', `HEAD:${f}`); } catch { return ''; } };

(async () => {
  const a = unc('m.py', 'def f(n):\n    if (n > 1):\n        return 1\n    return 0\n', 'def f(n):\n    if (n > 1,):\n        return 1\n    return 0\n');
  const b = unc('m.js', 'function f(a, b) {\n  return a;\n}\n', 'function f(a, b) {\n  return a, b;\n}\n');
  const c = unc('m.py', 'def f(n):\n    if (n > 1):\n        return 1\n    return 0\n', 'def f(n):\n    if (n > 1, log(n)):\n        return 1\n    return 0\n');
  console.log(`   a: uncovered=${JSON.stringify(a.u)}  b: uncovered=${JSON.stringify(b.u)} mutants=${b.muts}  c: uncovered=${JSON.stringify(c.u)} mutants=${c.muts}`);

  // d: JS
  const jsFiles = {
    'src/m.js': 'function pick(a, b) {\n  return a;\n}\nmodule.exports = { pick };\n',
    'test/m.test.js': "const test = require('node:test');\nconst assert = require('assert');\nconst { pick } = require('../src/m');\n\ntest('label', () => {\n  assert.strictEqual(pick(2, 2), 2);\n});\n"
  };
  const d = await L.execCommit(jsFiles, { file: 'src/m.js', current_code: '  return a;', proposed_code: '  return a, b;' });
  const dm = d.o.mutation || {};
  const dc = committedFile(d.repo, 'src/m.js');
  console.log(`   d: status=${d.o.status} reason=${d.o.reason || '(none)'} killed=${dm.killed} killed_test=${dm.killed_test} uncovered_token=${JSON.stringify(dm.uncovered_token)} commit=${d.o.commit ? d.o.commit.slice(0, 12) : '-'}`);
  if (/return a, b;/.test(dc)) console.log('   d: committed src/m.js holds `return a, b;` (pick(1, 2) is now 2, was 1)');

  // e: Python
  const pyFiles = {
    'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '',
    'app/m.py': "CALLS = []\n\n\ndef log(n):\n    CALLS.append(n)\n    return n\n\n\ndef size(n):\n    if (n > 1):\n        return 'big'\n    return 'small'\n",
    'tests/test_m.py': "from app import m\n\n\ndef test_size():\n    m.CALLS.clear()\n    assert m.size(5) == 'big'\n    assert m.CALLS == [5]\n"
  };
  const e = await L.execCommit(pyFiles, { file: 'app/m.py', current_code: '    if (n > 1):', proposed_code: '    if (n > 1, log(n)):' }, { pkg: null });
  const em = e.o.mutation || {};
  const ec = committedFile(e.repo, 'app/m.py');
  console.log(`   e: status=${e.o.status} reason=${e.o.reason || '(none)'} killed=${em.killed} killed_test=${em.killed_test} uncovered_token=${JSON.stringify(em.uncovered_token)} commit=${e.o.commit ? e.o.commit.slice(0, 12) : '-'}`);
  if (/n > 1, log\(n\)\)/.test(ec)) console.log("   e: committed app/m.py holds `if (n > 1, log(n)):` (size(0) is now 'big', was 'small')");

  // f: the `;` analogue, JS: an inserted `;` after a kept operand ends the
  // kept expression early (`const x = a && b;` -> `const x = a; log(b) && b;`).
  const fFiles = {
    'src/m.js': 'const calls = [];\nfunction log(v) { calls.push(v); return v; }\nfunction both(a, b) {\n  const x = a && b;\n  return x;\n}\nmodule.exports = { both, calls };\n',
    'test/m.test.js': "const test = require('node:test');\nconst assert = require('assert');\nconst m = require('../src/m');\n\ntest('label', () => {\n  m.calls.length = 0;\n  assert.strictEqual(m.both(true, true), true);\n  assert.deepStrictEqual(m.calls, [true]);\n});\n"
  };
  const fu = unc('src/m.js', fFiles['src/m.js'], fFiles['src/m.js'].replace('const x = a && b;', 'const x = a; log(b) && b;'));
  const f = await L.execCommit(fFiles, { file: 'src/m.js', current_code: '  const x = a && b;', proposed_code: '  const x = a; log(b) && b;' });
  const fm = f.o.mutation || {};
  console.log(`   f: uncovered=${JSON.stringify(fu.u)} mutants=${fu.muts}; status=${f.o.status} reason=${f.o.reason || '(none)'} killed=${fm.killed} killed_test=${fm.killed_test} commit=${f.o.commit ? f.o.commit.slice(0, 12) : '-'}`);
  if (/const x = a; log\(b\) && b;/.test(committedFile(f.repo, 'src/m.js'))) console.log('   f: committed src/m.js holds `const x = a; log(b) && b;` (both(true, false) is now true, was false)');

  L.report('a control: Python trailing `if (c,):` comma is structural', a.u === ',', JSON.stringify(a.u), '","');
  L.report('b JS `return a;` -> `return a, b;`: the comma operator that discards `a` is exempt punctuation', b.u === ',', `uncovered=${JSON.stringify(b.u)} mutants=${b.muts}`, 'uncovered ","');
  L.report('c Python `if (c):` -> `if (c, log(n)):`: the comma that makes an always-true tuple is exempt punctuation', c.u === ',', `uncovered=${JSON.stringify(c.u)} mutants=${c.muts}`, 'uncovered ","');
  L.report('d executor commits a JS edit whose inserted comma operator discards the returned value', d.o.status !== 'passed',
    `status=${d.o.status} commit=${d.o.commit ? 'yes' : 'no'}`, 'reverted / tests_insensitive (uncovered_token ",")');
  L.report('e executor commits a Python edit whose inserted comma makes an `if` condition always true', e.o.status !== 'passed',
    `status=${e.o.status} commit=${e.o.commit ? 'yes' : 'no'}`, 'reverted / tests_insensitive (uncovered_token ",")');
  L.report('f executor commits a JS edit whose inserted `;` cuts a kept expression short', f.o.status !== 'passed' && fu.u === ';',
    `uncovered=${JSON.stringify(fu.u)} status=${f.o.status} commit=${f.o.commit ? 'yes' : 'no'}`, 'uncovered ";", reverted / tests_insensitive');
  process.exit(L.exitCode());
})().catch(err => { console.error(err); process.exit(2); });
