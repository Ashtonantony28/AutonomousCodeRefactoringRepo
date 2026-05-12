'use strict';

// Cluster failed proposals by their text signature (current_code +
// proposed_code + critic reasoning + failure stderr tail) using TF-IDF
// vectors and a small spherical k-means. Produces a label per cluster
// chosen via tf-idf top terms, so the dashboard can show "what kinds of
// refactors are failing".
//
// Pure JS, no embeddings API needed. Roughly O(n * vocab) for n < a few
// hundred failures, which is our realistic ceiling per session.

const STOPWORDS = new Set(('the of and a in to is it that this for with as on by be at or are from but not have which an if any all '
  + 'will may can has was its were been being so do does did when then them their there these those into out up down over').split(' '));

function tokenize(s) {
  if (!s) return [];
  return s.toLowerCase()
    .replace(/[^a-z0-9_$]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
}

function termFrequency(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function buildVocab(docs, { maxVocab = 800, minDf = 2 } = {}) {
  const df = new Map();
  for (const doc of docs) {
    const seen = new Set();
    for (const t of doc) if (!seen.has(t)) { df.set(t, (df.get(t) || 0) + 1); seen.add(t); }
  }
  const entries = [...df.entries()].filter(([, c]) => c >= minDf).sort((a, b) => b[1] - a[1]);
  const vocab = new Map();
  for (let i = 0; i < Math.min(maxVocab, entries.length); i++) vocab.set(entries[i][0], i);
  const idf = new Float64Array(vocab.size);
  const N = docs.length || 1;
  for (const [term, idx] of vocab.entries()) idf[idx] = Math.log((N + 1) / ((df.get(term) || 1) + 1)) + 1;
  return { vocab, idf };
}

function tfidf(docTokens, vocab, idf) {
  const v = new Float64Array(vocab.size);
  const tf = termFrequency(docTokens);
  for (const [term, count] of tf.entries()) {
    const idx = vocab.get(term);
    if (idx == null) continue;
    v[idx] = count * idf[idx];
  }
  normalize(v);
  return v;
}

function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Spherical k-means: cluster L2-normalized vectors by cosine similarity.
function kmeans(vectors, k, { maxIters = 30, seed = 42 } = {}) {
  if (!vectors.length) return { assignments: [], centroids: [] };
  k = Math.min(k, vectors.length);
  // k-means++ init
  const rng = mulberry32(seed);
  const centroids = [vectors[Math.floor(rng() * vectors.length)].slice()];
  while (centroids.length < k) {
    const dists = vectors.map(v => {
      let best = 0;
      for (const c of centroids) best = Math.max(best, cosine(v, c));
      return Math.max(0, 1 - best);
    });
    const total = dists.reduce((a, b) => a + b, 0) || 1;
    let r = rng() * total;
    let idx = 0;
    for (let i = 0; i < dists.length; i++) { r -= dists[i]; if (r <= 0) { idx = i; break; } }
    centroids.push(vectors[idx].slice());
  }

  let assignments = new Array(vectors.length).fill(0);
  for (let it = 0; it < maxIters; it++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let bestK = 0, bestS = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const s = cosine(vectors[i], centroids[c]);
        if (s > bestS) { bestS = s; bestK = c; }
      }
      if (assignments[i] !== bestK) { assignments[i] = bestK; changed = true; }
    }
    // Update centroids
    const sums = Array.from({ length: centroids.length }, () => new Float64Array(centroids[0].length));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let j = 0; j < vectors[i].length; j++) sums[c][j] += vectors[i][j];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      centroids[c] = sums[c];
      normalize(centroids[c]);
    }
    if (!changed) break;
  }
  return { assignments, centroids };
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function topTerms(centroid, vocab, n = 6) {
  const reverse = new Map();
  for (const [t, i] of vocab.entries()) reverse.set(i, t);
  const pairs = [];
  for (let i = 0; i < centroid.length; i++) if (centroid[i] > 0) pairs.push([reverse.get(i), centroid[i]]);
  pairs.sort((a, b) => b[1] - a[1]);
  return pairs.slice(0, n).map(p => p[0]);
}

function docOfProposal(p) {
  const verdict = p.critic_verdict || {};
  const out = (p.test_outcome && (p.test_outcome.stderr_tail || p.test_outcome.stdout_tail || '')) || '';
  return [p.current_code || '', p.proposed_code || '', verdict.reasoning || '', out].join(' ');
}

function clusterFailures(proposals, { k = 4 } = {}) {
  const failed = proposals.filter(p => p.test_outcome && ['failed', 'reverted', 'apply_failed', 'timeout', 'environment_error'].includes(p.test_outcome.status));
  if (failed.length < 4) return { clusters: [], reason: `not enough failures (${failed.length})` };
  const tokens = failed.map(p => tokenize(docOfProposal(p)));
  const { vocab, idf } = buildVocab(tokens);
  if (vocab.size === 0) return { clusters: [], reason: 'empty vocab' };
  const vecs = tokens.map(t => tfidf(t, vocab, idf));
  const { assignments, centroids } = kmeans(vecs, k);
  const groups = Array.from({ length: centroids.length }, () => []);
  for (let i = 0; i < assignments.length; i++) groups[assignments[i]].push(failed[i]);
  return {
    clusters: groups.map((members, idx) => ({
      cluster_id: idx,
      size: members.length,
      label: topTerms(centroids[idx], vocab, 5).join(' / ') || `cluster ${idx}`,
      exemplars: members.slice(0, 3).map(p => ({ issue_id: p.issue_id, file: p.file }))
    })).filter(c => c.size > 0)
  };
}

module.exports = { clusterFailures, tokenize, tfidf, buildVocab, kmeans, cosine, topTerms };
