'use strict';

// AUDIT-4 repro: timing margin of test/test-runner.test.js:47-70 ("timeout
// kills the whole process group, grandchildren included").
//
//   node audit/4/pgroup-timing.js [iterations=10]
//
// The test asserts the grandchild `sleep` is gone within 2000 ms of the
// timeout, using process.kill(pid, 0). That probe also succeeds for a zombie,
// so the test measures how quickly the grandchild is *reaped* (by whatever
// PID 1 / subreaper adopts it), not how quickly it is killed. This prints,
// per iteration, when the grandchild became a zombie (killed) and when it
// disappeared (reaped).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCommand } = require('../../src/runner/test-runner');

function state(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; } catch { return null; }
}

async function once() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit4-pgrp-'));
  try {
    const pidFile = path.join(dir, 'pid');
    const r = await runCommand({ cmd: 'sh', args: ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], cwd: dir, env: process.env, timeoutMs: 300 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const t0 = Date.now();
    let zombieAt = null, goneAt = null;
    while (Date.now() - t0 < 10000) {
      const s = state(pid);
      if (s === 'Z' && zombieAt == null) zombieAt = Date.now() - t0;
      if (s == null) { goneAt = Date.now() - t0; if (zombieAt == null) zombieAt = goneAt; break; }
      await new Promise(res => setTimeout(res, 10));
    }
    return { timedOut: r.timedOut, zombieAt, goneAt };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const n = Number(process.argv[2] || 10);
  let over = 0;
  for (let i = 0; i < n; i++) {
    const r = await once();
    const late = r.goneAt == null || r.goneAt > 2000;
    if (late) over++;
    console.log(`iter ${i + 1}: timedOut=${r.timedOut} killed(zombie)@${r.zombieAt}ms gone@${r.goneAt == null ? '>10000' : r.goneAt}ms${late ? '  <- the test would FAIL (2000 ms budget)' : ''}`);
  }
  console.log(`\n${over}/${n} iterations exceeded the test's 2000 ms budget; PID 1 here is: ${fs.readFileSync('/proc/1/cmdline', 'utf8').replace(/\0/g, ' ').trim()}`);
})();
