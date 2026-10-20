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

const KEYWORDS = {
  javascript: new Set(('break case catch class const continue debugger default delete do else export extends finally for function if import in ' +
    'instanceof let new return super switch this throw try typeof var void while with yield await async of static get set true false null ' +
    'undefined NaN Infinity arguments').split(' ')),
  python: new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if ' +
    'import in is lambda nonlocal not or pass raise return try while with yield match case').split(' '))
};
const IDENT = /^[A-Za-z_$][\w$]*$/;

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
function jsUses(src, file, toks) {
  const { ast } = require('../validation/ast-checker').parseJs(src, file);
  if (!ast) return null;
  const want = new Map(toks.map(([s, e]) => [s, e]));
  const up = new Map();
  const found = [];
  const stack = [[ast.program, null, null, false]];
  while (stack.length) {
    const [n, p, k, bind] = stack.pop();
    up.set(n, [p, k]);
    if (n.type === 'Identifier' && !bind && want.get(n.start) === n.end) found.push(n);
    if (/^(?:Import|Export)\w*Specifier$|^TS|^JSX|TypeAnnotation$/.test(n.type)) continue;
    for (const key of Object.keys(n)) {
      if (AST_SKIP.has(key) || TYPE_KEYS.has(key)) continue;
      const noRef = (BINDS[n.type] || []).includes(key) || (n.type === 'UnaryExpression' && /^(?:typeof|delete)$/.test(n.operator)) ||
        (key === 'key' && !n.computed) || (key === 'local' || key === 'exported' || key === 'imported');
      const b = noRef || ((n.type === 'AssignmentPattern' && key === 'right') || (key === 'key' && n.computed) ? false : bind);
      for (const c of [].concat(n[key])) if (c && typeof c.type === 'string') stack.push([c, n, key, b]);
    }
  }
  const out = new Map();
  for (const n of found) {
    let u = n;
    let [p, k] = up.get(u);
    if (p.type === 'PrivateName') { u = p; [p, k] = up.get(u); }
    if (MEMBER.test(p.type) && k === 'property' && !p.computed) { u = p; [p, k] = up.get(u); }
    while (p && ((MEMBER.test(p.type) && k === 'object') || (CALL.test(p.type) && k === 'callee') || (p.type === 'TaggedTemplateExpression' && k === 'tag'))) {
      u = p;
      [p, k] = up.get(u);
    }
    const text = (x) => src.slice(x.start, x.end);
    let rep;
    if (p.type === 'ObjectProperty' && p.shorthand) rep = `${n.name}: ${JS_PERTURB(n.name)}`;
    else if (p.type === 'ExpressionStatement') rep = 'void 0';
    else if (CALL.test(u.type)) {
      const c = u.callee;
      const ns = !MEMBER.test(c.type) || /^(?:ThisExpression|Super)$/.test(c.object.type) || (c.object.type === 'Identifier' && /^[A-Z]/.test(c.object.name));
      const arg = u.arguments[0] && u.arguments[0].type !== 'SpreadElement' ? u.arguments[0] : null;
      const skip = ns ? arg : c.object;
      rep = skip ? `(${text(skip)})` : JS_PERTURB(text(u));
    } else rep = JS_PERTURB(text(u));
    out.set(n.start, { use: [u.start, u.end], text: rep });
  }
  return out;
}

// Python (ast, one python3 run): as jsUses, with offsets converted from
// UTF-8 columns. An `await` is part of the use it awaits.
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
for n in ast.walk(tree):
    for c in ast.iter_child_nodes(n):
        up[c] = n
    for a in (getattr(n, 'annotation', None), getattr(n, 'returns', None)):
        if isinstance(a, ast.expr):
            ann.update(ast.walk(a))
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
        if isinstance(p, (ast.Attribute, ast.Subscript)) and p.value is u and isinstance(p.ctx, ast.Load) or isinstance(p, ast.Call) and p.func is u or isinstance(p, ast.Await):
            u = p
        else:
            break
    skip = None
    if isinstance(u, ast.Call):
        f = u.func
        if isinstance(f, ast.Attribute) and not (isinstance(f.value, ast.Name) and (f.value.id in ('self', 'cls') or f.value.id[:1].isupper())):
            skip = span(f.value)
        elif u.args and not isinstance(u.args[0], ast.Starred):
            skip = span(u.args[0])
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
function insertedNames(src, before, h, lang) {
  const isName = (t) => IDENT.test(t) && !KEYWORDS[lang].has(t);
  const text = (from) => ([s, e]) => from.slice(s, e);
  const gaps = (h.gaps || []).map(g => ({ ins: g.ins, del: g.del.map(text(before)) }));
  const moved = new Set(gaps.flatMap(g => g.del));
  const swaps = gaps.every(g => g.ins.length === g.del.length && g.del.every(isName) && g.ins.map(text(src)).every(isName));
  const out = [];
  for (const g of gaps) {
    const del = g.del.filter(isName);
    g.ins.forEach(([s, e], k) => {
      const name = src.slice(s, e);
      if (!isName(name)) return;
      const was = del.length && !moved.has(name) ? (swaps ? g.del[k] : '') : null;
      out.push({ at: s, end: e, name, was });
    });
  }
  return out;
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
// An edit over EDIT_MAX_HUNKS hunks, EDIT_MAX_CHARS changed characters or
// EDIT_MAX_SITES sites in one hunk (or one too large to diff) gets no
// mutants and the result is marked `capped`; a Python parse or use check
// that did not finish within `timeoutMs` (default 10 s) gives none either,
// marked `unchecked`. Each mutant is parse-checked on the smallest statement
// around it (jsParseCheck / parsesPython), not the file. A reference with
// no parse-valid use-site mutant gives none, marked `unmutated_ref`.
// -> [{ mutation, src, line, hunk, site, ref?, revert? }] (site: the token's offset in src)
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
  const names = hunks.map(h => insertedNames(src, before || '', h, lang));
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
        const site = h.ranges[r][0];
        if (!sites.has(site)) sites.set(site, EDIT_OPS[lang].map(() => []));
        const l = sites.get(site)[oi];
        if (l.length < max) l.push({ op, m, hunk: hi, site });
      }
    });
    // Use sites: one per distinct use, plus one per replaced name.
    const refs = [];
    const seen = new Set();
    for (const t of names[hi]) {
      const u = uses.get(t.at);
      if (!u) continue;
      const base = { hunk: hi, site: t.at, ref: t.name, line: lineOf(t.at) };
      if (t.was === '') return Object.assign([], { unmutated_ref: { name: t.name, line: base.line, hunk: hi } });
      if (!seen.has(u.use.join(':'))) {
        seen.add(u.use.join(':'));
        refs.push({ ...base, mutation: 'use_site', edits: [[u.use[0], u.use[1] - u.use[0], u.text]], lo: u.use[0], hi: u.use[1] });
      }
      if (t.was) refs.push({ ...base, mutation: 'revert_reference', revert: true, edits: [[t.at, t.end - t.at, t.was]], lo: t.at, hi: t.end });
    }
    if (sites.size + refs.length > EDIT_MAX_SITES) return Object.assign([], { capped: true });
    needed.push(...refs);
    candidates.push(...refs.map(built => ({ built })));
    for (const perOp of sites.values()) {
      const order = [];
      for (let i = 0; perOp.some(l => l.length > i); i++) for (const l of perOp) if (l[i]) order.push(l[i]);
      candidates.push(...order.slice(0, max * 4));
    }
  }
  const build = (c) => {
    if (c.built) return c.built;
    const mut = mutateAt(src, code, c.op, c.m, lang);
    return mut && { ...mut, mutation: c.op.name, line: lineOf(c.m.index), hunk: c.hunk, site: c.site };
  };
  const key = (c) => `${c.site}${c.revert ? 'r' : ''}`;
  const kept = new Map();
  const out = [];
  const take = ({ edits, lo, hi, ...c }) => { kept.set(key(c), (kept.get(key(c)) || 0) + 1); out.push({ ...c, src: applyEdits(src, edits) }); };
  if (lang === 'python') {
    // One batch: every candidate, the first `max` that parse per site.
    const built = candidates.map(build).filter(Boolean);
    const ok = built.length ? parsesPython(src, built, lineOf, starts, timeoutMs) : [];
    if (!ok) return Object.assign([], { unchecked: true });
    built.forEach((c, i) => { if (ok[i] && (kept.get(key(c)) || 0) < max) take(c); });
  } else {
    const parses = jsParseCheck(src, file);
    for (const c of candidates) {
      const b = build(c);
      if (b && (kept.get(key(b)) || 0) < max && parses(b)) take(b);
    }
  }
  const lost = needed.find(n => !kept.has(key(n)));
  if (lost) return Object.assign([], { unmutated_ref: { name: lost.ref, line: lost.line, hunk: lost.hunk } });
  return out.sort((x, y) => x.hunk - y.hunk || x.site - y.site);
}

module.exports = { injectInto, syntheticNegatives, rescoreMutant, originalFileSrc, editMutants, changeHunks, MUTATIONS, MAX_MUTANTS, EDIT_MAX_HUNKS, EDIT_MAX_CHARS, EDIT_MAX_SITES };
