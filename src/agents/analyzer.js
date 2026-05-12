'use strict';

const { v4: uuidv4 } = require('uuid');
const { callClaude, extractJsonBlock } = require('../utils/claude-client');

const SYSTEM_PROMPT = [
  'You are a code analyzer.',
  'You receive a list of source files and their contents.',
  'Identify tech debt: high complexity, duplication, poor error handling, maintainability issues.',
  'For each issue, output exactly one JSON object (no prose, no markdown):',
  '{',
  '  "issue_id": "<uuid>",',
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

const MAX_FILES_PER_BATCH = 12;
const MAX_CHARS_PER_FILE = 8000;
const TARGET_PROPOSALS = 10;

function chunkFiles(files, maxFiles, maxBytes) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    const size = f.content.length;
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

function renderBatch(batch) {
  const parts = [];
  for (const f of batch) {
    const content = f.content.length > MAX_CHARS_PER_FILE
      ? f.content.slice(0, MAX_CHARS_PER_FILE) + '\n/* ...truncated... */'
      : f.content;
    parts.push(`=== FILE: ${f.relative} ===\n${content}`);
  }
  return parts.join('\n\n');
}

function normalizeProposal(raw, allowedFiles) {
  if (!raw || typeof raw !== 'object') return null;
  const file = String(raw.file || '').trim();
  if (!file || !allowedFiles.has(file)) return null;
  const current = String(raw.current_code || '');
  const proposed = String(raw.proposed_code || '');
  if (!current || !proposed || current === proposed) return null;
  const risk = Number(raw.risk_estimate);
  return {
    issue_id: raw.issue_id && typeof raw.issue_id === 'string' ? raw.issue_id : uuidv4(),
    file,
    current_code: current,
    proposed_code: proposed,
    reasoning: String(raw.reasoning || ''),
    risk_estimate: Number.isFinite(risk) ? Math.max(0, Math.min(1, risk)) : 0.5,
    critic_verdict: null,
    pattern_check_results: [],
    combined_confidence: null,
    test_outcome: null,
    decision_trace: []
  };
}

async function callAnalyzerOnce(batch) {
  const user = [
    'Analyze these files for tech debt. Return a JSON array of proposals.',
    '',
    renderBatch(batch)
  ].join('\n');
  const resp = await callClaude({ system: SYSTEM_PROMPT, user });
  let parsed = extractJsonBlock(resp.text);
  if (parsed && !Array.isArray(parsed)) parsed = [parsed];
  return { proposals: Array.isArray(parsed) ? parsed : null, usage: resp.usage, raw: resp.text };
}

async function runAnalyzer({ files, tracker }) {
  const allowedFiles = new Set(files.map(f => f.relative));
  const batches = chunkFiles(files, MAX_FILES_PER_BATCH, 60_000);
  const proposals = [];

  for (const batch of batches) {
    if (proposals.length >= TARGET_PROPOSALS) break;
    let result;
    try {
      result = await callAnalyzerOnce(batch);
    } catch (err) {
      console.error(`[analyzer] batch failed: ${err.message}`);
      continue;
    }
    tracker.record('analyzer', result.usage);

    let raw = result.proposals;
    if (!raw) {
      // one retry with stricter framing
      try {
        const retry = await callClaude({
          system: SYSTEM_PROMPT,
          user: 'Your previous output was not valid JSON. Return ONLY a JSON array of proposal objects. No prose, no fences.\n\n' + renderBatch(batch)
        });
        tracker.record('analyzer', retry.usage);
        const parsed = extractJsonBlock(retry.text);
        raw = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : null);
      } catch (err) {
        console.error(`[analyzer] retry failed: ${err.message}`);
      }
    }
    if (!raw) continue;

    for (const item of raw) {
      const norm = normalizeProposal(item, allowedFiles);
      if (norm) proposals.push(norm);
      if (proposals.length >= TARGET_PROPOSALS) break;
    }
  }

  return proposals;
}

module.exports = { runAnalyzer, SYSTEM_PROMPT, normalizeProposal, chunkFiles };
