#!/bin/bash
# Runs every AUDIT-25 probe one after another (each under `timeout 1800`),
# one log per probe in OUT_DIR, and prints each probe's exit code
# (1 = reproduced finding). TMPDIR points at OUT_DIR/tmp. Run nothing else
# on the machine meanwhile: the probes time suites.
# usage: bash audit/25/run-all.sh [OUT_DIR] [name ...]
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
r switch-hot node audit/25/switch-hot.js
r mutant-gen node --expose-gc audit/25/mutant-gen.js --reps 5
r hook-volume node audit/25/hook-volume.js
r leaks node audit/25/leaks.js
r table node audit/22/sites-scale.js --cases table --reps 3
echo "logs in $O"
touch "$O/ALLDONE"
