'use strict';

// AUDIT-11: statement and branch coverage of the Python diff-test harness
// (src/validation/py_diff_harness.py) under the test suite, via coverage.py.
//
//   node audit/11/py-coverage.js [--out summary.json] [test files...]
//   (default: every test/*.test.js)
//
// py-diff-testing.js spawns `python3 -I -B <harness>` with PATH from the
// environment. This puts a python3 shim first on PATH that starts the harness
// through py-cov-launcher.py (coverage.py with fork/_exit patches; data saved
// outside the temp cwd the caller deletes) and passes every other python3
// call through untouched. Coverage adds start-up time inside the 3 s hard
// kill, so a test that fails here but not in `npm test` is reported, not
// counted as a finding. Prints FINDING (exit 1) when the harness is below
// 85% statements; ok otherwise.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HARNESS = path.join(ROOT, 'src/validation/py_diff_harness.py');
const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = oi >= 0 ? argv.splice(oi, 2)[1] : null;

function main() {
  const realPy = execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
  const covMod = spawnSync(realPy, ['-c', 'import coverage,os;print(os.path.dirname(os.path.dirname(coverage.__file__)))'], { encoding: 'utf8' });
  if (covMod.status !== 0) { console.log('coverage.py not importable by python3; cannot measure the harness'); process.exitCode = 2; return; }
  const site = covMod.stdout.trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-pycov-'));
  const bin = path.join(tmp, 'bin');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(bin); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'rc.ini'), [
    '[run]', `data_file = ${path.join(data, '.coverage')}`, 'parallel = true', 'branch = true',
    'patch = fork', `include = ${HARNESS}`, ''
  ].join('\n'));
  const launcher = path.join(__dirname, 'py-cov-launcher.py');
  fs.writeFileSync(path.join(bin, 'python3'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    `  case "$a" in *py_diff_harness.py) exec "${realPy}" -I -B "${launcher}" "$a" "${site}" "${data}";; esac`,
    'done',
    `exec "${realPy}" "$@"`, ''
  ].join('\n'), { mode: 0o755 });

  const tests = argv.length ? argv : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const failed = [...r.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(m => m[1]).filter(n => !/\.test\.js$/.test(n));
  const pass = (r.stdout.match(/^# pass (\d+)/m) || [])[1];
  console.log(`suite under the shim: exit ${r.status}, pass ${pass}, fail ${failed.length}${failed.length ? `: ${failed.join(' | ')}` : ''}`);

  const files = fs.readdirSync(data).filter(f => f.startsWith('.coverage'));
  console.log(`coverage data files: ${files.length} (parent processes + forked sides)`);
  const covEnv = { ...process.env, COVERAGE_RCFILE: path.join(data, 'rc.ini') };
  spawnSync(realPy, ['-m', 'coverage', 'combine', '-q'], { cwd: data, env: covEnv, encoding: 'utf8' });
  const json = path.join(data, 'cov.json');
  const rep = spawnSync(realPy, ['-m', 'coverage', 'json', '-q', '-o', json], { cwd: data, env: covEnv, encoding: 'utf8' });
  if (rep.status !== 0) { console.log(`coverage json failed: ${rep.stdout}${rep.stderr}`); process.exitCode = 2; return; }
  const f = Object.values(JSON.parse(fs.readFileSync(json, 'utf8')).files)[0];
  const s = f.summary;
  const missing = f.missing_lines;
  const rng = [];
  for (let i = 0; i < missing.length; i++) { let j = i; while (j + 1 < missing.length && missing[j + 1] === missing[j] + 1) j++; rng.push(i === j ? `${missing[i]}` : `${missing[i]}-${missing[j]}`); i = j; }
  // Lines no tracer can see: audit-hook callbacks run with tracing off, and
  // the forked child keeps running run_side()'s frame, which was entered
  // before coverage restarted in the child (sys.settrace only reaches new
  // frames). They are reported apart, not as gaps.
  const srcLines = fs.readFileSync(HARNESS, 'utf8').split('\n');
  const blind = new Set();
  const span = (from, to) => { const a = srcLines.findIndex(l => from.test(l)); if (a < 0) return; let b = a + 1; while (b < srcLines.length && !to.test(srcLines[b])) b++; for (let k = a + 1; k < b; k++) blind.add(k + 1); };
  span(/^def audit_hook\(/, /^    return hook/);
  span(/^    pid = os\.fork\(\)/, /^    os\.close\(w\)/);
  const statements = new Set([...f.executed_lines, ...missing]);
  const blindStmts = [...blind].filter(n => statements.has(n));
  const blindMissing = missing.filter(n => blind.has(n));
  const adjTotal = s.num_statements - blindStmts.length;
  const adjCovered = s.covered_lines - (blindStmts.length - blindMissing.length);
  const pctS = 100 * adjCovered / adjTotal;
  const realMissing = missing.filter(n => !blind.has(n));
  const rng2 = [];
  for (let i = 0; i < realMissing.length; i++) { let j = i; while (j + 1 < realMissing.length && realMissing[j + 1] === realMissing[j] + 1) j++; rng2.push(i === j ? `${realMissing[i]}` : `${realMissing[i]}-${realMissing[j]}`); i = j; }
  console.log(`src/validation/py_diff_harness.py (raw): statements ${(100 * s.covered_lines / s.num_statements).toFixed(2)}% (${s.covered_lines}/${s.num_statements}), branches ${(100 * s.covered_branches / s.num_branches).toFixed(2)}% (${s.covered_branches}/${s.num_branches})`);
  console.log(`  ${blindStmts.length} statements are invisible to any tracer (audit hook body, child side of fork in run_side); ${blindMissing.length} of them show as missing`);
  console.log(`src/validation/py_diff_harness.py (measurable): statements ${pctS.toFixed(2)}% (${adjCovered}/${adjTotal})`);
  console.log(`  missing lines: ${rng2.join(' ')}`);
  void rng;
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ ...s, num_statements: adjTotal, covered_lines: adjCovered, raw: s, missing_lines: realMissing, blind_lines: blindStmts, suite_failed: failed }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pctS >= 85 ? 'ok: harness >= 85% statements' : 'FINDING: harness below 85% statements');
  process.exitCode = pctS >= 85 ? 0 : 1;
}

main();
