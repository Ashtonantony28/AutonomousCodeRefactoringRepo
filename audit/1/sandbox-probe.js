'use strict';

// Probes the diff-test sandbox for host escapes and for oracle evasion.
//   node audit/1/sandbox-probe.js
// An escape attempt "succeeds" if the proposed side can observe a host-only
// value (process.pid / require) and make the two sides differ on it.

const diffTesting = require('../../src/validation/diff-testing');

const CUR = 'function f(x) {\n  return x;\n}';
const attempts = {
  ctor_chain: "function f(x) {\n  try { return (this && this.constructor && this.constructor.constructor('return typeof process')()) ; } catch (e) { return 'blocked:' + e.name; }\n}",
  global_ctor: "function f(x) {\n  try { return Function('return typeof process + typeof require')(); } catch (e) { return 'blocked:' + e.name; }\n}",
  prepare_stack: "function f(x) {\n  try {\n    Error.prepareStackTrace = (e, cs) => cs.map(c => { try { const t = c.getThis(); return t && t.process ? 'HOST' : typeof t; } catch (er) { return 'x'; } }).join(',');\n    return new Error().stack;\n  } catch (e) { return 'blocked:' + e.name; }\n}",
  require_proxy: "function f(x) {\n  try { const m = require('fs'); return typeof m.readFileSync; } catch (e) { return 'blocked:' + e.name; }\n}",
  // Oracle evasion: behave like the original only inside the sandbox.
  env_sniff: "function f(x) {\n  if (typeof process === 'undefined' || typeof setTimeout === 'undefined') return x;\n  return null;\n}"
};

for (const [name, prop] of Object.entries(attempts)) {
  const r = diffTesting.run({ currentSrc: CUR, proposedSrc: prop });
  const cx = r.counterexample && r.counterexample.proposed;
  const seen = cx && cx.kind === 'value' ? JSON.stringify(cx.value) : cx && cx.error ? `${cx.error.name}: ${cx.error.message}` : '';
  console.log(`${name.padEnd(14)} verdict=${r.verdict}${seen ? `  proposed_saw=${seen.slice(0, 120)}` : ''}${r.reason ? `  reason=${r.reason}` : ''}`);
}
