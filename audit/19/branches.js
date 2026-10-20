'use strict';

// AUDIT-19: uncovered branches in the safety-critical files, from Node's own
// lcov report (`node --test --experimental-test-coverage`, BRDA records).
// Node's view counts test processes and child `node` processes, not worker
// threads (diff-prep / diff-sandbox), so diff-testing.js and the workers
// are listed for completeness only; `npm run coverage` is the line figure
// that sees every isolate.
//
//   node audit/19/branches.js [--json out.json]
//
// Prints, per file, the lines holding a branch no test took, with the
// enclosing function name. Exit 1 (FINDING) only when the suite is red.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
  'src/agents/executor.js',
  'src/runner/test-runner.js', 'src/runner/reverter.js', 'src/runner/worktree.js', 'src/runner/anchor-matcher.js',
  'src/validation/hybrid-validator.js', 'src/validation/diff-testing.js', 'src/validation/py-diff-testing.js',
  'src/validation/ast-checker.js', 'src/validation/polyglot-ast.js',
  'src/orchestrator.js', 'src/rl/bug-injector.js', 'src/utils/hunks.js', 'src/utils/checkpoint.js'
];

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit19-br-'));
  const out = path.join(tmp, 'lcov.info');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage',
    '--test-reporter=lcov', `--test-reporter-destination=${out}`,
    '--test-reporter=dot', '--test-reporter-destination=stdout', ...tests],
  { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 64 << 20 });
  const recs = {};
  let cur = null;
  try {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (line.startsWith('SF:')) cur = { file: path.relative(ROOT, line.slice(3)).split(path.sep).join('/'), fns: [], brf: 0, brh: 0, miss: new Map(), lf: 0, lh: 0 };
      else if (!cur) continue;
      else if (line.startsWith('FN:')) { const [ln, name] = line.slice(3).split(','); cur.fns.push([+ln, name]); }
      else if (line.startsWith('BRDA:')) {
        const [ln, , , hits] = line.slice(5).split(',');
        if (hits === '-' || hits === '0') cur.miss.set(+ln, (cur.miss.get(+ln) || 0) + 1);
      } else if (line.startsWith('BRF:')) cur.brf = +line.slice(4);
      else if (line.startsWith('BRH:')) cur.brh = +line.slice(4);
      else if (line.startsWith('LF:')) cur.lf = +line.slice(3);
      else if (line.startsWith('LH:')) cur.lh = +line.slice(3);
      else if (line === 'end_of_record') { recs[cur.file] = cur; cur = null; }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const json = {};
  for (const f of FILES) {
    const rec = recs[f];
    if (!rec) { console.log(`${f}: absent from Node's report`); continue; }
    const fnAt = (ln) => { let best = '(top)'; for (const [l, n] of rec.fns) if (l <= ln) best = n; return best; };
    const lines = [...rec.miss.keys()].sort((a, b) => a - b);
    console.log(`\n${f}: lines ${(100 * rec.lh / (rec.lf || 1)).toFixed(2)}%, branches ${(100 * rec.brh / (rec.brf || 1)).toFixed(2)}% (${rec.brh}/${rec.brf}), ${lines.length} line(s) with an untaken branch`);
    const byFn = new Map();
    for (const ln of lines) { const n = fnAt(ln); if (!byFn.has(n)) byFn.set(n, []); byFn.get(n).push(ln); }
    for (const [n, ls] of byFn) console.log(`  ${n}: ${ls.join(' ')}`);
    json[f] = { lines_pct: rec.lh / (rec.lf || 1), branches_pct: rec.brh / (rec.brf || 1), untaken: Object.fromEntries(byFn) };
  }
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(json, null, 1));
  const red = r.status !== 0;
  if (red) {
    const names = [...new Set(((r.stdout || '') + (r.stderr || '')).split('\n').filter(l => /^\s*✖/.test(l)).map(l => l.trim()))];
    for (const n of names.slice(0, 10)) console.log(`failed under coverage: ${n}`);
  }
  console.log(red ? `\nFINDING: suite exited ${r.status} under coverage` : '\nok: suite green under coverage (untaken branches listed above)');
  process.exitCode = red ? 1 : 0;
}

main();
