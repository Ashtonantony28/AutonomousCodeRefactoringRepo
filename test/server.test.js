'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start } = require('../src/interpretability/server');
const { freshSession, saveSession } = require('../src/utils/checkpoint');
const { fakeProposals } = require('./helpers/factories');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', d => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function sseClient(port) {
  const events = [];
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk);
          const data = /^data: (.+)$/m.exec(chunk);
          if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
        }
      });
      resolve();
    }).on('error', reject);
  });
  return { events, ready, close: () => req.destroy() };
}

async function until(pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

test('server starts on ephemeral port and serves /healthz + /session.json', async () => {
  const sess = freshSession('/tmp/repo');
  saveSession(sess);
  const { server, close } = await start({ port: 0, quiet: true });
  try {
    const { port } = server.address();
    const health = await get(port, '/healthz');
    const s = await get(port, '/session.json');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(JSON.parse(s.body).run_id, sess.run_id);
  } finally {
    await close();
  }
});

test('/ reflects saveSession within 2 s and SSE emits a state event', async () => {
  const prev = process.env.REFACTOR_STATE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-live-'));
  process.env.REFACTOR_STATE_DIR = path.join(dir, 'state');
  const { server, close } = await start({ port: 0, quiet: true });
  const { port } = server.address();
  const sse = sseClient(port);
  try {
    const sess = freshSession('/tmp/repo');
    const [a, b] = fakeProposals(2);
    a.file = 'src/first-file.js';
    b.file = 'src/second-live-file.js';
    sess.proposals = [a];
    saveSession(sess);
    await sse.ready;
    assert(await until(async () => (await get(port, '/')).body.includes('first-file.js'), 2000));
    const before = sse.events.length;

    sess.proposals.push(b);
    saveSession(sess);
    const t0 = Date.now();
    assert(await until(async () => (await get(port, '/')).body.includes('second-live-file.js'), 2000), '/ shows new proposal');
    assert(await until(() => sse.events.slice(before).some(e => e.event === 'state' && e.data.proposals === 2), 2000 - (Date.now() - t0)),
      'SSE state event received');
  } finally {
    sse.close();
    await close();
    process.env.REFACTOR_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server does not keep the process alive by default and close() stops it', async () => {
  const { server, state, close } = await start({ port: 0, quiet: true });
  assert.strictEqual(server.listening, true);
  assert.strictEqual(state.watchTimer.hasRef(), false);
  await close();
  assert.strictEqual(server.listening, false);
});

test('/rl-weights.json and /calibration.json follow the session target_repo', async () => {
  const { saveWeights } = require('../src/rl/classifier');
  const calibration = require('../src/rl/calibration');
  const repoA = path.join(os.tmpdir(), 'sg6-server-a');
  const repoB = path.join(os.tmpdir(), 'sg6-server-b');
  saveWeights({ w: [1, 2, 3, 4], b: 0, marker: 'A' }, repoA);
  saveWeights({ w: [4, 3, 2, 1], b: 0, marker: 'B' }, repoB);
  calibration.fitFromProposals(fakeProposals(), repoA);
  const { server, close } = await start({ port: 0, quiet: true });
  try {
    const { port } = server.address();
    saveSession(freshSession(repoA));
    assert.strictEqual(JSON.parse((await get(port, '/rl-weights.json')).body).marker, 'A');
    assert(Array.isArray(JSON.parse((await get(port, '/calibration.json')).body).xs));
    saveSession(freshSession(repoB));
    assert.strictEqual(JSON.parse((await get(port, '/rl-weights.json')).body).marker, 'B');
    assert.strictEqual(JSON.parse((await get(port, '/calibration.json')).body), null);
  } finally {
    await close();
  }
});
