'use strict';

// AUDIT-34: surviving SG41 / SG42 safety mutants, shown to be load-bearing.
// For each case the real executor reverts an edit the suite cannot judge;
// with the mutant applied to a temp copy of src/ the same edit is committed.
// The test files that name the mutated module are then run on the mutated
// copy: if they stay green, nothing pins the rule (full suite:
// `node audit/11/mutants.js <id>`).
//
//   node audit/34/unpinned.js [BI-kwfor] ...      # default: every case
//   node audit/34/unpinned.js --no-tests ...      # executor verdicts only
//
// Cases pass the gate's diff-test result the executor sees (`equivalent`,
// deletions observed), as test/executor.test.js does: the executor bar exists
// for the diff test's blind spots. Each case's test file asserts the
// proposed code's values on the inputs it uses; the edit changes behaviour
// on inputs it does not use. Python cases need pytest + coverage.py.
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
// Re-anchored after SG45 (any deleted keyword is a swap).
const KW = 'g.del.some(([s, e]) => KEYWORDS[lang].has(before.slice(s, e))';

const CASES = {
  // SG42 swapped block keyword: `for (; n > 0;)` -> `if (n > 0)` runs the
  // body once instead of n times. The suite only calls n = 0 and n = 1; the
  // `if`'s own negate_condition kill (n = 1) shows the condition matters,
  // not the loop. Mutant: `for` is not a block keyword, so the `if` that
  // replaced it stands on its condition site.
  'BI-kwfor': {
    finding: 'H1',
    mutate: { file: BI, from: KW, to: 'g.del.some(([s, e]) => /^(?:if|elif|else|while|do|with|switch|try|match|async)$/.test(before.slice(s, e))' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(t, n) {\n  for (; n > 0;) { n--; t += 1; }\n  return t;\n}',
    prop: 'function f(t, n) {\n  if (n > 0) { n--; t += 1; }\n  return t;\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(0, 1), 1); assert.strictEqual(f(5, 0), 5); });"),
    diff_test: EQUIV
  },
  // SG42: `else:` -> `elif n:` drops the branch for n = 0. The suite calls
  // n = 6, 1, -1; the `elif`'s negate_condition (n = 1) and the use site of
  // `n` (n + 1 at n = -1) are killed. Mutant: `else` is not a block keyword.
  'BI-kwelse': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: KW, to: 'g.del.some(([s, e]) => /^(?:if|elif|while|for|do|with|switch|try|match|async)$/.test(before.slice(s, e))' },
    tests: /bug-injector|executor/,
    cur: "def f(t, n):\n    if n > 5:\n        t = t[:5]\n    else:\n        t = t + '!'\n    return t\n",
    prop: "def f(t, n):\n    if n > 5:\n        t = t[:5]\n    elif n:\n        t = t + '!'\n    return t\n",
    test: "def test_f():\n    assert m.f('abcdefg', 6) == 'abcde'\n    assert m.f('a', 1) == 'a!'\n    assert m.f('b', -1) == 'b!'\n",
    diff_test: EQUIV
  },
  // SG41 Python `;` on a `try` / `except` / `finally` line joins its suite:
  // `t = t + 2` now runs only on ValueError. The suite only passes
  // non-numbers; the `2` is killed. Mutant: try / except / finally lines
  // are not compound-statement heads.
  'BI-pytry': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: '|with|try|except|finally|def|', to: '|with|def|' },
    tests: /bug-injector|executor/,
    cur: 'def f(t):\n    try: t = int(t)\n    except ValueError: t = 0\n    t = t + 1\n    return t\n',
    prop: 'def f(t):\n    try: t = int(t)\n    except ValueError: t = 0; t = t + 2\n    return t\n',
    test: "def test_f():\n    assert m.f('x') == 2\n    assert m.f('y') == 2\n",
    diff_test: EQUIV
  },
  // SG41 Python `;` on an `async for` line: the next statement moves into
  // the loop. The suite only passes one-element iterables. Mutant: `async`
  // lines are not compound-statement heads.
  'BI-pyasync': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: '|class|async|case(?!', to: '|class|case(?!' },
    tests: /bug-injector|executor/,
    cur: 'async def g(t, xs):\n    async for x in xs: t += x\n    t = t + 1\n    return t\n',
    prop: 'async def g(t, xs):\n    async for x in xs: t += x; t = t + 2\n    return t\n',
    test: 'import asyncio\n\n\nasync def it(*xs):\n    for x in xs:\n        yield x\n\n\ndef test_g():\n    assert asyncio.run(m.g(0, it(1))) == 3\n    assert asyncio.run(m.g(5, it(2))) == 9\n',
    diff_test: EQUIV
  },
  // SG41 Python `;` on a `case` clause line: `t = t + 2` runs only for
  // n == 1. The suite only calls n = 1. Mutant: `case` lines are exempt.
  'BI-pycase': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: '|async|case(?!', to: '|async|(?!)case(?!' },
    tests: /bug-injector|executor/,
    cur: 'def f(t, n):\n    match n:\n        case 1: t = t * 3\n    t = t + 1\n    return t\n',
    prop: 'def f(t, n):\n    match n:\n        case 1: t = t * 3; t = t + 2\n    return t\n',
    test: 'def test_f():\n    assert m.f(1, 1) == 5\n    assert m.f(2, 1) == 8\n',
    diff_test: EQUIV
  },
  // SG41 operand-splitting comma, Python: `max(n - 1, 0)` -> `max(n, - 1, 2)`
  // makes `n` its own argument. The suite only calls n = 0, 1; the `2` is
  // killed. Mutant: the Python branch skips `splits` (JS keeps it).
  'BI-pysplits': {
    finding: 'H2',
    lang: 'py',
    mutate: { file: BI, from: '    if (splits(a)) return true;\n', to: '' },
    tests: /bug-injector|executor/,
    cur: 'def f(s, n):\n    return max(n - 1, 0)\n',
    prop: 'def f(s, n):\n    return max(n, - 1, 2)\n',
    test: "def test_f():\n    assert m.f('', 0) == 2\n    assert m.f('', 1) == 2\n",
    diff_test: EQUIV
  },
  // SG38/SG41 every test of a logged name must pass: two tests named 'x'.
  // The first hits the module's load throw and fails (its wrapper rethrows,
  // so the TAP stack shows no load frame); the second catches the throw on
  // purpose. The 4 -> 5 mutant makes the module throw at load: a load
  // failure, never a kill. Mutant: the last test of the name decides
  // (AUDIT-30's TR-dupname case has the passing one first, so it misses this).
  'TR-lastwins': {
    finding: 'H3',
    mutate: { file: TR, from: "byName.set(k, byName.get(k) !== false && state === 'pass')", to: "byName.set(k, state === 'pass')" },
    tests: /test-runner|executor/,
    file: 'src/m.js',
    cur: 'const N = 3;',
    prop: 'const N = 4;',
    rest: "if (N === 5) throw new RangeError('N out of range');\nfunction f() { return N; }\nmodule.exports = { f };",
    test: T("test('x', () => {\n  let m;\n  try { m = require('../src/m'); } catch (e) { throw new Error('setup: ' + e.message); }\n  m.f();\n});\ntest('x', () => { try { require('../src/m'); } catch { /* optional */ } });"),
    diff_test: EQUIV
  }
};

function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit34-rep-'));
  if (c.lang === 'py') {
    fs.writeFileSync(path.join(repo, 'pytest.ini'), '[pytest]\n');
    fs.mkdirSync(path.join(repo, 'app'));
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'app/__init__.py'), '');
    fs.writeFileSync(path.join(repo, 'app/m.py'), c.cur);
    fs.writeFileSync(path.join(repo, 'tests/test_m.py'), `import app.m as m\n\n\n${c.test}`);
    return repo;
  }
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'a34', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, c.file), `'use strict';\n${c.cur}\n${c.rest}\n`);
  fs.writeFileSync(path.join(repo, 'test/a.test.js'), c.test);
  return repo;
}

function copyTree(c, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit34-src-'));
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
    const proposal = { issue_id: 'a34', file: ${JSON.stringify(file)}, current_code: ${JSON.stringify(c.cur)}, proposed_code: ${JSON.stringify(c.prop)}, diff_test: ${JSON.stringify(c.diff_test || null)} };
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
