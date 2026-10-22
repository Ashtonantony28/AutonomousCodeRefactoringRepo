'use strict';

// AUDIT-30: surviving SG37/SG38 safety mutants, shown to be load-bearing.
// For each case the real executor reverts an edit the suite cannot judge;
// with the mutant applied to a temp copy of src/ the same edit is committed.
// The test files that name the mutated module are then run on the mutated
// copy: if they stay green, nothing pins the rule (full suite:
// `node audit/11/mutants.js <id>`).
//
//   node audit/30/unpinned.js [BI-while] ...      # default: every case
//   node audit/30/unpinned.js --no-tests ...      # executor verdicts only
//
// Cases pass the gate's diff-test result the executor sees (`equivalent`,
// deletions observed), as test/executor.test.js does: the executor bar exists
// for the diff test's blind spots. Python cases need pytest + coverage.py.
//
// Prints FINDING (exit 1) when the real code commits, or when the mutated
// copy commits and the named test files stay green; ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const T = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const EQUIV = { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: true, duration_ms: 1 };
const BI = 'src/rl/bug-injector.js';
const TR = 'src/runner/test-runner.js';

const CASES = {
  // SG37 JS `;`: an inserted `;` after a `while (...)` head empties the loop
  // body; `t += 2` then runs once whatever n is. The suite only calls n = 1,
  // where the loop body runs once either way; the `2` beside it is killed.
  // Mutant: only `if` / `for` heads count (the test pins `if`, `for`).
  'BI-while': {
    finding: 'H1',
    mutate: { file: BI, from: '/\\b(?:if|for|while)\\s*$/', to: '/\\b(?:if|for)\\s*$/' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(t, n) {\n  while (n-- > 0) t += 1;\n  return t;\n}',
    prop: 'function f(t, n) {\n  while (n-- > 0); t += 2;\n  return t;\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(0, 1), 2); assert.strictEqual(f(5, 1), 7); });"),
    diff_test: EQUIV
  },
  // SG37 JS `;` before a line ASI would have joined: `s\n  -n` is `s - n`;
  // with `;` the `-n` is a dead statement. The suite only calls n = 0; the
  // `* 2` beside the `;` is killed. Mutant: only a line starting `(` counts
  // (the test pins `(`; `[`, template, `+`, `-`, `/` are unpinned).
  'BI-asichar': {
    finding: 'H1',
    mutate: { file: BI, from: '/^[([`+\\-/]/.test(code[nextCode(a + 1)]', to: '/^[(]/.test(code[nextCode(a + 1)]' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(s, n) {\n  const v = s\n  -n\n  return v;\n}',
    prop: 'function f(s, n) {\n  const v = s * 2;\n  -n\n  return v;\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(3, 0), 6); assert.strictEqual(f(5, 0), 10); });"),
    diff_test: EQUIV
  },
  // SG37 Python `;` on a compound line: `for x in xs: t += x; t = t + 2`
  // moves `t = t + 2` into the loop. The suite only passes one-element
  // lists. Mutant: only `if` / `elif` / `else` lines count (the test pins `if`).
  'BI-pykw': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: '(?:if|elif|else|for|while|with|try|except|finally|def|class|async|match|case)\\b', to: '(?:if|elif|else)\\b' },
    tests: /bug-injector|executor/,
    cur: 'def f(t, xs):\n    for x in xs: t += x\n    t = t + 1\n    return t\n',
    prop: 'def f(t, xs):\n    for x in xs: t += x; t = t + 2\n    return t\n',
    test: 'def test_f():\n    assert m.f(0, [1]) == 3\n    assert m.f(5, [2]) == 9\n',
    diff_test: EQUIV
  },
  // SG37 Python trailing comma before `=`: `x = ys` -> `x, = ys` unpacks a
  // one-element sequence (a list gives its element, not the list). The
  // suite only passes strings, where xs[:1] and its one element are equal.
  // Mutant: a comma right before `=` (or `;`) at statement level is exempt.
  'BI-pyeq': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: "q === undefined || q === ';' || q === '=' || /\\n/", to: 'q === undefined || /\\n/' },
    tests: /bug-injector|executor/,
    cur: 'def f(xs):\n    x = xs\n    return x\n',
    prop: 'def f(xs):\n    x, = xs[:1]\n    return x\n',
    test: "def test_f():\n    assert m.f('ab') == 'a'\n    assert m.f('cd') == 'c'\n",
    diff_test: EQUIV
  },
  // SG37 Python grouping paren after an operator keyword: `s in (t)` is a
  // substring test, `s in (t,)` an equality test. The suite only checks
  // s == t. Mutant: only `return` before the paren makes it a grouping
  // paren (the test pins `return (t,)`); `in`, `not`, `and`, ... read as calls.
  'BI-pykwapp': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: '!/\\b(?:return|in|not|and|or|is|if|else|yield|await|lambda|del|assert)$/.test(head)', to: '!/\\b(?:return)$/.test(head)' },
    tests: /bug-injector|executor/,
    cur: 'def f(s, t):\n    return [s in (t), 1]\n',
    prop: 'def f(s, t):\n    return [s in (t,), 2]\n',
    test: "def test_f():\n    assert m.f('a', 'a') == [True, 2]\n    assert m.f('b', 'c') == [False, 2]\n",
    diff_test: EQUIV
  },
  // SG37 indentation: a line indented into an `if` block runs only when the
  // condition holds. The suite only calls n = 2; the `'!'` on the moved line
  // is killed. Real code: re-indentation is covered by no sibling site.
  // Mutant: a site on the re-indented line covers it (the SG34 rule, which
  // CLAUDE.md still states).
  'BI-insideind': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: 'if (!depth.get(a) && !fresh(a, le)) push(false);', to: 'if (!depth.get(a) && !fresh(a, le)) push(spans.some(x => a <= x.s && x.e <= le));' },
    tests: /bug-injector|executor/,
    cur: "def f(t, n):\n    if n > 1:\n        t = t[:9]\n    t = t.strip()\n    return t\n",
    prop: "def f(t, n):\n    if n > 1:\n        t = t[:9]\n        t = t.strip() + '!'\n    return t\n",
    test: "def test_f():\n    assert m.f(' ab ', 2) == 'ab!'\n    assert m.f(' c', 3) == 'c!'\n",
    diff_test: EQUIV
  },
  // SG38 duplicate test names: two tests named 'x'. The first catches the
  // module's load throw on purpose; the second hits it too and fails (its
  // wrapper rethrows, so the TAP stack shows no load frame). The 4 -> 5
  // mutant makes the module throw at load: a load failure, never a kill.
  // Nothing asserts the value. Real code: the logged name 'x' maps to 'x'
  // and 'x#2', one failed, not excused. Mutant: one passing 'x' excuses it.
  'TR-dupname': {
    finding: 'H3',
    mutate: { file: TR, from: "ids.every(id => tests[id] === 'pass')", to: "ids.some(id => tests[id] === 'pass')" },
    tests: /test-runner|executor/,
    file: 'src/m.js',
    cur: 'const N = 3;',
    prop: 'const N = 4;',
    rest: "if (N === 5) throw new RangeError('N out of range');\nfunction f() { return N; }\nmodule.exports = { f };",
    test: T("test('x', () => { try { require('../src/m'); } catch { /* optional */ } });\ntest('x', () => {\n  let m;\n  try { m = require('../src/m'); } catch (e) { throw new Error('setup: ' + e.message); }\n  m.f();\n});"),
    diff_test: EQUIV
  }
};

function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit30-rep-'));
  if (c.lang === 'py') {
    fs.writeFileSync(path.join(repo, 'pytest.ini'), '[pytest]\n');
    fs.mkdirSync(path.join(repo, 'app'));
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'app/__init__.py'), '');
    fs.writeFileSync(path.join(repo, 'app/m.py'), c.cur);
    fs.writeFileSync(path.join(repo, 'tests/test_m.py'), `import app.m as m\n\n\n${c.test}`);
    return repo;
  }
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'a30', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, c.file), `'use strict';\n${c.cur}\n${c.rest}\n`);
  fs.writeFileSync(path.join(repo, 'test/a.test.js'), c.test);
  return repo;
}

function copyTree(c, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit30-src-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (withTests) {
    fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  }
  const f = path.join(dir, c.mutate.file);
  const text = fs.readFileSync(f, 'utf8');
  if (text.split(c.mutate.from).length !== 2) throw new Error(`mutant pattern not found once in ${c.mutate.file}`);
  fs.writeFileSync(f, text.replace(c.mutate.from, () => c.mutate.to));
  return dir;
}

function execIn(srcRoot, c) {
  const repo = makeRepo(c);
  const file = c.lang === 'py' ? 'app/m.py' : c.file;
  const code = `
    const { runExecutor } = require(${JSON.stringify(path.join(srcRoot, 'src/agents/executor.js'))});
    const proposal = { issue_id: 'a30', file: ${JSON.stringify(file)}, current_code: ${JSON.stringify(c.cur)}, proposed_code: ${JSON.stringify(c.prop)}, diff_test: ${JSON.stringify(c.diff_test || null)} };
    runExecutor({ proposal, repoRoot: ${JSON.stringify(repo)}, onKept: () => 'commit' }).then(r => {
      const m = r.mutation || {};
      console.log(JSON.stringify({ status: r.status, reason: r.reason || null, commit: r.commit || null, sites: m.sites, killed: m.killed || null, killed_test: m.killed_test || null, uncovered_token: m.uncovered_token || null, collection_errors: m.collection_errors || null }));
    });`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 300_000 });
  fs.rmSync(repo, { recursive: true, force: true });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(-500) }; }
}

function testsKill(c) {
  const dir = copyTree(c, true);
  try {
    const files = fs.readdirSync(path.join(dir, 'test')).filter(f => f.endsWith('.test.js') && c.tests.test(f)).map(f => path.join('test', f));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20 });
    const n = (k) => ((r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1];
    return { killed: r.status !== 0, summary: `${files.join(' ')}: pass=${n('pass')} fail=${n('fail')}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hasPy = () => spawnSync('python3', ['-c', 'import pytest, coverage'], { stdio: 'ignore' }).status === 0;

function main() {
  const args = process.argv.slice(2);
  const noTests = args.includes('--no-tests');
  const picked = args.filter(a => !a.startsWith('--'));
  const ids = picked.length ? picked : Object.keys(CASES);
  let findings = 0;
  for (const id of ids) {
    const c = CASES[id];
    if (!c) { console.log(`unknown case ${id}`); continue; }
    if (c.lang === 'py' && !hasPy()) { console.log(`skip ${id}: pytest + coverage.py not installed`); continue; }
    const real = execIn(ROOT, c);
    console.log(`[${id}] real code:    ${JSON.stringify(real)}`);
    if (real.status !== 'reverted') { console.log(`FINDING ${c.finding} ${id}: the real executor keeps an edit the suite cannot judge`); findings++; continue; }
    const dir = copyTree(c, false);
    let mut;
    try { mut = execIn(dir, c); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`[${id}] mutated copy: ${JSON.stringify(mut)}`);
    if (mut.status !== 'passed') { console.log(`ok ${id}: the mutated copy also reverts`); continue; }
    if (noTests) { console.log(`load-bearing ${id}: the mutated copy commits (tests not run)`); continue; }
    const k = testsKill(c);
    console.log(`[${id}] tests on the mutated copy: ${k.summary}`);
    if (!k.killed) { console.log(`FINDING ${c.finding} ${id}: rule is load-bearing (mutated copy commits) and the tests stay green with it`); findings++; } else console.log(`ok ${id}: a test kills the mutant`);
  }
  process.exitCode = findings ? 1 : 0;
}

main();
