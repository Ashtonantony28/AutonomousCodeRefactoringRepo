'use strict';

// AUDIT-18 H1: the per-test reporters SG26 adds through NODE_OPTIONS
// (`--test-reporter=tap` twice, two destinations) are skipped only when the
// suite's own `--test-reporter` is in package.json `scripts.test` or in
// NODE_OPTIONS (test-runner.js `ownsReporters`). A `scripts.test` that
// delegates (`npm run unit`) to a script with its own reporter gets three
// reporters and two destinations, and node refuses to start the test run.
// Every run of that suite, the main run included, is red with no test run.
// README: such suites "get no kill and end `tests_insensitive`".
//   a  control: js-basic as is                           -> passed
//   b  "test": "npm run unit", unit has --test-reporter=dot -> documented tests_insensitive
//   c  as b, after a smoke step that loads the edited module -> documented tests_insensitive,
//      never a labelled failure (sample label 0, false-positive reward, Reflexion)
// The suite in b and c passes when run by hand (npm test, exit 0).
// Full pipeline, stub client, temp REFACTOR_STATE_DIR (audit/10/lib.js).
//   node audit/18/nested-reporter.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { env, gitInit, runWith, proposals, report, exitCode } = require('../10/lib');
const { loadSamples } = require('../../src/rl/collector');

const ADD = { file: 'src/math.js', current_code: 'function add(a, b) {\n  const result = a + b;\n  return result;\n}', proposed_code: 'function add(a, b) {\n  return a + b;\n}' };

function setup(scripts, extra = {}) {
  const dir = env.copyFixture('js-basic');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (scripts) pkg.scripts = scripts;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [rel, src] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  return gitInit(dir);
}

function byHand(repo) {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  return spawnSync('npm', ['test', '--silent'], { cwd: repo, env: e, encoding: 'utf8' }).status;
}

async function run(id, repo) {
  const stub = proposals([ADD]);
  let reflexion = 0;
  stub.reflexion = () => { reflexion++; return 'not json'; };
  const { s } = await runWith(repo, stub);
  const p = s.proposals.find(x => x.file === ADD.file && !x.parent_issue_id);
  const o = p.test_outcome || {};
  const samples = loadSamples(repo).filter(x => !x.synthetic);
  const line = `${id}: status=${o.status} reason=${o.reason === undefined ? '(none)' : o.reason} exercised=${o.coverage && o.coverage.exercised} ` +
    `labels=[${samples.map(x => x.label)}] reflexion_calls=${reflexion} fp_penalty=${p.reward_breakdown ? p.reward_breakdown.fp_penalty : '-'} by_hand_exit=${byHand(repo)}`;
  console.log('   ' + line);
  return { o, samples, reflexion, stderr: (o.stderr_tail || '').split('\n').filter(Boolean).slice(-4).join(' | ') };
}

(async () => {
  const unit = 'node --test --test-reporter=dot test/math.test.js';
  const a = await run('a control', setup(null));
  const b = await run('b nested own reporter', setup({ test: 'npm run unit --silent', unit }));
  const smoke = "'use strict';\nconst { add } = require('../src/math');\nif (add(1, 2) !== 3) process.exit(1);\n";
  const c = await run('c smoke step + nested reporter', setup({ test: 'node scripts/smoke.js && npm run unit --silent', unit }, { 'scripts/smoke.js': smoke }));
  console.log(`   b stderr tail: ${b.stderr.slice(0, 300)}`);

  report('control', a.o.status === 'passed', `status=${a.o.status}`, 'passed');
  report('H1b a delegated test script with its own --test-reporter: every run is red, no test runs',
    b.o.status === 'reverted' && b.o.reason === 'tests_insensitive',
    `status=${b.o.status} reason=${b.o.reason} (node rejects the extra reporters; the suite passes by hand)`,
    'README "Per-test kills": no kill, `reverted` with `tests_insensitive`; the main run green as without the harness');
  report('H1c as b, after a step that loads the edited module: a passing edit becomes a labelled failure',
    !(c.o.status === 'reverted' && !c.o.reason) && !c.samples.some(x => x.label === 0) && c.reflexion === 0,
    `status=${c.o.status} reason=${c.o.reason === undefined ? '(none)' : c.o.reason}, label-0 sample=${c.samples.some(x => x.label === 0)}, Reflexion calls=${c.reflexion}`,
    'an untested revert (no sample, no reward, no Reflexion); the suite is green by hand');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
