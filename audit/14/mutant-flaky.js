#!/usr/bin/env node
'use strict';

// SG18/SG20/SG22 mutation evidence: a mutant run that FAILS is a kill, with
// no check that the unmutated suite passes at that moment (only a timeout is
// re-run). The suite here never asserts on the edited function, so every
// kept edit is kept on false evidence. Modes:
//   random  the suite fails with probability --p (a flaky test), no load;
//   timing  the suite has a performance assertion: a CPU loop of ~W ms
//           (unloaded) must finish within --factor x W. A load spike of --busy
//           busy processes, each in its own session (other users' jobs, CI
//           neighbours: separate autogroups), starts after the main test run
//           and stops when the executor returns.
//   steady  timing suite, no load (control).
// The edit `return a + b;` -> `return (a + b) * 1;` inserts one mutable token
// (`1`, numeric_off_by_one) and deletes none, so the diff test plays no part.
//
// usage: node audit/14/mutant-flaky.js [--mode random|timing|steady] [--repeat 20]
//          [--p 0.2] [--busy 8] [--work-ms 300] [--factor 2]

const { spawn } = require('child_process');
const L = require('./lib');
const runner = require(L.src('runner/test-runner'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const MODE = opt('--mode', 'random');
const REPEAT = Number(opt('--repeat', 20));
const P = Number(opt('--p', 0.2));
const BUSY = Number(opt('--busy', 8));
const WORK = Number(opt('--work-ms', 300));
const FACTOR = Number(opt('--factor', 2));

const ITERS = (() => {
  const t0 = performance.now(); let x = 0; for (let i = 0; i < 1e7; i++) x += Math.sqrt(x + i);
  return Math.round(1e7 * WORK / (performance.now() - t0));
})();

let spike = null;
const origRun = runner.runTests;
runner.runTests = async function (o) {
  const r = await origRun(o);
  if (o.edit && MODE === 'timing' && BUSY > 0) {
    const kids = [];
    for (let i = 0; i < BUSY; i++) kids.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', detached: true }));
    kids.forEach(k => k.unref());
    spike = () => kids.forEach(k => { try { process.kill(-k.pid, 'SIGKILL'); } catch { /* */ } });
  }
  return r;
};
const { runExecutor } = require(L.src('agents/executor'));

function genRepo() {
  const dir = L.tmpDir('mut-flaky');
  L.write(dir, 'package.json', JSON.stringify({ name: 'mut', version: '1.0.0', scripts: { test: 'node test/run.js' } }));
  L.write(dir, 'src/add.js', "'use strict';\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  const body = MODE === 'random'
    ? [`if (Math.random() < ${P}) { console.error('flaky failure'); process.exit(1); }`]
    : [
      "const assert = require('assert');",
      `const t0 = Date.now(); { let x = 0; for (let i = 0; i < ${ITERS}; i++) x += Math.sqrt(x + i); }`,
      `assert.ok(Date.now() - t0 < ${Math.round(FACTOR * WORK)}, 'too slow: ' + (Date.now() - t0) + ' ms');`
    ];
  L.write(dir, 'test/run.js', ["const { add } = require('../src/add');", ...body, 'add(2, 3); // no assertion on the result: insensitive', "console.log('1 passing');"].join('\n'));
  L.gitInit(dir);
  return dir;
}

(async () => {
  console.log(`mode ${MODE}${MODE === 'random' ? ` p=${P}` : `, CPU loop ~${WORK} ms must finish < ${Math.round(FACTOR * WORK)} ms, spike of ${MODE === 'timing' ? BUSY : 0} setsid busy processes after the main run`}; insensitive suite: every kept edit is false evidence`);
  const outcomes = {};
  let kept = 0;
  const notes = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = genRepo();
    const proposal = { issue_id: `flaky-${i}`, file: 'src/add.js', current_code: '  return a + b;\n', proposed_code: '  return (a + b) * 1;\n' };
    let r;
    try {
      r = await runExecutor({ proposal, repoRoot: dir });
    } finally {
      if (spike) { spike(); spike = null; }
    }
    const k = `${r.status}${r.reason ? ':' + r.reason : ''}`;
    outcomes[k] = (outcomes[k] || 0) + 1;
    if (r.status === 'passed') {
      kept++;
      notes.push(`#${i} killed by ${r.mutation && r.mutation.killed} after ${r.mutation && r.mutation.run} run(s)`);
    }
    L.rm(dir);
  }
  console.log(`outcomes: ${JSON.stringify(outcomes)}`);
  console.log(`kept edits with false evidence: ${kept}/${REPEAT}`);
  for (const n of notes) console.log('  ' + n);
})();
