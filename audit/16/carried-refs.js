'use strict';

// AUDIT-16 SG25 probe (unit level, no suite runs): does editMutants treat an
// inserted identifier naming a TOP-LEVEL binding of the file as a carried
// reference, as CLAUDE.md documents ("an inserted identifier ... that names
// a top-level binding of the file defined outside the edit ... every site of
// that binding's definition ... needs its own kill"; none to mutate ->
// `unmutated_ref`)? For each shape the edit is `<expr>` -> `<expr>.slice(0, X)`
// / `[0:X]` with X bound at top level in a different syntactic form.
// Expected for every row: mutants marked `ref: X`, or `unmutated_ref`.
// Prints FINDING (exit 1) for a top-level binding that gets neither (only
// the unrelated slice-start site `0` is left to kill).
//   node audit/16/carried-refs.js

require('../1/lib'); // temp REFACTOR_STATE_DIR
const { editMutants } = require('../../src/rl/bug-injector');
const { changedSpan } = require('../../src/runner/test-runner');

const JS = (pre, ref) => ({
  file: 'src/a.js',
  before: `'use strict';\n${pre}\nfunction body(s) {\n  return String(s);\n}\nmodule.exports = { body };\n`,
  after: `'use strict';\n${pre}\nfunction body(s) {\n  return String(s).slice(0, ${ref});\n}\nmodule.exports = { body };\n`,
  ref
});
const PY = (pre, ref) => ({
  file: 'app/a.py',
  before: `${pre}\n\ndef body(s):\n    return str(s)\n`,
  after: `${pre}\n\ndef body(s):\n    return str(s)[0:${ref}]\n`,
  ref
});

const rows = [
  ['JS const X = 4096 (control)', JS('const MAX_LEN = 4096;', 'MAX_LEN')],
  ['JS const { maxLen } = LIMITS', JS('const LIMITS = { maxLen: 4096 };\nconst { maxLen } = LIMITS;', 'maxLen')],
  ['JS const [MIN, MAX] = [1, 4096]', JS('const [MIN_LEN, MAX_LEN] = [1, 4096];', 'MAX_LEN')],
  ['JS let X; X = 4096', JS('let MAX_LEN;\nMAX_LEN = 4096;', 'MAX_LEN')],
  ['JS const { MAX } = require(...)', JS("const { MAX_LEN } = require('./limits');", 'MAX_LEN')],
  ['Py X = 4096 (control)', PY('MAX_LEN = 4096', 'MAX_LEN')],
  ['Py MIN, MAX = 1, 4096', PY('MIN_LEN, MAX_LEN = 1, 4096', 'MAX_LEN')],
  ['Py try: X = 4096 except: X = 1024', PY('try:\n    import zlib  # noqa\n    MAX_LEN = 4096\nexcept ImportError:\n    MAX_LEN = 1024', 'MAX_LEN')],
  ['Py if/else top-level X', PY('import sys\nif sys.maxsize > 2 ** 32:\n    MAX_LEN = 4096\nelse:\n    MAX_LEN = 1024', 'MAX_LEN')],
  ['Py from app.limits import X', PY('from app.limits import MAX_LEN', 'MAX_LEN')],
  ['Py with/for top-level X', PY('for MAX_LEN in (4096,):\n    pass', 'MAX_LEN')]
];

let bad = 0;
for (const [label, c] of rows) {
  const span = changedSpan(c.before, c.after);
  const ms = editMutants(c.after, { ...span, file: c.file, max: 3, before: c.before });
  const refs = ms.filter(m => m.ref === c.ref).length;
  const seen = refs > 0 || (ms.unmutated_ref && ms.unmutated_ref.name === c.ref);
  const sites = [...new Set(ms.map(m => m.site))].length;
  const out = ms.unmutated_ref ? `unmutated_ref=${ms.unmutated_ref.name}` : `sites=${sites} ref-mutants=${refs} [${ms.map(m => `${m.mutation}@${m.line}${m.ref ? `(ref ${m.ref})` : ''}`).join(', ')}]`;
  console.log(`${seen ? 'ok     ' : 'FINDING'} ${label.padEnd(36)} ${out}`);
  if (!seen) bad++;
}
if (bad) {
  console.log(`FINDING: ${bad} top-level bindings are not treated as carried references; only the unrelated slice start is left to kill`);
  process.exit(1);
}
console.log('ok');
