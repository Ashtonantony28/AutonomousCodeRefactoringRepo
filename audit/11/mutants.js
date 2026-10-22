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
const BI = 'src/rl/bug-injector.js';
const HK = 'src/utils/hunks.js';

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
    '      if (!killed) {\n        const sm = mutants.find(x => siteKey(x) === site);', '      if (false) {\n        const sm = mutants.find(x => siteKey(x) === site);'),
  M('X-tokill', 'redundant', EX, 'SG20: a timed-out mutant run goes on to confirmation like a failed one (backed by SG26: a kill needs a failed test in both mutant runs)',
    "        if (r.status !== 'failed') continue;", "        if (r.status !== 'failed' && r.status !== 'timeout') continue;"),
  M('X-del', 'safety', EX, 'SG18: a deletion stands without an equivalent diff test or a covering kill',
    '  if (unseen) {\n    out.unobserved_deletion_line', '  if (false) {\n    out.unobserved_deletion_line'),
  M('X-delobs', 'safety', EX, 'SG18: deletion accepted on an equivalent diff test that never ran the deleted code',
    "const observed = !!diffTest && diffTest.verdict === 'equivalent' && diffTest.deletions_observed === true;", "const observed = !!diffTest && diffTest.verdict === 'equivalent';"),
  M('X-mutleft', 'redundant', EX, 'the last mutant is left in the file (and committed) instead of the edit (backed by SG24: every kept edit ends on the unmutated control run, which writes the edit back)',
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
    '  try { killActive(); removeLiveDirs(); } catch { /* */ }\n', '  try { removeLiveDirs(); } catch { /* */ }\n'),
  M('O5', 'control', OR, 'persisted in-flight snapshot not restored on start',
    'const crashed = FileSnapshot.restoreFromDisk(inflightPath(absRepo), {', 'const crashed = null && FileSnapshot.restoreFromDisk(inflightPath(absRepo), {'),

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
    '    elif not same(la, la2):', '    elif False:'),
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
  // Re-anchored by AUDIT-19: SG25 headCommitOf has the same `.filter(Boolean).pop();`.
  M('W-trailer', 'safety', WT, 'reconciliation reads the first issue_id line (free-text reasoning) instead of the trailer',
    '.filter(Boolean).pop();\n    if (sha', '.filter(Boolean)[0];\n    if (sha'),

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
    "'no_coverage_tool', 'coverage_timeout', ", "'no_coverage_tool', "),

  // --- SG25 (AUDIT-13 C1/C2/H1/L1, AUDIT-15 H1)
  M('T-coll', 'safety', TR, 'SG25: a pytest run that failed at collection/import is not flagged (counts as a mutant kill)',
    '  if (collectionError) out.collection_error = true;', ''),
  M('T-bare', 'safety', TR, 'SG25: runs without coverage use the bare pytest script (repo root off sys.path)',
    '  if (py) { cmd = py; args', '  if (false) { cmd = py; args'),
  M('BI-refs', 'safety', 'src/rl/bug-injector.js', 'SG26: inserted references are never required (a kill on an unrelated token stands in)',
    "      if (!seen.has(u.use.join(':'))) {", '      if (false) {'),
  M('BI-unref', 'safety', 'src/rl/bug-injector.js', 'SG26: a name replaced inside changed code (nothing reverts it alone) is no longer an unmutated reference',
    "      if (t.was === '') return Object.assign([], { unmutated_ref: { name: t.name, line: base.line, hunk: hi } });", ''),
  M('BI-revert', 'safety', 'src/rl/bug-injector.js', 'SG26: a name swapped for another needs no kill of the old name back (any use of the new one stands in)',
    '      if (t.was) refs.push(', '      if (false) refs.push('),
  M('BI-lost', 'safety', 'src/rl/bug-injector.js', 'SG26: a reference whose use-site mutant does not parse is not reported (its hunk stands on other sites)',
    '  const lost = needed.find(n => !kept.has(key(n)));', '  const lost = null;'),
  M('BI-skip', 'safety', 'src/rl/bug-injector.js', 'SG26: a call is perturbed in its result instead of skipped (a nested helper\'s cap is never asked)',
    "stmt ? 'None' : skip ? `(${text(skip)})` : PY_PERTURB(text(use))", "stmt ? 'None' : PY_PERTURB(text(use))"),
  M('BI-bind', 'safety', 'src/rl/bug-injector.js', 'SG26: JS reads through a member (this.MAX, cfg.max, s.slice) are not uses',
    "    if (n.type === 'Identifier' && !bind && want.get(n.start) === n.end) found.push(n);", "    if (n.type === 'Identifier' && !bind && want.get(n.start) === n.end && !/Member/.test(p && p.type)) found.push(n);"),
  M('EX-pertest', 'safety', EX, 'SG26: a failing mutant run kills whichever tests failed (no per-test comparison with the control)',
    '        const tests = a && b ? a.filter(function (id) { return this.has(id); }, new Set(b)) : [];', "        const tests = ['run'];"),
  M('EX-testset', 'safety', EX, 'SG26: a mutant run with a test missing, crashed or added is compared as if the set were the same',
    '  if (ids.length !== Object.keys(control.tests).length || ids.some(id => !(id in control.tests))) return null;', ''),
  M('EX-nofail', 'redundant', EX, 'SG26: early skip of a failed mutant run with no failing test removed (backed by the per-test comparison after the control run)',
    "        if (!r.tests || !Object.values(r.tests).includes('fail')) { count('no_failed_test'); continue; }", ''),
  M('TR-load', 'redundant', TR, 'SG26: a module that failed to load (node:test crash / module-body frame, pytest collection error) is not flagged (backed by the SG30 load hooks)',
    ' || !!(perTest && perTest.load) || !loaded);', ' || !loaded);'),
  M('TR-pyload', 'safety', TR, 'SG26: a pytest failure raised from a module body (import inside a test) is not a load failure',
    ' || /:\\d+: in <module>$/m.test(unxml(body))) load = true;', ') load = true;'),
  M('TR-jsload', 'safety', TR, 'SG26: a node:test failure raised while a module loads is not a load failure',
    "((kv && kv[1] === 'exitCode' && indent === yaml) || LOAD_FRAME.test(line))) load = true;", "(kv && kv[1] === 'exitCode' && indent === yaml)) load = true;"),
  M('PH-tail', 'safety', PH, 'SG25: chained-comparison tails / later generators are no probe sites (the enclosing statement is)',
    '        t = tail(node, a, b)', '        t = None'),
  M('HV-delcond', 'safety', HV, 'SG25: condition_change relaxed although part of a condition was deleted',
    " && !c.deletes_condition) {", ') {'),
  M('R-committed', 'safety', RV, 'SG25: a snapshot whose edit is already committed is restored over it',
    '    if (sha) {', '    if (false) {'),

  // --- AUDIT-19: SG24-SG26 rules not pinned by a mutant above
  M('EX-coll', 'redundant', EX, 'SG26: a mutant run flagged collection_error is judged like a test failure (backed by failedTests returning null for it)',
    "        if (r.collection_error) { count('collection_errors'); continue; }\n", ''),
  { id: 'EX-coll2', kind: 'safety', why: 'SG26: collection_error ignored everywhere in the executor (first run, failedTests, confirmation run)',
    edits: [
      { file: EX, from: "        if (r.collection_error) { count('collection_errors'); continue; }\n", to: '' },
      { file: EX, from: '  if (!r.tests || !control.tests || r.collection_error) return null;', to: '  if (!r.tests || !control.tests) return null;' },
      { file: EX, from: "        if (again.status !== 'failed' || again.collection_error) { count('unconfirmed'); continue; }", to: "        if (again.status !== 'failed') { count('unconfirmed'); continue; }" }
    ] },
  M('EX-repro', 'safety', EX, 'SG24/SG26: a test failing only in the first mutant run counts (no reproduction in the second run)',
    '        const tests = a && b ? a.filter(function (id) { return this.has(id); }, new Set(b)) : [];', '        const tests = a && b ? a : [];'),
  M('EX-again', 'redundant', EX, 'SG24: second mutant run not required to fail (backed by the per-test intersection)',
    "        if (again.status !== 'failed' || again.collection_error) { count('unconfirmed'); continue; }", "        if (again.collection_error) { count('unconfirmed'); continue; }"),
  M('EX-switchoff', 'safety', EX, 'SG34: the control run keeps the mutant switched on (no control: every failing mutant run kills)',
    '        const control = await runSuite(m.src, m.control);', '        const control = await runSuite(m.src, m.env);'),
  M('EX-ctrlpass', 'safety', EX, 'SG26/SG34: a test that did not pass in the control run (flaky, or failing on the switch text) can be a kill',
    "  return ids.filter(id => r.tests[id] === 'fail' && control.tests[id] === 'pass');", "  return ids.filter(id => r.tests[id] === 'fail');"),
  M('EX-sitekey', 'safety', EX, 'SG26: revert_reference mutant shares its site with the use-site perturbation (one kill covers both)',
    'const siteKey = (m) => (m.revert ? `r${m.site}` : m.site);', 'const siteKey = (m) => m.site;'),
  M('EX-bare', 'safety', EX, 'a hunk with inserted tokens but no site no longer blocks',
    '  const bare = hunks.findIndex((h, i) => !h.deletion && !mutants.some(m => m.hunk === i));', '  const bare = -1;'),
  M('EX-unref', 'redundant', EX, 'SG26: unmutated_ref result ignored (backed: that result carries no mutants, so every hunk is bare)',
    '  if (mutants.unmutated_ref) {', '  if (false) {'),
  M('EX-unchecked', 'label', EX, 'SG24: mutant parse check not finished reported as tests_insensitive, not mutation_budget',
    '  if (mutants.unchecked) { out.budget_exhausted = true;', '  if (false) { out.budget_exhausted = true;'),
  M('TR-tapfail', 'safety', TR, 'SG26: a node:test hook / non-test-code failure (failureType != testCodeFailure) counts as a test failure',
    "add(cur.id, cur.state === 'fail' && cur.failureType !== 'testCodeFailure' ? 'error' : cur.state);", 'add(cur.id, cur.state);'),
  M('TR-juerr', 'safety', TR, 'SG26: a pytest <error> (fixture/setup error) counts as a test failure',
    "      state = /<failure\\b/.test(body) ? 'fail' : 'error';", "      state = 'fail';"),
  M('TR-jucoll', 'safety', TR, 'SG26: a pytest collection failure reported in junit (--continue-on-collection-errors, exit 1) is not a load failure',
    '      if (/<error\\b[^>]*message="collection failure/.test(body) || /:\\d+: in <module>$/m.test(unxml(body))) load = true;',
    '      if (/:\\d+: in <module>$/m.test(unxml(body))) load = true;'),
  M('TR-pyexit', 'redundant', TR, 'SG25: pytest exit 2-5 (collection/usage error) no longer flagged unless junit has a load marker (backed: such runs have no per-test failure or a changed test set)',
    '(pytest && result.exitCode >= 2 && result.exitCode <= 5) || ', ''),
  M('TR-dup', 'safety', TR, 'SG26: duplicate TAP test names overwrite each other (a failing duplicate can be hidden, a set change unseen)',
    // SG41: re-anchored (suites are kept apart too).
    'const tests = {}, suites = {}, names = [], add = adder(tests),', 'const tests = {}, suites = {}, names = [], add = (id, state) => { tests[id] = state; },'),
  M('TR-tapnest', 'safety', TR, 'SG26: TAP subtest ids not prefixed by their parents (same-named subtests in two suites collide)',
    "      cur = { id: [...names, untap(m[2])].join(' > '),", '      cur = { id: untap(m[2]),'),
  M('BI-revkey', 'safety', 'src/rl/bug-injector.js', 'SG26: revert_reference and use_site share a key (a lost revert mutant is not reported)',
    "  const key = (c) => `${c.site}${c.revert ? 'r' : ''}`;", '  const key = (c) => `${c.site}`;'),
  M('BI-default', 'safety', 'src/rl/bug-injector.js', 'SG26: a reference in a default value inside a binding pattern is not a use',
    "  return noRef || ((n.type === 'AssignmentPattern' && key === 'right') || (key === 'key' && n.computed) ? false : bind);", '  return noRef || bind;'),
  M('BI-pyattr', 'safety', 'src/rl/bug-injector.js', 'SG26: Python attribute reads (self.MAX, cfg.limit) are not uses',
    '    elif isinstance(n, ast.Attribute):\n        e = off', '    elif False:\n        e = off'),
  M('BI-sitecap', 'label', 'src/rl/bug-injector.js', 'SG26: use sites not counted toward the 12-site cap',
    '    if (sites.size + lits.length + refs.length > EDIT_MAX_SITES)', '    if (sites.size + lits.length > EDIT_MAX_SITES)'),
  M('W-headdiff', 'redundant', WT, 'SG25: snapshot discarded when HEAD names its issue_id although the file differs from HEAD (backed: issue_ids are unique per session and a committed proposal is never re-executed)',
    "  if (tryGit(dir, ['diff', '--quiet', 'HEAD', '--', ...files]) == null) return null;\n", ''),
  M('W-headid', 'redundant', WT, "SG25: snapshot discarded when HEAD is another issue's commit (backed by the diff-against-HEAD check)",
    '  if (!m || m[1] !== issueId) return null;', '  if (!m) return null;'),
  M('W-headtrailer', 'safety', WT, 'SG25: headCommitOf reads the first issue_id line (free-text reasoning) instead of the trailer',
    '.filter(Boolean).pop();\n  if (!m', '.filter(Boolean)[0];\n  if (!m'),
  M('R-committhrow', 'safety', RV, 'SG25: a committed() check that throws discards the snapshot (crashed edit left in the worktree)',
    '    try { sha = committed ? committed(data) : null; } catch { sha = null; }', "    try { sha = committed ? committed(data) : null; } catch { sha = 'mutant'; }"),
  M('O-committed', 'safety', OR, 'SG25: orchestrator passes no committed() check (crashed-after-commit snapshot restored over the commit)',
    '    committed: (d) => worktree.headCommitOf(d.repo_root, d.meta && d.meta.issue_id, Object.keys(d.files))', '    committed: null'),

  // --- SG29: AUDIT-19 M1/M3/M6
  M('X-shared', 'perf', EX, 'AUDIT-9 C2: mutant runs share the test budget with the main run (a slow suite never gets a confirmed kill)',
    'budgetMs: testTimeoutMs || TIMEOUT_MS, usedMs', 'budgetMs: (testTimeoutMs || TIMEOUT_MS) - testResult.execution_time_ms, usedMs'),
  M('TR-judup', 'safety', TR, 'SG26: duplicate JUnit test ids overwrite each other (a failing duplicate can be hidden, a set change unseen)',
    "    add(`${attr(m[1], 'classname')}::${attr(m[1], 'name')}`, state);", "    tests[`${attr(m[1], 'classname')}::${attr(m[1], 'name')}`] = state;"),
  M('BI-private', 'safety', BI, 'SG26: a #private member read is perturbed as its bare name (no parse-valid use-site mutant)',
    "    if (p.type === 'PrivateName') { u = p; [p, k] = up.get(u); }", '    if (false) { u = p; [p, k] = up.get(u); }'),
  M('BI-shorthand', 'safety', BI, 'SG26: a shorthand property { MAX } is perturbed as a bare value (no parse-valid use-site mutant)',
    "    } else if (p.type === 'ObjectProperty' && p.shorthand) rep =", '    } else if (false) rep ='),
  M('TR-hook', 'safety', TR, 'SG30: a module body throw logged by the load hooks (deep stack, wrapped require/import) is not a load failure',
    ' || !!(perTest && perTest.load) || !loaded);', ' || !!(perTest && perTest.load));'),
  M('TR-caught', 'safety', TR, 'SG33: a module body throw a passing test caught on purpose is a load failure (no kill on such a target)',
    // AUDIT-30: re-anchored after SG38 (loadFailed takes per-test names).
    '!(name ? testPassed(name, key) : passed.has(key))', '!(name ? testPassed(name, key) : false)'),
  M('TR-jspass', 'safety', TR, 'SG33: a JS load throw is excused in a test process that exits non-zero (uncaught or wrapped load failure is a kill)',
    '(code) => { if (code === 0)', '(code) => { if (true)'),
  M('TR-pypass', 'safety', TR, 'SG33: a pytest load throw is excused in a test that failed (wrapped import failure is a kill)',
    '    _finish(not _bad)\n', '    _finish(True)\n'),
  M('EX-sham', 'safety', EX, 'SG30/SG34: the control is the edit, not the same switched text (a source-reading test kills)',
    '        const control = await runSuite(m.src, m.control);', '        const control = await runSuite(edited, {});'),
  M('EX-env', 'safety', EX, 'SG34: the mutant runs never set the switch variable (mutant runs are control runs)',
    '  Object.entries(vars).forEach(set);', ''),
  M('BI-uncovered', 'safety', BI, 'SG30: an inserted token no mutant covers is carried by its siblings\' kills',
    '  if (bare) return Object.assign([], { uncovered:', '  if (false) return Object.assign([], { uncovered:'),
  M('BI-jsns', 'safety', BI, 'SG30: a JS namespace call is skipped to its module object instead of its first non-literal argument',
    'const recv = MEMBER.test(c.type) && !ns(c.object) ? c.object : null;', 'const recv = MEMBER.test(c.type) ? c.object : null;'),
  M('BI-pystmt', 'safety', BI, 'SG26: a Python call in statement position is skipped to its argument instead of dropped (None)',
    "text: stmt ? 'None' :", "text: false ? 'None' :"),
  M('BI-pyrecv', 'safety', BI, 'SG26: a Python method call is perturbed in its result instead of skipped to its receiver',
    '            skip = span(f.value)', '            skip = None'),
  M('HK-litline', 'safety', HK, 'SG31: a hunk is tokenised from its first line, not from the literal holding it (code between quotes becomes one string token)',
    '  const t = v.toks || (v.toks = tokensOf(v, 0, v.kept.length, lang));', '  const t = tokensOf(v, lines[0].s, lines[lines.length - 1].e, lang);'),
  M('HK-pyquote', 'safety', HK, 'SG31: a Python quote right after a word (`return"x"`) opens no string (the lexer stalled on it before SG31)',
    ' || !isWord(src[i - 1]) || !isWord(c)) &&', ' || !isWord(src[i - 1])) &&'),
  M('HK-slide', 'safety', HK, 'SG31: an inserted run is not slid to its balanced place (`f(x).` instead of `.f(x)`: the dot falls outside the use)',
    '  slide(pairs, at, 1);', ''),
  M('BI-unary', 'safety', BI, 'SG31: an inserted `!` / `~` has no site (it stands on a sibling\'s kill)',
    "    { name: 'drop_unary', re: /!(?!=)|~/g, to: () => '' },", ''),
  M('BI-pyin', 'safety', BI, 'SG31: an inserted Python `in` / `not` / `is` has no site',
    "    { name: 'negate_in', re: /\\bnot\\s+in\\b|", "    { name: 'negate_in', re: /\\bnever\\s+in\\b|"),
  M('BI-punct', 'safety', BI, 'SG31: every operator token is exempt from the fail-closed rule like punctuation',
    '    } else if (!SEP.test(text)) push(covers(a, b), nameAt.has(a));', '    } else if (/[\\w\'"`]/.test(text)) push(covers(a, b), nameAt.has(a));'),
  M('BI-bound', 'safety', BI, 'SG31: an inserted `=` stands on any later covered token, not the one right after it',
    '!src.slice(t.end, nx.at).trim()) t.ok = nx.ok;', 'true) t.ok = nx.ok;'),
  M('BI-switch', 'safety', BI, 'SG34: a mutant is written as plain text, not a switch (the control is the mutant too)',
    '    return { edits: [[s, e - s, text]], lo: s, hi: e };', '    return { edits: [[s, e - s, m]], lo: s, hi: e };'),
  M('BI-wrapcover', 'safety', BI, 'SG34: a token with no mutant is covered by any use site whose span holds it (an enclosing wrapper\'s kill)',
    '  const own = (x, a, b) => { if (x.use < 0 || x.use === a) return true;', '  const own = (x, a, b) => { if (true) return true;'),
  M('BI-struct', 'safety', BI, 'SG34: a bracket that frames kept code needs no site inside its structure',
    '      if (p === undefined || !fresh(o, c + 1)) push(', '      if (false) push('),
  M('BI-indent', 'safety', BI, 'SG34: a re-indented Python statement needs no site inside it',
    '      if (!depth.get(a) && !fresh(a, le)) push(', '      if (false) push('),
  M('BI-quote', 'redundant', BI, 'SG34: a quote that starts no lexView string is not rejected (backed: every string token comes from lexView)',
    "    } else if (/^['\"`]/.test(text) && !strAt.has(a)) push(false);\n", ''),
  M('HK-strlit', 'safety', HK, 'SG34: strings are not taken from lexView (a backslash-continued string hides the code after it)',
    '  v.at = new Map(v.lits.map(l => [l.s, l]));', "  v.at = new Map(v.lits.filter(l => l.kind !== 'string').map(l => [l.s, l]));"),
  M('HK-value', 'safety', HK, 'SG34: a respelled string or number is a change (a re-quoted string is a site that stands for a moved block)',
    'function valueKey(t, lang) {\n', 'function valueKey(t, lang) {\n  return t;\n'),
  M('HK-join', 'safety', HK, 'SG34: an inserted run is not slid to start with its operator or separator (a duplicated argument is perturbed as the old one)',
    '    if (join >= 0) best = join;\n', ''),
  M('DT-bound', 'safety', DT, 'SG31: integer-width boundaries are not always tried in the JS diff test (x | 0 for Math.trunc is equivalent)',
    "    for (const n of BOUNDARY_NUMS) forces.push({ n, as: 'num' });", ''),
  M('PH-bound', 'safety', PH, 'SG31: boundary values are not always tried in the Python diff test (a // 2 for int(a / 2) is equivalent)',
    '                    add({**others, n: v}, cap)', '                    pass'),
  M('EX-wall', 'perf', EX, 'SG32: only the test process time is charged to the mutant budget, not report parsing',
    '    spent += Math.max(Date.now() - t, r.execution_time_ms);', '    spent += r.execution_time_ms;'),
  M('TR-dupnext', 'perf', TR, 'SG32: duplicate test ids are numbered by probing from #2 each time (quadratic in repeats)',
    '    let k = id, n = next.get(id) || 2;', '    let k = id, n = 2;'),
  M('BI-hoist', 'perf', BI, 'SG35: the switch re-reads its variable on every evaluation instead of a binding read once per module load',
    "    const text = lang === 'python' ? (form", "    on = lang === 'python' ? `__import__('os').environ.get('${name}') == '${val}'` : `globalThis.process.env.${name} === '${val}'`;\n    const text = lang === 'python' ? (form"),
  M('BI-jsdeadline', 'perf', BI, 'SG35: the JS parse check has no time limit (a large literal statement blocks the mutant phase)',
    '      if (performance.now() > until) return', '      if (false) return'),
  M('BI-pyuses', 'label', BI, 'SG26/SG34: a use or shape check that did not finish gives no mutants unmarked (tests_insensitive, not mutation_budget)',
    '  if (!uses) return Object.assign([], { unchecked: true });', '  if (!uses) return [];'),

  // --- AUDIT-26: SG27-SG34 rules not yet covered
  M('EX-uncov', 'safety', EX, 'SG30: an uncovered_token result is ignored by the executor (the hunk stands on its other sites)',
    '  if (mutants.uncovered) { out.uncovered_token', '  if (false) { out.uncovered_token'),
  M('BI-union', 'safety', BI, 'SG30/SG31: a site covers the union of its mutants\' spans, not the span every mutant changes',
    's: Math.max(p.s, m.span[0]), e: Math.min(p.e, m.span[1])', 's: Math.min(p.s, m.span[0]), e: Math.max(p.e, m.span[1])'),
  M('BI-nameread', 'safety', BI, 'SG30: an inserted binding / key / keyword-argument name needs no covered read of the same name',
    '  for (const t of toks) if (t.name && !t.ok) t.ok = read.has(t.text);', '  for (const t of toks) if (t.name && !t.ok) t.ok = true;'),
  M('BI-applied', 'safety', BI, 'SG34: an argument-list bracket pair is covered by any enclosing use site, not only its own call',
    '(x.use >= 0 ? x.e === c + 1 :', '(x.use >= 0 ? x.e >= c + 1 :'),
  M('BI-prefix', 'safety', BI, 'SG34: a prefix-operator site anywhere before a bracket pair covers it (not only one applied to it)',
    'x.prefix && x.e <= o && !src.slice(x.e, o).trim()', 'x.prefix'),
  M('BI-lits', 'redundant', BI, 'SG30: template / f-string parts and regex atoms / flags get no site (backed: such a token is then uncovered)',
    '      if (mut) lits.push(', '      if (false) lits.push('),
  M('BI-jsparse', 'redundant', BI, 'JS switch mutants are not parse-checked (backed: a mutant that breaks load is a collection_error, never a kill)',
    '      if (sw && parses(sw)) take(b, sw);', '      if (sw) take(b, sw);'),
  M('BI-pyparse', 'redundant', BI, 'Python switch mutants are not parse-checked (backed: a collection error is never a kill)',
    '    built.forEach(([b, sw], i) => { if (ok[i] && (kept.get(key(b)) || 0) < max) take(b, sw); });', '    built.forEach(([b, sw], i) => { if ((kept.get(key(b)) || 0) < max) take(b, sw); });'),
  M('HK-holes', 'safety', HK, 'SG30: template / f-string interpolation tokens are dropped (a change inside ${} is invisible)',
    '        if (lit.holes[k]) out.push(', '        if (false) out.push('),
  M('HK-atoms', 'safety', HK, 'SG30: regex body atoms are dropped (a changed regex body is invisible)',
    "      for (const [a, b] of lit.atoms) push(a, b, '\\u0002');\n", ''),
  M('HK-indent', 'safety', HK, 'SG34: Python lines get no indentation token (a re-indented statement is no change)',
    '      if (at >= reach) out.push(', '      if (false) out.push('),
  M('HK-octal', 'safety', HK, 'SG34: a legacy octal literal compares by decimal value (10 -> 010 is no change)',
    ' : /^0\\d/.test(n) ? t : ', ' : '),
  M('HK-bigint', 'safety', HK, 'SG34: BigInt literals compare as NaN (1n -> 2n is no change)',
    '/n$/.test(n) ? `\\u0005${BigInt(n.slice(0, -1))}n` : ', ''),
  M('HK-pyfloat', 'safety', HK, 'SG34: a Python float compares equal to the int of the same value (1 -> 1.0 is no change)',
    '`\\u0005${Number(n)}.0`', '`\\u0005${Number(n)}`'),
  M('HK-bytes', 'safety', HK, "SG34: a Python bytes literal compares equal to the str of the same text ('a' -> b'a' is no change)",
    "`\\u0004${/b/i.test(m[1]) ? 'b' : ''}${m[3]}`", '`\\u0004${m[3]}`'),
  M('TR-pyoutside', 'safety', TR, 'SG33: a pytest load throw outside any test or collected module can be excused (empty key marked passed)',
    '    if ok and _key:', '    if ok:'),
  M('TR-covreset', 'safety', TR, 'SG28: coverage of the refused first run (a pre-step that loads the module) is kept for the re-run',
    '      if (covDir) { fs.rmSync(covDir, { recursive: true, force: true }); fs.mkdirSync(covDir); }\n', ''),
  M('TR-fallback', 'label', TR, 'SG28: node refusing the added reporters is not re-run without them (edit_not_exercised / label-0 sample)',
    '    if (reporters && !result.timedOut && reporterConflict(result)) {', '    if (false) {'),
  M('TR-sticky', 'perf', TR, 'SG28: a reporter conflict is not remembered (every later run starts twice)',
    '  if (reporterConflicts.has(repoRoot)) return true;\n', ''),
  M('TR-livedirs', 'perf', TR, 'SG27: in-flight temp dirs are not registered (removeLiveDirs removes nothing on a signal)',
    '  for (const d of [covDir, pycDir]) if (d) liveDirs.add(d);\n', ''),
  M('S-rmdirs', 'perf', OR, 'SG27: the signal handler no longer removes the in-flight temp dirs',
    '  try { killActive(); removeLiveDirs(); } catch { /* */ }\n', '  try { killActive(); } catch { /* */ }\n'),
  M('PH-numonce', 'safety', PH, 'SG27: a module name bound more than once (or rebound) is hinted as a numeric constant',
    '        if isinstance(tg, ast.Name) and bound.get(tg.id) == 1 and', '        if isinstance(tg, ast.Name) and bound.get(tg.id, 0) >= 1 and'),
  M('PH-numboth', 'safety', PH, 'SG27: a name numeric on one side only (the edit rebinds it) is hinted as a numeric constant',
    '    nums = module_nums(cur_tree) & module_nums(prop_tree)', '    nums = module_nums(cur_tree) | module_nums(prop_tree)'),
  M('DT-strs', 'safety', DT, 'SG31: boundary strings (tab, prototype keys, 5,000 chars) are not always tried in the JS diff test',
    '    for (const s of BOUNDARY_STRS) forces.push({ s });', ''),

  // --- AUDIT-30: SG37 (NaN value keys, structural extent, `;` / `,`) and SG38 (per-test caught-load attribution, BOM, stale kill fields)
  M('HK-nanjs', 'safety', HK, 'SG37: a JS number with no computable value keys as NaN (0x1e+6000 -> 0x2e+6000 is no change)',
    ' : Number.isNaN(Number(n)) ? t : `', ' : `'),
  M('HK-nanpy', 'safety', HK, 'SG37: a Python number with no computable value keys as NaN (6e3.real -> 7e3.real is no change)',
    'return Number.isNaN(Number(n)) ? t : `\\u0005${Number(n)}.0`;', 'return `\\u0005${Number(n)}.0`;'),
  M('BI-structoff', 'safety', BI, 'SG37: no `;` / `,` is structural (every separator exempt again)',
    '    else if (structural(a, text)) push(false);\n', ''),
  M('BI-while', 'safety', BI, 'SG37: a `;` after a `while (...)` head (empty loop body) is exempt',
    '/\\b(?:if|for(?:\\s+await)?|while|with)\\s*$/', '/\\b(?:if|for(?:\\s+await)?|with)\\s*$/'),
  M('BI-forawait', 'safety', BI, 'SG41: a `;` after a `for await (...)` head (empty loop body) is exempt',
    '/\\b(?:if|for(?:\\s+await)?|while|with)\\s*$/', '/\\b(?:if|for|while|with)\\s*$/'),
  M('BI-with', 'safety', BI, 'SG41: a `;` after a `with (...)` head (empty body) is exempt',
    '/\\b(?:if|for(?:\\s+await)?|while|with)\\s*$/', '/\\b(?:if|for(?:\\s+await)?|while)\\s*$/'),
  M('BI-sameline', 'safety', BI, 'SG41: a same-line `;` before `(`, `[`, template, `+`, `-` or `/` (the expression would continue) is exempt; only across a newline counts',
    "      return /^(?:[([`/]|\\+(?!\\+)|-(?!-))/.test(code.slice(n, n + 2));", "      return /\\n/.test(code.slice(a + 1, n)) && /^(?:[([`/]|\\+(?!\\+)|-(?!-))/.test(code.slice(n, n + 2));"),
  M('BI-splits', 'safety', BI, 'SG41: a JS comma between two kept tokens (`6000 - 1` -> `6000, - 1`) is exempt',
    "      if (text === ',') return splits(a);", "      if (text === ',') return false;"),
  M('BI-elsedo', 'safety', BI, 'SG37: a `;` after `do` is exempt (parse-invalid in practice)',
    '/\\b(?:else|do)$/', '/\\b(?:else)$/'),
  M('BI-asichar', 'safety', BI, 'SG37: a `;` before a line starting `[`, template, `+`, `-` or `/` (ASI-joined) is exempt; only `(` counts',
    '/^(?:[([`/]|\\+(?!\\+)|-(?!-))/.test(code.slice(n, n + 2))', '/^[(]/.test(code.slice(n, n + 2))'),
  M('BI-pykw', 'safety', BI, 'SG37: a Python `;` on a for / while / with / try / def ... line (joins its suite) is exempt; only if / elif / else count',
    '(?:if|elif|else|for|while|with|try|except|finally|def|class|async|case(?!', '(?:if|elif|else|case(?!'),
  M('BI-pyeq', 'safety', BI, 'SG37: a Python statement-level trailing comma before `=` (`x, = ys` unpacks) or `;` is exempt',
    "q === undefined || q === ';' || q === '=' || /\\n/", 'q === undefined || /\\n/'),
  M('BI-pykwapp', 'safety', BI, 'SG37: a paren after `in` / `not` / `and` / ... reads as a call, so `s in (t,)` (tuple) is exempt',
    '!/(?<![\\w.])(?:return|in|not|and|or|is|if|elif|else|while|for|with|as|except|raise|from|yield|await|lambda|del|assert|match|case)$/.test(head)', '!/(?<![\\w.])(?:return)$/.test(head)'),
  M('BI-pysub', 'safety', BI, 'SG37: a trailing comma in a subscript (`xs[n,]`, tuple key) is exempt',
    "code[o] === '(' ? !applied : code[o] === '[' && applied", "code[o] === '(' ? !applied : false"),
  M('BI-inside', 'safety', BI, 'SG37: a changed bracket framing kept code is covered by a sibling site inside the pair (SG34 rule)',
    'push(p !== undefined && applied(o, c));', 'push(p !== undefined && (applied(o, c) || spans.some(x => o <= x.s && x.e <= c + 1)));'),
  M('BI-insideind', 'safety', BI, 'SG37: a re-indented line framing kept code is covered by a site on that line (SG34 rule)',
    'if (!depth.get(a) && !fresh(a, le)) push(false);', 'if (!depth.get(a) && !fresh(a, le)) push(spans.some(x => a <= x.s && x.e <= le));'),
  M('TR-dupname', 'safety', TR, 'SG38: a load throw logged in a test is excused when any test of that name passed (duplicate names)',
    "byName.set(k, byName.get(k) !== false && state === 'pass')", "byName.set(k, byName.get(k) === true || state === 'pass')"),
  M('TR-noname', 'safety', TR, 'SG38: a load throw logged under a name with no per-test result (a suite, a hook) is excused',
    // SG41: a name with no test or suite falls back to its process key.
    'return v === undefined ? passed.has(key) : v;', 'return v === undefined ? true : v;'),
  M('TR-dupprefix', 'safety', TR, 'SG38: a logged name matches every id it prefixes, not only its own `#n` duplicates',
    'for (const k of m ? [id, m[1]] : [id])', 'for (const k of Array.from(id, (_, i) => id.slice(0, i + 1)))'),
  M('TR-testkey', 'safety', TR, 'SG38: a load throw logged inside any test is excused, passed or not',
    '!(name ? testPassed(name, key) : passed.has(key))', '!(name ? true : passed.has(key))'),
  M('TR-nowrap', 'safety', TR, 'SG38: node:test is not wrapped (no per-test attribution; same-process caught throws block kills again)',
    "return req === 'node:test' && typeof r === 'function' ? wrap(r) : r;", 'return r;'),
  M('TR-lastfn', 'redundant', TR, 'SG38: the first function argument is bound, not the last (node:test takes the callback last)',
    "const i = a.findLastIndex(x => typeof x === 'function');", "const i = a.findIndex(x => typeof x === 'function');"),
  M('TR-hookany', 'redundant', TR, 'SG38: a store with no string fullName is logged as a test name (JSON of undefined; never passes, fails closed)',
    "(t && typeof t.fullName === 'string' ? ", '(t ? '),
  M('TR-suite', 'safety', TR, 'SG41: suites are not recorded (a caught load throw in a passing describe callback blocks every kill)',
    "if (cur.type === 'suite') addSuite(cur.id, cur.state);", "if (cur.type === 'suite');"),
  M('TR-untap', 'safety', TR, 'SG41: TAP ids keep the reporter\'s escapes (a logged name with `#` or a backslash never matches)',
    "const untap = (s) => s.replace(/\\\\([\\\\#])/g, '$1');", 'const untap = (s) => s;'),
  M('TR-ctrl', 'safety', TR, 'SG41: a logged name with a newline is compared raw (never matches the TAP id)',
    'byName.get(name.replace(/[\\b\\f\\t\\n\\r\\v]/g, c => CTRL[c]))', 'byName.get(name)'),
  M('BI-pylambda', 'safety', BI, 'SG41: a lambda\'s commas count as the paren\'s own (`(lambda a, b: a,)` tuple is exempt)',
    'if (commas.get(o) > 1 && !lambdas.has(o)) return false;', 'if (commas.get(o) > 1) return false;'),
  M('BI-pydisplay', 'redundant', BI, 'SG41: a trailing comma in a display that already holds other commas is structural (over-rejects; fails closed)',
    'if (commas.get(o) > 1 && !lambdas.has(o)) return false;', ''),
  M('BI-pylogical', 'safety', BI, 'SG41: a Python `;` on a continuation line of a compound statement is exempt (only the physical line is read)',
    "      while (s > 0 && depth.get(s)) s = code.lastIndexOf('\\n', s - 2) + 1;\n", ''),
  M('BI-pybom1', 'label', BI, 'SG38: the Python shape check does not strip a BOM (no switch places, fewer mutants: fails closed)',
    "        stack = list(ast.parse(src.removeprefix('\\\\ufeff')).body)", '        stack = list(ast.parse(src).body)'),
  M('BI-pybom2', 'label', BI, 'SG38: the Python parse check rejects a BOM file (mutants dropped: fails closed)',
    "        ast.parse(text.removeprefix('\\\\ufeff'))", '        ast.parse(text)'),
  M('BI-pybom3', 'safety', BI, 'SG38: Python use-site offsets ignore a leading BOM (perturbations land one character off)',
    'starts = [bom]', 'starts = [0]'),
  M('EX-killclr', 'label', EX, 'SG38: a surviving site leaves killed_test / killed_line from an earlier kill',
    '        delete out.killed_line;\n        delete out.killed_test;\n', ''),

  // --- AUDIT-31: SG42 (env-blind switch control, swapped block keywords)
  M('BI-ctrlunset', 'safety', BI, 'SG42: the control run unsets the switch variable (a test reading the environment\'s keys kills every mutant)',
    'control: { [name]: off }', 'control: { [name]: undefined }'),
  M('BI-flagval', 'safety', BI, 'SG42: the switch value is the flag `1` (a test rejecting flag-like env values kills every mutant)',
    'const [val, off] = [token(), token()];', "const [val, off] = ['1', token()];"),
  M('BI-kwswap', 'safety', BI, 'SG42: a block keyword that replaced another (`while` -> `if`) is covered by its own condition site',
    'if (swappedKeyword(c.hunk, k, k + kw.length)) span[0] = k + kw.length;', '')
];

// AUDIT-19: tests seen failing on unmutated code under host load.
const FLAKY = /mutant runs have their own budget|out of mutant budget|thousands of constant bindings|V8 coverage: a file the tests never load/;

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
  if (args.includes('--check')) {
    // AUDIT-19: pattern check only (each edit of each mutant matches exactly once).
    let bad = 0;
    for (const m of MUTANTS) for (const e of m.edits) {
      const n = fs.readFileSync(path.join(ROOT, e.file), 'utf8').split(e.from).length - 1;
      if (n !== 1) { bad++; console.log(`FINDING pattern ${m.id}: found ${n} times in ${e.file}`); }
    }
    console.log(bad ? `FINDING: ${bad} pattern(s) do not match exactly once` : `ok: ${MUTANTS.length} mutants, every pattern matches once`);
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (args.includes('--list')) { for (const m of MUTANTS) console.log(`${m.id.padEnd(14)} ${m.kind.padEnd(9)} ${m.why}`); return; }
  const list = args.length ? MUTANTS.filter(m => args.includes(m.id)) : MUTANTS;
  const dir = copyRepo();
  const tally = {};
  const survivors = [];
  try {
    // AUDIT-19: timing-bound tests (FLAKY) fail under host load; the baseline
    // gets up to 3 tries and names what failed.
    let base;
    for (let i = 0; i < 3; i++) {
      base = runTests(dir, allTests(dir));
      console.log(`baseline (unmutated copy): pass=${base.pass} fail=${base.fail}${base.failed.length ? ` failed: ${base.failed.join(' | ')}` : ''}`);
      if (!base.fail && base.status === 0) break;
    }
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
        // AUDIT-19: a kill only by known timing-bound tests is re-checked once
        // on the full suite (host load gives false kills there).
        if ((r.fail > 0 || r.status !== 0) && r.failed.length && r.failed.every(n => FLAKY.test(n))) {
          console.log(`         re-check: killed only by timing-bound test(s): ${r.failed.join(' | ')}`);
          r = runTests(dir, allTests(dir)); stage += '+recheck';
        }
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
