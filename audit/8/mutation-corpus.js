'use strict';

// AUDIT-8 corpus (audit/8/corpus.js) through the real orchestrator gate
// (critic jury -> AST/polyglot checks -> diff test -> vetoes -> criticGate ->
// learned gate), dry run: `dry_run` = would have been executed. Uses the
// AUDIT-5 harness (stub client, temp REFACTOR_STATE_DIR via test/helpers/env.js).
//
// Each mutant: witness in real node/python first (must differ), then the gate
// with the most favourable critic (U: 3/3 approve, p 0.9, no edge cases).
// Escapes are split by what let them through:
//   equivalent  - the diff test certified the change (JS)
//   lexical     - non-JS, no diff test; the Python lexical checks passed
//
//   node audit/8/mutation-corpus.js              # mutants + benign
//   node audit/8/mutation-corpus.js --only LG1,PA3
//   node audit/8/mutation-corpus.js --benign     # benign only
//   node audit/8/mutation-corpus.js --json
// Prints FINDING and exits 1 when any witnessed mutant reaches the executor.

const { makeRepo, throughGate, rm, UNANIMOUS, witness, pyWitness } = require('../5/lib');
const { MUTANTS, PY_MUTANTS, BENIGN } = require('./corpus');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const benignOnly = args.includes('--benign');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

function nameOf(src) {
  const m = /(?:function|class)\s+(\w+)/.exec(src);
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
      dt: dt.verdict, runs: dt.runs, dt_reason: dt.reason || null,
      failed_checks: (p.pattern_check_results || []).filter(c => !c.passed).map(c => c.check_name),
      why: (p.test_outcome && (p.test_outcome.reason || (p.test_outcome.reasons || []).join('; '))) || null
    };
  } finally { rm(repo); }
}

(async () => {
  const quiet = console.log;
  const rows = [];
  const mutants = benignOnly ? [] : [...MUTANTS, ...PY_MUTANTS.map(m => ({ ...m, py: true, cat: 'python' }))].filter(m => !only || only.has(m.id));
  for (const m of mutants) {
    const { file, files } = build(m);
    const w = (m.py ? pyWitness : witness)({ files, file, cur: m.cur, prop: m.prop, expr: m.w });
    const valid = w.cur !== w.prop && !/harness-error/.test(w.cur + w.prop);
    console.log = () => {};
    let U;
    try { U = await gate(m); } finally { console.log = quiet; }
    rows.push({ id: m.id, cat: m.cat, kind: m.kind, witness: w, valid, U });
  }
  const benign = [];
  for (const b of BENIGN.filter(x => !only || only.has(x.id))) {
    console.log = () => {};
    let U;
    try { U = await gate(b); } finally { console.log = quiet; }
    benign.push({ id: b.id, py: !!b.py, kind: b.kind, U });
  }

  const valid = rows.filter(r => r.valid);
  const esc = valid.filter(r => r.U.status === 'dry_run');
  const accepted = benign.filter(b => b.U.status === 'dry_run');

  if (asJson) {
    console.log(JSON.stringify({ rows, benign }, null, 2));
  } else {
    for (const r of rows) {
      const tag = !r.valid ? 'BADMUTANT' : r.U.status === 'dry_run' ? 'ESCAPED' : 'caught';
      console.log(`${r.id.padEnd(5)} ${tag.padEnd(9)} ${r.U.status}/${r.U.dt}(runs=${r.U.runs})  -- ${r.kind}`);
      if (r.U.status === 'dry_run' || !r.valid) {
        console.log(`        failed_checks=[${r.U.failed_checks}] witness ${JSON.stringify(r.witness).slice(0, 220)}`);
      }
    }
    console.log('');
    for (const b of benign) {
      const ok = b.U.status === 'dry_run';
      console.log(`${b.id.padEnd(5)} ${ok ? 'accepted' : 'REJECTED'} ${b.U.status}/${b.U.dt}  -- ${b.kind}${ok ? '' : `\n        ${(b.U.why || '').slice(0, 200)}`}`);
    }
    const pct = (a, b) => `${a}/${b} = ${(100 * a / Math.max(1, b)).toFixed(1)}%`;
    if (rows.length) {
      const js = valid.filter(r => r.cat !== 'python');
      const py = valid.filter(r => r.cat === 'python');
      const cats = [...new Set(valid.map(r => r.cat))];
      console.log('');
      console.log(`mutants: ${rows.length} (${rows.length - valid.length} invalid witness)`);
      for (const c of cats) {
        const all = valid.filter(r => r.cat === c);
        const e = all.filter(r => r.U.status === 'dry_run');
        console.log(`  ${c.padEnd(12)} ${e.length}/${all.length} escaped ${e.map(r => r.id).join(' ')}`);
      }
      console.log(`escape, unanimous critic: ${pct(esc.length, valid.length)}  (JS ${esc.filter(r => r.cat !== 'python').length}/${js.length} via diff test equivalent, Python ${esc.filter(r => r.cat === 'python').length}/${py.length} via lexical checks)`);
    }
    if (benign.length) {
      const bjs = benign.filter(b => !b.py), bpy = benign.filter(b => b.py);
      const rej = (l) => l.filter(b => b.U.status !== 'dry_run').length;
      console.log(`benign false rejection (gate): ${pct(benign.length - accepted.length, benign.length)}  (JS ${rej(bjs)}/${bjs.length}, Python ${rej(bpy)}/${bpy.length})`);
    }
  }
  if (esc.length) {
    console.log(`FINDING: ${esc.length} witnessed semantics-changing edits reach the executor: ${esc.map(r => r.id).join(', ')}`);
    process.exit(1);
  }
  if (benignOnly && accepted.length < benign.length) {
    console.log(`FINDING: ${benign.length - accepted.length} benign refactors rejected`);
    process.exit(1);
  }
  console.log('ok');
})();
