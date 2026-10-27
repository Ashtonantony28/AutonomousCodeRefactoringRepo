'use strict';

// AUDIT-44 L2: SG49 `shifts` makes a `,` structural in any kept `(` / `[`
// with kept code after it. CLAUDE.md scopes the rule to "a kept call, array,
// pattern or parameter list (Python: call, list, tuple)". In Python it also
// reaches a `def` parameter list (right to reject: a new positional
// parameter shifts callers' arguments, but undocumented) and a parenthesised
// `from m import (a, b)` list (nothing shifts: an over-rejection, fails
// closed). Both were judged on their sites before SG49 (e641183).
// Rows print `stops on ,` or `judged`; FINDING when a row outside the
// documented scope stops on the `,`; the ctl rows must stop.
// Pure editMutants calls; no pipeline, API or state.
//   node audit/44/shift-reach.js

const { L, sites, report } = require('../39/lib');
const P = (...b) => L(...b, '');
const ROWS = [
  ['L2', 'Py def parameter list `def f(a, b=2)` -> `def f(a, c=1, b=2)` (shifts positional callers; CLAUDE.md lists no Python parameter list)', 'app/x.py',
    P('def f(a, b=2):', '    return a + b'), P('def f(a, c=1, b=2):', '    return a + b + c')],
  ['L2', 'Py import list `from os.path import (join)` -> `(basename, join)` (nothing shifts)', 'app/x.py',
    P('from os.path import (join)', 'def f(a):', '    return join(a, a)'), P('from os.path import (basename, join)', 'def f(a):', '    return join(a, basename(a))')],
  ['ctl', 'Py call `t.replace(a, b)` -> `t.replace(\'x\', a, b)` (documented: call)', 'app/x.py',
    P('def f(t, a, b):', '    return t.replace(a, b)'), P('def f(t, a, b):', "    return t.replace('x', a, b)")],
  ['ctl', 'Py list `[a, b]` -> `[\'x\', a, b]` (documented: list)', 'app/x.py',
    P('def f(a, b):', '    return [a, b]'), P('def f(a, b):', "    return ['x', a, b]")]
];
report(ROWS.map(([id, label, file, before, after]) => {
  const r = sites(file, before, after);
  const onComma = r.stopped && r.uncovered === ',';
  return { label: `[${id}] ${label}`, finding: id === 'ctl' ? !onComma : onComma,
    detail: r.stopped ? `stops on ${JSON.stringify(r.uncovered || r.unmutated)}` : `judged on ${r.judged.join(', ')}` };
}));
