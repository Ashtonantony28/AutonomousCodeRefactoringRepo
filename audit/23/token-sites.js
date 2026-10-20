'use strict';

// AUDIT-23 H1, C1, H3 and M4 at unit level: what `bug-injector.editMutants`
// asks the suite to kill for edits whose change is carried by punctuation,
// indentation, a backslash-continued string, a token inside a wrapper's
// use-site span, or a slid insertion. FINDING when the edit gets mutants (so
// the hunk can stand on them) while the token that carries the change has
// no mutant of its own. Controls print ok when the rule holds.
//
//   node audit/23/token-sites.js
//
// No pipeline run, no API, no state dir: pure functions on strings.

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));
const { changeHunks } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'hunks'));

const L = (...l) => l.join('\n');

// [label, file, before, after, check(info) -> null (rule holds) | string (finding)]
// info: { ins: inserted token texts, muts: [{ mutation, site, ref, span }], flags }
const carriers = (want) => (i) => {
  if (i.flags.uncovered || i.flags.unmutated_ref || !i.muts.length) return null;
  const free = want.filter(w => i.ins.includes(w));
  return free.length ? `change carried by ${JSON.stringify(free)} (no mutant); hunk judged on ${JSON.stringify(i.muts.map(m => `${m.mutation}@${m.at}`))}` : null;
};
const noUse = (name) => (i) => {
  if (i.flags.uncovered || i.flags.unmutated_ref || !i.muts.length) return null;
  return i.muts.some(m => m.ref === name) ? null : `inserted read \`${name}\` has no use site; mutants ${JSON.stringify(i.muts.map(m => `${m.mutation}@${m.at}`))}`;
};
const spanOnly = (tok) => (i) => {
  if (i.flags.uncovered || !i.muts.length) return null;
  const by = i.muts.filter(m => m.spanText.includes(tok));
  return by.length && by.every(m => m.mutation === 'use_site') ? `\`${tok}\` has no mutant; covered only by ${JSON.stringify(by.map(m => `use_site(${m.ref})`))}` : null;
};
const slid = (i) => {
  const u = i.muts.find(m => m.mutation === 'use_site' && m.ref === 'String');
  return u && u.argIndex === 0 ? `inserted \`String(t),\` slid to argument 0: the use-site mutant perturbs the argument that was already there (${u.atText})` : null;
};

const ROWS = [
  ['punct JS braces (P01)', 'src/x.js',
    L('function f(s) {', '  let out = String(s);', '  if (out.length > 4096) out = out.slice(0, 4096);', "  out = out.normalize('NFC');", '  return out;', '}', ''),
    L('function f(s) {', '  let out = String(s);', '  if (out.length > 4096) { out = out.slice(0, 4096);', '  out = out.normalize("NFC"); }', '  return out;', '}', ''), carriers(['{', '}'])],
  ['punct JS parens (P03)', 'src/x.js',
    L('function f(p, s) {', "  return String(p) + String(s).normalize('NFC');", '}', ''),
    L('function f(p, s) {', '  return (String(p) + String(s)).normalize("NFC");', '}', ''), carriers(['(', ')'])],
  ['punct Py parens (P05)', 'app/x.py',
    L('import unicodedata', 'def f(p, s):', "    return unicodedata.normalize('NFC', str(p)) + str(s)", ''),
    L('import unicodedata', 'def f(p, s):', '    return unicodedata.normalize("NFC", str(p) + str(s))', ''), carriers([')'])],
  ['indent Py block (I01)', 'app/x.py',
    L('import unicodedata', 'def f(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "    out = unicodedata.normalize('NFC', out)", '    return out', ''),
    L('import unicodedata', 'def f(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', '        out = unicodedata.normalize("NFC", out)', '    return out', ''), carriers(['        '])],
  ['cont JS continued string (C01)', 'src/x.js',
    L('const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return 'ID:\\", "' + up(s);", '}', ''),
    L('const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return up('ID:\\", "' + String(s).normalize('NFKC'));", '}', ''), noUse('normalize')],
  ['cont Py continued string (C02)', 'app/x.py',
    L('import unicodedata', 'def up(x):', '    return str(x).upper()', 'def f(s):', "    return 'ID:\\", "' + up(s)", ''),
    L('import unicodedata', 'def up(x):', '    return str(x).upper()', 'def f(s):', "    return up('ID:\\", "' + unicodedata.normalize('NFKC', str(s)) + '')", ''), noUse('normalize')],
  ['control: C01 on one line', 'src/x.js',
    L('const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return 'ID:' + up(s);", '}', ''),
    L('const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return up('ID:' + String(s).normalize('NFKC'));", '}', ''), noUse('normalize')],
  ['wrap JS typeof in toUpperCase span (W01)', 'src/x.js',
    L('function f(x) {', "  return 'KIND:' + (Number.isFinite(x) ? 'NUM' : 'OTHER');", '}', ''),
    L('function f(x) {', "  return ('kind:' + (typeof x === 'number' ? 'num' : 'other')).toUpperCase();", '}', ''), spanOnly('typeof')],
  ['control: typeof without the wrapper', 'src/x.js',
    L('function f(x) {', "  return 'KIND:' + (Number.isFinite(x) ? 'NUM' : 'OTHER');", '}', ''),
    L('function f(x) {', "  return 'KIND:' + (typeof x === 'number' ? 'NUM' : 'OTHER');", '}', ''), spanOnly('typeof')],
  ['slide JS duplicated argument (H01)', 'src/x.js',
    L('function f(s, t) {', '  return String(s).lastIndexOf(String(t));', '}', ''),
    L('function f(s, t) {', '  return String(s).lastIndexOf(String(t), String(t));', '}', ''), slid]
];

let findings = 0;
for (const [label, file, before, after, check] of ROWS) {
  const ms = editMutants(after, { file, before, max: 3 });
  const ins = changeHunks(before, after, file).flatMap(h => h.ranges.map(([a, b]) => after.slice(a, b)));
  const call = after.indexOf('lastIndexOf(');
  const muts = ms.map(m => ({
    mutation: m.mutation, ref: m.ref, at: JSON.stringify(after.slice(m.site, m.site + 8)),
    spanText: after.slice(m.span[0], m.span[1]), atText: JSON.stringify(after.slice(m.span[0], m.span[1])),
    argIndex: call >= 0 ? (after.slice(call, m.span[0]).match(/,/g) || []).length : -1
  }));
  const flags = { uncovered: ms.uncovered, unmutated_ref: ms.unmutated_ref, capped: ms.capped };
  const f = check({ ins, muts, flags });
  const tag = f ? 'FINDING' : 'ok     ';
  if (f) findings++;
  const state = flags.uncovered ? ` uncovered=${JSON.stringify(flags.uncovered.text)}` : flags.unmutated_ref ? ` unmutated_ref=${flags.unmutated_ref.name}` : '';
  console.log(`${tag} ${label.padEnd(44)} inserted=${JSON.stringify(ins)}${state}`);
  if (f) console.log(`        ${f}`);
  else if (!state) console.log(`        mutants ${JSON.stringify(muts.map(m => `${m.mutation}${m.ref ? `(${m.ref})` : ''}@${m.at}`))}`);
}
if (findings) {
  console.log(`FINDING: ${findings} rows`);
  process.exit(1);
}
console.log('ok');
