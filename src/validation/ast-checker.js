'use strict';

const fs = require('fs');
const path = require('path');

let parser, traverse;
try { parser = require('@babel/parser'); } catch { parser = null; }
try { traverse = require('@babel/traverse').default; } catch { traverse = null; }
const polyglot = require('./polyglot-ast');

const PARSE_OPTS = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: ['jsx', 'typescript', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator']
};

function tryParse(src) {
  if (!parser) return null;
  try { return parser.parse(src, PARSE_OPTS); } catch { return null; }
}

function isJsLike(file) {
  return /\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(file);
}

// ---------- Function signature collection ----------

function collectFunctions(ast) {
  const out = [];
  if (!ast || !traverse) return out;
  try {
    traverse(ast, {
      FunctionDeclaration(p) {
        const name = p.node.id && p.node.id.name;
        if (name) out.push({ name, params: p.node.params.length, node: p.node });
      },
      VariableDeclarator(p) {
        const init = p.node.init;
        if (!init) return;
        if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') {
          const name = p.node.id && p.node.id.name;
          if (name) out.push({ name, params: init.params.length, node: init });
        }
      },
      ClassMethod(p) {
        const name = p.node.key && (p.node.key.name || p.node.key.value);
        if (name) out.push({ name, params: p.node.params.length, node: p.node, isMethod: true });
      },
      ObjectMethod(p) {
        const name = p.node.key && (p.node.key.name || p.node.key.value);
        if (name) out.push({ name, params: p.node.params.length, node: p.node, isMethod: true });
      }
    });
  } catch { /* ignore traversal errors */ }
  return out;
}

function checkSignatureDrift({ currentAst, proposedAst, repoRoot }) {
  const cur = collectFunctions(currentAst);
  const prop = collectFunctions(proposedAst);
  const drift = [];
  for (const c of cur) {
    const match = prop.find(p => p.name === c.name);
    if (match && match.params !== c.params) {
      drift.push({ name: c.name, before: c.params, after: match.params });
    }
  }
  if (drift.length === 0) {
    return { check_name: 'signature_drift', passed: true, detail: 'no signature changes detected' };
  }
  // Look for callsites of drifted functions across repo
  const callsiteHits = [];
  if (repoRoot) {
    const names = new Set(drift.map(d => d.name));
    const filesToScan = collectRepoFiles(repoRoot, 200);
    for (const f of filesToScan) {
      const src = safeRead(f);
      if (!src) continue;
      for (const n of names) {
        const re = new RegExp(`\\b${escapeRegExp(n)}\\s*\\(`, 'g');
        if (re.test(src)) callsiteHits.push({ name: n, file: path.relative(repoRoot, f) });
      }
    }
  }
  const detail = drift.map(d => `${d.name}: ${d.before}→${d.after} args`).join('; ')
    + (callsiteHits.length ? `; ${callsiteHits.length} callsite(s) potentially affected` : '');
  return { check_name: 'signature_drift', passed: callsiteHits.length === 0, detail };
}

// ---------- Error handling removal ----------

function countTryCatch(src) {
  if (!src) return 0;
  let n = 0;
  const tryRe = /\btry\s*\{/g;
  while (tryRe.exec(src)) n++;
  const catchRe = /\.catch\s*\(/g;
  while (catchRe.exec(src)) n++;
  return n;
}

function checkErrorHandlingRemoval({ currentSrc, proposedSrc }) {
  const before = countTryCatch(currentSrc);
  const after = countTryCatch(proposedSrc);
  if (before > 0 && after < before) {
    return {
      check_name: 'error_handling_removal',
      passed: false,
      detail: `try/catch or .catch() count went from ${before} to ${after}`
    };
  }
  return { check_name: 'error_handling_removal', passed: true, detail: `before=${before} after=${after}` };
}

// ---------- New dependency introduced ----------

function collectImports(ast) {
  const out = new Set();
  if (!ast || !traverse) return out;
  try {
    traverse(ast, {
      ImportDeclaration(p) { if (p.node.source) out.add(p.node.source.value); },
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee && callee.name === 'require' && p.node.arguments[0] && p.node.arguments[0].type === 'StringLiteral') {
          out.add(p.node.arguments[0].value);
        }
      }
    });
  } catch { /* */ }
  return out;
}

function loadPackageJson(repoRoot) {
  if (!repoRoot) return null;
  const p = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function isExternal(name) {
  if (!name) return false;
  if (name.startsWith('.') || name.startsWith('/')) return false;
  if (name.startsWith('node:')) return false;
  return true;
}

function checkNewDependency({ currentAst, proposedAst, repoRoot }) {
  const before = collectImports(currentAst);
  const after = collectImports(proposedAst);
  const added = [...after].filter(x => !before.has(x) && isExternal(x));
  if (added.length === 0) {
    return { check_name: 'new_dependency', passed: true, detail: 'no new external imports' };
  }
  const pkg = loadPackageJson(repoRoot) || {};
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
  ]);
  const missing = added.filter(a => {
    const root = a.startsWith('@') ? a.split('/').slice(0, 2).join('/') : a.split('/')[0];
    return !declared.has(root);
  });
  if (missing.length === 0) {
    return { check_name: 'new_dependency', passed: true, detail: `added imports declared in package.json: ${added.join(', ')}` };
  }
  return { check_name: 'new_dependency', passed: false, detail: `undeclared imports: ${missing.join(', ')}` };
}

// ---------- Return-type change ----------

function functionsAlwaysReturn(ast) {
  const out = new Map();
  if (!ast || !traverse) return out;
  const examine = (node, name) => {
    if (!node || !node.body || node.body.type !== 'BlockStatement') {
      out.set(name, { alwaysReturns: true, hasReturn: true });
      return;
    }
    let hasAny = false;
    let allPaths = true;
    const visit = (block) => {
      let returned = false;
      for (const stmt of block.body) {
        if (stmt.type === 'ReturnStatement' && stmt.argument) { hasAny = true; returned = true; }
        else if (stmt.type === 'ThrowStatement') { returned = true; }
        else if (stmt.type === 'IfStatement') {
          if (stmt.alternate && stmt.consequent && stmt.consequent.type === 'BlockStatement' && stmt.alternate.type === 'BlockStatement') {
            const a = visit(stmt.consequent);
            const b = visit(stmt.alternate);
            if (a && b) returned = true;
            if (a || b) hasAny = true;
          }
        } else if (stmt.type === 'BlockStatement') {
          if (visit(stmt)) returned = true;
        }
      }
      return returned;
    };
    allPaths = visit(node.body);
    if (!hasAny) allPaths = false;
    out.set(name, { alwaysReturns: allPaths, hasReturn: hasAny });
  };
  try {
    traverse(ast, {
      FunctionDeclaration(p) { if (p.node.id) examine(p.node, p.node.id.name); },
      VariableDeclarator(p) {
        const init = p.node.init;
        if (init && (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')) {
          if (p.node.id && p.node.id.name && init.body && init.body.type === 'BlockStatement') examine(init, p.node.id.name);
        }
      },
      ClassMethod(p) { if (p.node.key && p.node.key.name) examine(p.node, p.node.key.name); }
    });
  } catch { /* */ }
  return out;
}

function checkReturnTypeChange({ currentAst, proposedAst }) {
  const before = functionsAlwaysReturn(currentAst);
  const after = functionsAlwaysReturn(proposedAst);
  const regressed = [];
  for (const [name, b] of before.entries()) {
    if (!b.alwaysReturns || !b.hasReturn) continue;
    const a = after.get(name);
    if (!a) continue;
    if (a.hasReturn && !a.alwaysReturns) regressed.push(name);
  }
  if (regressed.length === 0) {
    return { check_name: 'return_type_change', passed: true, detail: 'all functions still return on all paths' };
  }
  return { check_name: 'return_type_change', passed: false, detail: `missing return path in: ${regressed.join(', ')}` };
}

// ---------- Helpers ----------

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function collectRepoFiles(root, maxFiles) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', 'coverage'].includes(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && isJsLike(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

// ---------- Main entry ----------

function runChecks({ proposal, repoRoot }) {
  const file = proposal.file;
  const fileAbs = path.join(repoRoot, file);
  const fullSrc = safeRead(fileAbs);
  const splicedSrc = fullSrc && fullSrc.includes(proposal.current_code)
    ? fullSrc.replace(proposal.current_code, proposal.proposed_code)
    : proposal.proposed_code;
  const baselineSrc = fullSrc || proposal.current_code;

  const checks = [];
  let lang = 'unknown';

  if (isJsLike(file)) {
    lang = 'javascript';
    const currentAst = tryParse(baselineSrc);
    const proposedAst = tryParse(splicedSrc);
    if (currentAst && proposedAst) {
      checks.push(checkSignatureDrift({ currentAst, proposedAst, repoRoot }));
      checks.push(checkNewDependency({ currentAst, proposedAst, repoRoot }));
      checks.push(checkReturnTypeChange({ currentAst, proposedAst }));
    } else {
      checks.push({ check_name: 'parse', passed: false, detail: 'failed to parse current or proposed code' });
    }
  } else if (polyglot.languageOf(file)) {
    const poly = polyglot.runChecks({ file, currentSrc: baselineSrc, proposedSrc: splicedSrc });
    if (poly) {
      lang = poly.lang;
      checks.push(...poly.checks);
    } else {
      checks.push({ check_name: 'parse', passed: false, detail: 'polyglot parser failed' });
    }
  }

  // Universal text-based error-handling check (catches removal even when AST
  // can't be built or when the change is local to the snippet).
  checks.push(checkErrorHandlingRemoval({ currentSrc: proposal.current_code, proposedSrc: proposal.proposed_code }));

  const passed = checks.filter(c => c.passed).length;
  const score = checks.length ? passed / checks.length : 0.5;
  return { checks, score, lang };
}

module.exports = {
  runChecks,
  checkSignatureDrift,
  checkErrorHandlingRemoval,
  checkNewDependency,
  checkReturnTypeChange,
  collectFunctions,
  collectImports,
  tryParse
};
