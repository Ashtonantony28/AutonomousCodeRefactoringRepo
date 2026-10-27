'use strict';

// AUDIT-35 at unit level: what `bug-injector.editMutants` asks the suite to
// kill for each shape, beside controls that stop (`uncovered_token`).
//
//   node audit/35/token-sites.js
//
// FINDING rows: the token that changes behaviour gets no `uncovered_token`
// and the hunk is judged only on other sites. ok rows stop (or are controls
// that stop). Pure functions on strings: no pipeline, API or state.

const path = require('path');
const { editMutants } = require(path.join(__dirname, '..', '..', 'src', 'rl', 'bug-injector'));

const L = (...l) => l.join('\n');

function info(file, before, after) {
  const m = editMutants(after, { file, before, max: 3 });
  const stopped = !!(m.uncovered || m.unmutated_ref || m.capped || m.unchecked || !m.length);
  const judged = [...m].map(x => `${x.mutation}${x.ref ? `(${x.ref})` : ''}:${after.slice(x.span[0], x.span[1]).slice(0, 14)}`);
  return { stopped, uncovered: m.uncovered && m.uncovered.text, unmutated: m.unmutated_ref && m.unmutated_ref.name, judged };
}

const JS = (body) => L("'use strict';", body, '');
const SLOPPY = (body) => L(body, '');
const ROWS = [
  // [label, file, before, after, expect: 'stop' | 'finding']
  // ---- keyword swaps outside BLOCK_KW (if|elif|else|while|for|do)
  ['kw JS `with (o)` -> `if (o)` (K01)', 'src/x.js',
    SLOPPY(L('var maxLen = 6000;', 'function f(s, o) {', '  var t = String(s).trim();', '  with (o || {}) t = t.slice(0, maxLen);', '  return t;', '}')),
    SLOPPY(L('var maxLen = 6000;', 'function f(s, o) {', '  var t = String(s).trim();', '  if (o || {}) t = t.slice(0, maxLen);', '  return t;', '}')), 'finding'],
  ['kw Python `with _LOCK:` -> `if _LOCK:` (K02)', 'app/x.py',
    L('import threading', '_LOCK = threading.Lock()', 'def f(s):', '    s = str(s)', '    with _LOCK:', '        s = s.strip()', '    return s', ''),
    L('import threading', '_LOCK = threading.Lock()', 'def f(s):', '    s = str(s)', '    if _LOCK:', '        s = s.strip()', '    return s', ''), 'finding'],
  ['kw JS `switch (c) { default: }` -> `if (c) { }`', 'src/x.js',
    JS(L('function f(s, c) {', '  let t = String(s);', '  switch (c) { default: t = t.trim(); }', '  return t;', '}')),
    JS(L('function f(s, c) {', '  let t = String(s);', '  if (c) { t = t.trim(); }', '  return t;', '}')), 'stop'],
  ['kw Python `try:` -> `if s:` (finally removed)', 'app/x.py',
    L('def f(s):', '    s = str(s)', '    try:', '        s = s.strip()', '    finally:', '        pass', '    return s', ''),
    L('def f(s):', '    s = str(s)', '    if s:', '        s = s.strip()', '    return s', ''), 'finding'],
  ['ctl JS `for…of` -> `for…in`', 'src/x.js',
    JS(L('function f(xs) {', '  let n = 0;', '  for (const c of xs) n += String(c).length;', '  return n;', '}')),
    JS(L('function f(xs) {', '  let n = 0;', '  for (const c in xs) n += String(c).length;', '  return n;', '}')), 'stop'],
  ['ctl Python `for` -> `while`', 'app/x.py',
    L('def f(xs):', '    n = 0', '    for c in xs:', '        n += 1', '    return n', ''),
    L('def f(xs):', '    n = 0', '    while c in xs:', '        n += 1', '    return n', ''), 'stop'],
  ['ctl JS `while` -> `if` (A31 K01, SG42)', 'src/x.js',
    JS(L('function f(s) {', '  let out = String(s);', '  while (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}')),
    JS(L('function f(s) {', '  let out = String(s);', '  if (out.length > 6000) out = out.slice(0, -1000);', '  return out;', '}')), 'stop'],
  // ---- commas
  ['sep JS trailing hole `[x]` -> `[x,,]` (S01)', 'src/x.js',
    JS(L('function f(s) {', '  const t = String(s);', '  return t.length > 6000 ? [t.slice(0, 6000)] : [t];', '}')),
    JS(L('function f(s) {', '  const t = String(s);', "  return t.length > 6000 ? [t.slice(0, 6000) + '',,] : [t];", '}')), 'finding'],
  ['sep JS trailing hole `[x]` -> `[x, ,]`', 'src/x.js',
    JS(L('function f(s) {', '  const t = String(s);', '  return t.length > 6000 ? [t.slice(0, 6000)] : [t];', '}')),
    JS(L('function f(s) {', '  const t = String(s);', "  return t.length > 6000 ? [t.slice(0, 6000) + '', ,] : [t];", '}')), 'finding'],
  ['sep JS inner hole beside an inserted sibling `[a, b]` -> `[a + \'\', , b]` (S03)', 'src/x.js',
    JS(L('function f(a, b) {', '  return [a, b];', '}')),
    JS(L('function f(a, b) {', "  return [a + '', , b];", '}')), 'finding'],
  ['ctl JS inner hole between kept tokens `[a, b]` -> `[a, , b]`', 'src/x.js',
    JS(L('function f(a, b) {', "  return [a + '', b];", '}')),
    JS(L('function f(a, b) {', "  return [a + '', , b];", '}')), 'stop'],
  ['sep JS splitting comma beside an inserted sibling `6000 - 1` -> `6000 | 0, - 1` (S02)', 'src/x.js',
    JS(L('function f(s) {', '  return String(s).slice(0, 6000 - 1);', '}')),
    JS(L('function f(s) {', '  return String(s).slice(0, 6000 | 0, - 1);', '}')), 'finding'],
  ['ctl JS splitting comma between kept tokens `6000 - 1` -> `6000, - 1` (A31 S04)', 'src/x.js',
    JS(L('function f(s) {', '  return String(s).slice(0, 6000 - 1);', '}')),
    JS(L('function f(s) {', "  return String(s).slice(0, 6000, - 1) + '';", '}')), 'stop'],
  ['sep Python splitting comma beside an inserted sibling `n - 1` -> `n | 0, - 1`', 'app/x.py',
    L('def f(s):', '    return str(s)[:max(6000 - 1, 0)]', ''),
    L('def f(s):', '    return str(s)[:max(6000 | 0, - 1, 0)]', ''), 'finding'],
  ['sep Python f-string `{x}` -> `{x,}` (S02)', 'app/x.py',
    L('def f(s):', '    s = str(s)', '    if len(s) > 6000:', '        return f"{s[:6000]}"', '    return s', ''),
    L('def f(s):', '    s = str(s)', '    if len(s) > 6000:', '        return f"{s[:6000] + \'\',}"', '    return s', ''), 'finding'],
  ['sep Python f-string `{x!r}` -> `{x,!r}`', 'app/x.py',
    L('def f(s):', '    return f"<{s[:6000]!r}>"', ''),
    L('def f(s):', '    return f"<{s[:6000] + \'\',!r}>"', ''), 'finding'],
  ['ctl Python statement-level `return x` -> `return x,`', 'app/x.py',
    L('def f(s):', '    return str(s)', ''),
    L('def f(s):', "    return str(s) + '',", ''), 'stop'],
  ['ctl Python `(lambda a, b: a)` -> `(lambda a, b: a,)`', 'app/x.py',
    L('def f(s):', '    g = (lambda a, b: a)', '    return g(s, 1)', ''),
    L('def f(s):', "    g = (lambda a, b: a + '',)", '    return g(s, 1)', ''), 'stop'],
  ['ctl Python lambda default `(lambda a=(1): a)` -> `(lambda a=(1,): a)`', 'app/x.py',
    L('def f(s):', '    g = (lambda a=(6000): a)', '    return str(s)[:g()]', ''),
    L('def f(s):', '    g = (lambda a=(6000,): a)', "    return str(s)[:g()[0] + 0]", ''), 'stop'],
  ['ctl Python subscript in f-string `{d[k]}` -> `{d[k,]}`', 'app/x.py',
    L('def f(d, k):', '    return f"{d[k]}"', ''),
    L('def f(d, k):', "    return f\"{d[k,]}\" + ''", ''), 'stop'],
  ['ctl Python `[(a), b]` -> `[(a,), b]` tuple in a list', 'app/x.py',
    L('def f(a, b):', '    return [(a), b]', ''),
    L('def f(a, b):', "    return [(a,), b + '']", ''), 'stop']
];

let bad = 0;
for (const [label, file, before, after, expect] of ROWS) {
  const i = info(file, before, after);
  let tag;
  if (expect === 'stop') tag = i.stopped ? 'ok     ' : 'FINDING';
  else tag = i.stopped ? 'ok     ' : 'FINDING';
  if (tag === 'FINDING') bad++;
  console.log(`${tag} ${label.padEnd(66)} ${i.stopped ? `stopped${i.uncovered ? ` uncovered=${JSON.stringify(i.uncovered)}` : ''}${i.unmutated ? ` unmutated_ref=${i.unmutated}` : ''}` : `judged on ${JSON.stringify(i.judged)}`}`);
}
process.exit(bad ? 1 : 0);
