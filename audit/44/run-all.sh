#!/bin/sh
# AUDIT-44 repros. Each prints ok / FINDING and exits 1 on a reproduced finding.
# Run from the repo root: sh audit/44/run-all.sh
st=0
for s in py-usercustomize old-node-engines sdk-timeout shift-reach; do
  echo "== audit/44/$s.js"
  node "audit/44/$s.js" || st=1
done
exit $st
