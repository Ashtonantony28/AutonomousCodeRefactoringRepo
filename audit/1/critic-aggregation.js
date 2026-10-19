'use strict';

// Critic jury aggregation lets a reviewer's certain "this changes behaviour"
// verdict be outvoted, and ignores concrete edge cases / hallucination flags.
//   node audit/1/critic-aggregation.js
// Expected: J1 and J2 rejected. Observed: both reach the executor (dry_run).

const { makeRepo, throughGate, summary, rm } = require('./lib');

const CUR = 'function isAdult(age) {\n  return age >= 18;\n}';
const PROP = 'function isAdult(age) {\n  return age > 18;\n}';
const SRC = `'use strict';\n${CUR}\nmodule.exports = { isAdult };\n`;

const v = (preserves, p, extra = {}) => ({ preserves_semantics: preserves, p_preserves: p, edge_cases: [], hallucination_flags: [], reasoning: 'r', ...extra });
const byPersona = (map) => ({ cacheTag }) => map[cacheTag.replace(/^critic-/, '').replace(/-retry$/, '')];

const juries = {
  'J1 strict reviewer certain of change (p=0), outvoted 2-1': byPersona({
    strict: v(false, 0, { edge_cases: ['isAdult(18) now returns false'] }),
    permissive: v(true, 1),
    security: v(true, 1)
  }),
  'J2 unanimous approve but every reviewer lists the breaking edge case': byPersona({
    strict: v(true, 0.9, { edge_cases: ['age === 18 now returns false'] }),
    permissive: v(true, 0.9, { edge_cases: ['boundary 18 changes'] }),
    security: v(true, 0.9, { edge_cases: ['18-year-olds lose access'], hallucination_flags: ['reasoning claims "no boundary change"'] })
  })
};

(async () => {
  for (const [name, critic] of Object.entries(juries)) {
    const repo = makeRepo({ 'src/age.js': SRC });
    try {
      const { proposal } = await throughGate({ repo, file: 'src/age.js', current: CUR, proposed: PROP, critic });
      const s = summary(proposal);
      const j = proposal.critic_verdict;
      console.log(`${name}\n  status=${s.status} combined=${s.combined} jury.p_preserves=${j.p_preserves} approval_rate=${j.agreement.approval_rate.toFixed(2)} dt=${s.diff_test} edge_cases=${JSON.stringify(j.edge_cases)}`);
    } finally { rm(repo); }
  }
})();
