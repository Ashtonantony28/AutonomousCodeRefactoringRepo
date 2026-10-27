'use strict';

// AUDIT-39 shared helpers. test/helpers/env.js first: state goes to a temp
// dir. No API calls; src/ and test/ are only required, never changed.
require('../../test/helpers/env');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('../../src/runner/test-runner');
const { editMutants } = require('../../src/rl/bug-injector');

const L = (...l) => l.join('\n');
const PKG = JSON.stringify({ name: 'a39', version: '0.0.0', private: true, scripts: { test: 'node --test' } });
const T = (b) => L("'use strict';", "const test = require('node:test');", "const assert = require('node:assert');", b, '');

function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit39-'));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), src);
  }
  return dir;
}

// Runs the suite twice through the real runTests: `good` (the module loads)
// and `bad` (A39_BAD=1: the module body throws at load). The bad run counts
// as a kill (executor `failedTests`) when it failed, is no collection error,
// ran the same tests, and a test that passed in the good run fails in it.
async function loadProbe(files, { env = {} } = {}) {
  const dir = writeTree(files);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, env);
    delete process.env.A39_BAD;
    const good = await runTests({ repoRoot: dir });
    process.env.A39_BAD = '1';
    const bad = await runTests({ repoRoot: dir });
    const same = good.tests && bad.tests && Object.keys(bad.tests).length === Object.keys(good.tests).length &&
      Object.keys(bad.tests).every(k => k in good.tests);
    const killers = same ? Object.keys(bad.tests).filter(k => bad.tests[k] === 'fail' && good.tests[k] === 'pass') : [];
    const kill = good.status === 'passed' && bad.status === 'failed' && !bad.collection_error && killers.length > 0;
    return { good: pick(good), bad: pick(bad), killers, kill };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const pick = (r) => ({ status: r.status, collection_error: !!r.collection_error, tests: r.tests, ...(r.status === 'passed' ? {} : { out: String(r.stderr || r.stdout || '').slice(0, 200) }) });

// editMutants verdict for one edit: stopped (uncovered / unmutated / capped /
// unchecked / no site) or judged on the listed sites.
function sites(file, before, after) {
  const m = editMutants(after, { file, before, max: 3 });
  const stopped = !!(m.uncovered || m.unmutated_ref || m.capped || m.unchecked || !m.length);
  const judged = [...new Set([...m].map(x => `${x.mutation}${x.ref ? `(${x.ref})` : ''}:${after.slice(x.span[0], x.span[1]).slice(0, 16)}`))];
  return { stopped, uncovered: m.uncovered && m.uncovered.text, unmutated: m.unmutated_ref && m.unmutated_ref.name, capped: !!m.capped, unchecked: !!m.unchecked, judged };
}

// rows: { label, finding: bool, detail }. Prints FINDING / ok per row, exits 1 on any finding.
function report(rows) {
  let bad = 0;
  for (const r of rows) {
    if (r.finding) bad++;
    console.log(`${(r.finding ? 'FINDING' : 'ok').padEnd(7)} ${r.label}\n        ${r.detail}`);
  }
  console.log(bad ? `FINDING: ${bad} row(s)` : 'ok');
  process.exitCode = bad ? 1 : 0;
}

module.exports = { L, PKG, T, writeTree, loadProbe, sites, report };
