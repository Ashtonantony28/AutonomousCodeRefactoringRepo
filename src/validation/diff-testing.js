'use strict';

// Differential testing oracle. Given a refactoring proposal that touches a
// pure(-ish) function, sandbox both the current and proposed source in two
// isolated vm contexts, then run fast-check property-based input generation
// against both. If the output for some input differs (or one throws while
// the other doesn't), the refactor is not semantics-preserving.
//
// Returns a result {applicable, runs, mismatches, sample, score} where:
//   - applicable: false if we couldn't locate a callable function or build
//     a sandbox (e.g. file is React JSX, has top-level await, etc.)
//   - score: in [0,1]; mismatches/runs subtracted from 1 (capped at 0)
//
// Designed to be FAST and SAFE — small input space, short timeouts. The
// idea (Le et al. PLDI'14 + Mokav 2024) is to use generated equivalence
// modulo inputs as a high-value pattern check.

const vm = require('vm');

let fc;
try { fc = require('fast-check'); } catch { fc = null; }

const RUN_TIMEOUT_MS = 1500;
const MAX_RUNS = 25;

function buildSandbox(src) {
  const sandbox = { module: { exports: {} }, exports: {}, console: { log: () => {}, warn: () => {}, error: () => {} }, require: stubRequire };
  sandbox.exports = sandbox.module.exports;
  const ctx = vm.createContext(sandbox, { name: 'diff-test' });
  try {
    const script = new vm.Script(src, { filename: 'sandbox.js' });
    script.runInContext(ctx, { timeout: RUN_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, ctx, sandbox };
}

function stubRequire(name) {
  // Allow a tiny allowlist of stdlib modules; everything else returns a
  // proxy that records access but never crashes.
  if (name === 'util') return require('util');
  if (name === 'path') return require('path');
  if (name === 'url') return require('url');
  return new Proxy(function () {}, {
    get: () => stubRequire('_'),
    apply: () => undefined
  });
}

function findExport(sandbox, name) {
  if (sandbox.module && sandbox.module.exports && typeof sandbox.module.exports[name] === 'function') {
    return sandbox.module.exports[name];
  }
  if (sandbox.exports && typeof sandbox.exports[name] === 'function') return sandbox.exports[name];
  // Some sources do `function foo(){}` without exporting — check the
  // sandbox global directly.
  if (typeof sandbox[name] === 'function') return sandbox[name];
  return null;
}

function detectFunctionName(src) {
  // Patterns tried in order:
  //   function NAME(...) {}
  //   const|let|var NAME = ...
  //   module.exports.NAME = ...
  //   module.exports = function NAME(...)
  //   exports.NAME = ...
  //   exports.NAME = function NAME(...)
  const patterns = [
    /\bfunction\s+([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:function\s*\(|\(|[A-Za-z_$])/m,
    /\bmodule\.exports\.([A-Za-z_]\w*)\s*=/,
    /\bexports\.([A-Za-z_]\w*)\s*=/
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
}

function detectArity(src, name) {
  // Try a few common shapes — function decl, `NAME = function(args)`,
  // `NAME = (args) =>`, `module.exports.NAME = function(args)`.
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(([^)]*)\\)`),
    new RegExp(`\\b${escapedName}\\s*=\\s*(?:async\\s*)?function\\s*[A-Za-z_]*\\s*\\(([^)]*)\\)`),
    new RegExp(`\\b${escapedName}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`),
    new RegExp(`\\bmodule\\.exports\\.${escapedName}\\s*=\\s*(?:async\\s*)?function\\s*[A-Za-z_]*\\s*\\(([^)]*)\\)`)
  ];
  for (const re of candidates) {
    const m = src.match(re);
    if (m) {
      const params = m[1].split(',').map(s => s.trim()).filter(Boolean);
      return Math.min(Math.max(params.length, 1), 4);
    }
  }
  return 1;
}

function buildArbitrary(arity) {
  if (!fc) return null;
  // Mix integers, small strings, small arrays — keeps the search space
  // tight but representative.
  const base = fc.oneof(
    fc.integer({ min: -50, max: 50 }),
    fc.float({ noNaN: true, min: -100, max: 100 }),
    fc.string({ maxLength: 6 }),
    fc.boolean(),
    fc.constantFrom(null, undefined, 0, ''),
    fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 4 })
  );
  const tuple = Array(arity).fill(0).map(() => base);
  return fc.tuple(...tuple);
}

function safeRun(fn, args) {
  try {
    const out = fn(...args);
    if (out && typeof out.then === 'function') return { kind: 'async' };
    return { kind: 'value', value: out };
  } catch (err) {
    return { kind: 'throw', error: err && err.message };
  }
}

function equivalent(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'throw') return true; // both threw; we count it as equivalent
  if (a.kind === 'async') return true; // skip async — can't compare cheaply
  return deepEq(a.value, b.value);
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) < 1e-9;
  }
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEq(x, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEq(a[k], b[k]));
}

function run({ currentSrc, proposedSrc, functionName, arity, runs = MAX_RUNS }) {
  if (!fc) return { applicable: false, reason: 'fast-check not installed', score: 0.5, runs: 0, mismatches: 0 };

  const name = functionName || detectFunctionName(proposedSrc) || detectFunctionName(currentSrc);
  if (!name) return { applicable: false, reason: 'no top-level function name detected', score: 0.5, runs: 0, mismatches: 0 };

  const sbA = buildSandbox(currentSrc);
  const sbB = buildSandbox(proposedSrc);
  if (!sbA.ok) return { applicable: false, reason: `current sandbox failed: ${sbA.error}`, score: 0.5, runs: 0, mismatches: 0 };
  if (!sbB.ok) return { applicable: false, reason: `proposed sandbox failed: ${sbB.error}`, score: 0, runs: 0, mismatches: 1 };

  const fnA = findExport(sbA.sandbox, name);
  const fnB = findExport(sbB.sandbox, name);
  if (!fnA || !fnB) return { applicable: false, reason: `function "${name}" not callable from sandbox`, score: 0.5, runs: 0, mismatches: 0 };

  const k = arity || detectArity(proposedSrc, name) || 1;
  const arb = buildArbitrary(k);
  if (!arb) return { applicable: false, reason: 'fast-check arbitrary not built', score: 0.5, runs: 0, mismatches: 0 };

  let mismatches = 0;
  let counterexample = null;
  let ran = 0;

  try {
    fc.assert(
      fc.property(arb, (args) => {
        ran++;
        const a = safeRun(fnA, args);
        const b = safeRun(fnB, args);
        if (!equivalent(a, b)) {
          mismatches++;
          if (!counterexample) counterexample = { args, current: a, proposed: b };
          return false;
        }
        return true;
      }),
      { numRuns: runs, endOnFailure: false }
    );
  } catch (err) {
    // fast-check throws on assertion failure; we already captured the
    // counterexample above, so swallow this and continue.
  }

  const score = ran > 0 ? Math.max(0, 1 - (mismatches / ran) * 2) : 0.5;
  return {
    applicable: true,
    function_name: name,
    arity: k,
    runs: ran,
    mismatches,
    score,
    counterexample
  };
}

module.exports = { run, detectFunctionName, detectArity, equivalent };
