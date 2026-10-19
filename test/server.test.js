'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { start } = require('../src/interpretability/server');
const { freshSession, saveSession } = require('../src/utils/checkpoint');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', d => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('server starts on ephemeral port and serves /healthz + /session.json', async () => {
  const sess = freshSession('/tmp/repo');
  saveSession(sess);
  const { server, state } = await start({ port: 0 });
  try {
    const { port } = server.address();
    const health = await get(port, '/healthz');
    const s = await get(port, '/session.json');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(JSON.parse(s.body).run_id, sess.run_id);
  } finally {
    clearInterval(state.watchTimer);
    server.close();
  }
});
