'use strict';

const fs = require('fs');
const path = require('path');
const { findAnchor, AnchorError, reindentReplacement } = require('./anchor-matcher');

class FileSnapshot {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.snapshots = new Map();
  }

  capture(relPath) {
    const abs = path.join(this.repoRoot, relPath);
    if (this.snapshots.has(relPath)) return;
    if (!fs.existsSync(abs)) {
      this.snapshots.set(relPath, { existed: false, content: null });
      return;
    }
    const content = fs.readFileSync(abs, 'utf8');
    this.snapshots.set(relPath, { existed: true, content });
  }

  restore(relPath) {
    const abs = path.join(this.repoRoot, relPath);
    const snap = this.snapshots.get(relPath);
    if (!snap) return false;
    if (snap.existed) {
      fs.writeFileSync(abs, snap.content);
    } else if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
    }
    return true;
  }

  restoreAll() {
    let count = 0;
    for (const rel of this.snapshots.keys()) {
      if (this.restore(rel)) count++;
    }
    return count;
  }
}

function applyEdit({ repoRoot, relPath, currentCode, proposedCode }) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`target file does not exist: ${relPath}`);
  }
  const src = fs.readFileSync(abs, 'utf8');

  let match;
  try {
    match = findAnchor(src, currentCode);
  } catch (err) {
    if (err instanceof AnchorError) {
      const e = new Error(`anchor match failed in ${relPath}: ${err.message}`);
      e.tier = err.tier;
      e.detail = err.detail;
      throw e;
    }
    throw err;
  }

  // Non-exact tiers: re-indent the replacement to the matched region's
  // indentation (tab-aware; shared helper with the indent-shift tier).
  const replacement = reindentReplacement(src, match, currentCode, proposedCode);

  const next = src.slice(0, match.start) + replacement + src.slice(match.end);
  fs.writeFileSync(abs, next);
  return {
    bytesBefore: src.length,
    bytesAfter: next.length,
    matchTier: match.tier,
    matchScore: match.score == null ? null : match.score,
    matchDelta: match.delta == null ? null : match.delta,
    matchStart: match.start,
    matchEnd: match.end,
    reindented: replacement !== proposedCode
  };
}

module.exports = { FileSnapshot, applyEdit };
