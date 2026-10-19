'use strict';

// CriticGPT-style synthetic negatives (McAleese et al., 2024). For each
// proposal that PASSED tests, inject a deterministic bug into its
// proposed_code, re-score the mutant through the AST checks and the
// differential test, and emit a "should-have-been-rejected" training sample
// (weighted 0.5 in training). Enlarges the gate's negative class without
// paying for real test failures.
//
// Mutations are intentionally simple and *visible to a human reviewer*
// so they form genuine "obvious bug" negatives:
//   - off-by-one in numeric literal       (e.g., 0 -> 1, 10 -> 9)
//   - swap === / ==
//   - drop `await` (async correctness)
//   - flip a boolean literal
//   - delete a `return ` keyword
//   - remove a null/undefined guard
//
// Each mutation runs only when it actually changes the source.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractFeatures } = require('./features');
const polyglot = require('../validation/polyglot-ast');
const { appendSamples } = require('./collector');
const { runChecks } = require('../validation/ast-checker');
const diffTesting = require('../validation/diff-testing');

const MUTATIONS = [
  {
    name: 'numeric_off_by_one',
    apply(src) {
      return src.replace(/(\b)(\d{1,4})(\b)/, (m, a, n, b) => {
        const v = parseInt(n, 10);
        return a + (v + 1) + b;
      });
    }
  },
  {
    name: 'swap_strict_equal',
    apply(src) {
      if (src.includes('===')) return src.replace('===', '==');
      if (src.includes('==')) return src.replace(/([^=!])==([^=])/, '$1===$2');
      return src;
    }
  },
  {
    name: 'drop_await',
    apply(src) {
      return src.replace(/\bawait\s+/, '');
    }
  },
  {
    name: 'flip_boolean',
    apply(src) {
      if (src.includes('true')) return src.replace(/\btrue\b/, 'false');
      if (src.includes('false')) return src.replace(/\bfalse\b/, 'true');
      return src;
    }
  },
  {
    name: 'drop_return',
    apply(src) {
      return src.replace(/\breturn\s+/, '');
    }
  },
  {
    name: 'remove_null_guard',
    apply(src) {
      return src.replace(/\bif\s*\(\s*[A-Za-z_$][\w$]*\s*(?:===|!==|==|!=)\s*(?:null|undefined)\s*\)\s*(?:return[^;]*;|\{[^}]*\})/, '');
    }
  }
];

function injectInto(source) {
  const out = [];
  for (const m of MUTATIONS) {
    let next;
    try { next = m.apply(source); } catch { next = source; }
    if (next && next !== source) out.push({ mutation: m.name, mutated: next });
  }
  return out;
}

const MAX_MUTANTS = 3;
const JS_FILE = /\.(js|cjs|mjs)$/i;

// The file as it was before the parent edit: the target may already hold the
// proposed code (in-place executor), in which case the edit is undone in memory.
function originalFileSrc(proposal, repoRoot) {
  if (!repoRoot || !proposal.file) return undefined;
  let src;
  try { src = fs.readFileSync(path.resolve(repoRoot, proposal.file), 'utf8'); } catch { return undefined; }
  const cur = proposal.current_code || '';
  if (cur && src.includes(cur)) return src;
  const prop = proposal.proposed_code || '';
  if (prop && src.includes(prop)) return src.replace(prop, () => cur);
  return undefined;
}

// Re-score a mutant with the same non-LLM signals a real proposal gets:
// AST checks and a differential test of original vs mutant. No Claude calls.
function rescoreMutant(parent, mutated, { repoRoot, fileSrc }) {
  const mutant = {
    file: parent.file,
    current_code: parent.current_code || '',
    proposed_code: mutated,
    risk_estimate: parent.risk_estimate
  };
  let checks = [];
  try { checks = runChecks({ proposal: mutant, repoRoot }).checks; } catch { checks = []; }
  let dt = null;
  if (JS_FILE.test(parent.file || '') && mutant.current_code) {
    try { dt = diffTesting.run({ currentSrc: mutant.current_code, proposedSrc: mutated, fileSrc }); } catch { dt = null; }
  }
  return { checks, diff_test: dt };
}

// Given a passing proposal, emit up to MAX_MUTANTS synthetic "should-reject"
// samples. Features come from the mutant's real AST checks plus the parent's
// critic features; mutants the diff test shows equivalent to the original are
// dropped (not bugs). Persisted to the target's sample store unless
// persist: false.
function syntheticNegatives(proposal, targetRepo = null, opts = {}) {
  if (!proposal || !proposal.test_outcome || proposal.test_outcome.status !== 'passed') return [];
  const { repoRoot = targetRepo, persist = !!targetRepo, max = MAX_MUTANTS } = opts;
  const fileSrc = originalFileSrc(proposal, repoRoot);
  const out = [];
  for (const m of injectInto(proposal.proposed_code || '')) {
    if (out.length >= max) break;
    const { checks, diff_test } = rescoreMutant(proposal, m.mutated, { repoRoot, fileSrc });
    if (diff_test && diff_test.verdict === 'equivalent') continue;
    out.push({
      proposal_id: `${proposal.issue_id}::${m.mutation}`,
      target_repo: targetRepo,
      features: extractFeatures({
        critic_verdict: proposal.critic_verdict,
        pattern_check_results: checks,
        current_code: proposal.current_code || '',
        proposed_code: m.mutated,
        risk_estimate: proposal.risk_estimate
      }),
      label: 0,
      synthetic: true,
      mutation: m.mutation,
      timestamp: new Date().toISOString()
    });
  }
  if (persist && out.length) appendSamples(out, targetRepo);
  return out;
}

// ---------- Mutants of an applied edit (executor's test-sensitivity bar) ----------
// Operators run on the comment/string-blanked source, only inside the edited
// lines, and every mutant must still parse: a mutant that breaks the file is
// "killed" by any suite that loads it, which proves nothing.

const swapper = (map) => (m) => map[m];
const EDIT_OPS = {
  javascript: [
    { name: 'negate_condition', re: /\b(?:if|while)\s*\(/g, wrap: ['!(', ')'] },
    { name: 'negate_equality', re: /===|!==|==|!=/g, to: swapper({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' }) },
    { name: 'flip_comparison', re: /(?<![<>=!-])(?:<=|>=|<|>)(?![<>=])/g, to: swapper({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { name: 'numeric_off_by_one', re: /(?<![\w.$])\d+(?:\.\d+)?(?![\w.$])/g, to: (n) => String(Number(n) + 1) },
    { name: 'swap_logical', re: /&&|\|\|/g, to: swapper({ '&&': '||', '||': '&&' }) },
    { name: 'swap_arith', re: /(?<=\s)[+-](?=\s)/g, to: swapper({ '+': '-', '-': '+' }) },
    { name: 'flip_boolean', re: /\b(?:true|false)\b/g, to: swapper({ true: 'false', false: 'true' }) },
    { name: 'drop_return', re: /\breturn[ \t]+(?=[^\s;}])/g, to: () => '' },
    { name: 'string_literal', re: /(['"]) *\1/g, string: true }
  ],
  python: [
    { name: 'negate_condition', re: /^[ \t]*(?:if|elif|while)[ \t]+/gm, pyCond: true },
    { name: 'negate_equality', re: /==|!=/g, to: swapper({ '==': '!=', '!=': '==' }) },
    { name: 'flip_comparison', re: /(?<![<>=!-])(?:<=|>=|<|>)(?![<>=])/g, to: swapper({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { name: 'numeric_off_by_one', re: /(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g, to: (n) => String(Number(n) + 1) },
    { name: 'swap_logical', re: /\b(?:and|or)\b/g, to: swapper({ and: 'or', or: 'and' }) },
    { name: 'swap_arith', re: /(?<=\s)[+-](?=\s)/g, to: swapper({ '+': '-', '-': '+' }) },
    { name: 'flip_boolean', re: /\b(?:True|False)\b/g, to: swapper({ True: 'False', False: 'True' }) },
    { name: 'drop_return', re: /\breturn[ \t]+(?=\S)/g, to: () => '' },
    { name: 'string_literal', re: /(['"]) *\1/g, string: true }
  ]
};
const IMPORT_BEFORE = /(?:require\s*\(|\bimport\s*\(?|\bfrom|\bimport)\s*$/;

function editLang(file) {
  if (/\.(js|cjs|mjs|jsx)$/i.test(file || '')) return 'javascript';
  if (/\.py$/i.test(file || '')) return 'python';
  return null;
}

// One mutant per operator match inside [lo, hi) -> { mutation, src, at } or null.
function mutateAt(src, code, op, m, lang) {
  const at = m.index;
  if (op.wrap) {
    const open = at + m[0].length - 1;
    const close = polyglot.matchBracket(code, open);
    if (close < 0) return null;
    return src.slice(0, open + 1) + op.wrap[0] + src.slice(open + 1, close) + op.wrap[1] + src.slice(close);
  }
  if (op.pyCond) {
    const from = at + m[0].length;
    let depth = 0;
    let j = from;
    for (; j < code.length; j++) {
      const c = code[j];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (depth <= 0 && (c === ':' || c === '\n')) break;
    }
    if (code[j] !== ':' || j === from) return null;
    return src.slice(0, from) + 'not (' + src.slice(from, j).trimEnd() + ')' + src.slice(j);
  }
  if (op.string) {
    if (IMPORT_BEFORE.test(code.slice(Math.max(0, at - 24), at))) return null;
    const end = at + m[0].length;
    if (lang === 'python' && (code[at - 1] === m[1] || code[end] === m[1])) return null; // triple quote
    return src.slice(0, end - 1) + 'x' + src.slice(end - 1);
  }
  return src.slice(0, at) + op.to(m[0]) + src.slice(at + m[0].length);
}

function parsesJs(src, file, baseErrors) {
  const { parseJs } = require('../validation/ast-checker');
  const r = parseJs(src, file);
  return !!r.ast && r.errors.length <= baseErrors;
}

function parsesPython(srcs) {
  const script = 'import ast, json, sys\nout = []\nfor s in json.load(sys.stdin):\n    try:\n        ast.parse(s)\n        out.append(True)\n    except Exception:\n        out.append(False)\nprint(json.dumps(out))';
  const r = spawnSync('python3', ['-c', script], { input: JSON.stringify(srcs), encoding: 'utf8', timeout: 10_000 });
  try { return JSON.parse(r.stdout); } catch { return srcs.map(() => false); }
}

// Up to `max` parse-valid mutants of the changed characters [start, end) of
// `src` (the edited file) or, when no operator applies to them, of the rest of
// the lines holding them; operators taken round-robin.
// -> [{ mutation, src, line }]
function editMutants(src, { start, end, file, max = MAX_MUTANTS }) {
  const lang = editLang(file);
  if (!lang || typeof src !== 'string') return [];
  const lo = src.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let hi = src.indexOf('\n', Math.max(start, end - 1));
  if (hi < 0) hi = src.length;
  const code = polyglot.stripCode(src, lang);
  const inSpan = [];
  const onLines = [];
  for (const op of EDIT_OPS[lang]) {
    const span = [];
    const lines = [];
    const re = new RegExp(op.re.source, op.re.flags);
    let m;
    while ((m = re.exec(code)) && m.index < hi) {
      if (m.index < lo) continue;
      const mutated = mutateAt(src, code, op, m, lang);
      if (!mutated || mutated === src) continue;
      const mutant = { mutation: op.name, src: mutated, line: src.slice(0, m.index).split('\n').length };
      (m.index < end && m.index + m[0].length > start ? span : lines).push(mutant);
    }
    inSpan.push(span);
    onLines.push(lines);
  }
  const perOp = inSpan.some(l => l.length) ? inSpan : onLines;
  const order = [];
  for (let i = 0; perOp.some(l => l.length > i); i++) for (const l of perOp) if (l[i]) order.push(l[i]);
  const candidates = order.slice(0, max * 4);
  let ok;
  if (lang === 'python') ok = parsesPython(candidates.map(c => c.src));
  else {
    const { parseJs } = require('../validation/ast-checker');
    const base = parseJs(src, file).errors.length;
    ok = candidates.map(c => parsesJs(c.src, file, base));
  }
  return candidates.filter((c, i) => ok[i]).slice(0, max);
}

module.exports = { injectInto, syntheticNegatives, rescoreMutant, originalFileSrc, editMutants, MUTATIONS, MAX_MUTANTS };
