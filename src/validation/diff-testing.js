'use strict';

// Differential testing oracle. Both the current and the proposed source are
// loaded into isolated vm contexts inside a worker_thread (resource-limited,
// empty env, killed after HARD_KILL_MS) and every changed callable in the
// edit (functions, class methods/accessors/constructors, object-literal
// methods/accessors) is called with the same generated inputs on both sides;
// changed constants are compared by value. Inputs are arity-aware and shaped
// by the code: objects with the property names the function reads, arrays,
// recording callbacks, and literals mined from both versions. They are passed
// as source literals and re-materialised inside each context on every call,
// so each side gets a fresh deep copy in its own realm.
//
// Result (src/contracts.js DiffTest):
//   { applicable, verdict: 'equivalent'|'divergent'|'inconclusive', runs,
//     counterexample?, reason?, duration_ms }
// plus legacy fields for hybrid-validator.js: score (1 / 0 / 0.5),
// mismatches, function_name, arity, mode ('file'|'snippet').
//
// `equivalent` needs MIN_VALUE_RUNS inputs per callable on which both sides
// returned normally; all-throw or a per-call timeout is `inconclusive`.
// run() is synchronous: the caller blocks on Atomics.wait until the worker
// reports or the hard kill fires.

const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { parse } = require('@babel/parser');

const WORKER_FILE = path.join(__dirname, 'diff-sandbox-worker.js');
const MAX_RUNS = 40;
const MAX_TARGETS = 8;
const MIN_VALUE_RUNS = 3;
const HARD_KILL_MS = 3000;
const BUDGET_MS = 1500;
const CALL_TIMEOUT_MS = 250;
const LOAD_TIMEOUT_MS = 1000;
const SEED = 42;
const CLASS_WRAP = '__DT_Class__';
const N_CALLBACKS = 9;
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 };

function tryParse(src) {
  try {
    return parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: false,
      errorRecovery: false
    });
  } catch {
    return null;
  }
}

function isFn(n) {
  return n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

function memberName(n) {
  if (!n || n.type !== 'MemberExpression' || n.computed) return null;
  return n.property.type === 'Identifier' ? n.property.name : null;
}

// 'module.exports' | 'exports' | null
function exportsBase(n) {
  if (n && n.type === 'Identifier' && n.name === 'exports') return 'exports';
  if (n && n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'module' && memberName(n) === 'exports') return 'module.exports';
  return null;
}

function propKey(p) {
  if (p.computed) return null;
  if (p.key.type === 'Identifier') return p.key.name;
  return p.key.type === 'StringLiteral' ? p.key.value : null;
}

function classTargets(cls, className, out) {
  for (const m of cls.body.body) {
    if (m.type !== 'ClassMethod' || m.computed || m.key.type !== 'Identifier') continue;
    out.push({ kind: 'method', className, name: m.key.name, isStatic: !!m.static, accessor: m.kind === 'method' ? null : m.kind, params: m.params.length, start: m.start, end: m.end, fn: m });
  }
}

// Methods, accessors and function-valued properties of an object literal
// bound to `owner` (a source expression); other properties are constants.
function objectTargets(obj, owner, out) {
  for (const p of obj.properties) {
    const key = p.type === 'SpreadElement' ? null : propKey(p);
    if (key === null) continue;
    if (p.type === 'ObjectMethod') {
      out.push({ kind: 'prop', owner, name: key, accessor: p.kind === 'method' ? null : p.kind, params: p.params.length, start: p.start, end: p.end, fn: p });
    } else if (isFn(p.value)) {
      out.push({ kind: 'prop', owner, name: key, accessor: null, params: p.value.params.length, start: p.start, end: p.end, fn: p.value });
    } else if (!p.shorthand && p.value.type !== 'Identifier') {
      out.push({ kind: 'value', name: key, expr: `${owner}[${JSON.stringify(key)}]`, params: 0, start: p.start, end: p.end });
    }
  }
}

function valueTargets(name, expr, init, start, end, out) {
  if (!init || init.type === 'Identifier' || init.type === 'ClassExpression') return;
  if (init.type === 'ObjectExpression') objectTargets(init, expr, out);
  else out.push({ kind: 'value', name, expr, params: 0, start, end });
}

// Top-level callables and constants of a program: function declarations,
// bindings to functions, classes (methods, accessors, constructor), object
// literals (methods, accessors, data properties), module.exports/exports
// assignments and other top-level constants.
function collectTargets(ast) {
  const out = [];
  const fnTarget = (name, fn, start, end) => out.push({ kind: 'fn', name, params: fn.params.length, start, end, fn });
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        visit(node.declaration);
        break;
      case 'FunctionDeclaration':
        if (node.id) fnTarget(node.id.name, node, node.start, node.end);
        break;
      case 'ClassDeclaration':
        if (node.id) classTargets(node, node.id.name, out);
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier' || !d.init) continue;
          if (isFn(d.init)) fnTarget(d.id.name, d.init, node.start, node.end);
          else if (d.init.type === 'ClassExpression') classTargets(d.init, d.id.name, out);
          else valueTargets(d.id.name, d.id.name, d.init, d.start, d.end, out);
        }
        break;
      case 'ExpressionStatement': {
        const e = node.expression;
        if (e.type !== 'AssignmentExpression' || e.operator !== '=') break;
        const prop = memberName(e.left);
        if (prop && e.left.type === 'MemberExpression' && exportsBase(e.left.object)) {
          if (isFn(e.right)) fnTarget(prop, e.right, node.start, node.end);
          else valueTargets(prop, `${exportsBase(e.left.object)}.${prop}`, e.right, node.start, node.end, out);
        } else if (exportsBase(e.left) === 'module.exports') {
          if (isFn(e.right) && e.right.id) fnTarget(e.right.id.name, e.right, node.start, node.end);
          else if (e.right.type === 'ObjectExpression') objectTargets(e.right, 'module.exports', out);
        } else if (e.left.type === 'Identifier' && isFn(e.right)) {
          fnTarget(e.left.name, e.right, node.start, node.end);
        }
        break;
      }
      default:
        break;
    }
  };
  for (const stmt of ast.program.body) visit(stmt);
  return out;
}

// Rewrite ES module syntax to something a CommonJS-style wrapper accepts.
// Imports become sandbox require() stubs; export keywords are dropped.
function toScript(src, ast) {
  if (!ast || ast.program.sourceType !== 'module') return src;
  const edits = [];
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const from = JSON.stringify(node.source.value);
      const text = node.specifiers.map(s => `var ${s.local.name} = require(${from});`).join(' ');
      edits.push({ start: node.start, end: node.end, text });
    } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.declaration) edits.push({ start: node.start, end: node.declaration.start, text: '' });
      else edits.push({ start: node.start, end: node.end, text: '' });
    } else if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration;
      const named = (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id;
      edits.push({ start: node.start, end: d.start, text: named ? '' : 'module.exports.default = ' });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const withText = (src) => (t) => ({ ...t, text: src.slice(t.start, t.end) });

// Snippet path: the snippet alone, or wrapped in a class when it is a bare
// method (or several) that does not parse at top level.
function prepareSnippet(src) {
  const ast = tryParse(src);
  if (ast) return { code: toScript(src, ast), targets: collectTargets(ast).map(withText(src)), parsed: true };
  const wrapped = `class ${CLASS_WRAP} {\n${src}\n}`;
  const wast = tryParse(wrapped);
  if (wast) return { code: wrapped, targets: collectTargets(wast).map(withText(wrapped)), parsed: true };
  return { code: src, targets: [], parsed: false };
}

function prepareFile(fileSrc, region) {
  const ast = tryParse(fileSrc);
  if (!ast) return { code: fileSrc, targets: [], parsed: false };
  const targets = collectTargets(ast)
    .filter(t => t.start < region.end && t.end > region.start)
    .map(withText(fileSrc));
  return { code: toScript(fileSrc, ast), targets, parsed: true };
}

const keyOf = (t) => `${t.kind}:${t.className || t.owner || ''}:${t.isStatic ? 's' : ''}:${t.accessor || ''}:${t.name}`;

// Pairs { cur, prop, removed? } to test: every target whose text changed,
// every callable the proposal removed, else every callable in both.
function chooseTargets(curTargets, propTargets, functionName) {
  const curByKey = new Map(curTargets.map(t => [keyOf(t), t]));
  const propKeys = new Set(propTargets.map(keyOf));
  const pairs = propTargets.filter(t => curByKey.has(keyOf(t))).map(t => ({ cur: curByKey.get(keyOf(t)), prop: t }));
  const removed = curTargets.filter(t => t.kind !== 'value' && !propKeys.has(keyOf(t))).map(t => ({ cur: t, prop: null, removed: true }));
  let out;
  if (functionName) {
    out = pairs.concat(removed).filter(p => p.cur.kind !== 'value' && p.cur.name === functionName);
  } else {
    out = pairs.filter(p => p.cur.text !== p.prop.text).concat(removed);
    if (!out.length) out = pairs.filter(p => p.cur.kind !== 'value');
  }
  return out.slice(0, MAX_TARGETS);
}

// --- input generation -------------------------------------------------------

class Callback {
  constructor(id) { this.id = id; }
}

const ARRAY_HINTS = new Set(['length', 'map', 'forEach', 'filter', 'reduce', 'push', 'pop', 'slice', 'splice', 'indexOf',
  'includes', 'join', 'some', 'every', 'find', 'findIndex', 'sort', 'concat', 'flat', 'flatMap', 'shift', 'unshift', 'reverse', 'at']);
const STRING_HINTS = new Set(['length', 'trim', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'startsWith', 'endsWith',
  'charAt', 'charCodeAt', 'padStart', 'padEnd', 'substring', 'substr', 'match', 'repeat', 'includes', 'indexOf', 'slice']);
const SKIP_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'call', 'apply', 'bind', 'then', 'toString', 'valueOf', 'hasOwnProperty']);
const EDGE_VALUES = [null, undefined, 0, '', [], {}, 1, -1, 'a', [1, 2, 3], true];

function toLiteral(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '-0';
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof Callback) return `__dt.cb(${v.id})`;
  if (Array.isArray(v)) return `[${v.map(toLiteral).join(', ')}]`;
  if (typeof v === 'object') return `({${Object.keys(v).map(k => `${JSON.stringify(k)}: ${toLiteral(v[k])}`).join(', ')}})`;
  return 'undefined';
}

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, fn); } else if (v && typeof v.type === 'string') walk(v, fn);
  }
}

// a.b.c / this.x as a dotted path, else null
function pathOf(n) {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && n.property.type === 'Identifier') {
    const o = pathOf(n.object);
    return o && `${o}.${n.property.name}`;
  }
  return null;
}

function newHints() {
  return { strings: new Set(), numbers: new Set(), keys: new Map(), called: new Set(), indexed: new Set(), alias: new Map(), usesArguments: false };
}

function addKey(h, p, k) {
  if (SKIP_KEYS.has(k)) return;
  if (!h.keys.has(p)) h.keys.set(p, new Set());
  h.keys.get(p).add(k);
}

// Literals, property names read per path, called paths and indexed paths.
function mine(fnNode, h) {
  walk(fnNode, (n) => {
    switch (n.type) {
      case 'StringLiteral':
        if (n.value.length <= 64) h.strings.add(n.value);
        break;
      case 'TemplateElement':
        if (n.value.cooked && n.value.cooked.length <= 64) h.strings.add(n.value.cooked);
        break;
      case 'NumericLiteral':
        for (const d of [-1, 0, 1]) h.numbers.add(n.value + d);
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const o = pathOf(n.object);
        if (!o) break;
        if (!n.computed && n.property.type === 'Identifier') addKey(h, o, n.property.name);
        else if (n.computed && n.property.type === 'StringLiteral') addKey(h, o, n.property.value);
        else if (n.computed) h.indexed.add(o);
        break;
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const p = pathOf(n.callee);
        if (p) h.called.add(p);
        break;
      }
      case 'Identifier':
        if (n.name === 'arguments') h.usesArguments = true;
        break;
      default:
        break;
    }
  });
}

function paramPath(p, i, h) {
  if (p.type === 'AssignmentPattern') return paramPath(p.left, i, h);
  if (p.type === 'RestElement') return p.argument.type === 'Identifier' ? p.argument.name : `$${i}`;
  if (p.type === 'Identifier') return p.name;
  const id = `$${i}`;
  if (p.type === 'ObjectPattern') {
    for (const q of p.properties) {
      if (q.type !== 'ObjectProperty' || q.computed || q.key.type !== 'Identifier') continue;
      addKey(h, id, q.key.name);
      const local = q.value.type === 'AssignmentPattern' ? q.value.left : q.value;
      if (local.type === 'Identifier') h.alias.set(`${id}.${q.key.name}`, local.name);
    }
  } else if (p.type === 'ArrayPattern') {
    h.indexed.add(id);
  }
  return id;
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(h, rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  // Literals mined from the code are drawn half of the time.
  const minedStrings = [...h.strings].slice(0, 40);
  const mined = [...h.numbers].filter(Number.isFinite).slice(0, 40);
  const strings = ['', 'a', 'abc', 'A b ', 'ABC', '0', '1.5', 'a@b', 'a@b.co', '../x', '2024-01-31'];
  const numbers = [0, 1, -1, 2, 10, 0.5, 0.1, 0.126, -1.5, 2.675, 1e6];
  const str = () => (minedStrings.length && rand() < 0.5 ? pick(minedStrings) : pick(strings));
  const num = () => {
    const r = rand();
    if (mined.length && r < 0.45) return pick(mined);
    return r < 0.8 ? pick(numbers) : Math.round(rand() * 2e5 - 1e5) / 1000;
  };
  const lengths = mined.filter(n => Number.isInteger(n) && n > 4 && n <= 64);
  const plainKeys = (ks) => ks.filter(k => !ARRAY_HINTS.has(k) && !STRING_HINTS.has(k));
  const allKeys = plainKeys([...new Set([...h.keys.values()].flatMap(s => [...s]))]).slice(0, 30);
  const expand = (paths) => paths.flatMap(p => (h.alias.has(p) ? [p, h.alias.get(p)] : [p]));
  const keysOf = (paths) => [...new Set(paths.flatMap(p => [...(h.keys.get(p) || [])]))];
  const prim = () => {
    const r = rand();
    if (r < 0.35) return num();
    if (r < 0.7) return str();
    if (r < 0.85) return rand() < 0.5;
    return rand() < 0.5 ? null : undefined;
  };
  const arr = (el) => Array.from({ length: lengths.length && rand() < 0.2 ? pick(lengths) : Math.floor(rand() * 5) }, el);
  const obj = (keys, val) => {
    const o = {};
    for (const k of keys) if (rand() < 0.8) o[k] = val(k);
    return o;
  };
  const any = (depth) => {
    const r = rand();
    if (depth >= 2 || r < 0.5) return prim();
    if (r < 0.65) return arr(() => any(depth + 1));
    if (r < 0.9 && allKeys.length) return obj(allKeys.filter(() => rand() < 0.5), () => any(depth + 1));
    return new Callback(Math.floor(rand() * N_CALLBACKS));
  };
  const forPaths = (paths, depth = 0) => {
    const all = expand(paths);
    const ks = keysOf(all);
    const r = rand();
    if (all.some(p => h.called.has(p)) && r < 0.5) return new Callback(Math.floor(rand() * N_CALLBACKS));
    if (depth < 3 && (ks.length || all.some(p => h.indexed.has(p)))) {
      const own = plainKeys(ks);
      const arrayish = ks.some(k => ARRAY_HINTS.has(k)) || all.some(p => h.indexed.has(p));
      const stringish = ks.some(k => STRING_HINTS.has(k));
      if (own.length && r < 0.8) return obj(own, (k) => forPaths(all.map(p => `${p}.${k}`), depth + 1));
      if (arrayish && (!stringish || rand() < 0.6) && r < 0.85) return arr(() => (allKeys.length && rand() < 0.5 ? obj(allKeys, () => any(depth + 2)) : any(depth + 1)));
      if (stringish && r < 0.85) return str();
    }
    return any(depth);
  };
  return { forPaths };
}

// [argsLiteral, selfLiteral][] for one target pair.
function buildInputs(pair, runs, seed, arityOpt) {
  const t = pair.prop || pair.cur;
  const h = newHints();
  const paths = [];
  let required = 4;
  for (const side of [pair.cur, pair.prop]) {
    if (!side || !side.fn) continue;
    mine(side.fn, h);
    side.fn.params.forEach((p, i) => { (paths[i] = paths[i] || []).push(paramPath(p, i, h)); });
    const opt = side.fn.params.findIndex(p => p.type === 'AssignmentPattern' || p.type === 'RestElement');
    required = Math.min(required, opt === -1 ? side.fn.params.length : opt);
  }
  let k;
  if (t.accessor === 'get') k = 0;
  else if (t.accessor === 'set') k = 1;
  else k = arityOpt || Math.min(Math.max(pair.cur.params, pair.prop ? pair.prop.params : 0, h.usesArguments ? 2 : 0), 4);
  const instance = t.kind === 'method' && !t.isStatic && t.accessor !== 'constructor';
  const selfKeys = instance ? [...(h.keys.get('this') || [])] : [];
  const rand = prng(seed);
  const gen = generator(h, rand);
  // Sometimes omit trailing optional/defaulted arguments.
  const argc = () => (required < k && rand() < 0.25 ? required + Math.floor(rand() * (k - required)) : k);
  const self = () => (selfKeys.length ? gen.forPaths(['this']) : undefined);
  const tuples = [];
  if (k > 0) for (const v of EDGE_VALUES) tuples.push([Array(k).fill(v), self()]);
  else for (let i = 0; i < MIN_VALUE_RUNS; i++) tuples.push([[], undefined]);
  if (k > 0 || selfKeys.length) {
    for (let i = 0; i < runs; i++) tuples.push([Array.from({ length: argc() }, (_, j) => gen.forPaths(paths[j] || [`$${j}`])), self()]);
  }
  const seen = new Set();
  const out = [];
  for (const [args, s] of tuples) {
    const lit = [`[${args.map(toLiteral).join(', ')}]`, toLiteral(s)];
    const key = lit.join('|');
    if (k > 0 && seen.has(key)) continue;
    seen.add(key);
    out.push({ args, self: s, lit });
  }
  return { arity: k, inputs: out };
}

function jsonSafe(v) {
  const rep = (key, x) => (typeof x === 'bigint' ? String(x) : x instanceof Callback ? `[callback ${x.id}]` : x);
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v, rep)); } catch { return null; }
}

// --- execution --------------------------------------------------------------

function execute(payload, hardKillMs) {
  const sab = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  let worker;
  try {
    worker = new Worker(WORKER_FILE, {
      workerData: { ...payload, flag: sab, port: port2 },
      transferList: [port2],
      resourceLimits: RESOURCE_LIMITS,
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true
    });
  } catch (err) {
    port1.close();
    return { verdict: 'inconclusive', reason: `worker failed to start: ${err.message}`, runs: 0 };
  }
  worker.on('error', () => {});
  worker.unref();
  Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, hardKillMs));
  let result = null, runs = 0, m;
  while ((m = receiveMessageOnPort(port1))) {
    const msg = m.message;
    if (msg.type === 'result') result = msg.result;
    else if (msg.type === 'compared') runs = msg.runs;
  }
  worker.terminate().catch(() => {});
  port1.close();
  if (result) return result;
  return { verdict: 'inconclusive', reason: `hard kill: sandbox did not finish within ${Math.round(hardKillMs)} ms (after ${runs} runs)`, runs };
}

function finish(t0, fields) {
  const out = { ...fields, duration_ms: Number((performance.now() - t0).toFixed(3)) };
  out.applicable = out.verdict !== 'inconclusive';
  out.score = out.verdict === 'equivalent' ? 1 : out.verdict === 'divergent' ? 0 : 0.5;
  out.mismatches = out.verdict === 'divergent' ? 1 : 0;
  if (out.verdict === 'inconclusive' && !out.reason) out.reason = 'inconclusive';
  return out;
}

const labelOf = (t) => (t.className ? `${t.className}.${t.name}` : t.owner ? `${t.owner}.${t.name}` : t.name);

function run(opts) {
  const t0 = performance.now();
  const { currentSrc, proposedSrc, fileSrc, functionName, arity, runs = MAX_RUNS } = opts;
  const hardKillMs = opts.hardKillMs || HARD_KILL_MS;
  if (typeof currentSrc !== 'string' || typeof proposedSrc !== 'string') {
    return finish(t0, { verdict: 'inconclusive', reason: 'currentSrc and proposedSrc must be strings', runs: 0 });
  }

  let mode = 'snippet';
  let cur, prop;
  const at = typeof fileSrc === 'string' && currentSrc ? fileSrc.indexOf(currentSrc) : -1;
  if (at >= 0) {
    const proposedFile = fileSrc.replace(currentSrc, () => proposedSrc);
    cur = prepareFile(fileSrc, { start: at, end: at + currentSrc.length });
    prop = prepareFile(proposedFile, { start: at, end: at + proposedSrc.length });
    if (cur.parsed) {
      mode = 'file';
      if (!cur.targets.length && !prop.targets.length) {
        cur.targets = prepareSnippet(currentSrc).targets.filter(t => t.kind === 'fn');
        prop.targets = prepareSnippet(proposedSrc).targets.filter(t => t.kind === 'fn');
      }
    }
  }
  if (mode === 'snippet') {
    cur = prepareSnippet(currentSrc);
    prop = prepareSnippet(proposedSrc);
  }

  const pairs = chooseTargets(cur.targets, prop.targets, functionName);
  if (!pairs.length) {
    return finish(t0, { verdict: 'inconclusive', reason: 'no callable function or constant located in the edit', runs: 0, mode });
  }
  const plan = pairs.map((p, i) => {
    const t = p.prop || p.cur;
    const desc = { kind: t.kind, name: t.name, className: t.className, owner: t.owner, expr: t.expr, isStatic: !!t.isStatic, accessor: t.accessor || null };
    const built = t.kind === 'value' ? { arity: 0, inputs: [] } : buildInputs(p, runs, SEED + i, arity);
    return { desc, label: labelOf(t), removed: !!p.removed, arity: built.arity, inputs: built.inputs };
  });

  const elapsed = performance.now() - t0;
  const res = execute({
    currentCode: cur.code,
    proposedCode: prop.code,
    targets: plan.map(p => ({ desc: p.desc, label: p.label, removed: p.removed, inputs: p.inputs.map(x => x.lit) })),
    callTimeoutMs: opts.callTimeoutMs || CALL_TIMEOUT_MS,
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    budgetMs: opts.budgetMs || BUDGET_MS,
    minValueRuns: opts.minValueRuns || MIN_VALUE_RUNS,
    fileMode: mode === 'file',
    fileText: mode === 'snippet' && typeof fileSrc === 'string' ? `${fileSrc}\n${currentSrc}` : undefined
  }, hardKillMs - elapsed);

  const ce = res.counterexample;
  const input = ce && plan[ce.ti] && plan[ce.ti].inputs[ce.index];
  if (input) {
    ce.args = jsonSafe(input.args);
    if (input.self !== undefined) ce.this = jsonSafe(input.self);
  }
  const callables = plan.filter(p => p.desc.kind !== 'value');
  return finish(t0, {
    ...res,
    function_name: plan.map(p => p.label).join(', '),
    arity: callables.length ? callables[0].arity : 0,
    mode
  });
}

module.exports = { run, collectTargets, toLiteral, HARD_KILL_MS };
