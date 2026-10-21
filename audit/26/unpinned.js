'use strict';

// AUDIT-26: surviving SG27-SG34 safety mutants, shown to be load-bearing.
// For each case the real executor reverts an edit the suite cannot judge;
// with the mutant applied to a temp copy of src/ the same edit is committed.
// The test files that name the mutated module are then run on the mutated
// copy: if they stay green, nothing pins the rule (full suite:
// `node audit/11/mutants.js <id>`).
//
//   node audit/26/unpinned.js [BI-applied] ...
//
// Cases pass the gate's diff-test result the executor sees
// (`equivalent`, deletions observed), as test/executor.test.js does: the
// executor bar exists for the diff test's blind spots.
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

const CASES = {
  // `g(a) + b` -> `h(g(a + b))`: the closing parenthesis of g moves past
  // `+ b` (the operand's scope widens). The suite only calls f(x, 0), so
  // nothing tells g(a + b) from g(a) + b. The moved `)` frames kept code and
  // needs a site inside g's parentheses or g's own call; the only kill is
  // the new wrapper h's use site. Mutant: any enclosing use site covers it.
  'BI-applied': {
    finding: 'H1',
    mutate: { file: 'src/rl/bug-injector.js', from: '(x.use >= 0 ? x.e === c + 1 :', to: '(x.use >= 0 ? x.e >= c + 1 :' },
    tests: /executor|bug-injector/,
    file: 'src/f.js',
    pre: 'function g(x) { return x * 2; }\nfunction h(x) { return x + 1; }',
    cur: 'function f(a, b) {\n  return g(a) + b;\n}',
    prop: 'function f(a, b) {\n  return h(g(a + b));\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(1, 0), 3); assert.strictEqual(f(4, 0), 9); });"),
    diff_test: EQUIV
  },
  // `g(a) + b` -> `~g(a + b)`: as above, with a new prefix `~` in front of
  // the call instead of a wrapper. The `~` site is killed; it is applied to
  // `g(...)`, not to g's parentheses. Mutant: a prefix site anywhere before
  // the pair covers it.
  'BI-prefix': {
    finding: 'H2',
    mutate: { file: 'src/rl/bug-injector.js', from: 'x.prefix && x.e <= o && !src.slice(x.e, o).trim()', to: 'x.prefix' },
    tests: /executor|bug-injector/,
    file: 'src/f.js',
    pre: 'function g(x) { return x * 2; }',
    cur: 'function f(a, b) {\n  return g(a) + b;\n}',
    prop: 'function f(a, b) {\n  return ~g(a + b);\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(1, 0), -3); assert.strictEqual(f(4, 0), -9); });"),
    diff_test: EQUIV
  },
  // `x * 1000n` -> `x * 2000n` next to a tested `1` -> `2`. The suite only
  // calls f(0n). Mutant: every BigInt literal compares as NaN, so 2000n is
  // no change and the hunk stands on the kill of `2`.
  'HK-bigint': {
    finding: 'H3',
    mutate: { file: 'src/utils/hunks.js', from: '/n$/.test(n) ? `\\u0005${BigInt(n.slice(0, -1))}n` : ', to: '' },
    tests: /executor|bug-injector|hunks/,
    file: 'src/f.js',
    cur: 'function f(x) {\n  return [x * 1000n, 1];\n}',
    prop: 'function f(x) {\n  return [x * 2000n, 2];\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.deepStrictEqual(f(0n), [0n, 2]); });"),
    diff_test: EQUIV
  },
  // An inserted `;` ends an expression statement that ASI continued:
  // `const v = a\n(b)` calls a(b); with `;` v is a. `;` is exempt from the
  // fail-closed rule and has no site, so the hunk is bare and the edit has
  // no mutant at all. Mutant: a bare hunk no longer blocks (no site to
  // judge = every site judged).
  'EX-bare': {
    finding: 'H4',
    mutate: { file: 'src/agents/executor.js', from: '  const bare = hunks.findIndex((h, i) => !h.deletion && !mutants.some(m => m.hunk === i));', to: '  const bare = -1;' },
    tests: /executor|bug-injector/,
    file: 'src/t.js',
    cur: 'function t(a, b) {\n  const v = a\n  (b)\n  return v;\n}',
    prop: 'function t(a, b) {\n  const v = a;\n  (b)\n  return v;\n}',
    rest: 'module.exports = { t };',
    test: T("const { t } = require('../src/t');\ntest('t', () => { assert.strictEqual(t(5, 1), 5); });"),
    diff_test: EQUIV
  },
  // Sloppy-mode file: `x * 10` -> `x * 010` (8). Mutant: a legacy octal
  // compares by its decimal reading, so 010 is no change.
  'HK-octal': {
    finding: 'H3',
    mutate: { file: 'src/utils/hunks.js', from: ' : /^0\\d/.test(n) ? t : ', to: ' : ' },
    tests: /executor|bug-injector|hunks/,
    sloppy: true,
    file: 'src/f.js',
    cur: 'function f(x) {\n  return [x * 10, 1];\n}',
    prop: 'function f(x) {\n  return [x * 010, 2];\n}',
    rest: 'module.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.deepStrictEqual(f(0), [0, 2]); });"),
    diff_test: EQUIV
  }
};

function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit26-rep-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'a26', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, c.file), `${c.sloppy ? '' : "'use strict';\n"}${c.pre ? `${c.pre}\n` : ''}${c.cur}\n${c.rest}\n`);
  fs.writeFileSync(path.join(repo, 'test/a.test.js'), c.test);
  return repo;
}

function copyTree(c, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit26-src-'));
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
  const code = `
    const { runExecutor } = require(${JSON.stringify(path.join(srcRoot, 'src/agents/executor.js'))});
    const proposal = { issue_id: 'a26', file: ${JSON.stringify(c.file)}, current_code: ${JSON.stringify(c.cur)}, proposed_code: ${JSON.stringify(c.prop)}, diff_test: ${JSON.stringify(c.diff_test || null)} };
    runExecutor({ proposal, repoRoot: ${JSON.stringify(repo)}, onKept: () => 'commit' }).then(r => {
      const m = r.mutation || {};
      console.log(JSON.stringify({ status: r.status, reason: r.reason || null, commit: r.commit || null, sites: m.sites, killed: m.killed || null, uncovered_token: m.uncovered_token || null }));
    });`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env, timeout: 180_000 });
  fs.rmSync(repo, { recursive: true, force: true });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(-500) }; }
}

function testsKill(c) {
  const dir = copyTree(c, true);
  try {
    const files = fs.readdirSync(path.join(dir, 'test')).filter(f => f.endsWith('.test.js') && c.tests.test(f)).map(f => path.join('test', f));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 });
    const n = (k) => ((r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1];
    return { killed: r.status !== 0, summary: `${files.join(' ')}: pass=${n('pass')} fail=${n('fail')}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
  let findings = 0;
  for (const id of ids) {
    const c = CASES[id];
    if (!c) { console.log(`unknown case ${id}`); continue; }
    const real = execIn(ROOT, c);
    console.log(`[${id}] real code:    ${JSON.stringify(real)}`);
    if (real.status !== 'reverted') { console.log(`FINDING ${c.finding} ${id}: the real executor keeps an edit the suite cannot judge`); findings++; continue; }
    const dir = copyTree(c, false);
    let mut;
    try { mut = execIn(dir, c); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`[${id}] mutated copy: ${JSON.stringify(mut)}`);
    if (mut.status !== 'passed') { console.log(`ok ${id}: the mutated copy also reverts`); continue; }
    const k = testsKill(c);
    console.log(`[${id}] tests on the mutated copy: ${k.summary}`);
    if (!k.killed) { console.log(`FINDING ${c.finding} ${id}: rule is load-bearing (mutated copy commits) and the tests stay green with it`); findings++; } else console.log(`ok ${id}: a test kills the mutant`);
  }
  process.exitCode = findings ? 1 : 0;
}

main();
