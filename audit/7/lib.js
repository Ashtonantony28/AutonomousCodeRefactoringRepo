'use strict';

// Shared harness for AUDIT-7 repros: the AUDIT-3 harness (temp
// REFACTOR_STATE_DIR / dashboard dir via test/helpers/env.js, quiet, report)
// plus a stub-backed pipeline runner. No API calls; never touches state/.
const lib = require('../3/lib');
const { runPipeline } = require('../../src/orchestrator');
const { installStub, resetClient } = require('../../test/helpers/stub-client');

// One pipeline run with its own stub responses. -> { s, stub }
async function runWith(repo, responses, opts = {}) {
  const stub = installStub(responses);
  try {
    const s = await lib.quiet(() => lib.noTestCtx(() => runPipeline({ repo, cache: 'off', ...opts })));
    return { s, stub };
  } finally { resetClient(); }
}

const APPROVE = { preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: 'stub approve' };

// Stub responses for analyzer proposals and a unanimous approving jury.
function proposals(list, { critic = APPROVE, reflexion = 'not json' } = {}) {
  return {
    'analyzer-files': [...new Set(list.map(p => p.file))].map(file => ({ file, why: 'audit', score: 1 })),
    'analyzer-funcs': [],
    'analyzer-propose': list.map(p => ({ reasoning: 'audit', risk_estimate: 0.2, ...p })),
    critic: typeof critic === 'function' ? critic : [{ response: critic }],
    reflexion
  };
}

module.exports = { ...lib, runWith, proposals, APPROVE };
