'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Executor isolation: every run applies and tests its edits in a git worktree
// of the target on branch refactor/<run_id>, so the target's own working tree
// is never written to. Passing proposals become one commit each.

const BOT_NAME = 'refactor-bot';
const BOT_EMAIL = 'refactor-bot@localhost';

// No output cap: `git status` of a target with many untracked files easily
// exceeds the 1 MB default, and a truncated answer must never read as "clean".
function gitRaw(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity });
}

function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

function tryGit(cwd, args) {
  try { return git(cwd, args); } catch { return null; }
}

function tryGitRaw(cwd, args) {
  try { return gitRaw(cwd, args); } catch { return null; }
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
// worktree uncommitted, so the executor tests against the same code. Any
// failure throws: validating HEAD instead of what the Analyzer read is wrong.
// Paths in `skip` (relative to the repo top) are left as the worktree has them.
function syncDirtyFiles(top, wtTop, skip = null) {
  let out;
  try {
    out = gitRaw(top, ['status', '--porcelain', '-z', '-uall']);
  } catch (err) {
    throw new Error(`git status failed: ${String(err.stderr || err.message).trim()}`);
  }
  // Entries are "XY path"; a rename/copy entry is followed by its source path.
  const entries = out.split('\0');
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if ((e[0] === 'R' || e[0] === 'C') && entries[i + 1]) paths.push(entries[++i]);
  }
  const synced = [];
  for (const rel of paths) {
    if (skip && skip.has(rel)) continue;
    const src = path.join(top, rel);
    const dst = path.join(wtTop, rel);
    try {
      const st = fs.existsSync(src) ? fs.statSync(src) : null;
      if (st && st.isDirectory()) continue; // submodule or nested repository: not file content
      if (st && st.isFile()) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } else if (fs.existsSync(dst)) {
        fs.rmSync(dst, { force: true, recursive: true });
      }
      synced.push(rel);
    } catch (err) {
      throw new Error(`could not copy ${rel} into the worktree: ${err.message}`);
    }
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

// Second branch name for when `worktree add -b refactor/<run_id>` fails, e.g.
// because a user branch named `refactor` blocks the refs/heads/refactor/ namespace.
function fallbackBranchFor(top, runId) {
  return refExists(top, 'refs/heads/refactor-run') ? `refactor-run-${runId}` : `refactor-run/${runId}`;
}

function refExists(top, ref) {
  return tryGit(top, ['rev-parse', '--verify', '--quiet', ref]) != null;
}

// Returns { mode: 'worktree', path, root, branch, base } or
// { mode: 'in-place', root, reason } when the target is not a git repo or has
// no commits. A git target with commits is never edited in place: if
// `git worktree add` also fails on the fallback branch name, throws (code
// EWORKTREE). Throws (worktree and branch removed) when the dirty-file sync fails.
function createWorktree({ targetRepo, runId, baseDir }) {
  const absTarget = fs.realpathSync(path.resolve(targetRepo));
  const top = gitToplevel(absTarget);
  if (!top) return { mode: 'in-place', root: absTarget, reason: 'target is not a git repository' };
  if (!hasHead(top)) return { mode: 'in-place', root: absTarget, reason: 'target git repository has no commits' };

  const wtPath = path.join(baseDir, runId);
  const sub = path.relative(top, absTarget);
  if (fs.existsSync(wtPath)) {
    const branch = tryGit(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']) || branchFor(runId);
    return resumeWorktree({ targetRepo, info: { mode: 'worktree', path: wtPath, branch, sub } });
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const errors = [];
  let branch = null;
  for (const name of [branchFor(runId), fallbackBranchFor(top, runId)]) {
    const existed = refExists(top, `refs/heads/${name}`);
    try {
      git(top, ['worktree', 'add', '-b', name, wtPath, 'HEAD']);
      branch = name;
      break;
    } catch (err) {
      errors.push(`${name}: ${String(err.stderr || err.message).trim()}`);
      // Drop what a half-finished add left behind (the path did not exist before).
      fs.rmSync(wtPath, { recursive: true, force: true });
      tryGit(top, ['worktree', 'prune']);
      if (!existed) tryGit(top, ['branch', '-D', name]);
    }
  }
  if (!branch) {
    throw Object.assign(new Error(`git worktree add failed (${errors.join('; ')}); the target is not edited in place. ` +
      'Fix the repository (a ref blocking the branch name, a locked worktree, disk space) and run again'), { code: 'EWORKTREE' });
  }
  const base = git(wtPath, ['rev-parse', 'HEAD']);
  let synced;
  try {
    synced = syncDirtyFiles(top, wtPath);
  } catch (err) {
    tryGit(top, ['worktree', 'remove', '--force', wtPath]);
    tryGit(top, ['branch', '-D', branch]);
    throw new Error(`uncommitted target changes could not be copied into the worktree (${err.message}); refusing to validate HEAD instead`);
  }
  const root = path.join(wtPath, sub);
  linkNodeModules(absTarget, root);
  return { mode: 'worktree', path: wtPath, root, branch, base, sub, dirty_synced: synced };
}

// Reattach to a run's worktree on --resume. A missing worktree is re-created
// from refactor/<run_id> (stale registration pruned first; the target's
// uncommitted changes synced again, except files the branch changed). Never
// falls back to editing a git target in place: throws (code EWORKTREE) when
// the branch is gone or the worktree cannot be re-attached.
function resumeWorktree({ targetRepo, info }) {
  if (!info || info.mode !== 'worktree') return info;
  const absTarget = fs.realpathSync(path.resolve(targetRepo));
  const top = gitToplevel(absTarget);
  const fail = (why) => Object.assign(new Error(`cannot resume run worktree ${info.path} on ${info.branch}: ${why}; ` +
    'the target is not edited in place. Restore the branch, or start a new run without --resume'), { code: 'EWORKTREE' });
  if (!top) throw fail('target is no longer a git repository');
  let synced = null;
  if (!fs.existsSync(info.path)) {
    if (tryGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${info.branch}`]) == null) throw fail(`branch ${info.branch} no longer exists`);
    tryGit(top, ['worktree', 'prune']);
    try {
      fs.mkdirSync(path.dirname(info.path), { recursive: true });
      git(top, ['worktree', 'add', info.path, info.branch]);
    } catch (err) {
      throw fail(`git worktree add failed: ${String(err.stderr || err.message).trim()}`);
    }
    const changed = info.base ? tryGitRaw(info.path, ['diff', '--name-only', '-z', info.base, 'HEAD']) : '';
    try {
      synced = syncDirtyFiles(top, info.path, new Set((changed || '').split('\0').filter(Boolean)));
    } catch (err) {
      tryGit(top, ['worktree', 'remove', '--force', info.path]);
      throw fail(err.message);
    }
  }
  if (tryGit(info.path, ['rev-parse', '--abbrev-ref', 'HEAD']) !== info.branch) throw fail(`${info.path} is not a worktree on ${info.branch}`);
  const sub = info.sub != null ? info.sub : path.relative(top, absTarget);
  const root = path.join(info.path, sub);
  linkNodeModules(absTarget, root);
  const base = info.base || tryGit(info.path, ['rev-parse', 'HEAD']);
  return { ...info, root, sub, base, ...(synced ? { dirty_synced: synced } : {}) };
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

// issue_id -> commit sha for the run branch's commits (the commit message's
// `issue_id:` line), so --resume can reconcile the session with the branch.
function committedIssues(info) {
  const out = new Map();
  if (!info || info.mode !== 'worktree' || !info.base || !info.branch) return out;
  const log = tryGitRaw(info.path, ['log', '--format=%H%n%B%x00', `${info.base}..${info.branch}`]);
  if (!log) return out;
  for (const rec of log.split('\0')) {
    const [sha, ...body] = rec.trim().split('\n');
    // The trailer is the last `issue_id:` line (the reasoning above it is free text).
    const m = body.map(l => /^issue_id: (\S+)$/.exec(l.trim())).filter(Boolean).pop();
    if (sha && m && !out.has(m[1])) out.set(m[1], sha);
  }
  return out;
}

function commitsSinceBase(info) {
  if (!info || info.mode !== 'worktree' || !info.base) return [];
  const out = tryGit(info.path, ['rev-list', '--reverse', `${info.base}..HEAD`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

// A crashed edit whose commit already landed: HEAD of `dir` carries the
// `issue_id` trailer and `files` match HEAD. -> that commit's sha, or null.
function headCommitOf(dir, issueId, files) {
  if (!issueId || !files.length || !gitToplevel(dir)) return null;
  const msg = tryGitRaw(dir, ['log', '-1', '--format=%B', 'HEAD']);
  const m = msg && msg.split('\n').map(l => /^issue_id: (\S+)$/.exec(l.trim())).filter(Boolean).pop();
  if (!m || m[1] !== issueId) return null;
  if (tryGit(dir, ['diff', '--quiet', 'HEAD', '--', ...files]) == null) return null;
  return tryGit(dir, ['rev-parse', 'HEAD']);
}

module.exports = { createWorktree, resumeWorktree, commitProposal, commitsSinceBase, committedIssues, headCommitOf, syncDirtyFiles, branchFor, gitToplevel };
