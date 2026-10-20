#!/bin/bash
# Re-runs the AUDIT-2 and AUDIT-6 load scripts, one after another, each under
# `timeout 900`, writing one log per script into OUT_DIR (default: a new temp dir).
# usage: bash audit/9/rerun-prior.sh [OUT_DIR] [name ...]
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
r tests-load env AUDIT_DAEMON_S=240 node audit/2/tests-load.js --modes fast,hang-escape,hang
r anchor-patho node audit/2/anchor-patho.js --reps 3
r ast-scale node audit/2/ast-scale.js
r diff-flaky150 node audit/2/diff-patho.js --flaky cpu-150ms-per-call --repeat 10
r diff-flaky100c8 node audit/2/diff-patho.js --flaky cpu-100ms-per-call --repeat 10 --contend 8
r diff-patho node audit/2/diff-patho.js
r cov-span node audit/6/coverage-load.js --cases span
r cov-procs node audit/6/coverage-load.js --cases procs
r cov-py node audit/6/coverage-py.js --files 50,200,500
r resume-scale node audit/6/session-resume-scale.js --parts a,b,c,d
r drift-scan node audit/6/drift-scan.js
r anchor-adv node audit/6/anchor-adversarial.js
r diffgen node audit/6/diffgen-load.js
r pipeline6 node audit/6/pipeline-load.js --proposals 50 --drift --serve
echo "logs in $O"
touch "$O/ALLDONE"
