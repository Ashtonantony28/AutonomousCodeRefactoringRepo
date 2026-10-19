'use strict';

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

let parser;
try { parser = require('@babel/parser'); } catch { parser = null; }
const polyglot = require('./polyglot-ast');

const JS_RE = /\.(js|jsx|mjs|cjs|ts|tsx)$/i;
const BUILTINS = new Set(builtinModules.flatMap(m => [m, m.split('/')[0]]));

function isJsLike(file) {
  return JS_RE.test(file);
}

function parseOptions(file, snippet) {
  const ts = /\.(ts|tsx)$/i.test(file || '');
  const plugins = ts ? ['typescript'] : ['jsx'];
  if (ts && /x$/i.test(file)) plugins.push('jsx');
  return {
    sourceType: 'unambiguous',
    errorRecovery: true,
    allowReturnOutsideFunction: snippet,
    allowAwaitOutsideFunction: snippet,
    allowSuperOutsideMethod: snippet,
    allowUndeclaredExports: true,
    allowNewTargetOutsideFunction: snippet,
    plugins
  };
}

// -> { ast, errors: string[] } on success (errors are the recovered ones),
//    { ast: null, errors: [msg], fatal: true } when the parser gives up.
function parseJs(src, file = 'x.js', snippet = false) {
  if (!parser) return { ast: null, errors: ['@babel/parser unavailable'], fatal: true };
  const opts = parseOptions(file, snippet);
  try {
    const ast = parser.parse(src, opts);
    return { ast, errors: (ast.errors || []).map(errorKey) };
  } catch (err) {
    if (snippet) {
      // Method fragments (`foo(a) { ... }`) only parse inside a class body.
      try {
        const ast = parser.parse(`class __Snippet__ {\n${src}\n}`, opts);
        if (!(ast.errors || []).length) return { ast, errors: [] };
      } catch { /* fall through */ }
    }
    return { ast: null, errors: [errorKey(err)], fatal: true };
  }
}

function errorKey(err) {
  return err.reasonCode || String(err.message || err).replace(/\s*\(\d+:\d+\)\s*$/, '');
}

function tryParse(src, file) {
  return parseJs(src, file).ast;
}

// ---------- AST walking ----------

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'errors', 'tokens', 'comments']);

// enter(node, parent, ctx) may return false (skip children) or a new ctx for children.
function walk(node, enter, parent = null, ctx = null) {
  if (!node || typeof node.type !== 'string') return;
  const next = enter(node, parent, ctx);
  if (next === false) return;
  const childCtx = next === undefined ? ctx : next;
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, enter, node, childCtx);
    } else if (v && typeof v.type === 'string') {
      walk(v, enter, node, childCtx);
    }
  }
}

const FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

function keyName(key, computed) {
  if (!key) return null;
  if (!computed && (key.type === 'Identifier' || key.type === 'PrivateName')) return key.type === 'PrivateName' ? `#${key.id.name}` : key.name;
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value);
  return null;
}

function memberText(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const obj = memberText(node.object);
    const prop = keyName(node.property, node.computed);
    return obj && prop ? `${obj}.${prop}` : null;
  }
  return null;
}

// ---------- Function collection ----------

// Returns [{ name, qname, callName, kind: 'function'|'method'|'constructor', params, node, start, end, isMethod, accessor }]
function collectFunctions(ast) {
  const out = [];
  if (!ast) return out;
  const push = (name, qname, callName, kind, fn, span, accessor = false) => {
    out.push({ name, qname, callName, kind, params: fn.params.length, node: fn, start: span.start, end: span.end, isMethod: kind !== 'function', accessor });
  };
  walk(ast, (node, parent, cls) => {
    switch (node.type) {
      case 'ClassDeclaration':
      case 'ClassExpression': {
        let name = node.id && node.id.name;
        if (!name && parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') name = parent.id.name;
        return name || '(anonymous class)';
      }
      case 'FunctionDeclaration':
        if (node.id) push(node.id.name, node.id.name, node.id.name, 'function', node, node);
        break;
      case 'VariableDeclarator':
        if (node.init && FN_TYPES.has(node.init.type) && node.id.type === 'Identifier') push(node.id.name, node.id.name, node.id.name, 'function', node.init, node);
        break;
      case 'AssignmentExpression':
        if (node.right && FN_TYPES.has(node.right.type) && node.left.type === 'MemberExpression') {
          const name = keyName(node.left.property, node.left.computed);
          const q = memberText(node.left);
          if (name && q) {
            const exported = /^(module\.)?exports\.[^.]+$/.test(q);
            push(name, q, name, exported ? 'function' : 'method', node.right, node);
          }
        }
        break;
      case 'ClassMethod':
      case 'ClassPrivateMethod':
      case 'TSDeclareMethod': {
        if (!node.params) break;
        const name = keyName(node.key, node.computed);
        if (!name) break;
        if (node.kind === 'constructor') push(cls, `${cls}.constructor`, cls, 'constructor', node, node);
        else push(name, `${cls}.${name}`, name, 'method', node, node, node.kind === 'get' || node.kind === 'set');
        break;
      }
      case 'ObjectMethod': {
        const name = keyName(node.key, node.computed);
        if (name) push(name, name, name, 'method', node, node, node.kind === 'get' || node.kind === 'set');
        break;
      }
      case 'ObjectProperty':
      case 'ClassProperty':
      case 'ClassPrivateProperty': {
        if (!node.value || !FN_TYPES.has(node.value.type)) break;
        const name = keyName(node.key, node.computed);
        if (name) push(name, node.type === 'ObjectProperty' ? name : `${cls}.${name}`, name, 'method', node.value, node);
        break;
      }
      default:
    }
    return undefined;
  }, null, '');
  return out;
}

function inRegion(fn, region, side) {
  if (!region) return true;
  const end = side === 'current' ? region.endCurrent : region.endProposed;
  return fn.start < Math.max(end, region.start + 1) && fn.end > region.start;
}

// Key by qualified name + occurrence index so same-named functions don't overwrite each other.
function keyFunctions(fns) {
  const seen = new Map();
  const out = new Map();
  for (const f of fns) {
    const i = seen.get(f.qname) || 0;
    seen.set(f.qname, i + 1);
    out.set(`${f.qname}#${i}`, f);
  }
  return out;
}

function pairFunctions(currentAst, proposedAst, region) {
  const curAll = collectFunctions(currentAst);
  const propAll = collectFunctions(proposedAst);
  const cur = keyFunctions(curAll.filter(f => inRegion(f, region, 'current')));
  const prop = keyFunctions(propAll.filter(f => inRegion(f, region, 'proposed')));
  const pairs = [];
  const removed = [];
  for (const [k, c] of cur) {
    if (prop.has(k)) pairs.push([c, prop.get(k)]);
    else if (!propAll.some(p => p.qname === c.qname)) removed.push(c);
  }
  const added = [...prop.values()].filter(p => !curAll.some(c => c.qname === p.qname));
  return { pairs, removed, added };
}

// ---------- Call sites ----------

function collectCalls(ast) {
  const out = [];
  if (!ast) return out;
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression' && node.type !== 'NewExpression') return;
    const callee = node.callee;
    const isNew = node.type === 'NewExpression';
    if (callee.type === 'Identifier') {
      out.push({ name: callee.name, member: false, isNew, start: node.start });
    } else if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
      const prop = keyName(callee.property, callee.computed);
      if ((prop === 'call' || prop === 'apply') && callee.object.type === 'Identifier') {
        out.push({ name: callee.object.name, member: false, isNew, start: node.start });
      } else if (prop) {
        out.push({ name: prop, member: true, isNew, start: node.start });
      }
    }
  });
  return out;
}

// Does a call match a drifted function? Plain functions/constructors are called
// by identifier (or as `ns.fn()` from a file that imports the module); methods by member access.
function callMatches(call, d, viaImport) {
  if (call.name !== d.callName) return false;
  if (d.kind === 'method') return call.member;
  if (d.kind === 'constructor') return call.isNew && (!call.member || viaImport);
  return !call.member || viaImport;
}

function importsTarget(fileAbs, sources, targetAbs) {
  const strip = (p) => p.replace(JS_RE, '');
  const target = strip(targetAbs);
  for (const s of sources) {
    if (!s.startsWith('.')) continue;
    const r = strip(path.resolve(path.dirname(fileAbs), s));
    if (r === target || path.join(r, 'index') === target) return true;
  }
  return false;
}

// Every quote-delimited run starting with '.' (tried at every quote, so a
// mis-paired quote cannot hide the next one): a superset of the relative
// module specifiers collectImports() finds, without a parse.
function relativeSpecifiers(src) {
  const out = [];
  for (const m of src.matchAll(/(['"`])(?=(\.[^'"`\n]*)\1)/g)) out.push(m[2]);
  return out;
}

// Lexical superset of the calls callMatches() accepts for `d` (comments may
// sit between the tokens), so a file without a match needs no parse.
const GAP = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
function callShapeRe(d) {
  const n = escapeRegExp(d.callName);
  if (d.kind === 'constructor') return new RegExp(`(?<![\\w$])${n}(?![\\w$])`); // `new C` needs no parens
  const computed = `\\[${GAP}(['"\`])${n}\\1${GAP}\\]`;
  const call = `${GAP}(?:\\?\\.${GAP})?\\(`;
  if (d.kind === 'method') return new RegExp(`(?:\\.${GAP}${n}(?![\\w$])|${computed})${call}`);
  return new RegExp(`(?:(?<![\\w$])${n}(?![\\w$])(?:${GAP}\\.${GAP}(?:call|apply)(?![\\w$]))?|${computed})${call}`);
}

function findCallSites({ drifted, proposedAst, region, repoRoot, file, fullSrc }) {
  const hits = [];
  const add = (d, where, count) => { if (count) hits.push({ name: d.callName, file: where, count }); };
  const fileLabel = file || '(edited file)';

  // Same file. With a splice, skip calls inside the edited region; in snippet-only
  // mode scan the on-disk file, skipping the old definition's own body.
  if (region) {
    const calls = collectCalls(proposedAst);
    for (const d of drifted) add(d, fileLabel, calls.filter(c => callMatches(c, d, false) && !(c.start >= region.start && c.start < region.endProposed)).length);
  } else if (fullSrc) {
    const { ast } = parseJs(fullSrc, file);
    if (ast) {
      const calls = collectCalls(ast);
      const defs = collectFunctions(ast);
      for (const d of drifted) {
        const own = defs.filter(f => f.qname === d.qname);
        add(d, fileLabel, calls.filter(c => callMatches(c, d, false) && !own.some(f => c.start >= f.start && c.start < f.end)).length);
      }
    }
  }

  if (!repoRoot) return hits;
  const targetAbs = file ? path.resolve(repoRoot, file) : null;
  const names = [...new Set(drifted.map(d => d.callName))];
  const nameRe = new RegExp(`(?<![\\w$])(?:${names.map(escapeRegExp).join('|')})(?![\\w$])`);
  // A plain function or constructor is only matched in files that import the
  // edited module, so files that do (lexically) are scanned first and, with
  // no method among the drifted, the others are not read further. A file is
  // parsed only when some drifted name appears in a call shape.
  const shapes = drifted.map(d => ({ d, re: callShapeRe(d) }));
  const importers = [], others = [];
  for (const f of polyglot.collectRepoFiles(repoRoot, polyglot.SCAN_MAX_WALK, JS_RE)) {
    if (f === targetAbs) continue;
    const src = polyglot.safeRead(f);
    if (!src || !nameRe.test(src)) continue;
    const imp = !targetAbs || importsTarget(f, relativeSpecifiers(src), targetAbs);
    if (!shapes.some(({ d, re }) => (imp || d.kind === 'method') && re.test(src))) continue;
    (imp ? importers : others).push({ f, src, imp });
  }
  let scanned = 0, bytes = 0;
  for (const { f, src, imp } of importers.concat(others)) {
    // One call site already fails the check; stop parsing.
    if (hits.length) { hits.stopped = true; break; }
    if (scanned >= CALL_SCAN_MAX_FILES || (scanned && bytes + src.length > CALL_SCAN_MAX_BYTES)) { hits.capped = true; break; }
    scanned++;
    bytes += src.length;
    const rel = path.relative(repoRoot, f);
    const parsed = parsedCalls(f, src);
    if (!parsed) {
      const stripped = polyglot.stripCode(src, 'javascript');
      for (const d of drifted) {
        if (d.kind !== 'method' && !imp) continue;
        const n = escapeRegExp(d.callName);
        const calls = (stripped.match(new RegExp(`(?<![\\w$])${n}\\s*\\(`, 'g')) || []).length;
        const defs = (stripped.match(new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\s*\\(`, 'g')) || []).length;
        add(d, rel, Math.max(0, calls - defs));
      }
    } else {
      const viaImport = targetAbs ? importsTarget(f, parsed.imports, targetAbs) : true;
      for (const d of drifted) {
        if (d.kind !== 'method' && !viaImport) continue;
        add(d, rel, parsed.calls.filter(c => callMatches(c, d, viaImport)).length);
      }
    }
  }
  return hits;
}

// Parse cache for call-site scans: per process (one run), keyed by path and
// validated by size + mtime, bounded in entries. The scan parses at most
// CALL_SCAN_MAX_FILES files and CALL_SCAN_MAX_BYTES of source.
const CALL_SCAN_MAX_FILES = 200;
const CALL_SCAN_MAX_BYTES = 2_000_000;
const PARSE_CACHE_MAX = 2000;
const parseCache = new Map();

function parsedCalls(f, src) {
  let key = null;
  try { const st = fs.statSync(f); key = `${st.size}:${st.mtimeMs}:${src.length}`; } catch { /* uncached */ }
  const hit = key && parseCache.get(f);
  if (hit && hit.key === key) return hit.value;
  const { ast } = parseJs(src, f);
  const value = ast ? { calls: collectCalls(ast), imports: [...collectImports(ast)] } : null;
  if (key) {
    parseCache.delete(f);
    parseCache.set(f, { key, value });
    if (parseCache.size > PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
  }
  return value;
}

function checkSignatureDrift({ currentAst, proposedAst, repoRoot, region = null, file = null, fullSrc = null }) {
  const { pairs, removed, added } = pairFunctions(currentAst, proposedAst, region);
  const drift = [];
  for (const [c, p] of pairs) {
    if (c.accessor || p.accessor) continue;
    if (c.params !== p.params) drift.push({ ...c, before: c.params, after: p.params });
  }
  for (const c of removed) if (!c.accessor) drift.push({ ...c, removed: true });
  if (drift.length === 0) {
    return { check_name: 'signature_drift', passed: true, severity: 'score', detail: 'no signature changes detected' };
  }
  const hits = findCallSites({ drifted: drift, proposedAst, region, repoRoot, file, fullSrc });
  const addedNames = added.map(a => a.qname).join(', ');
  const describe = (d) => d.removed
    ? `${d.qname} removed/renamed${addedNames ? ` (new: ${addedNames})` : ''}`
    : `${d.qname}: ${d.before}→${d.after} args`;
  const where = hits.map(h => `${h.name} in ${h.file} (${h.count})`).join(', ');
  const scan = hits.stopped ? ' (repo scan stops at the first call site)'
    : hits.capped ? ` (repo scan capped at ${CALL_SCAN_MAX_FILES} files / ${CALL_SCAN_MAX_BYTES / 1e6} MB calling the name; rest not checked)` : '';
  return {
    check_name: 'signature_drift',
    passed: hits.length === 0,
    severity: hits.length ? 'veto' : 'score',
    detail: `${drift.map(describe).join('; ')}; ${hits.length ? `call sites outside edit: ${where}` : 'no call sites outside edit'}${scan}`
  };
}

// ---------- Error handling removal ----------

function countErrorHandlingAst(ast) {
  let n = 0;
  walk(ast, (node) => {
    if (node.type === 'TryStatement' && node.handler) n++;
    else if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
      && (node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression')
      && keyName(node.callee.property, node.callee.computed) === 'catch') n++;
  });
  return n;
}

// Token-level fallback: strings and comments are blanked before matching.
function countTryCatch(src) {
  if (!src) return 0;
  const s = polyglot.stripCode(src, 'javascript');
  return (s.match(/\btry\s*\{/g) || []).length + (s.match(/\.\s*catch\s*\(/g) || []).length;
}

function errorHandlingResult(before, after, how) {
  if (before > 0 && after < before) {
    return { check_name: 'error_handling_removal', passed: false, severity: 'veto', detail: `try/catch or .catch() count went from ${before} to ${after} (${how})` };
  }
  return { check_name: 'error_handling_removal', passed: true, severity: 'score', detail: `before=${before} after=${after} (${how})` };
}

function checkErrorHandlingRemoval({ currentSrc, proposedSrc, currentAst, proposedAst }) {
  if (currentAst && proposedAst) return errorHandlingResult(countErrorHandlingAst(currentAst), countErrorHandlingAst(proposedAst), 'ast');
  const cur = currentAst ? null : parseJs(currentSrc || '', 'x.js', true).ast;
  const prop = proposedAst ? null : parseJs(proposedSrc || '', 'x.js', true).ast;
  const a = currentAst || cur;
  const b = proposedAst || prop;
  if (a && b) return errorHandlingResult(countErrorHandlingAst(a), countErrorHandlingAst(b), 'ast');
  return errorHandlingResult(countTryCatch(currentSrc), countTryCatch(proposedSrc), 'tokens');
}

// ---------- New dependency introduced ----------

function collectImports(ast) {
  const out = new Set();
  if (!ast) return out;
  const lit = (n) => n && (n.type === 'StringLiteral' ? n.value
    : n.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
  walk(ast, (node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (node.source) out.add(node.source.value);
        break;
      case 'ImportExpression':
        if (lit(node.source)) out.add(lit(node.source));
        break;
      case 'TSImportEqualsDeclaration':
        if (node.moduleReference && node.moduleReference.expression) out.add(node.moduleReference.expression.value);
        break;
      case 'CallExpression': {
        const callee = node.callee;
        const isReq = (callee.type === 'Identifier' && callee.name === 'require') || callee.type === 'Import'
          || (callee.type === 'MemberExpression' && memberText(callee) === 'require.resolve');
        if (isReq && lit(node.arguments[0])) out.add(lit(node.arguments[0]));
        break;
      }
      default:
    }
  });
  return out;
}

function loadPackageJson(dir) {
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

function declaredDeps(repoRoot, file) {
  const declared = new Set();
  const dirs = new Set([repoRoot]);
  if (repoRoot && file) {
    let d = path.dirname(path.resolve(repoRoot, file));
    const root = path.resolve(repoRoot);
    while (d.startsWith(root)) { dirs.add(d); if (d === root) break; d = path.dirname(d); }
  }
  for (const dir of dirs) {
    const pkg = loadPackageJson(dir) || {};
    if (pkg.name) declared.add(pkg.name);
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const n of Object.keys(pkg[k] || {})) declared.add(n);
    }
  }
  return declared;
}

function packageRoot(name) {
  return name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
}

function isExternal(name) {
  if (!name) return false;
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('#')) return false;
  if (name.startsWith('node:') || BUILTINS.has(name) || BUILTINS.has(packageRoot(name))) return false;
  return true;
}

function checkNewDependency({ currentAst, proposedAst, repoRoot, file = null }) {
  const before = collectImports(currentAst);
  const after = collectImports(proposedAst);
  const added = [...after].filter(x => !before.has(x) && isExternal(x));
  if (added.length === 0) {
    return { check_name: 'new_dependency', passed: true, severity: 'score', detail: 'no new external imports' };
  }
  const declared = declaredDeps(repoRoot, file);
  const missing = added.filter(a => !declared.has(packageRoot(a)));
  if (missing.length === 0) {
    return { check_name: 'new_dependency', passed: true, severity: 'score', detail: `added imports declared in package.json: ${added.join(', ')}` };
  }
  return { check_name: 'new_dependency', passed: false, severity: 'veto', detail: `undeclared imports: ${missing.join(', ')}` };
}

// ---------- Return-type change ----------

// Completion analysis over statements: can control fall off the end (normal),
// and which kinds of return are reachable. Nested functions are not entered.
function emptyFlow() { return { normal: true, ret: false, bare: false, brk: false, labels: new Set() }; }

function mergeFlow(into, r) {
  into.ret = into.ret || r.ret;
  into.bare = into.bare || r.bare;
  into.brk = into.brk || r.brk;
  for (const l of r.labels) into.labels.add(l);
}

function flowList(stmts) {
  const acc = emptyFlow();
  for (const s of stmts) {
    if (!acc.normal) break;
    const r = flowOf(s);
    mergeFlow(acc, r);
    acc.normal = r.normal;
  }
  return acc;
}

function isAlwaysTrue(test) {
  if (!test) return true;
  if (test.type === 'BooleanLiteral') return test.value === true;
  if (test.type === 'NumericLiteral') return test.value !== 0;
  return false;
}

function flowOf(s) {
  switch (s.type) {
    case 'BlockStatement':
    case 'StaticBlock':
      return flowList(s.body);
    case 'ReturnStatement':
      return { ...emptyFlow(), normal: false, ret: !!s.argument, bare: !s.argument };
    case 'ThrowStatement':
      return { ...emptyFlow(), normal: false };
    case 'BreakStatement': {
      const r = { ...emptyFlow(), normal: false };
      if (s.label) r.labels.add(s.label.name); else r.brk = true;
      return r;
    }
    case 'ContinueStatement':
      return { ...emptyFlow(), normal: false };
    case 'IfStatement': {
      const c = flowOf(s.consequent);
      const a = s.alternate ? flowOf(s.alternate) : emptyFlow();
      const r = emptyFlow();
      mergeFlow(r, c);
      mergeFlow(r, a);
      r.normal = c.normal || a.normal;
      return r;
    }
    case 'SwitchStatement': {
      const r = emptyFlow();
      let hasDefault = false;
      let anyBreak = false;
      let lastNormal = true;
      for (const cs of s.cases) {
        if (!cs.test) hasDefault = true;
        const res = flowList(cs.consequent);
        mergeFlow(r, res);
        anyBreak = anyBreak || res.brk;
        lastNormal = res.normal;
      }
      r.brk = false;
      r.normal = !hasDefault || anyBreak || lastNormal;
      return r;
    }
    case 'WhileStatement':
    case 'ForStatement':
    case 'DoWhileStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const b = flowOf(s.body);
      const r = emptyFlow();
      mergeFlow(r, b);
      const infinite = (s.type === 'WhileStatement' || s.type === 'ForStatement' || s.type === 'DoWhileStatement') && isAlwaysTrue(s.test);
      r.normal = !infinite || b.brk;
      r.brk = false;
      return r;
    }
    case 'LabeledStatement': {
      const r = flowOf(s.body);
      if (r.labels.has(s.label.name)) { r.labels.delete(s.label.name); r.normal = true; }
      return r;
    }
    case 'TryStatement': {
      const b = flowOf(s.block);
      const h = s.handler ? flowOf(s.handler.body) : null;
      const f = s.finalizer ? flowOf(s.finalizer) : null;
      const r = emptyFlow();
      mergeFlow(r, b);
      if (h) mergeFlow(r, h);
      if (f) mergeFlow(r, f);
      const normal = b.normal || (h ? h.normal : false);
      r.normal = f ? normal && f.normal : normal;
      return r;
    }
    case 'WithStatement':
      return flowOf(s.body);
    default:
      return emptyFlow();
  }
}

function returnInfo(fn) {
  if (!fn.body || fn.body.type !== 'BlockStatement') return { always: !!fn.body, hasValueReturn: !!fn.body };
  const r = flowOf(fn.body);
  return { always: !r.normal && !r.bare && r.ret, hasValueReturn: r.ret };
}

// Back-compat helper: Map(qname#i -> { alwaysReturns, hasReturn }).
function functionsAlwaysReturn(ast) {
  const out = new Map();
  for (const [k, f] of keyFunctions(collectFunctions(ast))) {
    const info = returnInfo(f.node);
    out.set(k, { alwaysReturns: info.always, hasReturn: info.hasValueReturn });
  }
  return out;
}

function checkReturnTypeChange({ currentAst, proposedAst, region = null }) {
  const { pairs } = pairFunctions(currentAst, proposedAst, region);
  const regressed = [];
  for (const [c, p] of pairs) {
    if (c.kind === 'constructor' || (c.accessor && c.node.kind === 'set')) continue;
    const b = returnInfo(c.node);
    if (!b.always) continue;
    const a = returnInfo(p.node);
    if (!a.always) regressed.push(`${c.qname} (${a.hasValueReturn ? 'a path no longer returns a value' : 'all returns removed'})`);
  }
  if (regressed.length === 0) {
    return { check_name: 'return_type_change', passed: true, severity: 'score', detail: 'all functions still return on all paths' };
  }
  return { check_name: 'return_type_change', passed: false, severity: 'veto', detail: `missing return path in: ${regressed.join(', ')}` };
}

// ---------- Parse check ----------

function checkParse(cur, prop) {
  if (prop.fatal && !cur.fatal) {
    return { check_name: 'parse', passed: false, severity: 'veto', detail: `proposed source does not parse: ${prop.errors[0]}` };
  }
  if (prop.fatal && cur.fatal) {
    return { check_name: 'parse', passed: false, severity: 'score', detail: `current and proposed sources both fail to parse: ${prop.errors[0]}` };
  }
  const remaining = new Map();
  for (const e of cur.errors) remaining.set(e, (remaining.get(e) || 0) + 1);
  const introduced = [];
  for (const e of prop.errors) {
    const n = remaining.get(e) || 0;
    if (n > 0) remaining.set(e, n - 1); else introduced.push(e);
  }
  if (introduced.length) {
    return { check_name: 'parse', passed: false, severity: 'veto', detail: `proposed source introduces ${introduced.length} syntax error(s): ${introduced.slice(0, 3).join('; ')}` };
  }
  return null;
}

// ---------- Splicing ----------

// Replace the first verbatim occurrence of currentCode. A replacer function is
// used so `$&`, `$'`, `` $` `` and `$1` in the proposed code stay literal.
function spliceSource(fullSrc, currentCode, proposedCode) {
  if (fullSrc == null) return { ok: false, reason: 'target file not readable' };
  if (!currentCode) return { ok: false, reason: 'current_code is empty' };
  const start = fullSrc.indexOf(currentCode);
  if (start < 0) return { ok: false, reason: 'current_code not found verbatim in file' };
  const src = fullSrc.replace(currentCode, () => proposedCode);
  let occurrences = 0;
  for (let i = start; i >= 0; i = fullSrc.indexOf(currentCode, i + 1)) occurrences++;
  return { ok: true, src, start, endCurrent: start + currentCode.length, endProposed: start + proposedCode.length, occurrences };
}

// ---------- Helpers ----------

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function withNote(check, note) {
  return note ? { ...check, detail: `${check.detail} ${note}` } : check;
}

// ---------- Main entry ----------

function runChecks({ proposal, repoRoot }) {
  const file = proposal.file;
  const currentCode = proposal.current_code || '';
  const proposedCode = proposal.proposed_code || '';
  const fullSrc = repoRoot ? polyglot.safeRead(path.join(repoRoot, file)) : null;
  const splice = spliceSource(fullSrc, currentCode, proposedCode);

  let baselineSrc, proposedSrc, region, note = '';
  if (splice.ok) {
    baselineSrc = fullSrc;
    proposedSrc = splice.src;
    region = { start: splice.start, endCurrent: splice.endCurrent, endProposed: splice.endProposed };
    if (splice.occurrences > 1) note = `[current_code occurs ${splice.occurrences} times; first occurrence checked]`;
  } else {
    baselineSrc = currentCode;
    proposedSrc = proposedCode;
    region = null;
    note = `[snippet-only: ${splice.reason}]`;
  }

  const checks = [];
  let lang = 'unknown';

  if (isJsLike(file)) {
    lang = 'javascript';
    const snippet = !splice.ok;
    const cur = parseJs(baselineSrc, file, snippet);
    const prop = parseJs(proposedSrc, file, snippet);
    const parseCheck = checkParse(cur, prop);
    if (parseCheck) checks.push(parseCheck);
    const currentAst = cur.ast;
    const proposedAst = prop.ast;
    if (currentAst && proposedAst) {
      const ctx = { currentAst, proposedAst, repoRoot, region, file, fullSrc: snippet ? fullSrc : null };
      checks.push(checkSignatureDrift(ctx));
      checks.push(checkNewDependency(ctx));
      checks.push(checkReturnTypeChange(ctx));
      checks.push(splice.ok
        ? checkErrorHandlingRemoval({ currentAst, proposedAst })
        : checkErrorHandlingRemoval({ currentSrc: currentCode, proposedSrc: proposedCode, currentAst, proposedAst }));
    } else {
      checks.push(checkErrorHandlingRemoval({ currentSrc: currentCode, proposedSrc: proposedCode }));
    }
  } else if (polyglot.languageOf(file)) {
    const poly = polyglot.runChecks({ file, currentSrc: baselineSrc, proposedSrc, repoRoot, region });
    if (poly) {
      lang = poly.lang;
      checks.push(...poly.checks);
    } else {
      checks.push({ check_name: 'parse', passed: false, severity: 'score', detail: 'polyglot parser failed' });
      checks.push(checkErrorHandlingRemoval({ currentSrc: currentCode, proposedSrc: proposedCode }));
    }
  } else {
    checks.push(errorHandlingResult(countTryCatch(currentCode), countTryCatch(proposedCode), 'tokens'));
  }

  const out = checks.map(c => withNote(c, note));
  const passed = out.filter(c => c.passed).length;
  const score = out.length ? passed / out.length : 0.5;
  return { checks: out, score, lang, splice: { ok: splice.ok, reason: splice.reason || null, occurrences: splice.occurrences || 0 } };
}

module.exports = {
  runChecks,
  spliceSource,
  parseJs,
  checkParse,
  checkSignatureDrift,
  checkErrorHandlingRemoval,
  checkNewDependency,
  checkReturnTypeChange,
  collectFunctions,
  collectImports,
  collectCalls,
  functionsAlwaysReturn,
  countTryCatch,
  tryParse,
  CALL_SCAN_MAX_FILES
};
