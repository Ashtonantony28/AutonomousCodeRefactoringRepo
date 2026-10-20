'use strict';

// AUDIT-20 SG27 probe: the Python diff test hints a parameter `num` when it
// meets a module name bound once to a numeric constant (`module_nums`), and
// then builds only numbers (and None) for it. Each pair below changes
// behaviour only for a non-number argument. The twin is the same edit with
// the constant bound twice (so it is not in `module_nums`); the twin's
// verdict shows what the generator finds without the SG27 hint.
//   a  `flag == ENABLED`: bools never built
//   b  `ch * WIDTH`, WIDTH rebound at runtime through globals().update
//   c  `fmt % COUNT`: format strings never built
// Prints FINDING (exit 1) when a pair is `equivalent` while its twin is
// `divergent`. Diff-test level only: the executor bar still stops these
// edits end to end (audit/20/run.js H01, H02), so this is Medium.
//   node audit/20/py-num-hint.js

const diffTesting = require('../../src/validation/diff-testing');

const CASES = [
  { id: 'a', what: 'flag == ENABLED (bool input)', pre: 'ENABLED = 1\n',
    cur: 'def is_on(flag):\n    return flag == ENABLED\n', prop: 'def is_on(flag):\n    return flag == ENABLED and flag is not True\n' },
  { id: 'b', what: 'ch * WIDTH, WIDTH rebound via globals().update', pre: 'WIDTH = 2\n\n\ndef configure(**kw):\n    globals().update(kw)\n\n\n',
    cur: 'def rule(ch):\n    return ch * WIDTH\n', prop: 'def rule(ch):\n    return (ch * WIDTH)[:WIDTH]\n' },
  { id: 'c', what: 'fmt % COUNT (format-string input)', pre: 'COUNT = 3\n',
    cur: 'def render(fmt):\n    return fmt % COUNT\n', prop: 'def render(fmt):\n    return (fmt + 0) % COUNT\n' }
];

const twinPre = (pre) => pre.replace(/^(\w+) = (.+)$/m, '$1 = $2\n$1 = $2');

let findings = 0;
for (const c of CASES) {
  const run = (pre) => diffTesting.run({ currentSrc: c.cur, proposedSrc: c.prop, fileSrc: `"""m"""\n${pre}${c.cur}`, file: 'pkg/m.py' });
  const r = run(c.pre), t = run(twinPre(c.pre));
  const bad = r.verdict === 'equivalent' && t.verdict === 'divergent';
  if (bad) findings++;
  console.log(`${bad ? 'FINDING' : 'ok     '} ${c.id} ${c.what.padEnd(48)} module_nums: ${r.verdict}(runs=${r.runs})  twin (bound twice): ${t.verdict}(runs=${t.runs})${t.reason ? ` ${String(t.reason).slice(0, 60)}` : ''}`);
}
if (findings) {
  console.log(`FINDING: ${findings} divergences hidden by the module_nums numeric hint`);
  process.exit(1);
}
console.log('ok');
