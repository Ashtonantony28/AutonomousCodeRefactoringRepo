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
// Temp dirs of the runs in flight, removed by removeLiveDirs on a signal
// (process.exit skips runTests' finally).
const liveDirs = new Set();

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

function removeLiveDirs() {
  for (const dir of liveDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  liveDirs.clear();
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

// pytest runs as `<python> -m pytest` with the interpreter behind the
// `pytest` script on PATH (its shebang): `-m` puts the repo root on sys.path,
// so every run (edit, mutant, control) imports the code the same way.
// coverage.py has to be importable by that interpreter. -> { py, coverage }
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const pyCoverage = new Map();
function pytestInterpreter() {
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
    const ok = (args) => { try { return spawnSync(py, args, { stdio: 'ignore', timeout: 10_000 }).status === 0; } catch { return false; } };
    const usable = !!py && ok(['-c', 'import pytest']);
    pyCoverage.set(key, { py: usable ? py : null, coverage: usable && ok(['-m', 'coverage', '--version']) });
  }
  return pyCoverage.get(key);
}
function pytestPythonWithCoverage() {
  const it = pytestInterpreter();
  return it.coverage ? it.py : null;
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

// Per-test results: node:test TAP (a second reporter, to a temp file, set
// through NODE_OPTIONS unless the suite picks its own reporters) or pytest
// JUnit XML (`--tb=short`, so a frame run by a module body reads
// `in <module>`). -> { tests: { id: 'pass' | 'fail' | 'skip' | 'error' },
// load } or null. `load`: a module failed to load (a test file process
// crashed, a failure raised from a module body, a pytest collection error).
// Only 'fail' is an assertion or exception inside a test.
const LOAD_FRAME = /\bModule\._compile\b|\bModuleJob\.run\b/;
// tests[id] = state; a repeated id gets the next free `#n` (per-id counter).
function adder(tests) {
  const next = new Map();
  return (id, state) => {
    let k = id, n = next.get(id) || 2;
    while (k in tests) k = `${id}#${n++}`;
    next.set(id, n);
    tests[k] = state;
  };
}
function tapResults(text) {
  const tests = {}, names = [], add = adder(tests);
  let load = false, cur = null, yaml = null;
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (yaml !== null) {
      if (line.trim() === '...' && indent === yaml) {
        if (cur.type !== 'suite') add(cur.id, cur.state === 'fail' && cur.failureType !== 'testCodeFailure' ? 'error' : cur.state);
        yaml = null;
      } else {
        const kv = line.trim().match(/^(\w+):\s*'?([\w-]*)/);
        if (kv && indent === yaml) cur[kv[1]] = kv[2];
        if (cur.state === 'fail' && ((kv && kv[1] === 'exitCode' && indent === yaml) || LOAD_FRAME.test(line))) load = true;
      }
      continue;
    }
    const sub = line.match(/^\s*# Subtest: (.*)$/);
    if (sub) { names.length = indent >> 2; names.push(sub[1]); continue; }
    const m = line.match(/^\s*(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (m) {
      names.length = indent >> 2;
      cur = { id: [...names, m[2]].join(' > '), state: m[3] ? 'skip' : m[1] ? 'fail' : 'pass' };
      yaml = indent + 2;
    }
  }
  return Object.keys(tests).length ? { tests, load } : null;
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
function junitResults(xml) {
  const tests = {}, add = adder(tests);
  let load = false;
  const attr = (a, k) => { const m = a.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? unxml(m[1]) : ''; };
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] || '';
    let state = 'pass';
    if (/<(?:failure|error)\b/.test(body)) {
      state = /<failure\b/.test(body) ? 'fail' : 'error';
      if (/<error\b[^>]*message="collection failure/.test(body) || /:\d+: in <module>$/m.test(unxml(body))) load = true;
    } else if (/<skipped\b/.test(body)) state = 'skip';
    add(`${attr(m[1], 'classname')}::${attr(m[1], 'name')}`, state);
  }
  return Object.keys(tests).length ? { tests, load } : null;
}

// Reporters the suite picks itself cannot be extended (node needs as many
// destinations as reporters): no per-test results then. A suite that picks
// them out of sight (a delegated script, .npmrc) makes node refuse to start
// with ours added: that run is repeated without them, and so is every later
// run in that repo.
const reporterConflicts = new Set();
const reporterConflict = (r) => r.exitCode !== 0 && /ERR_INVALID_ARG_VALUE[\s\S]*--test-reporter|--test-reporter[\s\S]*ERR_INVALID_ARG_VALUE/.test(r.stderr);

// Load hooks: a module body that throws is logged (to REFACTOR_LOAD_LOG,
// `T <key> <file>`), however deep the throw or however the test reports it,
// and `P <key>` marks a key that passed: a throw caught on purpose
// (`assert.throws(() => require(...))`, `pytest.raises` around an import) is
// no load failure. JS: a preloaded wrapper of Module._compile, key = the
// process, passed when a node:test file process exits 0. pytest: a plugin
// wrapping __import__ (an ImportError is a missing optional module, not a
// load failure), key = the test or collected module, passed when every phase
// passed; a throw outside both never passes.
const JS_LOAD_HOOK = `const M = require('module'), fs = require('fs'), c = M.prototype._compile;
const key = process.pid + '.' + process.hrtime.bigint(), log = (s) => { try { fs.appendFileSync(process.env.REFACTOR_LOAD_LOG, s + '\\n'); } catch {} };
let seen = false;
M.prototype._compile = function (...a) {
  try { return c.apply(this, a); } catch (e) {
    log('T\\t' + key + '\\t' + this.filename);
    if (!seen && process.env.NODE_TEST_CONTEXT) process.on('exit', (code) => { if (code === 0) log('P\\t' + key); });
    seen = true;
    throw e;
  }
};
`;
const PY_LOAD_HOOK = `import builtins, os
_imp = builtins.__import__
_key, _n, _bad = '', 0, False
def _log(s):
    with open(os.environ['REFACTOR_LOAD_LOG'], 'a') as f:
        f.write(s + '\\n')
def _hook(name, *a, **k):
    try:
        return _imp(name, *a, **k)
    except ImportError:
        raise
    except Exception:
        _log('T\\t%s\\t%s.py' % (_key, name.replace('.', '/')))
        raise
builtins.__import__ = _hook
def _start(what):
    global _key, _n, _bad
    _n += 1
    _key, _bad = '%d:%s' % (_n, what), False
def _finish(ok):
    global _key
    if ok and _key:
        _log('P\\t' + _key)
    _key = ''
def pytest_collectstart(collector):
    _start(collector.nodeid)
def pytest_collectreport(report):
    _finish(report.passed)
def pytest_runtest_logstart(nodeid, location):
    _start(nodeid)
def pytest_runtest_logreport(report):
    global _bad
    _bad = _bad or report.failed
def pytest_runtest_logfinish(nodeid, location):
    _finish(not _bad)
`;
// Logged load failures, not caught under a key that passed, of modules other
// than tests and conftest.
function loadFailed(log, repoRoot) {
  let text;
  try { text = fs.readFileSync(log, 'utf8'); } catch { return false; }
  const { isTestFile } = require('../utils/file-discovery');
  const rows = text.split('\n').map(l => l.split('\t'));
  const passed = new Set(rows.filter(r => r[0] === 'P').map(r => r[1]));
  return rows.some(([k, key, f]) => k === 'T' && !passed.has(key) && f && !isTestFile(path.isAbsolute(f) ? path.relative(repoRoot, f) : f) && !/(?:^|\/)conftest\.py$/.test(f));
}

function ownsReporters(repoRoot, env) {
  if (reporterConflicts.has(repoRoot)) return true;
  if (/--test-reporter/.test(env.NODE_OPTIONS || '')) return true;
  try { return /--test-reporter/.test(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts.test); } catch { return false; }
}

// `edit` ({ file, start, end }: the changed span of the edited file) turns on
// execution evidence: result.coverage says whether any test ran the edit.
// result.tests holds the per-test results when the framework reports them
// (tapResults / junitResults); collection_error is set when a module failed
// to load or collect, so no test judged the code.
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
  for (const d of [covDir, pycDir]) if (d) liveDirs.add(d);
  const env = { ...process.env, CI: '1', PYTHONPYCACHEPREFIX: pycDir };
  // Coverage is collected only when it is evaluated (an inherited
  // NODE_V8_COVERAGE would make every run, mutant runs included, pay for it;
  // spawn re-adds it unless the key is present, so it is emptied).
  env.NODE_V8_COVERAGE = '';
  delete env.COVERAGE_PROCESS_START;
  let cmd = detected.cmd, args = detected.args;
  const py = detected.cmd === 'pytest' ? pytestInterpreter().py : null;
  if (py) { cmd = py; args = ['-m', 'pytest', ...detected.args]; }
  if (tool === 'v8') env.NODE_V8_COVERAGE = covDir;
  if (tool === 'coverage.py') {
    env.COVERAGE_FILE = path.join(covDir, 'data');
    args = ['-m', 'coverage', 'run', ...args];
  }
  const pytest = detected.framework === 'pytest';
  const report = path.join(pycDir, pytest ? 'junit.xml' : 'tests.tap');
  const reportArgs = pytest ? [`--junitxml=${report}`, '--tb=short'] : [];
  env.REFACTOR_LOAD_LOG = path.join(pycDir, 'load.log');
  if (pytest) {
    fs.writeFileSync(path.join(pycDir, 'refactor_load_hook.py'), PY_LOAD_HOOK);
    env.PYTHONPATH = [env.PYTHONPATH, pycDir].filter(Boolean).join(path.delimiter);
    reportArgs.push('-p', 'refactor_load_hook');
  } else {
    fs.writeFileSync(path.join(pycDir, 'load-hook.js'), JS_LOAD_HOOK);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} "--require=${path.join(pycDir, 'load-hook.js')}"`.trim();
  }
  const baseOptions = env.NODE_OPTIONS;
  const reporters = !pytest && !ownsReporters(repoRoot, env);
  if (reporters) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --test-reporter=tap --test-reporter-destination=stdout --test-reporter=tap "--test-reporter-destination=${report}"`.trim();
  }

  let result, perTest = null, loaded = true, coverage = edit ? { available: false, reason: 'no_coverage_tool' } : undefined;
  const deadline = Date.now() + timeoutMs;
  let tCov = null;
  try {
    result = await runCommand({ cmd, args: [...args, ...reportArgs], cwd: repoRoot, env, timeoutMs });
    if (reporters && !result.timedOut && reporterConflict(result)) {
      reporterConflicts.add(repoRoot);
      if (baseOptions === undefined) delete env.NODE_OPTIONS; else env.NODE_OPTIONS = baseOptions;
      if (covDir) { fs.rmSync(covDir, { recursive: true, force: true }); fs.mkdirSync(covDir); }
      result = await runCommand({ cmd, args: [...args, ...reportArgs], cwd: repoRoot, env, timeoutMs: Math.max(1, deadline - Date.now()) });
    }
    try {
      const text = fs.readFileSync(report, 'utf8');
      perTest = pytest ? junitResults(text) : tapResults(text);
    } catch { /* no per-test report */ }
    loaded = !loadFailed(env.REFACTOR_LOAD_LOG, repoRoot);
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
    for (const d of [covDir, pycDir]) if (d) { fs.rmSync(d, { recursive: true, force: true }); liveDirs.delete(d); }
  }

  let status;
  if (result.timedOut) status = 'timeout';
  else if (result.spawnError) status = 'environment_error';
  else if (result.exitCode === 0) status = 'passed';
  else status = 'failed';

  const counts = parseCounts(result.stdout + '\n' + result.stderr, detected.framework);
  // pytest exits 1 when tests failed; 2-5 when collection or an import broke,
  // it was interrupted, misused, or collected nothing: no test judged the code.
  const collectionError = status === 'failed' && ((pytest && result.exitCode >= 2 && result.exitCode <= 5) || !!(perTest && perTest.load) || !loaded);
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
  if (perTest) out.tests = perTest.tests;
  if (collectionError) out.collection_error = true;
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

module.exports = { runTests, runCommand, killActive, removeLiveDirs, detectCommand, parseCounts, changedSpan, coverageTool, tapResults, junitResults, TIMEOUT_MS };
