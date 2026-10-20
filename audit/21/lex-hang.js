'use strict';

// AUDIT-21 M: `hunks.lexView` never returns on a Python string literal that
// directly follows a word character (`return"x"`, `else"y"`, `in"abc"`, all
// valid Python). pyLex sees the quote, rejects it as a string start because
// the previous character is a word character, then skips "word characters"
// from the quote: none, so `i` never advances. changeHunks lexes the whole
// file, so any edit to such a file hangs the process that diffs it.
//
//   node audit/21/lex-hang.js
// a) changeHunks on a one-line edit, in a child process with a 10 s limit;
// b) the same edit end to end (non-dry, stub critic, temp state dir), in a
//    child process with a 120 s limit; c) b) with the strings spaced off.
// Prints FINDING and exits 1 when either does not finish.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const L = (...l) => l.join('\n');
const CUR = L('def label(s):', "    return 'id:' + str(s)");
const PROP = L('def label(s):', '    return "id:" + str(s)[:4096]');
const REST = process.argv[3] === 'spaced'
  ? L('', '', 'def kind(s):', '    return "text" if s else "empty"')
  : L('', '', 'def kind(s):', '    return"text" if s else"empty"');

if (process.argv[2] === '--child-unit') {
  const { changeHunks } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'hunks'));
  const src = (body) => `${body}\n${REST}\n`;
  const h = changeHunks(src(CUR), src(PROP), 'app/x.py');
  process.stdout.write(`hunks=${h.length}`);
  process.exit(0);
}

if (process.argv[2] === '--child-e2e') {
  const { e2e, UNANIMOUS } = require('../5/lib');
  const files = {
    'pytest.ini': '[pytest]\n', 'app/__init__.py': '',
    'app/x.py': `${CUR}\n${REST}\n`,
    'tests/test_x.py': L('import app.x as m', '', '', 'def test_label():', '    assert m.label("a") == "id:a"', '    assert m.kind("") == "empty"', '')
  };
  const log = console.log;
  console.log = () => {}; console.warn = () => {};
  e2e({ files, pkg: {}, file: 'app/x.py', cur: CUR, prop: PROP, critic: UNANIMOUS }).then((r) => {
    const o = r.proposal.test_outcome || {};
    log(`status=${o.status} reason=${o.reason || ''}`);
    process.exit(0);
  });
} else {
  let findings = 0;
  const run = (label, arg, timeout, control = false) => {
    const t0 = Date.now();
    // The child's temp repo, worktree and state dir go under its own TMPDIR,
    // removed here: a killed child cannot clean up.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit21-hang-'));
    const r = spawnSync(process.execPath, [__filename, arg, control ? 'spaced' : ''], { encoding: 'utf8', timeout, cwd: path.join(__dirname, '..', '..'), env: { ...process.env, TMPDIR: tmp } });
    fs.rmSync(tmp, { recursive: true, force: true });
    const hung = r.error && r.error.code === 'ETIMEDOUT';
    if (hung && !control) findings++;
    console.log(`${hung ? 'FINDING' : 'ok     '} ${label}: ${hung ? `no result after ${Date.now() - t0} ms (killed)` : `${(r.stdout || '').trim()} in ${Date.now() - t0} ms`}`);
  };
  console.log(`file tail: ${JSON.stringify(REST.trim())}`);
  run('a) changeHunks(before, after) on app/x.py', '--child-unit', 10_000);
  run('b) end to end (gate + executor) on the same edit', '--child-e2e', 120_000);
  run('c) control: b) with `return "text" if s else "empty"`', '--child-e2e', 120_000, true);
  if (findings) {
    console.log('FINDING: lexView does not terminate on a Python string that follows a word character');
    process.exit(1);
  }
  console.log('ok');
}
