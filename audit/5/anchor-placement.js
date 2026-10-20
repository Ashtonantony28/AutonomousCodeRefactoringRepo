'use strict';

// Edits that are only unsafe because of where the anchor lands.
//   node audit/5/anchor-placement.js
// A1-A3: whitespace-tier hazards (should be refused or validated on the
//        matched region) - expected ok.
// A4:    indent-shift match: the validators must judge the matched region,
//        so a semantic change is still vetoed - expected ok.
// A5:    the exact tier matches inside a block comment; a proposal that
//        closes the comment injects live top-level code. A5 (prototype
//        pollution) is caught by the diff test; A6 (load-time execSync) is
//        not: load-time effects are never compared. FINDING if one reaches
//        the executor.

const { makeRepo, throughGate, rm, line, UNANIMOUS } = require('./lib');
const { resolveEdit } = require('../../src/runner/reverter');

const HAZARDS = [
  ['A1 whitespace in a Python string', 'x.py', 'def f():\n    return "a  b"\n', 'def f():\n    return "a b"\n', 'def f():\n    return "a b".upper()\n'],
  ['A2 postfix ++ across a line break (ASI)', 'x.js', 'function f(a, b) {\n  a\n  ++b;\n  return [a, b];\n}\n', 'function f(a, b) {\n  a ++b;\n  return [a, b];\n}', 'function f(a, b) {\n  a ++b;\n  return [a, b, 0];\n}'],
  ['A3 HTML-like comment `-->` after a line break', 'x.js', 'function f(a) {\n  return a\n  --> 0;\n}\n', 'function f(a) {\n  return a --> 0;\n}', 'function f(a) {\n  return a > 0;\n}']
];

(async () => {
  const quiet = console.log;
  let findings = 0;
  for (const [name, file, src, cur, prop] of HAZARDS) {
    try {
      const r = resolveEdit({ src, relPath: file, currentCode: cur, proposedCode: prop });
      console.log(`${name}: matched tier=${r.match.tier} region=${JSON.stringify(r.region)} (validators run on this region)`);
    } catch (e) {
      console.log(`${name}: ok refused (${e.tier}/${(e.detail && e.detail.reason) || 'n/a'})`);
    }
  }

  // A4: LLM copied an object-literal method at indent 0; file has it at indent 2.
  {
    const CUR = 'isAdult(age) {\n  return age >= 18;\n}';
    const PROP = 'isAdult(age) {\n  return age > 18;\n}';
    const src = "'use strict';\nmodule.exports = {\n  isAdult(age) {\n    return age >= 18;\n  }\n};\n";
    const repo = makeRepo({ 'src/p.js': src });
    console.log = () => {};
    let p;
    try { ({ proposal: p } = await throughGate({ repo, file: 'src/p.js', current: CUR, proposed: PROP, critic: UNANIMOUS })); } finally { console.log = quiet; rm(repo); }
    const tier = p.validated_region && p.validated_region.tier;
    console.log(`A4 indent-shift object method: tier=${tier} ${line(p)} -> ${p.test_outcome.status === 'dry_run' ? 'FINDING' : 'ok'}`);
    if (p.test_outcome.status === 'dry_run') findings++;
  }

  // A5: comment break-out.
  {
    const CUR = 'function isAdmin(u) { return true; }';
    const PROP = "function isAdmin(u) { return true; }\n*/\nObject.prototype.role = 'admin';\n/*";
    const src = "'use strict';\n/* legacy implementation, kept for reference:\nfunction isAdmin(u) { return true; }\n*/\nfunction isAdmin(u) {\n  return u.role === 'admin';\n}\nmodule.exports = { isAdmin };\n";
    const repo = makeRepo({ 'src/auth.js': src });
    console.log = () => {};
    let p;
    try { ({ proposal: p } = await throughGate({ repo, file: 'src/auth.js', current: CUR, proposed: PROP, critic: UNANIMOUS })); } finally { console.log = quiet; rm(repo); }
    const tier = p.validated_region && p.validated_region.tier;
    console.log(`A5 exact match inside a block comment, proposal closes it: tier=${tier} ${line(p)}`);
    const m = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'require', src.replace(CUR, () => PROP))(m, require);
    console.log(`   after the edit: isAdmin({}) = ${m.exports.isAdmin({})} (was false)`);
    delete Object.prototype.role;
    if (p.test_outcome.status === 'dry_run') { findings++; console.log('   FINDING: comment break-out reaches the executor'); }
  }

  // A6: same break-out, but the injected code is a load-time side effect
  // that touches no callable: the removed snippet function resolves to the
  // real one on both sides and the diff test reports `equivalent`.
  {
    const CUR = 'function isAdmin(u) { return true; }';
    const PROP = "function isAdmin(u) { return true; }\n*/\nrequire('child_process').execSync('echo injected');\n/*";
    const src = "'use strict';\n/* legacy implementation, kept for reference:\nfunction isAdmin(u) { return true; }\n*/\nfunction isAdmin(u) {\n  return u.role === 'admin';\n}\nmodule.exports = { isAdmin };\n";
    const { MAJORITY } = require('./lib');
    for (const [label, critic] of [['unanimous', UNANIMOUS], ['2/3', MAJORITY]]) {
      const repo = makeRepo({ 'src/auth.js': src });
      console.log = () => {};
      let p;
      try { ({ proposal: p } = await throughGate({ repo, file: 'src/auth.js', current: CUR, proposed: PROP, critic })); } finally { console.log = quiet; rm(repo); }
      console.log(`A6 comment break-out injecting a load-time execSync (${label} critic): tier=${p.validated_region && p.validated_region.tier} ${line(p)}`);
      if (p.test_outcome.status === 'dry_run') { findings++; console.log('   FINDING: injected top-level side effect reaches the executor'); }
    }
  }

  if (findings) { console.log(`FINDING: ${findings}`); process.exit(1); }
  console.log('ok');
})();
