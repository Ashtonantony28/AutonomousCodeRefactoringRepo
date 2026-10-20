#!/usr/bin/env node
'use strict';

// SG22 per-site mutants: editMutants builds and parses up to MUTANT_CAP (3)
// full-file mutants per site, for up to EDIT_MAX_SITES (12) sites per hunk and
// EDIT_MAX_HUNKS (16) hunks, synchronously in the executor (JS: one Babel
// parse of the whole file per candidate; Python: all candidates of a batch
// in one `python3 -c` spawnSync with a 10 s timeout, whose failure counts
// every candidate as unparsable). The edit adds ` + 0` pairs (two sites each:
// swap_arith, numeric_off_by_one) to H functions of a 199 KB file.
// Reports editMutants' wall time (= main-thread block), mutants built, sites
// with at least one mutant, and whether every hunk has a mutant (the executor
// otherwise reverts `tests_insensitive` without running a test).
//
// usage: node audit/14/edit-sites.js [--lang js,py] [--hunks 1,4,16] [--sites 2,6,12]
//          [--file-kb 199] [--contend 0] [--reps 1]

const L = require('./lib');
const { editMutants } = require(L.src('rl/bug-injector'));
const { changeHunks } = require(L.src('utils/hunks'));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LANGS = opt('--lang', 'js,py').split(',');
const HUNKS = opt('--hunks', '1,4,16').split(',').map(Number);
const SITES = opt('--sites', '2,6,12').split(',').map(Number);
const FILE_KB = Number(opt('--file-kb', 199));
const CONTEND = Number(opt('--contend', 0));
const REPS = Number(opt('--reps', 1));

function jsFn(i, extra) { return `function g${i}(a, b) {\n  const t = a * ${i % 9} - b;\n  return t${extra};\n}\n`; }
function pyFn(i, extra) { return `def g${i}(a, b):\n    t = a * ${i % 9} - b\n    return t${extra}\n\n\n`; }

function files(lang, hunks, sites) {
  const fn = lang === 'js' ? jsFn : pyFn;
  const extra = ' + 0'.repeat(Math.max(1, Math.round(sites / 2)));
  let before = lang === 'js' ? "'use strict';\n" : '"""m"""\n';
  let after = before;
  let i = 0;
  const target = FILE_KB * 1024;
  const at = Math.floor(target * 0.9);
  while (before.length < at) { const s = fn(i++, ''); before += s; after += s; }
  for (let h = 0; h < hunks; h++) { before += fn(i, ''); after += fn(i, extra); i++; before += fn(i, ''); after += fn(i, ''); i++; }
  while (before.length < target) { const s = fn(i++, ''); before += s; after += s; }
  return { before, after, file: lang === 'js' ? 'src/m.js' : 'pkg/m.py' };
}

let stop = () => {};
if (CONTEND) stop = L.contend(CONTEND);
console.log(`editMutants on a ${FILE_KB} KB file, ${CONTEND} busy processes; main thread blocked for the whole call`);
console.log(L.row(['lang', 'hunks', 'sites/h', 'p50_ms', 'max_ms', 'mutants', 'sites_hit', 'every_hunk', 'peakMB'], [5, 6, 8, 9, 9, 8, 10, 11, 7]));
try {
  for (const lang of LANGS) {
    for (const h of HUNKS) {
      for (const s of SITES) {
        const { before, after, file } = files(lang, h, s);
        const ms = [];
        let res;
        for (let k = 0; k < REPS; k++) {
          const t0 = performance.now();
          res = editMutants(after, { start: 0, end: after.length, file, max: 3, before });
          ms.push(performance.now() - t0);
        }
        const hunks = changeHunks(before, after, file);
        const sitesHit = new Set(res.map(m => m.site)).size;
        const every = hunks.every((x, i) => res.some(m => m.hunk === i));
        const st = L.stats(ms);
        console.log(L.row([lang, hunks.length, s, L.fmt(st.p50), L.fmt(st.max), res.capped ? 'capped' : res.length, sitesHit, every, L.fmt(L.hwmMb())], [5, 6, 8, 9, 9, 8, 10, 11, 7]));
      }
    }
  }
} finally {
  stop();
}
