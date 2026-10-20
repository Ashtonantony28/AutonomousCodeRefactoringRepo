'use strict';

// AUDIT-11: loaded with `node -r` (NODE_OPTIONS) by audit/11/flaky.js.
// Shuffles the order of the top-level tests inside each test file: the
// `test` function a test file gets from require('node:test') queues its
// calls while the file loads, then registers them in a seeded random order
// (AUDIT11_SEED). Hooks (test.after, test.afterEach, ...) pass straight
// through. Node 22 has no built-in test shuffling.
const Module = require('module');

const SEED = Number(process.env.AUDIT11_SEED || 1);
function rng(seed) {
  let s = Math.imul(seed, 2654435761) >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 16; i++) next();
  return next;
}

const origRequire = Module.prototype.require;
let wrapped = null;
Module.prototype.require = function (id) {
  const real = origRequire.apply(this, arguments);
  if ((id !== 'node:test' && id !== 'test') || !/\.test\.js$/.test(this.filename || '')) return real;
  if (wrapped) return wrapped;
  const queue = [];
  let scheduled = false;
  const flush = () => {
    const r = rng(SEED);
    for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
    if (process.env.AUDIT11_SHOW_ORDER) console.error(`[shuffle ${SEED}] ${queue.map(a => a[0]).join(' | ')}`);
    for (const args of queue) real(...args);
  };
  wrapped = function shuffledTest(...args) {
    queue.push(args);
    if (!scheduled) { scheduled = true; setImmediate(flush); }
  };
  for (const k of Object.keys(real)) wrapped[k] = real[k];
  wrapped.test = wrapped;
  for (const k of ['after', 'afterEach', 'before', 'beforeEach', 'skip', 'todo', 'only', 'mock', 'describe', 'it', 'suite', 'run', 'snapshot']) {
    if (k in real) wrapped[k] = real[k];
  }
  return wrapped;
};
