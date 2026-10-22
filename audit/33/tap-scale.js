#!/usr/bin/env node
'use strict';

// AUDIT-33: SG41 test-runner per-run parsing stays linear.
//   tapResults: TAP unescape (`\#`, `\\`) on every name, suites recorded,
//     ids built by joining the enclosing subtest names.
//   loadFailed(log, root, tests, suites): byName index over tests + suites,
//     control characters rewritten per distinct logged name, a name no test
//     or suite has falls back to its process key.
// Both run synchronously after the test process exits, on every run (main,
// each mutant run, control); mutant runs are charged that time.
//
// Synthetic node:test TAP (the shape tapResults parses: `# Subtest:`,
// `ok n - name`, YAML block with `type: 'suite'` for describe), N leaf
// tests in suites of 10, names carrying `\#` / `\\` escapes; a nested
// shape (depth D) and long names (2 KB each). loadFailed gets N/2 named rows
// (half test names, a quarter suite names, a quarter unknown names that
// fall back to the process key) plus the matching P rows.
// The same input also goes through the pre-SG41 tapResults / loadFailed
// (--old-rev, default 1d75f37) for the SG41 delta.
// FINDING when a doubling of N takes more than 1.5x the size ratio in time
// (not linear), or a 20,000-test run of the flat or depth-8 shape takes over
// 1 s (the 2 KB-name shape is a 90 MB report: linearity only).
//
// usage: node audit/33/tap-scale.js [--sizes 5000,10000,20000] [--reps 3] [--old-rev 1d75f37]

const L = require('../29/lib');
const { tapResults, loadFailed } = require(L.src('runner/test-runner'));
const oldDir = L.srcAt(L.opt('--old-rev', '1d75f37'));
const old = require(L.path.join(oldDir, 'src/runner/test-runner'));

const SIZES = L.nums('--sizes', '5000,10000,20000');
const REPS = Number(L.opt('--reps', 3));

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/#/g, '\\#');
function yaml(ind, type, fail) {
  const p = ' '.repeat(ind + 2);
  return [`${p}---`, `${p}duration_ms: 0.1`, `${p}type: '${type}'`, ...(fail ? [`${p}failureType: 'testCodeFailure'`] : []), `${p}...`];
}
// N leaves; suites of 10 at depth `depth` (each level one suite); name pad.
function tap(n, { depth = 1, pad = '' } = {}) {
  const out = ['TAP version 13'];
  const names = [];
  let leaf = 0, top = 0;
  const emit = (lvl, prefix) => {
    const ind = 4 * lvl, sp = ' '.repeat(ind);
    if (lvl === depth) {
      for (let k = 0; k < 10 && leaf < n; k++, leaf++) {
        const name = `case #${leaf} a\\b ${pad}`;
        names.push([...prefix, name].join(' > '));
        out.push(`${sp}# Subtest: ${esc(name)}`, `${sp}ok ${k + 1} - ${esc(name)}`, ...yaml(ind, 'test'));
      }
      out.push(`${sp}1..10`);
      return;
    }
    const s = `suite #${top++} ${pad}`;
    out.push(`${sp}# Subtest: ${esc(s)}`);
    emit(lvl + 1, [...prefix, s]);
    out.push(`${sp}ok 1 - ${esc(s)}`, ...yaml(ind, 'suite'));
  };
  while (leaf < n) emit(0, []);
  return { text: out.join('\n') + '\n', names };
}

function time(fn) {
  const ms = [];
  let r;
  for (let i = 0; i < REPS; i++) { const t0 = performance.now(); r = fn(); ms.push(performance.now() - t0); }
  return { r, ms: L.median(ms) };
}

const dir = L.tmpDir('a33-tap');
for (const [label, opts] of [['flat suites', {}], ['depth 8', { depth: 8 }], ['2 KB names', { pad: 'x'.repeat(2048) }]]) {
  const rows = [];
  console.log(`${label}:`);
  for (const n of SIZES) {
    const { text, names } = tap(n, opts);
    const t1 = time(() => tapResults(text));
    const res = t1.r;
    const nTests = res ? Object.keys(res.tests).length : 0, nSuites = res && res.suites ? Object.keys(res.suites).length : 0;
    // Log: N/2 named rows over tests, suites and unknown names, P for every key.
    const log = [];
    const suiteIds = res && res.suites ? Object.keys(res.suites) : [];
    for (let i = 0; i < n / 2; i++) {
      const name = i % 4 < 2 ? names[i] : i % 4 === 2 ? suiteIds[i % suiteIds.length] : `gone ${i}`;
      log.push(`T\t1.${i}\t${dir}/src/bad.js\t${JSON.stringify(name)}`, `P\t1.${i}`);
    }
    const file = L.write(dir, `load-${n}.log`, log.join('\n') + '\n');
    const t2 = time(() => loadFailed(file, dir, res.tests, res.suites));
    const o1 = time(() => old.tapResults(text)), o2 = time(() => old.loadFailed(file, dir, o1.r.tests));
    console.log(`  N=${n}: pre-SG41 tapResults ${L.ms(o1.ms)}, loadFailed ${L.ms(o2.ms)}`);
    console.log(`  N=${n}: TAP ${Math.round(text.length / 1024)} KB, ${nTests} tests, ${nSuites} suites; tapResults ${L.ms(t1.ms)}, loadFailed ${L.ms(t2.ms)} (failed=${t2.r})`);
    L.check(`${label} N=${n}: every test parsed, unescaped`, nTests === n && names.every(x => res.tests[x] === 'pass'), `${nTests}/${n}`);
    L.check(`${label} N=${n}: all rows excused`, t2.r === false, String(t2.r));
    rows.push([n, t1.ms + t2.ms]);
  }
  for (let i = 1; i < rows.length; i++) {
    const [n0, a] = rows[i - 1], [n1, b] = rows[i];
    L.check(`${label}: ${n0} -> ${n1} tests is linear (time ratio <= 1.5x the size ratio)`, b / Math.max(a, 1) <= 1.5 * (n1 / n0), `${Math.round(a)} -> ${Math.round(b)} ms`);
  }
  const big = rows.find(([n]) => n === 20000);
  if (big && label !== '2 KB names') L.check(`${label}: 20,000 tests parsed and checked under 1 s`, big[1] < 1000, `${Math.round(big[1])} ms`);
}
L.rm(dir);
L.rm(oldDir);
L.finish();
