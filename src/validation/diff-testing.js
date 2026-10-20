'use strict';

// Differential testing oracle. Both the current and the proposed source are
// loaded into isolated vm contexts inside a worker_thread (resource-limited,
// empty env, killed after HARD_KILL_MS) and every changed callable in the
// edit is called with the same generated inputs on both sides; changed
// constants are compared by value. Callables are located wherever a module
// usually puts them: declarations, classes (methods, accessors, fields,
// computed keys), object literals (nested too), `X.prototype.m =`, `obj.m =`,
// `Object.defineProperty`, anonymous `module.exports`/`export default`, and
// inside top-level blocks and IIFEs. Inputs are arity-aware and shaped by the
// code: objects with the property names the function reads, arrays,
// recording callbacks, literals mined from both versions and boundary values
// derived from them (±1, repeats, case flips, regex samples with quantifier
// counts ±1 and metacharacters swapped, lengths around mined numbers).
// Inputs outside the original's evident domain (a number for an array
// parameter, ...) are not generated. They are passed as source literals and
// re-materialised inside each context on every call.
//
// Result (src/contracts.js DiffTest):
//   { applicable, verdict: 'equivalent'|'divergent'|'inconclusive', runs,
//     counterexample?, reason?, duration_ms }
// plus legacy fields for hybrid-validator.js: score (1 / 0 / 0.5),
// mismatches, function_name, arity, mode ('file'|'snippet').
//
// `equivalent` needs every input of every target run, one in five distinct
// inputs returning a value, and MIN_VALUE_RUNS value-returning runs per
// target (value-returning inputs are re-run when there are fewer). It is
// withheld (`inconclusive`) when targets were skipped, when a
// top-level statement outside a located callable changed, when a changed
// callable writes different module-scope bindings, or when the edit changes
// references to host globals the sandbox does not provide, to the global
// object (`globalThis` or a local alias of it, however the property is
// reached) or to the clock (`Date`; the sandbox clock is fixed).
// When the edit deletes code, the current version is probed so the result
// says whether that code ran (`deletions_observed`).
// run() is synchronous: the caller blocks on Atomics.wait until the worker
// reports or the hard kill fires. Python edits (`file` *.py or
// `lang: 'python'`) go to py-diff-testing.js.

const path = require('path');
const { changeHunks } = require('../utils/hunks');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { parse } = require('@babel/parser');

const WORKER_FILE = path.join(__dirname, 'diff-sandbox-worker.js');
const MAX_RUNS = 40;
const MAX_TARGETS = 8;
const MIN_VALUE_RUNS = 10;
const HARD_KILL_MS = 3000;
const BUDGET_MS = 1500;
const CALL_TIMEOUT_MS = 250;
const LOAD_TIMEOUT_MS = 1000;
const SEED = 42;
const CLASS_WRAP = '__DT_Class__';
const N_CALLBACKS = 9;
const ITER_CALLBACK = 9;
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 };
// Globals a Node module can see that the sandbox does not provide.
const HOST_GLOBALS = ['process', 'Buffer', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
  'clearImmediate', 'queueMicrotask', 'global', 'window', 'document', 'navigator', 'fetch', 'performance', 'structuredClone',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'atob', 'btoa', 'crypto', 'globalThis', 'Date', 'Function'];

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

// a.b.c / this.x / f() as a dotted path, else null
function pathOf(n) {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if ((n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && n.property.type === 'Identifier') {
    const o = pathOf(n.object);
    return o && `${o}.${n.property.name}`;
  }
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    const c = pathOf(n.callee);
    return c && `${c}()`;
  }
  return null;
}

const ownerPath = (n) => { const p = pathOf(n); return p && !/^this\b|\(\)/.test(p) ? p : null; };
const member = (owner, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${owner}.${key}` : `${owner}[${JSON.stringify(key)}]`);

function classTargets(cls, className, src, out) {
  const members = new Set(cls.body.body.map(m => (m.key && !m.computed ? propKey(m) : null)).filter(Boolean));
  for (const m of cls.body.body) {
    const keyExpr = m.computed ? src.slice(m.key.start, m.key.end) : null;
    const name = keyExpr ? `[${keyExpr}]` : m.key ? propKey(m) : null;
    if (!name) continue;
    const base = { className, members, keyExpr, start: m.start, end: m.end };
    if (m.type === 'ClassMethod') {
      out.push({ ...base, kind: 'method', name, isStatic: !!m.static, accessor: m.kind === 'method' ? null : m.kind, params: m.params.length, fn: m });
    } else if (m.type === 'ClassProperty' && m.static) {
      if (isFn(m.value)) out.push({ ...base, kind: 'prop', owner: className, name, accessor: null, params: m.value.params.length, fn: m.value });
      else if (m.value && !keyExpr) out.push({ ...base, kind: 'value', name, expr: member(className, name), params: 0 });
    } else if (m.type === 'ClassProperty') {
      const fn = isFn(m.value) ? m.value : null;
      out.push({ ...base, kind: 'field', name, params: fn ? fn.params.length : 0, fn });
    }
  }
}

// Methods, accessors and function-valued properties of an object literal
// bound to `owner` (a source expression); nested literals recurse; other
// properties are constants.
function objectTargets(obj, owner, src, out, depth = 0) {
  for (const p of obj.properties) {
    const key = p.type === 'SpreadElement' ? null : propKey(p);
    if (key === null) continue;
    if (p.type === 'ObjectMethod') {
      out.push({ kind: 'prop', owner, name: key, accessor: p.kind === 'method' ? null : p.kind, params: p.params.length, start: p.start, end: p.end, fn: p });
    } else if (isFn(p.value)) {
      out.push({ kind: 'prop', owner, name: key, accessor: null, params: p.value.params.length, start: p.start, end: p.end, fn: p.value });
    } else if (p.value.type === 'ObjectExpression' && depth < 2) {
      objectTargets(p.value, member(owner, key), src, out, depth + 1);
    } else if (p.value.type === 'ClassExpression') {
      classTargets(p.value, member(owner, key), src, out);
    } else if (!p.shorthand && p.value.type !== 'Identifier') {
      out.push({ kind: 'value', name: key, expr: member(owner, key), params: 0, start: p.start, end: p.end });
    }
  }
}

function valueTargets(name, expr, init, start, end, src, out) {
  if (!init || init.type === 'Identifier') return;
  if (init.type === 'ClassExpression') classTargets(init, expr, src, out);
  else if (init.type === 'ObjectExpression') objectTargets(init, expr, src, out);
  else out.push({ kind: 'value', name, expr, params: 0, start, end });
}

// Callables and constants of a program, at top level and inside top-level
// blocks, if statements and IIFEs.
function collectTargets(ast, src = '') {
  const out = [];
  const fnTarget = (name, fn, start, end) => out.push({ kind: 'fn', name, params: fn.params.length, start, end, fn });
  const assign = (node, left, right) => {
    const prop = memberName(left);
    if (prop) {
      const obj = left.object;
      const base = exportsBase(obj);
      if (base) {
        if (isFn(right)) fnTarget(prop, right, node.start, node.end);
        else valueTargets(prop, `${base}.${prop}`, right, node.start, node.end, src, out);
      } else if (memberName(obj) === 'prototype' && obj.object.type === 'Identifier') {
        if (isFn(right)) out.push({ kind: 'method', className: obj.object.name, members: new Set(), name: prop, isStatic: false, accessor: null, params: right.params.length, start: node.start, end: node.end, fn: right });
      } else if (ownerPath(obj)) {
        if (isFn(right)) out.push({ kind: 'prop', owner: ownerPath(obj), name: prop, accessor: null, params: right.params.length, start: node.start, end: node.end, fn: right });
        else if (right.type === 'ObjectExpression' || right.type === 'ClassExpression') valueTargets(prop, member(ownerPath(obj), prop), right, node.start, node.end, src, out);
      }
    } else if (exportsBase(left) === 'module.exports') {
      if (isFn(right)) fnTarget(right.id ? right.id.name : 'module.exports', right, node.start, node.end);
      else if (right.type === 'ObjectExpression' || right.type === 'ClassExpression') valueTargets('module.exports', 'module.exports', right, node.start, node.end, src, out);
    } else if (left.type === 'Identifier') {
      if (isFn(right)) fnTarget(left.name, right, node.start, node.end);
      else if (right.type === 'ClassExpression') classTargets(right, left.name, src, out);
    }
  };
  const defineProperty = (call) => {
    const [o, k, d] = call.arguments;
    if (pathOf(call.callee) !== 'Object.defineProperty' || !o || !k || k.type !== 'StringLiteral' || !d || d.type !== 'ObjectExpression') return;
    const owner = exportsBase(o) || ownerPath(o);
    if (!owner) return;
    for (const p of d.properties) {
      const key = p.type === 'SpreadElement' ? null : propKey(p);
      const fn = p.type === 'ObjectMethod' ? p : p.value && isFn(p.value) ? p.value : null;
      if (!fn || !['get', 'set', 'value'].includes(key)) continue;
      out.push({ kind: 'prop', owner, name: k.value, accessor: key === 'value' ? null : key, params: fn.params.length, start: p.start, end: p.end, fn });
    }
  };
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'ExportNamedDeclaration':
        visit(node.declaration);
        break;
      case 'ExportDefaultDeclaration': {
        const d = node.declaration;
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) visit(d);
        else if (d.type === 'FunctionDeclaration' || isFn(d)) fnTarget('module.exports.default', d, d.start, d.end);
        else if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') classTargets(d, 'module.exports.default', src, out);
        break;
      }
      case 'FunctionDeclaration':
        if (node.id) fnTarget(node.id.name, node, node.start, node.end);
        break;
      case 'ClassDeclaration':
        if (node.id) classTargets(node, node.id.name, src, out);
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier' || !d.init) continue;
          if (isFn(d.init)) fnTarget(d.id.name, d.init, node.start, node.end);
          else valueTargets(d.id.name, d.id.name, d.init, d.start, d.end, src, out);
        }
        break;
      case 'BlockStatement':
        node.body.forEach(visit);
        break;
      case 'IfStatement':
        visit(node.consequent);
        visit(node.alternate);
        break;
      case 'ExpressionStatement': {
        let e = node.expression;
        if (e.type === 'UnaryExpression') e = e.argument;
        if (e.type === 'AssignmentExpression' && e.operator === '=') assign(node, e.left, e.right);
        else if (e.type === 'CallExpression') {
          const callee = e.callee.type === 'MemberExpression' && ['call', 'apply'].includes(memberName(e.callee)) ? e.callee.object : e.callee;
          if (isFn(callee) && callee.body.type === 'BlockStatement') callee.body.body.forEach(visit);
          else defineProperty(e);
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
  if (ast) return { code: toScript(src, ast), targets: collectTargets(ast, src).map(withText(src)), parsed: true };
  const wrapped = `class ${CLASS_WRAP} {\n${src}\n}`;
  const wast = tryParse(wrapped);
  if (wast) return { code: wrapped, targets: collectTargets(wast, wrapped).map(withText(wrapped)), parsed: true };
  return { code: src, targets: [], parsed: false };
}

function prepareFile(fileSrc, region) {
  const ast = tryParse(fileSrc);
  if (!ast) return { code: fileSrc, targets: [], parsed: false };
  const all = collectTargets(ast, fileSrc).map(withText(fileSrc));
  const targets = all.filter(t => t.start < region.end && t.end > region.start);
  return { code: toScript(fileSrc, ast), targets, all, ast, src: fileSrc, parsed: true };
}

// --- what the edit touches outside the located callables ---------------------

const PURE_CTORS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Array', 'Object', 'Date', 'Error', 'TypeError', 'RangeError']);

function pureExpr(n) {
  if (!n) return true;
  switch (n.type) {
    case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NullLiteral': case 'RegExpLiteral': case 'BigIntLiteral':
    case 'Identifier': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression':
      return true;
    case 'TemplateLiteral': return n.expressions.every(pureExpr);
    case 'ArrayExpression': return n.elements.every(e => !e || pureExpr(e.type === 'SpreadElement' ? e.argument : e));
    case 'ObjectExpression': return n.properties.every(p => p.type === 'ObjectMethod' || (p.type === 'ObjectProperty' && !p.computed && pureExpr(p.value)));
    case 'UnaryExpression': return n.operator !== 'delete' && pureExpr(n.argument);
    case 'BinaryExpression': case 'LogicalExpression': return pureExpr(n.left) && pureExpr(n.right);
    case 'MemberExpression': return !n.computed && pureExpr(n.object);
    case 'NewExpression': return n.callee.type === 'Identifier' && PURE_CTORS.has(n.callee.name) && n.arguments.every(pureExpr);
    case 'CallExpression': return pathOf(n.callee) === 'Object.freeze' && n.arguments.every(pureExpr);
    default: return false;
  }
}

function declNames(s) {
  const names = [];
  const pat = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') names.push(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(q => pat(q.type === 'RestElement' ? q.argument : q.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(pat);
    else if (p.type === 'AssignmentPattern') pat(p.left);
    else if (p.type === 'RestElement') pat(p.argument);
  };
  const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
  if (!d) return names;
  if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) names.push(d.id.name);
  else if (d.type === 'VariableDeclaration') d.declarations.forEach(x => pat(x.id));
  return names;
}

function declLike(s) {
  const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
  if (!d) return false;
  if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') return true;
  if (d.type === 'VariableDeclaration') return d.declarations.every(x => pureExpr(x.init));
  return s.type === 'ExportDefaultDeclaration' && pureExpr(d);
}

// Top-level statements with located targets and comments blanked out,
// whitespace removed.
function stmtTexts(prep) {
  const blanks = prep.all.map(t => [t.start, t.end]).concat((prep.ast.comments || []).map(c => [c.start, c.end])).sort((a, b) => a[0] - b[0]);
  return prep.ast.program.body.map(s => {
    let text = '', at = s.start;
    for (const [a, b] of blanks) {
      if (a < at || b > s.end) continue;
      text += `${prep.src.slice(at, a)}\u0000`;
      at = b;
    }
    return { node: s, text: (text + prep.src.slice(at, s.end)).replace(/\s+/g, '').replace(/(\u0000[,;]?)+/g, '\u0000') };
  });
}

// Reasons a top-level statement changed in a way no located target covers:
// anything but a new or removed declaration with a side-effect-free value.
function uncovered(cur, prop) {
  const a = stmtTexts(cur), b = stmtTexts(prop);
  const unmatched = (xs, ys) => {
    const left = new Map();
    for (const y of ys) left.set(y.text, (left.get(y.text) || 0) + 1);
    return xs.filter(x => { const n = left.get(x.text); if (n) { left.set(x.text, n - 1); return false; } return true; });
  };
  const ua = unmatched(a, b), ub = unmatched(b, a);
  const reasons = [];
  for (const [mine, other, src] of [[ua, ub, cur.src], [ub, ua, prop.src]]) {
    const otherNames = new Set(other.flatMap(x => declNames(x.node)));
    for (const s of mine) {
      if (declLike(s.node) && !declNames(s.node).some(n => otherNames.has(n))) continue;
      reasons.push(`top-level statement changed outside a located callable: ${JSON.stringify(src.slice(s.node.start, s.node.end).replace(/\s+/g, ' ').slice(0, 60))}`);
    }
  }
  return [...new Set(reasons)];
}

function bindingNames(ast) {
  return new Set(ast.program.body.flatMap(declNames));
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

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'set', 'delete', 'add', 'clear', 'sort', 'reverse', 'fill', 'copyWithin']);

function rootOf(n) {
  while (n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')) n = n.object;
  return n && n.type === 'Identifier' ? n.name : null;
}

// Module-scope bindings a function writes (assigns, updates, deletes from or
// mutates through a mutator method).
function writes(fnNode, names) {
  const out = new Set();
  walk(fnNode, (n) => {
    let r = null;
    if (n.type === 'AssignmentExpression') r = rootOf(n.left);
    else if (n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) r = rootOf(n.argument);
    else if (n.type === 'CallExpression' && MUTATORS.has(memberName(n.callee))) r = rootOf(n.callee.object);
    if (r && names.has(r)) out.add(r);
  });
  return out;
}

const stripJs = (src) => src.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '""');

// Local names bound to the global object (`const g = globalThis`).
function globalAliases(src) {
  return [...stripJs(src || '').matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:globalThis|global|window)\s*(?=[;,\n)])/g)].map(m => m[1]);
}

// Identifier-like references outside strings and comments. Any property of
// the global object is reached through it or an alias, so those count too.
function hostGlobals(a, b, aliases = []) {
  const count = (src, g) => (stripJs(src).match(new RegExp(`(?<![\\w$.])${g.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length;
  return [...new Set([...HOST_GLOBALS, ...aliases])].filter(g => count(a, g) !== count(b, g));
}

const FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'ClassBody']);

// Innermost statement of a statement list that overlaps [a, b).
function listStatementAt(node, a, b, best = null) {
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue;
    const v = node[k];
    for (const c of Array.isArray(v) ? v : [v]) {
      if (!c || typeof c.type !== 'string' || c.end <= a || c.start >= b) continue;
      if (Array.isArray(v) && (k === 'body' || k === 'consequent') && /(Statement|Declaration)$/.test(c.type)) best = c;
      best = listStatementAt(c, a, b, best);
    }
  }
  return best;
}

// The current source with `__dt.hit(k);` before the innermost statement
// holding each deleted token, so the sandbox can tell whether deleted code
// ran. -> { code, n } or null when a deleted token is not reached by running
// its statement (a parameter, an expression-bodied function, a class body).
function probeDeletions(src, ranges) {
  const ast = tryParse(src);
  if (!ast) return null;
  const points = new Set();
  for (const [a, b] of ranges) {
    const st = listStatementAt(ast.program, a, b);
    if (!st) return null;
    let inner = false;
    walk(st, (n) => { if (FN_TYPES.has(n.type) && n.start <= a && b <= n.end) inner = true; });
    if (inner) return null;
    points.add(st.start);
  }
  const at = [...points].sort((x, y) => y - x);
  let out = src;
  at.forEach((p, k) => { out = `${out.slice(0, p)}__dt.hit(${k});${out.slice(p)}`; });
  const past = tryParse(out);
  return past ? { code: toScript(out, past), n: at.length } : null;
}

const keyOf = (t) => `${t.kind}:${t.className || t.owner || ''}:${t.isStatic ? 's' : ''}:${t.accessor || ''}:${t.name}`;

// { pairs: { cur, prop, removed? }[], skipped }: every target whose text
// changed, every callable the proposal removed, else every callable in both.
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
  return { pairs: out.slice(0, MAX_TARGETS), skipped: Math.max(0, out.length - MAX_TARGETS) };
}

// --- input generation -------------------------------------------------------

class Callback {
  constructor(id) { this.id = id; }
}

const ARRAY_HINTS = new Set(['length', 'map', 'forEach', 'filter', 'reduce', 'push', 'pop', 'slice', 'splice', 'indexOf',
  'includes', 'join', 'some', 'every', 'find', 'findIndex', 'sort', 'concat', 'flat', 'flatMap', 'shift', 'unshift', 'reverse', 'at']);
const STRING_HINTS = new Set(['length', 'trim', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'startsWith', 'endsWith',
  'charAt', 'charCodeAt', 'padStart', 'padEnd', 'substring', 'substr', 'match', 'repeat', 'includes', 'indexOf', 'slice']);
// Evidence of a parameter's type, used to keep generated inputs in the domain
// the original evidently accepts.
const ARRAY_ONLY = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'push', 'pop', 'splice', 'some', 'every', 'find',
  'findIndex', 'findLast', 'sort', 'flat', 'flatMap', 'shift', 'unshift', 'reverse', 'join', 'fill']);
const STRING_ONLY = new Set(['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'replaceAll', 'startsWith',
  'endsWith', 'charAt', 'charCodeAt', 'codePointAt', 'padStart', 'padEnd', 'substring', 'substr', 'match', 'matchAll', 'repeat',
  'localeCompare', 'normalize', 'search']);
const NUMBER_ONLY = new Set(['toFixed', 'toPrecision', 'toExponential']);
const PRIM_KEYS = new Set([...ARRAY_HINTS, ...STRING_HINTS, ...ARRAY_ONLY, ...STRING_ONLY, ...NUMBER_ONLY, 'keys', 'values', 'entries', 'toLocaleString']);
const GUARD_CALLS = new Set(['Array.isArray', 'String', 'Number', 'Boolean', 'Object', 'parseInt', 'parseFloat', 'isNaN',
  'Number.isNaN', 'Number.isFinite', 'Number.isInteger', 'isFinite', 'JSON.stringify', 'Object.keys', 'Object.entries', 'Object.values', 'Object.assign']);
const ELEMENT_CALLBACK = { forEach: 0, map: 0, filter: 0, some: 0, every: 0, find: 0, findIndex: 0, flatMap: 0, reduce: 1, reduceRight: 1 };
const ARITH_OPS = new Set(['-', '*', '/', '%', '**', '<<', '>>', '>>>', '&', '|', '^']);
const NUMERIC_OPS = new Set([...ARITH_OPS, '<', '>', '<=', '>=']);
const SKIP_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'call', 'apply', 'bind', 'then', 'toString', 'valueOf', 'hasOwnProperty']);
const EDGE_VALUES = [null, undefined, 0, '', [], {}, 1, -1, 'a', [1, 2, 3], true, -0];
const GENERIC_STRINGS = ['', ' a', 'a ', ' A b ', '0x10', 'a.b', 'A', '\u{1F600}', 'a\u{1F600}b'];

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

function newHints() {
  return {
    strings: new Set(), numbers: new Set(), regexes: [], keys: new Map(), called: new Set(), indexed: new Set(), numIndexed: new Set(),
    iterated: new Set(), numeric: new Set(), arith: new Set(), guarded: new Set(), counters: new Set(), alias: new Map(), typeofs: new Map(),
    usesArguments: false
  };
}

function addKey(h, p, k) {
  if (SKIP_KEYS.has(k)) return;
  if (!h.keys.has(p)) h.keys.set(p, new Set());
  h.keys.get(p).add(k);
}

const FOLD = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b, '**': (a, b) => a ** b, '<<': (a, b) => a << b, '>>': (a, b) => a >> b };

// Value of a constant numeric expression (`2 ** 20`, `-1`), else NaN.
function constNum(n) {
  if (!n) return NaN;
  if (n.type === 'NumericLiteral') return n.value;
  if (n.type === 'UnaryExpression' && n.operator === '-') return -constNum(n.argument);
  if (n.type === 'BinaryExpression' && FOLD[n.operator]) return FOLD[n.operator](constNum(n.left), constNum(n.right));
  return NaN;
}

const isNullish = (n) => n.type === 'NullLiteral' || (n.type === 'Identifier' && n.name === 'undefined');

// Literals, regexes, property names read per path, called / iterated /
// indexed / arithmetic paths, and paths the code tests before use.
function mine(fnNode, h) {
  const guard = (n) => { const p = n && pathOf(n); if (p) h.guarded.add(p); };
  walk(fnNode, (n) => {
    switch (n.type) {
      case 'StringLiteral':
        if (n.value.length <= 64) h.strings.add(n.value);
        break;
      case 'TemplateElement':
        if (n.value.cooked && n.value.cooked.length <= 64) h.strings.add(n.value.cooked);
        break;
      case 'TemplateLiteral':
        n.expressions.forEach(guard);
        break;
      case 'NumericLiteral':
        for (const d of [-1, 0, 1]) h.numbers.add(n.value + d);
        break;

      case 'RegExpLiteral':
        if (h.regexes.length < 8) h.regexes.push(n.pattern);
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const o = pathOf(n.object);
        if (!o) break;
        if (n.type === 'OptionalMemberExpression') h.guarded.add(o);
        if (!n.computed && n.property.type === 'Identifier') addKey(h, o, n.property.name);
        else if (n.computed && n.property.type === 'StringLiteral') addKey(h, o, n.property.value);
        else if (n.computed) {
          h.indexed.add(o);
          const q = n.property;
          if (q.type === 'NumericLiteral' || (q.type === 'BinaryExpression' && ARITH_OPS.has(q.operator)) || (q.type === 'Identifier' && h.counters.has(q.name))) h.numIndexed.add(o);
        }
        break;
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const p = pathOf(n.callee);
        if (p) h.called.add(p);
        if (n.type === 'OptionalCallExpression') guard(n.callee);
        if (GUARD_CALLS.has(p)) n.arguments.forEach(guard);
        if (p === 'Array.from' && pathOf(n.arguments[0])) h.iterated.add(pathOf(n.arguments[0]));
        const m = memberName(n.callee);
        const cb = n.arguments[0];
        const o = n.callee.type === 'MemberExpression' && pathOf(n.callee.object);
        if (o && m in ELEMENT_CALLBACK && isFn(cb) && cb.params[ELEMENT_CALLBACK[m]] && cb.params[ELEMENT_CALLBACK[m]].type === 'Identifier') {
          h.alias.set(`${o}.$el`, cb.params[ELEMENT_CALLBACK[m]].name);
        }
        break;
      }
      case 'SpreadElement': {
        const p = pathOf(n.argument);
        if (p) h.iterated.add(p);
        break;
      }
      case 'ForOfStatement': {
        const p = pathOf(n.right);
        if (!p) break;
        h.iterated.add(p);
        const d = n.left.type === 'VariableDeclaration' ? n.left.declarations[0].id : n.left;
        if (d.type === 'Identifier') h.alias.set(`${p}.$el`, d.name);
        break;
      }
      case 'ForStatement':
        if (n.init && n.init.type === 'VariableDeclaration') n.init.declarations.forEach(d => d.id.type === 'Identifier' && h.counters.add(d.id.name));
        break;
      case 'BinaryExpression': {
        const v = constNum(n);
        if (Number.isFinite(v)) for (const d of [-1, 0, 1]) h.numbers.add(v + d);
        for (const side of [n.left, n.right]) {
          const p = pathOf(side);
          if (p && NUMERIC_OPS.has(n.operator)) h.numeric.add(p);
          if (p && ARITH_OPS.has(n.operator)) h.arith.add(p);
        }
        if (['==', '===', '!=', '!=='].includes(n.operator) && (isNullish(n.left) || isNullish(n.right))) { guard(n.left); guard(n.right); }
        for (const [x, y] of [[n.left, n.right], [n.right, n.left]]) {
          const p = x.type === 'UnaryExpression' && x.operator === 'typeof' && y.type === 'StringLiteral' && pathOf(x.argument);
          if (p) h.typeofs.set(p, y.value);
        }
        break;
      }
      case 'UnaryExpression':
        if (n.operator === 'typeof' || n.operator === '!' || n.operator === '+') guard(n.argument);
        else if (n.operator === '-' || n.operator === '~') { const p = pathOf(n.argument); if (p) { h.numeric.add(p); h.arith.add(p); } }
        break;
      case 'LogicalExpression':
        guard(n.left); guard(n.right);
        break;
      case 'ConditionalExpression':
      case 'IfStatement':
      case 'WhileStatement':
        guard(n.test);
        break;
      case 'Identifier':
        if (n.name === 'arguments') h.usesArguments = true;
        break;
      default:
        break;
    }
  });
}

function paramPath(p, i, h) {
  if (p.type === 'AssignmentPattern') {
    const q = paramPath(p.left, i, h);
    h.guarded.add(q);
    return q;
  }
  if (p.type === 'RestElement') {
    const q = p.argument.type === 'Identifier' ? p.argument.name : `$${i}`;
    h.guarded.add(q);
    return q;
  }
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
    h.iterated.add(id);
  }
  return id;
}

const expandWith = (h) => (paths) => paths.flatMap(p => (h.alias.has(p) ? [p, h.alias.get(p)] : [p]));

// Type evidence for a path in the original, or null (anything goes).
function domainOf(path, h) {
  const all = expandWith(h)([path]);
  if (all.some(p => h.guarded.has(p))) return null;
  const ks = all.flatMap(p => [...(h.keys.get(p) || [])]);
  const d = {
    arr: ks.some(k => ARRAY_ONLY.has(k)),
    iter: all.some(p => h.numIndexed.has(p) || h.iterated.has(p)),
    str: ks.some(k => STRING_ONLY.has(k)),
    num: ks.some(k => NUMBER_ONLY.has(k)) || all.some(p => h.arith.has(p)),
    obj: ks.some(k => !PRIM_KEYS.has(k)),
    fn: all.some(p => h.called.has(p))
  };
  return Object.values(d).some(Boolean) ? d : null;
}

// Whether a generated value lies in the original's evident domain (null and
// undefined always do).
function fits(v, path, h, depth = 0) {
  if (v === null || v === undefined) return true;
  const d = domainOf(path, h);
  if (v instanceof Callback && v.id !== ITER_CALLBACK) {
    const r = domainOf(`${path}()`, h);
    if (r && (r.arr || r.iter)) return false;
  }
  const plain = typeof v === 'object' && !(v instanceof Callback);
  if (d && !((d.arr && Array.isArray(v)) || (d.iter && (Array.isArray(v) || typeof v === 'string')) || (d.str && typeof v === 'string') ||
    (d.obj && plain) || (d.fn && v instanceof Callback) ||
    (d.num && (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))))))) return false;
  if (depth >= 3 || !plain) return true;
  if (Array.isArray(v)) return v.every(x => fits(x, `${path}.$el`, h, depth + 1));
  return Object.keys(v).every(k => fits(v[k], `${path}.${k}`, h, depth + 1));
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

const RE_CLASS = { d: '1', D: 'a', w: 'a', W: ' ', s: ' ', S: 'a', b: '', B: '', n: '\n', t: '\t', r: '\r' };
const RE_META = '.*+?^$()[]{}|/\\-';

// A few strings a regex pattern matches plus near misses: each quantifier
// count ±1, each alternative, each escaped metacharacter swapped.
function regexSamples(pattern) {
  let i = 0;
  const inClass = (x, ch) => (typeof x === 'string' ? x === ch : x.cls ? new RegExp(`\\${x.cls}`).test(ch) : ch >= x.lo && ch <= x.hi);
  const charClass = () => {
    const neg = pattern[i] === '^';
    if (neg) i++;
    const set = [];
    while (i < pattern.length && pattern[i] !== ']') {
      const c = pattern[i++];
      if (c === '\\') { const d = pattern[i++]; set.push(RE_CLASS[d] !== undefined ? { cls: d } : d); } else if (pattern[i] === '-' && pattern[i + 1] && pattern[i + 1] !== ']') { set.push({ lo: c, hi: pattern[i + 1] }); i += 2; } else set.push(c);
    }
    i++;
    if (!neg) { const f = set[0]; return f === undefined ? '' : typeof f === 'string' ? f : f.cls ? RE_CLASS[f.cls] : f.lo; }
    return ['a', '1', '_', 'x', ' ', '.'].find(ch => !set.some(x => inClass(x, ch))) || '';
  };
  const render = (atoms, j = -1, f = null) => atoms.map((a, k) => (k === j ? f(a) : a.opts[0].repeat(a.count))).join('');
  const seq = () => {
    const alts = [[]];
    while (i < pattern.length && pattern[i] !== ')') {
      if (pattern[i] === '|') { i++; alts.push([]); continue; }
      alts[alts.length - 1].push(atom());
    }
    return alts;
  };
  const atom = () => {
    const c = pattern[i++];
    let a;
    if (c === '\\') { const d = pattern[i++]; a = RE_CLASS[d] !== undefined ? { opts: [RE_CLASS[d]] } : { opts: [d], meta: RE_META.includes(d) }; } else if (c === '[') a = { opts: [charClass()] };
    else if (c === '(') {
      let look = false;
      if (pattern[i] === '?') {
        if (pattern[i + 1] === ':') i += 2;
        else if (pattern[i + 1] === '<' && /[\w$]/.test(pattern[i + 2])) i = pattern.indexOf('>', i) + 1;
        else { look = true; i += pattern[i + 1] === '<' ? 3 : 2; }
      }
      const alts = seq();
      i++;
      a = { opts: look ? [''] : alts.map(x => render(x)) };
    } else a = { opts: [c === '^' || c === '$' ? '' : c === '.' ? 'a' : c] };
    let q = null;
    if ('*+?'.includes(pattern[i]) && i < pattern.length) q = pattern[i++] === '+' ? 1 : 0;
    else if (pattern[i] === '{') { const m = /^\{(\d+)(,\d*)?\}/.exec(pattern.slice(i)); if (m) { i += m[0].length; q = Number(m[1]); } }
    if (q !== null && pattern[i] === '?') i++;
    a.q = q !== null;
    a.count = a.q ? Math.min(Math.max(q, 1), 300) : 1;
    return a;
  };
  try {
    const out = [];
    for (const atoms of seq().slice(0, 4)) {
      out.push(render(atoms));
      atoms.forEach((a, j) => {
        if (a.q) out.push(render(atoms, j, x => x.opts[0].repeat(x.count + 1)), render(atoms, j, x => x.opts[0].repeat(x.count - 1)));
        for (const o of a.opts.slice(1, 4)) out.push(render(atoms, j, x => o.repeat(x.count)));
        if (a.meta) out.push(render(atoms, j, x => 'x'.repeat(x.count)));
      });
      if (atoms.some(a => a.meta)) out.push(atoms.map(a => (a.meta ? 'x' : a.opts[0]).repeat(a.count)).join(''));
    }
    return [...new Set(out)].filter(s => s.length <= 600).slice(0, 12);
  } catch {
    return [];
  }
}

const flipCase = (s) => [...s].map(c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');

// Boundary values: mined numbers (already ±1) and strings derived from mined
// strings and regexes (repeats, wrapped, case-flipped).
function boundaryPools(h) {
  const nums = [...h.numbers].filter(Number.isFinite).slice(0, 16);
  for (const n of [0, 1, 2, -1, 10]) if (nums.length < 4 && !nums.includes(n)) nums.push(n);
  const base = [...h.regexes.flatMap(regexSamples), ...h.strings].slice(0, 16);
  const strs = new Set();
  for (const s of base) for (const v of [s, s + s, `a${s}a`, flipCase(s)]) if (v.length <= 600) strs.add(v);
  for (const s of GENERIC_STRINGS) strs.add(s);
  return { nums, strs: [...strs].slice(0, 40) };
}

function generator(h, rand, pools) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  let force = null;
  const strings = ['', 'a', 'abc', 'A b ', 'ABC', '0', '1.5', 'a@b', 'a@b.co', '../x', '2024-01-31'];
  const numbers = [0, 1, -1, 2, 10, 0.5, 0.1, 0.126, -1.5, 2.675, 1e6];
  const forced = () => (force.s !== undefined ? force.s : force.n);
  const str = () => {
    if (force) return force.s !== undefined ? force.s : force.as === 'str' ? 'a'.repeat(force.n) : String(force.n);
    return pools.strs.length && rand() < 0.5 ? pick(pools.strs) : pick(strings);
  };
  const num = () => {
    if (force) return force.n !== undefined ? force.n : 1;
    const r = rand();
    if (pools.nums.length && r < 0.3) return pick(pools.nums);
    if (r < 0.5) return pick(numbers);
    return r < 0.75 ? Math.round(rand() * 2000 - 1000) : Math.round(rand() * 2e5 - 1e5) / 1000;
  };
  const lengths = pools.nums.filter(n => Number.isInteger(n) && n > 4 && n <= 64);
  const plainKeys = (ks) => ks.filter(k => !ARRAY_HINTS.has(k) && !STRING_HINTS.has(k));
  const allKeys = plainKeys([...new Set([...h.keys.values()].flatMap(s => [...s]))]).slice(0, 30);
  const expand = expandWith(h);
  const keysOf = (paths) => [...new Set(paths.flatMap(p => [...(h.keys.get(p) || [])]))];
  const prim = () => {
    if (force) return forced();
    const r = rand();
    if (r < 0.35) return num();
    if (r < 0.7) return str();
    if (r < 0.85) return rand() < 0.5;
    return rand() < 0.5 ? null : undefined;
  };
  const arrLen = (depth) => {
    if (force) return force.as === 'arr' && depth < 2 ? force.n : 2;
    return lengths.length && rand() < 0.2 ? pick(lengths) : Math.floor(rand() * 5);
  };
  const arr = (el, depth) => Array.from({ length: arrLen(depth) }, el);
  const obj = (keys, val) => {
    const o = {};
    for (const k of keys) if (force || rand() < 0.8) o[k] = val(k);
    return o;
  };
  const cbId = (all) => (all.some(p => h.iterated.has(`${p}()`) || keysOf([`${p}()`]).some(k => ARRAY_ONLY.has(k))) ? ITER_CALLBACK
    : force ? 0 : Math.floor(rand() * N_CALLBACKS));
  const any = (depth) => {
    if (force) return forced();
    const r = rand();
    if (depth >= 2 || r < 0.5) return prim();
    if (r < 0.65) return arr(() => any(depth + 1), depth);
    if (r < 0.9 && allKeys.length) return obj(allKeys.filter(() => rand() < 0.5), () => any(depth + 1));
    return new Callback(Math.floor(rand() * N_CALLBACKS));
  };
  const elem = (all, depth) => {
    const el = all.map(p => `${p}.$el`);
    if (expand(el).some(p => h.keys.has(p) || h.numeric.has(p) || h.called.has(p) || h.indexed.has(p))) return forPaths(el, depth + 1);
    return allKeys.length && !force && rand() < 0.5 ? obj(allKeys, () => any(depth + 2)) : any(depth + 1);
  };
  const forPaths = (paths, depth = 0) => {
    const all = expand(paths);
    const ks = keysOf(all);
    if (all.some(p => h.called.has(p)) && (force || rand() < 0.8)) return new Callback(cbId(all));
    const iter = all.some(p => h.indexed.has(p) || h.iterated.has(p));
    if (depth < 3 && (ks.length || iter)) {
      const own = plainKeys(ks);
      const arrayish = iter || ks.some(k => ARRAY_HINTS.has(k));
      const stringish = ks.some(k => STRING_HINTS.has(k));
      const sub = (k) => forPaths(all.map(p => `${p}.${k}`), depth + 1);
      if (force) {
        if (own.length) return obj(own, sub);
        if (arrayish && (force.as === 'arr' || !stringish)) return arr(() => elem(all, depth), depth);
        return stringish ? str() : forced();
      }
      const r = rand();
      if (own.length && r < 0.8) return obj(own, sub);
      if (arrayish && (!stringish || rand() < 0.6) && r < 0.85) return arr(() => elem(all, depth), depth);
      if (stringish && r < 0.85) return str();
    }
    if (force) return forced();
    const ty = all.map(p => h.typeofs.get(p)).find(Boolean);
    if (ty && rand() < 0.6) {
      if (ty === 'number' || ty === 'bigint') return num();
      if (ty === 'string') return str();
      if (ty === 'boolean') return rand() < 0.5;
      if (ty === 'function') return new Callback(Math.floor(rand() * N_CALLBACKS));
    }
    if (all.some(p => h.numeric.has(p)) && rand() < 0.6) return num();
    return any(depth);
  };
  return { forPaths, setForce: (f) => { force = f; } };
}

const tupleLit = (args) => `[${args.map(toLiteral).join(', ')}]`;

// { arity, inputs: { args, self, lit }[], probes } for one target pair.
// `probes` (a source literal) are the argument lists returned functions are
// called with.
function buildInputs(pair, runs, seed, arityOpt) {
  const t = pair.prop || pair.cur;
  const h = newHints(), hc = newHints();
  const paths = [], curPaths = [], nested = [];
  let required = 4;
  for (const side of [pair.cur, pair.prop]) {
    if (!side || !side.fn) continue;
    walk(side.fn, n => { if (n !== side.fn && (isFn(n) || n.type === 'ObjectMethod' || n.type === 'FunctionDeclaration')) nested.push(n); });
    mine(side.fn, h);
    side.fn.params.forEach((p, i) => { (paths[i] = paths[i] || []).push(paramPath(p, i, h)); });
    const opt = side.fn.params.findIndex(p => p.type === 'AssignmentPattern' || p.type === 'RestElement');
    required = Math.min(required, opt === -1 ? side.fn.params.length : opt);
  }
  if (pair.cur.fn) {
    mine(pair.cur.fn, hc);
    pair.cur.fn.params.forEach((p, i) => { curPaths[i] = paramPath(p, i, hc); });
  }
  let k;
  if (t.accessor === 'get') k = 0;
  else if (t.accessor === 'set') k = 1;
  else k = arityOpt || Math.min(Math.max(pair.cur.params, pair.prop ? pair.prop.params : 0, h.usesArguments ? 2 : 0), 4);
  const instance = (t.kind === 'method' && !t.isStatic && t.accessor !== 'constructor') || t.kind === 'field';
  const members = new Set([...(pair.cur.members || []), ...((pair.prop && pair.prop.members) || [])]);
  if (h.keys.has('this')) for (const m of members) h.keys.get('this').delete(m);
  const selfKeys = instance ? [...(h.keys.get('this') || [])] : [];
  const pools = boundaryPools(h);
  const rand = prng(seed);
  const gen = generator(h, rand, pools);
  const inDomain = (args) => args.every((v, j) => !curPaths[j] || fits(v, curPaths[j], hc));
  const argsFor = (n) => Array.from({ length: n }, (_, j) => gen.forPaths(paths[j] || [`$${j}`]));
  // Sometimes omit trailing optional/defaulted arguments.
  const argc = () => (required < k && rand() < 0.25 ? required + Math.floor(rand() * (k - required)) : k);
  const self = () => (selfKeys.length ? gen.forPaths(['this']) : undefined);
  const seen = new Set();
  const out = [];
  // Adds an in-domain input not seen before (arity-0 calls repeat).
  const add = (args, s) => {
    if (!inDomain(args)) return false;
    const lit = [tupleLit(args), toLiteral(s)];
    const key = lit.join('|');
    if ((k > 0 || selfKeys.length) && seen.has(key)) return false;
    seen.add(key);
    out.push({ args, self: s, lit });
    return true;
  };
  if (k > 0) {
    for (const v of EDGE_VALUES) {
      const args = Array(k).fill(v).map((x, j) => {
        if (!curPaths[j] || fits(x, curPaths[j], hc)) return x;
        for (let tries = 0; tries < 4; tries++) { const y = gen.forPaths(paths[j]); if (fits(y, curPaths[j], hc)) return y; }
        return null;
      });
      add(args, self());
    }
  } else for (let i = 0; i < 3; i++) add([], undefined);
  if (k > 0 || selfKeys.length) {
    const stringish = paths.flat().concat(selfKeys.length ? ['this'] : []).some(p => [...(h.keys.get(p) || [])].some(x => STRING_HINTS.has(x)));
    const forces = [];
    for (const n of pools.nums) {
      forces.push({ n, as: 'num' });
      if (Number.isInteger(n) && n >= 0 && n <= 2000) forces.push({ n, as: 'arr' });
      if (stringish && Number.isInteger(n) && n >= 0 && n <= 5000) forces.push({ n, as: 'str' });
    }
    for (const s of pools.strs) forces.push({ s });
    for (const f of forces) {
      gen.setForce(f);
      add(argsFor(k), self());
    }
    gen.setForce(null);
    for (let i = 0; i < runs; i++) {
      const n = argc();
      for (let tries = 0; tries < 6 && !add(argsFor(n), self()); tries++);
    }
  }
  // Probe argument lists for returned functions, shaped by the nested
  // functions' parameters, plus fixed and boundary values.
  const probes = [[0], [1], ['a'], [0, 1], [0, 2]];
  if (nested.length) {
    const np = [];
    for (const f of nested) f.params.slice(0, 3).forEach((p, i) => { (np[i] = np[i] || []).push(paramPath(p, i, h)); });
    const pk = Math.max(1, np.length);
    for (const n of [...new Set([0, 1, ...pools.nums.slice(0, 4)])]) {
      gen.setForce({ n, as: 'num' });
      probes.push(Array.from({ length: pk }, (_, j) => gen.forPaths(np[j] || [])));
    }
    gen.setForce(null);
    for (let i = 0; i < 3; i++) probes.push(Array.from({ length: pk }, (_, j) => gen.forPaths(np[j] || [])));
  }
  return { arity: k, inputs: out, probes: `[${probes.map(tupleLit).join(', ')}]`, pool: pools };
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
  if (opts && (opts.lang === 'python' || /\.py$/i.test(opts.file || ''))) return require('./py-diff-testing').run(opts);
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

  const { pairs, skipped } = chooseTargets(cur.targets, prop.targets, functionName);
  const caps = [];
  if (skipped) caps.push(`${skipped} changed callable(s) beyond the ${MAX_TARGETS}-target cap were not tested`);
  let bindings = [];
  if (mode === 'file' && prop.parsed) {
    caps.push(...uncovered(cur, prop));
    const pb = bindingNames(prop.ast);
    bindings = [...bindingNames(cur.ast)].filter(n => pb.has(n));
  }
  const names = new Set(bindings);
  for (const p of pairs) {
    if (!p.prop || !p.cur.fn || !p.prop.fn) continue;
    const a = writes(p.cur.fn, names), b = writes(p.prop.fn, names);
    const diff = [...a].filter(n => !b.has(n)).concat([...b].filter(n => !a.has(n)));
    if (diff.length) caps.push(`${labelOf(p.cur)} writes different module-scope state (${diff.join(', ')})`);
  }
  const globals = hostGlobals(currentSrc, proposedSrc, globalAliases(typeof fileSrc === 'string' ? fileSrc : currentSrc));
  if (globals.length) caps.push(`the edit changes references to host globals the sandbox does not provide (${globals.join(', ')})`);
  if (!pairs.length && (mode !== 'file' || !caps.length)) {
    return finish(t0, { verdict: 'inconclusive', reason: ['no callable function or constant located in the edit', ...caps].join('; '), runs: 0, mode });
  }
  const pool = { nums: new Set(), strs: new Set() };
  const plan = pairs.map((p, i) => {
    const t = p.prop || p.cur;
    const desc = { kind: t.kind, name: t.name, className: t.className, owner: t.owner, expr: t.expr, keyExpr: t.keyExpr || null, isStatic: !!t.isStatic, accessor: t.accessor || null, fnField: !!t.fn };
    const built = t.kind === 'value' ? { arity: 0, inputs: [], probes: '[]' } : buildInputs(p, runs, SEED + i, arity);
    if (built.pool) { built.pool.nums.forEach(n => pool.nums.add(n)); built.pool.strs.slice(0, 8).forEach(s => pool.strs.add(s)); }
    return { desc, label: labelOf(t), removed: !!p.removed, arity: built.arity, inputs: built.inputs, probes: built.probes };
  });

  const deleted = changeHunks(currentSrc, proposedSrc, 'edit.js').filter(h => h.deletion).flatMap(h => h.deleted);
  let probe = null;
  if (deleted.length && cur.parsed) {
    probe = mode === 'file' ? probeDeletions(fileSrc, deleted.map(([a, b]) => [a + at, b + at])) : probeDeletions(currentSrc, deleted);
  }

  const elapsed = performance.now() - t0;
  let res = execute({
    currentCode: probe ? probe.code : cur.code,
    hitCount: probe ? probe.n : 0,
    proposedCode: prop.code,
    targets: plan.map(p => ({ desc: p.desc, label: p.label, removed: p.removed, inputs: p.inputs.map(x => x.lit), probes: p.probes })),
    bindings,
    pool: [...pool.nums].slice(0, 16).concat([...pool.strs].slice(0, 8)),
    callTimeoutMs: opts.callTimeoutMs || CALL_TIMEOUT_MS,
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    budgetMs: opts.budgetMs || BUDGET_MS,
    minValueRuns: opts.minValueRuns || MIN_VALUE_RUNS,
    fileMode: mode === 'file',
    fileText: mode === 'snippet' && typeof fileSrc === 'string' ? `${fileSrc}\n${currentSrc}` : undefined
  }, hardKillMs - elapsed);

  if (res.verdict !== 'divergent' && (caps.length || !pairs.length)) {
    const why = pairs.length ? caps : ['no callable function or constant located in the edit', ...caps];
    res = { ...res, verdict: 'inconclusive', reason: [res.reason, ...why].filter(Boolean).join('; ') };
  }
  const ce = res.counterexample;
  const input = ce && plan[ce.ti] && plan[ce.ti].inputs[ce.index];
  if (input) {
    ce.args = jsonSafe(input.args);
    if (input.self !== undefined) ce.this = jsonSafe(input.self);
  }
  if (deleted.length) res.deletions_observed = !!probe && res.verdict === 'equivalent' && res.deletions_observed === true;
  else delete res.deletions_observed;
  const callables = plan.filter(p => p.desc.kind !== 'value');
  return finish(t0, {
    ...res,
    function_name: plan.map(p => p.label).join(', '),
    arity: callables.length ? callables[0].arity : 0,
    mode
  });
}

module.exports = { run, collectTargets, toLiteral, HARD_KILL_MS };
