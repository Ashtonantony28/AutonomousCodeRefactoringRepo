'use strict';

// AUDIT-20 C1/C2/H1 at unit level: which inserted tokens get a site of their
// own in `bug-injector.editMutants`. Each row is a one-line edit; `want`
// names inserted reads/literals that CLAUDE.md says need their own kill.
// FINDING when the edit's mutants hold no site on those tokens (so a kill
// of another token, or of the whole string, stands for them).
//
//   node audit/20/token-sites.js

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));

const ROWS = [
  // [label, lang, before, after, wanted tokens (inserted reads / literals)]
  ['JS `${}` truncation (A01)', 'js', "  return `${t}` + ' (' + n + ')';", '  return `${String(t).slice(0, 4096)}` + " (" + n + ")";', ['String', '4096']],
  ['JS same, outside `${}` (control)', 'js', "  return t + ' (' + n + ')';", "  return String(t).slice(0, 4096) + ' (' + n + ')';", ['String', '4096']],
  ['Py f-string truncation (B01)', 'py', '    return f"{t} ({n})"', '    return f"{str(t)[:4096]} ({n})"', ['str', '4096']],
  ['Py same, str.format (control)', 'py', '    return "{} ({})".format(t, n)', '    return "{} ({})".format(str(t)[:4096], n)', ['str', '4096']],
  ['JS Infinity read (C01)', 'js', "  return 'n=' + xs.flat().length;", '  return "n=" + xs.flat(Infinity).length;', ['Infinity']],
  ['JS undefined read', 'js', "  return 'n=' + xs.slice(1, -1).length;", '  return "n=" + xs.slice(1, undefined).length;', ['undefined']],
  ['JS hex literal (D01)', 'js', "  return 'id:' + s.slice(1);", '  return "id:" + s.slice(1, 0x1000);', ['0x1000']],
  ['JS exponent literal (D02)', 'js', "  return 'id:' + s.slice(1);", '  return "id:" + s.slice(1, 4e3);', ['4e3']],
  ['JS separator literal (D03)', 'js', "  return 'id:' + s.slice(1);", '  return "id:" + s.slice(1, 4_096);', ['4_096']],
  ['JS decimal literal (control)', 'js', "  return 'id:' + s.slice(1);", "  return 'id:' + s.slice(1, 4096);", ['4096']],
  ['JS regex flag g (D04)', 'js', "  return '> ' + s.replace(/\\t/, ' ');", '  return "> " + s.replace(/\\t/g, \' \');', ['g']],
  ['Py hex literal (D06)', 'py', "    return 'id:' + s[1:]", '    return "id:" + s[1:0x1000]', ['0x1000']],
  ['Py separator literal (D07)', 'py', "    return 'id:' + s[1:]", '    return "id:" + s[1:4_096]', ['4_096']]
];

const wrap = (lang, body) => (lang === 'js' ? `function f(s, t, n, xs) {\n${body}\n}\n` : `def f(s, t, n, xs):\n${body}\n`);

let findings = 0;
for (const [label, lang, b, a, want] of ROWS) {
  const before = wrap(lang, b), after = wrap(lang, a);
  const file = lang === 'js' ? 'src/x.js' : 'app/x.py';
  const ms = editMutants(after, { file, before, max: 3 });
  const sites = [...new Set(ms.map(m => m.site))];
  const tokOf = (site) => (after.slice(site).match(/^(?:`[^`]*`|f?"[^"]*"|'[^']*'|[\w.$]+|\S)/) || [''])[0];
  const covered = want.filter(w => ms.some(m => (m.ref === w) || tokOf(m.site) === w));
  const missing = want.filter(w => !covered.includes(w));
  const control = /control/.test(label);
  const bad = missing.length > 0 && !(ms.unmutated_ref);
  if (bad && !control) findings++;
  const desc = ms.unmutated_ref ? `unmutated_ref=${ms.unmutated_ref.name}` : `sites=${sites.length} [${ms.map(m => `${m.mutation}:${m.ref || tokOf(m.site)}`).join(', ')}]`;
  console.log(`${bad ? (control ? 'CTLFAIL' : 'FINDING') : 'ok     '} ${label.padEnd(36)} ${desc}${missing.length ? `  no own site: ${missing.join(', ')}` : ''}`);
}
if (findings) {
  console.log(`FINDING: ${findings} edits whose inserted reads/literals have no site of their own`);
  process.exit(1);
}
console.log('ok');
