'use strict';

// Worker side of differential testing. Each side is loaded into its own vm
// context whose global is a null-prototype object, so no host-realm object
// (process, require, host Function) is reachable from evaluated code. Every
// call into a context goes through a timed Script with microtaskMode
// 'afterEvaluate', so loops and promise chains are bounded by the per-call
// timeout. Values never cross into the host realm: the context serialises
// results to a JSON string, which the worker parses into plain host data.
//
// After load, the module-scope bindings, the exports and the interactions
// recorded during load are compared. A run then compares, per input: the
// return value (and whether it is an object an earlier call returned;
// returned functions are probed with shaped argument lists and their owner as
// `this`; generators are drained; thrown errors include own props), the
// arguments after the call, the `this` object, recorded calls into callbacks
// and dependency stubs, the non-function exports and the module-scope
// bindings. Dependency stubs answer with values from the mined literals on
// alternate runs. Only value/throw/side-effect mismatches are divergent, and
// not when the original threw an engine TypeError (the input is outside its
// domain); timeouts, unrun inputs and too few normal returns are inconclusive.

const vm = require('vm');
const { workerData } = require('worker_threads');

const PRELUDE = `(function () {
  'use strict';
  var G = globalThis;
  var stringify = JSON.stringify, isArray = Array.isArray;
  var create = Object.create, freeze = Object.freeze, assign = Object.assign, getDesc = Object.getOwnPropertyDescriptor;
  var ownNames = Object.getOwnPropertyNames, ownSymbols = Object.getOwnPropertySymbols, objToStr = Object.prototype.toString;
  var objIs = Object.is, toStr = String, defineProperty = Object.defineProperty, imul = Math.imul;
  var construct = Reflect.construct, apply = Reflect.apply;
  var PromiseC = Promise, MapC = Map, SetC = Set, DateC = Date, RegExpC = RegExp, ErrorC = Error, WeakSetC = WeakSet, WeakMapC = WeakMap, ProxyC = Proxy;
  var ReferenceErrorC = ReferenceError, symToPrim = Symbol.toPrimitive, symIter = Symbol.iterator, emptyIter = [][Symbol.iterator];
  var MAX_NODES = 20000, MAX_BIND_NODES = 5000, MAX_DEPTH = 24, MAX_CALLS = 50, MAX_KNOWN = 64, FIXED_NOW = 1700000000000;
  var STATE = 0, PLAIN = 1, PROBE = 2;
  var lookup = null, mod = null, rec = null, cur = null, targets = [], bindNames = [], pool = [], known = [];
  var probeArgs = [[0], [1], ['a']], vi = 0;
  var stubNames = new WeakMapC(), stubCache = new MapC(), seed = 0;

  Math.random = function () {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  G.Date = new ProxyC(DateC, {
    construct: function (tg, a, nt) { return construct(tg, a.length ? a : [FIXED_NOW], nt); },
    apply: function () { return toStr(construct(DateC, [FIXED_NOW])); }
  });
  DateC.now = function () { return FIXED_NOW; };

  function newSt(mode) { return { seen: new WeakSetC(), budget: MAX_NODES, trunc: false, mode: mode, probes: 0, pi: 0 }; }
  function ctorName(v) {
    try { var c = v.constructor; return c && typeof c.name === 'string' ? c.name : 'Object'; } catch (e) { return '?'; }
  }
  function hash(s) {
    var a = -2128831035, b = 5381;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = imul(a ^ c, 16777619); b = (imul(b, 33) + c) | 0; }
    return (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
  }
  function hash32(s) {
    var a = 0;
    for (var i = 0; i < s.length; i++) a = (imul(a, 31) + s.charCodeAt(i)) >>> 0;
    return a;
  }
  function ser(v, st, depth, owner) {
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
      // Returned functions are called with every probe list; one level
      // deeper with three of them, rotating with the outer probe.
      if (st.mode === PROBE && st.probes < 2) {
        var n = probeArgs.length, list = st.probes === 0 ? probeArgs : [probeArgs[st.pi % n], probeArgs[(st.pi + 1) % n], probeArgs[(st.pi + 2) % n]];
        st.probes++;
        f.probes = [];
        for (var p = 0; p < list.length; p++) {
          if (st.probes === 1) st.pi = p;
          try { f.probes[p] = ser(apply(v, owner, list[p]), st, depth + 1); } catch (e) { f.probes[p] = { t: 'throw', error: describeThrown(e) }; }
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
    if (st.mode !== STATE && objToStr.call(v) === '[object Generator]') {
      out = [];
      for (i = 0; i < 64 && st.budget >= 0; i++) { var r = v.next(); if (r.done) break; out[i] = ser(r.value, st, depth + 1); }
      return { t: 'gen', v: out };
    }
    if (v instanceof ErrorC) return { t: 'err', name: ctorName(v), message: toStr(v.message), v: props(v, st, depth, true) };
    return { t: 'obj', c: ctorName(v), v: props(v, st, depth, false) };
  }
  // Own string and symbol keys, enumerable or not ('~' marks non-enumerable).
  // Methods are serialised (probed, with the object as \`this\`) before the
  // data properties, so their effects on the object show.
  function props(v, st, depth, isErr) {
    var out = {}, names = ownNames(v).sort(), syms = ownSymbols(v), n = names.length + syms.length, vals = [];
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
      vals[vals.length] = [key, val];
    }
    for (var pass = 0; pass < 2; pass++) {
      for (var j = 0; j < vals.length && st.budget >= 0; j++) {
        if ((typeof vals[j][1] === 'function') === (pass === 0)) out[vals[j][0]] = ser(vals[j][1], st, depth + 1, v);
      }
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
  // On odd runs a property of a call result is a pool value, and numeric
  // coercions draw from the pool, so branches on dependency results are
  // taken both ways.
  function stub(name) {
    var s = stubCache.get(name);
    if (s) return s;
    s = new ProxyC(function () {}, {
      get: function (tg, k) {
        if (k === symToPrim) {
          return function (hint) {
            note('prim ' + name, [hint], true);
            if (hint !== 'number') return '';
            var nums = [];
            for (var q = 0; q < pool.length; q++) if (typeof pool[q] === 'number') nums[nums.length] = pool[q];
            return nums.length ? nums[(hash32(name) + vi) % nums.length] : 0;
          };
        }
        if (k === symIter) return function () { return apply(emptyIter, [], []); };
        if (typeof k === 'symbol' || k === 'then') return undefined;
        if (k === '__esModule') return false;
        if (k === 'prototype') return tg.prototype;
        var nm = name + '.' + k;
        note('get ' + nm, [], true);
        if ((vi & 1) && pool.length && name.indexOf('()') >= 0) return pool[(hash32(nm) + (vi >> 1)) % pool.length];
        return stub(nm);
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
    function () { return PromiseC.reject(new ErrorC('callback rejected')); },
    function () { return [1, 2, 3]; }
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
      var holder = d.isStatic ? cls : cls.prototype, key = d.keyExpr ? look(d.keyExpr) : d.name;
      top = cls;
      if (d.accessor === 'constructor') { t.fn = cls; t.mode = 'new'; } else {
        if (d.accessor) { var ds = holder && getDesc(holder, key); t.fn = ds && ds[d.accessor]; } else t.fn = holder && holder[key];
        if (d.isStatic) t.self = cls; else { t.mode = 'instance'; t.proto = holder; }
      }
    } else if (d.kind === 'prop') {
      var owner = look(d.owner);
      if (owner === null || (typeof owner !== 'object' && typeof owner !== 'function')) return { ok: false, error: d.owner + ' not found' };
      if (d.accessor) { var od = getDesc(owner, d.name); t.fn = od && od[d.accessor]; } else t.fn = owner[d.name];
      t.self = owner; t.mode = 'owner'; top = owner;
    } else if (d.kind === 'field') {
      var fc = look(d.className);
      if (typeof fc !== 'function') return { ok: false, error: 'class ' + d.className + ' not found' };
      t.mode = 'field'; t.fn = fc; t.name = d.keyExpr ? look(d.keyExpr) : d.name; t.fnField = d.fnField; top = fc;
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
  // Non-function module-scope bindings present in both versions.
  function bindState() {
    if (!lookup || !bindNames.length) return undefined;
    var st = newSt(STATE), out = {};
    st.budget = MAX_BIND_NODES;
    for (var i = 0; i < bindNames.length; i++) {
      var v;
      try { v = lookup(bindNames[i]); } catch (e) { continue; }
      if (typeof v !== 'function') out[bindNames[i]] = ser(v, st, 1);
    }
    return out;
  }

  var api = freeze({
    setup: function (names, values) { bindNames = names; pool = values; },
    load: function (wrapper) {
      mod = { exports: {} };
      var r = rec = { kind: 'load', calls: [], ncalls: 0 };
      try {
        wrapper.call(mod.exports, mod.exports, function (n) { return stub(toStr(n)); }, mod, '/sandbox/file.js', '/sandbox');
      } catch (e) {
        rec = null;
        return stringify({ ok: false, error: describeThrown(e) });
      }
      rec = null;
      r.bind = bindState();
      r.state = exportsState(newSt(STATE));
      return stringify({ ok: true, load: r });
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
    call: function (ti, args, selfProps, i, probes) {
      var t = targets[ti];
      seed = 0;
      vi = i | 0;
      if (probes && probes.length) probeArgs = probes;
      rec = { kind: 'pending', async: false, calls: [], ncalls: 0 };
      cur = { t: t, args: args, self: t.mode === 'instance' ? assign(create(t.proto), selfProps || {}) : t.self };
      try {
        var out;
        if (t.mode === 'field') {
          cur.self = construct(t.fn, []);
          out = cur.self[t.name];
          if (t.fnField && typeof out === 'function') out = apply(out, cur.self, args);
        } else out = t.mode === 'new' ? construct(t.fn, args) : apply(t.fn, cur.self, args);
        if (out !== null && (typeof out === 'object' || typeof out === 'function') && !stubNames.has(out)) {
          var at = known.indexOf(out);
          if (at < 0 && known.length < MAX_KNOWN) known[known.length] = out;
          rec.ident = at;
        }
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
      var st = newSt(PROBE);
      rec.value = ser(look(targets[ti].expr), st, 0);
      if (st.trunc) rec.trunc = true;
      var out = stringify(rec);
      rec = null;
      return out;
    },
    take: function () {
      var parts = [['args', cur.args], ['self', cur.t.mode === 'instance' || cur.t.mode === 'owner' || cur.t.mode === 'field' ? cur.self : undefined]];
      for (var i = 0; i < parts.length; i++) {
        var st = newSt(STATE);
        rec[parts[i][0]] = ser(parts[i][1], st, 0);
        if (st.trunc) rec.trunc = true;
      }
      var sst = newSt(STATE);
      rec.state = exportsState(sst);
      if (sst.trunc) rec.trunc = true;
      rec.bind = bindState();
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

function makeSide(label, code, descs, data) {
  const ctx = vm.createContext(Object.create(null), {
    name: `diff-test-${label}`,
    codeGeneration: { strings: true, wasm: false },
    microtaskMode: 'afterEvaluate'
  });
  vm.runInContext(PRELUDE, ctx, { timeout: data.loadTimeoutMs });
  vm.runInContext(`__dt.setup(${JSON.stringify(data.bindings || [])}, ${JSON.stringify(data.pool || [])})`, ctx, { timeout: data.loadTimeoutMs });
  const wrapped = `__dt.load(function (exports, require, module, __filename, __dirname) {${code}\n;__dt.capture(function (__dt_n) { return eval(__dt_n); });\n})`;
  let res;
  try {
    const script = new vm.Script(wrapped, { filename: `${label}.js` });
    res = JSON.parse(script.runInContext(ctx, { timeout: data.loadTimeoutMs }));
  } catch (err) {
    return { ok: false, error: hostError(err) };
  }
  if (!res.ok) return { ok: false, error: res.error };
  let resolved;
  try {
    resolved = JSON.parse(vm.runInContext(`__dt.resolve(${JSON.stringify(descs)})`, ctx, { timeout: data.loadTimeoutMs }));
  } catch (err) {
    const e = hostError(err);
    resolved = descs.map(() => ({ ok: false, error: `${e.name}: ${e.message}` }));
  }
  return { ok: true, ctx, resolved, load: res.load };
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

const hasStub = (r) => JSON.stringify([r.value, r.error, r.self, r.state, r.bind]).includes('{"t":"stub"');

// V8's own TypeError wording depends on the expression shape, not on the
// behaviour; two engine TypeErrors count as the same throw.
const ENGINE_TYPE_ERROR = /^(Cannot (read|set|destructure|convert|create|use)\b|.* is not (a function|iterable|a constructor|an object)\b|Reduce of empty array|Spread syntax requires)/;
const engineTypeError = (e) => !!e && e.name === 'TypeError' && ENGINE_TYPE_ERROR.test(e.message);

function errorsEq(a, b) {
  if (deepEq(a, b)) return true;
  return engineTypeError(a) && engineTypeError(b) && deepEq(a.props, b.props);
}

function outputsDiffer(a, b) {
  return a.kind !== b.kind || a.async !== b.async || a.ident !== b.ident || (a.kind === 'throw' ? !errorsEq(a.error, b.error) : !deepEq(a.value, b.value));
}

const callsEqual = (a, b) => deepEq(a.calls, b.calls) && a.ncalls === b.ncalls;

// 'equal' | 'mismatch' | 'differs' | 'ood' | 'unresolved' | 'timeout'. Stubs
// stand for unknown dependency behaviour: a difference is only a mismatch
// when both sides interacted with the stubs identically and no stub value is
// compared; otherwise it 'differs' (blocks equivalence without being a veto).
// A difference where the original threw an engine TypeError is on an input
// outside the original's domain ('ood').
function compare(a, b, opts) {
  if (a.kind === 'timeout' || b.kind === 'timeout') return 'timeout';
  const refA = isRefError(a), refB = isRefError(b);
  if (refA && refB) return 'unresolved';
  if (!opts.fileMode && (refA || refB)) return refB && hallucinated(b, opts.fileText) ? 'mismatch' : 'differs';
  const callsEq = callsEqual(a, b);
  if (!outputsDiffer(a, b) && callsEq && deepEq(a.args, b.args) && deepEq(a.self, b.self) && stateEq(a.state, b.state) && deepEq(a.bind, b.bind)) {
    return a.trunc || b.trunc ? 'unresolved' : 'equal';
  }
  if (((a.stubbed || b.stubbed) && !callsEq) || hasStub(a) || hasStub(b)) return 'differs';
  if (a.kind === 'throw' && engineTypeError(a.error)) return 'ood';
  return 'mismatch';
}

// Load-time comparison: module-scope bindings and exports after load, and
// the interactions recorded while loading. -> null | { divergent } | { note }
function compareLoad(a, b) {
  if (!a || !b) return null;
  const stateSame = deepEq(a.bind, b.bind) && stateEq(a.state, b.state);
  const callsEq = callsEqual(a, b);
  if (!stateSame && callsEq && !hasStub(a) && !hasStub(b)) return { divergent: true };
  if (!stateSame) return { note: 'module-scope state after load differs through dependency stubs' };
  if (!callsEq) return { note: 'load-time interactions with dependencies differ' };
  return null;
}

function main(data) {
  const t0 = now();
  const { currentCode, proposedCode, targets, callTimeoutMs, loadTimeoutMs, budgetMs, fileMode, fileText, minValueRuns } = data;
  const post = (msg) => data.port.postMessage(msg);
  const descs = targets.map(t => t.desc);
  const opts = { fileMode, fileText };

  const cur = makeSide('current', currentCode, descs, data);
  if (!cur.ok) return { verdict: 'inconclusive', reason: `current failed to load: ${cur.error.name}: ${cur.error.message}`, runs: 0 };
  const prop = makeSide('proposed', proposedCode, descs, data);
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
  const load = compareLoad(cur.load, prop.load);
  if (load && load.divergent) {
    return {
      verdict: 'divergent', runs: 1,
      reason: 'module-scope state differs after load',
      counterexample: { phase: 'load', current: cur.load, proposed: prop.load }
    };
  }
  if (!targets.length) return load ? { verdict: 'inconclusive', runs: 1, reason: load.note } : { verdict: 'equivalent', runs: 1 };

  let runs = 0, tested = 0, inconclusive = false;
  const notes = [];
  if (load) { inconclusive = true; notes.push(load.note); }
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
    let value = 0, thrown = 0, refBoth = 0, differs = 0, ood = 0, n = 0;
    for (let i = 0; i < calls.length; i++) {
      if (now() - t0 > budgetMs || now() > end) break;
      let a, b;
      if (calls[i] === null) {
        a = valueOf(cur, ti, callTimeoutMs);
        b = valueOf(prop, ti, callTimeoutMs);
      } else {
        const src = `__dt.call(${ti}, ${calls[i][0]}, ${calls[i][1]}, ${i}, ${t.probes || '[]'})`;
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
      else if (c === 'ood') ood++;
      else if (isRefError(a) && isRefError(b)) refBoth++;
    }
    // At least one in five distinct inputs (all of them when there are 3 or
    // fewer), up to minValueRuns.
    const need = t.desc.kind === 'value' ? 1 : Math.min(minValueRuns, Math.max(Math.ceil(calls.length / 5), Math.min(3, calls.length)));
    if (value >= need && !differs && !ood && n === calls.length) continue;
    inconclusive = true;
    if (differs) notes.push(`${t.label}: ${differs} of ${n} runs differ only through dependency stubs or missing snippet context`);
    else if (ood) notes.push(`${t.label}: ${ood} of ${n} runs differ only on inputs the current version rejects with a TypeError (outside its domain)`);
    else if (n < calls.length) notes.push(`${t.label}: time budget reached after ${n} of ${calls.length} inputs`);
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
