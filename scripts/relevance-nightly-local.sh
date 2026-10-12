#!/bin/bash
# Nightly relevance job on the local decider (cc-j8ti). Replaces the Jev launcher.sh:
# no `vault run`, no OpenRouter key, no --budget/--total-cap. Not installed in launchd;
# com.dmac.jev-retrain stays disabled until David approves the swap.
#   RELEVANCE_DRY=1  triage-discover dry run (nothing written)
#   TRIAGE_LIMIT=N   cap triage items (the 0.8B on MPS takes ~40 s per item)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export RELEVANCE_BACKEND=local
cd "$(dirname "$0")/.." || exit 1
echo "=== $(date -u +%FT%TZ) local retrain start"
r=0; c=0; t=0
bun src/relevance/cli.ts retrain; r=$?
bun src/relevance/cli.ts categorize --kind all; c=$?
if [ "${RELEVANCE_DRY:-0}" = 1 ]; then dry="--dry-run"; else dry=""; fi
bun src/relevance/cli.ts triage-discover $dry --limit "${TRIAGE_LIMIT:-300}" 2>&1 | grep -E "^(relevance: |run |todo |thresholds|\[jev|re-triaged|  ERR)"; t=${PIPESTATUS[0]}
echo "retrain=$r categorize=$c triage=$t"
[ $r -eq 0 ] && [ $c -eq 0 ] && [ $t -eq 0 ]
