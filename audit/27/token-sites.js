'use strict';

// AUDIT-27 at unit level: what `hunks.changeHunks` sees as changed and what
// `bug-injector.editMutants` asks the suite to kill, for the shapes in
// audit/27/corpus.js plus CRLF backslash continuations.
//
//   node audit/27/token-sites.js
//
// FINDING rows:
//   nan     a changed numeric token is no change (valueKey maps it to NaN)
//   inside  a structural bracket / re-indented line is covered only by an
//           identity or constant-read sibling inside it
//   sep     a `;` / `,` that changes control flow or type gets no mutant and
//           the hunk stands on a sibling
// ok rows are controls or fail-closed shapes (CRLF continuations).
// No pipeline run, no API, no state dir: pure functions on strings.

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));
const { changeHunks } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'hunks'));

const L = (...l) => l.join('\n');
const C = (...l) => l.join('\r\n');

function info(file, before, after) {
  const hs = changeHunks(before, after, file);
  const ins = hs.flatMap(h => h.ranges.map(([a, b]) => after.slice(a, b)));
  const m = editMutants(after, { file, before, max: 3 });
  const flags = {};
  for (const k of ['uncovered', 'unmutated_ref', 'capped', 'unchecked']) if (m[k]) flags[k] = m[k];
  return { hs, ins, muts: [...m].map(x => ({ mutation: x.mutation, ref: x.ref, text: after.slice(x.span[0], x.span[1]) })), flags };
}
const stopped = (i) => !!(i.flags.uncovered || i.flags.unmutated_ref || i.flags.capped || i.flags.unchecked || !i.muts.length);
const judged = (i) => JSON.stringify(i.muts.map(m => `${m.mutation}${m.ref ? `(${m.ref})` : ''}:${m.text.slice(0, 12)}`));

// The changed numeric token must be an inserted token.
const numChanged = (tok) => (i) => (i.ins.includes(tok) ? null : `\`${tok}\` changed value but is no inserted token (valueKey NaN); inserted=${JSON.stringify(i.ins)}${stopped(i) ? '' : ` judged on ${judged(i)}`}`);
// The carrier token is free and the hunk has mutants only on siblings.
const carried = (carrier, sib) => (i) => {
  if (stopped(i)) return null;
  return i.muts.every(m => sib.some(s => m.text.includes(s))) ? `change carried by ${JSON.stringify(carrier)}; hunk judged only on ${judged(i)}` : null;
};
const failClosed = (i) => (stopped(i) ? null : `not stopped; judged on ${judged(i)}`);

const ROWS = [
  ['nan JS 0x1e+6000 -> 0x2e+6000 (N01)', 'src/x.js',
    L("'use strict';", "const SUFFIX = '!';", 'function cap(s) {', '  const out = String(s).slice(0, 0x1e+6000);', "  return out + '!';", '}', ''),
    L("'use strict';", "const SUFFIX = '!';", 'function cap(s) {', '  const out = String(s).slice(0, 0x2e+6000);', '  return out + SUFFIX;', '}', ''), numChanged('0x2e+6000')],
  ['nan JS 6e3.toFixed -> 7e3.toFixed (N02)', 'src/x.js',
    L("'use strict';", 'const CAP = +6e3.toFixed();', ''), L("'use strict';", 'const CAP = +7e3.toFixed();', ''), numChanged('7e3.toFixed')],
  ['nan Py 6e3.real -> 7e3.real (N03)', 'app/x.py',
    L('CAP = int(6e3.real)', ''), L('CAP = int(7e3.real)', ''), numChanged('7e3.real')],
  ['nan Py 0x1e+6000 -> 0x3e+6000 (N04)', 'app/x.py',
    L('CAP = 0x1e+6000', ''), L('CAP = 0x3e+6000', ''), numChanged('0x3e+6000')],
  ['control: 6000 -> 7000', 'src/x.js',
    L("'use strict';", 'const CAP = 6000;', ''), L("'use strict';", 'const CAP = 7000;', ''), numChanged('7000')],
  ['inside JS braces + identity (X01)', 'src/x.js',
    L("'use strict';", 'function f(s) {', '  let out = String(s);', '  if (out.length > 4096) out = out.slice(0, 4096);', "  out = out.normalize('NFC');", '  return out;', '}', ''),
    L("'use strict';", 'function f(s) {', '  let out = String(s);', '  if (out.length > 4096) { out = out.slice(0, 4096);', "  out = out.normalize('NFC') + ''; }", '  return out;', '}', ''), carried(['{', '}'], ['+', "''"])],
  ['inside JS parens + identity (X03)', 'src/x.js',
    L("'use strict';", 'function f(p, s) {', "  return String(p) + String(s).normalize('NFC');", '}', ''),
    L("'use strict';", 'function f(p, s) {', "  return (String(p) + String(s) + '').normalize('NFC');", '}', ''), carried(['(', ')'], ['+', "''"])],
  ['inside Py indent + identity (X06)', 'app/x.py',
    L('import unicodedata', 'def f(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "    out = unicodedata.normalize('NFC', out)", '    return out', ''),
    L('import unicodedata', 'def f(s):', '    out = str(s)', '    if len(out) > 4096:', '        out = out[:4096]', "        out = unicodedata.normalize('NFC', out + '')", '    return out', ''), carried(['        '], ['+', "''"])],
  ['control: braces with no sibling inside', 'src/x.js',
    L("'use strict';", 'function f(s) {', '  let out = String(s);', '  if (out.length > 4096) out = out.slice(0, 4096);', "  out = out.normalize('NFC');", '  return out;', '}', ''),
    L("'use strict';", 'function f(s) {', '  let out = String(s);', '  if (out.length > 4096) { out = out.slice(0, 4096);', "  out = out.normalize('NFC'); }", '  return out;', '}', ''), failClosed],
  ['sep JS `if (c);` (Q01)', 'src/x.js',
    L("'use strict';", 'function f(s) {', '  let out = String(s);', "  if (out.includes('\\u200b')) out = out.normalize('NFKC');", '  return out;', '}', ''),
    L("'use strict';", 'function f(s) {', '  let out = String(s);', "  if (out.includes('\\u200b')); out = out.normalize('NFKC');", "  return out + '';", '}', ''), carried([';'], ['+', "''"])],
  ['sep Py trailing comma (Q04)', 'app/x.py',
    L('def f(s):', '    s = str(s)', '    if len(s) > 6000:', '        s = s[:6000]', '    return s', ''),
    L('def f(s):', '    s = str(s)', '    if len(s) > 6000:', '        s = s[:6000],', "    return s + ''", ''), carried([','], ['+', "''"])],
  ['sep Py `;` joins a suite (Q05)', 'app/x.py',
    L('import unicodedata', 'def f(s):', '    s = str(s)', '    if chr(8203) in s: s = s.replace(chr(8203), "")', "    s = unicodedata.normalize('NFKC', s)", '    return s', ''),
    L('import unicodedata', 'def f(s):', '    s = str(s)', "    if chr(8203) in s: s = s.replace(chr(8203), \"\"); s = unicodedata.normalize('NFKC', s)", "    return s + ''", ''), carried([';'], ['+', "''"])],
  ['control: `if (c);` alone', 'src/x.js',
    L("'use strict';", 'function f(s) {', '  let out = String(s);', "  if (out.includes('\\u200b')) out = out.normalize('NFKC');", '  return out;', '}', ''),
    L("'use strict';", 'function f(s) {', '  let out = String(s);', "  if (out.includes('\\u200b')); out = out.normalize('NFKC');", '  return out;', '}', ''), failClosed],
  ['crlf JS continued string, names in pseudo-literal', 'src/x.js',
    C("'use strict';", 'const N = 5;', 'function f(s) {', "  return 'ID:\\", "' + s + '!';", '}', ''),
    C("'use strict';", 'const N = 5;', 'function f(s) {', "  return 'ID:\\", "' + s.slice(N) + '!';", '}', ''), failClosed],
  ['crlf JS continued string, helper moved outward', 'src/x.js',
    C("'use strict';", 'const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return 'ID:\\", "' + up(s);", '}', ''),
    C("'use strict';", 'const up = (x) => String(x).toUpperCase();', 'function f(s) {', "  return up('ID:\\", "' + String(s).normalize('NFKC'));", '}', ''), failClosed],
  ['crlf Py continued string', 'app/x.py',
    C('N = 5', 'def f(s):', "    return 'ID:\\", "' + s + '!'", ''),
    C('N = 5', 'def f(s):', "    return 'ID:\\", "' + s[N:] + '!'", ''), failClosed],
  ['crlf Py continued string, helper moved outward', 'app/x.py',
    C('import unicodedata', 'def up(x):', '    return str(x).upper()', 'def f(s):', "    return 'ID:\\", "' + up(s)", ''),
    C('import unicodedata', 'def up(x):', '    return str(x).upper()', 'def f(s):', "    return up('ID:\\", "' + unicodedata.normalize('NFKC', str(s)) + '')", ''), failClosed]
];

let findings = 0;
for (const [label, file, before, after, check] of ROWS) {
  const i = info(file, before, after);
  const f = check(i);
  if (f) findings++;
  const fl = Object.keys(i.flags).map(k => ` ${k}=${JSON.stringify(i.flags[k].text || i.flags[k].name || true)}`).join('');
  console.log(`${f ? 'FINDING' : 'ok     '} ${label.padEnd(48)} hunks=${i.hs.length} inserted=${JSON.stringify(i.ins)}${fl}`);
  if (f) console.log(`        ${f}`);
}
if (findings) { console.log(`FINDING: ${findings} rows`); process.exit(1); }
console.log('ok');
