'use strict';

// CriticGPT-style synthetic negatives (McAleese et al., 2024). For each
// proposal that PASSED tests, inject a deterministic bug into its
// proposed_code and emit a synthetic "should-have-been-rejected" training
// sample. Used to enlarge the classifier's negative class without paying
// for real test failures.
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

const { extractFeatures } = require('./features');

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

// Given a passing proposal, emit synthetic "should-reject" samples.
function syntheticNegatives(proposal, targetRepo = null) {
  if (!proposal || !proposal.test_outcome || proposal.test_outcome.status !== 'passed') return [];
  const muts = injectInto(proposal.proposed_code || '');
  const parentConf = proposal.critic_verdict ? proposal.critic_verdict.claude_confidence : 0.7;
  const features = extractFeatures({
    critic_verdict: { claude_confidence: Math.min(0.99, parentConf + 0.1) },
    pattern_check_results: [],
    current_code: '',
    proposed_code: proposal.proposed_code || '',
    risk_estimate: proposal.risk_estimate || 0.3
  });
  return muts.map(m => ({
    proposal_id: `${proposal.issue_id}::${m.mutation}`,
    target_repo: targetRepo,
    features: features.slice(),
    label: 0,
    synthetic: true,
    mutation: m.mutation,
    timestamp: new Date().toISOString()
  }));
}

module.exports = { injectInto, syntheticNegatives, MUTATIONS };
