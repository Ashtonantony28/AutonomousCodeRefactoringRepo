#!/usr/bin/env node
'use strict';

// AUDIT-41: temp-dir, process and heap leaks across repeated executor runs
// (each with its mutant / control runs) and timed-out suites, on the
// current src. TMPDIR points at a fresh private dir after the libs load, so
// every `refactor-cov-` / `refactor-pyc-` / `pydt-` dir the src makes lands
// there; the state dir (test/helpers/env.js) is elsewhere.
//   js       runExecutor on the AUDIT-29 kept edit (CommonJS node:test)
//   py       the same edit on a pytest target
//   loader   the js case under `node --import ./register.mjs --test` (U rows)
//   timeout  runTests on a suite whose test spawns a detached-looking
//            grandchild and sleeps past timeoutMs (2 s)
// After N rounds: entries left in TMPDIR (Node's shared node-compile-cache
// dir excepted), processes left whose cwd is under a
// fixture, and heapUsed growth (gc'd) from round 2 to round N.
//
// FINDING when a temp entry or process is left, or the heap grows by more
// than 20 MB over the rounds.
//
// usage: node --expose-gc audit/41/leak.js [--rounds 6] [--cases js,py,loader,timeout]

const L = require('../29/lib');

const ROUNDS = Number(L.opt('--rounds', 6));
const CASES = L.list('--cases', 'js,py,loader,timeout');

function jsFixture(loader) {
  const dir = L.tmpDir('a41-leak-js');
  const cur = 'function f(x) {\n  return x + 1;\n}\n', prop = 'function f(x) {\n  return x + 2 - 1;\n}\n';
  const before = `'use strict';\n${cur}module.exports = { f };\n`;
  L.write(dir, 'package.json', JSON.stringify({ name: 'lk', version: '1.0.0', scripts: { test: loader ? 'node --import ./register.mjs --test' : 'node --test' } }));
  L.write(dir, 'loader.mjs', 'export async function load(url, ctx, next) { return next(url, ctx); }\n');
  L.write(dir, 'register.mjs', "import { register } from 'node:module';\nregister('./loader.mjs', import.meta.url);\n");
  L.write(dir, 'src/m.js', before);
  L.write(dir, 'test/m.test.js', "const test = require('node:test');\nconst assert = require('assert');\nconst { f } = require('../src/m');\n" +
    "test('small', () => { assert.strictEqual(f(1), 2); assert.strictEqual(f(-3), -2); });\n");
  L.gitInit(dir);
  return { dir, file: 'src/m.js', cur, prop, before };
}

function pyFixture() {
  const dir = L.tmpDir('a41-leak-py');
  const cur = 'def f(x):\n    return x + 1\n', prop = 'def f(x):\n    return x + 2 - 1\n';
  L.write(dir, 'pkg/__init__.py', '');
  L.write(dir, 'pkg/m.py', cur);
  L.write(dir, 'tests/test_m.py', 'from pkg.m import f\n\ndef test_f():\n    assert f(1) == 2\n    assert f(-3) == -2\n');
  L.write(dir, 'pytest.ini', '[pytest]\n');
  L.gitInit(dir);
  return { dir, file: 'pkg/m.py', cur, prop, before: cur };
}

function timeoutFixture() {
  const dir = L.tmpDir('a41-leak-to');
  L.write(dir, 'package.json', JSON.stringify({ name: 'to', version: '1.0.0', scripts: { test: 'node --test' } }));
  L.write(dir, 'test/t.test.js', "const test = require('node:test');\nconst { spawn } = require('child_process');\n" +
    "test('slow', async () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 30000)); });\n");
  return { dir };
}

const heap = () => { global.gc && global.gc(); return process.memoryUsage().heapUsed / 1048576; };

(async () => {
  L.pyPath();
  const { runExecutor } = require(L.src('agents/executor'));
  const { runTests } = require(L.src('runner/test-runner'));
  const diffTesting = require(L.src('validation/diff-testing'));
  const tmp = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), 'a41-leak-tmp-'));
  console.log(`rounds ${ROUNDS}; gc ${!!global.gc}; load ${L.fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
  for (const kind of CASES) {
    const f = kind === 'py' ? pyFixture() : kind === 'timeout' ? timeoutFixture() : jsFixture(kind === 'loader');
    const prevTmp = process.env.TMPDIR;
    const sub = L.fs.mkdtempSync(L.path.join(tmp, `${kind}-`));
    const outs = [], heaps = [];
    for (let r = 0; r < ROUNDS; r++) {
      process.env.TMPDIR = sub;
      let out;
      if (kind === 'timeout') {
        const t = await runTests({ repoRoot: f.dir, timeoutMs: 2000 });
        out = `${t.status}`;
      } else {
        const proposal = { issue_id: `lk-${kind}-${r}`, file: f.file, current_code: f.cur, proposed_code: f.prop };
        if (kind !== 'py') proposal.diff_test = diffTesting.run({ currentSrc: f.cur, proposedSrc: f.prop, fileSrc: f.before, file: f.file });
        const res = await runExecutor({ proposal, repoRoot: f.dir });
        out = `${res.status}${res.reason ? ' ' + res.reason : ''}`;
        L.fs.writeFileSync(L.path.join(f.dir, f.file), f.before);
      }
      if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
      outs.push(out);
      heaps.push(heap());
    }
    await L.sleep(500);
    // node-compile-cache: Node's own shared compile cache dir (one per TMPDIR,
    // reused across runs, not made by src): not a leak.
    const all = L.fs.readdirSync(sub), left = all.filter(n => n !== 'node-compile-cache');
    const procs = L.procsUnder([f.dir]);
    const grow = heaps[heaps.length - 1] - heaps[Math.min(1, heaps.length - 1)];
    console.log(`  ${kind.padEnd(8)} outcomes ${[...new Set(outs)].join(' | ')}; temp entries left ${left.length}${left.length ? ` (${left.slice(0, 4).join(', ')})` : ''}${all.length > left.length ? ' (+ node-compile-cache)' : ''}; processes left ${procs.length}; heap ${heaps.map(h => h.toFixed(1)).join(' ')} MB`);
    L.check(`${kind}: no temp dir left after ${ROUNDS} rounds`, left.length === 0, left.slice(0, 6).join(', '));
    L.check(`${kind}: no process left under the fixture`, procs.length === 0, procs.join('; '));
    L.check(`${kind}: heap growth under 20 MB`, grow < 20, `${grow.toFixed(1)} MB`);
    for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
    L.rm(f.dir);
  }
  L.rm(tmp);
  L.finish();
})();
