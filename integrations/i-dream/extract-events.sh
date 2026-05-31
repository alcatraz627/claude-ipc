#!/usr/bin/env bash
# claude-ipc → i-dream event extractor.
#
# Emits the IPC message log as JSONL (one event per message) for the dreaming
# layer to reflect on handoff patterns. Re-emits the full log each run; i-dream
# tracks its own cursor by ts. Requires the `claude-ipc` CLI on PATH and a broker
# that has run.
set -euo pipefail
OUT="${1:-$HOME/.claude-ipc/i-dream-events.jsonl}"
claude-ipc log 2>/dev/null \
  | jq -c '.messages[] | {id, ts, kind, from: .fromAlias, to: .toAlias, corrId, body: (.body[0:200])}' \
  > "$OUT"
