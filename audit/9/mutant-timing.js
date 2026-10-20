#!/usr/bin/env node
'use strict';

// SG14: a mutant run that times out on its full slice (2 x main run + 1 s)
// counts as "killed" (src/agents/executor.js mutationEvidence). The suite
// here never asserts on the edited function (it is insensitive: every
// mutant survives on merit), so any `passed` outcome is a kept edit with
// false sensitivity evidence. Modes:
//   contention  CPU-bound suite (a fixed amount of work, ~W ms unloaded), N busy processes started
//               after the main run (a load spike while the mutants run);
//   steady      same suite, N busy processes for the whole executor call;
//   jitter      suite sleeps 300 ms, or 300 + J ms with probability p
//               (a test with a retry/backoff path), no CPU load.
//
// usage: node audit/9/mutant-timing.js [--mode contention|steady|jitter] [--busy 0,8,16]
//          [--work-ms 300] [--repeat 10] [--jitter-ms 2500] [--p 0.2]

const L = require('./lib');
const { runExecutor } = require(L.src('agents/executor'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const MODE = opt('--mode', 'contention');
const BUSY = opt('--busy', MODE === 'jitter' ? '0' : '0,8,16').split(',').map(Number);
const WORK = Number(opt('--work-ms', 300));
const REPEAT = Number(opt('--repeat', 10));
const JITTER = Number(opt('--jitter-ms', 2500));
const P = Number(opt('--p', 0.2));

// Iterations of the suite's CPU loop that take ~WORK ms here, unloaded.
const ITERS = (() => {
  const t0 = performance.now(); let x = 0; for (let i = 0; i < 1e7; i++) x += Math.sqrt(x + i);
  return Math.round(1e7 * WORK / (performance.now() - t0));
})();

function genRepo() {
  const dir = L.tmpDir('mut-t');
  L.write(dir, 'package.json', JSON.stringify({ name: 'mut', version: '1.0.0', scripts: { test: 'node test/run.js' } }));
  L.write(dir, 'src/add.js', "'use strict';\nfunction add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
  const slow = MODE === 'jitter'
    ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 + (Math.random() < ${P} ? ${JITTER} : 0));`
    : `{ let x = 0; for (let i = 0; i < ${ITERS}; i++) x += Math.sqrt(x + i); }`;
  L.write(dir, 'test/run.js', ["const { add } = require('../src/add');", slow, 'add(2, 3); // no assertion: insensitive suite', "console.log('1 passing');"].join('\n'));
  L.gitInit(dir);
  return dir;
}

(async () => {
  console.log(`mode ${MODE}; insensitive suite (no assertion), so every kept edit is a false 'killed' verdict; ${REPEAT} runs per row`);
  const W = [6, 26, 14, 14, 40];
  const row = (c) => c.map((x, i) => String(x).padEnd(W[i] || 10)).join(' ');
  console.log(row(['busy', 'outcomes', 'main_p50_ms', 'mut_max_ms', 'kept edits (false evidence)']));
  for (const busy of BUSY) {
    const outcomes = {};
    const mains = [];
    let mutMax = 0;
    const kept = [];
    for (let i = 0; i < REPEAT; i++) {
      const dir = genRepo();
      let stop = () => {};
      if (MODE === 'steady' && busy) stop = L.contend(busy);
      const proposal = { issue_id: `t${i}`, file: 'src/add.js', current_code: '  return a + b;\n', proposed_code: '  const sum = a + b;\n  return sum;\n' };
      let spike = null;
      if (MODE === 'contention' && busy) {
        // Start the spike when the first mutant is written to the file.
        const fs = require('fs');
        const path = require('path');
        const f = path.join(dir, 'src/add.js');
        const t = setInterval(() => {
          let s = '';
          try { s = fs.readFileSync(f, 'utf8'); } catch { return; }
          if (!spike && s.includes('sum') && s !== "'use strict';\nfunction add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nmodule.exports = { add };\n") { spike = L.contend(busy); clearInterval(t); if (process.env.DBG) console.error("spike", JSON.stringify(s)); }
        }, 5);
        stop = () => { clearInterval(t); if (spike) spike(); };
      }
      const r = await runExecutor({ proposal, repoRoot: dir });
      stop();
      const k = `${r.status}${r.reason ? ':' + r.reason : ''}`;
      outcomes[k] = (outcomes[k] || 0) + 1;
      mains.push(r.execution_time_ms);
      const m = r.mutation || {};
      if (m.duration_ms) mutMax = Math.max(mutMax, m.duration_ms / Math.max(1, m.run));
      if (r.status === 'passed') kept.push(`${m.killed}@run${m.run}`);
      L.rm(dir);
    }
    console.log(row([busy, Object.entries(outcomes).map(([k, v]) => `${k.replace('reverted:', '')}:${v}`).join(' '), L.fmt(L.stats(mains).p50), L.fmt(mutMax), kept.join(' ')]));
  }
})();
