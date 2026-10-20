'use strict';

// AUDIT-21 H1 and C1 at unit level: which inserted tokens of an edit carry
// their own evidence in `bug-injector.editMutants` (a mutant whose site is
// that token, or a use-site mutant of that name). Each row is an edit and
// the tokens CLAUDE.md's per-token rule should judge. FINDING when
// editMutants returns mutants (no `uncovered` / `unmutated_ref` / `capped`
// flag: the hunk would stand on them) while a wanted token has none.
//
//   node audit/21/token-sites.js
//
// op:   the carrying token is an operator or keyword. It is not in the
//       fail-closed list (names, numbers, strings, literal parts, regex
//       atoms/flags), so a sibling's kill stands for it.
// mlit: the changed line is inside / closes a multi-line literal.
//       tokensOf starts at the line, not at the literal, so quotes in the
//       literal text pair up with code: the code between is one "string"
//       token, and any mutant inside it covers all of it.

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));
const { changeHunks } = require(path.join(__dirname, '..', '..', 'src', 'utils', 'hunks'));

const L = (...l) => l.join('\n');
const fn = (lang, body) => (lang === 'js' ? `function f(s, t, n, xs, k) {\n${body}\n}\n` : `def f(s, t, n, xs, k):\n${body}\n`);

// [label, lang, before, after, wanted tokens (text; the n-th occurrence in the after line(s) is the first one inserted), raw?]
const ROWS = [
  ['op JS unary - (O01)', 'js', "  return 'h:' + s.slice(0, 0x1000);", '  return "h:" + s.slice(-0x1000);', ['-']],
  ['op JS `in` (O03)', 'js', "  return 'has=' + (typeof T[k] === 'number');", '  return "has=" + (k in T);', ['in']],
  ['op JS `|` (O05)', 'js', "  return 'w=' + Math.trunc(n);", '  return "w=" + (n | 0);', ['|']],
  ['op JS `>>` (O06)', 'js', "  return 'h=' + Math.floor(n / 2);", '  return "h=" + (n >> 1);', ['>>']],
  ['op JS `>>>`', 'js', "  return 'u=' + Math.trunc(n);", '  return "u=" + (n >>> 0);', ['>>>']],
  ['op JS `??`', 'js', "  return 'q=' + (n || 1);", '  return "q=" + (n ?? 1);', ['??']],
  ['op JS `!`', 'js', "  return 'b=' + (s === '');", '  return "b=" + !(s === \'\');', ['!']],
  ['op JS `**=`', 'js', "  n *= 2;\n  return 'n=' + n;", '  n **= 2;\n  return "n=" + n;', ['**=']],
  ['op JS `null`', 'js', "  return 'j=' + JSON.stringify(xs);", '  return "j=" + JSON.stringify(xs, null);', ['null']],
  ['op Py `//` (O09)', 'py', "    return 'h=' + str(int(n / 2))", '    return "h=" + str(n // 2)', ['//']],
  ['op Py `-` slice (O12)', 'py', "    return 'f=' + str(xs[:100])", '    return "f=" + str(xs[-100:])', ['-']],
  ['op Py `**` (O14)', 'py', "    return 'sq=' + str(int(math.pow(n, 2)))", '    return "sq=" + str(n ** 2)', ['**']],
  ['op Py `not in`', 'py', "    return 'c=' + str(k in s)", '    return "c=" + str(k not in s)', ['not']],
  ['op Py `is`', 'py', "    return 'e=' + str(n == k)", '    return "e=" + str(n is k)', ['is']],
  ['op Py `None`', 'py', "    return 'w=' + s.split(' ')[0]", '    return "w=" + s.split(None)[0]', ['None']],
  ['mlit JS href="${}" line (M01)', 'js',
    L('function link(u, t) {', '  return `', '<a href="${String(u)}">${t}</a>', '`.trim();', '}', ''),
    L('function link(u, t) {', '  return `', '<a href="${String(u).slice(0, 0x800)}">${t}</a>', '`.trim();', '}', ''), ['slice', '0x800'], true],
  ['mlit JS template closing line (M02)', 'js',
    L('function card(t) {', '  return `', '<b>${t}</b>', '`.trim() + "!";', '}', 'function foot() { return `-`; }', ''),
    L('function card(t) {', '  return `', '<b>${t}</b>', '`.trim().slice(0, 0x1000) + "!";', '}', 'function foot() { return `-`; }', ''), ['slice', '0x1000'], true],
  ['mlit JS apostrophes in text (M03)', 'js',
    L('function clock(n) {', '  return `', "It's ${String(n)} o'clock", '`.trim();', '}', ''),
    L('function clock(n) {', '  return `', "It's ${String(n).normalize(\"NFKC\")} o'clock", '`.trim();', '}', ''), ['normalize'], true],
  ['mlit Py triple-quote closing line (M08)', 'py',
    L('def note(s):', '    return """', 'note:', '""".strip() + " " + str(s).expandtabs(4)', '', '', 'def foot():', '    """Footer."""', '    return "-"', ''),
    L('def note(s):', '    return """', 'note:', '""".strip() + " " + str(s).expandtabs(-4)', '', '', 'def foot():', '    """Footer."""', '    return "-"', ''), ['-'], true],
  ['mlit Py """ + "!" (M05 shape)', 'py',
    L('def banner(s):', '    return """', '== {} ==', '""".strip().format(s) + "!"', ''),
    L('def banner(s):', '    return """', '== {} ==', '""".strip().format(str(s)[:0x1000]) + "!"', ''), ['str', '0x1000'], true],
  ['control: M01 change on one line', 'js',
    L('function link(u, t) {', '  return `<a href="${String(u)}">${t}</a>`;', '}', ''),
    L('function link(u, t) {', '  return `<a href="${String(u).slice(0, 0x800)}">${t}</a>`;', '}', ''), ['slice', '0x800'], true],
  ['control: M02 change on one line', 'js',
    L('function card(t) {', '  return `<b>${t}</b>`.trim() + "!";', '}', 'function foot() { return `-`; }', ''),
    L('function card(t) {', '  return `<b>${t}</b>`.trim().slice(0, 0x1000) + "!";', '}', 'function foot() { return `-`; }', ''), ['slice', '0x1000'], true]
];

let findings = 0;
for (const [label, lang, b, a, want, raw] of ROWS) {
  const before = raw ? b : fn(lang, b), after = raw ? a : fn(lang, a);
  const file = lang === 'js' ? 'src/x.js' : 'app/x.py';
  const ms = editMutants(after, { file, before, max: 3 });
  const ins = changeHunks(before, after, file).flatMap(h => h.ranges);
  // A wanted token: an occurrence of its text inside the inserted ranges'
  // span (the first one not in `before` at the same place).
  const span = [Math.min(...ins.map(r => r[0])), Math.max(...ins.map(r => r[1]))];
  const at = (w) => {
    for (let i = after.indexOf(w, span[0]); i >= 0 && i < span[1]; i = after.indexOf(w, i + 1)) {
      if (!/[\w$]/.test(w[0]) || !/[\w$]/.test(after[i - 1] || '')) return i;
    }
    return -1;
  };
  const own = (w) => { const i = at(w); return ms.some(m => m.site === i || (m.ref === w && m.site === i)); };
  const flagged = ms.uncovered || ms.unmutated_ref || ms.capped || ms.unchecked;
  const missing = flagged ? [] : want.filter(w => !own(w));
  const control = /^control/.test(label);
  const bad = missing.length > 0;
  if (bad && !control) findings++;
  const tok = ins.map(([s, e]) => after.slice(s, e));
  const desc = flagged ? `stopped: ${ms.uncovered ? `uncovered=${JSON.stringify(ms.uncovered.text)}` : ms.unmutated_ref ? `unmutated_ref=${ms.unmutated_ref.name}` : 'capped/unchecked'}`
    : `mutants=[${ms.map(m => `${m.mutation}@${JSON.stringify(after.slice(m.site, m.site + 12).split(/\s/)[0])}`).join(', ')}]`;
  console.log(`${bad ? (control ? 'CTLFAIL' : 'FINDING') : 'ok     '} ${label.padEnd(38)} inserted=${JSON.stringify(tok).slice(0, 90)} ${desc}${missing.length ? `  no own site: ${missing.join(', ')}` : ''}`);
}
if (findings) {
  console.log(`FINDING: ${findings} edits stand on mutants that never touch the token carrying the change`);
  process.exit(1);
}
console.log('ok');
