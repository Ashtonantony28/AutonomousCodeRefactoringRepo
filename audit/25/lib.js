'use strict';

// Shared helpers for the AUDIT-25 scripts: audit/22/lib.js (which loads
// test/helpers/env.js first, so REFACTOR_STATE_DIR / REFACTOR_DASHBOARD_DIR
// point at a temp dir before any src module loads) plus a `--src DIR`
// override, so a probe can be re-run against another commit's `src/` tree
// (`mkdir /tmp/old && git archive 5f26dd8 src | tar -x -C /tmp/old &&
// ln -s "$PWD/node_modules" /tmp/old/node_modules`). Fixtures are generated
// under os.tmpdir(); no live API call.

const L22 = require('../22/lib');

const SRC = L22.opt('--src', null);
const src = SRC ? (p) => L22.path.join(L22.path.resolve(SRC), 'src', p) : L22.src;

// The PY_LOAD_HOOK / JS_LOAD_HOOK text of src/runner/test-runner.js (not
// exported), read from the source file.
function hookText(name) {
  const text = L22.fs.readFileSync(src('runner/test-runner.js'), 'utf8');
  const m = text.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\n`));
  // The source is a template literal with only \\ escapes: evaluate it.
  // eslint-disable-next-line no-new-func
  return m ? Function(`return \`${m[1]}\`;`)() : null;
}

module.exports = { ...L22, src, SRC, hookText };
