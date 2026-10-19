'use strict';

// AUDIT-3: README.md / CLAUDE.md / PLAN.md claims vs code and CLI behaviour.
//
//   node audit/3/docs-vs-code.js

const { env, report, exitCode } = require('./lib');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const CLAUDE = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const ORCH = path.join(ROOT, 'src/orchestrator.js');

function get(url) {
  return new Promise((resolve, reject) => http.get(url, (res) => {
    let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
  }).on('error', reject));
}

(async () => {
  // ---- 1. CLI flags: README table / CLAUDE.md vs commander ----
  // buildCli is not exported; read the option table from --help.
  const help = spawnSync(process.execPath, [ORCH, '--help'], { encoding: 'utf8' }).stdout;
  const cliFlags = [...help.matchAll(/^\s+(--[a-z-]+)/gm)].map(m => m[1]).filter(f => f !== '--help');
  const readmeFlags = [...README.matchAll(/^\| `(--[a-z-]+)/gm)].map(m => m[1]);
  const claudeCli = CLAUDE.slice(CLAUDE.indexOf('## CLI'));
  const claudeFlags = [...new Set([...claudeCli.matchAll(/(--[a-z-]+)/g)].map(m => m[1]))];
  report('L-doc-1 CLAUDE.md "## CLI" lists only part of the CLI',
    cliFlags.every(f => claudeFlags.includes(f)),
    `commander: ${cliFlags.join(' ')}; README table: ${readmeFlags.join(' ')}; CLAUDE.md: ${claudeFlags.join(' ')}`,
    'CLAUDE.md ("source of truth") documents --cache, --no-hierarchical, --serve, --port (and that the API cache is on by default)');

  // ---- 2. invalid flag values ----
  const tmp = fs.mkdtempSync(path.join(env.root, 'cli-'));
  const envv = { ...process.env, REFACTOR_STATE_DIR: path.join(tmp, 'state'), REFACTOR_DASHBOARD_DIR: path.join(tmp, 'dash'), ANTHROPIC_API_KEY: '' };
  const bad = spawnSync(process.execPath, [ORCH, '--repo', tmp, '--cache', 'bogus', '--dry-run'], { encoding: 'utf8', env: envv });
  const firstErr = (bad.stderr || '').split('\n').slice(0, 2).join(' | ');
  report('L-cli-2 --cache with an unknown mode dies with a stack trace',
    bad.status === 2 || /usage|allowed choices|invalid/i.test(bad.stderr) && !/\n\s+at /.test(bad.stderr),
    `exit=${bad.status}; stderr: ${firstErr}; stack frames printed: ${(bad.stderr.match(/\n\s+at /g) || []).length}`,
    'commander .choices([...]) rejecting the value with a usage error (exit 1/2, no stack)');
  const src = fs.readFileSync(ORCH, 'utf8');
  report('L-cli-3 --port <non-number> silently becomes 4173',
    !/Number\(opts\.port\) \|\| 4173/.test(src),
    `orchestrator.js: "dashboardPort: Number(opts.port) || 4173" -> --port abc / --port 0 serve on 4173`,
    'reject invalid ports (or honour 0 = ephemeral)');

  // ---- 3. README anchor tier order ----
  const am = fs.readFileSync(path.join(ROOT, 'src/runner/anchor-matcher.js'), 'utf8');
  const order = [...am.matchAll(/return \{ tier: '([a-z-]+)'/g)].map(m => m[1]);
  const readmeOrder = (README.match(/4-tier anchor matching \(exact → ([^)]+)\)/) || [])[1];
  report('L-doc-4 README tier order differs from anchor-matcher',
    readmeOrder && readmeOrder.replace(/\s/g, '').startsWith(order.slice(1).join('→').replace('indent-shift', 'indent')),
    `README: "exact → ${readmeOrder}"; code: ${order.join(' → ')}`,
    'same order in both');

  // ---- 4. CLAUDE.md: warn at 70% saturation ----
  const { TokenTracker } = require('../../src/utils/token-tracker');
  const lines = [];
  const log = console.log, warn = console.warn, err = console.error;
  console.log = (...a) => lines.push(a.join(' ')); console.warn = console.log; console.error = console.log;
  const s = { };
  const t = new TokenTracker(s);
  const r = t.record('critic', { input_tokens: 70_000, output_tokens: 0 });
  console.log = log; console.warn = warn; console.error = err;
  const orchUsesExceeded = /exceeded|shouldPrune|saturation/.test(src);
  report('L-doc-5 "warn at 70% saturation" (CLAUDE.md) is never emitted',
    lines.length > 0 || orchUsesExceeded,
    `record() at ${Math.round(r.saturation * 100)}% returned exceeded=${r.exceeded}; output lines: ${lines.length}; orchestrator reads exceeded/shouldPrune: ${orchUsesExceeded}`,
    'a warning when an agent crosses 70%, or the CLAUDE.md line removed');

  // ---- 5. server: /calibration.json promised "model + reliability bins" ----
  const { start } = require('../../src/interpretability/server');
  const calibration = require('../../src/rl/calibration');
  const { saveSession, freshSession } = require('../../src/utils/checkpoint');
  const target = fs.mkdtempSync(path.join(env.root, 'tgt-'));
  const sess = freshSession(target); saveSession(sess);
  const xs = Array.from({ length: 20 }, (_, i) => i / 20);
  calibration.save(calibration.fitIsotonic(xs, xs.map(x => (x > 0.5 ? 1 : 0))), target);
  const srv = await start({ port: 0, quiet: true });
  const cal = await get(`${srv.url}calibration.json`);
  await srv.close();
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src/interpretability/server.js'), 'utf8');
  report('L-doc-6 /calibration.json has no reliability bins; /rl-weights.json undocumented',
    'bins' in cal || 'reliability' in cal,
    `keys: ${Object.keys(cal).join(', ')}; server header lists /rl-weights.json: ${/GET \/rl-weights\.json/.test(serverSrc)}`,
    'server.js header: "isotonic calibration model + reliability bins"');

  // ---- 6. contract asserts at stage boundaries (PLAN: "used in tests and at stage boundaries") ----
  const used = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); if (e.isDirectory()) walk(a); else if (a.endsWith('.js') && !a.endsWith('contracts.js')) { const t2 = fs.readFileSync(a, 'utf8').split('\n').filter(l => !l.includes('require(')).join('\n'); for (const m of t2.matchAll(/\b(assert[A-Z]\w+)\b/g)) (used[m[1]] = used[m[1]] || new Set()).add(path.relative(ROOT, a)); } } };
  walk(path.join(ROOT, 'src'));
  const all = Object.keys(require('../../src/contracts')).filter(k => k.startsWith('assert'));
  const unused = all.filter(k => !used[k]);
  report('M-contract-7 four of seven contract asserts never run in src/',
    unused.length === 0,
    `used in src: ${Object.entries(used).map(([k, v]) => `${k} (${[...v].join(',')})`).join('; ')}; never: ${unused.join(', ')}`,
    'assertProposal on analyzer/reflexion output, assertTestOutcome on executor output, assertSample before samples are persisted (PLAN "Interface contracts")');

  // ---- 7. the e2e test's persisted-sample assert reads the empty global store ----
  const e2e = fs.readFileSync(path.join(ROOT, 'test/orchestrator.e2e.test.js'), 'utf8');
  const line = e2e.split('\n').findIndex(l => l.includes('for (const s of loadSamples()) assertSample(s);')) + 1;
  const { samplesPath, stateDirFor } = { ...require('../../src/rl/collector'), ...require('../../src/utils/checkpoint') };
  report('L-test-8 e2e "persisted samples satisfy the contract" assert is vacuous',
    line === 0,
    `test/orchestrator.e2e.test.js:${line} iterates loadSamples() = ${samplesPath()} (global, never written since SG6); samples live in ${path.relative(env.stateDir, stateDirFor('/x'))}/rl-samples.json`,
    'loadSamples(repo)');
  process.exit(exitCode());
})().catch((e) => { console.error(e); process.exit(2); });
