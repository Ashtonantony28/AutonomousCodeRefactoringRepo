'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert');
const { discover } = require('../src/utils/file-discovery');
const { makeTempRepo } = require('./helpers/factories');
const { rm } = require('./helpers/env');

test('discovers index.js in temp repo', (t) => {
  const repo = makeTempRepo();
  t.after(() => rm(repo));
  const files = discover(repo);
  assert(files.find(f => f.relative === 'index.js'));
});
