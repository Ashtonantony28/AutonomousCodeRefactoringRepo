'use strict';

// Worker side of differential testing. Each side is loaded into its own vm
// context whose global is a null-prototype object, so no host-realm object
// (process, require, host Function) is reachable from evaluated code. Every
// call into a context goes through a timed Script with microtaskMode
// 'afterEvaluate', so loops and promise chains are bounded by the per-call
// timeout. Values never cross into the host realm: the context serialises
// results to a JSON string, which the worker parses into plain host data.

const vm = require('vm');
const { workerData } = require('worker_threads');

const PRELUDE = `(function () {
  'use strict';
  var G = globalThis;
  var stringify = JSON.stringify, keys = Object.keys, isArray = Array.isArray;
  var getProto = Object.getPrototypeOf, create = Object.create, freeze = Object.freeze;
  var objIs = Object.is, toStr = String, defineProperty = Object.defineProperty;
  var MapC = Map, SetC = Set, DateC = Date, RegExpC = RegExp, ErrorC = Error, WeakSetC = WeakSet;
  var ReferenceErrorC = ReferenceError;
  var lookup = null, mod = null, rec = null, curArgs = null;
  var targetFn = null, targetSelf, targetIsMethod = false;

  function ctorName(v) {
    try { var c = v.constructor; return c && typeof c.name === 'string' ? c.name : 'Object'; } catch (e) { return '?'; }
  }
  function ser(v, seen, depth) {
    var t = typeof v;
    if (v === undefined) return { t: 'u' };
    if (v === null) return null;
    if (t === 'number') return (v === v && v !== Infinity && v !== -Infinity) ? (objIs(v, -0) ? 0 : v) : { t: 'n', v: toStr(v) };
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'bigint') return { t: 'big', v: toStr(v) };
    if (t === 'symbol') return { t: 'sym', v: toStr(v.description) };
    if (t === 'function') return { t: 'fn', name: toStr(v.name), len: v.length };
    if (depth > 8) return { t: 'deep' };
    if (seen.has(v)) return { t: 'cycle' };
    seen.add(v);
    var out, i, k, n = 0;
    if (isArray(v)) {
      out = [];
      for (i = 0; i < v.length && i < 200; i++) out[i] = ser(v[i], seen, depth + 1);
      return { t: 'arr', len: v.length, v: out };
    }
    if (v instanceof DateC) return { t: 'date', v: toStr(v.getTime()) };
    if (v instanceof RegExpC) return { t: 're', v: toStr(v) };
    if (v instanceof MapC) {
      out = [];
      v.forEach(function (val, key) { if (n++ < 200) out[out.length] = [ser(key, seen, depth + 1), ser(val, seen, depth + 1)]; });
      return { t: 'map', v: out };
    }
    if (v instanceof SetC) {
      out = [];
      v.forEach(function (val) { if (n++ < 200) out[out.length] = ser(val, seen, depth + 1); });
      return { t: 'set', v: out };
    }
    if (v instanceof ErrorC) return { t: 'err', name: ctorName(v), message: toStr(v.message) };
    var ks = keys(v).sort();
    out = {};
    for (i = 0; i < ks.length && i < 200; i++) { k = ks[i]; out[k] = ser(v[k], seen, depth + 1); }
    return { t: 'obj', c: ctorName(v), v: out };
  }
  function describeThrown(e) {
    if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
      var msg;
      try { msg = toStr(e.message); } catch (x) { msg = '?'; }
      return { name: ctorName(e), message: msg };
    }
    return { name: typeof e, message: stringify(ser(e, new WeakSetC(), 0)) };
  }
  function stub(name) {
    var p = new Proxy(function () {}, {
      get: function (t, k) {
        if (k === 'then' || typeof k === 'symbol') return undefined;
        if (k === '__esModule') return false;
        return stub(name + '.' + toStr(k));
      },
      apply: function () { throw new ReferenceErrorC('module ' + name + ' is not available in the sandbox'); },
      construct: function () { throw new ReferenceErrorC('module ' + name + ' is not available in the sandbox'); }
    });
    return p;
  }
  function sandboxRequire(name) { return stub(toStr(name)); }

  var api = freeze({
    load: function (wrapper) {
      mod = { exports: {} };
      try {
        wrapper.call(mod.exports, mod.exports, sandboxRequire, mod, '/sandbox/file.js', '/sandbox');
        return stringify({ ok: true });
      } catch (e) {
        return stringify({ ok: false, error: describeThrown(e) });
      }
    },
    capture: function (fn) { lookup = fn; },
    resolve: function (desc) {
      function look(n) {
        var v;
        if (lookup) { try { v = lookup(n); } catch (e) { v = undefined; } }
        if (v === undefined && mod && mod.exports) {
          var ex = mod.exports;
          if ((typeof ex === 'object' || typeof ex === 'function') && ex !== null) {
            try { v = ex[n]; } catch (e) { v = undefined; }
            if (v === undefined && typeof ex === 'function' && ex.name === n) v = ex;
            if (v === undefined && ex.default && ex.default.name === n) v = ex.default;
          }
        }
        return v;
      }
      var fn, self;
      if (desc.kind === 'method') {
        var cls = look(desc.className);
        if (typeof cls !== 'function') return stringify({ ok: false, error: 'class ' + desc.className + ' not found' });
        if (desc.isStatic) { fn = cls[desc.name]; self = cls; }
        else { fn = cls.prototype && cls.prototype[desc.name]; self = cls.prototype; }
      } else {
        fn = look(desc.name);
      }
      if (typeof fn !== 'function') return stringify({ ok: false, error: desc.name + ' is not callable' });
      targetFn = fn; targetSelf = self; targetIsMethod = desc.kind === 'method' && !desc.isStatic;
      return stringify({ ok: true });
    },
    call: function (args) {
      curArgs = args;
      rec = { kind: 'pending', async: false };
      var self = targetIsMethod ? create(targetSelf) : targetSelf;
      try {
        var out = targetFn.apply(self, args);
        if (out !== null && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function') {
          rec.async = true;
          var r = rec;
          out.then(function (v) { r.kind = 'value'; r.value = ser(v, new WeakSetC(), 0); },
                   function (e) { r.kind = 'throw'; r.error = describeThrown(e); });
        } else {
          rec.kind = 'value';
          rec.value = ser(out, new WeakSetC(), 0);
        }
      } catch (e) {
        rec.kind = 'throw';
        rec.error = describeThrown(e);
      }
    },
    take: function () {
      rec.args = ser(curArgs, new WeakSetC(), 0);
      return stringify(rec);
    }
  });
  defineProperty(G, '__dt', { value: api, writable: false, configurable: false, enumerable: false });
  G.console = freeze({ log: function () {}, info: function () {}, warn: function () {}, error: function () {}, debug: function () {} });
})();`;

const CALL_TAKE = new vm.Script('__dt.take()', { filename: 'diff-test-take.js' });

function now() { return performance.now(); }

function hostError(err) {
  // Errors thrown into the host (compile errors, vm timeouts) are host or
  // engine objects with plain data fields; nothing user-defined runs here.
  const name = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'Timeout' : (err && err.name) || 'Error';
  return { name: String(name), message: String((err && err.message) || err) };
}

function makeSide(label, code, desc, loadTimeoutMs) {
  const ctx = vm.createContext(Object.create(null), {
    name: `diff-test-${label}`,
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate'
  });
  vm.runInContext(PRELUDE, ctx, { timeout: loadTimeoutMs });
  const wrapped = `__dt.load(function (exports, require, module, __filename, __dirname) {${code}\n;__dt.capture(function (__dt_n) { return eval(__dt_n); });\n})`;
  let res;
  try {
    const script = new vm.Script(wrapped, { filename: `${label}.js` });
    res = JSON.parse(script.runInContext(ctx, { timeout: loadTimeoutMs }));
  } catch (err) {
    return { ok: false, error: hostError(err) };
  }
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const r = JSON.parse(vm.runInContext(`__dt.resolve(${JSON.stringify(desc)})`, ctx, { timeout: loadTimeoutMs }));
    if (!r.ok) return { ok: true, callable: false, error: { name: 'NotCallable', message: r.error } };
  } catch (err) {
    return { ok: true, callable: false, error: hostError(err) };
  }
  return { ok: true, callable: true, ctx };
}

function callSide(side, literal, timeoutMs) {
  try {
    vm.runInContext(`__dt.call(${literal})`, side.ctx, { timeout: timeoutMs });
    return JSON.parse(CALL_TAKE.runInContext(side.ctx, { timeout: timeoutMs }));
  } catch (err) {
    const e = hostError(err);
    if (e.name === 'Timeout') return { kind: 'timeout' };
    return { kind: 'throw', async: false, error: e };
  }
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

function isRefError(r) { return r.kind === 'throw' && r.error && r.error.name === 'ReferenceError'; }

// 'equal' | 'mismatch' | 'unresolved'
function compare(a, b, fileMode) {
  if (a.kind === 'timeout' && b.kind === 'timeout') return 'unresolved';
  if (a.kind === 'timeout' || b.kind === 'timeout') return 'mismatch';
  const refA = isRefError(a), refB = isRefError(b);
  if (refA && refB) return 'unresolved';
  if (!fileMode && (refA || refB)) return 'unresolved';
  if (a.kind !== b.kind || a.async !== b.async) return 'mismatch';
  if (a.kind === 'throw') {
    if (a.error.name !== b.error.name || a.error.message !== b.error.message) return 'mismatch';
  } else if (a.kind === 'value' && !deepEq(a.value, b.value)) {
    return 'mismatch';
  }
  return deepEq(a.args, b.args) ? 'equal' : 'mismatch';
}

function main(data) {
  const t0 = now();
  const { currentCode, proposedCode, target, inputs, callTimeoutMs, loadTimeoutMs, budgetMs, fileMode } = data;
  const post = (msg) => data.port.postMessage(msg);

  const cur = makeSide('current', currentCode, target, loadTimeoutMs);
  if (!cur.ok) return { verdict: 'inconclusive', reason: `current failed to load: ${cur.error.name}: ${cur.error.message}`, runs: 0 };
  const prop = makeSide('proposed', proposedCode, target, loadTimeoutMs);
  if (!prop.ok) {
    if (!fileMode && prop.error.name === 'ReferenceError') {
      return { verdict: 'inconclusive', reason: `proposed snippet needs context to load: ${prop.error.message}`, runs: 0 };
    }
    return {
      verdict: 'divergent', runs: 0,
      reason: `proposed failed to load: ${prop.error.name}: ${prop.error.message}`,
      counterexample: { phase: 'load', proposed: { kind: 'throw', error: prop.error } }
    };
  }
  if (!cur.callable) return { verdict: 'inconclusive', reason: `current: ${cur.error.message}`, runs: 0 };
  if (!prop.callable) return { verdict: 'inconclusive', reason: `proposed: ${prop.error.message}`, runs: 0 };

  let runs = 0, equal = 0, unresolved = 0, refBoth = 0, budgetHit = false;
  for (let i = 0; i < inputs.length; i++) {
    if (now() - t0 > budgetMs) { budgetHit = true; break; }
    const literal = inputs[i];
    const a = callSide(cur, literal, callTimeoutMs);
    post({ type: 'progress', index: i, input: literal, current: a });
    const b = callSide(prop, literal, callTimeoutMs);
    runs++;
    const c = compare(a, b, fileMode);
    post({ type: 'compared', index: i });
    if (c === 'mismatch') {
      return {
        verdict: 'divergent', runs,
        reason: a.kind === 'timeout' || b.kind === 'timeout'
          ? `${a.kind === 'timeout' ? 'current' : 'proposed'} side exceeded the ${callTimeoutMs} ms per-call timeout`
          : 'outputs differ',
        counterexample: { index: i, input: literal, current: a, proposed: b }
      };
    }
    if (c === 'equal') equal++;
    else {
      unresolved++;
      if (isRefError(a) && isRefError(b)) refBoth++;
    }
  }
  if (equal === 0) {
    let reason;
    if (runs === 0) reason = 'time budget exhausted before any input ran';
    else if (refBoth === runs) reason = 'both sides threw ReferenceError on every input (missing context; pass fileSrc)';
    else reason = `no input produced a comparable result (${unresolved} unresolved)`;
    return { verdict: 'inconclusive', reason, runs };
  }
  const out = { verdict: 'equivalent', runs, compared: equal };
  if (budgetHit) out.reason = `time budget reached after ${runs} of ${inputs.length} inputs`;
  else if (unresolved) out.reason = `${unresolved} of ${runs} inputs unresolved (ReferenceError or both timed out)`;
  return out;
}

const flag = new Int32Array(workerData.flag);
let result;
try {
  result = main(workerData);
} catch (err) {
  result = { verdict: 'inconclusive', reason: `sandbox error: ${hostError(err).message}`, runs: 0 };
}
workerData.port.postMessage({ type: 'result', result });
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
