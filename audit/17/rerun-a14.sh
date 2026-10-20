#!/bin/bash
# Re-runs the AUDIT-14 repros (C1, H1-H4, M1-M4, what-holds) and the prior
# rounds' set (audit/14/rerun-prior.sh), one after another, each under
# `timeout 1200`, one log per script in OUT_DIR. TMPDIR is pointed at
# OUT_DIR/tmp so refactor-cov-* / refactor-pyc-* / pydt-* dirs left behind by
# src are counted at the end (leftovers.log).
# usage: bash audit/17/rerun-a14.sh [OUT_DIR] [name ...]
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
  timeout 1200 "$@" >> "$O/$name.log" 2>&1
  echo "== exit $? in $(( $(date +%s) - s )) s" >> "$O/$name.log"
}
r c1-timing node audit/14/mutant-flaky.js --mode timing --repeat 20 --busy 8
r c1-steady node audit/14/mutant-flaky.js --mode steady --repeat 10
r c1-random node audit/14/mutant-flaky.js --mode random --repeat 20 --p 0.2
r h1 node audit/14/py-deletion.js --kb 2,10,14,30,60
r h2 node audit/14/diff-size.js --lang py --kb 100,150,199
r h2-contend node audit/14/diff-size.js --lang py --kb 50,75,100,150 --contend 8 --reps 3
r h3-py node audit/14/edit-sites.js --lang py --hunks 4,16 --sites 6,12 --contend 8
r h3-py0 node audit/14/edit-sites.js --lang py --hunks 4,16 --sites 6,12
r h3-js node audit/14/edit-sites.js --hunks 16 --sites 12
r h3-exec node audit/14/executor-sites.js --hunks 16 --sites 12
r h4 node audit/14/diff-bindings.js --kind const
r h4-contend node audit/14/diff-bindings.js --kind const --n 1000,2000,3000,5000 --contend 8
r m1 node audit/14/diff-size.js --lang js --kb 150,199 --contend 8 --reps 3
r m2 node audit/14/diff-prep.js --parts a,b,c
r m4 node audit/14/mutant-budget.js mutant-budget --suite-s 29,31,45
r m4-py node audit/14/mutant-budget.js mutant-budget --lang py --suite-s 30,40
r py-adv node audit/14/py-adversarial.js
r wt-retry node audit/14/worktree-retry.js
r pipe-py node audit/14/pipeline-load-py.js --proposals 20 --drift --serve
r pipe-js node audit/9/pipeline-load.js --proposals 50 --drift --serve
r prior bash audit/14/rerun-prior.sh "$O/prior"
echo "src temp dirs left in $TMPDIR:" > "$O/leftovers.log"
ls "$TMPDIR" | sed 's/-[A-Za-z0-9_]*$//' | sort | uniq -c >> "$O/leftovers.log"
touch "$O/ALLDONE"
