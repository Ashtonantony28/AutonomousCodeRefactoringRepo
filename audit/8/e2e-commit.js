'use strict';

// End to end, non-dry: worktree on refactor/<run_id>, real tests with the
// coverage-evidence + mutation-sensitivity rules, commit. Every scenario is a
// semantics-changing edit with a plausible suite that calls the edited code.
// The focus is mutant-kill evasion: the suite kills a bug-injected mutant of
// the *edited lines* while never observing the actual change.
//
//   node audit/8/e2e-commit.js            # all
//   node audit/8/e2e-commit.js X1 X3      # some
// Prints FINDING per committed scenario, exits 1 if any was committed.

const { e2e, line, UNANIMOUS, pytestWithCoverageDir } = require('../5/lib');
const path = require('path');
const fs = require('fs');
const os = require('os');

const nodeTest = (req, body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('${req}');\n${body}\n`;
const NODE_PKG = { scripts: { test: 'node --test' } };

const SCENARIOS = {
  X1: {
    title: 'audit log line removed; the killed mutant is drop_return on the adjacent, tested return',
    file: 'src/billing.js',
    cur: "function discount(price) {\n  const d = price > 100 ? price * 0.9 : price;\n  console.log('discount applied', price);\n  return d;\n}",
    prop: 'function discount(price) {\n  const d = price > 100 ? price * 0.9 : price;\n  return d;\n}',
    rest: 'module.exports = { discount };',
    test: nodeTest('../src/billing', "test('discount', () => { assert.strictEqual(m.discount(50), 50); assert.strictEqual(m.discount(200), 180); });"),
    after: (m) => { const out = []; const s = console.log; console.log = (...a) => out.push(a.join(' ')); try { m.discount(50); } finally { console.log = s; } return `discount(50) logged ${JSON.stringify(out)} (was ["discount applied 50"])`; }
  },
  X2: {
    title: 'secret added to a log line; killed mutant is a numeric mutation of the adjacent tested computation',
    file: 'src/conn.js',
    cur: "function connect(url, token) {\n  const ttl = 30;\n  console.log('connecting', url);\n  return ttl * 2;\n}",
    prop: "function connect(url, token) {\n  const ttl = 30;\n  console.log('connecting', url, token);\n  return ttl * 2;\n}",
    rest: 'module.exports = { connect };',
    test: nodeTest('../src/conn', "test('connect', () => { assert.strictEqual(m.connect('u', 's3cret'), 60); });"),
    after: (m) => { const out = []; const s = console.log; console.log = (...a) => out.push(a.join(' ')); try { m.connect('u', 's3cret'); } finally { console.log = s; } return `connect logged ${JSON.stringify(out)} (was ["connecting u"]; token now leaked)`; }
  },
  X3: {
    title: 'JSON key order changed; killed mutant is a string-literal mutation of the same returned object',
    file: 'src/row.js',
    cur: "function toRow(u) {\n  return { id: u.id, name: u.name, kind: 'user' };\n}",
    prop: "function toRow(u) {\n  return { name: u.name, id: u.id, kind: 'user' };\n}",
    rest: 'module.exports = { toRow };',
    test: nodeTest('../src/row', "test('toRow', () => { const r = m.toRow({ id: 1, name: 'a' }); assert.strictEqual(r.id, 1); assert.strictEqual(r.kind, 'user'); });"),
    after: (m) => `JSON.stringify(toRow) = ${JSON.stringify(m.toRow({ id: 1, name: 'a' }))} (key order changed; was {"id":1,...})`
  },
  X4: {
    title: 'frozen result no longer frozen; killed mutant mutates an adjacent tested numeric field',
    file: 'src/cfg.js',
    cur: 'function defaults() {\n  return Object.freeze({ retries: 3, timeout: 5000 });\n}',
    prop: 'function defaults() {\n  return { retries: 3, timeout: 5000 };\n}',
    rest: 'module.exports = { defaults };',
    test: nodeTest('../src/cfg', "test('defaults', () => { assert.strictEqual(m.defaults().timeout, 5000); });"),
    after: (m) => `Object.isFrozen(defaults()) = ${Object.isFrozen(m.defaults())} (was true; callers relying on immutability break)`
  },
  X5: {
    title: 'Python: audit print removed; killed mutant is drop_return on the adjacent tested return',
    py: true,
    file: 'app/pay.py',
    cur: 'def charge(user, amt):\n    print("charge", user, amt)\n    fee = amt // 10\n    return amt - fee\n',
    prop: 'def charge(user, amt):\n    fee = amt // 10\n    return amt - fee\n',
    test: 'from app.pay import charge\n\n\ndef test_charge():\n    assert charge("ada", 100) == 90\n'
  },
  X6: {
    title: 'Python: dict.get default dropped; killed mutant mutates the adjacent tested arithmetic',
    py: true,
    file: 'app/stats.py',
    cur: 'def score(d, k):\n    base = d.get(k, 0)\n    return base + 1\n',
    prop: 'def score(d, k):\n    base = d.get(k)\n    return base + 1\n',
    test: 'from app.stats import score\n\n\ndef test_score():\n    assert score({"a": 5}, "a") == 6\n'
  }
};

function filesFor(s) {
  if (s.py) {
    return {
      files: {
        'pytest.ini': '[pytest]\n',
        'app/__init__.py': '',
        [s.file]: s.cur,
        'tests/test_it.py': s.test
      },
      pkg: null
    };
  }
  return {
    files: { [s.file]: `'use strict';\n${s.cur}\n${s.rest}\n`, 'test/a.test.js': s.test },
    pkg: NODE_PKG
  };
}

(async () => {
  const pick = process.argv.slice(2);
  const quiet = console.log;
  let committed = 0;
  for (const [id, s] of Object.entries(SCENARIOS)) {
    if (pick.length && !pick.includes(id)) continue;
    if (s.py && !pytestWithCoverageDir()) { quiet(`${id} skipped: no pytest with coverage.py on PATH`); continue; }
    const { files, pkg } = filesFor(s);
    console.log = () => {};
    let r;
    try {
      r = await e2e({ files, pkg: pkg || {}, file: s.file, cur: s.cur, prop: s.prop, critic: UNANIMOUS });
    } finally { console.log = quiet; }
    const p = r.proposal;
    const cov = p.test_outcome && p.test_outcome.coverage;
    const mut = p.test_outcome && p.test_outcome.mutation;
    console.log(`== ${id} ${s.title}`);
    console.log(`   ${line(p)}`);
    if (cov) console.log(`   coverage: tool=${cov.tool} exercised=${cov.exercised} executed_lines=${cov.executed_lines}/${cov.edited_lines} functions_missed=${cov.functions_missed}`);
    if (mut) console.log(`   mutation: mutants=${mut.mutants} run=${mut.run} killed=${mut.killed} (line ${mut.killed_line})`);
    if (r.commit) {
      committed++;
      console.log(`   committed ${r.commit.slice(0, 12)} on ${r.wt.branch}:`);
      console.log(r.committedDiff.split('\n').filter(l => /^[-+][^-+]/.test(l)).map(l => `     ${l}`).join('\n'));
      if (s.after && !s.py) {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit8-after-'));
        for (const [rel, src] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
          fs.writeFileSync(path.join(d, rel), rel === s.file ? r.committedFile : src);
        }
        console.log(`   on the committed branch: ${s.after(require(path.join(d, s.file)))}`);
        fs.rmSync(d, { recursive: true, force: true });
      } else if (s.py) {
        console.log(`   committed file:\n${r.committedFile.split('\n').map(l => '     ' + l).join('\n')}`);
      }
      console.log('   FINDING: semantics-changing edit committed');
    } else {
      console.log('   ok (not committed)');
    }
  }
  if (committed) { console.log(`FINDING: ${committed} unsafe edit(s) committed`); process.exit(1); }
  console.log('ok');
})();
