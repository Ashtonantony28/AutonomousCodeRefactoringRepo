#!/usr/bin/env node
'use strict';

// SG34 writes every mutant into the file as a runtime switch around the
// smallest expression holding the site:
//   JS     (globalThis.process.env.K === '1' ? (M) : (O))
//   Python ((M) if __import__('os').environ.get('K') == '1' else (O))
// and the control run is the same text with K unset. The switch is evaluated
// every time the expression is: a process.env read in JS (a C++ interceptor
// + getenv), an __import__ call (through the pytest load hook's Python-level
// wrapper) plus an os.environ lookup in Python. Mutant and control runs get
// at most 2x the plain suite time + 1 s each (the main run's, until a
// mutant run measures it).
//
// Repo: one function `f` (`return x + 1;` -> `return x + 2 - 1;`, every site
// killed by a small test) and a test that calls `f` --calls times in a loop
// (a hot path: a per-item / per-char helper under a loop test).
// Reports per call count:
//   * direct suite times: the edit as written, the switch on, the switch off
//     (the first mutant editMutants writes);
//   * runExecutor outcome, mutant runs, timeouts, mutant phase wall.
// FINDING when the edit is not kept at a call count where the smallest count
// keeps it (the switch makes mutant / control runs time out), or when the
// mutant phase grows more than twice as fast as the edit's own suite time
// relative to the smallest count (budget spent on the switch, not the tests).
//
// usage: node audit/25/switch-hot.js [--lang js,py] [--calls-js 1000,1000000,5000000]
//          [--calls-py 1000,1000000,3000000] [--pad 300] [--src DIR]

const L = require('./lib');
const { runExecutor } = require(L.src('agents/executor'));
const { runTests } = require(L.src('runner/test-runner'));
const diffTesting = require(L.src('validation/diff-testing'));
let editMutants = null;
try { ({ editMutants } = require(L.src('rl/bug-injector'))); } catch { /* */ }

const LANGS = L.list('--lang', 'js,py');
const CALLS = { js: L.nums('--calls-js', '1000,1000000,5000000'), py: L.nums('--calls-py', '1000,1000000,3000000') };
if (LANGS.includes('py')) L.pyPath();

function repo(lang, n) {
  const dir = L.tmpDir(`a25-hot-${lang}`);
  const js = lang === 'js';
  const cur = js ? 'function f(x) {\n  return x + 1;\n}\n' : 'def f(x):\n    return x + 1\n';
  const prop = js ? 'function f(x) {\n  return x + 2 - 1;\n}\n' : 'def f(x):\n    return x + 2 - 1\n';
  const file = js ? 'src/m.js' : 'pkg/m.py';
  const before = js ? `'use strict';\n${cur}module.exports = { f };\n` : cur;
  L.write(dir, file, before);
  if (js) {
    L.write(dir, 'package.json', JSON.stringify({ name: 'hot', version: '1.0.0', scripts: { test: 'node --test' } }));
    L.write(dir, 'test/m.test.js', [
      "const test = require('node:test');",
      "const assert = require('assert');",
      "const { f } = require('../src/m');",
      "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });",
      `test('loop', () => { let s = 0; for (let i = 0; i < ${n}; i++) s += f(i) - i; assert.strictEqual(s, ${n}); });`
    ].join('\n') + '\n');
  } else {
    L.write(dir, 'pkg/__init__.py', '');
    L.write(dir, 'pytest.ini', '[pytest]\ntestpaths = tests\n');
    L.write(dir, 'tests/test_m.py', [
      'from pkg.m import f',
      'def test_small():',
      '    assert f(1) == 2',
      '    assert f(-3) == -2',
      'def test_loop():',
      '    s = 0',
      `    for i in range(${n}):`,
      '        s += f(i) - i',
      `    assert s == ${n}`,
      ''
    ].join('\n'));
  }
  L.gitInit(dir);
  const proposal = { issue_id: `hot-${lang}-${n}`, file, current_code: cur, proposed_code: prop };
  proposal.diff_test = diffTesting.run({ currentSrc: cur, proposedSrc: prop, fileSrc: before, file });
  return { dir, file, before, edited: before.replace(cur, prop), proposal };
}

async function timed(dir, file, text, env) {
  L.fs.writeFileSync(L.path.join(dir, file), text);
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  let r;
  try { r = runTests({ repoRoot: dir }); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  r = await r;
  return { ms: r.execution_time_ms, status: r.status };
}

// Per-evaluation cost of the switch condition alone (no test runner), with
// the current environment and with --pad extra variables (a CI environment):
// a JS process.env read is a getenv() scan of the environment.
function perEval() {
  const { spawnSync } = require('child_process');
  const N = { js: 5e6, py: 1e6 };
  const code = {
    js: `const N=${N.js};function p(a){return a*2+1}function s(a){return (globalThis.process.env.REFACTOR_MUTANT==='1'?(a*2-1):(a*2+1))}
for(const f of [p,s]){let t=performance.now(),x=0;for(let i=0;i<N;i++)x+=f(i);console.log(performance.now()-t)}`,
    py: `import time\nN=${N.py}\ndef p(a): return a*2+1\ndef s(a): return ((a*2-1) if __import__('os').environ.get('REFACTOR_MUTANT') == '1' else (a*2+1))\nfor f in (p, s):\n    t=time.perf_counter(); x=0\n    for i in range(N): x+=f(i)\n    print((time.perf_counter()-t)*1000)\n`
  };
  const pad = Number(L.opt('--pad', 300));
  console.log('1. switch condition cost per evaluation (ns), plain call vs switched call');
  for (const lang of LANGS) {
    for (const extra of [0, pad]) {
      const env = { ...process.env };
      for (let i = 0; i < extra; i++) env[`AUDIT_PAD_${i}`] = 'x'.repeat(40);
      const r = lang === 'js' ? spawnSync(process.execPath, ['-e', code.js], { env, encoding: 'utf8' }) : spawnSync('python3', ['-I', '-c', code.py], { env, encoding: 'utf8' });
      const [p, s] = r.stdout.trim().split('\n').map(Number);
      const n = N[lang];
      console.log(`   ${lang} env ${Object.keys(env).length} vars: plain ${L.fmt((p / n) * 1e6, 1)} ns, switched ${L.fmt((s / n) * 1e6, 1)} ns per call (x${L.fmt(s / p, 0)})`);
    }
  }
  console.log('2. runExecutor on a hot-path edit');
}

(async () => {
  perEval();
  const W = [5, 9, 9, 9, 9, 7, 32, 6, 5, 9, 9];
  console.log(L.row(['lang', 'calls', 'edit_ms', 'sw_on_ms', 'sw_off_ms', 'ratio', 'outcome', 'runs', 'tmo', 'suite_ms', 'mut_ms'], W));
  for (const lang of LANGS) {
    let keptAt = null, base = null;
    for (const n of CALLS[lang]) {
      const g = repo(lang, n);
      try {
        const d = { edit: null, on: null, off: null };
        d.edit = await timed(g.dir, g.file, g.edited, {});
        const muts = editMutants ? editMutants(g.edited, { file: g.file, before: g.before }) : [];
        const m0 = Array.isArray(muts) && muts.find(m => m.env);
        if (m0) {
          d.on = await timed(g.dir, g.file, m0.src, m0.env);
          d.off = await timed(g.dir, g.file, m0.src, Object.fromEntries(Object.keys(m0.env).map(k => [k, undefined])));
        }
        L.fs.writeFileSync(L.path.join(g.dir, g.file), g.before);
        const r = await runExecutor({ proposal: g.proposal, repoRoot: g.dir });
        const m = r.mutation || {};
        const outcome = `${r.status}${r.reason ? ' ' + r.reason : ''}`;
        const ratio = d.off ? d.off.ms / d.edit.ms : null;
        console.log(L.row([lang, n, L.fmt(d.edit.ms), d.on ? L.fmt(d.on.ms) : '-', d.off ? L.fmt(d.off.ms) : '-', ratio ? L.fmt(ratio, 1) : '-', outcome, m.run || 0, m.timeouts || 0, L.fmt(m.suite_ms), L.fmt(m.duration_ms)], W));
        if (process.env.A25_VERBOSE) console.log(JSON.stringify(m));
        if (r.status === 'passed' && keptAt == null) keptAt = n;
        if (!base) base = { n, edit: d.edit.ms, mut: m.duration_ms };
        else {
          if (keptAt != null) L.check(`${lang} ${n} calls: edit kept as at ${keptAt} calls`, r.status === 'passed', outcome);
          if (m.duration_ms != null && base.mut) {
            const g1 = m.duration_ms / base.mut, g0 = d.edit.ms / base.edit;
            L.check(`${lang} ${n} calls: mutant phase grows with the suite (x${L.fmt(g1, 1)}) not the switch (suite x${L.fmt(g0, 1)})`, g1 <= 2 * g0, `${L.fmt(base.mut)} -> ${L.fmt(m.duration_ms)} ms; switch-off run ${d.off ? L.fmt(d.off.ms) : '-'} ms vs edit ${L.fmt(d.edit.ms)} ms`);
          }
        }
      } finally { L.rm(g.dir); }
    }
  }
  L.finish();
})();
