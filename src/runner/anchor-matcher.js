'use strict';

// Aider-style 4-tier anchor matching for SEARCH/REPLACE edits.
// Tiers, tried in order, return as soon as a unique match is found:
//   1. exact          — byte-identical substring search
//   2. whitespace     — collapse all runs of whitespace to single spaces
//                       on both sides; map back to original byte ranges
//   3. indent-shift   — current_code uses one indentation level, target
//                       file uses another; try every common left-trim
//                       shift on the anchor before matching
//   4. fuzzy          — line-by-line difflib-style similarity ratio over
//                       sliding windows of N=len(anchor lines)
//
// Returns { tier, start, end } on success, throws AnchorError on failure
// with a descriptive reason (so the orchestrator can fold into
// failure_class).

class AnchorError extends Error {
  constructor(message, { tier, detail } = {}) {
    super(message);
    this.tier = tier;
    this.detail = detail;
  }
}

function exactMatch(haystack, needle) {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  const occ = haystack.split(needle).length - 1;
  if (occ > 1) return { ambiguous: true, count: occ };
  return { start: idx, end: idx + needle.length };
}

// Collapse \s+ to ' ' and remember the original-offset for each
// collapsed-string position, so we can map a match back to the original
// source's byte range.
function collapseWithMap(s) {
  const out = [];
  const map = [];           // map[i] = original index of collapsed char i
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      // emit a single space, record offset
      out.push(' ');
      map.push(i);
      while (i < s.length && /\s/.test(s[i])) i++;
    } else {
      out.push(c);
      map.push(i);
      i++;
    }
  }
  return { collapsed: out.join(''), map };
}

function whitespaceMatch(haystack, needle) {
  const H = collapseWithMap(haystack);
  const N = collapseWithMap(needle);
  if (!N.collapsed.length) return null;
  const idx = H.collapsed.indexOf(N.collapsed);
  if (idx === -1) return null;
  const occ = H.collapsed.split(N.collapsed).length - 1;
  if (occ > 1) return { ambiguous: true, count: occ };
  const start = H.map[idx];
  // end maps to the index of the last collapsed char of needle, plus run length
  const lastCollapsed = idx + N.collapsed.length - 1;
  let endOrig = H.map[lastCollapsed];
  // advance endOrig over the trailing whitespace run if needle ended in one
  if (/\s/.test(N.collapsed[N.collapsed.length - 1])) {
    while (endOrig < haystack.length && /\s/.test(haystack[endOrig])) endOrig++;
  } else {
    endOrig += 1;
  }
  return { start, end: endOrig };
}

function commonLeftIndent(text) {
  const lines = text.split('\n').filter(l => l.trim().length);
  if (!lines.length) return 0;
  let min = Infinity;
  for (const l of lines) {
    const m = l.match(/^(\s*)/);
    min = Math.min(min, m ? m[1].length : 0);
  }
  return Number.isFinite(min) ? min : 0;
}

function reindent(text, delta) {
  if (delta === 0) return text;
  const lines = text.split('\n');
  if (delta > 0) {
    const pad = ' '.repeat(delta);
    return lines.map(l => l.length ? pad + l : l).join('\n');
  }
  const trim = -delta;
  return lines.map(l => {
    let k = 0;
    while (k < trim && k < l.length && l[k] === ' ') k++;
    return l.slice(k);
  }).join('\n');
}

function indentShiftMatch(haystack, needle) {
  const needleIndent = commonLeftIndent(needle);
  // Try a range of shifts: -needleIndent .. +12 spaces.
  for (let delta = -needleIndent; delta <= 12; delta++) {
    if (delta === 0) continue;
    const shifted = reindent(needle, delta);
    const r = exactMatch(haystack, shifted);
    if (r && !r.ambiguous) return { ...r, delta };
  }
  return null;
}

// Line-based fuzzy match: slide a window of N=needleLines.length over the
// haystack and pick the window with the highest similarity ratio
// (1 - normalized Levenshtein over collapsed-whitespace lines), provided
// it crosses a threshold.
function fuzzyMatch(haystack, needle, { minRatio = 0.85 } = {}) {
  const hLines = haystack.split('\n');
  const nLines = needle.split('\n');
  if (!nLines.length) return null;
  const N = nLines.length;
  let best = { score: 0, line: -1 };
  for (let i = 0; i + N <= hLines.length; i++) {
    const window = hLines.slice(i, i + N).join('\n');
    const score = similarity(collapseWS(window), collapseWS(needle));
    if (score > best.score) best = { score, line: i };
  }
  if (best.score < minRatio || best.line === -1) return null;
  // compute byte offsets of the matched window
  let start = 0;
  for (let i = 0; i < best.line; i++) start += hLines[i].length + 1;
  let end = start;
  for (let i = best.line; i < best.line + N; i++) {
    end += hLines[i].length + (i < best.line + N - 1 ? 1 : 0);
  }
  return { start, end, score: best.score };
}

function collapseWS(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const lev = levenshtein(a, b);
  const max = Math.max(a.length, b.length);
  return 1 - lev / max;
}

function levenshtein(a, b) {
  if (a.length > 200) a = a.slice(0, 200);
  if (b.length > 200) b = b.slice(0, 200);
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function findAnchor(haystack, needle) {
  if (!needle) throw new AnchorError('empty anchor', { tier: 'none' });

  // 1. exact
  let r = exactMatch(haystack, needle);
  if (r && !r.ambiguous) return { tier: 'exact', start: r.start, end: r.end };
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (exact); ambiguous`, { tier: 'exact', detail: { occurrences: r.count } });
  }

  // 2. whitespace-normalized
  r = whitespaceMatch(haystack, needle);
  if (r && !r.ambiguous) return { tier: 'whitespace', start: r.start, end: r.end };
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (whitespace-norm); ambiguous`, { tier: 'whitespace', detail: { occurrences: r.count } });
  }

  // 3. indent-shift
  r = indentShiftMatch(haystack, needle);
  if (r) return { tier: 'indent-shift', start: r.start, end: r.end, delta: r.delta };

  // 4. fuzzy
  r = fuzzyMatch(haystack, needle);
  if (r) return { tier: 'fuzzy', start: r.start, end: r.end, score: r.score };

  throw new AnchorError('anchor not found at any tier', { tier: 'none' });
}

module.exports = {
  findAnchor,
  AnchorError,
  exactMatch,
  whitespaceMatch,
  indentShiftMatch,
  fuzzyMatch,
  similarity,
  levenshtein,
  collapseWS
};
