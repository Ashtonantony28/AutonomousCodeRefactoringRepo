'use strict';

// AUDIT-11: targeted mutation testing of the rules that decide whether an
// edit is committed, reverted, or the target is touched (plus AUDIT-4
// re-checks and a few labelling rules). A mutant that SURVIVES (the whole
// suite still green) means no test pins that rule.
//
//   node audit/11/mutants.js                 # all mutants
//   node audit/11/mutants.js E1 G-dry ...    # selected ids
//   node audit/11/mutants.js --list          # ids and descriptions
//
// The repo is copied to a temp dir OUTSIDE this checkout (node_modules
// symlinked); src/ and test/ here are never modified. Per mutant: the test
// files that name the mutated module run first; a failure there kills it.
// Otherwise the full suite (`node --test test/*.test.js`) decides. Each
// mutant is checked to match its pattern exactly once, else it is reported
// as "pattern" and skipped. Prints FINDING per surviving safety mutant,
// exit 1 if any.
//
// kind: 'safety' = commit / revert / target-touch rule (survivor = Critical);
//       'redundant' = a safety rule another rule backs up (survivor is
//       expected; reported to show the back-up carries it);
//       'label' / 'perf' = learning-label or budget rules (survivor = Medium/Low);
//       'control' = expected killed (shows the harness detects breaks).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const M = (id, kind, file, why, from, to, extra = {}) => ({ id, kind, edits: [{ file, from, to }], why, ...extra });

const EX = 'src/agents/executor.js';
const TR = 'src/runner/test-runner.js';
const OR = 'src/orchestrator.js';
const HV = 'src/validation/hybrid-validator.js';
const DT = 'src/validation/diff-testing.js';
const SB = 'src/validation/diff-sandbox-worker.js';
const PW = 'src/validation/diff-prep-worker.js';
const PJ = 'src/validation/py-diff-testing.js';
const PH = 'src/validation/py_diff_harness.py';
const WT = 'src/runner/worktree.js';
const RV = 'src/runner/reverter.js';

const SAME_LINE_SB = '    if (value >= need && valued.length >= distinct && !differs && !ood && n >= calls.length) continue;';
const PY_PASS = '        if value >= MIN_VALUE_RUNS and len(valued) >= need_distinct and not (differs or ood or nondet) and n == len(sched):';

const MUTANTS = [
  // --- AUDIT-4 highs, re-checked
  M('E1', 'safety', EX, 'AUDIT-4 H1: timed-out / environment_error edits kept (and committed)',
    "if (status === 'failed' || status === 'timeout' || status === 'environment_error') {", "if (status === 'failed') {"),
  M('E2', 'safety', EX, 'AUDIT-4 H1: a failed worktree commit leaves the edit in place',
    "      snap.restoreAll();\n      return {\n        status: 'environment_error',\n        reason: `commit failed", "      return {\n        status: 'environment_error',\n        reason: `commit failed"),
  M('T1', 'safety', TR, 'AUDIT-4 H1: a test command that cannot be spawned counts as passed',
    "else if (result.spawnError) status = 'environment_error';", "else if (result.spawnError) status = 'passed';"),
  M('W1', 'safety', WT, 'AUDIT-4 H2: uncommitted target edits never copied into the worktree',
    'function syncDirtyFiles(top, wtTop, skip = null) {\n', 'function syncDirtyFiles(top, wtTop, skip = null) {\n  return [];\n'),
  M('A1', 'safety', 'src/runner/anchor-matcher.js', 'AUDIT-4 H3: whitespace tier picks the first of several matches',
    '  const idxs = allIndexes(H, N, MAX_OCCURRENCES);\n  if (!idxs.length) return null;\n  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };',
    '  const idxs = allIndexes(H, N, MAX_OCCURRENCES);\n  if (!idxs.length) return null;'),
  // AUDIT-4 mediums on safety-adjacent rules
  M('O1', 'safety', OR, 'AUDIT-4 M1: SIGINT/SIGTERM no longer flush session.json',
    '  try { if (session) saveSession(session); } catch { /* */ }\n', ''),
  M('O2', 'safety', OR, 'AUDIT-4 M1: an uncaught exception exits 0 instead of 1',
    "exit(signal === 'uncaughtException' ? 1 : 0);", 'exit(0);'),
  M('O3', 'safety', OR, 'AUDIT-4 M1: SIGTERM handler not installed (edit left in flight)',
    "  process.on('SIGTERM', () => handleSignal('SIGTERM', session));\n", ''),
  M('O4', 'safety', OR, 'AUDIT-4 M3: executor exception leaves test_outcome null (re-run on --resume)',
    "    proposal.test_outcome = { status: 'error', error: err.message };\n", ''),
  M('C1', 'safety', 'src/utils/checkpoint.js', 'AUDIT-4 M2: legacy global session adopted for another target',
    'if (!old || !old.target_repo || path.resolve(old.target_repo) !== path.resolve(targetRepo)) return null;', 'if (!old) return null;'),

  // --- executor (SG12, SG14, SG18, SG20)
  M('X-noexec', 'safety', EX, 'green suite that never executed the edit is kept (edit_not_exercised)',
    "  } else if (status === 'passed' && !coverage.exercised) {", "  } else if (false) {"),
  M('X-norunner', 'safety', EX, 'no test runner: edit kept and committed instead of skipped_no_tests',
    "  } else if (status === 'no_test_runner') {", '  } else if (false) {'),
  M('X-mutok', 'safety', EX, 'mutation evidence ignored: edit kept although no mutant failed the suite',
    '    if (!mutation.ok) {', '    if (false) {'),
  M('X-mutthrow', 'safety', EX, 'an exception during the mutant runs counts as evidence',
    '      mutation = { killed: null, ok: false, error: err.message };', '      mutation = { killed: null, ok: true, error: err.message };'),
  // X-hunk, X-del, X-delobs re-anchored after SG22 (per-site evidence, `observed` / `unseen`).
  M('X-hunk', 'safety', EX, 'per-site evidence: a site with no killed mutant no longer blocks (one kill anywhere suffices)',
    '      if (!killed) {\n        const sm = mutants.find(x => x.site === site);', '      if (false) {\n        const sm = mutants.find(x => x.site === site);'),
  M('X-tokill', 'safety', EX, 'SG20: a timed-out mutant run counts as a kill',
    "        if (r.status === 'failed') {\n          out.killed = m.mutation;", "        if (r.status === 'failed' || r.status === 'timeout') {\n          out.killed = m.mutation;"),
  M('X-del', 'safety', EX, 'SG18: a deletion stands without an equivalent diff test or a covering kill',
    '  if (unseen) {\n    out.unobserved_deletion_line', '  if (false) {\n    out.unobserved_deletion_line'),
  M('X-delobs', 'safety', EX, 'SG18: deletion accepted on an equivalent diff test that never ran the deleted code',
    "const observed = !!diffTest && diffTest.verdict === 'equivalent' && diffTest.deletions_observed === true;", "const observed = !!diffTest && diffTest.verdict === 'equivalent';"),
  M('X-mutleft', 'safety', EX, 'the last mutant is left in the file (and committed) instead of the edit',
    '  } finally {\n    fs.writeFileSync(abs, edited);\n  }', '  } finally {\n  }'),
  M('X-envthrow', 'safety', EX, 'runTests throwing leaves the edit applied',
    "  } catch (err) {\n    snap.restoreAll();\n    return {\n      status: 'environment_error',\n      reason: err.message,", "  } catch (err) {\n    return {\n      status: 'environment_error',\n      reason: err.message,"),
  M('X-unstage', 'safety', EX, 'failed commit leaves the edit staged (next commit carries it)',
    "      spawnSync('git', ['reset', '-q', '--', proposal.file], { cwd: repoRoot, stdio: 'ignore' });\n", ''),
  M('X-capped', 'label', EX, 'edit too large to mutate reported as tests_insensitive, not mutation_budget',
    '  if (mutants.capped) { out.budget_exhausted = true; out.edit_too_large = true; return done(); }', '  if (false) { out.budget_exhausted = true; out.edit_too_large = true; return done(); }'),
  M('X-reason', 'label', EX, 'mutation_budget and tests_insensitive reasons swapped',
    "reason = mutation.budget_exhausted ? 'mutation_budget' : 'tests_insensitive';", "reason = mutation.budget_exhausted ? 'tests_insensitive' : 'mutation_budget';"),
  M('X-budget', 'perf', EX, 'SG20: mutant runs start even when the budget cannot fit one',
    '    if (out.run && left < suiteMs + 500) return null;', '    if (false) return null;'),

  // --- test runner (SG12, SG14, SG16)
  M('T-perfn', 'safety', TR, 'SG14: one executed changed function is enough (others never ran)',
    'exercised: groups.length > 0 && missed.length === 0,', 'exercised: groups.length > 0 && missed.length < groups.length,'),
  M('T-count', 'safety', TR, 'SG12: a loaded but never-executed changed character counts as executed',
    'if (!hit[j] && best[j] && best[j].count > 0) { hit[j] = 1; hits++; }', 'if (!hit[j] && best[j] && best[j].count >= 0) { hit[j] = 1; hits++; }'),
  M('T-pyhit', 'safety', TR, 'SG12: Python edit counts as exercised whatever coverage.py says',
    '    g.hit = g.hit || executed.has(n);', '    g.hit = true;'),
  M('T-straggler', 'safety', TR, 'processes left in the test process group are not killed after exit (can write after revert/commit)',
    '      killGroup(proc); // stragglers left in the group\n', ''),
  M('T-grace', 'safety', TR, 'SG12: no hard bound after the timeout kill (a child that survives SIGKILL of the group hangs the run)',
    '      hardTimer = setTimeout(finish, EXIT_GRACE_MS);\n', ''),
  M('T-covto', 'label', TR, 'SG16: coverage json overrun reported as edit_not_exercised, not coverage_timeout',
    "    if (r.timedOut) throw new CoverageTimeout('coverage json exceeded the test budget');", "    if (r.timedOut) throw new Error('coverage json exceeded the test budget');"),
  M('T2', 'control', TR, 'timeout no longer reported as timeout',
    "if (result.timedOut) status = 'timeout';", "if (false) status = 'timeout';"),

  // --- orchestrator gate and flow (SG9, SG10, SG14, SG17)
  M('G-dry', 'safety', OR, '--dry-run runs the executor (on the target itself: dry runs get no worktree)',
    "  if (dryRun) {\n    proposal.test_outcome = { status: 'dry_run' };", "  if (false) {\n    proposal.test_outcome = { status: 'dry_run' };"),
  M('G-veto', 'safety', OR, 'vetoed proposals proceed to the gate',
    '  if (proposal.veto && proposal.veto.vetoed) {', '  if (false) {'),
  M('G-unan', 'safety', OR, 'SG14: a majority (not unanimous) jury is enough',
    '  if (!votes.unanimous) return `critic jury ${votes.approve}/${votes.n} approve (need unanimous)`;\n', ''),
  M('G-persona', 'safety', OR, 'SG14: a persona with p_preserves < 0.2 no longer blocks',
    'const low = jury.panel.filter(v => !(v.p_preserves >= MIN_PERSONA_P));', 'const low = [];'),
  M('G-edge', 'safety', OR, 'SG14: personas naming behaviour-changing edge cases no longer block',
    '  if (edge.length) return', '  if (false) return'),
  M('G-comb', 'redundant', OR, 'combined_confidence < 0.5 no longer blocks',
    '  if (!(proposal.combined_confidence >= REJECT_THRESHOLD)) return `combined_confidence < ${REJECT_THRESHOLD}`;\n', ''),
  M('G-block', 'safety', OR, 'SG9/SG14: unconfirmed edits (no equivalent diff test) pass the gate',
    '  return block ? `unconfirmed edit: ${block}` : null;', '  return null;'),
  M('G-p', 'safety', OR, 'jury mean p_preserves < MIN_CRITIC_P no longer blocks',
    'if (!votes.majority || p === null || p < MIN_CRITIC_P) {', 'if (!votes.majority) {'),
  M('G-rl', 'safety', OR, 'learned gate p_pass < 0.4 no longer skips the executor',
    "    if (pPass < RL_GATE_THRESHOLD) {\n      proposal.test_outcome = { status: 'rl_rejected'", "    if (false) {\n      proposal.test_outcome = { status: 'rl_rejected'"),
  { id: 'G-testfile', kind: 'safety', why: 'SG14: proposals to test files reach the critic and the executor (both checks removed)',
    edits: [
      { file: OR, from: "  if (testFile) {\n    proposal.test_outcome = { status: 'critic_rejected', reason: testFile };", to: "  if (false) {\n    proposal.test_outcome = { status: 'critic_rejected', reason: testFile };" },
      { file: OR, from: '  const testFile = testFileReason(proposal);\n  if (testFile) return testFile;\n', to: '' }
    ] },
  M('G-testfile1', 'redundant', OR, 'test-file rejection before the critic removed (criticGate still rejects)',
    "  if (testFile) {\n    proposal.test_outcome = { status: 'critic_rejected', reason: testFile };", "  if (false) {\n    proposal.test_outcome = { status: 'critic_rejected', reason: testFile };"),
  M('G-region', 'safety', OR, 'SG10: validators judge current_code/proposed_code, not the region the executor replaces',
    '  if (r.region === proposal.current_code && r.replacement === proposal.proposed_code) return null;', '  return null;'),
  M('G-reconcile', 'safety', OR, 'SG13: --resume no longer reconciles with refactor/<run_id> (committed proposal re-executed)',
    '  if (resume) reconcileWithBranch({ session, info: session.worktree, absRepo });\n', ''),
  M('G-reconcile2', 'safety', OR, 'reconciliation overwrites proposals that already have an outcome',
    '    if (p.test_outcome || !sha) continue;', '    if (!sha) continue;'),
  M('S-kill', 'safety', OR, 'signal handler no longer kills the in-flight test process group',
    '  try { killActive(); } catch { /* */ }\n', ''),
  M('O5', 'control', OR, 'persisted in-flight snapshot not restored on start',
    'const crashed = FileSnapshot.restoreFromDisk(inflightPath(absRepo));', 'const crashed = null;'),

  // --- hybrid validator (SG9, SG14, SG19)
  M('HV-js0', 'safety', HV, 'SG14: a JS/Python edit the diff test ran no input on proceeds on jury + AST alone',
    '  if (file && DIFF_FILE.test(file)) {', '  if (false) {'),
  M('HV-checks', 'safety', HV, 'SG9: non-JS unconfirmed edit proceeds although an AST check failed',
    '  if (votes.unanimous && !failed.length) return null;', '  if (votes.unanimous) return null;'),
  M('HV-runs', 'redundant', HV, 'SG9: inconclusive diff test with runs > 0 no longer blocks (DIFF_FILE rule backs it)',
    "  if (dt && dt.verdict === 'inconclusive' && dt.runs > 0) {", '  if (false) {'),
  M('HV-div', 'redundant', HV, 'divergent diff test no longer vetoes (gate still needs equivalent)',
    "  if (dt && dt.verdict === 'divergent') {", '  if (false) {'),
  M('HV-unrej', 'redundant', HV, 'unanimous critic reject no longer vetoes (gate still needs majority)',
    '  if (jury.panel.length && jury.panel.every(v => v.preserves_semantics === false)) {', '  if (false) {'),
  M('HV-relax', 'redundant', HV, 'SG19: Python condition_change veto relaxed on any diff test verdict',
    "  if (!dt || dt.verdict !== 'equivalent') return;", '  if (!dt) return;'),
  M('HV-err', 'safety', HV, 'a diff test that throws counts as equivalent',
    '      dt = inconclusive(`diff-test error: ${err.message}`, { duration_ms: elapsed(t0) });', "      dt = { applicable: true, verdict: 'equivalent', runs: 1, reason: 'mutant', duration_ms: 0 };"),
  M('H1', 'control', HV, 'severity:veto checks never veto',
    "if (c.severity === 'veto' && !c.passed)", 'if (false)'),

  // --- JS diff test (SG11, SG15, SG18, SG20)
  M('DT-hard', 'safety', DT, 'SG20: hard kill of the prep worker counts as equivalent',
    "  return finish(t0, { verdict: 'inconclusive', reason: `hard kill: ${why}`, runs: r.runs });", "  return finish(t0, { verdict: 'equivalent', reason: `hard kill: ${why}`, runs: r.runs });"),
  M('DT-exechard', 'safety', DT, 'hard kill of the sandbox worker counts as equivalent',
    "  return { verdict: 'inconclusive', reason: `hard kill: sandbox did not finish", "  return { verdict: 'equivalent', reason: `hard kill: sandbox did not finish"),
  M('DT-caps', 'safety', DT, 'SG15: caps (uncovered top-level change, host globals, state writes, target cap) no longer make the verdict inconclusive',
    "  if (res.verdict !== 'divergent' && (caps.length || !pairs.length)) {", '  if (false) {'),
  M('DT-del', 'safety', DT, 'SG18: deletions_observed reported true without the probes having run',
    "  if (deleted.length) res.deletions_observed = !!probe && res.verdict === 'equivalent' && res.deletions_observed === true;", '  if (deleted.length) res.deletions_observed = true;'),
  M('DT-pure', 'safety', DT, 'SG15: a new top-level declaration with a side-effecting initialiser counts as harmless',
    'function pureExpr(n) {\n  if (!n) return true;', 'function pureExpr(n) {\n  return true;'),
  M('DT-writes', 'safety', DT, 'SG15: a changed write to module-scope state no longer caps the verdict',
    '    if (diff.length) caps.push(', '    if (false) caps.push('),
  M('DT-globals', 'safety', DT, 'SG18: changed host-global references no longer cap the verdict',
    '  if (globals.length) caps.push(', '  if (false) caps.push('),
  M('DT-skipped', 'safety', DT, 'SG15: changed callables beyond the target cap no longer cap the verdict',
    '  if (skipped) caps.push(', '  if (false) caps.push('),
  M('PW-err', 'safety', PW, 'an exception while preparing inputs counts as equivalent',
    "  result = { verdict: 'inconclusive', reason: `diff test error:", "  result = { verdict: 'equivalent', reason: `diff test error:"),
  M('SB-budget', 'safety', SB, 'SG15: a target cut short by the time budget can be equivalent',
    SAME_LINE_SB, '    if (value >= need && valued.length >= distinct && !differs && !ood) continue;'),
  M('SB-allthrow', 'safety', SB, 'SG11: all-throw / too few value runs can be equivalent',
    SAME_LINE_SB, '    if (valued.length >= distinct && !differs && !ood && n >= calls.length) continue;'),
  M('SB-load', 'safety', SB, 'SG15: load-time differences through stubs no longer make the verdict inconclusive',
    '  if (load) { inconclusive = true; notes.push(load.note); }', '  if (false) { inconclusive = true; notes.push(load.note); }'),
  M('SB-trunc', 'safety', SB, 'SG20: deferred module state too large to compare no longer makes the verdict inconclusive',
    '      } else if (sa.trunc || sb.trunc) { inconclusive = true;', '      } else if (false) { inconclusive = true;'),
  M('SB-err', 'safety', SB, 'a sandbox exception counts as equivalent',
    "  result = { verdict: 'inconclusive', reason: `sandbox error:", "  result = { verdict: 'equivalent', reason: `sandbox error:"),
  M('SB-tested', 'safety', SB, 'no changed callable resolved can still be equivalent',
    "  if (!tested) return { verdict: 'inconclusive'", "  if (false) return { verdict: 'inconclusive'"),

  // --- Python diff test (SG19)
  M('PJ-hard', 'safety', PJ, 'Python sandbox hard kill counts as equivalent',
    "else if (r.error || r.signal) res = { verdict: 'inconclusive'", "else if (r.error || r.signal) res = { verdict: 'equivalent'"),
  M('PJ-parse', 'safety', PJ, 'unreadable harness output counts as equivalent',
    "try { res = JSON.parse(line); } catch { res = { verdict: 'inconclusive'", "try { res = JSON.parse(line); } catch { res = { verdict: 'equivalent'"),
  M('PJ-del', 'safety', PJ, 'SG18/19: Python deletions_observed forced true',
    "  if (deleted.length) res.deletions_observed = res.verdict === 'equivalent' && res.deletions_observed === true;", '  if (deleted.length) res.deletions_observed = true;'),
  M('PH-nondet', 'safety', PH, 'non-deterministic module load no longer inconclusive',
    '    if la2 is None or not same(la, la2):', '    if False:'),
  M('PH-budget', 'safety', PH, 'a target cut short by the time budget can be equivalent',
    PY_PASS, '        if value >= MIN_VALUE_RUNS and len(valued) >= need_distinct and not (differs or ood or nondet):'),
  M('PH-stub', 'safety', PH, 'load-time state differing through stubs no longer inconclusive',
    "            inconclusive = True\n            notes.append('module-scope state after load differs through dependency stubs')", "            notes.append('module-scope state after load differs through dependency stubs')"),
  M('PH-err', 'safety', PH, 'a harness exception counts as equivalent',
    "        out = {'verdict': 'inconclusive', 'runs': 0, 'reason': f'harness error:", "        out = {'verdict': 'equivalent', 'runs': 0, 'reason': f'harness error:"),
  M('PH-noload', 'safety', PH, 'a side that died before loading counts as equivalent',
    "        return {'verdict': 'inconclusive', 'runs': 0, 'reason': 'a sandboxed side ended before loading the module'}", "        return {'verdict': 'equivalent', 'runs': 0, 'reason': 'a sandboxed side ended before loading the module'}"),

  // --- worktree isolation (SG13, SG16, SG17, SG21)
  M('W-inplace', 'safety', WT, 'SG21: worktree add failing on a git repo falls back to editing the target in place',
    '  if (!branch) {\n    throw Object.assign(', "  if (!branch) {\n    return { mode: 'in-place', root: absTarget, reason: 'mutant' };\n    throw Object.assign("),
  M('W-retry', 'perf', WT, 'SG21: no retry on refactor-run/<run_id> (fails closed with EWORKTREE)',
    '  for (const name of [branchFor(runId), fallbackBranchFor(top, runId)]) {', '  for (const name of [branchFor(runId)]) {'),
  M('W-status', 'safety', WT, 'SG16: git status failure reads as a clean target (validates HEAD)',
    '    throw new Error(`git status failed: ${String(err.stderr || err.message).trim()}`);', '    return [];'),
  M('W-copy', 'safety', WT, 'SG16: a dirty file that cannot be copied is skipped silently',
    '      throw new Error(`could not copy ${rel} into the worktree: ${err.message}`);', '      continue;'),
  M('W-rename', 'safety', WT, 'SG13: rename/copy entries mis-parsed (source path taken as an entry)',
    "    if ((e[0] === 'R' || e[0] === 'C') && entries[i + 1]) paths.push(entries[++i]);", '    if (false) paths.push(entries[++i]);'),
  M('W-gone', 'safety', WT, 'SG17: --resume with the run branch gone edits the target in place',
    '    if (tryGit(top, [\'rev-parse\', \'--verify\', \'--quiet\', `refs/heads/${info.branch}`]) == null) throw fail(`branch ${info.branch} no longer exists`);',
    "    if (tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`]) == null) return { mode: 'in-place', root: absTarget, reason: 'mutant' };"),
  M('W-notgit', 'safety', WT, 'SG17: --resume on a target that is no longer a git repo edits it in place',
    "  if (!top) throw fail('target is no longer a git repository');", "  if (!top) return { mode: 'in-place', root: absTarget, reason: 'mutant' };"),
  M('W-head', 'safety', WT, 'SG17: resume accepts a recorded path that is not a worktree on the run branch',
    "  if (tryGit(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']) !== info.branch) throw fail(", '  if (false) throw fail('),
  M('W-readd', 'safety', WT, 'SG17: resume re-add failure is swallowed',
    '      throw fail(`git worktree add failed: ${String(err.stderr || err.message).trim()}`);', '      void err;'),
  M('W-skip', 'safety', WT, 'SG17: re-created worktree overwrites files the run branch changed with the target\'s dirty copies',
    "      synced = syncDirtyFiles(top, info.path, new Set((changed || '').split('\\0').filter(Boolean)));", '      synced = syncDirtyFiles(top, info.path, null);'),
  M('W-resync', 'safety', WT, 'SG17: dirty sync failure on re-created worktree is swallowed',
    "      tryGit(top, ['worktree', 'remove', '--force', info.path]);\n      throw fail(err.message);", '      void err;'),
  M('W-add', 'safety', WT, 'commit stages every change in the worktree (dirty-synced files too), not only the edited file',
    "  git(info.path, ['add', '--', rel]);", "  git(info.path, ['add', '-A']);"),
  M('W-trailer', 'safety', WT, 'reconciliation reads the first issue_id line (free-text reasoning) instead of the trailer',
    '.filter(Boolean).pop();', '.filter(Boolean)[0];'),

  // --- crash snapshots (SG5, SG21)
  M('R-discard', 'safety', RV, 'SG21: snapshot of a vanished worktree is restored (fails every later run) instead of discarded',
    '    if (!fs.existsSync(data.repo_root)) {', '    if (false) {'),
  M('R-persist', 'safety', RV, 'snapshot not persisted before the edit (crash mid-test unrecoverable)',
    '    this.persist();\n  }\n\n  persist() {', '  }\n\n  persist() {'),
  M('R-region', 'safety', RV, 'SG10: executor applies the edit although the matched region is not the validated one',
    'if (expectedRegion != null && region !== expectedRegion) {', 'if (false) {'),

  // --- learning identity / labels (SG14, SG17)
  M('L-key', 'label', 'src/rl/collector.js', 'SG17: samples keyed by issue_id only (a different edit replaces the sample)',
    'return `${s.edit_id || s.proposal_id}|', 'return `${s.proposal_id}|'),
  M('L-calkey', 'label', 'src/rl/calibration.js', 'SG17: calibration points keyed by issue_id only',
    '    const key = pt => pt.edit_id || pt.proposal_id;', '    const key = pt => pt.proposal_id;'),
  M('L-budget', 'label', 'src/rl/collector.js', 'SG20: mutation_budget reverts become label-0 samples',
    "'tests_insensitive', 'mutation_budget'];", "'tests_insensitive'];"),
  M('L-covto', 'label', 'src/rl/collector.js', 'SG16: coverage_timeout reverts become label-0 samples',
    "'no_coverage_tool', 'coverage_timeout', ", "'no_coverage_tool', ")
];

function copyRepo() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'audit11-mut-'));
  for (const e of fs.readdirSync(ROOT)) {
    if (['.git', 'node_modules', 'state', 'dashboard'].includes(e)) continue;
    fs.cpSync(path.join(ROOT, e), path.join(dst, e), { recursive: true });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dst, 'node_modules'), 'dir');
  return dst;
}

function allTests(dir) {
  return fs.readdirSync(path.join(dir, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
}

const ALIAS = { 'diff-sandbox-worker': 'diff-testing', 'diff-prep-worker': 'diff-testing', py_diff_harness: 'py-diff-testing' };
function subsetFor(dir, m) {
  const names = new Set(m.edits.map(e => { const b = path.basename(e.file).replace(/\.(js|py)$/, ''); return ALIAS[b] || b; }));
  return allTests(dir).filter(t => { const s = fs.readFileSync(path.join(dir, t), 'utf8'); return [...names].some(n => s.includes(n)); });
}

function runTests(dir, tests) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: dir, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 << 20 });
  const num = (k) => { const x = (r.stdout || '').match(new RegExp(`^# ${k} (\\d+)`, 'm')); return x ? Number(x[1]) : null; };
  const failed = [...(r.stdout || '').matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(x => x[1]).filter(n => !/\.test\.js$/.test(n));
  return { pass: num('pass'), fail: num('fail'), failed, status: r.status };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) { for (const m of MUTANTS) console.log(`${m.id.padEnd(14)} ${m.kind.padEnd(9)} ${m.why}`); return; }
  const list = args.length ? MUTANTS.filter(m => args.includes(m.id)) : MUTANTS;
  const dir = copyRepo();
  const tally = {};
  const survivors = [];
  try {
    const base = runTests(dir, allTests(dir));
    console.log(`baseline (unmutated copy): pass=${base.pass} fail=${base.fail}`);
    if (base.fail || base.status !== 0) { console.log('baseline is not green; aborting'); process.exitCode = 2; return; }
    for (const m of list) {
      const origs = new Map();
      let bad = null;
      for (const e of m.edits) {
        const abs = path.join(dir, e.file);
        const cur = origs.has(abs) ? null : fs.readFileSync(abs, 'utf8');
        if (cur !== null) origs.set(abs, cur);
        const text = fs.readFileSync(abs, 'utf8');
        const n = text.split(e.from).length - 1;
        if (n !== 1) { bad = `pattern found ${n} times in ${e.file}`; break; }
        fs.writeFileSync(abs, text.replace(e.from, () => e.to));
      }
      const t0 = Date.now();
      let verdict, by = [], stage = '';
      if (bad) verdict = 'pattern';
      else {
        const sub = subsetFor(dir, m);
        let r = sub.length ? runTests(dir, sub) : null;
        stage = `subset(${sub.length})`;
        if (!r || !(r.fail > 0 || r.status !== 0)) { r = runTests(dir, allTests(dir)); stage = 'full'; }
        const dead = r.fail > 0 || r.status !== 0;
        verdict = dead ? 'killed' : 'SURVIVED';
        by = [...new Set(r.failed)].slice(0, 2);
      }
      for (const [abs, text] of origs) fs.writeFileSync(abs, text);
      tally[`${m.kind}:${verdict}`] = (tally[`${m.kind}:${verdict}`] || 0) + 1;
      const flag = verdict === 'SURVIVED' && m.kind === 'safety' ? 'FINDING ' : verdict === 'SURVIVED' && m.kind === 'control' ? 'FINDING(control) ' : '';
      if (verdict === 'SURVIVED') survivors.push(m);
      console.log(`${flag}${verdict.padEnd(8)} ${m.id.padEnd(14)} [${m.kind}] ${m.why}  (${stage}, ${Date.now() - t0} ms)${bad ? ` ${bad}` : ''}`);
      if (by.length) console.log(`         by: ${by.join(' | ')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${JSON.stringify(tally)}`);
  console.log(`survivors: ${survivors.map(m => `${m.id}(${m.kind})`).join(' ') || 'none'}`);
  const findings = survivors.filter(m => m.kind === 'safety' || m.kind === 'control');
  console.log(findings.length ? `FINDING: ${findings.length} safety/control mutant(s) survive the full suite` : 'ok: no safety mutant survives');
  process.exitCode = findings.length ? 1 : 0;
}

main();
