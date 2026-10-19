'use strict';

const crypto = require('crypto');
const { callClaude, extractJsonBlock } = require('../utils/claude-client');

// Agentless-style hierarchical localization (Xia et al., arXiv:2407.01489).
// Three Claude passes that hierarchically narrow the search:
//   pass 1: file shortlist  — given a repo summary, name the top-N files
//   pass 2: function shortlist — within the shortlisted files, name the
//                                hottest functions/lines
//   pass 3: edit window — given the targeted functions, emit proposals
//
// This is dramatically cheaper than the original "dump all files, ask for
// proposals" because pass 1 sees only file index entries (path+size+
// signature counts) and pass 2 only sees the functions named by pass 1.
// Each pass also produces a `decision_trace` entry for interpretability.

const MAX_FILES_PER_BATCH = 12;
const MAX_CHARS_PER_FILE = 8000;
const TARGET_PROPOSALS = 10;
const FILE_SHORTLIST = 8;
const FUNCTION_SHORTLIST = 12;

// Deterministic ids keep critic prompts (and so replay-cache keys) stable
// across runs; model-supplied ids are ignored.
function proposalId(file, currentCode) {
  return crypto.createHash('sha256').update(String(file) + '\0' + String(currentCode)).digest('hex').slice(0, 16);
}

// `taken` is the set of ids already in the session; collisions get -2, -3, ...
function uniqueProposalId(file, currentCode, taken) {
  const base = proposalId(file, currentCode);
  let id = base;
  for (let n = 2; taken && taken.has(id); n++) id = `${base}-${n}`;
  if (taken) taken.add(id);
  return id;
}

// ---------- Pass 3 (single-batch fallback / per-function edit) ----------

const PROPOSAL_SYSTEM = [
  'You are a code analyzer.',
  'You receive a list of source files and their contents.',
  'Identify tech debt: high complexity, duplication, poor error handling, maintainability issues.',
  'For each issue, output exactly one JSON object (no prose, no markdown):',
  '{',
  '  "file": "<relative path>",',
  '  "current_code": "<the problematic snippet, copied verbatim from the file>",',
  '  "proposed_code": "<your refactored version>",',
  '  "reasoning": "<why this is tech debt and why your fix is correct>",',
  '  "risk_estimate": <0.0-1.0, where 1.0 = high risk of breaking things>',
  '}',
  'Output a JSON array of these objects. Nothing else.',
  'Aim for 5 to 10 proposals total. Quality over quantity.',
  'CRITICAL: current_code MUST appear verbatim in the corresponding file (whitespace, punctuation, identifiers identical) so the executor can locate it.'
].join('\n');

// ---------- Pass 1: file shortlist ----------

const FILE_SHORTLIST_SYSTEM = [
  'You are a code-quality triage agent.',
  'You receive a repository summary: paths, sizes, function counts.',
  'Rank the files most likely to harbor tech debt and return a JSON array:',
  '[{ "file": "<relative path>", "why": "<one-sentence reason>", "score": <0.0-1.0> }, ...]',
  'Return at most ' + FILE_SHORTLIST + ' files. Nothing else.'
].join('\n');

function summarizeFile(f) {
  const fnRe = /(?:^|\W)(?:function|def|fn|public|private)\s+([A-Za-z_]\w*)\s*\(/g;
  const fnNames = new Set();
  let m;
  while ((m = fnRe.exec(f.content || ''))) fnNames.add(m[1]);
  const lines = (f.content || '').split('\n').length;
  return { file: f.relative, lines, functions: fnNames.size, size_bytes: f.size };
}

async function pickFileShortlist({ files, tracker }) {
  const summary = files.map(summarizeFile);
  const user = 'Repository summary (JSON):\n' + JSON.stringify(summary).slice(0, 30_000);
  let parsed = null;
  try {
    const resp = await callClaude({ system: FILE_SHORTLIST_SYSTEM, user, cacheTag: 'analyzer-files' });
    if (tracker) tracker.record('analyzer', resp.usage);
    parsed = extractJsonBlock(resp.text);
  } catch (err) {
    return { fileList: files.slice(0, FILE_SHORTLIST), pass: { reason: `file-shortlist API error: ${err.message}` } };
  }
  if (!Array.isArray(parsed)) return { fileList: files.slice(0, FILE_SHORTLIST), pass: { reason: 'malformed shortlist' } };
  const byPath = new Map(files.map(f => [f.relative, f]));
  const selected = parsed
    .map(s => byPath.get(String(s.file)))
    .filter(Boolean)
    .slice(0, FILE_SHORTLIST);
  return { fileList: selected.length ? selected : files.slice(0, FILE_SHORTLIST), pass: parsed };
}

// ---------- Pass 2: function shortlist ----------

const FUNCTION_SHORTLIST_SYSTEM = [
  'You receive a small set of files with their FULL contents.',
  'Identify the worst functions / regions to refactor first.',
  'Return JSON: [{ "file": "<path>", "anchor": "<function name OR opening line>", "why": "<reason>", "score": <0.0-1.0> }, ...]',
  'Return at most ' + FUNCTION_SHORTLIST + '. Nothing else.'
].join('\n');

async function pickFunctionShortlist({ files, tracker }) {
  const renderedFiles = files.map(f => {
    const trunc = (f.content || '').slice(0, MAX_CHARS_PER_FILE);
    return `=== FILE: ${f.relative} ===\n${trunc}`;
  }).join('\n\n');
  const user = 'Identify the most problematic regions across these files:\n\n' + renderedFiles;
  let parsed = null;
  try {
    const resp = await callClaude({ system: FUNCTION_SHORTLIST_SYSTEM, user, cacheTag: 'analyzer-funcs' });
    if (tracker) tracker.record('analyzer', resp.usage);
    parsed = extractJsonBlock(resp.text);
  } catch (err) {
    return [];
  }
  return Array.isArray(parsed) ? parsed.slice(0, FUNCTION_SHORTLIST) : [];
}

// ---------- Pass 3: edit windows / proposals ----------

function chunkFiles(files, maxFiles, maxBytes) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    const size = (f.content || '').length;
    if (cur.length >= maxFiles || curBytes + size > maxBytes) {
      if (cur.length) batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function renderBatch(batch, focusHints) {
  const parts = [];
  for (const f of batch) {
    const content = (f.content || '').length > MAX_CHARS_PER_FILE
      ? (f.content || '').slice(0, MAX_CHARS_PER_FILE) + '\n/* ...truncated... */'
      : (f.content || '');
    const hints = (focusHints || []).filter(h => h && h.file === f.relative);
    const hintLines = hints.length
      ? '\n/* analyzer hints:\n' + hints.map(h => `  - ${h.anchor || ''}: ${h.why || ''}`).join('\n') + '\n*/\n'
      : '';
    parts.push(`=== FILE: ${f.relative} ===${hintLines}\n${content}`);
  }
  return parts.join('\n\n');
}

function normalizeProposal(raw, allowedFiles, taken = null) {
  if (!raw || typeof raw !== 'object') return null;
  const file = String(raw.file || '').trim();
  if (!file || !allowedFiles.has(file)) return null;
  const current = String(raw.current_code || '');
  const proposed = String(raw.proposed_code || '');
  if (!current || !proposed || current === proposed) return null;
  const risk = Number(raw.risk_estimate);
  return {
    issue_id: uniqueProposalId(file, current, taken),
    file,
    current_code: current,
    proposed_code: proposed,
    reasoning: String(raw.reasoning || ''),
    risk_estimate: Number.isFinite(risk) ? Math.max(0, Math.min(1, risk)) : 0.5,
    critic_verdict: null,
    pattern_check_results: [],
    diff_test: null,
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

async function callAnalyzerOnce(batch, hints) {
  const user = [
    'Analyze these files for tech debt. Return a JSON array of proposals.',
    '',
    renderBatch(batch, hints)
  ].join('\n');
  const resp = await callClaude({ system: PROPOSAL_SYSTEM, user, cacheTag: 'analyzer-propose' });
  let parsed = extractJsonBlock(resp.text);
  if (parsed && !Array.isArray(parsed)) parsed = [parsed];
  return { proposals: Array.isArray(parsed) ? parsed : null, usage: resp.usage, raw: resp.text };
}

// ---------- Orchestration ----------

async function runAnalyzer({ files, tracker, hierarchical = true, takenIds = null }) {
  const allowedFiles = new Set(files.map(f => f.relative));
  const taken = new Set(takenIds || []);
  const proposals = [];

  let targetFiles = files;
  let hints = [];

  if (hierarchical && files.length > FILE_SHORTLIST) {
    const { fileList } = await pickFileShortlist({ files, tracker });
    targetFiles = fileList;
    hints = await pickFunctionShortlist({ files: targetFiles, tracker });
  }

  const batches = chunkFiles(targetFiles, MAX_FILES_PER_BATCH, 60_000);

  for (const batch of batches) {
    if (proposals.length >= TARGET_PROPOSALS) break;
    let result;
    try {
      result = await callAnalyzerOnce(batch, hints);
    } catch (err) {
      console.error(`[analyzer] batch failed: ${err.message}`);
      continue;
    }
    tracker.record('analyzer', result.usage);

    let raw = result.proposals;
    if (!raw) {
      try {
        const retry = await callClaude({
          system: PROPOSAL_SYSTEM,
          user: 'Your previous output was not valid JSON. Return ONLY a JSON array of proposal objects. No prose, no fences.\n\n' + renderBatch(batch, hints),
          cacheTag: 'analyzer-propose-retry'
        });
        tracker.record('analyzer', retry.usage);
        const parsed = extractJsonBlock(retry.text);
        raw = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : null);
      } catch (err) { /* */ }
    }
    if (!raw) continue;

    for (const item of raw) {
      const norm = normalizeProposal(item, allowedFiles, taken);
      if (norm) proposals.push(norm);
      if (proposals.length >= TARGET_PROPOSALS) break;
    }
  }

  return proposals;
}

module.exports = {
  runAnalyzer,
  pickFileShortlist,
  pickFunctionShortlist,
  normalizeProposal,
  proposalId,
  uniqueProposalId,
  chunkFiles,
  summarizeFile,
  PROPOSAL_SYSTEM,
  FILE_SHORTLIST_SYSTEM,
  FUNCTION_SHORTLIST_SYSTEM
};
