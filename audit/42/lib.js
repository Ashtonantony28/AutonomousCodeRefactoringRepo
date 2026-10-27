'use strict';

// AUDIT-42 shared harness (after audit/38/unpinned.js). Temp repos and temp
// copies of src/ only; src/ and test/ here are never modified. State and
// dashboard writes go to a temp dir (test/helpers/env.js) and children run
// without ANTHROPIC_API_KEY: no API calls.
require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const T = (body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\n${body}\n`;
const EQUIV = { applicable: true, verdict: 'equivalent', runs: 12, deletions_observed: true, duration_ms: 1 };
const PKG = JSON.stringify({ name: 'a42', version: '0.0.0', private: true, scripts: { test: 'node --test' } });

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.ANTHROPIC_API_KEY;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

function runNode(code, extra) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: childEnv(extra), timeout: 300_000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout || '').slice(-800) }; }
}

function writeFiles(dir, files) {
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
}

// A repo for one executor case: Python (app/m.py, tests/test_m.py) or JS
// (c.file, test/a.test.js); c.files adds more.
function makeRepo(c) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit42-rep-'));
  if (c.lang === 'py') {
    writeFiles(repo, { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', 'app/m.py': `${c.pre || ''}${c.cur}\n${c.rest || ''}`, 'tests/test_m.py': `import app.m as m\n\n\n${c.test}` });
  } else {
    writeFiles(repo, { 'package.json': PKG, [c.file]: `'use strict';\n${c.cur}\n${c.rest}\n`, 'test/a.test.js': c.test });
  }
  if (c.files) writeFiles(repo, c.files);
  return repo;
}

// A temp copy of src/ (and test/ when withTests) with the mutant applied.
function copyTree(mutate, withTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit42-src-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (withTests) {
    fs.cpSync(path.join(ROOT, 'test'), path.join(dir, 'test'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  }
  for (const m of [].concat(mutate || [])) {
    const f = path.join(dir, m.file);
    const text = fs.readFileSync(f, 'utf8');
    if (text.split(m.from).length !== 2) throw new Error(`mutant pattern not found once in ${m.file}`);
    fs.writeFileSync(f, text.replace(m.from, () => m.to));
  }
  return dir;
}

// The executor on one case (the edit applied in place: no git repo).
function execIn(srcRoot, c, extraEnv) {
  const repo = makeRepo(c);
  const file = c.lang === 'py' ? 'app/m.py' : c.file;
  const proposal = { issue_id: 'a42', file, current_code: c.cur, proposed_code: c.prop, diff_test: c.diff_test || EQUIV };
  const code = `
    const { runExecutor } = require(${JSON.stringify(path.join(srcRoot, 'src/agents/executor.js'))});
    runExecutor({ proposal: ${JSON.stringify(proposal)}, repoRoot: ${JSON.stringify(repo)}, onKept: () => 'commit' }).then(r => {
      const m = r.mutation || {};
      console.log(JSON.stringify({ status: r.status, reason: r.reason || null, commit: r.commit || null, sites: m.sites, killed: m.killed || null, killed_test: m.killed_test || null, uncovered_token: m.uncovered_token || null, collection_errors: m.collection_errors || null }));
    });`;
  try { return runNode(code, extraEnv); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

// runTests on a temp repo, clean then with `badVar`=1 (the source throws
// while loading) -> { clean, bad: { status, collection_error, tests } }.
function probeRunTests(srcRoot, files, { badVar = 'A42_BAD', extraEnv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit42-rt-'));
  writeFiles(dir, typeof files === 'function' ? files(dir) : files);
  const code = `
    const { runTests } = require(${JSON.stringify(path.join(srcRoot, 'src/runner/test-runner.js'))});
    const out = {};
    (async () => {
      for (const bad of [false, true]) {
        if (bad) process.env[${JSON.stringify(badVar)}] = '1'; else delete process.env[${JSON.stringify(badVar)}];
        const r = await runTests({ repoRoot: ${JSON.stringify(dir)} });
        out[bad ? 'bad' : 'clean'] = { status: r.status, collection_error: r.collection_error || false, tests: r.tests };
      }
      console.log(JSON.stringify(out));
    })();`;
  try { return runNode(code, extraEnv); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The run fails, and its load failure is not reported: a mutant run of a
// module that cannot load would count as a kill.
const excused = (r) => !!(r && r.bad && r.bad.status === 'failed' && r.bad.collection_error === false);

// Run the test files matching `re` on a mutated copy -> { killed, summary }.
function testsKill(mutate, re) {
  const dir = copyTree(mutate, true);
  try {
    const files = fs.readdirSync(path.join(dir, 'test')).filter(f => f.endsWith('.test.js') && re.test(f)).map(f => path.join('test', f));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env: childEnv(), encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20 });
    const n = (k) => ((r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1];
    return { killed: r.status !== 0, summary: `${files.join(' ')}: pass=${n('pass')} fail=${n('fail')}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const hasPy = () => spawnSync('python3', ['-c', 'import pytest, coverage'], { stdio: 'ignore' }).status === 0;

module.exports = { ROOT, T, EQUIV, PKG, childEnv, runNode, writeFiles, makeRepo, copyTree, execIn, probeRunTests, excused, testsKill, hasPy };
