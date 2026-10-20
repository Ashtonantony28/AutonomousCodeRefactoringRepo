'use strict';

// AUDIT-18 Lows (docs vs behaviour after SG24-SG26). Temp repos in
// os.tmpdir(), temp REFACTOR_STATE_DIR via audit/10/lib.js, no API calls.
//   L1  an `.npmrc` `node-options=` replaces NODE_OPTIONS for npm scripts, so the
//       per-test reporters never reach node:test: no per-test results, every
//       edit ends tests_insensitive; README's list of suites without per-test
//       kills does not name it
//   L2  py-basic/proposals.json expects `passed` for total -> sum(values);
//       since SG26 it is `tests_insensitive` (`sum` replaces a loop: no
//       use-site evidence), and no test runs that fixture's expectations
//   L3  TestOutcome.test_command is not the command that ran: the per-test
//       reporter (NODE_OPTIONS) and pytest's --junitxml/--tb=short are missing
//   node audit/18/docs-and-shapes.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { env, gitInit, runWith, proposals, report, exitCode, noTestCtx } = require('../10/lib');
const { runTests } = require('../../src/runner/test-runner');

const W = path.join(__dirname, '..', '..');

(async () => {
  // L1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit18-npmrc-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', private: true, scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test/a.test.js'), "const test = require('node:test');\ntest('one', () => {});\n");
  const plain = await noTestCtx(() => runTests({ repoRoot: dir }));
  fs.writeFileSync(path.join(dir, '.npmrc'), 'node-options=--no-warnings\n');
  const npmrc = await noTestCtx(() => runTests({ repoRoot: dir }));
  env.rm(dir);
  const readme = fs.readFileSync(path.join(W, 'README.md'), 'utf8');
  const listed = /npmrc|node-options/.test(readme);
  console.log(`   L1 per-test results: plain=${JSON.stringify(plain.tests)} with .npmrc node-options=${JSON.stringify(npmrc.tests)}; README mentions it: ${listed}`);
  report('L1 .npmrc node-options silently disables per-test kills (undocumented)', !!npmrc.tests || listed,
    `.npmrc node-options: tests=${JSON.stringify(npmrc.tests)} (status ${npmrc.status}); README "Per-test kills" does not list it`,
    'per-test results reach node:test, or README names the case');

  // L2 + L3 (pytest)
  const fx = JSON.parse(fs.readFileSync(path.join(W, 'test/fixtures/py-basic/proposals.json'), 'utf8'))[0];
  const hasPytest = spawnSync('pytest', ['--version'], { stdio: 'ignore' }).status === 0;
  let pyCmd = null;
  if (hasPytest) {
    const py = gitInit(env.copyFixture('py-basic'));
    const { s } = await runWith(py, proposals([fx]));
    const o = s.proposals[0].test_outcome || {};
    pyCmd = o.test_command;
    console.log(`   L2 py-basic ${fx.file}: expected_status=${fx.expected_status} observed=${o.status}${o.reason ? ` (${o.reason})` : ''} unmutated_ref=${o.mutation && o.mutation.unmutated_ref}`);
    report('L2 py-basic fixture expectation stale after SG26', o.status === fx.expected_status,
      `${o.status} (${o.reason}), mutation.unmutated_ref=${o.mutation && o.mutation.unmutated_ref}`, `expected_status ${fx.expected_status} (or the fixture updated)`);
  } else console.log('   L2 skipped: pytest not installed');

  const js = gitInit(env.copyFixture('js-basic'));
  const ADD = { file: 'src/math.js', current_code: 'function add(a, b) {\n  const result = a + b;\n  return result;\n}', proposed_code: 'function add(a, b) {\n  return a + b;\n}' };
  const { s } = await runWith(js, proposals([ADD]));
  const jsCmd = s.proposals[0].test_outcome.test_command;
  console.log(`   L3 recorded test_command: js="${jsCmd}" py="${pyCmd}"`);
  const missing = !/test-reporter/.test(jsCmd) || (pyCmd != null && !/junitxml/.test(pyCmd));
  report('L3 TestOutcome.test_command omits the per-test reporter arguments that ran', !missing,
    `js "${jsCmd}" (NODE_OPTIONS reporters not shown)${pyCmd ? `, py "${pyCmd}" (no --junitxml/--tb=short)` : ''}`,
    'the command (and reporter env) that actually ran');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
