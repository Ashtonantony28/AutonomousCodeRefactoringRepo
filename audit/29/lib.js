'use strict';

// Shared helpers for the AUDIT-29 scripts: audit/25/lib.js (which loads
// test/helpers/env.js first, so state goes to a temp dir; `--src DIR` runs a
// probe against another commit's `src/`), plus the JS load hook text of an
// older commit for before/after comparisons. Fixtures are generated under
// os.tmpdir(); no live API call.

const L = require('../25/lib');
const { execFileSync } = require('child_process');

// The JS_LOAD_HOOK / PY_LOAD_HOOK text of src/runner/test-runner.js at git
// revision `rev` (default 74dafcf = SG35, the last commit before SG38), or of
// `--old-src DIR` when given.
const OLD_REV = L.opt('--old-rev', '74dafcf');
function hookAt(name, rev = OLD_REV) {
  const dir = L.opt('--old-src', null);
  const text = dir
    ? L.fs.readFileSync(L.path.join(L.path.resolve(dir), 'src/runner/test-runner.js'), 'utf8')
    : execFileSync('git', ['-C', L.REPO_ROOT, 'show', `${rev}:src/runner/test-runner.js`], { encoding: 'utf8' });
  const m = text.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\n`));
  // eslint-disable-next-line no-new-func
  return m ? Function(`return \`${m[1]}\`;`)() : null;
}

// Extract `rev`'s src/ into a temp dir (node_modules symlinked) -> dir, for
// require()-ing an older module next to the current one.
function srcAt(rev) {
  const dir = L.fs.mkdtempSync(L.path.join(L.os.tmpdir(), `a29-src-${rev}-`));
  execFileSync('bash', ['-c', `git -C "${L.REPO_ROOT}" archive ${rev} src | tar -x -C "${dir}"`]);
  L.fs.symlinkSync(L.path.join(L.REPO_ROOT, 'node_modules'), L.path.join(dir, 'node_modules'));
  return dir;
}

const ms = (x) => `${Math.round(x)} ms`;

module.exports = { ...L, hookAt, srcAt, OLD_REV, ms };
