#!/usr/bin/env node
'use strict';

// AUDIT-37 L4: the SG45 sitecustomize chains "the sitecustomize it shadows"
// by PathFinder.find_spec over sys.path minus its OWN directory only. With
// two such directories on PYTHONPATH (a pytest target whose tests run
// another pytest run through runTests: the inner PYTHONPATH is the outer one
// plus the inner temp dir), the two copies find each other forever:
// a -> b -> a -> ... until RecursionError, which site.py reports as
// "Error in sitecustomize" on stderr of EVERY Python process, and each level
// wraps sys.excepthook again, so a main module that raises logs one T row per
// level (hundreds) and walks the whole chain. Not a hang: Python's recursion
// limit ends it.
//
// usage: node audit/37/py-site-nest.js

const L = require('../29/lib');
const { spawnSync } = require('child_process');

L.pyPath();
const dir = L.tmpDir('a37-site-nest');
const core = L.hookText('PY_LOAD_CORE'), site = L.hookText('PY_SITE');
if (!core || !site) { console.log('FINDING: hook text not found'); process.exit(1); }
for (const d of ['a', 'b']) { L.write(L.path.join(dir, d), 'refactor_load_core.py', core); L.write(L.path.join(dir, d), 'sitecustomize.py', site); }
const log = L.path.join(dir, 'load.log');
const runs = {};
for (const pp of [['a'], ['a', 'b']]) {
  const env = { ...process.env, REFACTOR_LOAD_LOG: log, PYTHONPATH: pp.map(d => L.path.join(dir, d)).join(':') };
  const t0 = performance.now();
  const ok = spawnSync('python3', ['-c', 'pass'], { env, encoding: 'utf8', timeout: 60000 });
  const tOk = performance.now() - t0;
  try { L.fs.rmSync(log); } catch {}
  const t1 = performance.now();
  const bad = spawnSync('python3', ['-c', 'raise ValueError(1)'], { env, encoding: 'utf8', timeout: 60000 });
  const tBad = performance.now() - t1;
  let rows = 0;
  try { rows = L.fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; L.fs.rmSync(log); } catch {}
  const err = (ok.stderr || '').split('\n')[0];
  runs[pp.join('+')] = { err, rows };
  console.log(`PYTHONPATH=${pp.join(':').padEnd(4)} 'pass': status ${ok.status} ${Math.round(tOk)} ms stderr=${JSON.stringify(err)} | raising main: ${Math.round(tBad)} ms, ${rows} T row(s)`);
}
L.check('one hook dir: clean start, one T row for a raising main', !runs.a.err && runs.a.rows === 1, JSON.stringify(runs.a));
L.check('two hook dirs (nested runTests): no "Error in sitecustomize", one T row', !runs['a+b'].err && runs['a+b'].rows <= 2, JSON.stringify(runs['a+b']));
L.rm(dir);
L.finish();
