'use strict';

// AUDIT-38: surviving SG44 / SG45 safety mutants, shown to be load-bearing.
// For each case the real code gives the safe outcome (the executor reverts
// an edit the suite cannot judge, or runTests / loadFailed reports a load
// failure); with the mutant applied to a temp copy of src/ the unsafe one
// (a commit, or a load failure excused so its run can count as a kill).
// The test files that name the mutated module then run on the mutated copy:
// if they stay green, nothing pins the rule (full suite:
// `node audit/11/mutants.js <id>`).
//
//   node audit/38/unpinned.js [BI-tuplesub] ...   # default: every case
//   node audit/38/unpinned.js --no-tests ...      # verdicts only
//
// Executor cases pass the gate's diff-test result the executor sees
// (`equivalent`, deletions observed), as test/executor.test.js does: the
// executor bar exists for the diff test's blind spots. Each case's test file
// asserts the proposed code's values on the inputs it uses; the edit changes
// behaviour on inputs it does not use. Python cases need pytest + coverage.py.
//
// Prints FINDING (exit 1) when the real code is unsafe, or when the mutated
// copy is unsafe and the named test files stay green; ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const T = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const EQUIV = { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: true, duration_ms: 1 };
const BI = 'src/rl/bug-injector.js';
const TR = 'src/runner/test-runner.js';
const TUPLE_RET = "    return code[o] === '(' ? !pyApplied(o) : code[o] === '[' ? pyApplied(o) : fields.has(o);";

// runTests probe: a temp node:test repo; `files` written, the run made with
// SG38_BAD=1 (src/m.mjs throws while loading). -> { status, collection_error }.
const runTestsProbe = (files) => (srcRoot) => `
  const fs = require('fs'), os = require('os'), path = require('path');
  const { runTests } = require(${JSON.stringify(path.join(srcRoot, TR))});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit38-rt-'));
  const files = ${JSON.stringify(files)};
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
  const out = {};
  (async () => {
    for (const bad of [false, true]) {
      if (bad) process.env.SG38_BAD = '1'; else delete process.env.SG38_BAD;
      const r = await runTests({ repoRoot: dir });
      out[bad ? 'bad' : 'clean'] = { status: r.status, collection_error: r.collection_error || false, tests: r.tests };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(JSON.stringify(out));
  })();`;
const PKG = JSON.stringify({ name: 'a38', version: '0.0.0', private: true, scripts: { test: 'node --test' } });
const MJS = "if (process.env.SG38_BAD) throw new Error('bad');\nexport const show = (s) => s;\n";
const CLI_MJS = "let m;\ntry { m = await import('../src/m.mjs'); } catch (e) { console.log('error: ' + e.message); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n";
const CJS = "'use strict';\nif (process.env.SG38_BAD) throw new Error('bad');\nmodule.exports = { show: (s) => s };\n";
const CLI_CJS = "'use strict';\nlet m;\ntry { m = require('../src/m.js'); } catch (e) { console.log('error: ' + e.message); process.exit(0); }\nconsole.log(m.show(process.argv[2]));\n";
const NO_CTX = '(() => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; })()';
const cliTest = (envExpr, cli = 'cli.mjs') => T(`test('cli', () => {\n  const env = ${envExpr};\n  const r = require('child_process').spawnSync(process.execPath, [require('path').join(__dirname, '../bin/${cli}'), 'ab'], { encoding: 'utf8', env });\n  assert.strictEqual(r.stdout, 'ab\\n');\n});`);
// The run fails (the CLI prints the error). Safe: it is a collection error,
// so it is never a kill. Excused: a mutant run of a module that cannot load
// would count as a kill.
const excused = (r) => !!(r && r.bad && r.bad.status === 'failed' && r.bad.collection_error === false);

const CASES = {
  // SG44 Python comma making a tuple key of a kept subscript: `d[n]` ->
  // `d[n, t]` looks up `(n, t)`. The suite passes a dict keyed by pairs; the
  // use site of `t` is killed. Mutant: a subscript is never tuple-making.
  'BI-tuplesub': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: TUPLE_RET, to: "    return code[o] === '(' ? !pyApplied(o) : code[o] === '[' ? false : fields.has(o);" },
    tests: /bug-injector|executor/,
    cur: 'def f(d, n, t):\n    return d[n]\n',
    prop: 'def f(d, n, t):\n    return d[n, t]\n',
    test: "def test_f():\n    assert m.f({(1, 2): 'a', (1, 3): 'b'}, 1, 2) == 'a'\n",
    diff_test: EQUIV
  },
  // SG44 `beside`: kept code on EITHER side. `return (s)` -> `return (t, s)`
  // makes a tuple of kept `s` whose kept neighbour is on the right only.
  // Mutant: `beside` looks left only.
  'BI-besideleft': {
    finding: 'H1',
    lang: 'py',
    mutate: { file: BI, from: 'const beside = (a) => !!(reach(a, -1) || reach(a, 1));', to: 'const beside = (a) => !!reach(a, -1);' },
    tests: /bug-injector|executor/,
    cur: 'def f(s, t):\n    return (s)\n',
    prop: 'def f(s, t):\n    return (t, s)\n',
    test: "def test_f():\n    assert m.f('a', 'b') == ('b', 'a')\n",
    diff_test: EQUIV
  },
  // SG44 array elision: a leading hole `[, s]` shifts `s` to index 1. The
  // suite asserts the proposed array; `''` and `+` are killed. Mutant: only
  // holes next to a comma count.
  'BI-elisionlead': {
    finding: 'H1',
    mutate: { file: BI, from: "[code[prevCode(a)], code[nextCode(a + 1)]].includes(',') || code[prevCode(a)] === '['))", to: "[code[prevCode(a)], code[nextCode(a + 1)]].includes(',')))" },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(s) {\n  return [s];\n}',
    prop: "function f(s) {\n  return [, s + ''];\n}",
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.deepStrictEqual(f('a'), [, 'a']); });"),
    diff_test: EQUIV
  },
  // SG45 any deleted keyword: `delete o.k` -> `if (n) o.k = 0` keeps the key
  // (and only for truthy n). The suite passes n = true; the `if`'s own
  // negate_condition, the use of `n` and the `0` are killed. Mutant: only
  // block-statement keywords count as replaced.
  'BI-kwblock': {
    finding: 'H3',
    mutate: { file: BI, from: 'g.del.some(([s, e]) => KEYWORDS[lang].has(before.slice(s, e))', to: 'g.del.some(([s, e]) => /^(?:if|elif|else|while|for|do|with|switch|try|match|async)$/.test(before.slice(s, e))' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(o, n) {\n  delete o.k;\n  return o;\n}',
    prop: 'function f(o, n) {\n  if (n) o.k = 0;\n  return o;\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.deepStrictEqual(f({ k: 1 }, true), { k: 0 }); });"),
    diff_test: EQUIV
  },
  // SG45 spawned-child rule, ES module arm: a test spawns an ESM CLI that
  // catches the failed import() and exits 0. Real: the child's key never
  // passes (C row, parent no runner) -> collection error. Mutant: the ESM
  // exit handler logs no C row, so the child's exit-0 P row excuses it.
  'TR-esmcrow': {
    finding: 'H4',
    mutate: { file: TR, from: "    if (esm.size && !seen && file) log('C\\\\t' + key + '\\\\t' + process.ppid);\n", to: '' },
    tests: /test-runner|executor/,
    probe: runTestsProbe({ 'package.json': PKG, 'src/m.mjs': MJS, 'bin/cli.mjs': CLI_MJS, 'test/cli.test.js': cliTest('process.env') }),
    unsafe: excused
  },
  // SG45: only a node:test file process (NODE_TEST_CONTEXT) logs P. A test
  // that spawns the ESM CLI with NODE_TEST_CONTEXT removed from the env (a
  // common pattern) gets a child that is neither a file process nor marked
  // spawned. Real: no P -> collection error. Mutant: the ESM exit handler
  // logs P on exit 0 without the file-process check.
  'TR-esmpfile': {
    finding: 'H4',
    mutate: { file: TR, from: "    if (esm.size && file && code === 0) log('P\\\\t' + key);", to: "    if (esm.size && code === 0) log('P\\\\t' + key);" },
    tests: /test-runner|executor/,
    probe: runTestsProbe({ 'package.json': PKG, 'src/m.mjs': MJS, 'bin/cli.mjs': CLI_MJS, 'test/cli.test.js': cliTest(NO_CTX) }),
    unsafe: excused
  },
  // SG45, CJS arm of the same rule: the env-stripped child catches a failed
  // require() and exits 0. Mutant: the CJS exit handler logs P without the
  // file-process check.
  'TR-cjspfile': {
    finding: 'H4',
    mutate: { file: TR, from: "    if (!seen && file) process.on('exit', (code) => { if (code === 0) log('P\\\\t' + key); });", to: "    if (!seen) process.on('exit', (code) => { if (code === 0) log('P\\\\t' + key); });" },
    tests: /test-runner|executor/,
    probe: runTestsProbe({ 'package.json': PKG, 'src/m.js': CJS, 'bin/cli.js': CLI_CJS, 'test/cli.test.js': cliTest(NO_CTX, 'cli.js') }),
    unsafe: excused
  },
  // SG44 reach() returns the inserted bracket of a pair that holds kept code:
  // `6000 - 1` -> `Number(6000), - 1` splits the kept operand. The call's
  // use site (value + 1) is killed and covers its brackets. Mutant: reach()
  // skips any inserted pair, so the comma sees `Number` and then `,`.
  'BI-reachpair': {
    finding: 'H1',
    mutate: { file: BI, from: '        if (p === undefined || !fresh(Math.min(i, p), Math.max(i, p) + 1)) return { i, nl };', to: '        if (p === undefined) return { i, nl };' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(s) {\n  return s.slice(0, 6000 - 1);\n}',
    prop: 'function f(s) {\n  return s.slice(0, Number(6000), - 1);\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f('x'.repeat(7000)).length, 6000); });"),
    diff_test: EQUIV
  },
  // SG44 ASI-aware semiReach: a line starting `in` / `instanceof` continues
  // the expression. `const ok = k\n in o` -> `const ok = k; log(k)\n in o`
  // cuts `in o` off `ok`. The suite checks the proposed value and the log;
  // the use site of `k` is killed. Mutant: an `in` line reads as a new
  // statement, so the `;` has no kept operand on its right.
  'BI-semiinst': {
    finding: 'H2',
    mutate: { file: BI, from: '/^(?:(?!(?:in|instanceof)\\b)[\\w$]|\\+\\+|--)/', to: '/^(?:[\\w$]|\\+\\+|--)/' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(k, o) {\n  const ok = k\n    in o;\n  return ok;\n}',
    prop: 'function f(k, o) {\n  const ok = k; log(k)\n    in o;\n  return ok;\n}',
    rest: 'const seen = [];\nfunction log(x) { seen.push(x); }\nmodule.exports = { f, seen };',
    test: T("const { f, seen } = require('../src/f');\ntest('f', () => { assert.strictEqual(f('a', { a: 1 }), 'a'); assert.deepStrictEqual(seen, ['a']); });"),
    diff_test: EQUIV
  },
  // SG44 semiReach: a `}` closing an object literal is an operand.
  // `o = { n: s }.n + 1` -> `o = { n: s }; log(t).n + 1` makes `o` the
  // object. The suite checks the proposed value and the log; the use site
  // of `t` is killed. Mutant: every `}` before a `;` reads as a block end.
  'BI-semiobj': {
    finding: 'H2',
    mutate: { file: BI, from: "      if (h < 0 || ')};{'.includes(code[h]) || /(?:=>|(?<![\\w$])(?:else|try|finally|do))$/.test(code.slice(Math.max(0, h - 8), h + 1))) return null;", to: '      return null;' },
    tests: /bug-injector|executor/,
    file: 'src/f.js',
    cur: 'function f(s, t) {\n  const o = { n: s }.n + 1;\n  return o;\n}',
    prop: 'function f(s, t) {\n  const o = { n: s }; log(t).n + 1;\n  return o;\n}',
    rest: 'const seen = [];\nfunction log(x) { seen.push(x); return { n: 0 }; }\nmodule.exports = { f, seen };',
    test: T("const { f, seen } = require('../src/f');\ntest('f', () => { assert.deepStrictEqual(f('a', 'b'), { n: 'a' }); assert.deepStrictEqual(seen, ['b']); });"),
    diff_test: EQUIV
  },
  // SG44 duplicate ids `<name>\t#<n>` indexed under `<name>` (`s` flag): a
  // logged name holding U+2028. Two tests of that name, the second fails:
  // real -> load failure; mutant (no `s` flag) -> the failing duplicate is
  // not indexed under the name, the passing first one excuses the throw.
  'TR-dupdotall': {
    finding: 'H5',
    mutate: { file: TR, from: 'const m = /^(.*)\\t#\\d+$/s.exec(id);', to: 'const m = /^(.*)\\t#\\d+$/.exec(id);' },
    tests: /test-runner|executor/,
    probe: (srcRoot) => `
      const fs = require('fs'), os = require('os'), path = require('path');
      const { loadFailed } = require(${JSON.stringify(path.join(srcRoot, TR))});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit38-lf-'));
      const name = 'a' + String.fromCharCode(0x2028) + 'b', log = path.join(dir, 'load.log');
      fs.writeFileSync(log, 'T\\t1.2\\t' + path.join(dir, 'src/m.js') + '\\t' + JSON.stringify(name) + '\\n');
      const failed = loadFailed(log, dir, { [name]: 'pass', [name + '\\t#2']: 'fail' });
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(JSON.stringify({ load_failed: failed }));`,
    unsafe: (r) => r && r.load_failed === false
  }
};

function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit38-rep-'));
  if (c.lang === 'py') {
    fs.writeFileSync(path.join(repo, 'pytest.ini'), '[pytest]\n');
    fs.mkdirSync(path.join(repo, 'app'));
    fs.mkdirSync(path.join(repo, 'tests'));
    fs.writeFileSync(path.join(repo, 'app/__init__.py'), '');
    fs.writeFileSync(path.join(repo, 'app/m.py'), c.cur);
    fs.writeFileSync(path.join(repo, 'tests/test_m.py'), `import app.m as m\n\n\n${c.test}`);
    return repo;
  }
  fs.writeFileSync(path.join(repo, 'package.json'), PKG);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, c.file), `'use strict';\n${c.cur}\n${c.rest}\n`);
  fs.writeFileSync(path.join(repo, 'test/a.test.js'), c.test);
  return repo;
}

function copyTree(c, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit38-src-'));
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

function runNode(code) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 300_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout || '').slice(-500) }; }
}

function execIn(srcRoot, c) {
  if (c.probe) return runNode(c.probe(srcRoot));
  const repo = makeRepo(c);
  const file = c.lang === 'py' ? 'app/m.py' : c.file;
  const code = `
    const { runExecutor } = require(${JSON.stringify(path.join(srcRoot, 'src/agents/executor.js'))});
    const proposal = { issue_id: 'a38', file: ${JSON.stringify(file)}, current_code: ${JSON.stringify(c.cur)}, proposed_code: ${JSON.stringify(c.prop)}, diff_test: ${JSON.stringify(c.diff_test || null)} };
    runExecutor({ proposal, repoRoot: ${JSON.stringify(repo)}, onKept: () => 'commit' }).then(r => {
      const m = r.mutation || {};
      console.log(JSON.stringify({ status: r.status, reason: r.reason || null, commit: r.commit || null, sites: m.sites, killed: m.killed || null, killed_test: m.killed_test || null, uncovered_token: m.uncovered_token || null, collection_errors: m.collection_errors || null }));
    });`;
  try { return runNode(code); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

const unsafe = (c, r) => c.unsafe ? c.unsafe(r) : r.status === 'passed';
const safe = (c, r) => c.unsafe ? !r.error && !c.unsafe(r) : r.status === 'reverted';

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
    if (!safe(c, real)) { console.log(`FINDING ${c.finding} ${id}: the real code is not safe on this case`); findings++; continue; }
    const dir = copyTree(c, false);
    let mut;
    try { mut = execIn(dir, c); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`[${id}] mutated copy: ${JSON.stringify(mut)}`);
    if (!unsafe(c, mut)) { console.log(`ok ${id}: the mutated copy is also safe`); continue; }
    if (noTests) { console.log(`load-bearing ${id}: the mutated copy is unsafe (tests not run)`); continue; }
    const k = testsKill(c);
    console.log(`[${id}] tests on the mutated copy: ${k.summary}`);
    if (!k.killed) { console.log(`FINDING ${c.finding} ${id}: rule is load-bearing (mutated copy unsafe) and the tests stay green with it`); findings++; } else console.log(`ok ${id}: a test kills the mutant`);
  }
  process.exitCode = findings ? 1 : 0;
}

main();
