#!/usr/bin/env bash
# AUDIT-43: every repro, one log each under OUT (default: a temp dir).
# Exit 1 when any repro reports FINDING.
cd "$(dirname "$0")/../.." || exit 2
OUT=${1:-$(mktemp -d)}
mkdir -p "$OUT"
rc=0
for s in token-sites load-probes run; do
  node "audit/43/$s.js" > "$OUT/$s.log" 2>&1; r=$?
  echo "$s.js exit=$r ($(grep -c '^FINDING' "$OUT/$s.log") FINDING lines)"
  [ $r -ne 0 ] && rc=1
done
echo "logs: $OUT"
exit $rc
