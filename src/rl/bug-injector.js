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
const { changeHunks, lexView } = require('../utils/hunks');

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
// An arithmetic, bitwise, shift or power operator (or its compound
// assignment) -> another of the same arity.
const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*', '**': '*', '//': '/', '&': '|', '|': '&', '^': '&', '<<': '>>', '>>': '<<', '>>>': '>>', '++': '--', '--': '++' };
const arith = (t) => (t.length > 1 && t.endsWith('=') && ARITH[t.slice(0, -1)] ? `${ARITH[t.slice(0, -1)]}=` : ARITH[t]);
// A numeric literal of any spelling plus one (decimal; a Python float stays a float).
function bump(n, py) {
  const t = n.replace(/_/g, '');
  if (/[jJ]$/.test(t)) return `(${n} + 1)`;
  if (/^0[xob]|^\d+n?$/i.test(t)) {
    try { return String(BigInt(t.replace(/n$/, '')) + 1n) + (/n$/.test(t) ? 'n' : ''); } catch { return `(${n} + 1)`; }
  }
  const v = Number(t);
  if (!Number.isFinite(v)) return `(${n} + 1)`;
  const w = v + 1 === v ? v * 2 : v + 1;
  return String(w) + (py && Number.isInteger(w) && !/e/.test(String(w)) ? '.0' : '');
}
const EDIT_OPS = {
  javascript: [
    { name: 'negate_condition', re: /\b(?:if|while)\s*\(/g, wrap: ['!(', ')'] },
    { name: 'negate_equality', re: /===|!==|==|!=/g, to: swapper({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' }) },
    { name: 'flip_comparison', re: /(?<![<>=!-])(?:<=|>=|<|>)(?![<>=])/g, to: swapper({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { name: 'numeric_off_by_one', re: /(?<![\w.$])(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)(?![\w$])/g, to: (n) => bump(n, false) },
    { name: 'swap_logical', re: /&&|\|\||\?\?/g, to: swapper({ '&&': '||', '||': '&&', '??': '||' }) },
    { name: 'swap_arith', re: /\*\*=?|>>>=?|<<=?|>>=?|\+\+|--|(?<![&|])[&|](?![&|])=?|[-+*/%^]=?/g, to: arith },
    { name: 'drop_unary', re: /!(?!=)|~/g, to: () => '' },
    { name: 'negate_in', re: /\b(?:in|instanceof)\b/g, ast: 'binary' },
    { name: 'negate_ternary', re: /\?(?![.?])/g, ast: 'cond' },
    { name: 'null_value', re: /\bnull\b/g, to: () => '0' },
    { name: 'drop_await', re: /\bawait\s+/g, to: () => '' },
    { name: 'flip_boolean', re: /\b(?:true|false)\b/g, to: swapper({ true: 'false', false: 'true' }) },
    { name: 'drop_return', re: /\breturn[ \t]+(?=[^\s;}])/g, to: () => '' },
    { name: 'string_literal', re: /(['"]) *\1/g, string: true }
  ],
  python: [
    { name: 'negate_condition', re: /^[ \t]*(?:if|elif|while)[ \t]+/gm, pyCond: true },
    { name: 'negate_equality', re: /==|!=/g, to: swapper({ '==': '!=', '!=': '==' }) },
    { name: 'flip_comparison', re: /(?<![<>=!-])(?:<=|>=|<|>)(?![<>=])/g, to: swapper({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }) },
    { name: 'numeric_off_by_one', re: /(?<![\w.])(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)(?![\w])/g, to: (n) => bump(n, true) },
    { name: 'swap_logical', re: /\b(?:and|or)\b/g, to: swapper({ and: 'or', or: 'and' }) },
    { name: 'swap_arith', re: /\*\*=?|\/\/=?|<<=?|>>=?|-(?!>)=?|[+*/%&|^]=?/g, to: arith },
    { name: 'drop_unary', re: /~/g, to: () => '' },
    { name: 'negate_in', re: /\bnot\s+in\b|\bis\s+not\b|\bis\b|\bin\b/g, to: (t) => (/^not/.test(t) ? 'in' : /^is\s/.test(t) ? 'is' : t === 'is' ? 'is not' : 'not in') },
    { name: 'drop_not', re: /(?<!\bis\s+)\bnot\s+(?!in\b)/g, to: () => '' },
    { name: 'null_value', re: /\bNone\b/g, to: () => '0' },
    { name: 'drop_await', re: /\bawait\s+/g, to: () => '' },
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
function mutateAt(src, code, op, m, lang, nodes) {
  const at = m.index;
  if (op.ast) {
    const n = nodes()[op.ast].get(at);
    return n ? { edits: [[n[0], 0, '!('], [n[1], 0, ')']], lo: n[0], hi: n[1], wrap: n } : null;
  }
  if (op.wrap) {
    const open = at + m[0].length - 1;
    const close = polyglot.matchBracket(code, open);
    if (close < 0) return null;
    return { edits: [[open + 1, 0, op.wrap[0]], [close, 0, op.wrap[1]]], lo: open + 1, hi: close, wrap: [open + 1, close] };
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
    return { edits: [[from, j - from, 'not (' + src.slice(from, j).trimEnd() + ')']], lo: from, hi: j, wrap: [from, from + src.slice(from, j).trimEnd().length] };
  }
  if (op.string) {
    if (IMPORT_BEFORE.test(code.slice(Math.max(0, at - 24), at))) return null;
    const end = at + m[0].length;
    if (lang === 'python' && (code[at - 1] === m[1] || code[end] === m[1])) return null; // triple quote
    return { edits: [[end - 1, 0, 'x']], lo: end - 1, hi: end - 1, pad: end };
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

const KEYWORDS = {
  javascript: new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in ' +
    'instanceof let new return super switch this throw try typeof var void while with yield await async of static get set true false null').split(' ')),
  python: new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if ' +
    'import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '))
};
const IDENT = /^[A-Za-z_$][\w$]*$/;
const VALUES = /^(?:None|True|False|null|true|false)$/;

// ---------- Use sites of inserted references ----------
// An inserted identifier or member the edit reads is perturbed where the
// edit uses it, whatever binds it: its value (the identifier with its member
// / call chain) gets P below, a call is skipped (its receiver, else its
// first argument, takes its place), a call or read in statement position is
// dropped. Binding positions (declarations, parameters, assignment targets,
// keys, labels, imports) and type annotations are no use.
const JS_PERTURB = (u) => `((v) => { const p = (v) => typeof v === 'number' ? v + 1 : typeof v === 'bigint' ? v + 1n : typeof v === 'string' ? v + '~' : ` +
  "typeof v === 'boolean' ? !v : v == null ? 0 : Array.isArray(v) ? (v.length ? v.slice(0, -1) : [0]) : " +
  "typeof v === 'function' && !/^class\\b/.test(Function.prototype.toString.call(v)) ? function (...a) { return p(v.apply(this, a)); } : " +
  'v instanceof Promise ? v.then(p) : Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length ? Object.fromEntries(Object.entries(v).slice(0, -1)) : v; ' +
  `return p(v); })(${u})`;
const PY_PERTURB = (u) => '(lambda p, v: p(p, v))(lambda p, v: (not v) if type(v) is bool else v + 1 if type(v) in (int, float, complex) ' +
  'else v + "~" if type(v) is str else v + b"~" if type(v) is bytes else v[:-1] if type(v) in (list, tuple) and v else type(v)([0]) if type(v) in (list, tuple) ' +
  'else dict(list(v.items())[:-1]) if type(v) is dict and v else 0 if v is None ' +
  `else (lambda *a, **k: p(p, v(*a, **k))) if callable(v) and not isinstance(v, type) else v, ${u})`;

const BINDS = {
  VariableDeclarator: ['id'], FunctionDeclaration: ['id', 'params'], FunctionExpression: ['id', 'params'], ArrowFunctionExpression: ['params'],
  ObjectMethod: ['params'], ClassMethod: ['params'], ClassPrivateMethod: ['params'], ClassDeclaration: ['id'], ClassExpression: ['id'],
  CatchClause: ['param'], ForInStatement: ['left'], ForOfStatement: ['left'], AssignmentExpression: ['left'], UpdateExpression: ['argument'],
  LabeledStatement: ['label'], BreakStatement: ['label'], ContinueStatement: ['label'], MetaProperty: ['meta', 'property']
};
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'implements', 'predicate']);
const MEMBER = /^(?:Optional)?MemberExpression$/;
const CALL = /^(?:Optional)?CallExpression$|^NewExpression$/;

// JS (babel): `toks` ([s, e) of inserted identifiers) -> Map(s -> { use: [s, e],
// text }) for those the edit reads, or null when the file does not parse.
// The value of a read is the identifier with its member chain, up to a call:
// a called name (`f(x)`, `o.f(x)`, a namespace receiver `util.f(x)`) is
// that call, which is skipped: a value receiver takes its place, else (a
// plain function, `this`, a module or capitalised namespace) its first
// non-literal argument, else the call's value is perturbed. A namespace is
// never the replacement.
const LITERAL = /^(?:String|Numeric|Boolean|Null|BigInt|RegExp)Literal$/;
function jsUses(src, file, toks) {
  const { ast } = require('../validation/ast-checker').parseJs(src, file);
  if (!ast) return null;
  const want = new Map(toks.map(([s, e]) => [s, e]));
  const up = new Map();
  const found = [];
  const mods = new Set();
  const required = (x) => !!x && ((CALL.test(x.type) && x.callee.type === 'Identifier' && x.callee.name === 'require') || (MEMBER.test(x.type) && required(x.object)));
  const stack = [[ast.program, null, null, false]];
  while (stack.length) {
    const [n, p, k, bind] = stack.pop();
    up.set(n, [p, k]);
    if (n.type === 'Identifier' && !bind && want.get(n.start) === n.end) found.push(n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && required(n.init)) mods.add(n.id.name);
    if (/^Import(?:Default|Namespace)Specifier$/.test(n.type)) mods.add(n.local.name);
    if (/^(?:Import|Export)\w*Specifier$|^TS|^JSX|TypeAnnotation$/.test(n.type)) continue;
    for (const key of Object.keys(n)) {
      if (AST_SKIP.has(key) || TYPE_KEYS.has(key)) continue;
      const noRef = (BINDS[n.type] || []).includes(key) || (n.type === 'UnaryExpression' && /^(?:typeof|delete)$/.test(n.operator)) ||
        (key === 'key' && !n.computed) || (key === 'local' || key === 'exported' || key === 'imported');
      const b = noRef || ((n.type === 'AssignmentPattern' && key === 'right') || (key === 'key' && n.computed) ? false : bind);
      for (const c of [].concat(n[key])) if (c && typeof c.type === 'string') stack.push([c, n, key, b]);
    }
  }
  const text = (x) => src.slice(x.start, x.end);
  const callee = (x) => { const [p, k] = up.get(x); return CALL.test(p.type) && k === 'callee'; };
  const ns = (x) => {
    while (MEMBER.test(x.type)) x = x.object;
    return /^(?:ThisExpression|Super)$/.test(x.type) || (x.type === 'Identifier' && (mods.has(x.name) || /^[A-Z]/.test(x.name)));
  };
  const out = new Map();
  for (const n of found) {
    let u = n;
    let [p, k] = up.get(u);
    if (p.type === 'PrivateName') { u = p; [p, k] = up.get(u); }
    if (MEMBER.test(p.type) && k === 'property' && !p.computed) { u = p; [p, k] = up.get(u); }
    while (MEMBER.test(p.type) && k === 'object' && !callee(p)) { u = p; [p, k] = up.get(u); }
    let call = null;
    if (CALL.test(p.type) && k === 'callee') call = p;
    else if (MEMBER.test(p.type) && k === 'object' && callee(p) && ns(u)) call = up.get(p)[0];
    let rep;
    if (call) {
      u = call;
      const c = call.callee;
      const recv = MEMBER.test(c.type) && !ns(c.object) ? c.object : null;
      const args = [];
      for (const a of call.arguments) { if (a.type === 'SpreadElement') break; args.push(a); }
      const skip = recv || args.find(a => !LITERAL.test(a.type) && !(a.type === 'TemplateLiteral' && !a.expressions.length));
      rep = skip ? `(${text(skip)})` : JS_PERTURB(text(u));
    } else if (p.type === 'ObjectProperty' && p.shorthand) rep = `${n.name}: ${JS_PERTURB(n.name)}`;
    else if (p.type === 'TaggedTemplateExpression' && k === 'tag') { u = p; rep = JS_PERTURB(text(u)); } else rep = JS_PERTURB(text(u));
    if (up.get(u)[0].type === 'ExpressionStatement') rep = 'void 0';
    out.set(n.start, { use: [u.start, u.end], text: rep, ...(p.type === 'ObjectProperty' && p.shorthand ? { short: `${n.name}: ` } : {}) });
  }
  return out;
}

// JS operators a textual swap cannot negate -> { binary: Map(offset of an
// `in` / `instanceof` -> [s, e) of its expression), cond: Map(offset of a
// ternary `?` -> [s, e) of its test) }; empty when the file does not parse.
function jsNodes(src, file, code) {
  const out = { binary: new Map(), cond: new Map() };
  const { ast } = require('../validation/ast-checker').parseJs(src, file);
  const stack = ast ? [ast.program] : [];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'BinaryExpression' && (n.operator === 'in' || n.operator === 'instanceof')) out.binary.set(code.indexOf(n.operator, n.left.end), [n.start, n.end]);
    if (n.type === 'ConditionalExpression') out.cond.set(code.indexOf('?', n.test.end), [n.test.start, n.test.end]);
    for (const k of Object.keys(n)) {
      if (AST_SKIP.has(k)) continue;
      for (const c of [].concat(n[k])) if (c && typeof c.type === 'string') stack.push(c);
    }
  }
  return out;
}

// Python (ast, one python3 run): as jsUses, with offsets converted from
// UTF-8 columns. An `await` is part of the use it awaits; `self`, `cls`,
// imported and capitalised names are namespaces.
const PY_USES = `import ast, json, sys
req = json.load(sys.stdin)
src = req['src']
lines = src.split('\\n')
def u16(s):
    return len(s.encode('utf-16-le', 'surrogatepass')) // 2
starts = [0]
for l in lines:
    starts.append(starts[-1] + u16(l) + 1)
def off(ln, col):
    return starts[ln - 1] + u16(lines[ln - 1].encode('utf-8', 'surrogatepass')[:col].decode('utf-8', 'replace'))
def span(n):
    return [off(n.lineno, n.col_offset), off(n.end_lineno, n.end_col_offset)]
try:
    tree = ast.parse(src)
except Exception:
    print('null')
    sys.exit()
up = {}
ann = set()
mods = set()
for n in ast.walk(tree):
    for c in ast.iter_child_nodes(n):
        up[c] = n
    for a in (getattr(n, 'annotation', None), getattr(n, 'returns', None)):
        if isinstance(a, ast.expr):
            ann.update(ast.walk(a))
    if isinstance(n, (ast.Import, ast.ImportFrom)):
        for a in n.names:
            mods.add(a.asname or a.name.split('.')[0])
def callee(e):
    p = up.get(e)
    return isinstance(p, ast.Call) and p.func is e
def ns(e):
    while isinstance(e, ast.Attribute):
        e = e.value
    return isinstance(e, ast.Name) and (e.id in mods or e.id in ('self', 'cls') or e.id[:1].isupper())
want = {tuple(t) for t in req['toks']}
out = []
for n in ast.walk(tree):
    if n in ann or not isinstance(getattr(n, 'ctx', None), ast.Load):
        continue
    if isinstance(n, ast.Name):
        at = span(n)
    elif isinstance(n, ast.Attribute):
        e = off(n.end_lineno, n.end_col_offset)
        at = [e - len(n.attr), e]
    else:
        continue
    if tuple(at) not in want:
        continue
    u = n
    while True:
        p = up.get(u)
        if isinstance(p, (ast.Attribute, ast.Subscript)) and p.value is u and isinstance(p.ctx, ast.Load) and not callee(p):
            u = p
        else:
            break
    p = up.get(u)
    call = p if callee(u) else up.get(p) if isinstance(p, ast.Attribute) and p.value is u and callee(p) and ns(u) else None
    skip = None
    if call is not None:
        u = call
        f = call.func
        if isinstance(f, ast.Attribute) and not ns(f.value):
            skip = span(f.value)
        else:
            for a in call.args:
                if isinstance(a, ast.Starred):
                    break
                if not isinstance(a, ast.Constant):
                    skip = span(a)
                    break
    if isinstance(up.get(u), ast.Await):
        u = up[u]
    out.append([at[0], span(u), isinstance(up.get(u), ast.Expr), skip])
print(json.dumps(out))
`;
function pyUses(src, toks, timeoutMs = 10_000) {
  const r = spawnSync('python3', ['-I', '-c', PY_USES], { input: JSON.stringify({ src, toks }), encoding: 'utf8', timeout: Math.max(1, timeoutMs), maxBuffer: 16 * 1024 * 1024 });
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const text = ([s, e]) => src.slice(s, e);
  return new Map(rows.map(([at, use, stmt, skip]) => [at, { use, text: stmt ? 'None' : skip ? `(${text(skip)})` : PY_PERTURB(text(use)) }]));
}

// Inserted identifier tokens of a hunk the edit may read: [{ at, end, name, was }].
// `was` marks a replaced name (one not deleted anywhere in the hunk, in a
// stretch that deleted identifiers): the k-th deleted identifier of the
// stretch when every stretch of the hunk only swaps names one for one,
// else '' (a replacement in changed code: nothing reverts it alone).
// Tokens inside literals (`lit` / `blit`: starts in src / before) are no names.
function insertedNames(src, before, h, lang, lit, blit) {
  const isName = (t) => IDENT.test(t) && !KEYWORDS[lang].has(t);
  const text = (from, skip) => ([s, e]) => (skip.has(s) ? '' : from.slice(s, e));
  const gaps = (h.gaps || []).map(g => ({ ins: g.ins, del: g.del.map(text(before, blit)) }));
  const moved = new Set(gaps.flatMap(g => g.del));
  const swaps = gaps.every(g => g.ins.length === g.del.length && g.del.every(isName) && g.ins.map(text(src, lit)).every(isName));
  const out = [];
  for (const g of gaps) {
    const del = g.del.filter(isName);
    g.ins.forEach(([s, e], k) => {
      const name = text(src, lit)([s, e]);
      if (!isName(name)) return;
      const was = del.length && !moved.has(name) ? (swaps ? g.del[k] : '') : null;
      out.push({ at: s, end: e, name, was });
    });
  }
  return out;
}

// Literal sub-tokens of a lexView: Map(start -> { lit, kind: 'part' | 'atom' |
// 'flag' | 'delim', at: [s, e, textStart, textEnd] }).
function literalTokens(lits) {
  const out = new Map();
  for (const l of lits) {
    if (l.kind === 'regex') {
      out.set(l.s, { lit: l, kind: 'delim' });
      out.set(l.body[1], { lit: l, kind: 'delim' });
      for (const a of l.atoms) out.set(a[0], { lit: l, kind: 'atom', at: a });
      for (const a of l.flags) out.set(a[0], { lit: l, kind: 'flag', at: a });
    } else if (l.parts) for (const a of l.parts) out.set(a[0], { lit: l, kind: 'part', at: a });
  }
  return out;
}

// Mutant of a literal sub-token: 'x' appended to a template / f-string text
// part; a regex flag dropped, a quantifier's bound plus one, any other atom
// dropped (replaced by `(?!)` when that leaves no valid regex).
// -> { edits, lo, hi, pad } or null.
function literalMutant(src, t) {
  const [s, e, , te] = t.at;
  if (t.kind === 'part') return { mutation: 'string_literal', edits: [[te, 0, 'x']], lo: te, hi: te, pad: t.lit.e };
  const { body, flags } = t.lit;
  const flagText = src.slice(flags.length ? flags[0][0] : body[1] + 1, t.lit.e);
  const valid = (b, f) => { if (!b) return false; try { new RegExp(b, f); return true; } catch { return false; } };
  const rel = (x) => x - body[0];
  const bodyText = src.slice(body[0], body[1]);
  if (t.kind === 'flag') {
    const f = flagText.replace(src[s], '');
    return valid(bodyText, f) ? { mutation: 'regex_literal', edits: [[s, 1, '']], lo: s, hi: e } : null;
  }
  const quant = src.slice(s, e).match(/^\{(\d+)(,?)(\d*)\}(\??)$/);
  const bumped = quant && (quant[3] ? `{${quant[1]},${Number(quant[3]) + 1}}` : `{${Number(quant[1]) + 1}${quant[2]}}`) + quant[4];
  for (const ins of bumped ? [bumped] : ['', '(?!)']) {
    if (valid(bodyText.slice(0, rel(s)) + ins + bodyText.slice(rel(e)), flagText)) return { mutation: 'regex_literal', edits: [[s, e - s, ins]], lo: s, hi: e, pad: t.lit.e };
  }
  return null;
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
// per site. Every inserted identifier or member the edit reads is a site
// too (one use-site mutant, `ref`: see jsUses), and one that replaced
// another identifier in its stretch another (`revert`: the old name back).
// Template / f-string text parts and regex atoms and flags are sites of
// their own (literalMutant).
// Fail closed per token (with `before`): every inserted name, number,
// string, template / f-string text part and regex atom or flag must be
// covered: by a mutant of its own site, or inside the expression a use-site
// mutant perturbs (`cover`); a name with no read of its own (a binding, key
// or keyword argument) by a covered read of the same name. Since every site
// needs a kill and every mutant of a site covers the same tokens, a kill of
// each site covers each token. An inserted token nothing covers gives no
// mutants, marked `uncovered` ({ text, line, hunk }).
// An edit over EDIT_MAX_HUNKS hunks, EDIT_MAX_CHARS changed characters or
// EDIT_MAX_SITES sites in one hunk (or one too large to diff) gets no
// mutants and the result is marked `capped`; a Python parse or use check
// that did not finish within `timeoutMs` (default 10 s) gives none either,
// marked `unchecked`. Each mutant is parse-checked on the smallest statement
// around it (jsParseCheck / parsesPython), not the file. A reference with
// no parse-valid use-site mutant gives none, marked `unmutated_ref`.
// A mutant that adds text carries `sham`: src with the site's expression
// wrapped in redundant parentheses (at least as many characters as the
// mutant adds) and as many spaces added after the mutated code (after the
// literal, for one inside a literal), a behaviour-preserving control.
// -> [{ mutation, src, sham?, line, hunk, site, span, ref?, revert? }] (site: the token's offset in src; span: the range every mutant of the site changes)
function editMutants(src, { start, end, file, max = MAX_MUTANTS, before, timeoutMs }) {
  const lang = editLang(file);
  if (!lang || typeof src !== 'string') return [];
  const diffed = typeof before === 'string';
  const hunks = diffed ? changeHunks(before, src, file) : [{ ranges: [[start, end]] }];
  const changed = hunks.reduce((n, h) => n + h.ranges.reduce((m, [a, b]) => m + b - a, 0), 0);
  if (hunks.length > EDIT_MAX_HUNKS || changed > EDIT_MAX_CHARS || hunks.some(h => h.capped)) return Object.assign([], { capped: true });
  const view = lexView(src, lang);
  const code = view.code;
  const litToks = literalTokens(view.lits);
  const fQuotes = new Set(view.lits.filter(l => l.kind === 'fstring').map(l => l.q));
  const starts = [0];
  for (let k = src.indexOf('\n'); k >= 0; k = src.indexOf('\n', k + 1)) starts.push(k + 1);
  const lineOf = (i) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const blit = diffed ? new Set(literalTokens(lexView(before, lang).lits).keys()) : new Set();
  const names = hunks.map(h => insertedNames(src, before || '', h, lang, litToks, blit));
  const toks = names.flat().map(t => [t.at, t.end]);
  const uses = !toks.length ? new Map() : lang === 'python' ? pyUses(src, toks, timeoutMs) : jsUses(src, file, toks);
  if (!uses) return Object.assign([], { unchecked: true });
  const candidates = [];
  const needed = [];
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
        if ((op.string && fQuotes.has(a)) || (litToks.get(a) || {}).kind === 'delim') continue;
        const site = h.ranges[r][0];
        if (!sites.has(site)) sites.set(site, EDIT_OPS[lang].map(() => []));
        const l = sites.get(site)[oi];
        if (l.length < max) l.push({ op, m, hunk: hi, site });
      }
    });
    // Literal sub-token sites: one mutant each.
    const lits = [];
    for (const [a] of h.ranges) {
      const t = litToks.get(a);
      const mut = t && t.kind !== 'delim' && literalMutant(src, t);
      if (mut) lits.push({ ...mut, span: [a, t.at[1]], wrap: [t.lit.s, t.lit.e], hunk: hi, site: a, line: lineOf(a) });
    }
    // Use sites: one per distinct use, plus one per replaced name.
    const refs = [];
    const seen = new Set();
    for (const t of names[hi]) {
      const u = uses.get(t.at);
      if (!u) continue;
      const base = { hunk: hi, site: t.at, ref: t.name, line: lineOf(t.at), wrap: u.short ? [...u.use, u.short] : u.use };
      if (t.was === '') return Object.assign([], { unmutated_ref: { name: t.name, line: base.line, hunk: hi } });
      if (!seen.has(u.use.join(':'))) {
        seen.add(u.use.join(':'));
        refs.push({ ...base, mutation: 'use_site', span: u.use, edits: [[u.use[0], u.use[1] - u.use[0], u.text]], lo: u.use[0], hi: u.use[1] });
      }
      if (t.was) refs.push({ ...base, mutation: 'revert_reference', revert: true, span: [t.at, t.end], edits: [[t.at, t.end - t.at, t.was]], lo: t.at, hi: t.end });
    }
    if (sites.size + lits.length + refs.length > EDIT_MAX_SITES) return Object.assign([], { capped: true });
    needed.push(...refs);
    candidates.push(...refs.map(built => ({ built })), ...lits.map(built => ({ built })));
    for (const perOp of sites.values()) {
      const order = [];
      for (let i = 0; perOp.some(l => l.length > i); i++) for (const l of perOp) if (l[i]) order.push(l[i]);
      candidates.push(...order.slice(0, max * 4));
    }
  }
  let jsn;
  const nodes = () => jsn || (jsn = jsNodes(src, file, code));
  const atom = new RegExp(String.raw`[A-Za-z_$][\w$]*|(?:\d|\.\d)(?:[\w.]|(?<=\d[eE])[+-])*`, 'y');
  // [s, e) of the expression atom (literal, bracket group, name, number) at i, or null.
  const litAt = new Map(view.lits.map(l => [l.s, l]));
  const atomAt = (i) => {
    const l = litAt.get(i);
    if (l) return [l.s, l.e];
    if ('([{'.includes(code[i])) { const e = polyglot.matchBracket(code, i); return e < 0 ? null : [i, e + 1]; }
    atom.lastIndex = i;
    const w = atom.exec(code);
    return w ? [i, i + w[0].length] : null;
  };
  // An operator match's sham wraps the match itself when it is an atom,
  // else its right operand, else the name before it.
  const atomNear = ([s, e]) => {
    const self = atomAt(s);
    if (self && self[1] === e && !(KEYWORDS[lang].has(src.slice(s, e)) && !VALUES.test(src.slice(s, e)))) return self;
    let i = e;
    while (code[i] === ' ' || code[i] === '\t') i++;
    const r = atomAt(i);
    if (r) return r;
    let j = s;
    while (code[j - 1] === ' ' || code[j - 1] === '\t') j--;
    let b = j;
    while (b > 0 && /[\w$]/.test(code[b - 1])) b--;
    return b < j ? [b, j] : null;
  };
  const build = (c) => {
    if (c.built) return c.built;
    const mut = mutateAt(src, code, c.op, c.m, lang, nodes);
    if (!mut) return null;
    const lit = c.op.string && view.lits.find(l => l.s <= c.m.index && c.m.index < l.e);
    const span = lit ? [lit.s, lit.e] : [c.m.index, c.m.index + c.m[0].length];
    return { wrap: atomNear(span), ...mut, span, mutation: c.op.name, line: lineOf(c.m.index), hunk: c.hunk, site: c.site };
  };
  // Sham edits of a mutant that adds text: its wrap in redundant parentheses
  // (as many characters as the mutant adds, or one more) and as many spaces
  // at `pad`. [] when it adds nothing, null when it has no wrap.
  const shamOf = ({ edits, hi, pad = hi, wrap }) => {
    const grow = edits.reduce((n, [, del, ins]) => n + ins.length - del, 0);
    if (grow <= 0) return [];
    if (!wrap) return null;
    const [a, e, pre = ''] = wrap;
    const n = Math.max(1, grow - pre.length), k = Math.ceil(n / 2);
    // Past 16 characters (parsers cap nesting) a number takes the rest: (10…0, x) / (10…0, x)[1].
    const [open, close] = n <= 16 ? ['('.repeat(k), ')'.repeat(k)]
      : lang === 'python' ? [`(1${'0'.repeat(Math.max(0, n - 7))},`, ')[1]'] : [`(1${'0'.repeat(Math.max(0, n - 4))},`, ')'];
    const parens = pre ? [[a, e - a, pre + open + src.slice(a, e) + close]] : [[a, 0, open], [e, 0, close]];
    return [...parens, [pad, 0, ' '.repeat(grow)]].sort((x, y) => x[0] - y[0]);
  };
  const shamMut = (edits) => ({ edits, lo: edits[0][0], hi: edits[edits.length - 1][0] });
  const key = (c) => `${c.site}${c.revert ? 'r' : ''}`;
  const kept = new Map();
  const out = [];
  const take = ({ edits, lo, hi, pad, wrap, ...c }, sham) => {
    kept.set(key(c), (kept.get(key(c)) || 0) + 1);
    out.push({ ...c, src: applyEdits(src, edits), ...(sham.length ? { sham: applyEdits(src, sham) } : {}) });
  };
  if (lang === 'python') {
    // One batch: every candidate and its sham, the first `max` per site where both parse.
    const built = candidates.map(build).filter(Boolean).map(b => [b, shamOf(b)]).filter(([, sh]) => sh);
    const batch = built.flatMap(([b, sh]) => (sh.length ? [b, shamMut(sh)] : [b]));
    const ok = batch.length ? parsesPython(src, batch, lineOf, starts, timeoutMs) : [];
    if (!ok) return Object.assign([], { unchecked: true });
    let i = 0;
    for (const [b, sh] of built) {
      const good = ok[i] && (!sh.length || ok[i + 1]);
      i += sh.length ? 2 : 1;
      if (good && (kept.get(key(b)) || 0) < max) take(b, sh);
    }
  } else {
    const parses = jsParseCheck(src, file);
    for (const c of candidates) {
      const b = build(c);
      const sh = b && shamOf(b);
      if (sh && (kept.get(key(b)) || 0) < max && parses(b) && (!sh.length || parses(shamMut(sh)))) take(b, sh);
    }
  }
  const lost = needed.find(n => !kept.has(key(n)));
  if (lost) return Object.assign([], { unmutated_ref: { name: lost.ref, line: lost.line, hunk: lost.hunk } });
  const bare = diffed && uncoveredToken(src, hunks, out, names, litToks);
  if (bare) return Object.assign([], { uncovered: { ...bare, line: lineOf(bare.at) } });
  return out.sort((x, y) => x.hunk - y.hunk || x.site - y.site);
}

// The first inserted token other than punctuation (brackets, commas,
// semicolons, colons, regex delimiters) and whitespace that no mutant covers
// -> { text, at, hunk }, or null. A site covers the span every one of its
// mutants changes (the match, the literal token, the perturbed use).
const PUNCT = /^[()[\]{},;:]$/;
const BOUND = /^(?:=|const|let|var)$/;
function uncoveredToken(src, hunks, out, names, litToks) {
  const nameAt = new Set(names.flat().map(t => t.at));
  const spans = new Map();
  for (const m of out) {
    const k = `${m.site}${m.revert ? 'r' : ''}`, p = spans.get(k);
    spans.set(k, p ? [Math.max(p[0], m.span[0]), Math.min(p[1], m.span[1])] : m.span);
  }
  const covers = (a, b) => [...spans.values()].some(([s, e]) => s <= a && b <= e);
  const toks = [];
  hunks.forEach((h, hunk) => h.ranges.forEach(([a, b]) => {
    const text = src.slice(a, b), t = litToks.get(a);
    if (t ? t.kind === 'delim' : !text.trim() || PUNCT.test(text)) return;
    toks.push({ text, at: a, end: b, hunk, name: !t && nameAt.has(a), ok: covers(a, b) });
  }));
  const read = new Set(toks.filter(t => t.name && t.ok).map(t => t.text));
  for (const t of toks) if (t.name && !t.ok) t.ok = read.has(t.text);
  // `=` and `const` / `let` / `var` stand on the covered token right after them.
  for (let i = toks.length - 2; i >= 0; i--) {
    const t = toks[i], nx = toks[i + 1];
    if (!t.ok && BOUND.test(t.text) && nx.hunk === t.hunk && !src.slice(t.end, nx.at).trim()) t.ok = nx.ok;
  }
  const bad = toks.find(t => !t.ok && !t.name) || toks.find(t => !t.ok);
  return bad ? { text: bad.text, at: bad.at, hunk: bad.hunk } : null;
}

module.exports = { injectInto, syntheticNegatives, rescoreMutant, originalFileSrc, editMutants, changeHunks, MUTATIONS, MAX_MUTANTS, EDIT_MAX_HUNKS, EDIT_MAX_CHARS, EDIT_MAX_SITES };
