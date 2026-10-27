'use strict';

// AUDIT-44 M1: package.json `engines` allows node >= 18, but since SG50 a
// test process on a node without `module.registerHooks` (before 22.15 /
// 23.5) logs a `U` row and fails closed: no failing mutant run is a kill,
// so no JS edit can ever commit there (every one ends reverted /
// tests_insensitive, no sample). README says so under "Caught module-load
// throws"; nothing at startup or in `engines` does.
//   a  control: the audit/40 value-tested insertion commits on this node
//   b  same edit, a preload deletes module.registerHooks (audit/39/old-node.js)
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/44/old-node-engines.js

const path = require('path');
const fs = require('fs');
const { execOn, brief, report, exitCode, PKG } = require('../24/lib');

const OLD = "return 'n=' + n;";
const NEW = "return 'n=' + n + '!';";
const SRC = `'use strict';\n\nfunction label(n) {\n  ${OLD}\n}\n\nmodule.exports = { label };\n`;
const TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label } = require('../src/m');\n" +
  "test('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n";
const ROOT = path.resolve(__dirname, '..', '..');

(async () => {
  const run = async () => (await execOn({ 'src/m.js': SRC, 'test/m.test.js': TEST }, { file: 'src/m.js', current_code: OLD, proposed_code: NEW }, { pkg: PKG })).o;
  const a = await run();
  console.log(`   a: ${brief(a)}`);
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${saved || ''} --require=${path.join(ROOT, 'audit/39/old-node.js')}`.trim();
  let b;
  try { b = await run(); } finally { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; }
  console.log(`   b: ${brief(b)}`);
  const engines = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines || {};
  const m = /(\d+)(?:\.(\d+))?/.exec(engines.node || '');
  const floor = m ? [Number(m[1]), Number(m[2] || 0)] : [0, 0];
  const allowsOld = floor[0] < 22 || (floor[0] === 22 && floor[1] < 15);
  report('a control: the edit commits on this node', a.status === 'passed', brief(a), 'passed');
  report(`M1 b engines "${engines.node}" admits a node on which no JS edit can commit (no module.registerHooks: every failing mutant run is a load failure)`,
    !(allowsOld && b.status !== 'passed'), `engines=${JSON.stringify(engines)}; ${brief(b)}`,
    'engines.node >= 22.15 (or a startup warning / documented floor for JS targets), or b committing');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
