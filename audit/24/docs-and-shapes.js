'use strict';

// AUDIT-24 Lows: docs and exported shapes after SG30/SG31.
//   L1 executor.js / bug-injector.js comments describe the sham as spaces
//      only; since SG31 it also wraps the site in non-space characters.
//   L2 editMutants' documented element shape lists `cover?` (never set) and
//      omits `span` (always set); `mutation.unmutated_hunk_line` names the
//      line of an uncovered token too.
//   L3 CLAUDE.md's list of `tests_insensitive` causes ("a site survived, a
//      hunk has no site, or a deleted token is neither observed nor
//      replaced") omits the SG26-SG31 causes; the new `mutation.*` fields have
//      no contract entry and no reader outside the executor.
// No API calls, no suite runs.
//   node audit/24/docs-and-shapes.js

const fs = require('fs');
const path = require('path');
const { report, exitCode } = require('./lib');
const { editMutants } = require('../../src/rl/bug-injector');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// L1
const before = "'use strict';\nfunction label(n) {\n  return 'n=' + n;\n}\nmodule.exports = { label };\n";
const after = before.replace("'n=' + n", "'n=' + n + '!'");
const ms = editMutants(after, { file: 'src/m.js', before, max: 3 });
const sham = ms.find(m => m.sham);
const added = sham ? sham.sham.length - after.length : 0;
const nonSpace = sham ? sham.sham.replace(/\s/g, '').length - after.replace(/\s/g, '').length : 0;
const exComment = /as many spaces added at the site/.test(read('src/agents/executor.js'));
const biComment = /`sham`: src with as many spaces added\s*\/\/ after the mutated code/.test(read('src/rl/bug-injector.js'));
console.log(`   L1 sham of ${sham && sham.mutation}: +${added} chars, +${nonSpace} non-space; sham line: ${sham ? JSON.stringify(sham.sham.split('\n')[2]) : '-'}`);
console.log(`   L1 executor.js "as many spaces added at the site": ${exComment}; bug-injector.js "src with as many spaces added after the mutated code": ${biComment}`);
report('L1 code comments describe the sham as spaces only (SG31 wraps the site in non-space characters)',
  !(nonSpace > 0 && (exComment || biComment)),
  `sham adds ${nonSpace} non-space characters; executor comment stale=${exComment}, bug-injector comment stale=${biComment}`,
  'comments match CLAUDE.md "Sham control" (spaces plus the site wrapped in as many non-space characters)');

// L2
const keys = [...new Set(ms.flatMap(m => Object.keys(m)))].sort();
const doc = (read('src/rl/bug-injector.js').match(/-> \[\{ mutation, src[^\n]*/) || [''])[0];
const exSrc = read('src/agents/executor.js');
const hunkLineForToken = /out\.uncovered_token = [^;]+; out\.unmutated_hunk_line/.test(exSrc);
console.log(`   L2 element keys=[${keys}] documented: ${doc}`);
report('L2 editMutants element shape and mutation field names drift from their docs',
  keys.includes('span') === /\bspan\b/.test(doc) && !(/cover\?/.test(doc) && !keys.includes('cover')) && !hunkLineForToken,
  `span set=${keys.includes('span')} documented=${/\bspan\b/.test(doc)}; cover documented=${/cover\?/.test(doc)} set=${keys.includes('cover')}; uncovered_token line stored as unmutated_hunk_line=${hunkLineForToken}`,
  'documented shape = produced shape; a field named for what it holds');

// L3
const claude = read('CLAUDE.md');
const list = (claude.replace(/\s+/g, ' ').match(/`tests_insensitive` \(a site survived[^)]*\)/) || [''])[0];
const missing = ['uncovered', 'unmutated_ref', 'control_failed', 'load'].filter(w => !list.includes(w));
const contracts = read('src/contracts.js');
const fields = ['uncovered_token', 'control_failed', 'unmutated_ref', 'collection_errors', 'killed_test'];
const srcFiles = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) srcFiles.push(p); } })(path.join(ROOT, 'src'));
const readers = fields.filter(f => srcFiles.some(p => !/executor\.js$|bug-injector\.js$/.test(p) && fs.readFileSync(p, 'utf8').includes(f)));
const inContract = fields.filter(f => contracts.includes(f));
console.log(`   L3 CLAUDE.md list: ${JSON.stringify(list)}; missing causes: [${missing}]; fields in contracts.js: [${inContract}]; read outside executor/bug-injector: [${readers}]`);
report('L3 CLAUDE.md `tests_insensitive` cause list and contracts lag SG26-SG31 mutation outcomes',
  !missing.length && inContract.length === fields.length,
  `list omits [${missing}]; contracts.js names [${inContract}] of [${fields}]; readers in src/ (dashboard, collector, reflexion, clustering): [${readers}]`,
  'one list of causes; TestOutcome.mutation documented in src/contracts.js');

process.exit(exitCode());
