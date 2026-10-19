'use strict';

const fs = require('fs');
const path = require('path');
const { findAnchor, AnchorError, reindentReplacement, langOf } = require('./anchor-matcher');

// Snapshots of files about to be edited. With `persistPath` the snapshot is
// also written to disk (atomically) before any edit so a crash-restart can
// restore it; live snapshots are tracked so a signal handler can revert them.
const live = new Set();

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

class FileSnapshot {
  constructor(repoRoot, { persistPath = null, meta = null } = {}) {
    this.repoRoot = repoRoot;
    this.persistPath = persistPath;
    this.meta = meta;
    this.snapshots = new Map();
    live.add(this);
  }

  capture(relPath) {
    const abs = path.join(this.repoRoot, relPath);
    if (this.snapshots.has(relPath)) return;
    if (!fs.existsSync(abs)) {
      this.snapshots.set(relPath, { existed: false, content: null });
    } else {
      this.snapshots.set(relPath, { existed: true, content: fs.readFileSync(abs, 'utf8') });
    }
    this.persist();
  }

  persist() {
    if (!this.persistPath) return;
    writeJsonAtomic(this.persistPath, {
      repo_root: this.repoRoot,
      meta: this.meta,
      files: Object.fromEntries(this.snapshots),
      captured_at: new Date().toISOString()
    });
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
    this.release();
    return count;
  }

  // The edit is final (kept or committed): drop the snapshot without restoring.
  release() {
    live.delete(this);
    this.snapshots.clear();
    if (this.persistPath) {
      try { fs.unlinkSync(this.persistPath); } catch { /* */ }
    }
  }

  static restoreLive() {
    let count = 0;
    for (const snap of [...live]) {
      try { count += snap.restoreAll(); } catch { /* */ }
    }
    return count;
  }

  // Restore a snapshot persisted by a process that died mid-edit.
  static restoreFromDisk(persistPath) {
    if (!persistPath || !fs.existsSync(persistPath)) return null;
    let data;
    try { data = JSON.parse(fs.readFileSync(persistPath, 'utf8')); } catch { data = null; }
    if (!data || !data.repo_root || !data.files) {
      try { fs.unlinkSync(persistPath); } catch { /* */ }
      return null;
    }
    const snap = new FileSnapshot(data.repo_root);
    for (const [rel, entry] of Object.entries(data.files)) snap.snapshots.set(rel, entry);
    const restored = snap.restoreAll();
    try { fs.unlinkSync(persistPath); } catch { /* */ }
    return { repo_root: data.repo_root, meta: data.meta || null, files: Object.keys(data.files), restored };
  }
}

// Where `currentCode` lands in `src` and what replaces it there.
// -> { match, region, replacement }; throws (with tier/detail) when the
// anchor matcher refuses.
function resolveEdit({ src, relPath, currentCode, proposedCode }) {
  let match;
  try {
    match = findAnchor(src, currentCode, { lang: langOf(relPath) });
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
  return { match, region: src.slice(match.start, match.end), replacement };
}

// `expectedRegion`: the text the validators judged; the edit is refused
// (tier 'region') unless the matched region is exactly that text.
function applyEdit({ repoRoot, relPath, currentCode, proposedCode, expectedRegion = null }) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`target file does not exist: ${relPath}`);
  }
  const src = fs.readFileSync(abs, 'utf8');
  const { match, region, replacement } = resolveEdit({ src, relPath, currentCode, proposedCode });
  if (expectedRegion != null && region !== expectedRegion) {
    const e = new Error(`anchor match failed in ${relPath}: matched region (${match.tier}, offsets ${match.start}-${match.end}) is not the region that was validated`);
    e.tier = 'region';
    e.detail = { reason: 'region_changed', match_tier: match.tier, start: match.start, end: match.end };
    throw e;
  }

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
    matchedRegion: region,
    reindented: replacement !== proposedCode
  };
}

module.exports = { FileSnapshot, applyEdit, resolveEdit };
