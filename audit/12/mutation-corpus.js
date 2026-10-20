'use strict';

// AUDIT-12 corpus (audit/12/corpus.js) through the real orchestrator gate
// (critic jury -> AST/polyglot checks -> diff test -> vetoes -> criticGate ->
// learned gate), dry run: `dry_run` = would have been executed. Uses the
// AUDIT-5 harness (stub client, temp REFACTOR_STATE_DIR via test/helpers/env.js).
//
// Each mutant: witness in real node/python first (must differ), then the gate
// with the most favourable critic (3/3 approve, p 0.9, no edge cases).
// An escape is a witnessed semantics change the diff test called
// `equivalent`. `obs` is the diff test's deletions_observed (pure deletions
// with obs=true need no killed mutant in the executor).
//
//   node audit/12/mutation-corpus.js              # mutants + benign
//   node audit/12/mutation-corpus.js --only J50,P20
//   node audit/12/mutation-corpus.js --benign     # benign only
// Prints FINDING and exits 1 when any witnessed mutant reaches the executor
// (or, with --benign, when a benign refactor is rejected).

const { makeRepo, throughGate, rm, UNANIMOUS, witness, pyWitness } = require('../5/lib');
const { MUTANTS, PY_MUTANTS, BENIGN, PY_BENIGN } = require('./corpus');

const args = process.argv.slice(2);
const benignOnly = args.includes('--benign');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

function nameOf(src) {
  const m = /(?:function\*?|class)\s+(\w+)/.exec(src);
  return m ? m[1] : null;
}

function build(e) {
  if (e.py) {
    const file = `pkg/m_${e.id.toLowerCase()}.py`;
    return { file, files: { 'pkg/__init__.py': '', [file]: `${e.pre || ''}\n${e.cur}` } };
  }
  const file = `src/${e.id}.js`;
  const exp = e.exp !== undefined ? e.exp : `module.exports = { ${nameOf(e.cur)} };`;
  return { file, files: { [file]: `'use strict';\n${e.pre || ''}\n${e.cur}\n${exp}\n` } };
}

async function gate(e) {
  const { file, files } = build(e);
  const repo = makeRepo(files);
  try {
    const { proposal: p } = await throughGate({ repo, file, current: e.cur, proposed: e.prop, critic: UNANIMOUS });
    const dt = p.diff_test || {};
    return {
      status: p.test_outcome && p.test_outcome.status,
      dt: dt.verdict, runs: dt.runs, dt_reason: dt.reason || null, obs: dt.deletions_observed,
      failed_checks: (p.pattern_check_results || []).filter(c => !c.passed).map(c => c.check_name),
      why: (p.test_outcome && (p.test_outcome.reason || (p.test_outcome.reasons || []).join('; '))) || (p.veto ? p.veto.reasons.join('; ') : null)
    };
  } finally { rm(repo); }
}

(async () => {
  const quiet = console.log;
  const rows = [];
  const mutants = benignOnly ? [] : [...MUTANTS, ...PY_MUTANTS.map(m => ({ ...m, py: true }))].filter(m => !only || only.has(m.id));
  for (const m of mutants) {
    const { file, files } = build(m);
    const w = (m.py ? pyWitness : witness)({ files, file, cur: m.cur, prop: m.prop, expr: m.w });
    const valid = w.cur !== w.prop && !/harness-error/.test(w.cur + w.prop);
    console.log = () => {};
    let U;
    try { U = await gate(m); } finally { console.log = quiet; }
    rows.push({ id: m.id, py: !!m.py, cat: m.cat, kind: m.kind, witness: w, valid, U });
  }
  const benign = [];
  for (const b of [...BENIGN, ...PY_BENIGN.map(x => ({ ...x, py: true }))].filter(x => !only || only.has(x.id))) {
    console.log = () => {};
    let U;
    try { U = await gate(b); } finally { console.log = quiet; }
    benign.push({ id: b.id, py: !!b.py, kind: b.kind, U });
  }

  const valid = rows.filter(r => r.valid);
  const esc = valid.filter(r => r.U.status === 'dry_run');
  for (const r of rows) {
    const tag = !r.valid ? 'BADMUTANT' : r.U.status === 'dry_run' ? 'ESCAPED' : 'caught';
    console.log(`${r.id.padEnd(4)} ${tag.padEnd(9)} ${r.U.status}/${r.U.dt}(runs=${r.U.runs}${r.U.obs === undefined ? '' : ` obs=${r.U.obs}`})  -- ${r.kind}`);
    if (r.U.status === 'dry_run' || !r.valid) console.log(`        witness ${JSON.stringify(r.witness).slice(0, 200)}`);
    else console.log(`        ${String(r.U.why || r.U.dt_reason || '').slice(0, 160)}`);
  }
  const pct = (a, b) => `${a}/${b} = ${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  if (rows.length) {
    console.log('');
    console.log(`mutants: ${rows.length} (${rows.length - valid.length} invalid witness)`);
    for (const c of [...new Set(valid.map(r => r.cat))]) {
      const all = valid.filter(r => r.cat === c);
      const e = all.filter(r => r.U.status === 'dry_run');
      console.log(`  ${c.padEnd(12)} ${e.length}/${all.length} escaped ${e.map(r => r.id).join(' ')}`);
    }
    const js = valid.filter(r => !r.py), py = valid.filter(r => r.py);
    console.log(`escape, unanimous critic: ${pct(esc.length, valid.length)}  (JS ${esc.filter(r => !r.py).length}/${js.length}, Python ${esc.filter(r => r.py).length}/${py.length})`);
  }
  if (benign.length) {
    console.log('');
    for (const b of benign) {
      const ok = b.U.status === 'dry_run';
      if (!ok) console.log(`${b.id.padEnd(4)} REJECTED ${b.U.status}/${b.U.dt}  -- ${b.kind}\n        ${String(b.U.why || b.U.dt_reason || '').slice(0, 200)}`);
    }
    const bjs = benign.filter(b => !b.py), bpy = benign.filter(b => b.py);
    const rej = (l) => l.filter(b => b.U.status !== 'dry_run').length;
    console.log(`benign false rejection (gate): ${pct(rej(benign), benign.length)}  (JS ${rej(bjs)}/${bjs.length}, Python ${rej(bpy)}/${bpy.length})`);
  }
  if (esc.length) {
    console.log(`FINDING: ${esc.length} witnessed semantics-changing edits reach the executor: ${esc.map(r => r.id).join(', ')}`);
    process.exit(1);
  }
  if (benignOnly && benign.some(b => b.U.status !== 'dry_run')) {
    console.log('FINDING: benign refactors rejected');
    process.exit(1);
  }
  console.log('ok');
})();
