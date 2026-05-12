'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next',
  '.cache', '.venv', 'venv', '__pycache__', '.idea', '.vscode'
]);

const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt'
]);

const MAX_FILE_BYTES = 200_000;

function isBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function walk(root, { maxFiles = 500 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXT.has(ext)) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > MAX_FILE_BYTES) continue;
        out.push({ path: full, relative: path.relative(root, full), size: stat.size, ext });
      }
    }
  }
  return out;
}

function readFileSafe(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    if (isBinary(buf)) return null;
    return buf.toString('utf8');
  } catch (err) {
    return null;
  }
}

function discover(root, opts = {}) {
  const files = walk(root, opts);
  const withContent = [];
  for (const f of files) {
    const content = readFileSafe(f.path);
    if (content == null) continue;
    withContent.push({ ...f, content });
  }
  return withContent;
}

module.exports = { walk, discover, readFileSafe, SKIP_DIRS, CODE_EXT, MAX_FILE_BYTES };
