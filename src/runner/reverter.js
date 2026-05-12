'use strict';

const fs = require('fs');
const path = require('path');

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
  const idx = src.indexOf(currentCode);
  if (idx === -1) {
    throw new Error(`current_code anchor not found in ${relPath}`);
  }
  const occurrences = src.split(currentCode).length - 1;
  if (occurrences > 1) {
    throw new Error(`current_code anchor matches ${occurrences} locations in ${relPath}; ambiguous`);
  }
  const next = src.slice(0, idx) + proposedCode + src.slice(idx + currentCode.length);
  fs.writeFileSync(abs, next);
  return { bytesBefore: src.length, bytesAfter: next.length };
}

module.exports = { FileSnapshot, applyEdit };
