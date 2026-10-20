'use strict';

// End to end, non-dry: worktree on refactor/<run_id>, real tests with the
// per-function coverage + per-hunk mutation rules, commit. Every scenario is
// a semantics-changing edit with a plausible suite that calls the edited code
// and passes on both versions. Critic: unanimous approve (p 0.9, no edge cases).
//
//   node audit/12/e2e-commit.js            # all
//   node audit/12/e2e-commit.js Y1 Y4      # some
// Prints FINDING per committed scenario (controls print ok when reverted),
// exits 1 if any non-control scenario was committed.

const { e2e, line, UNANIMOUS, pytestWithCoverageDir, witness, pyWitness } = require('../5/lib');

const nodeTest = (req, body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('${req}');\n${body}\n`;
const NODE_PKG = { scripts: { test: 'node --test' } };

const SCENARIOS = {
  Y1: {
    title: 'C1: braceless BigInt branch deleted; the probe sits before the `if`, so "observed" without the branch running',
    file: 'src/units.js',
    cur: "function scale(n) {\n  if (typeof n === 'bigint') return n * 1000n;\n  return n * 1000;\n}",
    prop: 'function scale(n) {\n  return n * 1000;\n}',
    rest: 'module.exports = { scale };',
    test: nodeTest('../src/units', "test('scale', () => { assert.strictEqual(m.scale(2), 2000); });"),
    w: 'String(m.scale(2n))'
  },
  Y2: {
    title: 'C1: short-circuit __proto__ key guard deleted (statement ran, assignment never did)',
    file: 'src/store.js',
    cur: "function put(o, k, v) {\n  k === '__proto__' && (k = '_proto');\n  o[k] = v;\n  return o;\n}",
    prop: 'function put(o, k, v) {\n  o[k] = v;\n  return o;\n}',
    rest: 'module.exports = { put };',
    test: nodeTest('../src/store', "test('put', () => { assert.deepStrictEqual(m.put({}, 'a', 1), { a: 1 }); });"),
    w: "Object.keys(m.put({}, '__proto__', { admin: true }))"
  },
  Y3: {
    title: 'C1 (Python): conditional-expression truncation deleted (statement ran, slice branch never did)',
    py: true,
    file: 'app/notes.py',
    cur: 'def note(s):\n    s = s[:3000] if len(s) > 3000 else s\n    return s.strip()\n',
    prop: 'def note(s):\n    return s.strip()\n',
    test: 'from app.notes import note\n\n\ndef test_note():\n    assert note(" hi ") == "hi"\n',
    w: 'len(m.note("x" * 4000))'
  },
  Y4: {
    title: 'C2: braced BigInt branch deleted in the same hunk as a reordered operand; only the inserted token is mutated',
    file: 'src/units2.js',
    cur: "function scale(n) {\n  if (typeof n === 'bigint') {\n    return n * 1000n;\n  }\n  return n * 1000;\n}",
    prop: 'function scale(n) {\n  return 1000 * n;\n}',
    rest: 'module.exports = { scale };',
    test: nodeTest('../src/units2', "test('scale', () => { assert.strictEqual(m.scale(2), 2000); });"),
    w: 'String(m.scale(2n))'
  },
  Y5: {
    title: 'control for Y4: the same braced deletion alone (pure deletion, not observed) is reverted',
    control: true,
    file: 'src/units3.js',
    cur: "function scale(n) {\n  if (typeof n === 'bigint') {\n    return n * 1000n;\n  }\n  return n * 1000;\n}",
    prop: 'function scale(n) {\n  return n * 1000;\n}',
    rest: 'module.exports = { scale };',
    test: nodeTest('../src/units3', "test('scale', () => { assert.strictEqual(m.scale(2), 2000); });"),
    w: 'String(m.scale(2n))'
  },
  Y6: {
    title: 'H2: private-field clamp dropped from a constructor (pure deletion, ran, oracle cannot see #fields)',
    file: 'src/pool.js',
    cur: 'class Pool {\n  #max;\n  constructor(max) {\n    this.#max = Math.max(1, max);\n  }\n  capacity() {\n    return this.#max;\n  }\n}',
    prop: 'class Pool {\n  #max;\n  constructor(max) {\n    this.#max = max;\n  }\n  capacity() {\n    return this.#max;\n  }\n}',
    rest: 'module.exports = { Pool };',
    test: nodeTest('../src/pool', "test('pool', () => { assert.strictEqual(new m.Pool(5).capacity(), 5); });"),
    w: 'new m.Pool(0).capacity()'
  },
  Y7: {
    title: 'H2 (Python): logger.info call removed (pure deletion, ran, INFO is below the sandbox log level)',
    py: true,
    file: 'app/pay.py',
    cur: 'import logging\nlog = logging.getLogger(__name__)\n\n\ndef charge(user, amt):\n    log.info("charge %s %s", user, amt)\n    return amt\n',
    prop: 'import logging\nlog = logging.getLogger(__name__)\n\n\ndef charge(user, amt):\n    return amt\n',
    test: 'from app.pay import charge\n\n\ndef test_charge():\n    assert charge("ada", 5) == 5\n',
    w: '(lambda lg, io: (lambda buf: (lg.basicConfig(stream=buf, level=lg.INFO, force=True), m.charge("ada", 5), buf.getvalue())[-1])(io.StringIO()))(__import__("logging"), __import__("io"))'
  },
  Y8: {
    title: 'H3 (AUDIT-8 DM3): 1000-char truncation added; the killed mutant (0 -> 1) is unrelated to the truncation',
    file: 'src/body.js',
    cur: 'function body(s) {\n  return String(s);\n}',
    prop: 'function body(s) {\n  return String(s).slice(0, 1000);\n}',
    rest: 'module.exports = { body };',
    test: nodeTest('../src/body', "test('body', () => { assert.strictEqual(m.body('abc'), 'abc'); });"),
    w: "m.body('x'.repeat(1500)).length"
  },
  Y9: {
    title: 'H4 (SG20 deferred state): last-seen update guarded; state differs mid-run only, killed mutant negates the new guard',
    file: 'src/table.js',
    pre: 'const TABLE = Array.from({ length: 3000 }, (_, i) => i * 2);\nlet lastSeen = null;',
    cur: 'function lookup(i) {\n  lastSeen = i;\n  return TABLE[i];\n}',
    prop: 'function lookup(i) {\n  if (i) lastSeen = i;\n  return TABLE[i];\n}',
    rest: 'module.exports = { lookup, seen: () => lastSeen };',
    test: nodeTest('../src/table', "test('lookup', () => { assert.strictEqual(m.lookup(5), 10); assert.strictEqual(m.seen(), 5); });"),
    w: '(m.lookup(5), m.lookup(0), m.seen())'
  }
};

function filesFor(s) {
  if (s.py) {
    return { files: { 'pytest.ini': '[pytest]\n', 'app/__init__.py': '', [s.file]: s.cur, 'tests/test_it.py': s.test }, pkg: null };
  }
  return { files: { [s.file]: `'use strict';\n${s.pre ? `${s.pre}\n` : ''}${s.cur}\n${s.rest}\n`, 'test/a.test.js': s.test }, pkg: NODE_PKG };
}

(async () => {
  const pick = process.argv.slice(2);
  const quiet = console.log;
  let committed = 0;
  let controlsBad = 0;
  for (const [id, s] of Object.entries(SCENARIOS)) {
    if (pick.length && !pick.includes(id)) continue;
    if (s.py && !pytestWithCoverageDir()) { quiet(`${id} skipped: no pytest with coverage.py on PATH`); continue; }
    const { files, pkg } = filesFor(s);
    const wit = (s.py ? pyWitness : witness)({ files, file: s.file, cur: s.cur, prop: s.prop, expr: s.w });
    console.log = () => {};
    let r;
    try {
      r = await e2e({ files, pkg: pkg || {}, file: s.file, cur: s.cur, prop: s.prop, critic: UNANIMOUS });
    } finally { console.log = quiet; }
    const p = r.proposal;
    const mut = p.test_outcome && p.test_outcome.mutation;
    const dt = p.diff_test || {};
    console.log(`== ${id} ${s.title}`);
    console.log(`   ${line(p)} deletions_observed=${dt.deletions_observed}`);
    if (mut) console.log(`   mutation: hunks=${mut.hunks} mutants=${mut.mutants} run=${mut.run} killed=${mut.killed}${mut.killed_line ? ` (line ${mut.killed_line})` : ''}`);
    console.log(`   witness (real ${s.py ? 'python' : 'node'}): current=${wit.cur} proposed=${wit.prop}`);
    if (r.commit) {
      console.log(`   committed ${r.commit.slice(0, 12)} on ${r.wt.branch}:`);
      console.log(r.committedDiff.split('\n').filter(l => /^[-+][^-+]/.test(l)).map(l => `     ${l}`).join('\n'));
      if (s.control) { controlsBad++; console.log('   FINDING: control committed'); } else { committed++; console.log('   FINDING: semantics-changing edit committed'); }
    } else {
      console.log(`   ${s.control ? 'ok (control reverted as expected)' : 'ok (not committed)'}`);
    }
  }
  if (committed || controlsBad) { console.log(`FINDING: ${committed + controlsBad} unsafe edit(s) committed`); process.exit(1); }
  console.log('ok');
})();
