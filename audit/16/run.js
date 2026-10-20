'use strict';

// AUDIT-16 end-to-end runner: every corpus entry (audit/16/corpus.js) is run
// non-dry through the real orchestrator (stub critic: 3/3 approve, p 0.9, no
// edge cases): worktree on refactor/<run_id>, the entry's own suite (node
// --test / pytest + coverage.py), per-site mutants, commit. A real node /
// python witness confirms each entry changes observable behaviour, and the
// suite is run on the CURRENT version too (it must pass before the edit).
// Temp REFACTOR_STATE_DIR via test/helpers/env.js (audit/1/lib.js); stub
// client only; never touches state/, dashboard/, src/ or test/.
//
//   node audit/16/run.js                 # whole corpus
//   node audit/16/run.js --only K01,N02  # some
//   node audit/16/run.js --json out.json # also write rows
// Prints FINDING and exits 1 when any witnessed semantics change is committed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { e2e, UNANIMOUS, pytestWithCoverageDir, witness, pyWitness } = require('../5/lib');
const { CASES } = require('./corpus');

const NODE_PKG = { scripts: { test: 'node --test' } };

function filesFor(c) {
  const extra = c.extra || {};
  if (c.py) {
    const file = c.file || `app/${c.id.toLowerCase()}.py`;
    const mod = file.replace(/\.py$/, '').split('/').join('.');
    const src = `${c.pre ? `${c.pre}\n` : ''}${c.cur}${c.rest ? `\n${c.rest}` : ''}`;
    const test = c.testRaw ? c.test : `import ${mod} as m\n\n\n${c.test}`;
    return { file, pkg: null, files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', ...extra, [file]: src, [`tests/test_${c.id.toLowerCase()}.py`]: test } };
  }
  const file = c.file || `src/${c.id.toLowerCase()}.js`;
  const src = `'use strict';\n${c.pre ? `${c.pre}\n` : ''}${c.cur}\n${c.rest}\n`;
  const test = `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../${file.replace(/\.js$/, '')}');\n${c.test}\n`;
  return { file, pkg: NODE_PKG, files: { ...extra, [file]: src, [`test/${c.id.toLowerCase()}.test.js`]: test } };
}

function pytestPython() {
  const dir = pytestWithCoverageDir();
  if (!dir) return null;
  const head = fs.readFileSync(path.join(dir, 'pytest'), 'utf8').split('\n')[0];
  const m = head.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
  return path.basename(m[1]) === 'env' ? m[2] : m[1];
}

// The entry's suite must pass on the CURRENT version (run in a scratch dir).
function suitePassesOnCurrent({ files, py }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit16-suite-'));
  try {
    for (const [rel, src] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), src);
    }
    if (py) execFileSync(pytestPython(), ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], { cwd: dir, stdio: 'pipe', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    else execFileSync(process.execPath, ['--test'], { cwd: dir, stdio: 'pipe', timeout: 60_000 });
    return true;
  } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runCase(c) {
  const { file, files, pkg } = filesFor(c);
  const wit = (c.py ? pyWitness : witness)({ files, file, cur: c.cur, prop: c.prop, expr: c.w });
  const witnessOk = wit.cur !== wit.prop && !/harness-error/.test(wit.cur + wit.prop);
  const suiteOk = suitePassesOnCurrent({ files, py: !!c.py });
  const quiet = console.log, qw = console.warn;
  console.log = () => {}; console.warn = () => {};
  let r;
  try { r = await e2e({ files, pkg: pkg || {}, file, cur: c.cur, prop: c.prop, critic: UNANIMOUS }); } finally { console.log = quiet; console.warn = qw; }
  const p = r.proposal;
  const o = p.test_outcome || {};
  const dt = p.diff_test || {};
  const mut = o.mutation || null;
  return {
    id: c.id, py: !!c.py, cat: c.cat, kind: c.kind, valid: witnessOk && suiteOk, witnessOk, suiteOk, witness: wit,
    status: o.status, reason: o.reason || (o.reasons || []).join('; ') || (p.veto ? p.veto.reasons.join('; ') : null),
    dt: dt.verdict, runs: dt.runs, dt_reason: dt.reason || null, obs: dt.deletions_observed,
    failed_checks: (p.pattern_check_results || []).filter(x => !x.passed).map(x => x.check_name),
    mutation: mut && {
      hunks: mut.hunks, mutants: mut.mutants, sites: mut.sites, run: mut.run, killed: mut.killed, killed_line: mut.killed_line,
      unmutated_ref: mut.unmutated_ref, surviving_ref: mut.surviving_ref, collection_errors: mut.collection_errors
    },
    commit: r.commit || null,
    diff: r.committedDiff ? r.committedDiff.split('\n').filter(l => /^[-+][^-+]/.test(l)) : null
  };
}

(async () => {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const hasPy = !!pytestWithCoverageDir();
  const rows = [];
  for (const c of CASES.filter(x => !only || only.has(x.id))) {
    if (c.py && !hasPy) { console.log(`${c.id} skipped: no pytest with coverage.py`); continue; }
    const r = await runCase(c);
    rows.push(r);
    const tag = !r.witnessOk ? 'BADWITNESS' : !r.suiteOk ? 'BADSUITE' : r.commit ? 'COMMITTED' : 'stopped';
    const u = r.mutation || {};
    const m = r.mutation ? ` mut(h=${u.hunks} sites=${u.sites} mutants=${u.mutants} run=${u.run} killed=${u.killed}${u.killed_line ? `@${u.killed_line}` : ''}` +
      `${u.unmutated_ref ? ` unmutated_ref=${u.unmutated_ref}` : ''}${u.surviving_ref ? ` surviving_ref=${u.surviving_ref}` : ''}${u.collection_errors ? ` collection_errors=${u.collection_errors}` : ''})` : '';
    console.log(`${r.id.padEnd(4)} ${tag.padEnd(10)} ${r.status}${r.reason ? `(${String(r.reason).slice(0, 90)})` : ''} dt=${r.dt}(runs=${r.runs}${r.obs === undefined ? '' : ` obs=${r.obs}`})${r.failed_checks.length ? ` checks=[${r.failed_checks}]` : ''}${m} -- ${r.kind}`);
    if (r.commit || !r.valid) console.log(`        witness cur=${String(r.witness.cur).slice(0, 80)} prop=${String(r.witness.prop).slice(0, 80)}`);
    if (r.commit) console.log(`        committed ${r.commit.slice(0, 12)}: ${r.diff.join(' | ').slice(0, 220)}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  const valid = rows.filter(r => r.valid);
  const committed = valid.filter(r => r.commit);
  const by = (f) => { const o = {}; for (const r of valid) { const k = f(r); o[k] = (o[k] || 0) + 1; } return o; };
  console.log('');
  console.log(`entries: ${rows.length} (${rows.length - valid.length} bad witness/suite); JS ${valid.filter(r => !r.py).length}, Python ${valid.filter(r => r.py).length}`);
  console.log(`outcomes: ${JSON.stringify(by(r => (r.commit ? 'committed' : `${r.status}${r.status === 'reverted' ? `:${r.reason}` : ''}`)))}`);
  console.log(`reached the executor: ${valid.filter(r => !['vetoed', 'critic_rejected', 'rl_rejected'].includes(r.status)).length}/${valid.length}`);
  for (const cat of [...new Set(valid.map(r => r.cat))]) {
    const all = valid.filter(r => r.cat === cat);
    console.log(`  ${cat.padEnd(12)} committed ${all.filter(r => r.commit).length}/${all.length} ${all.filter(r => r.commit).map(r => r.id).join(' ')}`);
  }
  if (committed.length) {
    console.log(`FINDING: ${committed.length} witnessed semantics-changing edits committed: ${committed.map(r => r.id).join(', ')}`);
    process.exit(1);
  }
  console.log('ok');
})();
