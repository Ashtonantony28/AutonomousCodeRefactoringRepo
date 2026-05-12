'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TIMEOUT_MS = 60_000;
const COVERAGE_DIR = '.refactor-coverage';

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

function runCommand({ cmd, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '';
    let timedOut = false;
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd,
        env,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      return resolve({ exitCode: null, stdout: '', stderr: err.message, durationMs: 0, timedOut: false, spawnError: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* */ }
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + '\n' + err.message, durationMs: Date.now() - start, timedOut, spawnError: true });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - start, timedOut, spawnError: false });
    });
  });
}

// Coverage of the changed file is opportunistic: we look for c8 / nyc /
// jest --coverage / pytest-cov in package.json or installed CLIs, and
// re-run with coverage enabled when a runner is available. If we can't,
// we return { available: false } and the orchestrator skips this signal.
async function measureCoverage({ repoRoot, file, command, timeoutMs = TIMEOUT_MS } = {}) {
  const detected = command || detectCommand(repoRoot);
  if (!detected) return { available: false, reason: 'no test runner' };

  // Prefer c8 when it's resolvable in the target repo; it overlays nicely
  // on `npm test` without changing the test script.
  const c8Bin = path.join(repoRoot, 'node_modules', '.bin', 'c8');
  if (fs.existsSync(c8Bin) && detected.framework === 'npm') {
    const result = await runCommand({
      cmd: c8Bin,
      args: ['--reporter=json-summary', '--reports-dir', COVERAGE_DIR, '--include', file, 'npm', 'test', '--silent'],
      cwd: repoRoot,
      env: { ...process.env, CI: '1' },
      timeoutMs
    });
    const summary = readCoverageSummary(repoRoot, file);
    return { available: true, ...summary, exit_code: result.exitCode, framework: 'c8' };
  }
  return { available: false, reason: 'no c8 in target node_modules' };
}

function readCoverageSummary(repoRoot, file) {
  const p = path.join(repoRoot, COVERAGE_DIR, 'coverage-summary.json');
  if (!fs.existsSync(p)) return { lines_pct: null, branches_pct: null };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const fileKey = Object.keys(j).find(k => k.endsWith(file)) || 'total';
    const e = j[fileKey] || j.total || {};
    return {
      lines_pct: e.lines && typeof e.lines.pct === 'number' ? e.lines.pct / 100 : null,
      branches_pct: e.branches && typeof e.branches.pct === 'number' ? e.branches.pct / 100 : null,
      functions_pct: e.functions && typeof e.functions.pct === 'number' ? e.functions.pct / 100 : null
    };
  } catch {
    return { lines_pct: null };
  }
}

async function runTests({ repoRoot, command, timeoutMs = TIMEOUT_MS } = {}) {
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

  const result = await runCommand({
    cmd: detected.cmd,
    args: detected.args,
    cwd: repoRoot,
    env: { ...process.env, CI: '1' },
    timeoutMs
  });

  let status;
  if (result.timedOut) status = 'timeout';
  else if (result.spawnError) status = 'environment_error';
  else if (result.exitCode === 0) status = 'passed';
  else status = 'failed';

  const counts = parseCounts(result.stdout + '\n' + result.stderr, detected.framework);
  return {
    status,
    framework: detected.framework,
    command: `${detected.cmd} ${detected.args.join(' ')}`,
    exit_code: result.exitCode,
    passed_tests: counts.passed,
    failed_tests: counts.failed,
    coverage_delta: null,
    execution_time_ms: result.durationMs,
    stdout: truncate(result.stdout, 4000),
    stderr: truncate(result.stderr, 4000),
    timed_out: result.timedOut
  };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\n...[truncated]' : s;
}

module.exports = { runTests, detectCommand, parseCounts, measureCoverage, readCoverageSummary };
