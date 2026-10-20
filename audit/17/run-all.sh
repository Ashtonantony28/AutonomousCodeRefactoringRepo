#!/bin/bash
# Runs every AUDIT-17 probe one after another (each under `timeout 1800`),
# one log per probe in OUT_DIR, and prints each probe's exit code
# (1 = reproduced finding). TMPDIR points at OUT_DIR/tmp.
# usage: bash audit/17/run-all.sh [OUT_DIR] [name ...]
cd "$(dirname "$0")/../.." || exit 1
O=${1:-$(mktemp -d)}; shift
mkdir -p "$O/tmp"
export TMPDIR="$O/tmp"
ONLY=" $* "
r() {
  name=$1; shift
  if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $name "* ]]; then return; fi
  s=$(date +%s)
  echo "== $name: $*" > "$O/$name.log"
  timeout 1800 "$@" >> "$O/$name.log" 2>&1
  rc=$?
  echo "== exit $rc in $(( $(date +%s) - s )) s" >> "$O/$name.log"
  echo "$name exit $rc"
}
r edit-refs node audit/17/edit-refs.js --lines 1000,5000,12000 --reps 3
r executor-refs node audit/17/executor-refs.js --suite-s 0.5,1.5,3
r py-startup node audit/17/py-startup.js --files 200,500 --reps 3
r py-probes node audit/17/py-probes.js --reps 3
r py-probes-c8 node audit/17/py-probes.js --reps 3 --contend 8
r py-scale-const node audit/17/py-scale-const.js --reps 5
r py-scale-const-c8 node audit/17/py-scale-const.js --reps 3 --contend 8
r startup-head node audit/17/startup-head.js --files 200,5000,25000 --reps 5
r leaks node audit/17/leaks.js
r py-adv-timer node audit/14/py-adversarial.js --contend 0,8 --case timer
echo "logs in $O"
touch "$O/ALLDONE"
