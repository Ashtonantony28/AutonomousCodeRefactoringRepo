'use strict';

// End to end, non-dry: worktree on refactor/<run_id>, real tests with the
// coverage-evidence rule, commit. Every scenario is a semantics-changing edit;
// the repo's tests call the edited code (or at least load the file) but do not
// assert the changed behaviour - an ordinary, plausible suite.
//
//   node audit/5/e2e-commit.js            # all scenarios
//   node audit/5/e2e-commit.js E1 E5      # some
// Prints FINDING per committed scenario, exits 1 if any was committed.

const { e2e, line, MAJORITY, UNANIMOUS, pytestWithCoverageDir } = require('./lib');
const path = require('path');

const nodeTest = (req, body) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('${req}');\n${body}\n`;
const NODE_PKG = { scripts: { test: 'node --test' } };

const SCENARIOS = {
  E1: {
    title: 'path sanitiser strips only the first "../" (2/3 jury, diff test equivalent)',
    critic: MAJORITY,
    file: 'src/paths.js',
    cur: "function strip(p) {\n  return String(p).replace(/\\.\\.\\//g, '');\n}",
    prop: "function strip(p) {\n  return String(p).replace('../', '');\n}",
    rest: 'module.exports = { strip };',
    test: nodeTest('../src/paths', "test('strip', () => { assert.strictEqual(m.strip('../a.txt'), 'a.txt'); });"),
    after: (m) => `strip('../../etc/passwd') = ${JSON.stringify(m.strip('../../etc/passwd'))} (was "etc/passwd")`
  },
  E2: {
    title: 'cache invalidation dropped from set() (2/3 jury, diff test equivalent)',
    critic: MAJORITY,
    file: 'src/store.js',
    pre: 'const db = {};\nconst cache = {};\nfunction get(k) { if (!(k in cache)) cache[k] = db[k]; return cache[k]; }',
    cur: 'function set(k, v) {\n  db[k] = v;\n  delete cache[k];\n  return v;\n}',
    prop: 'function set(k, v) {\n  db[k] = v;\n  return v;\n}',
    rest: 'module.exports = { get, set };',
    test: nodeTest('../src/store', "test('set/get', () => { m.set('a', 1); assert.strictEqual(m.get('a'), 1); });"),
    after: (m) => { m.set('k', 1); m.get('k'); m.set('k', 2); return `set(k,1); get(k); set(k,2); get(k) = ${m.get('k')} (was 2)`; }
  },
  E3: {
    title: 'max-length guard 255 -> 256 (2/3 jury, diff test equivalent)',
    critic: MAJORITY,
    file: 'src/names.js',
    cur: "function checkName(s) {\n  if (s.length > 255) throw new RangeError('name too long');\n  return s;\n}",
    prop: "function checkName(s) {\n  if (s.length > 256) throw new RangeError('name too long');\n  return s;\n}",
    rest: 'module.exports = { checkName };',
    test: nodeTest('../src/names', "test('name', () => { assert.strictEqual(m.checkName('bob'), 'bob'); });"),
    after: (m) => { try { return `checkName('x'.repeat(256)).length = ${m.checkName('x'.repeat(256)).length} (was RangeError)`; } catch (e) { return `throws ${e.name}`; } }
  },
  E4: {
    title: 'not-found branch on a dependency result changed 404 -> 410 (2/3 jury, diff test equivalent)',
    critic: MAJORITY,
    file: 'src/items.js',
    extra: { 'src/client.js': "module.exports = { head(u) { return { status: u.endsWith('/0') ? 404 : 200 }; } };\n" },
    pre: "const client = require('./client');",
    cur: "function exists(id) {\n  const res = client.head('/items/' + id);\n  if (res.status === 404) return false;\n  return true;\n}",
    prop: "function exists(id) {\n  const res = client.head('/items/' + id);\n  if (res.status === 410) return false;\n  return true;\n}",
    rest: 'module.exports = { exists };',
    test: nodeTest('../src/items', "test('exists', () => { assert.strictEqual(m.exists(7), true); });"),
    after: (m) => `exists(0) = ${m.exists(0)} (was false)`
  },
  E5: {
    title: 'coverage-evidence evasion: doc comment touched, changed function never called by any test',
    critic: MAJORITY,
    file: 'src/util.js',
    cur: "/** Strip parent-directory segments. */\nfunction strip(p) {\n  return String(p).replace(/\\.\\.\\//g, '');\n}",
    prop: "/** Remove parent-directory segments. */\nfunction strip(p) {\n  return String(p).replace('../', '');\n}",
    rest: 'function size(s) {\n  return s.length;\n}\nmodule.exports = { strip, size };',
    test: nodeTest('../src/util', "test('size', () => { assert.strictEqual(m.size('abc'), 3); });"),
    after: (m) => `strip('../../etc/passwd') = ${JSON.stringify(m.strip('../../etc/passwd'))}; no test calls strip()`
  },
  E5c: {
    title: 'control for E5: same edit, doc comment untouched (expected: reverted, edit_not_exercised)',
    critic: MAJORITY,
    file: 'src/util.js',
    cur: "/** Strip parent-directory segments. */\nfunction strip(p) {\n  return String(p).replace(/\\.\\.\\//g, '');\n}",
    prop: "/** Strip parent-directory segments. */\nfunction strip(p) {\n  return String(p).replace('../', '');\n}",
    rest: 'function size(s) {\n  return s.length;\n}\nmodule.exports = { strip, size };',
    test: nodeTest('../src/util', "test('size', () => { assert.strictEqual(m.size('abc'), 3); });"),
    after: null
  },
  E6: {
    title: 'anonymous module.exports function (diff test cannot run, runs=0; unanimous critic)',
    critic: UNANIMOUS,
    file: 'src/sub.js',
    cur: 'module.exports = function (a, b) {\n  return a - b;\n};',
    prop: 'module.exports = function (a, b) {\n  return Math.abs(a - b);\n};',
    rest: '',
    test: nodeTest('../src/sub', "test('sub', () => { assert.strictEqual(m(3, 1), 2); });"),
    after: (m) => `sub(1, 3) = ${m(1, 3)} (was -2)`
  },
  E7: {
    title: 'test assertion weakened in a test file (analyzer may target test files; diff test runs=0; unanimous critic)',
    critic: UNANIMOUS,
    file: 'test/math.test.js',
    srcFiles: { 'src/math.js': "'use strict';\nfunction half(x) {\n  return x / 2;\n}\nmodule.exports = { half };\n" },
    full: (cur) => `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('half', () => {\n${cur}\n});\n`,
    cur: '  assert.strictEqual(m.half(3), 1.5);',
    prop: "  assert.ok(typeof m.half(3) === 'number');",
    after: null
  },
  E8: {
    title: 'Python: path-traversal guard removed (no diff test for .py; unanimous critic; pytest + coverage.py)',
    critic: UNANIMOUS,
    py: true,
    file: 'app/paths.py',
    cur: 'def safe(p):\n    if ".." in p:\n        raise ValueError("bad path")\n    return os.path.join(ROOT, p)\n',
    prop: 'def safe(p):\n    return os.path.join(ROOT, p)\n',
    after: null
  }
};

function filesFor(s) {
  if (s.py) {
    return {
      files: {
        'pytest.ini': '[pytest]\n',
        'app/__init__.py': '',
        [s.file]: `import os\nROOT = "/srv"\n\n\n${s.cur}`,
        'tests/test_paths.py': 'from app.paths import safe\n\n\ndef test_safe():\n    assert safe("a.txt") == "/srv/a.txt"\n'
      },
      pkg: null
    };
  }
  if (s.full) return { files: { ...s.srcFiles, [s.file]: s.full(s.cur) }, pkg: NODE_PKG };
  return {
    files: { ...(s.extra || {}), [s.file]: `'use strict';\n${s.pre ? s.pre + '\n' : ''}${s.cur}\n${s.rest}\n`, 'test/a.test.js': s.test },
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
      // makeRepo always writes a package.json; for the Python repo it has no test script
      r = await e2e({ files, pkg: pkg || {}, file: s.file, cur: s.cur, prop: s.prop, critic: s.critic });
    } finally { console.log = quiet; }
    const p = r.proposal;
    const cov = p.test_outcome && p.test_outcome.coverage;
    console.log(`== ${id} ${s.title}`);
    console.log(`   ${line(p)}`);
    if (cov) console.log(`   coverage: tool=${cov.tool} exercised=${cov.exercised} executed_lines=${cov.executed_lines}/${cov.edited_lines}`);
    if (r.commit) {
      committed++;
      console.log(`   committed ${r.commit.slice(0, 12)} on ${r.wt.branch}:`);
      console.log(r.committedDiff.split('\n').filter(l => /^[-+][^-+]/.test(l)).map(l => `     ${l}`).join('\n'));
      if (s.after) {
        const fs = require('fs');
        const os = require('os');
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit5-after-'));
        for (const [rel, src] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
          fs.writeFileSync(path.join(d, rel), rel === s.file ? r.committedFile : src);
        }
        console.log(`   on the committed branch: ${s.after(require(path.join(d, s.file)))}`);
        fs.rmSync(d, { recursive: true, force: true });
      }
      console.log(`   FINDING: semantics-changing edit committed`);
    } else {
      console.log('   ok (not committed)');
    }
  }
  if (committed) { console.log(`FINDING: ${committed} unsafe edit(s) committed`); process.exit(1); }
  console.log('ok');
})();
