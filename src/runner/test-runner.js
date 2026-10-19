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

function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

// coverage.py has to be importable by the interpreter that runs pytest, so it
// is looked up through pytest's shebang. Returns that python, or null.
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

function smallest(ranges, off) {
  let best = null;
  for (const r of ranges) {
    if (r.startOffset <= off && off < r.endOffset &&
        (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset)) best = r;
  }
  return best;
}

// A character counts as executed when, in some process, the innermost V8
// range containing it has a non-zero count; its group is the innermost V8
// function containing it.
function v8Exercised(covDir, absFile, src, span) {
  const urls = new Set([pathToFileURL(absFile).href]);
  try { urls.add(pathToFileURL(fs.realpathSync(absFile)).href); } catch { /* */ }
  const shift = src.charCodeAt(0) === 0xFEFF ? 1 : 0; // the CJS loader strips a BOM
  const probes = codeProbes(src, span, commentMask(src, absFile));
  const hit = new Set();
  const groupOf = new Map();
  let loaded = false;
  let names = [];
  try { names = fs.readdirSync(covDir).filter(n => n.endsWith('.json')); } catch { /* */ }
  for (const name of names) {
    let data;
    try {
      const raw = fs.readFileSync(path.join(covDir, name), 'utf8');
      if (![...urls].some(u => raw.includes(u))) continue;
      data = JSON.parse(raw);
    } catch { continue; }
    for (const script of data.result || []) {
      if (!urls.has(script.url)) continue;
      loaded = true;
      const fns = (script.functions || []).filter(f => f.ranges && f.ranges.length);
      const ranges = fns.flatMap(f => f.ranges);
      const extents = fns.map(f => f.ranges[0]);
      for (const off of probes) {
        if (!groupOf.has(off)) {
          const fn = smallest(extents, off - shift);
          groupOf.set(off, fn ? `${fn.startOffset}:${fn.endOffset}` : 'script');
        }
        if (hit.has(off)) continue;
        const best = smallest(ranges, off - shift);
        if (best && best.count > 0) hit.add(off);
      }
    }
  }
  const groups = new Map();
  for (const off of probes) {
    const k = groupOf.get(off) || 'unloaded';
    const g = groups.get(k) || { line: lineOf(src, off), hit: false };
    g.hit = g.hit || hit.has(off);
    groups.set(k, g);
  }
  const lines = new Set(probes.map(o => lineOf(src, o)));
  const executed = new Set([...hit].map(o => lineOf(src, o)));
  return summarize('v8', lines.size, executed.size, { detail: loaded ? null : 'file never loaded by the tests', groups: [...groups.values()] });
}

// def/class/decorator lines run at import, so they say nothing about the
// edited body; a header-only edit is judged by the first statement after it.
// Only statements count (coverage.py's executed + missing lines: no comments,
// docstrings or continuation lines); each is grouped by its innermost def.
const PY_HEADER = /^\s*(?:@|(?:async\s+)?def\b|class\b)/;
function pyExercised(jsonPath, repoRoot, absFile, src, span) {
  let files;
  try { files = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).files || {}; } catch { return summarize('coverage.py', 0, 0, { detail: 'no coverage data' }); }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const key = Object.keys(files).find(k => real(path.resolve(repoRoot, k)) === real(absFile));
  const executed = new Set(key ? files[key].executed_lines || [] : []);
  const statements = key ? new Set([...executed, ...(files[key].missing_lines || [])]) : null;
  const srcLines = src.split('\n');
  const isStmt = (n) => {
    if (PY_HEADER.test(srcLines[n - 1] || '')) return false;
    if (statements) return statements.has(n);
    const t = (srcLines[n - 1] || '').trim();
    return !!t && !t.startsWith('#');
  };
  const first = lineOf(src, span.start);
  const last = span.end > span.start ? lineOf(src, span.end - 1) : first;
  let lines = [];
  for (let n = first; n <= last; n++) if (isStmt(n)) lines.push(n);
  if (!lines.length) {
    for (let n = last + 1; n <= srcLines.length; n++) if (isStmt(n)) { lines = [n]; break; }
  }
  const lineStart = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStart.push(i + 1);
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
  let cmd = detected.cmd, args = detected.args;
  if (tool === 'v8') env.NODE_V8_COVERAGE = covDir;
  if (tool === 'coverage.py') {
    env.COVERAGE_FILE = path.join(covDir, 'data');
    cmd = pytestPythonWithCoverage();
    args = ['-m', 'coverage', 'run', '-m', 'pytest', ...detected.args];
  }

  let result, coverage = edit ? { available: false, reason: 'no_coverage_tool' } : undefined;
  try {
    result = await runCommand({ cmd, args, cwd: repoRoot, env, timeoutMs });
    if (tool && !result.timedOut && !result.spawnError) {
      const absFile = path.resolve(repoRoot, edit.file);
      const src = fs.readFileSync(absFile, 'utf8');
      if (tool === 'v8') {
        coverage = v8Exercised(covDir, absFile, src, edit);
      } else {
        const jsonPath = path.join(covDir, 'coverage.json');
        spawnSync(cmd, ['-m', 'coverage', 'json', '-q', '-o', jsonPath], { cwd: repoRoot, env, stdio: 'ignore', timeout: 30_000 });
        coverage = pyExercised(jsonPath, repoRoot, absFile, src, edit);
      }
    }
  } catch (err) {
    coverage = { available: true, tool, exercised: false, reason: 'edit_not_exercised', detail: `coverage unreadable: ${err.message}` };
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
  if (coverage) out.coverage = coverage;
  return out;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
}

module.exports = { runTests, runCommand, killActive, detectCommand, parseCounts, changedSpan, coverageTool, TIMEOUT_MS };
