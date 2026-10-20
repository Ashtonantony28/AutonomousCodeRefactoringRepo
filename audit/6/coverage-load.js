#!/usr/bin/env node
'use strict';

// V8 coverage evidence in src/runner/test-runner.js (runTests with `edit`).
// After the suite exits, v8Exercised reads every NODE_V8_COVERAGE JSON
// synchronously and, per process that loaded the edited file, checks every
// non-whitespace character of the changed span against every V8 range of
// the file; line numbers come from lineOf(), a scan from offset 0 per probe.
// None of that is under the test timeout. Measured: total runTests time,
// the post-exit part (total - execution_time_ms), coverage files/bytes and the
// longest main-thread stall (10 ms ticker).
//
// usage: node audit/6/coverage-load.js [--cases span,procs,json] [--quick]
//   span   edit-span size on a 199 KB file (1 test process; exercised / not)
//   procs  N test processes that each load the edited file (edit not run)
//   json   one process that also loads a large generated module (coverage JSON size)

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const args = process.argv.slice(2);
const CASES = (args.includes('--cases') ? args[args.indexOf('--cases') + 1] : 'span,procs,json').split(',');
const QUICK = args.includes('--quick');

L.isolateState('cov');
const { runTests, changedSpan } = require(L.src('runner/test-runner'));

// 199 KB of small functions (~2,800 of them); `edited` rewrites the bodies of
// the functions whose text lies in the last `spanBytes` of the file.
function bigModule(spanBytes) {
  let src = "'use strict';\n";
  let j = 0;
  while (src.length + 200 < 199_000) src += L.fnText(0, j++);
  src += 'module.exports = { f0_0, f0_1 };\n';
  const cut = Math.max(0, src.length - spanBytes);
  const head = src.slice(0, cut);
  const tail = src.slice(cut).replace(/return t(\d+);/g, 'return t$1 + 0;');
  return { before: src, after: head + tail, fns: j };
}

function makeRepo({ module, test, extra = {} }) {
  const dir = L.tmpDir('covrepo');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov', version: '1.0.0', private: true, scripts: { test: 'node test/run.js' } }));
  fs.writeFileSync(path.join(dir, 'mod.js'), module);
  fs.writeFileSync(path.join(dir, 'test', 'run.js'), test);
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

async function measure(label, dir, before, after) {
  fs.writeFileSync(path.join(dir, 'mod.js'), after);
  const span = changedSpan(before, after);
  const mon = L.stallMonitor(10);
  const t = performance.now();
  // Snapshot the coverage dir size by intercepting rmSync of the temp dir.
  let covFiles = 0, covBytes = 0;
  const origRm = fs.rmSync;
  fs.rmSync = function (p, o) {
    if (String(p).includes('refactor-cov-')) {
      try { for (const n of fs.readdirSync(p)) { covFiles++; covBytes += fs.statSync(path.join(p, n)).size; } } catch { /* */ }
    }
    return origRm.call(this, p, o);
  };
  let r;
  try { r = await runTests({ repoRoot: dir, edit: { file: 'mod.js', ...span } }); } finally { fs.rmSync = origRm; }
  const total = performance.now() - t;
  await new Promise(res => setTimeout(res, 30)); // let the ticker observe the stall
  const stall = mon.stop();
  const post = total - r.execution_time_ms;
  console.log(L.row([label, (span.end - span.start), r.status, r.coverage && r.coverage.exercised, L.fmt(r.execution_time_ms, 0), L.fmt(post, 0), L.fmt(total, 0), covFiles, (covBytes / 1e6).toFixed(1), L.fmt(stall.max, 0)], [44, 9, 8, 6, 9, 9, 9, 6, 7, 8]));
  L.rm(dir);
  return { post, total };
}

async function main() {
  console.log(L.row(['case', 'span_B', 'status', 'exerc', 'suite_ms', 'post_ms', 'total_ms', 'files', 'cov_MB', 'stall_ms'], [44, 9, 8, 6, 9, 9, 9, 6, 7, 8]));
  if (CASES.includes('span')) {
    const spans = QUICK ? [2_000, 20_000] : [2_000, 10_000, 20_000, 50_000, 100_000, 190_000];
    for (const s of spans) {
      const m = bigModule(s);
      const loadOnly = "require('../mod.js'); console.log('1 passing');\n";
      await measure(`span ${s / 1000} KB, loaded not run`, makeRepo({ module: m.before, test: loadOnly }), m.before, m.after);
    }
  }
  if (CASES.includes('procs')) {
    const procs = QUICK ? [10, 50] : [10, 50, 100, 200];
    for (const span of [2_000, 20_000]) {
      const m = bigModule(span);
      for (const n of procs) {
        const test = `const { spawnSync } = require('child_process');\nfor (let i = 0; i < ${n}; i++) spawnSync(process.execPath, ['-e', "require('./mod.js')"], { cwd: require('path').join(__dirname, '..'), stdio: 'ignore' });\nconsole.log('${n} passing');\n`;
        await measure(`${n} processes, span ${span / 1000} KB, not run`, makeRepo({ module: m.before, test }), m.before, m.after);
      }
    }
  }
  if (CASES.includes('json')) {
    // K generated 5 MB modules (bundled vendor code, fixtures, ...) loaded in
    // the same process as the edited file -> one large coverage JSON
    let big = '';
    let i = 0;
    while (big.length < 5e6) { big += `function g${i}(a){if(a>${i})return a-${i};else return a+${i};}\n`; i++; }
    big += 'module.exports = 1;\n';
    for (const k of QUICK ? [1] : [1, 4, 8]) {
      const m = bigModule(2_000);
      const extra = {};
      let test = '';
      for (let q = 0; q < k; q++) { extra[`big${q}.js`] = big; test += `require('../big${q}.js');\n`; }
      test += "require('../mod.js'); console.log('1 passing');\n";
      await measure(`${k} x 5 MB modules (${k * i} fns) + span 2 KB`, makeRepo({ module: m.before, test, extra }), m.before, m.after);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
