'use strict';

// AUDIT-13 end-to-end runner: every corpus entry (audit/13/corpus.js) is run
// non-dry through the real orchestrator (stub critic: 3/3 approve, p 0.9, no
// edge cases): worktree on refactor/<run_id>, the entry's own suite (node
// --test / pytest + coverage.py), per-site mutants, commit. A real node /
// python witness confirms each entry changes observable behaviour.
// Temp REFACTOR_STATE_DIR via test/helpers/env.js (audit/1/lib.js); stub
// client only; never touches state/, dashboard/, src/ or test/.
//
//   node audit/13/run.js                 # whole corpus
//   node audit/13/run.js --only A01,P03  # some
//   node audit/13/run.js --json out.json # also write rows
// Prints FINDING and exits 1 when any witnessed semantics change is committed.

const fs = require('fs');
const { e2e, UNANIMOUS, pytestWithCoverageDir, witness, pyWitness } = require('../5/lib');
const { CASES } = require('./corpus');

const NODE_PKG = { scripts: { test: 'node --test' } };

function filesFor(c) {
  const extra = c.extra || {};
  if (c.py) {
    const file = c.file || `app/${c.id.toLowerCase()}.py`;
    const mod = file.replace(/\.py$/, '').split('/').join('.');
    const src = `${c.pre ? `${c.pre}\n` : ''}${c.cur}${c.rest ? `\n${c.rest}` : ''}`;
    const test = `import ${mod} as m\n\n\n${c.test}`;
    return { file, pkg: null, files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', ...extra, [file]: src, [`tests/test_${c.id.toLowerCase()}.py`]: test } };
  }
  const file = c.file || `src/${c.id.toLowerCase()}.js`;
  const src = `'use strict';\n${c.pre ? `${c.pre}\n` : ''}${c.cur}\n${c.rest}\n`;
  const test = `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../${file.replace(/\.js$/, '')}');\n${c.test}\n`;
  return { file, pkg: NODE_PKG, files: { ...extra, [file]: src, [`test/${c.id.toLowerCase()}.test.js`]: test } };
}

async function runCase(c) {
  const { file, files, pkg } = filesFor(c);
  const wit = (c.py ? pyWitness : witness)({ files, file, cur: c.cur, prop: c.prop, expr: c.w });
  const valid = wit.cur !== wit.prop && !/harness-error/.test(wit.cur + wit.prop);
  const quiet = console.log, qw = console.warn;
  console.log = () => {}; console.warn = () => {};
  let r;
  try { r = await e2e({ files, pkg: pkg || {}, file, cur: c.cur, prop: c.prop, critic: UNANIMOUS }); } finally { console.log = quiet; console.warn = qw; }
  const p = r.proposal;
  const o = p.test_outcome || {};
  const dt = p.diff_test || {};
  const mut = o.mutation || null;
  return {
    id: c.id, py: !!c.py, cat: c.cat, kind: c.kind, valid, witness: wit,
    status: o.status, reason: o.reason || (o.reasons || []).join('; ') || (p.veto ? p.veto.reasons.join('; ') : null),
    dt: dt.verdict, runs: dt.runs, dt_reason: dt.reason || null, obs: dt.deletions_observed,
    failed_checks: (p.pattern_check_results || []).filter(x => !x.passed).map(x => x.check_name),
    mutation: mut && { hunks: mut.hunks, mutants: mut.mutants, sites: mut.sites, run: mut.run, killed: mut.killed, killed_line: mut.killed_line },
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
    const tag = !r.valid ? 'BADWITNESS' : r.commit ? 'COMMITTED' : 'stopped';
    const m = r.mutation ? ` mut(h=${r.mutation.hunks} sites=${r.mutation.sites} mutants=${r.mutation.mutants} run=${r.mutation.run} killed=${r.mutation.killed})` : '';
    console.log(`${r.id.padEnd(4)} ${tag.padEnd(10)} ${r.status}${r.reason ? `(${String(r.reason).slice(0, 90)})` : ''} dt=${r.dt}(runs=${r.runs}${r.obs === undefined ? '' : ` obs=${r.obs}`})${r.failed_checks.length ? ` checks=[${r.failed_checks}]` : ''}${m} -- ${r.kind}`);
    if (r.commit || !r.valid) console.log(`        witness cur=${String(r.witness.cur).slice(0, 80)} prop=${String(r.witness.prop).slice(0, 80)}`);
    if (r.commit) console.log(`        committed ${r.commit.slice(0, 12)}: ${r.diff.join(' | ').slice(0, 220)}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
  const valid = rows.filter(r => r.valid);
  const committed = valid.filter(r => r.commit);
  const by = (f) => { const o = {}; for (const r of valid) { const k = f(r); o[k] = (o[k] || 0) + 1; } return o; };
  console.log('');
  console.log(`entries: ${rows.length} (${rows.length - valid.length} bad witness); JS ${valid.filter(r => !r.py).length}, Python ${valid.filter(r => r.py).length}`);
  console.log(`outcomes: ${JSON.stringify(by(r => (r.commit ? 'committed' : `${r.status}${r.status === 'reverted' ? `:${r.reason}` : ''}`)))}`);
  console.log(`reached the executor: ${valid.filter(r => !['vetoed', 'critic_rejected', 'rl_rejected'].includes(r.status)).length}/${valid.length}`);
  for (const cat of [...new Set(valid.map(r => r.cat))]) {
    const all = valid.filter(r => r.cat === cat);
    console.log(`  ${cat.padEnd(16)} committed ${all.filter(r => r.commit).length}/${all.length} ${all.filter(r => r.commit).map(r => r.id).join(' ')}`);
  }
  if (committed.length) {
    console.log(`FINDING: ${committed.length} witnessed semantics-changing edits committed: ${committed.map(r => r.id).join(', ')}`);
    process.exit(1);
  }
  console.log('ok');
})();
