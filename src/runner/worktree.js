'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Executor isolation: every run applies and tests its edits in a git worktree
// of the target on branch refactor/<run_id>, so the target's own working tree
// is never written to. Passing proposals become one commit each.

const BOT_NAME = 'refactor-bot';
const BOT_EMAIL = 'refactor-bot@localhost';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

function gitToplevel(dir) {
  const top = tryGit(dir, ['rev-parse', '--show-toplevel']);
  return top ? fs.realpathSync(top) : null;
}

function hasHead(top) {
  return tryGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD']) != null;
}

function branchFor(runId) { return `refactor/${runId}`; }

function identityArgs(cwd) {
  const email = tryGit(cwd, ['config', 'user.email']);
  const name = tryGit(cwd, ['config', 'user.name']);
  return email && name ? [] : ['-c', `user.name=${name || BOT_NAME}`, '-c', `user.email=${email || BOT_EMAIL}`];
}

// Uncommitted target changes (what the Analyzer saw) are copied into the
// worktree uncommitted, so the executor tests against the same code.
function syncDirtyFiles(top, wtTop) {
  const out = tryGit(top, ['status', '--porcelain', '-z', '-uall']);
  if (!out) return [];
  const entries = out.split('\0').filter(Boolean);
  const synced = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const code = e.slice(0, 2);
    const rel = e.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // next entry is the rename source
    const src = path.join(top, rel);
    const dst = path.join(wtTop, rel);
    try {
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } else if (fs.existsSync(dst)) {
        fs.rmSync(dst, { force: true });
      }
      synced.push(rel);
    } catch { /* best effort */ }
  }
  return synced;
}

// Dependencies are not tracked; let the worktree use the target's install.
function linkNodeModules(targetRoot, workRoot) {
  const src = path.join(targetRoot, 'node_modules');
  const dst = path.join(workRoot, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try { fs.symlinkSync(src, dst, 'dir'); return true; } catch { return false; }
}

// Returns { mode: 'worktree', path, root, branch, base } or
// { mode: 'in-place', root, reason } when the target is not a usable git repo.
function createWorktree({ targetRepo, runId, baseDir }) {
  const absTarget = fs.realpathSync(path.resolve(targetRepo));
  const top = gitToplevel(absTarget);
  if (!top) return { mode: 'in-place', root: absTarget, reason: 'target is not a git repository' };
  if (!hasHead(top)) return { mode: 'in-place', root: absTarget, reason: 'target git repository has no commits' };

  const branch = branchFor(runId);
  const wtPath = path.join(baseDir, runId);
  const sub = path.relative(top, absTarget);
  if (fs.existsSync(wtPath)) return resumeWorktree({ targetRepo, info: { mode: 'worktree', path: wtPath, branch, sub } });

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  try {
    git(top, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
  } catch (err) {
    return { mode: 'in-place', root: absTarget, reason: `git worktree add failed: ${String(err.stderr || err.message).trim()}` };
  }
  const base = git(wtPath, ['rev-parse', 'HEAD']);
  const synced = syncDirtyFiles(top, wtPath);
  const root = path.join(wtPath, sub);
  linkNodeModules(absTarget, root);
  return { mode: 'worktree', path: wtPath, root, branch, base, sub, dirty_synced: synced };
}

// Reattach to a run's worktree on --resume (re-adding it if it was pruned).
function resumeWorktree({ targetRepo, info }) {
  if (!info || info.mode !== 'worktree') return info;
  const absTarget = fs.realpathSync(path.resolve(targetRepo));
  const top = gitToplevel(absTarget);
  if (!fs.existsSync(info.path) && top) {
    try { git(top, ['worktree', 'add', info.path, info.branch]); } catch { /* */ }
  }
  if (!fs.existsSync(info.path)) {
    return { mode: 'in-place', root: absTarget, reason: `worktree ${info.path} is gone and could not be re-added` };
  }
  const sub = info.sub != null ? info.sub : (top ? path.relative(top, absTarget) : '');
  const root = path.join(info.path, sub);
  linkNodeModules(absTarget, root);
  const base = info.base || tryGit(info.path, ['rev-parse', 'HEAD']);
  return { ...info, root, sub, base };
}

// One commit per passing proposal; only the edited file is staged.
function commitProposal(info, proposal) {
  if (!info || info.mode !== 'worktree') return null;
  const rel = path.join(info.sub || '', proposal.file);
  git(info.path, ['add', '--', rel]);
  if (tryGit(info.path, ['diff', '--cached', '--quiet']) != null) return null; // nothing staged
  const msg = `refactor: ${proposal.file} [${proposal.issue_id}]\n\n${String(proposal.reasoning || '').slice(0, 2000)}\n\nissue_id: ${proposal.issue_id}\nfile: ${proposal.file}\n`;
  git(info.path, [...identityArgs(info.path), 'commit', '--no-verify', '-q', '-m', msg]);
  return git(info.path, ['rev-parse', 'HEAD']);
}

function commitsSinceBase(info) {
  if (!info || info.mode !== 'worktree' || !info.base) return [];
  const out = tryGit(info.path, ['rev-list', '--reverse', `${info.base}..HEAD`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

module.exports = { createWorktree, resumeWorktree, commitProposal, commitsSinceBase, branchFor, gitToplevel };
