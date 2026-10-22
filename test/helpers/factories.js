'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-repo-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tmp', version: '0.0.0', dependencies: { lodash: '^4.0.0' }, scripts: { test: 'echo "Tests:        2 passed" && exit 0' }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), [
    "const _ = require('lodash');",
    'function add(a, b) {',
    '  try { return a + b; } catch (e) { return null; }',
    '}',
    'function double(x) { return x * 2; }',
    'module.exports = { add, double };'
  ].join('\n'));
  return dir;
}

function makeProposal(file, current, proposed, opts = {}) {
  return {
    issue_id: uuidv4(),
    file,
    current_code: current,
    proposed_code: proposed,
    reasoning: opts.reasoning || 'tighten',
    risk_estimate: opts.risk == null ? 0.2 : opts.risk,
    critic_verdict: null,
    pattern_check_results: [],
    diff_test: null,
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

function fakeProposals(n = 25) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const passed = i % 3 !== 0;
    out.push({
      issue_id: 'p' + i, file: 'f.js', reasoning: '', current_code: 'x', proposed_code: 'y',
      risk_estimate: 0.1 + (i % 5) * 0.1,
      critic_verdict: {
        p_preserves: passed ? 0.85 : 0.4, edge_cases: passed ? [] : ['x'], hallucination_flags: [], reasoning: passed ? 'fine' : 'risky', preserves_semantics: passed,
        agreement: { mean_confidence: passed ? 0.85 : 0.4, std_confidence: passed ? 0.03 : 0.2, unanimous_approval: passed, approval_rate: passed ? 1 : 0.3, verbal_entropy: passed ? 0.1 : 0.6 }
      },
      pattern_check_results: [{ check_name: 'a', passed: true, detail: '' }, { check_name: 'b', passed, detail: '' }],
      diff_test: null,
      combined_confidence: passed ? 0.78 : 0.42,
      test_outcome: { status: passed ? 'passed' : 'failed', coverage: { available: true, lines_pct: passed ? 0.9 : 0.4 }, stderr_tail: passed ? '' : 'Error: expected 2 but got 1' },
      decision_trace: []
    });
  }
  return out;
}

// An editMutants mutant as plain text: its switch replaced by the mutated
// branch (a Python `return` switch: single-line branches only).
function plainMutant(m) {
  const { lexView } = require('../../src/utils/hunks');
  const [[name, val]] = Object.entries(m.env), on = `_${name.toLowerCase()}`;
  const py = `${on} = __import__('os').environ.get('${name}') == '${val}'`, isPy = m.src.includes(py);
  const read = isPy ? [`; ${py}`, `${py}; `, `${py}\n`].find(r => m.src.includes(r)) : `var ${on} = globalThis.process.env.${name} === '${val}'; `;
  const s = m.src.replace(read, '');
  const c = s.indexOf(on);
  const code = lexView(s, isPy ? 'python' : 'javascript').code;
  const close = (i) => { for (let d = 0; ; i++) { if ('([{'.includes(code[i])) d++; else if (')]}'.includes(code[i]) && !--d) return i; } };
  const after = c + on.length;
  if (isPy && s.startsWith(':\n', after)) {
    const [, ind, mut] = /^:\n([ \t]*) {4}(.*)\n/.exec(s.slice(after));
    const o = s.indexOf(`\n${ind}else:\n`, after) + ind.length + 8;
    return s.slice(0, c - 3) + mut + s.slice(s.indexOf('\n', o + ind.length + 4));
  }
  if (isPy) {
    const me = c - 5;
    let mo = me - 1;
    while (code[mo] !== '(' || close(mo) !== me) mo--;
    return s.slice(0, mo - 1) + s.slice(mo + 1, me) + s.slice(close(after + 6) + 2);
  }
  if (s.slice(c - 4, c) !== 'if (') {
    const me = close(after + 3);
    return s.slice(0, c - 1) + s.slice(after + 4, me) + s.slice(close(me + 4) + 2);
  }
  if (s[after + 2] === '{') {
    const me = close(after + 2);
    return s.slice(0, c - 4) + s.slice(after + 4, me - 1) + s.slice(close(me + 7) + 1);
  }
  const me = close(after + 2);
  return s.slice(0, c - 4) + s.slice(after + 3, me) + s.slice(close(me + 8) + 1);
}

module.exports = { makeTempRepo, makeProposal, fakeProposals, plainMutant };
