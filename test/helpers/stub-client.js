'use strict';

const fs = require('fs');
const path = require('path');
const { setClient, resetClient } = require('../../src/utils/claude-client');

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

const PREFIXES = ['analyzer-files', 'analyzer-funcs', 'analyzer-propose', 'critic', 'reflexion'];

function keyFor(cacheTag) {
  if (!cacheTag) return 'executor';
  return PREFIXES.find(p => cacheTag === p || cacheTag.startsWith(p + '-')) || cacheTag;
}

function render(response) {
  if (response == null) return '';
  return typeof response === 'string' ? response : JSON.stringify(response);
}

function isMatchList(entry) {
  return Array.isArray(entry) && entry.length > 0 &&
    entry.every(e => e && typeof e === 'object' && !Array.isArray(e) && 'response' in e);
}

function pick(entry, user) {
  if (!isMatchList(entry)) return entry;
  const hit = entry.find(e => e && (e.match == null || String(user).includes(e.match)));
  return hit ? hit.response : undefined;
}

function createStubClient(responses = {}) {
  const calls = [];
  const fn = async ({ system, user, cacheTag }) => {
    const key = keyFor(cacheTag);
    calls.push({ key, cacheTag: cacheTag || null });
    let entry = responses[key];
    if (typeof entry === 'function') entry = await entry({ system, user, cacheTag });
    const response = pick(entry, user);
    if (response === undefined) throw new Error(`stub client: no canned response for ${cacheTag || '(untagged)'}`);
    return { text: render(response), usage: { input_tokens: 100, output_tokens: 20 } };
  };
  fn.calls = calls;
  fn.count = (key) => key == null ? calls.length : calls.filter(c => c.key === key).length;
  return fn;
}

function loadFixtureResponses(name) {
  const dir = path.join(FIXTURES_DIR, name);
  const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'proposals.json'), 'utf8'));
  const rest = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8'));
  const forAnalyzer = proposals.map(({ expected_status, ...p }) => p);
  return {
    'analyzer-files': proposals.map(p => ({ file: p.file, why: 'fixture', score: 1 })),
    'analyzer-funcs': [],
    'analyzer-propose': forAnalyzer,
    ...rest
  };
}

function installStub(responses) {
  const stub = createStubClient(responses);
  setClient(stub);
  return stub;
}

module.exports = { createStubClient, loadFixtureResponses, installStub, resetClient, keyFor, FIXTURES_DIR };
