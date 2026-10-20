#!/usr/bin/env node
'use strict';

// SG28 reporter fallback, cost and leaks. The test script hands off
// (`npm run unit`) to a script that picks its own --test-reporter, after a
// pre-step of --pre-s seconds (a build / lint step). The first run in a repo
// starts with the runner's reporters, node refuses them and the same command
// is re-run without them in what is left of the test budget; later runs in
// that repo skip them (per process).
//   1. runTests twice (timeout --timeout-ms): wall, status, retry cost.
//   2. runExecutor on a behaviour-preserving edit: runs spent in the mutant
//      phase although no per-test results can ever exist (the outcome is
//      `tests_insensitive` whatever the mutants do).
// Leaks: processes under the repo, src temp dirs in a private TMPDIR.
// FINDING when a suite that fits its timeout ends `timeout` because of the
// first refused run, when anything is left behind, or when the mutant phase
// runs a suite although the main run had no per-test results.
//
// usage: node audit/22/reporter-fallback.js [--pre-s 0,2] [--suite-s 1] [--timeout-ms 6000]

const L = require('./lib');
const { runTests } = require(L.src('runner/test-runner'));
const { runExecutor } = require(L.src('agents/executor'));
const diffTesting = require(L.src('validation/diff-testing'));

const PRE = L.nums('--pre-s', '0,2');
const SUITE_S = Number(L.opt('--suite-s', 1));
const TIMEOUT = Number(L.opt('--timeout-ms', 6000));

function repo(pre) {
  const dir = L.tmpDir('a22-fb');
  const preStep = pre ? `node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${pre * 1000})" && ` : '';
  L.write(dir, 'package.json', JSON.stringify({ name: 'fb', version: '1.0.0', scripts: { test: 'npm run unit --silent', unit: `${preStep}node --test --test-reporter=spec` } }));
  const cur = 'function f(x) {\n  return x + 1;\n}\n';
  L.write(dir, 'src/m.js', `'use strict';\n${cur}module.exports = { f };\n`);
  L.write(dir, 'test/m.test.js', `const test = require('node:test');\nconst assert = require('assert');\nconst { f } = require('../src/m');\ntest('f', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SUITE_S * 1000}); for (let i = -5; i < 5; i++) assert.strictEqual(f(i), i + 1); });\n`);
  L.gitInit(dir);
  return { dir, cur };
}

(async () => {
  const W = [6, 5, 10, 10, 10, 6, 6, 6];
  console.log(`1. runTests, suite ${SUITE_S} s after a pre-step, timeout ${TIMEOUT} ms`);
  console.log(L.row(['pre_s', 'call', 'status', 'wall_ms', 'charged', 'tests', 'procs', 'tmp'], W));
  for (const pre of PRE) {
    const { dir } = repo(pre);
    await L.withTmp(async (tmp) => {
      for (let call = 1; call <= 2; call++) {
        const t0 = performance.now();
        const r = await runTests({ repoRoot: dir, timeoutMs: TIMEOUT });
        const wall = performance.now() - t0;
        await L.sleep(300);
        const procs = L.procsUnder([dir]);
        const temps = L.srcTmpDirs(tmp);
        console.log(L.row([pre, call, r.status, L.fmt(wall), L.fmt(r.execution_time_ms), r.tests ? Object.keys(r.tests).length : '-', procs.length, temps.length], W));
        const fits = (pre + SUITE_S) * 1000 + 1500 < TIMEOUT;
        if (fits) L.check(`pre ${pre}s call ${call}: suite that fits ${TIMEOUT} ms passes`, r.status === 'passed', `${r.status} in ${L.fmt(wall)} ms`);
        L.check(`pre ${pre}s call ${call}: nothing left`, !procs.length && !temps.length, `${procs.length} procs, ${temps.length} temp dirs`);
      }
    });
    L.rm(dir);
  }

  console.log('\n2. runExecutor (fresh repo path, so the first run retries)');
  for (const pre of PRE) {
    const { dir, cur } = repo(pre);
    const proposal = { issue_id: `fb-${pre}`, file: 'src/m.js', current_code: cur, proposed_code: 'function f(x) {\n  return x + 2 - 1;\n}\n' };
    proposal.diff_test = diffTesting.run({ currentSrc: cur, proposedSrc: proposal.proposed_code, fileSrc: L.fs.readFileSync(L.path.join(dir, 'src/m.js'), 'utf8'), file: 'src/m.js' });
    await L.withTmp(async (tmp) => {
      const t0 = performance.now();
      const r = await runExecutor({ proposal, repoRoot: dir });
      const wall = performance.now() - t0;
      const m = r.mutation || {};
      await L.sleep(300);
      const procs = L.procsUnder([dir]);
      const temps = L.srcTmpDirs(tmp);
      console.log(`pre ${pre}s: ${r.status} ${r.reason || ''}; main run ${r.execution_time_ms} ms; mutant runs ${m.run || 0} (${L.fmt(m.duration_ms)} ms; ${JSON.stringify({ no_failed_test: m.no_failed_test, collection_errors: m.collection_errors })}); executor wall ${L.fmt(wall)} ms; procs ${procs.length}, temp dirs ${temps.length}`);
      L.check(`executor pre ${pre}s: no mutant run when the main run has no per-test results`, !(m.run > 0), `${m.run} runs, ${L.fmt(m.duration_ms)} ms`);
      L.check(`executor pre ${pre}s: nothing left`, !procs.length && !temps.length, `${procs.length} procs, ${temps.length} temp dirs`);
    });
    L.rm(dir);
  }
  L.finish();
})();
