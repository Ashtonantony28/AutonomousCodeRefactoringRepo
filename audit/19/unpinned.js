'use strict';

// AUDIT-19: surviving safety mutants of SG26 evidence rules, shown to be
// load-bearing. For each case the real executor reverts an edit the suite
// cannot judge (tests_insensitive); with the mutant applied to a temp copy of
// src/ the same edit is committed. The test files that name the mutated
// module are then run on the mutated copy: if they stay green, nothing pins
// the rule (the full suite: `node audit/11/mutants.js <id>`).
//
//   node audit/19/unpinned.js [EX-sitekey] [BI-default]
//
// H1 EX-sitekey: `s.trim()` -> `s.trimStart()`; the suite never feeds
//    trailing whitespace. Skipping the call is caught, putting `trim` back
//    (revert_reference) is not. Mutant: revert keyed to the use site.
// H2 BI-default: a new default `k = LIMIT` in the same hunk as a tested
//    literal; no test calls f without k. Mutant: a reference inside a
//    default value is not a use.
//
// Prints FINDING (exit 1) when the real code commits, or when the mutated
// copy commits and the named test files stay green; ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const T = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;

const CASES = {
  'EX-sitekey': {
    finding: 'H1',
    mutate: { file: 'src/agents/executor.js', from: 'const siteKey = (m) => (m.revert ? `r${m.site}` : m.site);', to: 'const siteKey = (m) => m.site;' },
    tests: /executor|bug-injector/,
    file: 'src/t.js',
    cur: 'function t(s) {\n  return s.trim() + 1;\n}',
    prop: 'function t(s) {\n  return s.trimStart() + 1;\n}',
    rest: 'module.exports = { t };',
    test: T("const { t } = require('../src/t');\ntest('t', () => { assert.strictEqual(t('  ab'), 'ab1'); });")
  },
  'BI-default': {
    finding: 'H2',
    mutate: { file: 'src/rl/bug-injector.js', from: "      const b = noRef || ((n.type === 'AssignmentPattern' && key === 'right') || (key === 'key' && n.computed) ? false : bind);", to: '      const b = noRef || bind;' },
    tests: /executor|bug-injector/,
    file: 'src/f.js',
    cur: 'function f(a, k) {\n  return a + (k || 0);\n}',
    prop: 'function f(a, k = LIMIT) {\n  return a + (k || 0) + 1;\n}',
    rest: 'const LIMIT = 100;\nmodule.exports = { f };',
    test: T("const { f } = require('../src/f');\ntest('f', () => { assert.strictEqual(f(1, 2), 4); });")
  }
};

function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit19-rep-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'a19', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, c.file), `'use strict';\n${c.cur}\n${c.rest}\n`);
  fs.writeFileSync(path.join(repo, 'test/a.test.js'), c.test);
  return repo;
}

function copyTree(c, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit19-src-'));
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
    const proposal = { issue_id: 'a19', file: ${JSON.stringify(c.file)}, current_code: ${JSON.stringify(c.cur)}, proposed_code: ${JSON.stringify(c.prop)}, diff_test: null };
    runExecutor({ proposal, repoRoot: ${JSON.stringify(repo)}, onKept: () => 'commit' }).then(r => {
      const m = r.mutation || {};
      console.log(JSON.stringify({ status: r.status, reason: r.reason || null, commit: r.commit || null, sites: m.sites, killed: m.killed, surviving_ref: m.surviving_ref || null }));
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
    console.log(`[${id}] real code:   ${JSON.stringify(real)}`);
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
