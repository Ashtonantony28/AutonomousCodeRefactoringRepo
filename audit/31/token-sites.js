'use strict';

// AUDIT-31 at unit level: what `bug-injector.editMutants` asks the suite to
// kill for the sep / kw shapes in audit/31/corpus.js, beside the SG37
// controls that do stop (`uncovered_token`).
//
//   node audit/31/token-sites.js
//
// FINDING rows: the token that changes behaviour gets no `uncovered_token`
// and the hunk is judged only on sibling sites (sep), or the swapped block
// keyword is judged only on its own negate_condition site (kw).
// ok rows are controls. Pure functions on strings: no pipeline, API or state.

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));

const L = (...l) => l.join('\n');

function info(file, before, after) {
  const m = editMutants(after, { file, before, max: 3 });
  const stopped = !!(m.uncovered || m.unmutated_ref || m.capped || m.unchecked || !m.length);
  const judged = [...m].map(x => `${x.mutation}${x.ref ? `(${x.ref})` : ''}:${after.slice(x.span[0], x.span[1]).slice(0, 14)}`);
  return { stopped, uncovered: m.uncovered && m.uncovered.text, judged };
}

const JS = (body) => L("'use strict';", body, '');
const SLOPPY = (body) => L(body, '');
const ROWS = [
  // [label, file, before, after, expect: 'stop' (control) | 'finding' (shape carried by siblings)]
  ['sep JS `for await (c of x);` empty body (S01)', 'src/x.js',
    JS(L('async function f(x) {', '  let n = 0; var c;', '  for await (c of x) if (String(c).length > 6000) n++;', '  return String(n);', '}')),
    JS(L('async function f(x) {', '  let n = 0; var c;', '  for await (c of x); if (String(c).length > 6000) n++;', "  return String(n) + '';", '}')), 'finding'],
  ['ctl JS `for (c of x);` empty body (S07)', 'src/x.js',
    JS(L('function f(x) {', '  let n = 0; var c;', '  for (c of x) if (String(c).length > 6000) n++;', '  return String(n);', '}')),
    JS(L('function f(x) {', '  let n = 0; var c;', '  for (c of x); if (String(c).length > 6000) n++;', "  return String(n) + '';", '}')), 'stop'],
  ['sep JS `with (o);` empty body, sloppy (S02)', 'src/x.js',
    SLOPPY(L('var maxLen = 6000;', 'function f(s, o) {', '  var t = String(s);', '  with (o || {}) t = t.slice(0, maxLen);', '  return t;', '}')),
    SLOPPY(L('var maxLen = 6000;', 'function f(s, o) {', '  var t = String(s);', "  with (o || {}); t = t.slice(0, maxLen) + '';", '  return t;', '}')), 'finding'],
  ['sep JS same-line `; + (...)` (S03)', 'src/x.js',
    JS(L('function f(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + (out.length > 6000 ? '!' : '');", '}')),
    JS(L('function f(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + ''; + (out.length > 6000 ? '!' : '');", '}')), 'finding'],
  ['ctl JS `;` before a line starting `+` (ASI join)', 'src/x.js',
    JS(L('function f(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + ''", "    + (out.length > 6000 ? '!' : '');", '}')),
    JS(L('function f(s) {', '  const out = String(s);', "  return out.slice(0, 6000) + '' + '';", "    + (out.length > 6000 ? '!' : '');", '}')), 'stop'],
  ['sep JS comma `6000 - 1` -> `6000, - 1` (S04)', 'src/x.js',
    JS(L('function f(s) {', '  return String(s).slice(0, 6000 - 1);', '}')),
    JS(L('function f(s) {', "  return String(s).slice(0, 6000, - 1) + '';", '}')), 'finding'],
  ['sep Python `;` on a multi-line `if` header continuation (S05)', 'app/x.py',
    L('import unicodedata', 'def f(s):', '    s = str(s)', '    if (chr(8203) in s and', '            len(s) > 0): s = s.replace(chr(8203), "")', "    s = unicodedata.normalize('NFKC', s)", '    return s', ''),
    L('import unicodedata', 'def f(s):', '    s = str(s)', '    if (chr(8203) in s and', "            len(s) > 0): s = s.replace(chr(8203), \"\"); s = unicodedata.normalize('NFKC', s)", "    return s + ''", ''), 'finding'],
  ['ctl Python `;` on a one-line `if` header (AUDIT-27 Q05)', 'app/x.py',
    L('import unicodedata', 'def f(s):', '    s = str(s)', '    if chr(8203) in s: s = s.replace(chr(8203), "")', "    s = unicodedata.normalize('NFKC', s)", '    return s', ''),
    L('import unicodedata', 'def f(s):', '    s = str(s)', "    if chr(8203) in s: s = s.replace(chr(8203), \"\"); s = unicodedata.normalize('NFKC', s)", "    return s + ''", ''), 'stop'],
  ['kw JS `while` -> `if` (K01)', 'src/x.js',
    JS(L('function f(s) {', '  let out = String(s);', '  while (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}')),
    JS(L('function f(s) {', '  let out = String(s);', '  if (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}')), 'finding'],
  ['kw Python `elif` -> `if` (K02)', 'app/x.py',
    L('def f(s):', '    if len(s) > 6000:', '        s = s[:6000]', '    elif chr(8203) in s:', "        s = s.replace(chr(8203), '')", '    return s', ''),
    L('def f(s):', '    if len(s) > 6000:', '        s = s[:6000]', '    if chr(8203) in s:', "        s = s.replace(chr(8203), '')", '    return s', ''), 'finding']
];

let bad = 0;
for (const [label, file, before, after, expect] of ROWS) {
  const i = info(file, before, after);
  let tag;
  if (expect === 'stop') tag = i.stopped ? 'ok     ' : 'UNEXPECTED';
  else if (expect === 'note') tag = 'note   ';
  else tag = i.stopped ? 'ok     ' : 'FINDING';
  if (tag === 'FINDING' || tag === 'UNEXPECTED') bad++;
  console.log(`${tag} ${label.padEnd(64)} ${i.stopped ? `stopped${i.uncovered ? ` uncovered=${JSON.stringify(i.uncovered)}` : ''}` : `judged on ${JSON.stringify(i.judged)}`}`);
}
process.exit(bad ? 1 : 0);
