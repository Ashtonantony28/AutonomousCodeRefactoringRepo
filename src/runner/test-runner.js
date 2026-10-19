'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const TIMEOUT_MS = 60_000;
// After the child exits, buffered output gets DRAIN_MS to arrive; a child that
// survives the timeout kill is abandoned EXIT_GRACE_MS later.
const DRAIN_MS = 250;
const EXIT_GRACE_MS = 1500;
const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

function detectCommand(repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.test) return { cmd: 'npm', args: ['test', '--silent'], framework: 'npm' };
    } catch { /* */ }
  }
  if (fs.existsSync(path.join(repoRoot, 'pytest.ini')) ||
      fs.existsSync(path.join(repoRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(repoRoot, 'setup.cfg'))) {
    return { cmd: 'pytest', args: ['-q'], framework: 'pytest' };
  }
  if (fs.existsSync(path.join(repoRoot, 'Makefile'))) {
    return { cmd: 'make', args: ['test'], framework: 'make' };
  }
  return null;
}

function parseCounts(stdout, framework) {
  const text = stdout || '';
  let passed = 0, failed = 0;

  // Jest
  let m = text.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(?:\d+\s+skipped,\s+)?(\d+)\s+passed/);
  if (m) {
    failed = m[1] ? Number(m[1]) : 0;
    passed = m[2] ? Number(m[2]) : 0;
    return { passed, failed };
  }
  // Mocha
  m = text.match(/(\d+)\s+passing/);
  if (m) passed = Number(m[1]);
  m = text.match(/(\d+)\s+failing/);
  if (m) failed = Number(m[1]);
  if (passed || failed) return { passed, failed };

  // pytest
  m = text.match(/(\d+)\s+passed/);
  if (m) passed = Number(m[1]);
  m = text.match(/(\d+)\s+failed/);
  if (m) failed = Number(m[1]);
  if (passed || failed) return { passed, failed };

  return { passed, failed };
}

// Test commands run detached in their own process group so a timeout (or a
// SIGINT of the orchestrator) can kill the whole tree, grandchildren included.
const active = new Set();

function killGroup(proc, signal = 'SIGKILL') {
  if (!proc || proc.pid == null) return;
  try {
    if (process.platform === 'win32') proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch { try { proc.kill(signal); } catch { /* */ } }
}

function killActive(signal = 'SIGKILL') {
  let n = 0;
  for (const proc of active) { killGroup(proc, signal); n++; }
  return n;
}

// Resolves on the child's `exit` (or the timeout), not on stdio `close`: a
// descendant that left the process group (setsid) can hold the pipes open
// for as long as it lives.
function runCommand({ cmd, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '';
    let timedOut = false, spawnError = false, exitCode = null, durationMs = null, settled = false;
    let proc, hardTimer, drainTimer;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return resolve({ exitCode: null, stdout: '', stderr: err.message, durationMs: 0, timedOut: false, spawnError: true });
    }
    active.add(proc);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(proc);
      hardTimer = setTimeout(finish, EXIT_GRACE_MS);
    }, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      clearTimeout(drainTimer);
      active.delete(proc);
      proc.stdout.destroy();
      proc.stderr.destroy();
      resolve({ exitCode, stdout, stderr, durationMs: durationMs == null ? Date.now() - start : durationMs, timedOut, spawnError });
    }
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (err) => {
      spawnError = true;
      stderr += '\n' + err.message;
      finish();
    });
    proc.on('exit', (code) => {
      exitCode = code;
      durationMs = Date.now() - start;
      killGroup(proc); // stragglers left in the group
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    proc.on('close', finish);
  });
}

// The minimal changed region of `after` relative to `before`, as character
// offsets into `after` (empty for a pure deletion).
function changedSpan(before, after) {
  const max = Math.min(before.length, after.length);
  let pre = 0;
  while (pre < max && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  return { start: pre, end: after.length - suf };
}

function lineStarts(src) {
  const out = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

// 1-based line of `offset`, by binary search over lineStarts().
function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// Post-exit coverage work shares the test budget: past `deadline` it stops
// and the edit is reverted with reason `coverage_timeout`.
class CoverageTimeout extends Error {}
function checkDeadline(deadline) {
  if (Date.now() > deadline) throw new CoverageTimeout('coverage evaluation exceeded the test budget');
}
const tick = () => new Promise(resolve => setImmediate(resolve));

// coverage.py has to be importable by the interpreter that runs pytest, so it
// is looked up through pytest's shebang. Returns that python, or null.
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const pyCoverage = new Map();
function pytestPythonWithCoverage() {
  const key = process.env.PATH || '';
  if (!pyCoverage.has(key)) {
    let py = null;
    for (const dir of key.split(path.delimiter).filter(Boolean)) {
      let head;
      try { head = fs.readFileSync(path.join(dir, 'pytest'), 'utf8').slice(0, 256); } catch { continue; }
      const m = head.match(/^#!\s*(\S+)(?:[ \t]+(\S+))?/);
      if (m) py = path.basename(m[1]) === 'env' ? m[2] : m[1];
      break;
    }
    let ok = false;
    if (py) {
      try { ok = spawnSync(py, ['-m', 'coverage', '--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0; } catch { /* */ }
    }
    pyCoverage.set(key, ok ? py : null);
  }
  return pyCoverage.get(key);
}

// How execution of the edited file is observed: V8 coverage for plain JS,
// coverage.py around pytest; anything else has no tool.
function coverageTool(file, detected) {
  const ext = path.extname(file).toLowerCase();
  if (JS_EXT.has(ext)) return 'v8';
  if (ext === '.py' && detected.cmd === 'pytest' && pytestPythonWithCoverage()) return 'coverage.py';
  return null;
}

// Coverage evidence is grouped by the innermost function holding the changed
// code: the edit counts as exercised only when every group executed (a call of
// one edited function says nothing about another). `functions_missed` counts
// the groups that never ran.
function summarize(tool, edited, executed, { detail = null, groups = [] } = {}) {
  const missed = groups.filter(g => !g.hit).map(g => g.line);
  const out = {
    available: true, tool, exercised: groups.length > 0 && missed.length === 0,
    edited_lines: edited, executed_lines: executed, lines_pct: edited ? executed / edited : 0,
    functions: groups.length, functions_missed: missed.length
  };
  if (!out.exercised) {
    out.reason = 'edit_not_exercised';
    if (!detail) {
      detail = groups.length
        ? `changed code in ${missed.length} of ${groups.length} function(s) never executed (line ${missed.join(', ')})`
        : 'only comments or whitespace changed';
    }
  }
  if (detail) out.detail = detail;
  return out;
}

// Offsets of `src` inside comments (babel for JS, lexical fallback).
function commentMask(src, file) {
  const mask = new Uint8Array(src.length);
  const { ast } = require('../validation/ast-checker').parseJs(src, file);
  if (ast && Array.isArray(ast.comments)) {
    for (const c of ast.comments) mask.fill(1, c.start, c.end);
  } else {
    const kept = require('../validation/polyglot-ast').stripCode(src, 'javascript', { keepStrings: true });
    for (let i = 0; i < src.length; i++) if (kept[i] !== src[i]) mask[i] = 1;
  }
  return mask;
}

// Code characters of the changed span (comments and whitespace are not
// evidence); a pure deletion is judged at the first code character after it.
function codeProbes(src, span, isComment) {
  const isCode = (i) => !/\s/.test(src[i]) && !isComment[i];
  const probes = [];
  for (let i = span.start; i < span.end; i++) if (isCode(i)) probes.push(i);
  if (!probes.length && span.end <= span.start) {
    for (let i = span.start; i < src.length; i++) if (isCode(i)) { probes.push(i); break; }
  }
  return probes;
}

// For each offset of the ascending `offs`, the innermost range containing it
// (or null): ranges sorted by start (longer first, then by original order),
// swept once with a stack of the ranges still open. V8 ranges nest.
function innermost(ranges, offs) {
  const order = ranges.map((_, i) => i).sort((a, b) =>
    ranges[a].startOffset - ranges[b].startOffset || ranges[b].endOffset - ranges[a].endOffset || b - a);
  const out = new Array(offs.length);
  const open = [];
  let k = 0;
  for (let j = 0; j < offs.length; j++) {
    const off = offs[j];
    while (k < order.length && ranges[order[k]].startOffset <= off) {
      const r = ranges[order[k++]];
      while (open.length && open[open.length - 1].endOffset <= r.startOffset) open.pop();
      open.push(r);
    }
    while (open.length && open[open.length - 1].endOffset <= off) open.pop();
    out[j] = open.length ? open[open.length - 1] : null;
  }
  return out;
}

// A character counts as executed when, in some process, the innermost V8
// range containing it has a non-zero count; its group is the innermost V8
// function containing it. Only coverage files naming the edited file are
// parsed; the event loop gets a turn between files.
async function v8Exercised(covDir, absFile, src, span, deadline) {
  const urls = new Set([pathToFileURL(absFile).href]);
  try { urls.add(pathToFileURL(fs.realpathSync(absFile)).href); } catch { /* */ }
  const shift = src.charCodeAt(0) === 0xFEFF ? 1 : 0; // the CJS loader strips a BOM
  const probes = codeProbes(src, span, commentMask(src, absFile));
  const offs = probes.map(o => o - shift);
  checkDeadline(deadline);
  const hit = new Uint8Array(probes.length);
  let hits = 0;
  let groupOf = null;
  let loaded = false;
  let names = [];
  try { names = (await fs.promises.readdir(covDir)).filter(n => n.endsWith('.json')); } catch { /* */ }
  for (const name of names) {
    if (hits === probes.length && groupOf) break;
    await tick();
    checkDeadline(deadline);
    let data;
    try {
      const raw = await fs.promises.readFile(path.join(covDir, name), 'utf8');
      if (![...urls].some(u => raw.includes(u))) continue;
      checkDeadline(deadline);
      data = JSON.parse(raw);
    } catch (err) {
      if (err instanceof CoverageTimeout) throw err;
      continue;
    }
    for (const script of data.result || []) {
      if (!urls.has(script.url)) continue;
      loaded = true;
      const fns = (script.functions || []).filter(f => f.ranges && f.ranges.length);
      if (!groupOf) groupOf = innermost(fns.map(f => f.ranges[0]), offs).map(fn => fn ? `${fn.startOffset}:${fn.endOffset}` : 'script');
      const best = innermost(fns.flatMap(f => f.ranges), offs);
      for (let j = 0; j < probes.length; j++) {
        if (!hit[j] && best[j] && best[j].count > 0) { hit[j] = 1; hits++; }
      }
    }
  }
  const starts = lineStarts(src);
  const groups = new Map();
  const lines = new Set();
  const executed = new Set();
  probes.forEach((off, j) => {
    const line = lineAt(starts, off);
    lines.add(line);
    if (hit[j]) executed.add(line);
    const k = groupOf ? groupOf[j] : 'unloaded';
    const g = groups.get(k) || { line, hit: false };
    g.hit = g.hit || !!hit[j];
    groups.set(k, g);
  });
  return summarize('v8', lines.size, executed.size, { detail: loaded ? null : 'file never loaded by the tests', groups: [...groups.values()] });
}

// def/class/decorator lines run at import, so they say nothing about the
// edited body; a header-only edit is judged by the first statement after it.
// Only statements count (coverage.py's executed + missing lines: no comments,
// docstrings or continuation lines); each is grouped by its innermost def.
const PY_HEADER = /^\s*(?:@|(?:async\s+)?def\b|class\b)/;
function pyExercised(jsonPath, repoRoot, absFile, src, span, { noData = false } = {}) {
  let files = {};
  if (!noData) {
    try { files = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).files || {}; } catch { return summarize('coverage.py', 0, 0, { detail: 'no coverage data' }); }
  }
  const key = Object.keys(files).find(k => realOr(path.resolve(repoRoot, k)) === realOr(absFile));
  const executed = new Set(key ? files[key].executed_lines || [] : []);
  const statements = key ? new Set([...executed, ...(files[key].missing_lines || [])]) : null;
  const srcLines = src.split('\n');
  const isStmt = (n) => {
    if (PY_HEADER.test(srcLines[n - 1] || '')) return false;
    if (statements) return statements.has(n);
    const t = (srcLines[n - 1] || '').trim();
    return !!t && !t.startsWith('#');
  };
  const lineStart = lineStarts(src);
  const first = lineAt(lineStart, span.start);
  const last = span.end > span.start ? lineAt(lineStart, span.end - 1) : first;
  let lines = [];
  for (let n = first; n <= last; n++) if (isStmt(n)) lines.push(n);
  if (!lines.length) {
    for (let n = last + 1; n <= srcLines.length; n++) if (isStmt(n)) { lines = [n]; break; }
  }
  const defs = require('../validation/polyglot-ast').parsePython(src).functions;
  const groups = new Map();
  for (const n of lines) {
    const off = lineStart[n - 1] + (srcLines[n - 1].length - srcLines[n - 1].trimStart().length);
    let fn = null;
    for (const f of defs) if (f.start <= off && off < f.end && (!fn || f.end - f.start < fn.end - fn.start)) fn = f;
    const k = fn ? fn.start : 'module';
    const g = groups.get(k) || { line: n, hit: false };
    g.hit = g.hit || executed.has(n);
    groups.set(k, g);
  }
  return summarize('coverage.py', lines.length, lines.filter(n => executed.has(n)).length, { detail: key ? null : 'file never imported by the tests', groups: [...groups.values()] });
}

// `edit` ({ file, start, end }: the changed span of the edited file) turns on
// execution evidence: result.coverage says whether any test ran the edit.
async function runTests({ repoRoot, command, timeoutMs = TIMEOUT_MS, edit = null } = {}) {
  const detected = command || detectCommand(repoRoot);
  if (!detected) {
    return {
      status: 'no_test_runner',
      framework: null,
      passed_tests: 0,
      failed_tests: 0,
      coverage_delta: null,
      execution_time_ms: 0,
      stdout: '',
      stderr: '',
      reverted: false,
      command: null
    };
  }

  const tool = edit ? coverageTool(edit.file, detected) : null;
  const covDir = tool ? fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-cov-')) : null;
  // A fresh bytecode cache per run: a same-size rewrite within the same second
  // (an edit, a mutant) must not be served a stale .pyc.
  const pycDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-pyc-'));
  const env = { ...process.env, CI: '1', PYTHONPYCACHEPREFIX: pycDir };
  // Coverage is collected only when it is evaluated (an inherited
  // NODE_V8_COVERAGE would make every run, mutant runs included, pay for it;
  // spawn re-adds it unless the key is present, so it is emptied).
  env.NODE_V8_COVERAGE = '';
  delete env.COVERAGE_PROCESS_START;
  let cmd = detected.cmd, args = detected.args;
  if (tool === 'v8') env.NODE_V8_COVERAGE = covDir;
  if (tool === 'coverage.py') {
    env.COVERAGE_FILE = path.join(covDir, 'data');
    cmd = pytestPythonWithCoverage();
    args = ['-m', 'coverage', 'run', '-m', 'pytest', ...detected.args];
  }

  let result, coverage = edit ? { available: false, reason: 'no_coverage_tool' } : undefined;
  const deadline = Date.now() + timeoutMs;
  let tCov = null;
  try {
    result = await runCommand({ cmd, args, cwd: repoRoot, env, timeoutMs });
    if (tool && !result.timedOut && !result.spawnError) {
      tCov = Date.now();
      checkDeadline(deadline);
      const absFile = path.resolve(repoRoot, edit.file);
      const src = fs.readFileSync(absFile, 'utf8');
      if (tool === 'v8') {
        coverage = await v8Exercised(covDir, absFile, src, edit, deadline);
      } else {
        // Report the edited file only, in what is left of the test budget.
        const jsonPath = path.join(covDir, 'coverage.json');
        const include = [...new Set([absFile, realOr(absFile)])].join(',');
        const r = await runCommand({ cmd, args: ['-m', 'coverage', 'json', '-q', '-o', jsonPath, '--include', include], cwd: repoRoot, env, timeoutMs: Math.max(1, deadline - Date.now()) });
        if (r.timedOut) throw new CoverageTimeout('coverage json exceeded the test budget');
        coverage = pyExercised(jsonPath, repoRoot, absFile, src, edit, { noData: r.exitCode !== 0 && /No data to report/.test(r.stdout + r.stderr) });
      }
    }
  } catch (err) {
    coverage = err instanceof CoverageTimeout
      ? { available: true, tool, exercised: false, reason: 'coverage_timeout', detail: `${err.message} (${timeoutMs} ms)` }
      : { available: true, tool, exercised: false, reason: 'edit_not_exercised', detail: `coverage unreadable: ${err.message}` };
  } finally {
    if (covDir) fs.rmSync(covDir, { recursive: true, force: true });
    fs.rmSync(pycDir, { recursive: true, force: true });
  }

  let status;
  if (result.timedOut) status = 'timeout';
  else if (result.spawnError) status = 'environment_error';
  else if (result.exitCode === 0) status = 'passed';
  else status = 'failed';

  const counts = parseCounts(result.stdout + '\n' + result.stderr, detected.framework);
  const out = {
    status,
    framework: detected.framework,
    command: `${cmd} ${args.join(' ')}`,
    exit_code: result.exitCode,
    passed_tests: counts.passed,
    failed_tests: counts.failed,
    coverage_delta: null,
    execution_time_ms: result.durationMs,
    stdout: truncate(result.stdout, 4000),
    stderr: truncate(result.stderr, 4000),
    timed_out: result.timedOut
  };
  if (coverage) {
    if (tCov != null) coverage.duration_ms = Date.now() - tCov;
    out.coverage = coverage;
  }
  return out;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
}

module.exports = { runTests, runCommand, killActive, detectCommand, parseCounts, changedSpan, coverageTool, TIMEOUT_MS };
