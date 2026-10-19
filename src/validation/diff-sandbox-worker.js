'use strict';

// Worker side of differential testing. Each side is loaded into its own vm
// context whose global is a null-prototype object, so no host-realm object
// (process, require, host Function) is reachable from evaluated code. Every
// call into a context goes through a timed Script with microtaskMode
// 'afterEvaluate', so loops and promise chains are bounded by the per-call
// timeout. Values never cross into the host realm: the context serialises
// results to a JSON string, which the worker parses into plain host data.
//
// A run compares, per input: the return value (returned functions are probed,
// thrown errors include own props), the arguments after the call, the `this`
// object, recorded calls into callbacks and dependency stubs, and the
// non-function exports of the module. Only value/throw/side-effect mismatches
// are divergent; timeouts and too few normal returns are inconclusive.

const vm = require('vm');
const { workerData } = require('worker_threads');

const PRELUDE = `(function () {
  'use strict';
  var G = globalThis;
  var stringify = JSON.stringify, isArray = Array.isArray;
  var create = Object.create, freeze = Object.freeze, assign = Object.assign, getDesc = Object.getOwnPropertyDescriptor;
  var ownNames = Object.getOwnPropertyNames, ownSymbols = Object.getOwnPropertySymbols;
  var objIs = Object.is, toStr = String, defineProperty = Object.defineProperty, imul = Math.imul;
  var construct = Reflect.construct, apply = Reflect.apply;
  var PromiseC = Promise, MapC = Map, SetC = Set, DateC = Date, RegExpC = RegExp, ErrorC = Error, WeakSetC = WeakSet, WeakMapC = WeakMap, ProxyC = Proxy;
  var ReferenceErrorC = ReferenceError, symToPrim = Symbol.toPrimitive, symIter = Symbol.iterator, emptyIter = [][Symbol.iterator];
  var MAX_NODES = 20000, MAX_DEPTH = 24, MAX_CALLS = 50, PROBE_ARGS = [0, 1, 'a'];
  var STATE = 0, PLAIN = 1, PROBE = 2;
  var lookup = null, mod = null, rec = null, cur = null, targets = [];
  var stubNames = new WeakMapC(), stubCache = new MapC(), seed = 0;

  Math.random = function () {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function newSt(mode) { return { seen: new WeakSetC(), budget: MAX_NODES, trunc: false, mode: mode, probes: 0 }; }
  function ctorName(v) {
    try { var c = v.constructor; return c && typeof c.name === 'string' ? c.name : 'Object'; } catch (e) { return '?'; }
  }
  function hash(s) {
    var a = -2128831035, b = 5381;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = imul(a ^ c, 16777619); b = (imul(b, 33) + c) | 0; }
    return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  }
  function ser(v, st, depth) {
    if (--st.budget < 0) { st.trunc = true; return { t: 'trunc' }; }
    var t = typeof v;
    if (v === undefined) return { t: 'u' };
    if (v === null) return null;
    if (t === 'number') return (v === v && v !== Infinity && v !== -Infinity && !objIs(v, -0)) ? v : { t: 'n', v: objIs(v, -0) ? '-0' : toStr(v) };
    if (t === 'string') return v.length > 256 ? { t: 's', len: v.length, h: hash(v) } : v;
    if (t === 'boolean') return v;
    if (t === 'bigint') return { t: 'big', v: toStr(v) };
    if (t === 'symbol') return { t: 'sym', v: toStr(v.description) };
    if (stubNames.has(v)) return { t: 'stub', name: stubNames.get(v) };
    if (depth > MAX_DEPTH) { st.trunc = true; return { t: 'deep' }; }
    if (t === 'function') {
      var f = { t: 'fn', name: toStr(v.name), len: v.length };
      if (st.mode === PROBE && st.probes < 2) {
        st.probes++;
        f.probes = [];
        for (var p = 0; p < PROBE_ARGS.length; p++) {
          try { f.probes[p] = ser(apply(v, undefined, [PROBE_ARGS[p]]), st, depth + 1); } catch (e) { f.probes[p] = { t: 'throw', error: describeThrown(e) }; }
        }
        st.probes--;
      }
      return f;
    }
    if (st.seen.has(v)) return { t: 'cycle' };
    st.seen.add(v);
    var out, i;
    if (isArray(v)) {
      out = [];
      for (i = 0; i < v.length && st.budget >= 0; i++) out[i] = ser(v[i], st, depth + 1);
      if (i < v.length) st.trunc = true;
      return { t: 'arr', len: v.length, v: out };
    }
    if (v instanceof DateC) return { t: 'date', v: toStr(v.getTime()) };
    if (v instanceof RegExpC) return { t: 're', v: toStr(v) };
    if (v instanceof MapC || v instanceof SetC) {
      out = [];
      v.forEach(function (val, key) { if (st.budget >= 0) out[out.length] = [ser(key, st, depth + 1), ser(val, st, depth + 1)]; });
      return { t: v instanceof MapC ? 'map' : 'set', v: out };
    }
    if (v instanceof ErrorC) return { t: 'err', name: ctorName(v), message: toStr(v.message), v: props(v, st, depth, true) };
    return { t: 'obj', c: ctorName(v), v: props(v, st, depth, false) };
  }
  // Own string and symbol keys, enumerable or not ('~' marks non-enumerable).
  function props(v, st, depth, isErr) {
    var out = {}, names = ownNames(v).sort(), syms = ownSymbols(v), n = names.length + syms.length;
    for (var i = 0; i < n && st.budget >= 0; i++) {
      var k = i < names.length ? names[i] : syms[i - names.length];
      if (isErr && (k === 'stack' || k === 'message')) continue;
      var d = getDesc(v, k);
      if (!d) continue;
      var key = (typeof k === 'symbol' ? '@@' + toStr(k.description) : k);
      if (!d.enumerable) key = '~' + key;
      var val;
      if ('value' in d) val = d.value;
      else if (d.get) {
        try { val = apply(d.get, v, []); } catch (e) { out[key] = { t: 'throw', error: describeThrown(e) }; continue; }
      } else { out[key] = { t: 'acc' }; continue; }
      if (st.mode === STATE && typeof val === 'function') continue;
      out[key] = ser(val, st, depth + 1);
    }
    return out;
  }
  function describeThrown(e) {
    if (e !== null && (typeof e === 'object' || typeof e === 'function')) {
      var msg, extra;
      try { msg = toStr(e.message); } catch (x) { msg = '?'; }
      try { extra = props(e, newSt(PLAIN), 1, true); } catch (x) { extra = null; }
      return { name: ctorName(e), message: msg, props: extra };
    }
    return { name: typeof e, message: stringify(ser(e, newSt(PLAIN), 0)) };
  }
  function note(label, args, isStub) {
    if (!rec) return;
    if (isStub) rec.stubbed = true;
    rec.ncalls++;
    if (rec.calls.length >= MAX_CALLS) return;
    var st = newSt(PLAIN), a = [];
    for (var i = 0; i < args.length; i++) a[i] = ser(args[i], st, 1);
    rec.calls[rec.calls.length] = [label, a];
  }
  // Inert dependency stub: every access, call and construction yields
  // another stub. Interactions are recorded; the host treats differences
  // that involve stubs as unresolved unless both sides interacted alike.
  function stub(name) {
    var s = stubCache.get(name);
    if (s) return s;
    s = new ProxyC(function () {}, {
      get: function (tg, k) {
        if (k === symToPrim) return function (hint) { note('prim ' + name, [hint], true); return hint === 'number' ? 0 : ''; };
        if (k === symIter) return function () { return apply(emptyIter, [], []); };
        if (typeof k === 'symbol' || k === 'then') return undefined;
        if (k === '__esModule') return false;
        if (k === 'prototype') return tg.prototype;
        note('get ' + name + '.' + k, [], true);
        return stub(name + '.' + k);
      },
      apply: function (tg, self, args) { note(name + '()', args, true); return stub(name + '()'); },
      construct: function (tg, args) { note('new ' + name, args, true); return stub('new ' + name); }
    });
    stubNames.set(s, name);
    stubCache.set(name, s);
    return s;
  }
  var CALLBACKS = [
    function (a) { return a; },
    function () { return true; },
    function () { return false; },
    function () {},
    function (a, b) { return a < b ? -1 : a > b ? 1 : 0; },
    function () { throw new ErrorC('callback failed'); },
    function () { return 1; },
    function (a) { return PromiseC.resolve(a); },
    function () { return PromiseC.reject(new ErrorC('callback rejected')); }
  ];
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
  function exported(x) {
    var ex = mod && mod.exports;
    if (ex === x) return true;
    if (ex === null || (typeof ex !== 'object' && typeof ex !== 'function')) return false;
    var ks = ownNames(ex);
    for (var i = 0; i < ks.length; i++) { var d = getDesc(ex, ks[i]); if (d && 'value' in d && d.value === x) return true; }
    return false;
  }
  function resolveOne(d, i) {
    var t = { mode: 'call' }, top;
    if (d.kind === 'value') { targets[i] = { mode: 'value', expr: d.expr }; return { ok: true }; }
    if (d.kind === 'method') {
      var cls = look(d.className);
      if (typeof cls !== 'function') return { ok: false, error: 'class ' + d.className + ' not found' };
      var holder = d.isStatic ? cls : cls.prototype;
      top = cls;
      if (d.accessor === 'constructor') { t.fn = cls; t.mode = 'new'; } else {
        if (d.accessor) { var ds = holder && getDesc(holder, d.name); t.fn = ds && ds[d.accessor]; } else t.fn = holder && holder[d.name];
        if (d.isStatic) t.self = cls; else { t.mode = 'instance'; t.proto = holder; }
      }
    } else if (d.kind === 'prop') {
      var owner = look(d.owner);
      if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return { ok: false, error: d.owner + ' not found' };
      if (d.accessor) { var od = getDesc(owner, d.name); t.fn = od && od[d.accessor]; } else t.fn = owner[d.name];
      t.self = owner; t.mode = 'owner'; top = owner;
    } else {
      t.fn = look(d.name); top = t.fn;
    }
    if (typeof t.fn !== 'function') return { ok: false, error: d.name + ' is not callable' };
    targets[i] = t;
    return { ok: true, exported: exported(top) };
  }
  function exportsState(st) {
    var ex = mod && mod.exports;
    if (ex === null || (typeof ex !== 'object' && typeof ex !== 'function')) return undefined;
    var out = {}, ks = ownNames(ex), isFn = typeof ex === 'function';
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      if (isFn && (k === 'length' || k === 'name' || k === 'prototype')) continue;
      var d = getDesc(ex, k);
      if (d && 'value' in d && typeof d.value !== 'function') out[k] = ser(d.value, st, 1);
    }
    return out;
  }

  var api = freeze({
    load: function (wrapper) {
      mod = { exports: {} };
      try {
        wrapper.call(mod.exports, mod.exports, function (n) { return stub(toStr(n)); }, mod, '/sandbox/file.js', '/sandbox');
        return stringify({ ok: true });
      } catch (e) {
        return stringify({ ok: false, error: describeThrown(e) });
      }
    },
    capture: function (fn) { lookup = fn; },
    cb: function (id) {
      var f = CALLBACKS[id];
      return function () { note('cb' + id, arguments); return apply(f, this, arguments); };
    },
    resolve: function (descs) {
      var out = [];
      for (var i = 0; i < descs.length; i++) {
        try { out[i] = resolveOne(descs[i], i); } catch (e) { out[i] = { ok: false, error: 'resolve failed: ' + describeThrown(e).message }; }
      }
      return stringify(out);
    },
    call: function (ti, args, selfProps) {
      var t = targets[ti];
      seed = 0;
      rec = { kind: 'pending', async: false, calls: [], ncalls: 0 };
      cur = { t: t, args: args, self: t.mode === 'instance' ? assign(create(t.proto), selfProps || {}) : t.self };
      try {
        var out = t.mode === 'new' ? construct(t.fn, args) : apply(t.fn, cur.self, args);
        if (out !== null && (typeof out === 'object' || typeof out === 'function') && !stubNames.has(out) && typeof out.then === 'function') {
          rec.async = true;
          var r = rec;
          out.then(function (v) { var st = newSt(PROBE); r.kind = 'value'; r.value = ser(v, st, 0); if (st.trunc) r.trunc = true; },
                   function (e) { r.kind = 'throw'; r.error = describeThrown(e); });
        } else {
          var st = newSt(PROBE);
          rec.kind = 'value';
          rec.value = ser(out, st, 0);
          if (st.trunc) rec.trunc = true;
        }
      } catch (e) {
        rec.kind = 'throw';
        rec.error = describeThrown(e);
      }
    },
    value: function (ti) {
      seed = 0;
      rec = { kind: 'value', async: false, calls: [], ncalls: 0 };
      var st = newSt(PLAIN);
      rec.value = ser(look(targets[ti].expr), st, 0);
      if (st.trunc) rec.trunc = true;
      var out = stringify(rec);
      rec = null;
      return out;
    },
    take: function () {
      var parts = [['args', cur.args], ['self', cur.t.mode === 'instance' || cur.t.mode === 'owner' ? cur.self : undefined]];
      for (var i = 0; i < parts.length; i++) {
        var st = newSt(STATE);
        rec[parts[i][0]] = ser(parts[i][1], st, 0);
        if (st.trunc) rec.trunc = true;
      }
      var sst = newSt(STATE);
      rec.state = exportsState(sst);
      if (sst.trunc) rec.trunc = true;
      var out = stringify(rec);
      rec = null;
      return out;
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

function makeSide(label, code, descs, loadTimeoutMs) {
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
  let resolved;
  try {
    resolved = JSON.parse(vm.runInContext(`__dt.resolve(${JSON.stringify(descs)})`, ctx, { timeout: loadTimeoutMs }));
  } catch (err) {
    const e = hostError(err);
    resolved = descs.map(() => ({ ok: false, error: `${e.name}: ${e.message}` }));
  }
  return { ok: true, ctx, resolved };
}

function runIn(side, src, timeoutMs) {
  try {
    vm.runInContext(src, side.ctx, { timeout: timeoutMs });
    return JSON.parse(CALL_TAKE.runInContext(side.ctx, { timeout: timeoutMs }));
  } catch (err) {
    const e = hostError(err);
    if (e.name === 'Timeout') return { kind: 'timeout' };
    return { kind: 'throw', async: false, error: e };
  }
}

function valueOf(side, ti, timeoutMs) {
  try {
    return JSON.parse(vm.runInContext(`__dt.value(${ti})`, side.ctx, { timeout: timeoutMs }));
  } catch (err) {
    const e = hostError(err);
    return e.name === 'Timeout' ? { kind: 'timeout' } : { kind: 'throw', async: false, error: e };
  }
}

function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
}

// Exports present on both sides must hold the same data; added or removed
// export keys are not compared here.
function stateEq(a, b) {
  if (!a || !b) return true;
  return Object.keys(a).every(k => !Object.prototype.hasOwnProperty.call(b, k) || deepEq(a[k], b[k]));
}

function isRefError(r) { return r.kind === 'throw' && r.error && r.error.name === 'ReferenceError'; }

// Snippet mode: a proposed-only ReferenceError for a name that appears nowhere
// in the file (or the current snippet) is a hallucinated helper.
function hallucinated(r, fileText) {
  const m = /^([\w$]+) is not defined$/.exec(r.error.message || '');
  if (!m || typeof fileText !== 'string') return false;
  return !new RegExp(`(^|[^\\w$])${m[1].replace(/\$/g, '\\$')}([^\\w$]|$)`).test(fileText);
}

const hasStub = (r) => JSON.stringify([r.value, r.error, r.self, r.state]).includes('{"t":"stub"');

// V8's own TypeError wording depends on the expression shape, not on the
// behaviour; two engine TypeErrors count as the same throw.
const ENGINE_TYPE_ERROR = /^(Cannot (read|set|destructure|convert|create|use)\b|.* is not (a function|iterable|a constructor|an object)\b|Reduce of empty array)/;

function errorsEq(a, b) {
  if (deepEq(a, b)) return true;
  return !!(a && b) && a.name === 'TypeError' && b.name === 'TypeError' &&
    ENGINE_TYPE_ERROR.test(a.message) && ENGINE_TYPE_ERROR.test(b.message) && deepEq(a.props, b.props);
}

function outputsDiffer(a, b) {
  return a.kind !== b.kind || a.async !== b.async || (a.kind === 'throw' ? !errorsEq(a.error, b.error) : !deepEq(a.value, b.value));
}

// 'equal' | 'mismatch' | 'differs' | 'unresolved' | 'timeout'. Stubs stand
// for unknown dependency behaviour: a difference is only a mismatch when both
// sides interacted with the stubs identically and no stub value is compared;
// otherwise it 'differs' (blocks equivalence without being a veto).
function compare(a, b, opts) {
  if (a.kind === 'timeout' || b.kind === 'timeout') return 'timeout';
  const refA = isRefError(a), refB = isRefError(b);
  if (refA && refB) return 'unresolved';
  if (!opts.fileMode && (refA || refB)) return refB && hallucinated(b, opts.fileText) ? 'mismatch' : 'differs';
  const callsEq = deepEq(a.calls, b.calls) && a.ncalls === b.ncalls;
  if (!outputsDiffer(a, b) && callsEq && deepEq(a.args, b.args) && deepEq(a.self, b.self) && stateEq(a.state, b.state)) {
    return a.trunc || b.trunc ? 'unresolved' : 'equal';
  }
  if (((a.stubbed || b.stubbed) && !callsEq) || hasStub(a) || hasStub(b)) return 'differs';
  return 'mismatch';
}

function main(data) {
  const t0 = now();
  const { currentCode, proposedCode, targets, callTimeoutMs, loadTimeoutMs, budgetMs, fileMode, fileText, minValueRuns } = data;
  const post = (msg) => data.port.postMessage(msg);
  const descs = targets.map(t => t.desc);
  const opts = { fileMode, fileText };

  const cur = makeSide('current', currentCode, descs, loadTimeoutMs);
  if (!cur.ok) return { verdict: 'inconclusive', reason: `current failed to load: ${cur.error.name}: ${cur.error.message}`, runs: 0 };
  const prop = makeSide('proposed', proposedCode, descs, loadTimeoutMs);
  if (!prop.ok) {
    if (prop.error.name === 'Timeout') return { verdict: 'inconclusive', reason: `proposed side exceeded the ${loadTimeoutMs} ms load timeout`, runs: 0 };
    if (!fileMode && prop.error.name === 'ReferenceError') {
      return { verdict: 'inconclusive', reason: `proposed snippet needs context to load: ${prop.error.message}`, runs: 0 };
    }
    return {
      verdict: 'divergent', runs: 0,
      reason: `proposed failed to load: ${prop.error.name}: ${prop.error.message}`,
      counterexample: { phase: 'load', proposed: { kind: 'throw', error: prop.error } }
    };
  }

  let runs = 0, tested = 0, inconclusive = false;
  const notes = [];
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti];
    const ra = cur.resolved[ti] || {}, rb = prop.resolved[ti] || {};
    if (!ra.ok || !rb.ok) {
      if (ra.ok && ra.exported) {
        return {
          verdict: 'divergent', runs,
          reason: `${t.label} is exported by current but not callable in proposed (${rb.error})`,
          counterexample: { phase: 'resolve', target: t.label, proposed: { kind: 'missing', error: rb.error } }
        };
      }
      notes.push(`${t.label}: ${ra.ok ? 'proposed' : 'current'} ${ra.ok ? rb.error : ra.error}`);
      if (!t.removed) inconclusive = true;
      continue;
    }
    tested++;
    const end = now() + (t0 + budgetMs - now()) / (targets.length - ti);
    const calls = t.desc.kind === 'value' ? [null] : t.inputs;
    let value = 0, thrown = 0, refBoth = 0, differs = 0, n = 0;
    for (let i = 0; i < calls.length; i++) {
      if (now() - t0 > budgetMs || (now() > end && value >= minValueRuns)) break;
      let a, b;
      if (calls[i] === null) {
        a = valueOf(cur, ti, callTimeoutMs);
        b = valueOf(prop, ti, callTimeoutMs);
      } else {
        const src = `__dt.call(${ti}, ${calls[i][0]}, ${calls[i][1]})`;
        a = runIn(cur, src, callTimeoutMs);
        b = runIn(prop, src, callTimeoutMs);
      }
      n++; runs++;
      post({ type: 'compared', runs });
      const c = compare(a, b, opts);
      if (c === 'timeout') {
        const side = a.kind === 'timeout' && b.kind === 'timeout' ? 'both sides' : a.kind === 'timeout' ? 'current side' : 'proposed side';
        return { verdict: 'inconclusive', runs, reason: `${side} exceeded the ${callTimeoutMs} ms per-call timeout on ${t.label}` };
      }
      if (c === 'mismatch') {
        return {
          verdict: 'divergent', runs,
          reason: `${t.label}: ${outputsDiffer(a, b) ? 'outputs differ' : 'side effects differ'}`,
          counterexample: { target: t.label, ti, index: i, input: calls[i] && calls[i][0], self: calls[i] ? calls[i][1] : undefined, current: a, proposed: b }
        };
      }
      if (c === 'equal') { if (a.kind === 'value') value++; else thrown++; } else if (c === 'differs') differs++;
      else if (isRefError(a) && isRefError(b)) refBoth++;
    }
    const need = t.desc.kind === 'value' ? 1 : minValueRuns;
    if (value >= need && !differs) {
      if (n < calls.length) notes.push(`${t.label}: time budget reached after ${n} of ${calls.length} inputs`);
      continue;
    }
    inconclusive = true;
    if (differs) notes.push(`${t.label}: ${differs} of ${n} runs differ only through dependency stubs or missing snippet context`);
    else if (n === 0) notes.push(`${t.label}: time budget exhausted before any input ran`);
    else if (refBoth === n) notes.push(`${t.label}: both sides threw ReferenceError on every input (${fileMode ? 'unresolved name in the file' : 'missing context; pass fileSrc'})`);
    else if (thrown === n) notes.push(`${t.label}: both sides threw on every input (${n} runs)`);
    else notes.push(`${t.label}: only ${value} of ${n} runs returned comparable values on both sides (need ${need})`);
  }
  if (!tested) return { verdict: 'inconclusive', runs, reason: `no changed callable could be resolved (${notes.join('; ')})` };
  if (inconclusive) return { verdict: 'inconclusive', runs, reason: notes.join('; ') };
  const out = { verdict: 'equivalent', runs };
  if (notes.length) out.reason = notes.join('; ');
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
