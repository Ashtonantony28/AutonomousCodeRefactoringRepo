'use strict';

// AUDIT-24: test-runner exports changed by SG27/SG28/SG30/SG32, against what
// the executor and orchestrator read.
//   a tapResults / junitResults: { tests, load } or null; a repeated id gets
//     `#2`, `#3` (per-id counter, SG32) the same way in both formats.
//   b removeLiveDirs (SG27, called by handleSignal): removes the temp dirs of
//     a run in flight, and that run still settles (its finally tolerates it).
//   c runTests on a delegated reporter (SG28): one refused run, then results
//     without per-test data (`tests` absent), status passed.
// No API calls.
//   node audit/24/runner-api.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRepo, noTestCtx, report, exitCode } = require('./lib');
const { tapResults, junitResults, removeLiveDirs, runTests } = require('../../src/runner/test-runner');

const TAP = ['TAP version 13', '# Subtest: t', 'ok 1 - t', '  ---', '  duration_ms: 1', '  ...',
  '# Subtest: t', 'not ok 2 - t', '  ---', '  duration_ms: 1', "  failureType: 'testCodeFailure'", '  ...',
  '# Subtest: t', 'ok 3 - t', '  ---', '  duration_ms: 1', '  ...', '1..3'].join('\n');
const XML = '<testsuite><testcase classname="c" name="t"/><testcase classname="c" name="t"><failure message="x"/></testcase><testcase classname="c" name="t"/></testsuite>';

(async () => {
  const t = tapResults(TAP), j = junitResults(XML);
  console.log(`   a tap=${JSON.stringify(t)} junit=${JSON.stringify(j)} empty: tap=${tapResults('')} junit=${junitResults('<x/>')}`);
  report('a per-test parsers: shape and duplicate numbering',
    t && j && JSON.stringify(Object.keys(t.tests)) === '["t","t#2","t#3"]' && t.tests['t#2'] === 'fail' && t.load === false &&
    JSON.stringify(Object.values(j.tests)) === '["pass","fail","pass"]' && Object.keys(j.tests)[2] === 'c::t#3' && tapResults('') === null && junitResults('<x/>') === null,
    `tap keys=${t && Object.keys(t.tests)} junit keys=${j && Object.keys(j.tests)}`, '{ tests, load } with t, t#2, t#3; null without results');

  const slow = "'use strict';\nconst test = require('node:test');\ntest('slow', async () => { await new Promise(r => setTimeout(r, 1500)); });\n";
  const repo = makeRepo({ 'test/slow.test.js': slow }, { pkg: { name: 'x', private: true, scripts: { test: 'node --test' } }, gitRepo: true });
  const pre = new Set(fs.readdirSync(os.tmpdir()).filter(n => /^refactor-(pyc|cov)-/.test(n)));
  const p = noTestCtx(() => runTests({ repoRoot: repo, timeoutMs: 20_000 }));
  await new Promise(r => setTimeout(r, 400));
  const live = fs.readdirSync(os.tmpdir()).filter(n => /^refactor-(pyc|cov)-/.test(n) && !pre.has(n));
  removeLiveDirs();
  const left = live.filter(n => fs.existsSync(path.join(os.tmpdir(), n)));
  let settled = 'ok';
  try { await p; } catch (e) { settled = e.message; }
  console.log(`   b live dirs=${live.length} left after removeLiveDirs=${left.length} run settled: ${settled}`);
  report('b removeLiveDirs removes an in-flight run\'s temp dirs; the run still settles',
    live.length > 0 && left.length === 0 && settled === 'ok', `live=${live.length} left=${left.length} settled=${settled}`, 'all removed, run settles');

  const ok = "'use strict';\nconst test = require('node:test');\ntest('one', () => {});\n";
  const del = makeRepo({ 'test/one.test.js': ok }, { pkg: { name: 'x', private: true, scripts: { test: 'npm run unit --silent', unit: 'node --test --test-reporter=dot' } }, gitRepo: true });
  const r = await noTestCtx(() => runTests({ repoRoot: del, timeoutMs: 20_000 }));
  console.log(`   c delegated reporter: status=${r.status} tests=${JSON.stringify(r.tests)} collection_error=${r.collection_error}`);
  report('c delegated --test-reporter: green, no per-test results', r.status === 'passed' && r.tests === undefined,
    `status=${r.status} tests=${JSON.stringify(r.tests)}`, 'passed, tests absent');
  process.exit(exitCode());
})().catch(e => { console.error(e); process.exit(2); });
