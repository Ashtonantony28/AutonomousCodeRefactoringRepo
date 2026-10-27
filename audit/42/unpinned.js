'use strict';

// AUDIT-42: surviving SG48-SG50 safety mutants (audit/11/mutants.js block
// "AUDIT-42"), checked for being load-bearing. For each case the real code
// gives the safe outcome (the executor reverts an edit the suite cannot
// judge, or runTests reports a load failure); with the mutant applied to a
// temp copy of src/, the unsafe one (a commit, or a load failure excused so
// its run can count as a kill). The test files naming the mutated module
// then run on the mutated copy: if they stay green, nothing pins the rule
// (full suite: `node audit/11/mutants.js <id>`).
//
//   node audit/42/unpinned.js [BI-contcall ...]   # default: every case
//   node audit/42/unpinned.js --no-tests ...      # verdicts only
//
// Executor cases pass the gate's diff-test result the executor sees
// (`equivalent`, deletions observed), as test/executor.test.js does: the
// executor bar exists for the diff test's blind spots. Each case's test
// asserts the proposed code's values on the inputs it uses; the edit
// changes behaviour on inputs it does not use. Python cases need pytest +
// coverage.py.
//
// Prints FINDING (exit 1) when the real code is unsafe, or when the mutated
// copy is unsafe and the named test files stay green; ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const BI = 'src/rl/bug-injector.js';
const TR = 'src/runner/test-runner.js';
const CONT = '/^(?:[.,?:*%<>=&|^/([`]|';
const LOG = "const seen = [];\nfunction log(x) { seen.push(x); return x; }\nmodule.exports = { f, seen };";
const JSF = (body) => L.T(`const { f, seen } = require('../src/f');\ntest('f', () => { ${body} });`);

const CASES = {
  // SG49 `continued`: a kept `(` right of a line-start `;` continues the line
  // above (`g\n(x)` is a call). `const v = g\n (x)` -> `const v = g\n ; log(x)(x)`
  // makes v the function. The use site of x (log's argument) is killed.
  // Mutant: `(` / `[` / template are no continuation.
  'BI-contcall': {
    finding: 'H1',
    mutate: { file: BI, from: CONT, to: '/^(?:[.,?:*%<>=&|^/]|' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(g, x) {\n  const v = g\n    (x);\n  return v;\n}',
    prop: 'function f(g, x) {\n  const v = g\n    ; log(x)(x);\n  return v;\n}',
    rest: "const seen = [];\nfunction log(x) { seen.push(x); return (y) => y; }\nmodule.exports = { f, seen };",
    test: JSF("const g = (s) => s + '!';\n  assert.strictEqual(f(g, 'a'), g);\n  assert.deepStrictEqual(seen, ['a']);")
  },
  // SG49 `continued`: a kept `in` line continues the expression above.
  // `const ok = k\n in o` -> `const ok = k\n ; log(k) in o` makes ok = k.
  'BI-contin': {
    finding: 'H1',
    mutate: { file: BI, from: '|!=|(?:in|instanceof)(?![\\w$]))/.test(code.slice(r.i, r.i + 11))', to: '|!=)/.test(code.slice(r.i, r.i + 11))' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(k, o) {\n  const ok = k\n    in o;\n  return ok;\n}',
    prop: 'function f(k, o) {\n  const ok = k\n    ; log(k) in o;\n  return ok;\n}',
    rest: LOG,
    test: JSF("assert.strictEqual(f('a', { a: 1 }), 'a');\n  assert.deepStrictEqual(seen, ['a']);")
  },
  // SG49 `continued`: a kept `?` line continues a ternary above.
  // `const v = c\n ? s : t` -> `const v = c\n ; log(s) ? s : t` makes v = c.
  'BI-contq': {
    finding: 'H1',
    mutate: { file: BI, from: CONT, to: '/^(?:[.,*%<>=&|^/([`]|' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(c, s, t) {\n  const v = c\n    ? s : t;\n  return v;\n}',
    prop: 'function f(c, s, t) {\n  const v = c\n    ; log(s) ? s : t;\n  return v;\n}',
    rest: LOG,
    test: JSF("assert.strictEqual(f(true, 'a', 'b'), true);\n  assert.deepStrictEqual(seen, ['a']);")
  },
  // SG49 `continued`: a kept `*` line continues the product above.
  // `const v = n\n * 2` -> `const v = n\n ; log(n) * 2` makes v = n.
  'BI-contop': {
    finding: 'H1',
    mutate: { file: BI, from: CONT, to: '/^(?:[.,?:([`]|' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(n) {\n  const v = n\n    * 2;\n  return v;\n}',
    prop: 'function f(n) {\n  const v = n\n    ; log(n) * 2;\n  return v;\n}',
    rest: LOG,
    test: JSF('assert.strictEqual(f(3), 3);\n  assert.deepStrictEqual(seen, [3]);')
  },
  // SG49 droppedKeyword, JS `for`: `for (; c;) s;` -> `c && s;` runs the
  // step once. The `&&` -> `||` mutant is killed (10 elements -> 9).
  // Mutant: only `while` counts.
  'BI-kwdropjs': {
    finding: 'H2',
    mutate: { file: BI, from: "javascript: new Set('do else for switch try catch finally while with'.split(' '))", to: "javascript: new Set('while'.split(' '))" },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(xs) {\n  for (; xs.length > 9;) xs.pop();\n  return xs;\n}',
    prop: 'function f(xs) {\n  xs.length > 9 && xs.pop();\n  return xs;\n}',
    rest: 'module.exports = { f };',
    test: L.T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).length, 9); });")
  },
  // SG49 droppedKeyword, Python `for`: a one-line loop made one step.
  // Mutant: only `while` counts.
  'BI-kwdroppy': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: "python: new Set('else for while with try except finally match'.split(' '))", to: "python: new Set('while'.split(' '))" },
    tests: /bug-injector|executor/,
    cur: 'def f(xs):\n    for _ in range(len(xs) - 9): xs.pop()\n    return xs\n',
    prop: 'def f(xs):\n    len(xs) > 9 and xs.pop()\n    return xs\n',
    test: 'def test_f():\n    assert len(m.f(list(range(10)))) == 9\n    assert len(m.f(list(range(9)))) == 9\n'
  },
  // SG49 slice `:` of a kept subscript of a call result: `s.split()[n]` ->
  // `s.split()[n:n + 1]` returns a list, not an item. `n`, `+` and `1` are
  // killed. Mutant: only a subscript of a name counts.
  'BI-sliceapplied': {
    finding: 'H3',
    lang: 'py',
    mutate: { file: BI, from: "if (text === ':') return code[o] === '[' && !fresh(o, o + 1) && pyApplied(o) &&", to: "if (text === ':') return code[o] === '[' && !fresh(o, o + 1) && /\\w/.test(code[prevCode(o)]) &&" },
    tests: /bug-injector|executor/,
    cur: 'def f(s, n):\n    return s.split()[n]\n',
    prop: 'def f(s, n):\n    return s.split()[n:n + 1]\n',
    test: "def test_f():\n    assert m.f('a b c', 1) == ['b']\n"
  },
  // SG50 exec_module wrapper logs the module's __file__. A test loads
  // app/m.py by path under a test-like module name and catches the throw;
  // the test then fails. Real: app/m.py logged -> load failure. Mutant: the
  // name is logged (`test_helper.py`, a test file) -> excused.
  'TR-pyexecname': {
    finding: 'H4',
    lang: 'py',
    mutate: { file: TR, from: "log('T\\\\t%s\\\\t%s' % (key, getattr(module, '__file__', None) or module.__name__", to: "log('T\\\\t%s\\\\t%s' % (key, module.__name__" },
    tests: /test-runner|executor/,
    probe: () => ({
      'pytest.ini': '[pytest]\n',
      'app/__init__.py': '',
      'app/m.py': "import os\nif os.environ.get('A42_BAD'):\n    raise ValueError('bad')\n\n\ndef show(s):\n    return s\n",
      'tests/test_a.py': "import importlib.util, pathlib\n\n\ndef load():\n    spec = importlib.util.spec_from_file_location('test_helper', pathlib.Path(__file__).parent.parent / 'app' / 'm.py')\n    mod = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(mod)\n    return mod\n\n\ndef test_a():\n    try:\n        m = load()\n    except Exception:\n        m = None\n    assert m is not None and m.show('a') == 'a'\n"
    })
  },
  // SG50 `U` branch (node without module.registerHooks, simulated as in
  // test/test-runner.test.js by a --require that deletes it): only a node:test
  // file process logs P. A test spawns an ESM CLI with NODE_TEST_CONTEXT
  // removed; the CLI catches the failed import() and exits 0. Real: the
  // child's U key never passes -> load failure. Mutant: P without the file
  // check -> the child's U is excused.
  'TR-upfile': {
    finding: 'H4',
    mutate: { file: TR, from: "  if (file) { log('C\\\\t' + key + '\\\\t' + process.ppid); process.on('exit', (code) => { if (code === 0) log('P\\\\t' + key); }); seen = true; }", to: "  if (file) log('C\\\\t' + key + '\\\\t' + process.ppid); process.on('exit', (code) => { if (code === 0) log('P\\\\t' + key); }); seen = true;" },
    tests: /test-runner|executor/,
    oldNode: true,
    probe: () => ({
      'package.json': L.PKG,
      'src/m.mjs': "if (process.env.A42_BAD) throw new Error('bad');\nexport const show = (s) => s;\n",
      'bin/cli.mjs': "let m;\ntry { m = await import('../src/m.mjs'); } catch (e) { console.log('error: ' + e.message); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n",
      'test/cli.test.js': L.T("test('cli', () => {\n  const env = { ...process.env };\n  delete env.NODE_TEST_CONTEXT;\n  const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/cli.mjs'), 'ab'], { encoding: 'utf8', env });\n  assert.strictEqual(r.stdout, 'ab\\n');\n});")
    })
  }
};

let oldNodeFile = null;
function oldNodeEnv() {
  if (!oldNodeFile) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit42-old-'));
    oldNodeFile = path.join(d, 'old-node.js');
    fs.writeFileSync(oldNodeFile, "delete require('module').registerHooks;\n");
    process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
  }
  return { NODE_OPTIONS: `--require=${oldNodeFile}` };
}

function run(srcRoot, c) {
  if (c.probe) return L.probeRunTests(srcRoot, c.probe(), { extraEnv: c.oldNode ? oldNodeEnv() : undefined });
  return L.execIn(srcRoot, c);
}
const unsafe = (c, r) => c.probe ? L.excused(r) : r.status === 'passed';
const safe = (c, r) => c.probe ? !r.error && r.bad && r.bad.collection_error === true : r.status === 'reverted';

function main() {
  const args = process.argv.slice(2);
  const noTests = args.includes('--no-tests');
  const picked = args.filter(a => !a.startsWith('--'));
  const ids = picked.length ? picked : Object.keys(CASES);
  let findings = 0;
  for (const id of ids) {
    const c = CASES[id];
    if (!c) { console.log(`unknown case ${id}`); continue; }
    if ((c.lang === 'py' || /py/.test(id)) && !L.hasPy()) { console.log(`skip ${id}: pytest + coverage.py not installed`); continue; }
    const real = run(L.ROOT, c);
    console.log(`[${id}] real code:    ${JSON.stringify(real)}`);
    if (!safe(c, real)) { console.log(`FINDING ${c.finding} ${id}: the real code is not safe on this case`); findings++; continue; }
    const dir = L.copyTree(c.mutate, false);
    let mut;
    try { mut = run(dir, c); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`[${id}] mutated copy: ${JSON.stringify(mut)}`);
    if (!unsafe(c, mut)) { console.log(`ok ${id}: the mutated copy is also safe`); continue; }
    if (noTests) { console.log(`load-bearing ${id}: the mutated copy is unsafe (tests not run)`); continue; }
    const k = L.testsKill(c.mutate, c.tests);
    console.log(`[${id}] tests on the mutated copy: ${k.summary}`);
    if (!k.killed) { console.log(`FINDING ${c.finding} ${id}: rule is load-bearing (mutated copy unsafe) and the tests stay green with it`); findings++; } else console.log(`ok ${id}: a test kills the mutant`);
  }
  process.exitCode = findings ? 1 : 0;
}

main();
