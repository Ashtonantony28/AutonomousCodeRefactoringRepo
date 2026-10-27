'use strict';

// AUDIT-39 C1, H1, H2, M1 at unit level: what `bug-injector.editMutants` asks
// the suite to kill for each shape, beside controls that stop.
//
//   node audit/39/token-sites.js
//
// FINDING rows: the token that changes behaviour (a `;` cutting a kept
// operand, a `?` / `&&` replacing a loop, a `,` shifting kept arguments or
// elements) gets no `uncovered_token`, and the hunk is judged only on the
// listed sibling sites. ok rows stop as they should (controls). Pure
// functions on strings: no pipeline, API or state.

const { L, sites, report } = require('./lib');

const J = (...b) => L("'use strict';", ...b, '');
const P = (...b) => L(...b, '');
const ROWS = [
  // [finding id or 'ctl', label, file, before, after]
  // ---- C1: a JS `;` at the start of a continuation line
  ['C1', '`a)\\n  + b` -> `a)\\n  ; r = r + b` (C01)', 'src/x.js',
    J('function f(t, r) {', '  const n = Math.min(t, 6000)', '    + Math.max(0, t - 6000);', '  return n + r;', '}'),
    J('function f(t, r) {', '  const n = Math.min(t, 6000)', '    ; r = r + Math.max(0, t - 6000);', '  return n + r;', '}')],
  ['C1', '`a\\n  + b` -> `a\\n  ; out.push(a) + b` (name ends the line above)', 'src/x.js',
    J('function f(a, b, out) {', '  const x = a', '    + b;', '  return x;', '}'),
    J('function f(a, b, out) {', '  const x = a', '    ; out.push(a) + b;', '  return x;', '}')],
  ['C1', '`s]\\n  .trim()` -> `s]\\n  ; log(s) .trim()` (`]` ends the line above, member continuation)', 'src/x.js',
    J('function f(xs, log) {', '  const x = xs[0]', '    .trim();', '  return x;', '}'),
    J('function f(xs, log) {', '  const x = xs[0]', '    ; log(xs).trim();', '  return x;', '}')],
  ['ctl', '`;` at the end of the line above, kept `+ b` line below (SG44)', 'src/x.js',
    J('function f(a, b, out) {', '  const x = a', '    + b;', '  return x;', '}'),
    J('function f(a, b, out) {', '  const x = a; out.push(a)', '    + b;', '  return x;', '}')],
  ['ctl', '`;` before a `.member` line (SG44)', 'src/x.js',
    J('function f(a, out) {', '  const x = a', '    .trim();', '  return x;', '}'),
    J('function f(a, out) {', '  const x = a; out.push(a)', '    .trim();', '  return x;', '}')],
  ['ctl', 'same-line `a + b` -> `a; !c + c` (SG44)', 'src/x.js',
    J('function f(b, c) {', '  let a = b + c;', '  return a;', '}'),
    J('function f(b, c) {', '  let a = b; !c + c;', '  return a;', '}')],
  // ---- H1: a loop replaced by one conditional step without a guard keyword
  ['H1', '`while (c) t = g(t);` -> `c ? t = g(t) : t = t;` (K01)', 'src/x.js',
    J('function f(s) {', '  let t = String(s);', '  while (t.length > 6000) t = t.slice(1000);', '  return t;', '}'),
    J('function f(s) {', '  let t = String(s);', '  t.length > 6000 ? t = t.slice(1000) : t = t;', '  return t;', '}')],
  ['H1', '`while (c) xs.pop();` -> `c && xs.pop();` (K02)', 'src/x.js',
    J('function f(xs) {', '  while (xs.length > 6000) xs.pop();', '  return xs;', '}'),
    J('function f(xs) {', '  xs.length > 6000 && xs.pop();', '  return xs;', '}')],
  ['H1', '`for (;c;) xs.pop();` -> `c || xs.pop();`', 'src/x.js',
    J('function f(xs) {', '  for (; xs.length > 6000;) xs.pop();', '  return xs;', '}'),
    J('function f(xs) {', '  xs.length <= 6000 || xs.pop();', '  return xs;', '}')],
  ['ctl', '`while` -> `if` (SG45)', 'src/x.js',
    J('function f(xs) {', '  while (xs.length > 6000) xs.pop();', '  return xs;', '}'),
    J('function f(xs) {', '  if (xs.length > 6000) xs.pop();', '  return xs;', '}')],
  ['ctl', 'Python `while` -> ternary (no mutant on a Python ternary)', 'app/x.py',
    P('def f(t):', '    while len(t) > 6000:', '        t = t[1000:]', '    return t'),
    P('def f(t):', '    t = t[1000:] if len(t) > 6000 else t', '    return t')],
  // ---- H2: a `,` inserted before kept arguments / elements shifts them
  ['H2', 'JS call `t.slice(e)` -> `t.slice(0, e)` (S01)', 'src/x.js',
    J('function f(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(t.length - 6000) : t;', '}'),
    J('function f(s) {', '  const t = String(s);', '  return t.length > 6000 ? t.slice(0, t.length - 6000) : t;', '}')],
  ['H2', 'JS array `[a, b]` -> `[a, \'\', b]` (S02)', 'src/x.js',
    J('function f(a, b) {', '  return [a, b];', '}'),
    J('function f(a, b) {', "  return [a, '', b];", '}')],
  ['H2', 'JS array `[a, b]` -> `[\'x\', a, b]`', 'src/x.js',
    J('function f(a, b) {', '  return [a, b];', '}'),
    J('function f(a, b) {', "  return ['x', a, b];", '}')],
  ['H2', 'JS `new Array(n)` -> `new Array(0, n)`', 'src/x.js',
    J('function f(n) {', '  return new Array(n).length;', '}'),
    J('function f(n) {', '  return new Array(0, n).length;', '}')],
  ['H2', 'JS pattern `const [a] = xs` -> `const [h, a] = xs` (h read elsewhere)', 'src/x.js',
    J('function f(xs) {', '  const [a] = xs;', '  return a;', '}'),
    J('function f(xs) {', '  const [h, a] = xs;', '  return a + h;', '}')],
  ['H2', 'Python call `t.replace(a, b)` -> `t.replace(\'x\', a, b)`', 'app/x.py',
    P('def f(t, a, b):', '    return t.replace(a, b)'),
    P('def f(t, a, b):', "    return t.replace('x', a, b)")],
  ['H2', 'Python list `[a, b]` -> `[\'x\', a, b]`', 'app/x.py',
    P('def f(a, b):', '    return [a, b]'),
    P('def f(a, b):', "    return ['x', a, b]")],
  // ---- M1: an exempt `:` turns a subscript into a slice
  ['M1', 'Python `s[k]` -> `s[k:k + 1]` (IndexError -> \'\', element -> list)', 'app/x.py',
    P('def f(s, k):', '    return s[k]'),
    P('def f(s, k):', '    return s[k:k + 1]')],
  ['ctl', 'JS split between kept tokens `t.length - 6000` -> `t.length + 0, - 6000` (SG44, S03)', 'src/x.js',
    J('function f(s) {', '  const t = String(s);', '  return t.slice(t.length - 6000);', '}'),
    J('function f(s) {', '  const t = String(s);', '  return t.slice(t.length + 0, - 6000);', '}')],
  ['ctl', 'JS leading hole `[a]` -> `[, a]` (SG44/SG47)', 'src/x.js',
    J('function f(a) {', '  return [a];', '}'),
    J('function f(a) {', "  return [, a + ''];", '}')],
  ['ctl', 'Python statement tuple `return a, b` -> `return x, a, b` (reach stops at `return`)', 'app/x.py',
    P('def f(a, b):', '    return a, b'),
    P('def f(a, b):', "    return 'x', a, b")]
];

const rows = ROWS.map(([id, label, file, before, after]) => {
  const r = sites(file, before, after);
  const what = r.stopped ? `stops (uncovered=${JSON.stringify(r.uncovered)} unmutated=${JSON.stringify(r.unmutated)})` : `judged only on ${r.judged.join(', ')}`;
  const finding = !r.stopped; // every row must stop: a FINDING row is judged on siblings, a control that judges is a regression
  return { label: `[${id}] ${label}`, finding, detail: what };
});
report(rows);
