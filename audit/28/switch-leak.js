'use strict';

// AUDIT-28: can the SG34/SG35 mutant switch (`(_refactor_mutant ? M : O)`)
// or its hoisted module binding (`var _refactor_mutant = globalThis.process
// .env.REFACTOR_MUTANT === '1';`, Python `_refactor_mutant = __import__('os')
// ...`) leak into a committed file, the working file, the git tree, the
// orchestrator's process.env, or a synthetic negative?
//   a  JS kept edit     -> committed blob == the edited text, no switch anywhere
//   b  JS reverted edit -> file == pre-edit text, tree clean
//   c  Python kept edit, docstring + __future__ (hoist form 'after')
//   d  Python kept edit, `def` first (hoist form 'line')
//   e  Python reverted edit
//   f  syntheticNegatives of the kept JS proposal: no switch text in samples
//   g  SIGKILL while a mutant is in the file, then the startup restore
//      (FileSnapshot.restoreFromDisk, as orchestrator.js) -> pre-edit text
//   h  SIGTERM while a mutant is in the file (handleSignal) -> pre-edit text
// Executor only (runExecutor on temp git repos), no API calls.
//   node audit/28/switch-leak.js

const L = require('./lib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { syntheticNegatives } = require('../../src/rl/bug-injector');
const { FileSnapshot } = require('../../src/runner/reverter');
const worktree = require('../../src/runner/worktree');

const JS_M = "'use strict';\n\nfunction label(n) {\n  return 'n=' + n;\n}\n\nmodule.exports = { label };\n";
const JS_T = (strict) => "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst { label } = require('../src/m');\n" +
  (strict ? "test('label', () => { assert.strictEqual(label(1), 'n=1!'); });\n" : "test('label', () => { assert.ok(label(1).startsWith('n=1')); });\n");
const JS_EDIT = { file: 'src/m.js', current_code: "return 'n=' + n;", proposed_code: "return 'n=' + n + '!';" };

const PY_DOC = '"""Labels."""\nfrom __future__ import annotations\n\n\ndef label(n):\n    return \'n=\' + str(n)\n';
const PY_DEF = "def label(n):\n    return 'n=' + str(n)\n";
const PY_T = (strict) => 'from app.m import label\n\n\ndef test_label():\n' + (strict ? "    assert label(1) == 'n=1!'\n" : "    assert label(1).startswith('n=1')\n");
const PY_EDIT = { file: 'app/m.py', current_code: "return 'n=' + str(n)", proposed_code: "return 'n=' + str(n) + '!'" };
const pyFiles = (m, strict) => ({ 'pytest.ini': '[pytest]\ntestpaths = tests\n', 'app/__init__.py': '', 'app/m.py': m, 'tests/test_m.py': PY_T(strict) });

// Everything the run left: working file, HEAD blob, every commit's patch,
// untracked / modified paths (pytest's own .pytest_cache aside), env.
function leaks(repo, file, expect) {
  const work = fs.readFileSync(path.join(repo, file), 'utf8');
  const head = L.gitOut(repo, 'show', `HEAD:${file}`);
  const patches = L.gitOut(repo, 'log', '-p', '--all');
  const status = L.gitOut(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(l => l && !/\.pytest_cache\//.test(l));
  const bad = [];
  if (work !== expect) bad.push('working file != expected');
  if (L.SWITCH.test(work)) bad.push('switch in working file');
  if (L.SWITCH.test(head) || L.SWITCH.test(patches)) bad.push('switch committed');
  if (status.length) bad.push(`tree dirty: ${status.join(' | ')}`);
  if (L.envKeys().length) bad.push(`process.env keeps ${L.envKeys()}`);
  return { bad, head, work };
}

async function kept(id, files, edit, expectStatus) {
  const { o, repo, proposal } = await L.execCommit(files, edit, { pkg: edit.file.endsWith('.py') ? null : L.PKG });
  const before = files[edit.file];
  const edited = before.replace(edit.current_code, edit.proposed_code);
  const r = leaks(repo, edit.file, expectStatus === 'passed' ? edited : before);
  const ran = o.mutation ? o.mutation.run : 0;
  console.log(`   ${id}: status=${o.status} reason=${o.reason || '(none)'} mutant runs=${ran} commit=${o.commit ? o.commit.slice(0, 8) : '-'} leaks=${JSON.stringify(r.bad)}`);
  L.report(id, o.status === expectStatus && ran > 0 && !r.bad.length && (expectStatus !== 'passed' || r.head === edited),
    `status=${o.status} mutant runs=${ran} leaks=${JSON.stringify(r.bad)}`, `${expectStatus}, mutants ran, no switch text or binding anywhere, env clean`);
  return { o, repo, proposal };
}

// g: a child runs the executor with a persisted snapshot; it is SIGKILLed
// as soon as the file holds a switched mutant.
// sig 'SIGKILL': then the startup restore; 'SIGTERM': the child installed
// orchestrator.handleSignal, which must restore the file itself.
async function killMidMutant(id, sig) {
  const slow = JS_T(true) + "test('slow', async () => { await new Promise(r => setTimeout(r, 1500)); });\n";
  const repo = L.makeRepo({ 'src/m.js': JS_M, 'test/m.test.js': slow }, { pkg: L.PKG, gitRepo: true });
  const snap = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit28-snap-')), 'inflight.json');
  const proposal = { issue_id: 'audit28g', diff_test: L.EQUIV, reasoning: '', risk_estimate: 0.1, ...JS_EDIT };
  const code = `const { runExecutor } = require(${JSON.stringify(path.resolve(__dirname, '../../src/agents/executor'))});
const { handleSignal } = require(${JSON.stringify(path.resolve(__dirname, '../../src/orchestrator'))});
process.on('SIGTERM', () => handleSignal('SIGTERM', null));
runExecutor(${JSON.stringify({ proposal, repoRoot: repo, snapshotPath: snap })}).then(() => process.exit(0));`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-e', code], { env, stdio: 'ignore' });
  const abs = path.join(repo, 'src/m.js');
  let seen = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && child.exitCode === null) {
    let s = '';
    try { s = fs.readFileSync(abs, 'utf8'); } catch { /* */ }
    if (L.SWITCH.test(s)) { seen = true; child.kill(sig); break; }
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => (child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)));
  await new Promise(r => setTimeout(r, 2500)); // the orphaned suite finishes
  const leftBefore = L.SWITCH.test(fs.readFileSync(abs, 'utf8'));
  const exit = child.exitCode;
  const res = sig === 'SIGTERM' ? null : FileSnapshot.restoreFromDisk(snap, { committed: (d) => worktree.headCommitOf(d.repo_root, d.meta && d.meta.issue_id, Object.keys(d.files)) });
  const after = fs.readFileSync(abs, 'utf8');
  const inflight = fs.existsSync(snap);
  console.log(`   ${id}: ${sig} with a switch in the file=${seen}; exit=${exit}; switch left before restore=${leftBefore}; restore=${JSON.stringify(res && { restored: res.restored, discarded: res.discarded })}; inflight.json left=${inflight}; file==pre-edit=${after === JS_M}; env=${L.envKeys()}`);
  L.report(`${id} ${sig} mid-mutant: ${sig === 'SIGTERM' ? 'handleSignal' : 'the startup restore'} puts the pre-edit text back`,
    seen && after === JS_M && !L.SWITCH.test(after) && !inflight && (sig !== 'SIGTERM' || exit === 0),
    `seen=${seen} exit=${exit} file==pre-edit=${after === JS_M} inflight.json left=${inflight}`, 'pre-edit text, no switch, snapshot consumed');
}

(async () => {
  const a = await kept('a JS kept edit: committed text is the edit, no switch', { 'src/m.js': JS_M, 'test/m.test.js': JS_T(true) }, JS_EDIT, 'passed');
  await kept('b JS reverted edit: pre-edit text, no switch', { 'src/m.js': JS_M, 'test/m.test.js': JS_T(false) }, JS_EDIT, 'reverted');
  await kept('c Python kept edit (docstring + __future__ hoist)', pyFiles(PY_DOC, true), PY_EDIT, 'passed');
  await kept('d Python kept edit (def first, own-line hoist)', pyFiles(PY_DEF, true), PY_EDIT, 'passed');
  await kept('e Python reverted edit', pyFiles(PY_DEF, false), PY_EDIT, 'reverted');

  const p = { ...a.proposal, test_outcome: a.o, critic_verdict: null, pattern_check_results: [] };
  const negs = syntheticNegatives(p, a.repo, { persist: false });
  const text = JSON.stringify(negs);
  console.log(`   f: synthetic negatives=${negs.length} switch in samples=${L.SWITCH.test(text)}`);
  L.report('f synthetic negatives of a kept edit carry no switch text', !L.SWITCH.test(text), `n=${negs.length} switch=${L.SWITCH.test(text)}`, 'no switch');

  await killMidMutant('g', 'SIGKILL');
  await killMidMutant('h', 'SIGTERM');
  process.exit(L.exitCode());
})().catch(e => { console.error(e); process.exit(2); });
