'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false'];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInit(repo) {
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, [...ID, 'commit', '-q', '-m', 'fixture']);
  return repo;
}

// Every file under `dir` except .git, as { relPath: sha256 }.
function treeHash(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function branchCommits(repo, branch, base = 'main') {
  const out = git(repo, ['rev-list', '--reverse', `${base}..${branch}`]);
  return out ? out.split('\n') : [];
}

module.exports = { git, gitInit, treeHash, branchCommits };
