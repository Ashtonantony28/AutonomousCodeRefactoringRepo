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
const { appendSamples, editId } = require('./collector');
const { runChecks } = require('../validation/ast-checker');
const diffTesting = require('../validation/diff-testing');
const { changeHunks } = require('../utils/hunks');

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
const DIFF_FILE = /\.(js|cjs|mjs|py)$/i;

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
  if (DIFF_FILE.test(parent.file || '') && mutant.current_code) {
    try { dt = diffTesting.run({ currentSrc: mutant.current_code, proposedSrc: mutated, fileSrc, file: parent.file }); } catch { dt = null; }
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
      edit_id: `${editId(proposal)}::${m.mutation}`,
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
// Operators run on the comment/string-blanked source, only on tokens the edit
// changed, and every mutant must still parse: a mutant that breaks the file is
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

const EDIT_MAX_HUNKS = 16;
const EDIT_MAX_CHARS = 32_000;

// Up to `max` parse-valid mutants per change hunk of `src` (the edited
// file), each of a token the edit inserted or changed: with `before` (the
// file before the edit) the hunks come from a token diff, else [start, end)
// is one hunk. Unchanged tokens, even on an edited line, are never mutated.
// Operators are taken round-robin, at most max * 4 candidates per hunk, built
// and parsed lazily. An edit over EDIT_MAX_HUNKS hunks or EDIT_MAX_CHARS
// changed characters (or one too large to diff) gets no mutants and the
// result is marked `capped`.
// -> [{ mutation, src, line, hunk }]
function editMutants(src, { start, end, file, max = MAX_MUTANTS, before }) {
  const lang = editLang(file);
  if (!lang || typeof src !== 'string') return [];
  const hunks = typeof before === 'string' ? changeHunks(before, src, file) : [{ ranges: [[start, end]] }];
  const changed = hunks.reduce((n, h) => n + h.ranges.reduce((m, [a, b]) => m + b - a, 0), 0);
  if (hunks.length > EDIT_MAX_HUNKS || changed > EDIT_MAX_CHARS || hunks.some(h => h.capped)) return Object.assign([], { capped: true });
  const code = polyglot.stripCode(src, lang);
  const starts = [0];
  for (let k = src.indexOf('\n'); k >= 0; k = src.indexOf('\n', k + 1)) starts.push(k + 1);
  const lineOf = (i) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const candidates = [];
  hunks.forEach((h, hi) => {
    if (!h.ranges.length) return;
    const lo = src.lastIndexOf('\n', Math.max(0, h.ranges[0][0] - 1)) + 1;
    const last = h.ranges[h.ranges.length - 1][1];
    let stop = src.indexOf('\n', Math.max(lo, last - 1));
    if (stop < 0) stop = src.length;
    const perOp = EDIT_OPS[lang].map((op) => {
      const out = [];
      const re = new RegExp(op.re.source, op.re.flags);
      re.lastIndex = lo;
      let m, r = 0;
      while (out.length < max * 4 && (m = re.exec(code)) && m.index < stop) {
        if (m.index < lo) continue;
        const a = m.index, b = m.index + Math.max(1, m[0].length);
        while (r < h.ranges.length && h.ranges[r][1] <= a) r++;
        if (r >= h.ranges.length) break;
        if (!(a < h.ranges[r][1] && b > h.ranges[r][0])) continue;
        if (op.to && op.to(m[0]) === m[0]) continue;
        out.push({ op, m, hunk: hi });
      }
      return out;
    });
    const order = [];
    for (let i = 0; perOp.some(l => l.length > i); i++) for (const l of perOp) if (l[i]) order.push(l[i]);
    candidates.push(...order.slice(0, max * 4));
  });
  const build = (c) => {
    const mutated = mutateAt(src, code, c.op, c.m, lang);
    return mutated ? { mutation: c.op.name, src: mutated, line: lineOf(c.m.index), hunk: c.hunk } : null;
  };
  const kept = new Map();
  const out = [];
  const take = (c) => { kept.set(c.hunk, (kept.get(c.hunk) || 0) + 1); out.push(c); };
  if (lang === 'python') {
    // Two batches: the first `max` per hunk, then the rest for hunks still short.
    const first = [], rest = [], seen = new Map();
    for (const c of candidates) { const k = seen.get(c.hunk) || 0; seen.set(c.hunk, k + 1); (k < max ? first : rest).push(c); }
    for (const batch of [first, rest]) {
      const built = batch.filter(c => (kept.get(c.hunk) || 0) < max).map(build).filter(Boolean);
      const ok = built.length ? parsesPython(built.map(c => c.src)) : [];
      built.forEach((c, i) => { if (ok[i] && (kept.get(c.hunk) || 0) < max) take(c); });
    }
  } else {
    const { parseJs } = require('../validation/ast-checker');
    const base = parseJs(src, file).errors.length;
    for (const c of candidates) {
      if ((kept.get(c.hunk) || 0) >= max) continue;
      const b = build(c);
      if (b && parsesJs(b.src, file, base)) take(b);
    }
  }
  return out.sort((x, y) => x.hunk - y.hunk);
}

module.exports = { injectInto, syntheticNegatives, rescoreMutant, originalFileSrc, editMutants, changeHunks, MUTATIONS, MAX_MUTANTS, EDIT_MAX_HUNKS, EDIT_MAX_CHARS };
