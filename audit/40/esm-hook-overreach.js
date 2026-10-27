'use strict';

// AUDIT-40 L1 / L2: two SG45/SG46 ES-module load-hook rules reach further
// than CLAUDE.md / README describe. Both fail closed (no kill, no commit,
// no sample), so every edit on such a suite ends reverted /
// tests_insensitive with mutation.collection_errors.
//   a  control: `node --test`, a value-tested insertion commits
//   b  L1: `node --import ./test/setup.mjs --test`, where setup.mjs only sets
//      a global (no module.register: not an async loader). The hook treats
//      every `--import` as an async loader (`U` row), so a failing mutant
//      run is a load failure. CLAUDE.md: "a process with an async loader
//      gets none"; module.registerHooks works beside a plain --import.
//   c  L2: a test spawns an ES module CLI whose body ends in
//      `process.exit(0)` (it never completes). The ES module hook logs every
//      module "loaded but not completed at exit", the spawned child's key
//      never passes, so every failing run is a load failure.
//   d  control for c: the same CLI as CommonJS commits.
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/40/esm-hook-overreach.js

const { execOn, brief, report, exitCode, PKG } = require('../24/lib');

const OLD = "return 'n=' + n;";
const NEW = "return 'n=' + n + '!';";
const SRC = `'use strict';\n\nfunction label(n) {\n  ${OLD}\n}\n\nmodule.exports = { label };\n`;
const TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label } = require('../src/m');\n" +
  "test('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n";
const cliTest = (cli) => "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { execFileSync } = require('child_process');\nconst path = require('path');\n" +
  `test('cli', () => { assert.strictEqual(execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', '${cli}')], { encoding: 'utf8' }).trim(), 'usage: m'); });\n`;
const CLI_BODY = "console.log('usage: m');\nprocess.exit(0);\n";

async function one(id, files, pkg) {
  const { o } = await execOn({ 'src/m.js': SRC, 'test/m.test.js': TEST, ...files }, { file: 'src/m.js', current_code: OLD, proposed_code: NEW }, { pkg });
  console.log(`   ${id}: ${brief(o)}`);
  return o;
}

(async () => {
  const a = await one('a', {}, PKG);
  const b = await one('b', { 'test/setup.mjs': 'globalThis.AUDIT_SETUP = true;\n' }, { ...PKG, scripts: { test: 'node --import ./test/setup.mjs --test' } });
  const c = await one('c', { 'bin/cli.mjs': CLI_BODY, 'test/cli.test.js': cliTest('cli.mjs') }, PKG);
  const d = await one('d', { 'bin/cli.js': CLI_BODY, 'test/cli.test.js': cliTest('cli.js') }, PKG);
  report('a control: value-tested insertion commits', a.status === 'passed', brief(a), 'passed');
  report('L1 b a plain `--import` setup module (no async loader) makes every failing mutant run a load failure', b.status === 'passed', brief(b),
    'passed (registerHooks works beside a plain --import), or CLAUDE.md saying every --import disables kills');
  report('L2 c a spawned ES module CLI that ends in process.exit() makes every failing mutant run a load failure', c.status === 'passed', brief(c),
    'passed as d, or README / CLAUDE.md naming process.exit() in an ES module body as "not completed"');
  report('d control: the same CLI as CommonJS commits', d.status === 'passed', brief(d), 'passed');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
