#!/bin/bash
# Runs every AUDIT-33 probe, then the AUDIT-29 / AUDIT-25 / AUDIT-22 re-runs
# and the bench, one after another (each under `timeout 1800`), one log per
# probe in OUT_DIR, and prints each probe's exit code (1 = reproduced
# finding). TMPDIR points at OUT_DIR/tmp. Run nothing else on the machine
# meanwhile: the probes time suites.
# usage: bash audit/33/run-all.sh [OUT_DIR] [name ...]
cd "$(dirname "$0")/../.." || exit 1
O=${1:-$(mktemp -d)}; shift
mkdir -p "$O/tmp"
export TMPDIR="$O/tmp"
ONLY=" $* "
r() {
  name=$1; shift
  if [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $name "* ]]; then return; fi
  s=$(date +%s)
  echo "== $name: $* (load $(cut -d' ' -f1-3 /proc/loadavg))" > "$O/$name.log"
  timeout 1800 "$@" >> "$O/$name.log" 2>&1
  rc=$?
  echo "== exit $rc in $(( $(date +%s) - s )) s" >> "$O/$name.log"
  echo "$name exit $rc"
}
r sep-scale node audit/33/sep-scale.js --reps 2
r py-semi-k500 node audit/33/sep-scale.js --cases py-semi --kb 2000 --reps 1 --k 500
r tap-scale node audit/33/tap-scale.js
r switch-value node audit/33/switch-value.js
r load-names node audit/29/load-names.js
r load-exec node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000
r struct-scale node audit/29/struct-scale.js
r a25-switch-hot node audit/25/switch-hot.js
r a25-table node audit/22/sites-scale.js --cases table --reps 2
r bench npm run bench
echo "logs in $O"
touch "$O/ALLDONE"
