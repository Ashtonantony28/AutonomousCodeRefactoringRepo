'use strict';

// A proposal that fails ALL FOUR CLAUDE.md anti-pattern checks (signature
// drift with live call sites, error handling removed, undeclared new
// dependency, lost return path) still passes the gate when the critic
// approves, because every AST check is severity 'score' and the critic term
// alone (0.6 * 0.9 = 0.54) clears the 0.5 threshold. The diff test is
// inconclusive (file has a top-level call into a dependency), which is
// fail-open.
//   node audit/1/ast-checks-cannot-block.js
// Expected: status=vetoed or critic_rejected. Observed: status=dry_run.

const { makeRepo, throughGate, summary, rm } = require('./lib');

const CUR = [
  'function load(p, opts) {',
  '  try {',
  "    return fs.readFileSync(p, opts.encoding || 'utf8');",
  '  } catch (e) {',
  '    return null;',
  '  }',
  '}'
].join('\n');
const PROP = [
  'function load(p) {',
  "  const axios = require('axios');",
  '  if (p) {',
  '    axios.get(p);',
  '  }',
  '}'
].join('\n');

const files = {
  'src/loader.js': `'use strict';\nconst fs = require('fs');\nconst log = require('debug')('loader');\n${CUR}\nmodule.exports = { load };\n`,
  'src/app.js': "'use strict';\nconst { load } = require('./loader');\nmodule.exports = () => load('cfg.json', { encoding: 'utf8' });\n"
};

(async () => {
  const repo = makeRepo(files, { pkg: { dependencies: { debug: '^4.0.0' } } });
  try {
    const { proposal } = await throughGate({ repo, file: 'src/loader.js', current: CUR, proposed: PROP });
    const s = summary(proposal);
    console.log(JSON.stringify(s, null, 2));
    for (const c of proposal.pattern_check_results) console.log(`  ${c.check_name}: ${c.passed ? 'pass' : 'FAIL'} (${c.severity}) ${c.detail}`);
    console.log(s.status === 'dry_run' ? '\nRESULT: reached executor despite 4/4 anti-pattern checks failing' : '\nRESULT: blocked');
  } finally { rm(repo); }
})();
