'use strict';

// Differential testing oracle. Both the current and the proposed source are
// loaded into isolated vm contexts inside a worker_thread (resource-limited,
// empty env, killed after HARD_KILL_MS) and the target function is called
// with the same generated inputs on both sides. Inputs are passed as source
// literals and re-materialised inside each context on every call, so each
// side gets a fresh deep copy that lives in its own realm (stronger than
// structuredClone: no host object is ever handed to evaluated code).
//
// Result (src/contracts.js DiffTest):
//   { applicable, verdict: 'equivalent'|'divergent'|'inconclusive', runs,
//     counterexample?, reason?, duration_ms }
// plus legacy fields for hybrid-validator.js: score (1 / 0 / 0.5),
// mismatches, function_name, arity, mode ('file'|'snippet').
//
// run() is synchronous: the caller blocks on Atomics.wait until the worker
// reports or the hard kill fires.

const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { parse } = require('@babel/parser');

let fc;
try { fc = require('fast-check'); } catch { fc = null; }

const WORKER_FILE = path.join(__dirname, 'diff-sandbox-worker.js');
const MAX_RUNS = 25;
const HARD_KILL_MS = 3000;
const BUDGET_MS = 1500;
const CALL_TIMEOUT_MS = 250;
const LOAD_TIMEOUT_MS = 1000;
const SEED = 42;
const CLASS_WRAP = '__DT_Class__';
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

function paramCount(fn) {
  return fn.params.length;
}

function isFn(n) {
  return n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
}

function memberName(n) {
  if (!n || n.type !== 'MemberExpression' || n.computed) return null;
  return n.property.type === 'Identifier' ? n.property.name : null;
}

function isExportsTarget(n) {
  if (!n || n.type !== 'MemberExpression') return false;
  const o = n.object;
  if (o.type === 'Identifier' && o.name === 'exports') return true;
  return o.type === 'MemberExpression' && o.object.type === 'Identifier' && o.object.name === 'module' && memberName(o) === 'exports';
}

function classTargets(cls, className, out) {
  for (const m of cls.body.body) {
    if (m.type === 'ClassMethod' && m.kind === 'method' && !m.computed && m.key.type === 'Identifier') {
      out.push({ kind: 'method', className, name: m.key.name, isStatic: !!m.static, params: paramCount(m), start: m.start, end: m.end });
    }
  }
}

// Top-level callables of a program: function declarations, const/let/var
// bound function or arrow expressions, module.exports/exports assignments,
// and class methods (of declared or variable-bound classes).
function collectTargets(ast) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        visit(node.declaration);
        break;
      case 'FunctionDeclaration':
        if (node.id) out.push({ kind: 'fn', name: node.id.name, params: paramCount(node), start: node.start, end: node.end });
        break;
      case 'ClassDeclaration':
        if (node.id) classTargets(node, node.id.name, out);
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          if (d.id.type !== 'Identifier' || !d.init) continue;
          if (isFn(d.init)) out.push({ kind: 'fn', name: d.id.name, params: paramCount(d.init), start: node.start, end: node.end });
          else if (d.init.type === 'ClassExpression') classTargets(d.init, d.id.name, out);
        }
        break;
      case 'ExpressionStatement': {
        const e = node.expression;
        if (e.type !== 'AssignmentExpression' || !isFn(e.right)) break;
        const prop = memberName(e.left);
        if (prop && isExportsTarget(e.left)) {
          out.push({ kind: 'fn', name: prop, params: paramCount(e.right), start: node.start, end: node.end });
        } else if (prop === 'exports' && e.left.object.type === 'Identifier' && e.left.object.name === 'module' && e.right.id) {
          out.push({ kind: 'fn', name: e.right.id.name, params: paramCount(e.right), start: node.start, end: node.end });
        } else if (e.left.type === 'Identifier') {
          out.push({ kind: 'fn', name: e.left.name, params: paramCount(e.right), start: node.start, end: node.end });
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

// Snippet path: the snippet alone, or wrapped in a class when it is a bare
// method (or several) that does not parse at top level.
function prepareSnippet(src) {
  const ast = tryParse(src);
  if (ast) return { code: toScript(src, ast), targets: collectTargets(ast).map(t => ({ ...t, text: src.slice(t.start, t.end) })), parsed: true };
  const wrapped = `class ${CLASS_WRAP} {\n${src}\n}`;
  const wast = tryParse(wrapped);
  if (wast) return { code: wrapped, targets: collectTargets(wast).map(t => ({ ...t, text: wrapped.slice(t.start, t.end) })), parsed: true };
  return { code: src, targets: [], parsed: false };
}

function prepareFile(fileSrc, region, src) {
  const ast = tryParse(fileSrc);
  if (!ast) return { code: src, targets: [], parsed: false };
  const targets = collectTargets(ast)
    .filter(t => t.start < region.end && t.end > region.start)
    .map(t => ({ ...t, text: fileSrc.slice(t.start, t.end) }));
  return { code: toScript(fileSrc, ast), targets, parsed: true };
}

const keyOf = (t) => `${t.kind}:${t.className || ''}:${t.isStatic ? 's' : ''}:${t.name}`;

function chooseTarget(curTargets, propTargets, functionName) {
  if (functionName) {
    return propTargets.find(t => t.name === functionName) || curTargets.find(t => t.name === functionName) || null;
  }
  const curByKey = new Map(curTargets.map(t => [keyOf(t), t]));
  const inBoth = propTargets.filter(t => curByKey.has(keyOf(t)));
  const changed = inBoth.find(t => curByKey.get(keyOf(t)).text !== t.text);
  if (changed) return changed;
  if (inBoth.length) return inBoth[0];
  if (!propTargets.length) return curTargets[0] || null;
  return null;
}

// Proposed inputs as JS source literals, evaluated inside each context.
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
  if (Array.isArray(v)) return `[${v.map(toLiteral).join(', ')}]`;
  if (typeof v === 'object') return `({${Object.keys(v).map(k => `${JSON.stringify(k)}: ${toLiteral(v[k])}`).join(', ')}})`;
  return 'undefined';
}

function buildArbitrary(arity) {
  const base = fc.oneof(
    fc.integer({ min: -50, max: 50 }),
    fc.float({ noNaN: true, min: -100, max: 100 }),
    fc.string({ maxLength: 6 }),
    fc.boolean(),
    fc.constantFrom(null, undefined, 0, ''),
    fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 4 })
  );
  return fc.tuple(...Array(arity).fill(base));
}

const EDGE_VALUES = [null, undefined, 0, '', [], 1, -1, 'a', [1, 2, 3], true];

function buildInputs(arity, runs) {
  const tuples = EDGE_VALUES.map(v => Array(arity).fill(v));
  if (fc && runs > 0) tuples.push(...fc.sample(buildArbitrary(arity), { numRuns: runs, seed: SEED }));
  return tuples.map(t => ({ args: t, literal: `[${t.map(toLiteral).join(', ')}]` }));
}

function jsonSafe(v) {
  try { return JSON.parse(JSON.stringify(v === undefined ? null : v, (k, x) => (typeof x === 'bigint' ? String(x) : x))); } catch { return null; }
}

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
  let result = null, last = null, runs = 0, m;
  while ((m = receiveMessageOnPort(port1))) {
    const msg = m.message;
    if (msg.type === 'result') result = msg.result;
    else { last = msg; if (msg.type === 'compared') runs = msg.index + 1; }
  }
  worker.terminate().catch(() => {});
  port1.close();
  if (result) return result;
  if (last && last.type === 'progress' && last.current.kind !== 'timeout') {
    return {
      verdict: 'divergent',
      runs: last.index + 1,
      reason: `proposed side still running at the ${HARD_KILL_MS} ms hard kill while current returned`,
      counterexample: { index: last.index, input: last.input, current: last.current, proposed: { kind: 'timeout', hard_kill: true } }
    };
  }
  return { verdict: 'inconclusive', reason: `hard kill: sandbox did not finish within ${HARD_KILL_MS} ms`, runs };
}

function finish(t0, fields) {
  const out = { ...fields, duration_ms: Number((performance.now() - t0).toFixed(3)) };
  out.applicable = out.verdict !== 'inconclusive';
  out.score = out.verdict === 'equivalent' ? 1 : out.verdict === 'divergent' ? 0 : 0.5;
  out.mismatches = out.verdict === 'divergent' ? 1 : 0;
  if (out.verdict === 'inconclusive' && !out.reason) out.reason = 'inconclusive';
  return out;
}

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
    cur = prepareFile(fileSrc, { start: at, end: at + currentSrc.length }, fileSrc);
    prop = prepareFile(proposedFile, { start: at, end: at + proposedSrc.length }, proposedFile);
    if (cur.parsed) {
      mode = 'file';
      if (!cur.targets.length && !prop.targets.length) {
        const snipCur = prepareSnippet(currentSrc), snipProp = prepareSnippet(proposedSrc);
        cur.targets = snipCur.targets.filter(t => t.kind === 'fn');
        prop.targets = snipProp.targets.filter(t => t.kind === 'fn');
      }
    }
  }
  if (mode === 'snippet') {
    cur = prepareSnippet(currentSrc);
    prop = prepareSnippet(proposedSrc);
  }

  const target = chooseTarget(cur.targets, prop.targets, functionName);
  if (!target) {
    return finish(t0, { verdict: 'inconclusive', reason: 'no callable function located in the edit', runs: 0, mode });
  }
  const k = arity || Math.min(Math.max(target.params, 1), 4);
  const inputs = buildInputs(k, runs);
  const desc = { kind: target.kind, name: target.name, className: target.className, isStatic: !!target.isStatic };

  const elapsed = performance.now() - t0;
  const res = execute({
    currentCode: cur.code,
    proposedCode: prop.code,
    target: desc,
    inputs: inputs.map(i => i.literal),
    callTimeoutMs: opts.callTimeoutMs || CALL_TIMEOUT_MS,
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    budgetMs: opts.budgetMs || BUDGET_MS,
    fileMode: mode === 'file'
  }, hardKillMs - elapsed);

  if (res.counterexample && Number.isInteger(res.counterexample.index)) {
    res.counterexample.args = jsonSafe(inputs[res.counterexample.index].args);
  }
  return finish(t0, { ...res, function_name: target.className ? `${target.className}.${target.name}` : target.name, arity: k, mode });
}

module.exports = { run, collectTargets, toLiteral, HARD_KILL_MS };
