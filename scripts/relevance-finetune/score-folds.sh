#!/usr/bin/env bash
# Score every fold's eval payloads through local-decider.py.
#   score-folds.sh <dataDir> <tag> <rubric|lite> <model> [adapter-dir-template with {k}]
# Writes <dataDir>/pred-<tag>-f{k}.jsonl. DECIDER_TIMING=1 adds per-item elapsed_s.
set -euo pipefail
DATA=$1; TAG=$2; KIND=$3; MODEL=$4; ADAPTER=${5:-}
cd "$(dirname "$0")/../.."
for k in 0 1 2 3 4; do
  extra=()
  if [ -n "$ADAPTER" ]; then extra=(--adapter "${ADAPTER//\{k\}/$k}"); fi
  DECIDER_TIMING=1 uv run src/relevance/local-decider.py --model "$MODEL" ${extra[@]+"${extra[@]}"} \
    < "$DATA/eval-$KIND-f$k.jsonl" > "$DATA/pred-$TAG-f$k.jsonl"
done
