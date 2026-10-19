'use strict';

// Aider-style 4-tier anchor matching for SEARCH/REPLACE edits.
// Tiers, tried in order; each must find exactly one location or the
// whole match fails (an ambiguous tier never falls through):
//   1. exact          — byte-identical substring search
//   2. indent-shift   — the anchor's lines appear verbatim under a different
//                       leading-whitespace prefix (spaces or tabs)
//   3. whitespace     — collapse all runs of whitespace to single spaces
//                       on both sides; map back to original byte ranges
//   4. fuzzy          — line-window similarity (bounded Levenshtein over
//                       collapsed text); accepted only when the window is
//                       token-identical to the anchor and no other window
//                       scores within `ambiguityMargin` of it
//
// Returns { tier, start, end, ... } on success, throws AnchorError on
// failure with a descriptive reason and `detail` (so the orchestrator can
// fold it into failure_class / apply_failed).

class AnchorError extends Error {
  constructor(message, { tier, detail } = {}) {
    super(message);
    this.tier = tier;
    this.detail = detail;
  }
}

function isWs(code) {
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)));
}

function allIndexes(haystack, needle) {
  const out = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function exactMatch(haystack, needle) {
  const idxs = allIndexes(haystack, needle);
  if (!idxs.length) return null;
  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };
  return { start: idxs[0], end: idxs[0] + needle.length };
}

// The needle is trimmed, so the matched range never swallows surrounding
// newlines/indentation: it starts and ends on non-whitespace characters.
function whitespaceMatch(haystack, needle) {
  const trimmed = needle.trim();
  if (!trimmed) return null;
  const H = haystack.replace(/\s+/g, ' ');
  const N = trimmed.replace(/\s+/g, ' ');
  const idxs = allIndexes(H, N);
  if (!idxs.length) return null;
  if (idxs.length > 1) return { ambiguous: true, count: idxs.length };
  // Walk the original once to map collapsed offsets back to source offsets
  // (same mapping as collapseWithMap, without materializing it).
  const want0 = idxs[0];
  const want1 = idxs[0] + N.length - 1;
  let start = -1;
  let c = 0;
  let i = 0;
  while (i < haystack.length) {
    if (c === want0) start = i;
    if (c === want1) return { start, end: i + 1 };
    if (isWs(haystack.charCodeAt(i))) {
      while (i < haystack.length && isWs(haystack.charCodeAt(i))) i++;
    } else {
      i++;
    }
    c++;
  }
  return null;
}

function leadingWs(line) {
  return /^[ \t]*/.exec(line)[0];
}

function isBlank(line) {
  return !line.trim();
}

function commonIndentString(lines) {
  let common = null;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (common === null) { common = ws; continue; }
    let k = 0;
    while (k < common.length && k < ws.length && common[k] === ws[k]) k++;
    common = common.slice(0, k);
    if (!common) break;
  }
  return common || '';
}

// Back-compat numeric helper: smallest leading-whitespace width.
function commonLeftIndent(text) {
  return commonIndentString(text.split('\n')).length;
}

// Replace the leading `from` prefix of every non-blank line with `to`.
// Lines that do not carry the full prefix lose whatever leading
// whitespace they have and get `to`.
function shiftIndent(text, from, to) {
  if (from === to) return text;
  return text.split('\n').map((l) => {
    if (isBlank(l)) return l.length ? '' : l;
    const rest = l.startsWith(from) ? l.slice(from.length) : l.slice(leadingWs(l).length);
    return to + rest;
  }).join('\n');
}

function lineOffsets(lines) {
  const offs = new Array(lines.length);
  let o = 0;
  for (let i = 0; i < lines.length; i++) {
    offs[i] = o;
    o += lines[i].length + 1;
  }
  return offs;
}

// Find every location where the anchor's lines appear with their common
// leading whitespace replaced by some other whitespace string P (tabs or
// spaces). Matches start at a line boundary. More than one location —
// whether from the same P or different ones — is ambiguous.
function indentShiftMatch(haystack, needle) {
  const nLines = needle.split('\n');
  if (isBlank(nLines[0])) return null;
  const C = commonIndentString(nLines);
  const dl = nLines.map((l) => (isBlank(l) ? '' : l.slice(C.length)));
  const L = nLines.length - 1;
  const trailingEmpty = L > 0 && nLines[L] === '';
  const first = dl[0];
  const hLines = haystack.split('\n');
  const offs = lineOffsets(hLines);
  const found = [];
  for (let i = 0; i < hLines.length; i++) {
    const h = hLines[i];
    if (!h.endsWith(first)) continue;
    const P = h.slice(0, h.length - first.length);
    if (!/^[ \t]*$/.test(P)) continue;
    let ok = true;
    let end = offs[i] + h.length;
    for (let k = 1; k <= L; k++) {
      if (k === L && trailingEmpty) {
        if (i + k >= hLines.length) { ok = false; break; }
        end = offs[i + k];
        break;
      }
      const hk = hLines[i + k];
      if (hk === undefined) { ok = false; break; }
      if (isBlank(nLines[k])) {
        if (!isBlank(hk)) { ok = false; break; }
        end = offs[i + k] + hk.length;
        continue;
      }
      const want = P + dl[k];
      if (k === L ? !hk.startsWith(want) : hk !== want) { ok = false; break; }
      end = offs[i + k] + (k === L ? want.length : hk.length);
    }
    if (!ok) continue;
    found.push({ start: offs[i], end, indent: P });
  }
  if (!found.length) return null;
  if (found.length > 1) {
    return { ambiguous: true, count: found.length, deltas: [...new Set(found.map(f => f.indent.length - C.length))] };
  }
  const m = found[0];
  return { start: m.start, end: m.end, delta: m.indent.length - C.length, indent: m.indent, anchorIndent: C };
}

// Numeric shift kept for callers of the old API (spaces only).
function reindent(text, delta) {
  if (delta === 0) return text;
  if (delta > 0) return shiftIndent(text, '', ' '.repeat(delta));
  const trim = -delta;
  return text.split('\n').map((l) => {
    let k = 0;
    while (k < trim && k < l.length && l[k] === ' ') k++;
    return l.slice(k);
  }).join('\n');
}

function collapseWS(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const TOKEN_RE = new RegExp([
  '[A-Za-z_$\\u00c0-\\uffff][\\w$\\u00c0-\\uffff]*',      // identifiers / keywords
  '\\d[\\w.]*',                                           // numbers
  '"(?:\\\\.|[^"\\\\\\n])*"?',                            // string literals
  "'(?:\\\\.|[^'\\\\\\n])*'?",
  '`(?:\\\\.|[^`\\\\])*`?',
  '>>>=|===|!==|\\*\\*=|<<=|>>=|>>>|\\.\\.\\.|\\?\\?=|&&=|\\|\\|=',
  '=>|==|!=|<=|>=|&&|\\|\\||\\?\\?|\\?\\.|\\+\\+|--|\\*\\*|<<|>>|->|::|//|[-+*/%&|^]=',
  '\\S'                                                   // any other punctuation
].join('|'), 'g');

function tokenize(s) {
  return s.match(TOKEN_RE) || [];
}

function tokensEqual(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
  return true;
}

// Levenshtein distance. With `maxDist`, only a diagonal band of width
// 2*maxDist+1 is computed and the result is capped at maxDist+1 (meaning
// "more than maxDist"), so cost is O(min(m,n) * maxDist) instead of O(m*n).
let rowA = new Int32Array(256);
let rowB = new Int32Array(256);
function levenshtein(a, b, maxDist = Infinity) {
  if (a === b) return 0;
  let m = a.length, n = b.length;
  if (m > n) { const t = a; a = b; b = t; m = a.length; n = b.length; }
  const k = Math.min(maxDist, n);
  if (n - m > k) return k + 1;
  if (m === 0) return n;
  const BIG = k + 1;
  if (rowA.length < n + 1) { rowA = new Int32Array(2 * (n + 1)); rowB = new Int32Array(2 * (n + 1)); }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= n; j++) prev[j] = j <= k ? j : BIG;
  for (let i = 1; i <= m; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(n, i + k);
    cur[lo - 1] = lo - 1 === 0 ? (i <= k ? i : BIG) : BIG;
    let rowMin = cur[lo - 1];
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (j <= i - 1 + k ? prev[j] : BIG) + 1;
      const ins = cur[j - 1] + 1;
      let v = sub < del ? sub : del;
      if (ins < v) v = ins;
      if (v > BIG) v = BIG;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < n) cur[hi + 1] = BIG;
    if (rowMin >= BIG) return BIG;
    const t = prev; prev = cur; cur = t;
  }
  return prev[n] > BIG ? BIG : prev[n];
}

function similarity(a, b, minRatio = 0) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const max = Math.max(a.length, b.length);
  const k = Math.floor((1 - minRatio) * max);
  const lev = levenshtein(a, b, k);
  if (lev > k) return 0;
  return 1 - lev / max;
}

function charHist(s) {
  const h = new Int32Array(128);
  for (let i = 0; i < s.length; i++) h[Math.min(127, s.charCodeAt(i))]++;
  return h;
}

// Each edit changes the character multiset's L1 distance by at most 2, so
// ceil(L1/2) is a cheap lower bound on the Levenshtein distance.
const bagWork = new Int32Array(128);
function bagDistanceLowerBound(s, targetHist) {
  bagWork.set(targetHist);
  for (let i = 0; i < s.length; i++) bagWork[Math.min(127, s.charCodeAt(i))]--;
  let l1 = 0;
  for (let c = 0; c < 128; c++) l1 += bagWork[c] < 0 ? -bagWork[c] : bagWork[c];
  return Math.ceil(l1 / 2);
}

function trimBlankEdges(lines) {
  let s = 0, e = lines.length;
  while (s < e && isBlank(lines[s])) s++;
  while (e > s && isBlank(lines[e - 1])) e--;
  return lines.slice(s, e);
}

// Line-window fuzzy match. Windows of N = (non-blank-edged) anchor lines
// are scored by 1 - lev/maxLen over collapsed whitespace; only windows
// scoring >= minRatio - ambiguityMargin are computed exactly (banded).
// Returns:
//   null                                   nothing near the threshold
//   { below: true, closest }               best < minRatio
//   { ambiguous: true, closest, runnerUp } another non-overlapping window
//                                          within ambiguityMargin of best
//   { mismatch: true, closest }            best window not token-identical
//   { start, end, score }                  accepted
function fuzzyMatch(haystack, needle, { minRatio = 0.85, ambiguityMargin = 0.02 } = {}) {
  const nLines = trimBlankEdges(needle.split('\n'));
  if (!nLines.length) return null;
  const N = nLines.length;
  const anchorText = nLines.join('\n');
  const target = collapseWS(anchorText);
  const hLines = haystack.split('\n');
  const offs = lineOffsets(hLines);
  const cl = hLines.map(collapseWS);
  const targetHist = charHist(target);
  const floor = Math.max(0, minRatio - ambiguityMargin);
  // The band only needs to cover windows that can still matter: those
  // scoring >= max(floor, bestSoFar - margin). Since bestSoFar only rises,
  // every window within the margin of the final best is scored exactly.
  let bestSoFar = 0;
  let cands = [];
  for (let i = 0; i + N <= hLines.length; i++) {
    if (!cl[i] || !cl[i + N - 1]) continue;
    let w = cl[i];
    for (let j = i + 1; j < i + N; j++) if (cl[j]) w += ' ' + cl[j];
    const maxLen = Math.max(w.length, target.length);
    const need = Math.max(floor, bestSoFar - ambiguityMargin);
    const k = Math.floor((1 - need) * maxLen + 1e-9);
    if (Math.abs(w.length - target.length) > k) continue;
    if (bagDistanceLowerBound(w, targetHist) > k) continue;
    const d = levenshtein(w, target, k);
    if (d > k) continue;
    const score = 1 - d / maxLen;
    if (score + 1e-12 < need) continue;
    cands.push({ line: i, score });
    if (score > bestSoFar) bestSoFar = score;
  }
  cands = cands.filter(c => c.score + 1e-12 >= Math.max(floor, bestSoFar - ambiguityMargin));
  if (!cands.length) return null;
  let best = cands[0];
  for (const c of cands) if (c.score > best.score) best = c;
  const span = (c) => {
    const lastLine = hLines[c.line + N - 1];
    const start = offs[c.line];
    const end = offs[c.line + N - 1] + lastLine.replace(/\s+$/, '').length;
    return { start, end, score: Number(c.score.toFixed(4)), line: c.line + 1 };
  };
  const closest = span(best);
  if (best.score < minRatio) return { below: true, closest };
  let runnerUp = null;
  for (const c of cands) {
    if (c === best || Math.abs(c.line - best.line) < N) continue;
    if (!runnerUp || c.score > runnerUp.score) runnerUp = c;
  }
  if (runnerUp && runnerUp.score >= best.score - ambiguityMargin - 1e-12) {
    return { ambiguous: true, closest, runnerUp: span(runnerUp) };
  }
  if (!tokensEqual(haystack.slice(closest.start, closest.end), anchorText)) {
    return { mismatch: true, closest };
  }
  return { start: closest.start, end: closest.end, score: best.score };
}

function describeClosest(c) {
  return c ? ` (closest: line ${c.line}, offsets ${c.start}-${c.end}, score ${c.score})` : '';
}

function findAnchor(haystack, needle) {
  if (!needle) throw new AnchorError('empty anchor', { tier: 'none' });

  // 1. exact
  let r = exactMatch(haystack, needle);
  if (r && !r.ambiguous) return { tier: 'exact', start: r.start, end: r.end };
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (exact); ambiguous`, { tier: 'exact', detail: { occurrences: r.count } });
  }

  // 2. indent-shift (line-structure preserving, so tried before whitespace)
  r = indentShiftMatch(haystack, needle);
  if (r && !r.ambiguous) {
    return { tier: 'indent-shift', start: r.start, end: r.end, delta: r.delta, indent: r.indent, anchorIndent: r.anchorIndent };
  }
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (indent-shift); ambiguous`, { tier: 'indent-shift', detail: { occurrences: r.count, deltas: r.deltas } });
  }

  // 3. whitespace-normalized
  r = whitespaceMatch(haystack, needle);
  if (r && !r.ambiguous) return { tier: 'whitespace', start: r.start, end: r.end };
  if (r && r.ambiguous) {
    throw new AnchorError(`anchor matches ${r.count} locations (whitespace-norm); ambiguous`, { tier: 'whitespace', detail: { occurrences: r.count } });
  }

  // 4. fuzzy
  r = fuzzyMatch(haystack, needle);
  if (r && r.ambiguous) {
    throw new AnchorError(`fuzzy anchor ambiguous: runner-up within 0.02 of best${describeClosest(r.closest)}`, { tier: 'fuzzy', detail: { closest: r.closest, runner_up: r.runnerUp } });
  }
  if (r && r.mismatch) {
    throw new AnchorError(`fuzzy anchor rejected: closest window is not token-identical to the anchor${describeClosest(r.closest)}`, { tier: 'fuzzy', detail: { closest: r.closest } });
  }
  if (r && !r.below) return { tier: 'fuzzy', start: r.start, end: r.end, score: r.score };

  const closest = r && r.below ? r.closest : null;
  throw new AnchorError(`anchor not found at any tier${describeClosest(closest)}`, { tier: 'none', detail: { closest } });
}

// ---- replacement re-indentation (shared by indent-shift / whitespace / fuzzy)

function indentUnit(lines, base) {
  let minSpaces = Infinity;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (!ws.startsWith(base) || ws.length === base.length) continue;
    if (l.slice(ws.length).startsWith('*')) continue; // block-comment continuation
    const rel = ws.slice(base.length);
    if (rel[0] === '\t') return '\t';
    if (/^ +$/.test(rel) && rel.length >= 2) minSpaces = Math.min(minSpaces, rel.length);
  }
  return Number.isFinite(minSpaces) ? ' '.repeat(minSpaces) : null;
}

function fileIndentUnit(src) {
  const lines = src.split('\n', 5000);
  let tabs = 0, spaced = 0;
  const steps = new Map();
  let prev = 0;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const ws = leadingWs(l);
    if (ws[0] === '\t') tabs++;
    else if (ws.length) spaced++;
    if (!ws.includes('\t') && !l.slice(ws.length).startsWith('*')) {
      const step = ws.length - prev;
      if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) || 0) + 1);
      prev = ws.length;
    }
  }
  if (tabs > spaced) return '\t';
  let best = null, bestN = 0;
  for (const [s, n] of steps) if (n > bestN) { best = s; bestN = n; }
  return best ? ' '.repeat(best) : null;
}

function convertRel(rel, from, to) {
  if (!rel || !from || !to || from === to) return rel;
  const levels = rel.length / from.length;
  if (Number.isInteger(levels) && from.repeat(levels) === rel) return to.repeat(levels);
  return rel;
}

// Re-indent `replacement` so it lands at the indentation of the region
// `match` selected in `src`. `anchor` is the current_code the match was
// made from (its first non-blank line defines the anchor's base indent).
function reindentReplacement(src, match, anchor, replacement) {
  if (!match || match.tier === 'exact') return replacement;
  if (match.tier === 'indent-shift') {
    return shiftIndent(replacement, match.anchorIndent || '', match.indent || '');
  }
  const repLines = trimBlankEdges(replacement.replace(/\s+$/, '').split('\n'));
  if (!repLines.length) return '';
  const lineStart = src.lastIndexOf('\n', match.start - 1) + 1;
  const before = src.slice(lineStart, match.start);
  const lineEnd = src.indexOf('\n', lineStart);
  const firstLine = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd);
  const targetBase = leadingWs(firstLine);
  const inline = /^[ \t]*$/.test(before);

  const aLines = anchor.split('\n');
  const aFirst = aLines.find(l => !isBlank(l)) || '';
  const anchorBase = leadingWs(aFirst);
  const regionLines = src.slice(lineStart, match.end).split('\n');
  const anchorUnit = indentUnit(aLines, anchorBase) || indentUnit(repLines, anchorBase);
  let targetUnit = indentUnit(regionLines, targetBase);
  if (!targetUnit) targetUnit = targetBase.includes('\t') ? '\t' : fileIndentUnit(src);

  const out = repLines.map((l) => {
    if (isBlank(l)) return '';
    const ws = leadingWs(l);
    const rest = l.slice(ws.length);
    const rel = ws.startsWith(anchorBase) ? ws.slice(anchorBase.length) : '';
    return targetBase + convertRel(rel, anchorUnit, targetUnit) + rest;
  });
  out[0] = inline ? out[0].slice(before.length) : out[0].slice(leadingWs(out[0]).length);
  return out.join('\n');
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
  collapseWS,
  tokenize,
  tokensEqual,
  shiftIndent,
  reindent,
  commonLeftIndent,
  reindentReplacement
};
