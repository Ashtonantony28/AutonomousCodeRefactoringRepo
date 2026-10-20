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
// `this`, and so are the methods and getters of a returned object's
// user-defined prototypes; generators are drained; thrown errors include own
// props and name; arrays include their named properties),
// the arguments after the call, the `this` object, recorded calls into
// callbacks and dependency stubs, console output, changes to the global
// object and the builtins (prototypes, Math, JSON, ...), the non-function
// exports and the module-scope bindings. Objects are compared with their key
// order, property attributes (enumerable, writable, configurable, accessor),
// frozen / sealed / extensible state and null prototype. Dependency stubs answer with values from the mined literals on
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
  var getProto = Object.getPrototypeOf, isFrozen = Object.isFrozen, isSealed = Object.isSealed, isExt = Object.isExtensible;
  var construct = Reflect.construct, apply = Reflect.apply, ownKeys = Reflect.ownKeys, keyFor = Symbol.keyFor;
  var PromiseC = Promise, MapC = Map, SetC = Set, DateC = Date, RegExpC = RegExp, ErrorC = Error, WeakSetC = WeakSet, WeakMapC = WeakMap, ProxyC = Proxy;
  var ReferenceErrorC = ReferenceError, symToPrim = Symbol.toPrimitive, symIter = Symbol.iterator, emptyIter = [][Symbol.iterator];
  var fnToStr = Function.prototype.toString, ObjProto = Object.prototype;
  var MAX_NODES = 20000, MAX_BIND_NODES = 5000, MAX_END_NODES = 500000, SMALL_NODES = 256, SMALL_TOTAL = 4000, MAX_DEPTH = 24, MAX_CALLS = 50, MAX_KNOWN = 64, FIXED_NOW = 1700000000000;
  var STATE = 0, PLAIN = 1, PROBE = 2;
  var lookup = null, mod = null, rec = null, cur = null, targets = [], bindNames = [], pool = [], known = [];
  var probeArgs = [[0], [1], ['a']], vi = 0;
  var stubNames = new WeakMapC(), stubCache = new MapC(), seed = 0, hits = [], realmBase = null, deferState = false, bindUsed = 0;
  var REALM = [['globalThis', G], ['Object', Object], ['Object.prototype', Object.prototype], ['Array', Array], ['Array.prototype', Array.prototype],
    ['String', String], ['String.prototype', String.prototype], ['Number', Number], ['Number.prototype', Number.prototype],
    ['Boolean.prototype', Boolean.prototype], ['Function.prototype', Function.prototype], ['Symbol', Symbol], ['Symbol.prototype', Symbol.prototype],
    ['Math', Math], ['JSON', JSON], ['Reflect', Reflect], ['Promise', PromiseC], ['Promise.prototype', PromiseC.prototype],
    ['Map.prototype', MapC.prototype], ['Set.prototype', SetC.prototype], ['Date', DateC], ['Date.prototype', DateC.prototype],
    ['RegExp', RegExpC], ['RegExp.prototype', RegExpC.prototype], ['Error', ErrorC], ['Error.prototype', ErrorC.prototype]];

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

  function descOf(o, k) { var d = getDesc(o, k); return d && [d.value, d.get, d.set, d.writable, d.enumerable, d.configurable]; }
  function snapRealm() {
    realmBase = [];
    for (var i = 0; i < REALM.length; i++) {
      var o = REALM[i][1], m = new MapC(), ks = ownKeys(o);
      for (var j = 0; j < ks.length; j++) m.set(ks[j], descOf(o, ks[j]));
      realmBase[i] = { m: m, ext: isExt(o) };
    }
  }
  // Properties of the global object and the builtins added, changed or
  // removed since setup, as 'Owner.key+|~|-'; undefined when none.
  function realmDiff() {
    if (!realmBase) return undefined;
    var out = [];
    for (var i = 0; i < REALM.length; i++) {
      var o = REALM[i][1], b = realmBase[i], ks = ownKeys(o), name = REALM[i][0], n = 0;
      for (var j = 0; j < ks.length; j++) {
        var d = descOf(o, ks[j]), was = b.m.get(ks[j]), key = name + '.' + toStr(typeof ks[j] === 'symbol' ? ks[j].description : ks[j]);
        if (!was) { out[out.length] = key + '+'; continue; }
        n++;
        for (var q = 0; q < 6; q++) if (!objIs(d[q], was[q])) { out[out.length] = key + '~'; break; }
      }
      if (n < b.m.size) b.m.forEach(function (x, k) { if (!getDesc(o, k)) out[out.length] = name + '.' + toStr(typeof k === 'symbol' ? k.description : k) + '-'; });
      if (isExt(o) !== b.ext) out[out.length] = name + ' extensible';
    }
    return out.length ? out : undefined;
  }
  // 'F' frozen, 'S' sealed, 'N' not extensible, '' otherwise.
  function shape(v) {
    try { return isFrozen(v) ? 'F' : isSealed(v) ? 'S' : isExt(v) ? '' : 'N'; } catch (e) { return '?'; }
  }
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
    if (t === 'symbol') return { t: 'sym', v: toStr(v.description), g: keyFor(v) !== undefined };
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
      var a = { t: 'arr', len: v.length, v: out }, sa = shape(v), an = i < v.length ? [] : ownNames(v), ai = an.length;
      if (sa) a.x = sa;
      // Named properties of a fully serialised array (own string keys after 'length').
      while (ai > 0 && an[ai - 1] !== 'length') ai--;
      for (; ai < an.length && st.budget >= 0; ai++) {
        var ad = getDesc(v, an[ai]);
        if (!a.p) a.p = {};
        a.p[an[ai]] = ad && 'value' in ad ? ser(ad.value, st, depth + 1) : { t: 'acc' };
      }
      return a;
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
    var pm = st.mode === PROBE ? protoMethods(v, st, depth) : undefined;
    var o = { t: 'obj', c: ctorName(v), v: props(v, st, depth, false) }, so = shape(v), ks;
    if (pm) o.m = pm;
    try { if (getProto(v) === null) o.c = '(null)'; } catch (e) { o.c = '?'; }
    try { ks = ownNames(v).join(','); } catch (e) { ks = '?'; }
    o.k = ks.length > 256 ? hash(ks) : ks;
    if (so) o.x = so;
    return o;
  }
  function userProto(p) {
    try {
      var c = getDesc(p, 'constructor');
      return !c || typeof c.value !== 'function' || fnToStr.call(c.value).indexOf('[native code]') < 0;
    } catch (e) { return false; }
  }
  // Methods and getters of a returned object's user-defined prototypes,
  // probed / read with the object as \`this\`, so state only they reach
  // (private fields, closures) shows.
  function protoMethods(v, st, depth) {
    var out, p, n = 0;
    try { p = getProto(v); } catch (e) { return undefined; }
    for (var lvl = 0; p && p !== ObjProto && lvl < 4 && st.budget >= 0; lvl++) {
      if (stubNames.has(p) || !userProto(p)) break;
      var ks = ownNames(p).sort();
      for (var i = 0; i < ks.length && n < 16 && st.budget >= 0; i++) {
        var d = ks[i] === 'constructor' ? null : getDesc(p, ks[i]), val;
        if (!d || (!d.get && typeof d.value !== 'function')) continue;
        if (!out) out = {};
        n++;
        if (d.get) {
          try { val = apply(d.get, v, []); } catch (e) { out[lvl + ':^' + ks[i]] = { t: 'throw', error: describeThrown(e) }; continue; }
        } else val = d.value;
        out[lvl + ':' + (d.get ? '^' : '') + ks[i]] = ser(val, st, depth + 1, v);
      }
      try { p = getProto(p); } catch (e) { break; }
    }
    return out;
  }
  // Own string and symbol keys, enumerable or not. Key prefixes: '~'
  // non-enumerable, '!' read-only, '#' non-configurable, '^' getter, '='
  // setter.
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
      if (d.writable === false) key = '!' + key;
      if (!d.configurable) key = '#' + key;
      if (d.get) key = '^' + key;
      if (d.set) key = '=' + key;
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
      var ename;
      try { msg = toStr(e.message); } catch (x) { msg = '?'; }
      try { ename = toStr(e.name); } catch (x) { ename = '?'; }
      try { extra = props(e, newSt(PLAIN), 1, true); } catch (x) { extra = null; }
      return { name: ctorName(e), ename: ename, message: msg, props: extra };
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
  function logged(method, args) {
    if (!rec) return;
    rec.nout = (rec.nout | 0) + 1;
    if (!rec.out) rec.out = [];
    if (rec.out.length >= MAX_CALLS) return;
    var st = newSt(PLAIN), a = [];
    for (var i = 0; i < args.length; i++) a[i] = ser(args[i], st, 1);
    rec.out[rec.out.length] = [method, a];
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
  // The values of all module bindings in one call (one eval when first
  // needed, not one per binding per call), keyed by index in a null-prototype
  // object; an index is missing when its binding could not be read.
  var reader = null, safeReader = null;
  function readBinds() {
    if (!lookup || !bindNames.length) return {};
    if (!reader) {
      var all = '', each = '';
      for (var i = 0; i < bindNames.length; i++) {
        all += (i ? ', ' : '') + bindNames[i];
        each += ' try { __dt_o[' + i + '] = ' + bindNames[i] + '; } catch (__dt_e) {}';
      }
      try { reader = lookup('(function () { return [' + all + ']; })'); } catch (e) { reader = function () { throw e; }; }
      try { safeReader = lookup('(function () { var __dt_o = { __proto__: null };' + each + ' return __dt_o; })'); } catch (e) {
        safeReader = function () {
          var o = create(null);
          for (var j = 0; j < bindNames.length; j++) { try { o[j] = lookup(bindNames[j]); } catch (e2) { /* unreadable */ } }
          return o;
        };
      }
    }
    // A binding that cannot be read (never initialised) fails the array
    // reader; then each one is read on its own from now on.
    try { return reader(); } catch (e) { reader = safeReader; }
    try { return safeReader(); } catch (e) { return {}; }
  }
  // Non-function module-scope bindings present in both versions, as the
  // changes since this side's previous call (\`d\` set, \`r\` removed; the
  // host keeps the full map): a binding still holding the primitive it held
  // then is not serialised again.
  var bindSent = [], bindVals = [], bindPrim = [];
  function bindState() {
    if (!lookup || !bindNames.length) return undefined;
    var st = newSt(STATE), out = create(null), gone = [], vals = readBinds();
    st.budget = MAX_BIND_NODES;
    for (var i = 0; i < bindNames.length; i++) {
      var v = vals[i];
      if (!(i in vals) || typeof v === 'function') {
        if (bindSent[i]) { bindSent[i] = false; gone[gone.length] = bindNames[i]; }
        continue;
      }
      if (bindSent[i] && bindPrim[i] && objIs(bindVals[i], v)) continue;
      var sv = out[bindNames[i]] = ser(v, st, 1);
      bindSent[i] = true;
      bindVals[i] = v;
      bindPrim[i] = (v === null || typeof v !== 'object') && !(sv && sv.t === 'trunc');
    }
    bindUsed = MAX_BIND_NODES - st.budget;
    return { d: out, r: gone };
  }

  // Deferred mode, after every call: each module binding, the owner \`this\`
  // and each export whose serialisation fits SMALL_NODES nodes (hashed when
  // long; larger ones are only marked), until SMALL_TOTAL nodes per call.
  // Cheap, and a mid-run difference in small state shows even when the end
  // state agrees. An object once found too large is not walked again while
  // its key still holds it, and a binding holding the same primitive as at
  // the previous digest is not looked at again. Sent as the changes since
  // this side's previous digest (\`d\` set, \`r\` removed); the host keeps the
  // full map.
  var bigKeys = new MapC(), lastDigest = new MapC(), lastOther = new MapC(), lastVals = [], lastPrim = [];
  function smallDigest() {
    var delta = create(null), gone = [], used = 0, stubs = false, seen = new SetC(), i, k;
    function enc(key, v) {
      if (used >= SMALL_TOTAL) return undefined;
      if (bigKeys.get(key) === v && v !== null && typeof v === 'object') return '~';
      var st = newSt(STATE);
      st.budget = SMALL_NODES;
      var s = stringify(ser(v, st, 1));
      used += st.trunc ? SMALL_NODES : SMALL_NODES - st.budget;
      if (st.trunc) { bigKeys.set(key, v); return '~'; }
      if (s.indexOf('{"t":"stub"') >= 0) stubs = true;
      return s.length > 64 ? hash(s) + ':' + s.length : s;
    }
    function put(last, key, s) {
      if (s === undefined) {
        if (last.has(key)) { last.delete(key); gone[gone.length] = key; }
      } else if (last.get(key) !== s) { delta[key] = s; last.set(key, s); }
    }
    var vals = readBinds();
    for (i = 0; i < bindNames.length; i++) {
      var has = i in vals, v = vals[i], prim = v === null || (typeof v !== 'object' && typeof v !== 'function');
      if (has && prim && lastPrim[i] && objIs(v, lastVals[i])) continue;
      k = 'b.' + bindNames[i];
      var s = has && typeof v !== 'function' ? enc(k, v) : undefined;
      put(lastDigest, k, s);
      lastVals[i] = v;
      lastPrim[i] = has && prim && s !== undefined;
    }
    var ex = mod && mod.exports, other = [];
    if (cur && cur.t.mode === 'owner') other[other.length] = ['self', cur.t.self];
    if (ex !== null && (typeof ex === 'object' || typeof ex === 'function')) {
      var ks = ownNames(ex).sort();
      for (i = 0; i < ks.length; i++) {
        if (typeof ex === 'function' && (ks[i] === 'length' || ks[i] === 'name' || ks[i] === 'prototype')) continue;
        var d = getDesc(ex, ks[i]);
        if (d && 'value' in d) other[other.length] = ['e.' + ks[i], d.value];
      }
    }
    for (i = 0; i < other.length; i++) {
      seen.add(other[i][0]);
      put(lastOther, other[i][0], typeof other[i][1] === 'function' ? undefined : enc(other[i][0], other[i][1]));
    }
    var left = [];
    lastOther.forEach(function (v, key) { if (!seen.has(key)) left[left.length] = key; });
    for (i = 0; i < left.length; i++) put(lastOther, left[i], undefined);
    return { d: delta, r: gone, stub: stubs };
  }

  var api = freeze({
    setup: function (names, values) { bindNames = names; pool = values; snapRealm(); },
    hit: function (k) { hits[k] = (hits[k] | 0) + 1; },
    hits: function () { return stringify(hits); },
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
      bindUsed = 0;
      r.bind = bindState();
      var est = newSt(STATE);
      r.state = exportsState(est);
      r.nodes = MAX_NODES - est.budget + bindUsed;
      r.realm = realmDiff();
      return stringify({ ok: true, load: r });
    },
    capture: function (fn) { lookup = fn; },
    defer: function () { deferState = true; },
    resync: function () { lastDigest = new MapC(); lastOther = new MapC(); lastVals = []; lastPrim = []; bindSent = []; bindVals = []; bindPrim = []; },
    // Exports, module bindings and the target's owner, hashed per key, for
    // a deferred (end-of-target) state comparison; MAX_END_NODES in all.
    state: function (ti) {
      var st = newSt(STATE), t = targets[ti] || {}, out = { kind: 'state', state: {}, bind: {} }, stubs = false;
      st.budget = MAX_END_NODES;
      function digest(v) { var s = stringify(ser(v, st, 1)); if (s.indexOf('{"t":"stub"') >= 0) stubs = true; return hash(s) + ':' + s.length; }
      var ex = mod && mod.exports, i, ks;
      if (ex !== null && (typeof ex === 'object' || typeof ex === 'function')) {
        ks = ownNames(ex);
        for (i = 0; i < ks.length; i++) {
          if (typeof ex === 'function' && (ks[i] === 'length' || ks[i] === 'name' || ks[i] === 'prototype')) continue;
          var d = getDesc(ex, ks[i]);
          if (d && 'value' in d && typeof d.value !== 'function') out.state[ks[i]] = digest(d.value);
        }
      }
      var vals = readBinds();
      for (i = 0; i < bindNames.length; i++) if (i in vals && typeof vals[i] !== 'function') out.bind[bindNames[i]] = digest(vals[i]);
      if (t.mode === 'owner') out.self = digest(t.self);
      if (st.trunc) out.trunc = true;
      if (stubs) out.stubbed = true;
      return stringify(out);
    },
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
      var parts = [['args', cur.args], ['self', cur.t.mode === 'instance' || (cur.t.mode === 'owner' && !deferState) || cur.t.mode === 'field' ? cur.self : undefined]];
      for (var i = 0; i < parts.length; i++) {
        var st = newSt(STATE);
        rec[parts[i][0]] = ser(parts[i][1], st, 0);
        if (st.trunc) rec.trunc = true;
      }
      if (!deferState) {
        var sst = newSt(STATE);
        rec.state = exportsState(sst);
        if (sst.trunc) rec.trunc = true;
        rec.bind = bindState();
      } else rec.digest = smallDigest();
      rec.realm = realmDiff();
      var out = stringify(rec);
      rec = null;
      return out;
    }
  });
  defineProperty(G, '__dt', { value: api, writable: false, configurable: false, enumerable: false });
  var con = {}, methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert', 'group', 'groupCollapsed',
    'groupEnd', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'clear'];
  for (var ci = 0; ci < methods.length; ci++) (function (m) { con[m] = function () { logged(m, arguments); }; })(methods[ci]);
  G.console = freeze(con);
})();`;

const CALL_TAKE = new vm.Script('__dt.take()', { filename: 'diff-test-take.js' });

const STATE_NODES = 2000;

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
  const side = { ok: true, ctx, resolved, load: res.load, bmap: new Map() };
  if (applyBinds(side, side.load.bind)) side.load.bind = Object.fromEntries(side.bmap);
  return side;
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

// A side's binding changes applied to its full map -> the names changed
// (undefined when the record has none).
function applyBinds(side, delta) {
  if (!delta) return undefined;
  const names = Object.keys(delta.d);
  for (const k of names) side.bmap.set(k, delta.d[k]);
  for (const k of delta.r) side.bmap.delete(k);
  return names.concat(delta.r);
}

// Applies both sides' digest changes for one call to the full maps kept
// here and tracks the keys where the two sides differ; each record's
// \`digest.v\` becomes those keys only. A call without a digest (or a side
// out of step) starts both sides over with full digests.
function syncDigests(cur, prop, a, b, diff, timeoutMs) {
  if (!a.digest || !b.digest) {
    for (const s of [cur, prop]) {
      s.dmap = new Map();
      try { vm.runInContext('__dt.resync()', s.ctx, { timeout: timeoutMs }); } catch { /* the run ends inconclusive */ }
    }
    diff.clear();
    return;
  }
  const touched = new Set();
  for (const [s, r] of [[cur, a], [prop, b]]) {
    s.dmap = s.dmap || new Map();
    for (const k of Object.keys(r.digest.d)) { s.dmap.set(k, r.digest.d[k]); touched.add(k); }
    for (const k of r.digest.r) { s.dmap.delete(k); touched.add(k); }
  }
  for (const k of touched) {
    const x = cur.dmap.get(k), y = prop.dmap.get(k);
    if (x !== undefined && y !== undefined && x !== y) diff.add(k); else diff.delete(k);
  }
  a.digest = { v: {}, stub: a.digest.stub };
  b.digest = { v: {}, stub: b.digest.stub };
  for (const k of diff) { a.digest.v[k] = cur.dmap.get(k); b.digest.v[k] = prop.dmap.get(k); }
}

// Applies both sides' binding changes for one call and tracks the names
// held by one side only or with different values; each record's \`bind\`
// becomes those names only. A record without bindings (the call or its read
// failed) leaves its side out of step: that side sends all of them next time.
function syncBinds(cur, prop, a, b, diff, timeoutMs) {
  const touched = new Set();
  for (const [s, r] of [[cur, a], [prop, b]]) {
    const names = applyBinds(s, r.bind);
    if (names) { for (const k of names) touched.add(k); continue; }
    for (const k of s.bmap.keys()) touched.add(k);
    s.bmap = new Map();
    try { vm.runInContext('__dt.resync()', s.ctx, { timeout: timeoutMs }); } catch { /* the run ends inconclusive */ }
  }
  for (const k of touched) {
    const x = cur.bmap.has(k), y = prop.bmap.has(k);
    if (x !== y || (x && !deepEq(cur.bmap.get(k), prop.bmap.get(k)))) diff.add(k); else diff.delete(k);
  }
  for (const [s, r] of [[cur, a], [prop, b]]) {
    if (!r.bind) continue;
    r.bind = {};
    for (const k of diff) if (s.bmap.has(k)) r.bind[k] = s.bmap.get(k);
  }
}

function stateOf(side, ti, timeoutMs) {
  try {
    return JSON.parse(vm.runInContext(`__dt.state(${ti})`, side.ctx, { timeout: timeoutMs }));
  } catch (err) {
    return { kind: 'timeout' };
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

const hasStub = (r) => JSON.stringify([r.value, r.error, r.self, r.state, r.bind, r.out]).includes('{"t":"stub"');

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
// Console output and changes to the global object / builtins.
const effectsEqual = (a, b) => deepEq(a.out, b.out) && (a.nout | 0) === (b.nout | 0) && deepEq(a.realm, b.realm);

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
  if (!outputsDiffer(a, b) && callsEq && effectsEqual(a, b) && deepEq(a.args, b.args) && deepEq(a.self, b.self) && stateEq(a.state, b.state) && deepEq(a.bind, b.bind) && (!a.digest || !b.digest || stateEq(a.digest.v, b.digest.v))) {
    return a.trunc || b.trunc ? 'unresolved' : 'equal';
  }
  if (((a.stubbed || b.stubbed) && !callsEq) || hasStub(a) || hasStub(b) || (a.digest && a.digest.stub) || (b.digest && b.digest.stub)) return 'differs';
  if (a.kind === 'throw' && engineTypeError(a.error)) return 'ood';
  return 'mismatch';
}

// Load-time comparison: module-scope bindings and exports after load, and
// the interactions recorded while loading. -> null | { divergent } | { note }
function compareLoad(a, b) {
  if (!a || !b) return null;
  const stateSame = deepEq(a.bind, b.bind) && stateEq(a.state, b.state) && effectsEqual(a, b);
  const callsEq = callsEqual(a, b);
  if (!stateSame && callsEq && !hasStub(a) && !hasStub(b)) return { divergent: true };
  if (!stateSame) return { note: 'module-scope state after load differs through dependency stubs' };
  if (!callsEq) return { note: 'load-time interactions with dependencies differ' };
  return null;
}

function main(data) {
  const t0 = now();
  const { currentCode, proposedCode, targets, callTimeoutMs, loadTimeoutMs, budgetMs, fileMode, fileText, minValueRuns } = data;
  const post = (msg) => { data.port.postMessage(msg); if (data.relay) data.relay.postMessage(msg); };
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
  if (!targets.length) return load ? { verdict: 'inconclusive', runs: 1, reason: load.note } : withHits({ verdict: 'equivalent', runs: 1 }, cur, data);
  // Large module state is compared in full once per target, after its runs;
  // after every call only its small parts are (smallDigest).
  const defer = Math.max(cur.load.nodes | 0, prop.load.nodes | 0) > STATE_NODES;
  if (defer) for (const s of [cur, prop]) vm.runInContext('__dt.defer()', s.ctx, { timeout: loadTimeoutMs });

  let runs = 0, tested = 0, inconclusive = false;
  const notes = [], digestDiff = new Set(), bindDiff = new Set();
  for (const k of new Set([...cur.bmap.keys(), ...prop.bmap.keys()])) {
    if (cur.bmap.has(k) !== prop.bmap.has(k) || !deepEq(cur.bmap.get(k), prop.bmap.get(k))) bindDiff.add(k);
  }
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
    // minValueRuns value-returning runs: at least one in five distinct inputs
    // (all of them when there are 3 or fewer) returns a value, and those
    // inputs are called again (new run index) until minValueRuns is reached.
    const distinct = t.desc.kind === 'value' ? 1 : Math.min(minValueRuns, Math.max(Math.ceil(calls.length / 5), Math.min(3, calls.length)));
    const need = t.desc.kind === 'value' ? 1 : minValueRuns;
    const valued = [];
    let value = 0, thrown = 0, refBoth = 0, differs = 0, ood = 0, n = 0;
    for (let i = 0; i < calls.length || (i < calls.length + 2 * need && value < need && valued.length >= distinct && !differs && !ood); i++) {
      if (now() - t0 > budgetMs || now() > end) break;
      const at = i < calls.length ? i : valued[(i - calls.length) % valued.length];
      let a, b;
      if (calls[at] === null) {
        a = valueOf(cur, ti, callTimeoutMs);
        b = valueOf(prop, ti, callTimeoutMs);
      } else {
        const src = `__dt.call(${ti}, ${calls[at][0]}, ${calls[at][1]}, ${i}, ${t.probes || '[]'})`;
        a = runIn(cur, src, callTimeoutMs);
        b = runIn(prop, src, callTimeoutMs);
        if (defer) syncDigests(cur, prop, a, b, digestDiff, loadTimeoutMs);
        else syncBinds(cur, prop, a, b, bindDiff, loadTimeoutMs);
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
          counterexample: { target: t.label, ti, index: at, input: calls[at] && calls[at][0], self: calls[at] ? calls[at][1] : undefined, current: a, proposed: b }
        };
      }
      if (c === 'equal') {
        if (a.kind === 'value') { value++; if (i < calls.length) valued.push(i); } else thrown++;
      } else if (c === 'differs') differs++;
      else if (c === 'ood') ood++;
      else if (isRefError(a) && isRefError(b)) refBoth++;
    }
    if (defer && n) {
      const sa = stateOf(cur, ti, loadTimeoutMs), sb = stateOf(prop, ti, loadTimeoutMs);
      if (sa.kind === 'timeout' || sb.kind === 'timeout') { inconclusive = true; notes.push(`${t.label}: module state could not be compared in time`); continue; }
      if (!(stateEq(sa.state, sb.state) && deepEq(sa.bind, sb.bind) && deepEq(sa.self, sb.self))) {
        if (!sa.stubbed && !sb.stubbed) {
          return {
            verdict: 'divergent', runs,
            reason: `${t.label}: module state differs after ${n} runs`,
            counterexample: { phase: 'state', target: t.label, current: sa, proposed: sb }
          };
        }
        differs++;
      } else if (sa.trunc || sb.trunc) { inconclusive = true; notes.push(`${t.label}: module state too large to compare`); continue; }
    }
    if (value >= need && valued.length >= distinct && !differs && !ood && n >= calls.length) continue;
    inconclusive = true;
    if (differs) notes.push(`${t.label}: ${differs} of ${n} runs differ only through dependency stubs or missing snippet context`);
    else if (ood) notes.push(`${t.label}: ${ood} of ${n} runs differ only on inputs the current version rejects with a TypeError (outside its domain)`);
    else if (n < calls.length) notes.push(`${t.label}: time budget reached after ${n} of ${calls.length} inputs`);
    else if (refBoth === n) notes.push(`${t.label}: both sides threw ReferenceError on every input (${fileMode ? 'unresolved name in the file' : 'missing context; pass fileSrc'})`);
    else if (thrown === n) notes.push(`${t.label}: both sides threw on every input (${n} runs)`);
    else notes.push(`${t.label}: only ${value} of ${n} runs returned comparable values on both sides (${valued.length} of ${calls.length} inputs; need ${distinct} inputs, ${need} runs)`);
  }
  if (!tested) return { verdict: 'inconclusive', runs, reason: `no changed callable could be resolved (${notes.join('; ')})` };
  if (inconclusive) return { verdict: 'inconclusive', runs, reason: notes.join('; ') };
  const out = { verdict: 'equivalent', runs };
  if (notes.length) out.reason = notes.join('; ');
  return withHits(out, cur, data);
}

// Whether every deletion probe in the current version ran.
function withHits(out, side, data) {
  if (!data.hitCount) return out;
  let hits = [];
  try { hits = JSON.parse(vm.runInContext('__dt.hits()', side.ctx, { timeout: data.loadTimeoutMs })); } catch { hits = []; }
  out.deletions_observed = Array.from({ length: data.hitCount }, (_, k) => hits[k] > 0).every(Boolean);
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
