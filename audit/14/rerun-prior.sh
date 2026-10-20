#!/bin/bash
# Re-runs every prior performance Critical/High repro (AUDIT-2, AUDIT-6,
# AUDIT-9), one after another, each under `timeout 900`, one log per script
# in OUT_DIR (default: a new temp dir).
# usage: bash audit/14/rerun-prior.sh [OUT_DIR] [name ...]
cd "$(dirname "$0")/../.." || exit 1
O=${1:-$(mktemp -d)}; shift
mkdir -p "$O"
ONLY=" $* "
r() {
  name=$1; shift
  if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $name "* ]]; then return; fi
  s=$(date +%s)
  echo "== $name: $*" > "$O/$name.log"
  timeout 900 "$@" >> "$O/$name.log" 2>&1
  echo "== exit $? in $(( $(date +%s) - s )) s" >> "$O/$name.log"
}
# AUDIT-9
r a9-c1-diff node audit/9/diff-explosion.js
r a9-c1-validator node audit/9/validator-explosion.js
# audit/9 mutant-budget/mutant-timing call runExecutor without the diff test
# the orchestrator attaches; since SG22 that reverts their edit before any
# mutant runs, so they go through audit/14/mutant-budget.js (attaches it).
r a9-c2-js node audit/14/mutant-budget.js mutant-budget --suite-s 29,31,45
r a9-c2-py node audit/14/mutant-budget.js mutant-budget --lang py --suite-s 30,40
r a9-h1 node audit/9/edit-mutants.js
r a9-h1-2g node --max-old-space-size=2048 audit/9/edit-mutants.js --reps 1
r a9-h2 node audit/14/mutant-budget.js mutant-timing --mode jitter --repeat 20
r a9-h3 node audit/9/diff-state.js
r a9-h3-contend node audit/9/diff-state.js --contend 8 --case "exported array"
r a9-h4 node audit/9/drift-caps.js --cases c
# AUDIT-2 / AUDIT-6
r a2-c1 env AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes fast,hang-escape,hang
r a2-c2 node audit/2/anchor-patho.js --reps 3
r a2-h1 node audit/2/ast-scale.js
r a2-h2-150 node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10
r a2-h2-100c8 node audit/2/diff-patho.js --flaky cpu-100ms-per-call --repeat 10 --contend 8
r a6-c1-span node audit/6/coverage-load.js --cases span
r a6-c1-procs node audit/6/coverage-load.js --cases procs
r a6-c2 node audit/6/coverage-py.js --files 50,200,500
r a6-c3 node audit/6/session-resume-scale.js --parts d
r a6-h12 node audit/6/drift-scan.js
echo "logs in $O"
touch "$O/ALLDONE"
