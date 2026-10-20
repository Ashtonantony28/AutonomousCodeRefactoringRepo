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

// One mutant of an operator match -> { edits: [[at, deleted, inserted]],
// lo, hi } ([lo, hi]: the part of the original the change falls in) or null.
function mutateAt(src, code, op, m, lang) {
  const at = m.index;
  if (op.wrap) {
    const open = at + m[0].length - 1;
    const close = polyglot.matchBracket(code, open);
    if (close < 0) return null;
    return { edits: [[open + 1, 0, op.wrap[0]], [close, 0, op.wrap[1]]], lo: open + 1, hi: close };
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
    return { edits: [[from, j - from, 'not (' + src.slice(from, j).trimEnd() + ')']], lo: from, hi: j };
  }
  if (op.string) {
    if (IMPORT_BEFORE.test(code.slice(Math.max(0, at - 24), at))) return null;
    const end = at + m[0].length;
    if (lang === 'python' && (code[at - 1] === m[1] || code[end] === m[1])) return null; // triple quote
    return { edits: [[end - 1, 0, 'x']], lo: end - 1, hi: end - 1 };
  }
  return { edits: [[at, m[0].length, op.to(m[0])]], lo: at, hi: at + m[0].length };
}

// `text` (the original from offset `base`) with the edits applied.
function applyEdits(text, edits, base = 0) {
  let out = '', prev = 0;
  for (const [at, del, ins] of edits) { out += text.slice(prev, at - base) + ins; prev = at - base + del; }
  return out + text.slice(prev);
}

function parsesJs(src, file, baseErrors) {
  const { parseJs } = require('../validation/ast-checker');
  const r = parseJs(src, file);
  return !!r.ast && r.errors.length <= baseErrors;
}

const CHUNK_TYPES = /(?:Statement|Declaration)$|^(?:ClassMethod|ClassPrivateMethod|ClassProperty|ClassPrivateProperty|ObjectMethod)$/;
const AST_SKIP = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'errors', 'tokens', 'comments']);

// JS parse check of a mutant ({ edits, lo, hi }): on the smallest statement or
// class/object member (in a bare class/object) holding [lo, hi] that parses
// cleanly on its own (with the file's strictness), else on the whole file. Mutations add no newline and no
// context-dependent syntax, so a clean statement stays clean in place.
function jsParseCheck(src, file) {
  const { parseJs } = require('../validation/ast-checker');
  const full = parseJs(src, file);
  const base = full.errors.length;
  const nodes = [];
  if (full.ast) {
    const stack = [[full.ast.program, null]];
    while (stack.length) {
      const [node, up] = stack.pop();
      let here = up;
      if (CHUNK_TYPES.test(node.type) && node !== full.ast.program) {
        const wrap = /^Class/.test(node.type) ? ['class __M__ {\n', '\n}'] : node.type === 'ObjectMethod' ? ['({\n', '\n})'] : ['', ''];
        here = { start: node.start, end: node.end, up, wrap };
        nodes.push(here);
      }
      for (const k of Object.keys(node)) {
        if (AST_SKIP.has(k)) continue;
        const v = node[k];
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') stack.push([c, here]); } else if (v && typeof v.type === 'string') stack.push([v, here]);
      }
    }
  }
  nodes.sort((a, b) => a.start - b.start || b.end - a.end);
  const starts = nodes.map(n => n.start);
  const prog = full.ast && full.ast.program;
  const opts = {
    allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true,
    strictMode: !!prog && (prog.sourceType === 'module' || (prog.directives || []).some(d => d.value.value === 'use strict'))
  };
  const clean = new Map();
  const ok = (n, text) => { const r = parseJs(n.wrap[0] + text + n.wrap[1], file, false, opts); return !!r.ast && !r.errors.length; };
  return (mut) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= mut.lo) lo = mid + 1; else hi = mid; }
    let n = lo > 0 ? nodes[lo - 1] : null;
    while (n && !(n.start <= mut.lo && mut.hi <= n.end)) n = n.up;
    for (; n; n = n.up) {
      if (!clean.has(n)) clean.set(n, ok(n, src.slice(n.start, n.end)));
      if (clean.get(n)) return ok(n, applyEdits(src.slice(n.start, n.end), mut.edits, n.start));
    }
    return parsesJs(applyEdits(src, mut.edits), file, base);
  };
}

// Python parse check of many mutants in one python3 run: each on the
// smallest statement holding its changed lines that parses on its own (an
// indented one under `if 1:`), else on the whole file. -> booleans, or null
// when the check did not complete (timeout, no python3).
const PY_CHECK = `import ast, bisect, json, sys
req = json.load(sys.stdin)
src = req['src']
lines = src.split('\\n')
need = sorted({m[0] for m in req['muts']})
around = {}
if '\\r' not in src.replace('\\r\\n', ''):
    spans = []
    try:
        stack = list(ast.parse(src).body)
    except Exception:
        stack = []
    while stack:
        n = stack.pop()
        spans.append((min([n.lineno] + [d.lineno for d in getattr(n, 'decorator_list', [])]), n.end_lineno))
        for f in ('body', 'orelse', 'finalbody', 'handlers', 'cases'):
            for c in getattr(n, f, None) or ():
                stack.extend([c] if isinstance(c, ast.stmt) else getattr(c, 'body', []))
    for a, b in sorted(spans, key=lambda s: s[1] - s[0]):
        for k in range(bisect.bisect_left(need, a), bisect.bisect_right(need, b)):
            around.setdefault(need[k], []).append((a, b))
def parses(text):
    try:
        ast.parse(text)
        return True
    except Exception:
        return False
def wrap(ls):
    return ('if 1:\\n' if ls[0][:1] in (' ', '\\t') else '') + '\\n'.join(ls)
clean = {}
out = []
for l1, l2, text in req['muts']:
    mut = text.split('\\n')
    res = None
    for a, b in around.get(l1, ()):
        if b < l2:
            continue
        if (a, b) not in clean:
            clean[(a, b)] = parses(wrap(lines[a - 1:b]))
        if clean[(a, b)]:
            res = parses(wrap(lines[a - 1:l1 - 1] + mut + lines[l2:b]))
            break
    if res is None:
        res = parses('\\n'.join(lines[:l1 - 1] + mut + lines[l2:]))
    out.append(res)
print(json.dumps(out))
`;

function parsesPython(src, muts, lineOf, starts, timeoutMs = 10_000) {
  const payload = muts.map((m) => {
    const l1 = lineOf(m.lo), l2 = lineOf(m.hi);
    let e = src.indexOf('\n', m.hi);
    if (e < 0) e = src.length;
    return [l1, l2, applyEdits(src.slice(starts[l1 - 1], e), m.edits, starts[l1 - 1])];
  });
  const r = spawnSync('python3', ['-I', '-c', PY_CHECK], { input: JSON.stringify({ src, muts: payload }), encoding: 'utf8', timeout: Math.max(1, timeoutMs), maxBuffer: 16 * 1024 * 1024 });
  try {
    const ok = JSON.parse(r.stdout);
    return Array.isArray(ok) && ok.length === muts.length ? ok : null;
  } catch { return null; }
}

const EDIT_MAX_HUNKS = 16;
const EDIT_MAX_CHARS = 32_000;
const EDIT_MAX_SITES = 12;

// Up to `max` parse-valid mutants per site of `src` (the edited file): a
// site is one token the edit inserted or changed, and a mutant belongs to
// the site its operator match starts in. With `before` (the file before the
// edit) the hunks and their tokens come from a token diff, else [start, end)
// is one hunk and one site. Unchanged tokens, even on an edited line, are
// never mutated. Operators are taken round-robin, at most max * 4 candidates
// per site. An edit over EDIT_MAX_HUNKS hunks,
// EDIT_MAX_CHARS changed characters or EDIT_MAX_SITES sites in one hunk (or
// one too large to diff) gets no mutants and the result is marked `capped`;
// a Python parse check that did not finish within `timeoutMs` (default 10 s)
// gives none either, marked `unchecked`. Each mutant is parse-checked on the
// smallest statement around it (jsParseCheck / parsesPython), not the file.
// -> [{ mutation, src, line, hunk, site }] (site: the token's offset in src)
function editMutants(src, { start, end, file, max = MAX_MUTANTS, before, timeoutMs }) {
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
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    if (!h.ranges.length) continue;
    const lo = src.lastIndexOf('\n', Math.max(0, h.ranges[0][0] - 1)) + 1;
    const last = h.ranges[h.ranges.length - 1][1];
    let stop = src.indexOf('\n', Math.max(lo, last - 1));
    if (stop < 0) stop = src.length;
    // Per site (the inserted token a match starts in), per operator: up to max matches.
    const sites = new Map();
    EDIT_OPS[lang].forEach((op, oi) => {
      const re = new RegExp(op.re.source, op.re.flags);
      re.lastIndex = lo;
      let m, r = 0;
      while ((m = re.exec(code)) && m.index < stop) {
        if (m.index < lo) continue;
        const a = m.index, b = m.index + Math.max(1, m[0].length);
        while (r < h.ranges.length && h.ranges[r][1] <= a) r++;
        if (r >= h.ranges.length) break;
        if (!(a < h.ranges[r][1] && b > h.ranges[r][0])) continue;
        if (op.to && op.to(m[0]) === m[0]) continue;
        const site = h.ranges[r][0];
        if (!sites.has(site)) sites.set(site, EDIT_OPS[lang].map(() => []));
        const l = sites.get(site)[oi];
        if (l.length < max) l.push({ op, m, hunk: hi, site });
      }
    });
    if (sites.size > EDIT_MAX_SITES) return Object.assign([], { capped: true });
    for (const perOp of sites.values()) {
      const order = [];
      for (let i = 0; perOp.some(l => l.length > i); i++) for (const l of perOp) if (l[i]) order.push(l[i]);
      candidates.push(...order.slice(0, max * 4));
    }
  }
  const build = (c) => {
    const mut = mutateAt(src, code, c.op, c.m, lang);
    return mut && { ...mut, mutation: c.op.name, line: lineOf(c.m.index), hunk: c.hunk, site: c.site };
  };
  const kept = new Map();
  const out = [];
  const take = ({ edits, lo, hi, ...c }) => { kept.set(c.site, (kept.get(c.site) || 0) + 1); out.push({ ...c, src: applyEdits(src, edits) }); };
  if (lang === 'python') {
    // One batch: every candidate, the first `max` that parse per site.
    const built = candidates.map(build).filter(Boolean);
    const ok = built.length ? parsesPython(src, built, lineOf, starts, timeoutMs) : [];
    if (!ok) return Object.assign([], { unchecked: true });
    built.forEach((c, i) => { if (ok[i] && (kept.get(c.site) || 0) < max) take(c); });
  } else {
    const parses = jsParseCheck(src, file);
    for (const c of candidates) {
      if ((kept.get(c.site) || 0) >= max) continue;
      const b = build(c);
      if (b && parses(b)) take(b);
    }
  }
  return out.sort((x, y) => x.hunk - y.hunk || x.site - y.site);
}

module.exports = { injectInto, syntheticNegatives, rescoreMutant, originalFileSrc, editMutants, changeHunks, MUTATIONS, MAX_MUTANTS, EDIT_MAX_HUNKS, EDIT_MAX_CHARS, EDIT_MAX_SITES };
