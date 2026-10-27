#!/bin/bash
# Runs every AUDIT-41 probe, the AUDIT-37 probes, then the AUDIT-33 / AUDIT-29 / AUDIT-25 re-runs
# and the bench, one after another (each under `timeout 1800`), one log per
# probe in OUT_DIR, and prints each probe's exit code (1 = reproduced
# finding). TMPDIR points at OUT_DIR/tmp. Run nothing else on the machine
# meanwhile: the probes time suites.
# A25-M2 (per-run bytecode cache) is py-hook-nobc.
# usage: bash audit/41/run-all.sh [OUT_DIR] [name ...]
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
r import-flag node audit/41/import-flag.js
r mock-module node audit/41/mock-module.js
r leak node --expose-gc audit/41/leak.js
r async-loader node audit/37/async-loader.js
r sg44-scale node audit/37/sg44-scale.js --reps 2
r plain-mutant-hang node audit/37/plain-mutant-hang.js
r py-site-nest node audit/37/py-site-nest.js
r hook-load node audit/37/hook-load.js --reps 3
r py-hook node audit/37/py-hook.js --reps 3
r py-hook-nobc node audit/37/py-hook.js --reps 3 --cases spawn --nobytecode
# audit/33 sep-scale py-semi / js-comma patches are stale since SG46 (the
# bounds are in src): only js-semi still compares; A33-M1 is sg44-scale py-semi.
r a33-js-semi node audit/33/sep-scale.js --cases js-semi --reps 2
r a33-tap-scale node audit/33/tap-scale.js
r load-names node audit/29/load-names.js
r load-exec node audit/29/load-names.js --sizes '' --table '' --exec 20000,2000
r a25-switch-hot node audit/25/switch-hot.js
r a29-m2-table node audit/22/sites-scale.js --cases table --reps 2
r a25-m3m4-fallback node audit/22/reporter-fallback.js --pre-s 3 --timeout-ms 6500
r a25-m5-sites node audit/22/site-budget.js
r a25-m6-pydiff node audit/14/diff-size.js --lang py --kb 50,75,100,150 --contend 8 --reps 3
r bench npm run bench
echo "logs in $O"
touch "$O/ALLDONE"
