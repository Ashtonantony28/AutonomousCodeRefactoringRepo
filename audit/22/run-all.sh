#!/bin/bash
# Runs every AUDIT-22 probe one after another (each under `timeout 1800`),
# one log per probe in OUT_DIR, and prints each probe's exit code
# (1 = reproduced finding). TMPDIR points at OUT_DIR/tmp.
# usage: bash audit/22/run-all.sh [OUT_DIR] [name ...]
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
r report-parse node audit/22/report-parse.js
r dup-budget node audit/22/dup-budget.js
r sites-scale node audit/22/sites-scale.js
r site-budget node audit/22/site-budget.js
r load-hooks node audit/22/load-hooks.js
r reporter-fallback node audit/22/reporter-fallback.js --pre-s 0,3 --timeout-ms 6500
r leaks node audit/22/leaks.js
echo "logs in $O"
touch "$O/ALLDONE"
