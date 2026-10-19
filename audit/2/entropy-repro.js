#!/usr/bin/env node
'use strict';
// Incidental (not performance): identical persona reasoning makes
// critic.entropy() slightly negative, which assertJuryVerdict rejects, so the
// hybrid validator throws and the proposal is recorded as critic_rejected.
// usage: node audit/2/entropy-repro.js
const path = require('path');
const { entropy, aggregateJury } = require(path.join(__dirname, '..', '..', 'src', 'agents', 'critic'));
const { assertJuryVerdict } = require(path.join(__dirname, '..', '..', 'src', 'contracts'));
const t = 'critic verdict has no p_preserves'; // e.g. three malformed verdicts; text-dependent rounding
console.log('entropy of 3 identical texts:', entropy([t, t, t]));
const v = (persona) => ({ proposal_id: 'x', persona, preserves_semantics: true, p_preserves: 0.9, edge_cases: [], hallucination_flags: [], reasoning: t });
try { assertJuryVerdict(aggregateJury([v('strict'), v('permissive'), v('security')], 'x')); console.log('contract ok'); }
catch (e) { console.log('contract violation:', e.message); }
