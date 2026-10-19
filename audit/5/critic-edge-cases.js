'use strict';

// Round-1 M3 re-check on an edit the diff test cannot see (it reports
// `equivalent`): the gate still ignores a certain dissent and concrete
// edge cases that describe the behaviour change.
//   node audit/5/critic-edge-cases.js
// FINDING when either jury reaches the executor.

const { makeRepo, throughGate, rm, line } = require('./lib');

const CUR = "function strip(p) {\n  return String(p).replace(/\\.\\.\\//g, '');\n}";
const PROP = "function strip(p) {\n  return String(p).replace('../', '');\n}";
const SRC = `'use strict';\n${CUR}\nmodule.exports = { strip };\n`;

const v = (preserves, p, reasoning, edge = []) => ({ preserves_semantics: preserves, p_preserves: p, edge_cases: edge, hallucination_flags: [], reasoning });
const byPersona = (map) => ({ cacheTag }) => map[cacheTag.replace(/^critic-/, '').replace(/-retry$/, '')];

const JURIES = {
  'K1 security reviewer certain of a traversal regression (p=0), outvoted 2-1': byPersona({
    strict: v(true, 0.9, 'same output for the tested paths'),
    permissive: v(true, 0.9, 'string replace is simpler'),
    security: v(false, 0, "only the first '../' is removed now", ["strip('../../etc') now returns '../etc'"])
  }),
  'K2 unanimous approve while every reviewer lists the breaking edge case': byPersona({
    strict: v(true, 0.8, 'mostly equivalent', ["inputs with two '../' differ"]),
    permissive: v(true, 0.85, 'cleaner', ["'../../x' now keeps one '../'"]),
    security: v(true, 0.7, 'acceptable', ['nested traversal no longer fully stripped'])
  })
};

(async () => {
  const quiet = console.log;
  let findings = 0;
  for (const [name, critic] of Object.entries(JURIES)) {
    const repo = makeRepo({ 'src/paths.js': SRC });
    console.log = () => {};
    let p;
    try { ({ proposal: p } = await throughGate({ repo, file: 'src/paths.js', current: CUR, proposed: PROP, critic })); } finally { console.log = quiet; rm(repo); }
    const j = p.critic_verdict;
    console.log(`${name}\n  ${line(p)} jury.p=${j.p_preserves} edge_cases=${JSON.stringify(j.edge_cases)}`);
    if (p.test_outcome.status === 'dry_run') { findings++; console.log('  FINDING: reaches the executor'); }
  }
  if (findings) { console.log(`FINDING: ${findings}`); process.exit(1); }
  console.log('ok');
})();
