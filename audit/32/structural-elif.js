'use strict';

// AUDIT-32 H3: CLAUDE.md says a Python trailing comma "in a grouping paren"
// changes structure and is not exempt punctuation (SG37). The code decides
// "grouping" by the word before the paren: `if`, `in`, `not`, `and`, `or`,
// `is`, `else`, `return`, `yield`, `await`, `lambda`, `del`, `assert` count
// as grouping, any other word as a call. `elif (c,):` and `while (c,):`
// therefore read as calls, and the comma that turns the condition into an
// always-true tuple is exempt.
//   a  control: `if (n > 1,):` -> uncovered `,`
//   b  `elif (n > 1,):` -> no uncovered token (expected `,`)
//   c  `while (n > 1,):` -> no uncovered token (expected `,`)
//   d  end to end: `elif (n > 1):` -> `elif (n > 1,):` plus `'mid'` ->
//      `'mi' + 'd'` in the same hunk; a test kills those sites' mutants and the
//      executor commits the always-true `elif` (expected: reverted,
//      tests_insensitive / uncovered_token `,`). The executor is handed an
//      `equivalent` diff test, as for any diff-test blind spot (the real diff
//      test should see f(0) diverge; the executor bar is the documented
//      backstop for what it misses).
// No API calls; d drives runExecutor on a temp git repo.
//   node audit/32/structural-elif.js

const L = require('../28/lib');
const bugInjector = require('../../src/rl/bug-injector');

const unc = (b, a) => {
  const wrap = (body) => `import textwrap\n\n\ndef f(s, t, n, xs):\n${body}\n`;
  const m = bugInjector.editMutants(wrap(a), { file: 'app/x.py', before: wrap(b) });
  return m.uncovered ? m.uncovered.text : null;
};

(async () => {
  const a = unc("    if (n > 1):\n        return 'a'\n    return 'b'", "    if (n > 1,):\n        return 'a!'\n    return 'b'");
  const b = unc("    if n > 5:\n        return 'c'\n    elif (n > 1):\n        return 'a'\n    return 'b'", "    if n > 5:\n        return 'c'\n    elif (n > 1,):\n        return 'a!'\n    return 'b'");
  const c = unc('    while (n > 1):\n        n -= 1\n    return n', '    while (n > 1,):\n        n -= 2\n    return n');
  console.log(`   a: if uncovered=${JSON.stringify(a)}  b: elif uncovered=${JSON.stringify(b)}  c: while uncovered=${JSON.stringify(c)}`);

  const files = {
    'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '',
    'app/m.py': "def size(n):\n    if n > 5:\n        return 'big'\n    elif (n > 1):\n        return 'mid'\n    return 'small'\n",
    'tests/test_m.py': "from app.m import size\n\n\ndef test_size():\n    assert size(9) == 'big'\n    assert size(3) == 'mid'\n"
  };
  const edit = { file: 'app/m.py', current_code: "    elif (n > 1):\n        return 'mid'", proposed_code: "    elif (n > 1,):\n        return 'mi' + 'd'" };
  const { o, repo } = await L.execCommit(files, edit, { pkg: null });
  const mu = o.mutation || {};
  let committed = '';
  try { committed = L.gitOut(repo, 'show', 'HEAD:app/m.py'); } catch { /* no commit */ }
  console.log(`   d: status=${o.status} reason=${o.reason || '(none)'} killed=${mu.killed} killed_test=${mu.killed_test} uncovered_token=${JSON.stringify(mu.uncovered_token)} commit=${o.commit ? o.commit.slice(0, 12) : '-'}`);
  if (/n > 1,\)/.test(committed)) console.log('   d: committed app/m.py holds `elif (n > 1,):` (size(0) is now \'mid\', was \'small\')');

  L.report('a control: `if (c,):` comma is structural', a === ',', JSON.stringify(a), '","');
  L.report('b `elif (c,):` comma (always-true tuple condition) is exempt punctuation', b === ',', JSON.stringify(b), '","');
  L.report('c `while (c,):` comma (always-true tuple condition) is exempt punctuation', c === ',', JSON.stringify(c), '","');
  L.report('d executor keeps an edit whose inserted comma makes an `elif` condition always true',
    o.status !== 'passed', `status=${o.status} commit=${o.commit ? 'yes' : 'no'}`, 'reverted / tests_insensitive (uncovered_token ",")');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
