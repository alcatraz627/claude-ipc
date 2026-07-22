#!/usr/bin/env bash
# Wake yourself when a claude-ipc reply lands — a watcher you wrap in the Monitor tool.
#
# A turn-based agent can't notice a reply while it sits idle. Point Monitor at this
# and the line it prints becomes an event that re-invokes the agent, no human prompt:
#   Monitor({command: "ipc-await.sh <your-alias> --for <corrId>"})
#
# It polls a fresh `claude-ipc count` per tick (cheap, no hung connection), pulls the
# inbox only when the count changes, and exits the instant the awaited reply appears.
# Bash `echo` flushes to the Monitor pipe line-by-line — no buffering to fight.
set -u

ALIAS="${1:?usage: ipc-await.sh <alias> --for <corrId> [--interval N] [--cipc PATH]}"
shift
CORR=""; INTERVAL=5; CIPC="$(command -v claude-ipc || echo claude-ipc)"
while [ $# -gt 0 ]; do
  case "$1" in
    --for) CORR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --cipc) CIPC="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$CORR" ] || { echo "ipc-await: --for <corrId> is required" >&2; exit 2; }

# Change-gate on the cheap count (no badge side effect); pull details only on change.
# count FAILS on an unregistered alias (never a fake 0) — surface that loudly:
# a watcher on a pruned alias must die telling its Monitor why, not stall forever.
if ! prev="$("$CIPC" count "$ALIAS" 2>/dev/null)"; then
  echo "ipc-await: $ALIAS is not registered (pruned while idle?) — re-register, then re-arm me: claude-ipc register $ALIAS"
  exit 3
fi
[ -n "${AWAIT_DEBUG:-}" ] && echo "[await] baseline prev=$prev cipc=$CIPC alias=$ALIAS" >&2
while :; do
  sleep "$INTERVAL"
  if ! n="$("$CIPC" count "$ALIAS" 2>/dev/null)"; then
    echo "ipc-await: $ALIAS is not registered (pruned mid-watch?) — re-register, then re-arm me: claude-ipc register $ALIAS"
    exit 3
  fi
  [ -n "${AWAIT_DEBUG:-}" ] && echo "[await] n=$n prev=$prev" >&2
  [ "$n" = "$prev" ] && continue
  prev="$n"
  # A stateless pipe-stage parse (python as a filter, not a long-lived process):
  # print the awaited reply's body, or nothing.
  hit="$("$CIPC" inbox "$ALIAS" 2>/dev/null | CORR="$CORR" python3 -c '
import sys, os, json
c = os.environ["CORR"]
try:
    msgs = json.load(sys.stdin).get("messages", [])
except Exception:
    sys.exit(0)
for m in msgs:
    if m.get("kind") == "response" and m.get("corrId") == c:
        body = " ".join((m.get("body") or "").split())[:300]  # one line — each line is a separate wake
        print("reply from " + str(m.get("fromAlias")) + " re " + c + ": " + body)
        break
')"
  if [ -n "$hit" ]; then
    echo "$hit"   # the one wake — the Monitor stream ends here
    exit 0
  fi
done
