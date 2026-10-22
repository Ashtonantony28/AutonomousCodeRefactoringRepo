'use strict';

// AUDIT-32 M1, L1: SG37's structural `;` / `,` rule (bug-injector
// uncoveredToken `structural`) is broader than CLAUDE.md states. CLAUDE.md
// exempts every `,` and `;` except: JS `;` as an empty `if`/`else`/loop body
// or "before a line ASI would join"; Python `;` on a compound statement's
// line, and "a trailing comma at statement level, in a grouping paren or a
// subscript". The code treats every non-call paren as grouping and every
// `;` before a line starting `+`/`-` as an ASI join, and matches compound
// keywords textually.
//   a  control: element added to a one-line tuple / a multi-line list    -> no uncovered token
//   M1 element added to a multi-line tuple display `T = (\n 'a',\n 'b',\n)`:
//      its trailing comma (no structure change) is uncovered; end to end
//      the edit is `reverted` / `tests_insensitive` though a test kills `'c'`
//   L1a JS `;` before a `++t` line: ASI never joins `n + 1\n++t` (restricted
//      production), yet the `;` is uncovered
//   L1b Python `match = s; t = n + 1`: `match` as a variable name reads as a
//      compound statement, so the `;` is uncovered
// No API calls; M1 drives runExecutor on a temp git repo.
//   node audit/32/structural-scope.js

const L = require('../28/lib');
const bugInjector = require('../../src/rl/bug-injector');

const ms = (lang, b, a) => {
  const wrap = (body) => (lang === 'js' ? `'use strict';\nfunction f(s, t, n, xs) {\n${body}\n}\n` : `import textwrap\n\n\ndef f(s, t, n, xs):\n${body}\n`);
  return bugInjector.editMutants(wrap(a), { file: lang === 'js' ? 'src/x.js' : 'app/x.py', before: wrap(b) });
};
const unc = (lang, b, a) => { const m = ms(lang, b, a); return m.uncovered ? m.uncovered.text : null; };

const TUP_B = "    T = (\n        'a',\n        'b',\n    )\n    return s in T";
const TUP_A = "    T = (\n        'a',\n        'b',\n        'c',\n    )\n    return s in T";

(async () => {
  const ctlInline = unc('py', "    return s in ('a', 'b')", "    return s in ('a', 'b', 'c')");
  const ctlList = unc('py', TUP_B.replace('(', '[').replace('    )', '    ]'), TUP_A.replace('(', '[').replace('    )', '    ]'));
  const m1 = unc('py', TUP_B, TUP_A);
  const l1a = unc('js', '  let i = n\n  ++t\n  return i;', '  let i = n + 1;\n  ++t\n  return i;');
  const l1b = unc('py', '    match = s\n    return match', '    match = s; t = n + 1\n    return match');
  console.log(`   a: inline tuple uncovered=${ctlInline} multi-line list uncovered=${ctlList}`);
  console.log(`   M1: multi-line tuple uncovered=${JSON.stringify(m1)}`);
  console.log(`   L1a: JS ';' before '++t' uncovered=${JSON.stringify(l1a)}; L1b: Python 'match = s;' uncovered=${JSON.stringify(l1b)}`);

  const files = {
    'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '',
    'app/m.py': "ALLOWED = (\n    'a',\n    'b',\n)\n\n\ndef allowed(s):\n    return s in ALLOWED\n",
    'tests/test_m.py': "from app.m import allowed\n\n\ndef test_allowed():\n    assert allowed('a')\n    assert allowed('c')\n    assert not allowed('z')\n"
  };
  const edit = { file: 'app/m.py', current_code: "ALLOWED = (\n    'a',\n    'b',\n)", proposed_code: "ALLOWED = (\n    'a',\n    'b',\n    'c',\n)" };
  const o = (await L.execOn(files, edit, { pkg: null })).o;
  const mu = o.mutation || {};
  console.log(`   M1 e2e: status=${o.status} reason=${o.reason || '(none)'} uncovered_token=${JSON.stringify(mu.uncovered_token)} line=${mu.uncovered_token_line}`);

  L.report('a control: inline tuple / multi-line list element added', ctlInline === null && ctlList === null, `${ctlInline} / ${ctlList}`, 'null / null');
  L.report('M1 the trailing comma of a multi-line tuple display is "structural" (not a grouping paren, no tuple made)',
    m1 === null && o.status !== 'reverted', `uncovered=${JSON.stringify(m1)}; e2e status=${o.status} reason=${o.reason || '(none)'}`,
    'no uncovered token; the edit is judged on its \'c\' site');
  L.report('L1a a JS `;` before a `++` line is flagged as an ASI join', l1a === null, JSON.stringify(l1a), 'null');
  L.report('L1b a Python `;` after `match = ...` (a name) is flagged as a compound line', l1b === null, JSON.stringify(l1b), 'null');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
