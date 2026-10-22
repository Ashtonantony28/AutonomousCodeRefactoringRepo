#!/bin/bash
# Runs every AUDIT-29 probe one after another (each under `timeout 1800`),
# one log per probe in OUT_DIR, and prints each probe's exit code
# (1 = reproduced finding). TMPDIR points at OUT_DIR/tmp. Run nothing else
# on the machine meanwhile: the probes time suites.
# usage: bash audit/29/run-all.sh [OUT_DIR] [name ...]
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
r load-names node audit/29/load-names.js
r load-exec node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000
r struct-scale node audit/29/struct-scale.js
r hook-overhead node audit/29/hook-overhead.js --reps 5
r memory node --expose-gc audit/29/memory.js --n 120 --every 20
r a25-switch-hot node audit/25/switch-hot.js
r a25-table node audit/22/sites-scale.js --cases table --reps 2
r bench npm run bench
echo "logs in $O"
touch "$O/ALLDONE"
