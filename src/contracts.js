'use strict';

const { FEATURE_NAMES } = require('./rl/features');

const TEST_OUTCOME_STATUSES = [
  'passed', 'reverted', 'timeout', 'environment_error', 'apply_failed',
  'critic_rejected', 'vetoed', 'rl_rejected', 'dry_run', 'skipped_no_tests', 'error'
];
const DIFF_TEST_VERDICTS = ['equivalent', 'divergent', 'inconclusive'];
const CHECK_SEVERITIES = ['veto', 'score'];

const SHAPES = {
  Proposal: ['issue_id', 'file', 'current_code', 'proposed_code', 'reasoning', 'risk_estimate',
    'parent_issue_id?', 'attempt?', 'critic_verdict', 'pattern_check_results[]', 'diff_test',
    'combined_confidence', 'veto?', 'test_outcome', 'decision_trace[]'],
  Verdict: ['persona', 'preserves_semantics', 'p_preserves', 'edge_cases[]', 'hallucination_flags[]', 'reasoning'],
  JuryVerdict: ['panel[]', 'p_preserves', 'agreement{std,unanimous,approval_rate,verbal_entropy}'],
  CheckResult: ['check_name', 'passed', 'detail', 'severity'],
  DiffTest: ['applicable', 'verdict', 'runs', 'counterexample?', 'reason?', 'duration_ms'],
  Sample: ['proposal_id', 'target_repo', 'features[]', 'label', 'synthetic', 'mutation?', 'timestamp'],
  TestOutcome: ['status', '...']
};

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v)}`;
  if (typeof v === 'number') return `number ${v}`;
  return typeof v;
}

class ContractError extends Error {
  constructor(shape, errors) {
    super(`${shape} contract violated: ${errors.join('; ')}`);
    this.name = 'ContractError';
    this.shape = shape;
    this.errors = errors;
  }
}

function checker(shape, obj) {
  const errors = [];
  const isObj = obj !== null && typeof obj === 'object' && !Array.isArray(obj);
  const has = (k) => isObj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined;
  const fail = (k, expected) => errors.push(`${k}: expected ${expected}, got ${has(k) ? describe(obj[k]) : 'missing'}`);
  const c = {
    errors,
    isObj,
    string(k, { optional = false, nonEmpty = true } = {}) {
      if (!has(k)) { if (!optional) fail(k, 'string'); return; }
      if (typeof obj[k] !== 'string' || (nonEmpty && !obj[k].length)) fail(k, nonEmpty ? 'non-empty string' : 'string');
    },
    bool(k) { if (typeof obj[k] !== 'boolean') fail(k, 'boolean'); },
    prob(k, { nullable = false, optional = false } = {}) {
      const expected = nullable ? 'number in [0,1] or null' : 'number in [0,1]';
      if (!isObj || !(k in obj) || obj[k] === undefined) { if (!optional) fail(k, expected); return; }
      if (obj[k] === null) { if (!nullable) fail(k, expected); return; }
      if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k]) || obj[k] < 0 || obj[k] > 1) fail(k, expected);
    },
    int(k, { optional = false } = {}) {
      if (!has(k)) { if (!optional) fail(k, 'non-negative integer'); return; }
      if (!Number.isInteger(obj[k]) || obj[k] < 0) fail(k, 'non-negative integer');
    },
    num(k) { if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k]) || obj[k] < 0) fail(k, 'non-negative finite number'); },
    array(k, each) {
      if (!Array.isArray(obj[k])) { fail(k, 'array'); return; }
      if (each) obj[k].forEach((v, i) => { const e = each(v); if (e) errors.push(`${k}[${i}]: ${e}`); });
    },
    oneOf(k, values) { if (!values.includes(obj[k])) fail(k, `one of ${values.join('|')}`); },
    objectOrNull(k) {
      if (!isObj || !(k in obj)) { fail(k, 'object or null'); return; }
      const v = obj[k];
      if (v !== null && (typeof v !== 'object' || Array.isArray(v))) fail(k, 'object or null');
    },
    timestamp(k) {
      if (typeof obj[k] !== 'string' || Number.isNaN(Date.parse(obj[k]))) fail(k, 'ISO timestamp string');
    }
  };
  if (!isObj) errors.push(`expected object, got ${describe(obj)}`);
  return c;
}

function done(shape, c) {
  if (c.errors.length) throw new ContractError(shape, c.errors);
  return true;
}

function assertTestOutcome(o) {
  const c = checker('TestOutcome', o);
  if (c.isObj) c.oneOf('status', TEST_OUTCOME_STATUSES);
  return done('TestOutcome', c);
}

function assertProposal(p) {
  const c = checker('Proposal', p);
  if (c.isObj) {
    c.string('issue_id');
    c.string('file');
    c.string('current_code');
    c.string('proposed_code', { nonEmpty: false });
    c.string('reasoning', { nonEmpty: false });
    c.prob('risk_estimate');
    c.string('parent_issue_id', { optional: true });
    c.int('attempt', { optional: true });
    c.objectOrNull('critic_verdict');
    c.array('pattern_check_results', v => (v && typeof v === 'object' && !Array.isArray(v)) ? null : `expected object, got ${describe(v)}`);
    c.objectOrNull('diff_test');
    c.prob('combined_confidence', { nullable: true });
    if (p.veto !== undefined && p.veto !== null && (typeof p.veto !== 'object' || Array.isArray(p.veto))) {
      c.errors.push(`veto: expected object or null, got ${describe(p.veto)}`);
    }
    c.objectOrNull('test_outcome');
    if (p.test_outcome && typeof p.test_outcome === 'object') {
      try { assertTestOutcome(p.test_outcome); } catch (e) { c.errors.push(...e.errors.map(x => `test_outcome.${x}`)); }
    }
    c.array('decision_trace', v => (v && typeof v === 'object' && typeof v.stage === 'string') ? null : 'expected trace step with a stage');
  }
  return done('Proposal', c);
}

function assertVerdict(v) {
  const c = checker('Verdict', v);
  if (c.isObj) {
    c.string('persona');
    c.bool('preserves_semantics');
    c.prob('p_preserves');
    c.array('edge_cases', x => typeof x === 'string' ? null : `expected string, got ${describe(x)}`);
    c.array('hallucination_flags', x => typeof x === 'string' ? null : `expected string, got ${describe(x)}`);
    c.string('reasoning', { nonEmpty: false });
  }
  return done('Verdict', c);
}

function assertJuryVerdict(j) {
  const c = checker('JuryVerdict', j);
  if (c.isObj) {
    c.array('panel', v => { try { assertVerdict(v); return null; } catch (e) { return e.message; } });
    if (Array.isArray(j.panel) && !j.panel.length) c.errors.push('panel: expected at least one verdict');
    c.prob('p_preserves');
    const a = j.agreement;
    if (!a || typeof a !== 'object') c.errors.push(`agreement: expected object, got ${describe(a)}`);
    else {
      const ac = checker('JuryVerdict.agreement', a);
      ac.num('std');
      ac.bool('unanimous');
      ac.prob('approval_rate');
      ac.prob('verbal_entropy');
      c.errors.push(...ac.errors.map(x => `agreement.${x}`));
    }
  }
  return done('JuryVerdict', c);
}

function assertCheckResult(r) {
  const c = checker('CheckResult', r);
  if (c.isObj) {
    c.string('check_name');
    c.bool('passed');
    c.string('detail', { nonEmpty: false });
    c.oneOf('severity', CHECK_SEVERITIES);
  }
  return done('CheckResult', c);
}

function assertDiffTest(d) {
  const c = checker('DiffTest', d);
  if (c.isObj) {
    c.bool('applicable');
    c.oneOf('verdict', DIFF_TEST_VERDICTS);
    c.int('runs');
    c.string('reason', { optional: true, nonEmpty: false });
    c.num('duration_ms');
    if (d.verdict === 'divergent' && (d.counterexample === undefined || d.counterexample === null)) {
      c.errors.push('counterexample: expected for verdict divergent, got missing');
    }
    if (d.applicable === false && d.verdict !== 'inconclusive') {
      c.errors.push(`verdict: expected inconclusive when applicable is false, got ${describe(d.verdict)}`);
    }
  }
  return done('DiffTest', c);
}

function assertSample(s) {
  const c = checker('Sample', s);
  if (c.isObj) {
    c.string('proposal_id');
    c.string('target_repo');
    c.array('features', x => (typeof x === 'number' && Number.isFinite(x)) ? null : `expected finite number, got ${describe(x)}`);
    if (Array.isArray(s.features) && s.features.length !== FEATURE_NAMES.length) {
      c.errors.push(`features: expected length ${FEATURE_NAMES.length} (${FEATURE_NAMES.join(',')}), got ${s.features.length}`);
    }
    c.oneOf('label', [0, 1]);
    c.bool('synthetic');
    c.string('mutation', { optional: true });
    if (s.synthetic === true && typeof s.mutation !== 'string') c.errors.push('mutation: expected string for synthetic sample, got missing');
    c.timestamp('timestamp');
  }
  return done('Sample', c);
}

module.exports = {
  SHAPES,
  FEATURE_NAMES,
  TEST_OUTCOME_STATUSES,
  DIFF_TEST_VERDICTS,
  CHECK_SEVERITIES,
  ContractError,
  assertProposal,
  assertVerdict,
  assertJuryVerdict,
  assertCheckResult,
  assertDiffTest,
  assertSample,
  assertTestOutcome
};
