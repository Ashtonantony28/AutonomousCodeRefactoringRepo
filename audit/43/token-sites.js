'use strict';

// AUDIT-43 editMutants verdicts (unit level, real src/rl/bug-injector.js via
// audit/39/lib.js `sites`). A FINDING row is an edit with a witnessed
// semantics change that is judged (not stopped) on sites whose kills do not
// reach the change; a control row is a FINDING when it is judged.
//
//   node audit/43/token-sites.js          # every row
//   node audit/43/token-sites.js H2 M1    # rows of some findings

const { L, sites, report } = require('../39/lib');

const W = (...b) => L('function f(xs, t, a, b) {', ...b, '  return xs;', '}');
const P = (...b) => L('def f(xs, t, a, b):', ...b, '    return xs');

// [id, label, file, before, after, control, judgedOk]: a control is fine when
// stopped, or judged only on sites matching judgedOk (the site the change needs).
const ROWS = [
  // H2: guard -> `&&` / `and` step; the second statement leaves the guard
  ['H2', 'JS `if (c) { a; b; }` -> `c && a; b;`', 'a.js', W('  if (t.length < 6000) { xs.push(t); xs.push(a); }'), W('  t.length < 6000 && xs.push(t); xs.push(a);')],
  ['H2', 'JS multi-line block -> `c && a;` + dedented `b;`', 'a.js', W('  if (t.length < 6000) {', '    xs.push(t);', '    xs.push(a);', '  }'), W('  t.length < 6000 && xs.push(t);', '  xs.push(a);')],
  ['H2', 'Python one-line `if c: a; b` -> `c and a; b`', 'a.py', P('    if len(t) < 6000: xs.append(t); xs.append(a)'), P('    len(t) < 6000 and xs.append(t); xs.append(a)')],
  ['H2', 'control: `}` moved left of `b` (changed bracket)', 'a.js', W('  if (t.length < 6000) { xs.push(t); xs.push(a); }'), W('  if (t.length < 6000) { xs.push(t); } xs.push(a);'), true],
  ['H2', 'control: Python block -> `c and a` + dedented `b` (changed indentation)', 'a.py', P('    if len(t) < 6000:', '        xs.append(t)', '        xs.append(a)'), P('    len(t) < 6000 and xs.append(t)', '    xs.append(a)'), true],
  // H3: format directives inside a string are judged on the string's "x added" mutant
  ['H3', "f-string `{t}` -> `{t:.6000}`", 'a.py', P("    xs.append(f'{t}')"), P("    xs.append(f'{t:.6000}')")],
  ['H3', "`'%s' % t` -> `'%.6000s' % t`", 'a.py', P("    xs.append('%s' % t)"), P("    xs.append('%.6000s' % t)")],
  ['H3', "`'{}'.format(t)` -> `'{:.6000}'.format(t)`", 'a.py', P("    xs.append('{}'.format(t))"), P("    xs.append('{:.6000}'.format(t))")],
  ['H3', "f-string `{t}` -> `{t!r}` (conversion)", 'a.py', P("    xs.append(f'{t}')"), P("    xs.append(f'{t!r}')")],
  ['H3', 'control: `{t}` -> `{t[:6000]}` (number site in the field)', 'a.py', P("    xs.append(f'{t}')"), P("    xs.append(f'{t[:6000]}')"), true, /^numeric_off_by_one:6000$/],
  // M1: a deleted block keyword offset by one inserted elsewhere in the hunk
  ['M1', 'JS `while (c) s;` -> `c && s;` plus a new `while` on the next line', 'a.js', W('  while (xs.length > 6000) xs.pop();', '  xs.sort();'), W('  xs.length > 6000 && xs.pop();', '  while (a) a = b;')],
  ['M1', 'control: the same without the new `while` (SG49 droppedKeyword)', 'a.js', W('  while (xs.length > 6000) xs.pop();', '  xs.sort();'), W('  xs.length > 6000 && xs.pop();', '  xs.sort();'), true]
];

const only = new Set(process.argv.slice(2));
const rows = [];
for (const [id, label, file, before, after, control, judgedOk] of ROWS) {
  if (only.size && !only.has(id)) continue;
  const r = sites(file, before, after);
  const verdict = r.stopped ? `stopped (uncovered=${JSON.stringify(r.uncovered)} unmutated=${r.unmutated || '-'})` : `judged on ${r.judged.join(', ')}`;
  const fine = r.stopped || (judgedOk && r.judged.every(j => judgedOk.test(j)));
  rows.push({ label: `[${id}] ${label}`, finding: !fine, detail: control ? `control: ${verdict}` : verdict });
}
report(rows);
