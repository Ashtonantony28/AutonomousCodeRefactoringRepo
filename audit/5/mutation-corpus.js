'use strict';

// AUDIT-5 mutation + benign corpus through the real orchestrator gate
// (critic jury -> AST checks -> diff test -> vetoes -> criticGate -> learned
// gate), dry run: `dry_run` = would have been executed.
//
// Each mutant runs twice:
//   U: most favourable critic (3/3 approve, p 0.9)
//   M: split jury (2/3 approve, mean p 0.6) - passes only on an `equivalent` diff test
// and first has its behaviour change confirmed by a witness in real node/python.
//
//   node audit/5/mutation-corpus.js            # table + rates
//   node audit/5/mutation-corpus.js --json
//   node audit/5/mutation-corpus.js --only OM3,RX8
//   node audit/5/mutation-corpus.js --benign   # benign corpus only; FINDING if any safe refactor is rejected
// Prints FINDING and exits 1 when any mutant reaches the executor stage.

const { makeRepo, throughGate, rm, UNANIMOUS, MAJORITY, witness, pyWitness } = require('./lib');
const { MUTANTS, PY_MUTANTS, BENIGN, targets9 } = require('./corpus');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const benignOnly = args.includes('--benign');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

function nameOf(src) {
  const m = /(?:function|class)\s+(\w+)/.exec(src);
  return m ? m[1] : null;
}

function build(e) {
  if (e.gen === 'targets9') Object.assign(e, targets9());
  if (e.py) {
    const file = `pkg/m_${e.id.toLowerCase()}.py`;
    return { file, files: { 'pkg/__init__.py': '', [file]: `${e.pre || ''}\n${e.cur}` } };
  }
  const file = `src/${e.id}.${e.esm ? 'mjs' : 'js'}`;
  const exp = e.exp !== undefined ? e.exp : `module.exports = { ${nameOf(e.cur)} };`;
  const head = e.esm ? '' : "'use strict';\n";
  return { file, files: { ...(e.extra || {}), [file]: `${head}${e.pre || ''}\n${e.cur}\n${exp}\n` } };
}

async function gate(e, critic) {
  const { file, files } = build(e);
  const repo = makeRepo(files);
  try {
    const { proposal: p } = await throughGate({ repo, file, current: e.cur, proposed: e.prop, critic });
    const dt = p.diff_test || {};
    return {
      status: p.test_outcome && p.test_outcome.status,
      dt: dt.verdict,
      dt_reason: dt.reason || null,
      runs: dt.runs,
      failed_checks: (p.pattern_check_results || []).filter(c => !c.passed).map(c => c.check_name),
      why: (p.test_outcome && (p.test_outcome.reason || (p.test_outcome.reasons || []).join('; '))) || null
    };
  } finally { rm(repo); }
}

(async () => {
  const quiet = console.log;
  const rows = [];
  const mutants = [...MUTANTS, ...PY_MUTANTS.map(m => ({ ...m, py: true, cat: 'python' }))].filter(m => !benignOnly && (!only || only.has(m.id)));
  for (const m of mutants) {
    const { file, files } = build(m);
    let w = null;
    if (m.w) w = (m.py ? pyWitness : witness)({ files, file, cur: m.cur, prop: m.prop, expr: m.w });
    console.log = () => {};
    let U, M;
    try {
      U = await gate(m, UNANIMOUS);
      M = await gate(m, MAJORITY);
    } finally { console.log = quiet; }
    rows.push({ id: m.id, cat: m.cat, kind: m.kind, witness: w, valid: !w || w.cur !== w.prop, U, M });
  }
  const benign = [];
  for (const b of BENIGN.filter(x => !only || only.has(x.id))) {
    console.log = () => {};
    let U;
    try { U = await gate(b, UNANIMOUS); } finally { console.log = quiet; }
    benign.push({ id: b.id, kind: b.kind, U });
  }

  const escU = rows.filter(r => r.valid && r.U.status === 'dry_run');
  const escM = rows.filter(r => r.valid && r.M.status === 'dry_run');
  const invalid = rows.filter(r => !r.valid);
  const accepted = benign.filter(b => b.U.status === 'dry_run');

  if (asJson) {
    console.log(JSON.stringify({ rows, benign }, null, 2));
  } else {
    for (const r of rows) {
      const tag = !r.valid ? 'BADMUTANT' : r.U.status === 'dry_run' ? (r.M.status === 'dry_run' ? 'ESCAPED(U+M)' : 'ESCAPED(U)') : 'caught';
      console.log(`${r.id.padEnd(5)} ${tag.padEnd(12)} U=${r.U.status}/${r.U.dt}(runs=${r.U.runs}) M=${r.M.status}  -- ${r.kind}`);
      if (r.U.status === 'dry_run' || !r.valid) {
        console.log(`        dt reason: ${r.U.dt_reason || '-'}; failed_checks=[${r.U.failed_checks}]`);
        if (r.witness) console.log(`        witness ${JSON.stringify(r.witness)}`);
      }
    }
    console.log('');
    for (const b of benign) {
      console.log(`${b.id.padEnd(5)} ${b.U.status === 'dry_run' ? 'accepted' : 'REJECTED'} ${b.U.status}/${b.U.dt}  -- ${b.kind}${b.U.status !== 'dry_run' ? `\n        ${b.U.why || ''}` : ''}`);
    }
    const pct = (a, b) => `${a}/${b} = ${(100 * a / Math.max(1, b)).toFixed(1)}%`;
    const valid = rows.filter(r => r.valid);
    const js = valid.filter(r => r.cat !== 'python');
    const py = valid.filter(r => r.cat === 'python');
    console.log('');
    console.log(`mutants: ${rows.length} (${invalid.length} invalid witness)`);
    console.log(`escape, unanimous critic:  ${pct(escU.length, valid.length)}  (JS ${escU.filter(r => r.cat !== 'python').length}/${js.length}, Python ${escU.filter(r => r.cat === 'python').length}/${py.length})`);
    console.log(`escape, 2/3 critic:        ${pct(escM.length, valid.length)}  (diff test said equivalent)`);
    console.log(`benign false rejection:    ${pct(benign.length - accepted.length, benign.length)}`);
  }
  if (benignOnly) {
    const rate = (benign.length - accepted.length) / Math.max(1, benign.length);
    console.log(rate > 0 ? `FINDING: benign over-rejection ${(100 * rate).toFixed(1)}%` : 'ok');
    process.exit(rate > 0 ? 1 : 0);
  }
  if (escU.length) {
    console.log(`FINDING: ${escU.length} semantics-changing edits reach the executor (${escM.length} with a 2/3 jury): ${escU.map(r => r.id).join(', ')}`);
    process.exit(1);
  }
  console.log('ok');
})();
