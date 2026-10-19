'use strict';

// AUDIT-4: run `node --test test/*.test.js` (what `npm test` runs) N times and
// report wall time, failures, per-test duration spread, and anything a run
// leaves behind.
//
//   node audit/4/repeat.js [runs=5] [--stress]
//
// Each run gets its own private TMPDIR, so every temp dir, worktree and
// leftover process of that run can be attributed to it:
//   - residue: entries left in that TMPDIR (node's compile cache excluded)
//   - processes: any live process whose environment carries that TMPDIR
//   - repo: state/ and dashboard/ in this checkout, and `git status`
// --stress runs 2 CPU-burning processes per core alongside the suite to show
// which assertions depend on wall-clock timing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const RUNS = Number(args.find(a => /^\d+$/.test(a)) || 5);
const STRESS = args.includes('--stress');

function procsWithEnv(value) {
  const out = [];
  for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    if (Number(pid) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes(value)) {
        out.push(`${pid} ${fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 120)}`);
      }
    } catch { /* gone or not ours */ }
  }
  return out;
}

function walk(dir, depth = 2) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node-compile-cache') continue;
    out.push(path.join(dir, e.name));
    if (e.isDirectory() && depth > 1) out.push(...walk(path.join(dir, e.name), depth - 1));
  }
  return out;
}

function parseTap(text) {
  // top-level tests are the "ok N - name" lines indented by 4 (inside a file) when
  // node runs several files; record every leaf with its duration.
  const tests = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/);
    if (!m) continue;
    let dur = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const d = lines[j].match(/duration_ms: ([\d.]+)/);
      if (d) { dur = Number(d[1]); break; }
    }
    tests.push({ indent: m[1].length, ok: m[2] === 'ok', name: m[3], skip: m[4] || null, dur });
  }
  return tests;
}

async function main() {
  const repoStateBefore = ['state', 'dashboard'].map(d => fs.existsSync(path.join(ROOT, d)));
  const statusBefore = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: ROOT, encoding: 'utf8' });
  const burners = [];
  if (STRESS) {
    for (let i = 0; i < os.cpus().length * 2; i++) burners.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
    console.log(`stress: ${burners.length} busy-loop processes on ${os.cpus().length} cpus`);
  }
  const perTest = new Map();
  const summary = [];
  try {
    for (let r = 1; r <= RUNS; r++) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `audit4-run${r}-`));
      const env = { ...process.env, TMPDIR: tmp };
      delete env.NODE_TEST_CONTEXT;
      const tests = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).map(f => path.join('test', f));
      const t0 = Date.now();
      const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 << 20 });
      const wall = Date.now() - t0;
      const parsed = parseTap(res.stdout);
      const leaves = parsed.filter(t => t.indent > 0 || !/\.test\.js$/.test(t.name));
      const failed = leaves.filter(t => !t.ok).map(t => t.name);
      for (const t of leaves) {
        if (t.dur == null || t.skip) continue;
        if (!perTest.has(t.name)) perTest.set(t.name, []);
        perTest.get(t.name).push(t.dur);
      }
      const m = (k) => { const x = res.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return x ? Number(x[1]) : null; };
      // let detached stragglers settle before looking for them
      await new Promise(r2 => setTimeout(r2, 1500));
      const residue = walk(tmp);
      const procs = procsWithEnv(`TMPDIR=${tmp}`);
      summary.push({ run: r, exit: res.status, wall_ms: wall, tests: m('tests'), pass: m('pass'), fail: m('fail'), skipped: m('skipped'), failed, residue: residue.length, procs: procs.length });
      console.log(`run ${r}: exit=${res.status} wall=${wall}ms tests=${m('tests')} pass=${m('pass')} fail=${m('fail')} skipped=${m('skipped')}${failed.length ? ` FAILED: ${failed.join(' | ')}` : ''}`);
      if (residue.length) console.log(`  residue in TMPDIR (${residue.length}):\n    ${residue.slice(0, 15).join('\n    ')}`);
      if (procs.length) console.log(`  live processes from this run:\n    ${procs.join('\n    ')}`);
      for (const p of procs) { try { process.kill(Number(p.split(' ')[0]), 'SIGKILL'); } catch { /* */ } }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    for (const b of burners) b.kill('SIGKILL');
  }

  const walls = summary.map(s => s.wall_ms);
  console.log(`\nwall ms: min=${Math.min(...walls)} max=${Math.max(...walls)} mean=${Math.round(walls.reduce((a, b) => a + b, 0) / walls.length)}`);
  console.log(`runs with failures: ${summary.filter(s => s.fail).length}/${RUNS}; runs with residue: ${summary.filter(s => s.residue).length}; runs with live processes: ${summary.filter(s => s.procs).length}`);

  const spread = [...perTest.entries()].map(([name, d]) => ({ name, min: Math.min(...d), max: Math.max(...d) }))
    .sort((a, b) => b.max - a.max).slice(0, 10);
  console.log('\nslowest tests (min..max ms over runs):');
  for (const s of spread) console.log(`  ${s.min.toFixed(0).padStart(6)}..${s.max.toFixed(0).padStart(6)}  ${s.name}`);

  const repoStateAfter = ['state', 'dashboard'].map(d => fs.existsSync(path.join(ROOT, d)));
  const statusAfter = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: ROOT, encoding: 'utf8' });
  console.log(`\nrepo state/ exists before/after: ${repoStateBefore[0]}/${repoStateAfter[0]}; dashboard/: ${repoStateBefore[1]}/${repoStateAfter[1]}`);
  console.log(`git status --ignored changed: ${statusBefore !== statusAfter ? 'YES\n' + statusAfter : 'no'}`);
  const wts = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(l => l.startsWith('worktree ')).length;
  console.log(`git worktrees registered on this repo: ${wts}`);
}

main();
