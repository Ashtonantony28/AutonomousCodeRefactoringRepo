'use strict';

// AUDIT-26: does a surviving bug-injector mutant change any verdict?
// Runs editMutants (with `before`) on every edit of the audit corpora (13,
// 16, 20, 21, 23), once with src/ as it is and once with the mutant applied
// to a temp copy of src/, and lists the edits whose result differs: the
// uncovered / unmutated / capped / unchecked marks, or the number of sites.
// An edit the real code marks uncovered and the mutated copy gives mutants
// for (no mark) is one the mutant lets through to the mutant runs.
//
//   node audit/26/static-diff.js BI-union [--show]
//
// Prints FINDING (exit 1) when the mutated copy lets an edit through that
// the real code fails closed on; ok otherwise (the mutant is equivalent on
// this corpus).
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BI = 'src/rl/bug-injector.js';
const MUT = {
  'BI-union': { file: BI, from: 's: Math.max(p.s, m.span[0]), e: Math.min(p.e, m.span[1])', to: 's: Math.min(p.s, m.span[0]), e: Math.max(p.e, m.span[1])' },
  'BI-applied': { file: BI, from: '(x.use >= 0 ? x.e === c + 1 :', to: '(x.use >= 0 ? x.e >= c + 1 :' },
  'BI-prefix': { file: BI, from: 'x.prefix && x.e <= o && !src.slice(x.e, o).trim()', to: 'x.prefix' }
};

function corpus() {
  const out = [];
  for (const n of [13, 16, 20, 21, 23]) {
    const { CASES } = require(path.join(ROOT, 'audit', String(n), 'corpus.js'));
    for (const c of CASES) {
      if (!c.cur || !c.prop) continue;
      let file, wrap;
      if (c.py) {
        file = `app/${c.id.toLowerCase()}.py`;
        wrap = (x) => `${c.pre ? `${c.pre}\n` : ''}${x}${c.rest ? `\n${c.rest}` : ''}\n`;
      } else {
        file = `src/${c.id.toLowerCase()}.${c.ext || 'js'}`;
        wrap = (x) => `'use strict';\n${c.pre ? `${c.pre}\n` : ''}${x}\n${c.rest || ''}\n`;
      }
      out.push({ id: `${n}/${c.id}`, file, before: wrap(c.cur), after: wrap(c.prop) });
    }
  }
  return out;
}

function summary(editMutants, e) {
  const r = editMutants(e.after, { file: e.file, before: e.before, max: 3, timeoutMs: 10_000 });
  const mark = r.capped ? 'capped' : r.unchecked ? 'unchecked' : r.unmutated_ref ? `unmutated_ref:${r.unmutated_ref.name}`
    : r.uncovered ? `uncovered:${r.uncovered.text}@${r.uncovered.line}` : null;
  const sites = new Set(r.map(m => `${m.site}${m.revert ? 'r' : ''}`)).size;
  return { mark, sites, mutants: r.length };
}

function main() {
  const id = process.argv[2];
  const show = process.argv.includes('--show');
  const m = MUT[id];
  if (!m) { console.log(`usage: static-diff.js ${Object.keys(MUT).join('|')}`); process.exitCode = 2; return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit26-sd-'));
  try {
    fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const f = path.join(dir, m.file), text = fs.readFileSync(f, 'utf8');
    if (text.split(m.from).length !== 2) throw new Error(`pattern not found once in ${m.file}`);
    fs.writeFileSync(f, text.replace(m.from, () => m.to));
    const real = require(path.join(ROOT, BI)).editMutants;
    const mut = require(path.join(dir, BI)).editMutants;
    let differ = 0, through = 0, n = 0;
    for (const e of corpus()) {
      n++;
      const x = summary(real, e), y = summary(mut, e);
      if (x.mark === y.mark && x.sites === y.sites) { if (show) console.log(`same    ${e.id} ${JSON.stringify(x)}`); continue; }
      differ++;
      const lets = !!x.mark && x.mark.startsWith('uncovered') && !y.mark && y.mutants > 0;
      if (lets) through++;
      console.log(`${lets ? 'FINDING ' : 'differs '}${e.id}: real ${JSON.stringify(x)} mutated ${JSON.stringify(y)}`);
    }
    console.log(`${id}: ${n} corpus edits, ${differ} differ, ${through} let through by the mutant`);
    console.log(through ? `FINDING ${id}: the mutant lets ${through} corpus edit(s) through that the real code fails closed on`
      : `ok ${id}: no corpus edit is let through (the mutant is equivalent on this corpus)`);
    process.exitCode = through ? 1 : 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
