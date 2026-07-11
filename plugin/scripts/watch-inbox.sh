#!/usr/bin/env bash
# Standing inbox watcher for a Claude Code session — the plugin-monitor half of
# claude-ipc's wake path. Claude Code starts this automatically at session start
# (and again on every resume) and turns each line it prints into an event that
# re-invokes the agent, so new ipc mail wakes an idle session with no human turn.
#
# Identity: the session's alias comes from the alias-by-sid side file the
# SessionStart hook writes. A session that never registers (ephemeral /tmp cwd,
# hook failure) gets no side file — the watcher exits quietly rather than watch
# a mailbox nothing will ever fill.
#
# Wake discipline: only actionable mail (query / request / response) wakes the
# agent; an inform waits for the next organic turn's drain. New mail is detected
# by message-ID diff against a seen set — not a count delta, which can miss an
# arrival that interleaves with a consume — and a burst coalesces into ONE line,
# because every printed line is a separate wake. The baseline is taken from the
# first answer the broker actually gives, so a down broker never fakes an empty
# inbox and pre-existing mail (the SessionStart drain's job) never wakes.
#
# Bash on purpose: the compiled bun binary block-buffers stdout to pipes, which
# starves the monitor stream. `echo`/`printf` flush per line.
set -u

SID="${CLAUDE_CODE_SESSION_ID:-}"
[ -n "$SID" ] || exit 0 # not inside a session — nothing to watch

IPC_HOME="${CLAUDE_IPC_HOME:-$HOME/.claude-ipc}"
CIPC="${CLAUDE_IPC_BIN:-$(command -v claude-ipc || echo claude-ipc)}"
INTERVAL="${IPC_WATCH_INTERVAL:-10}"
GRACE_TRIES="${IPC_WATCH_GRACE_TRIES:-12}"

# The SessionStart hook races this monitor: it writes the alias file moments
# after the session (and this process) starts. Give it a grace window, then
# treat a missing side file as "this session isn't an ipc participant".
alias_file="$IPC_HOME/alias-by-sid/$SID"
ALIAS=""
i=0
while [ "$i" -lt "$GRACE_TRIES" ]; do
  if [ -s "$alias_file" ]; then
    ALIAS="$(tr -d '[:space:]' < "$alias_file")"
    break
  fi
  sleep 5
  i=$((i + 1))
done
[ -n "$ALIAS" ] || exit 0

STATE="$(mktemp -d "${TMPDIR:-/tmp}/ipc-watch.XXXXXX")"
trap 'rm -rf "$STATE" 2>/dev/null' EXIT
: > "$STATE/seen"

# One snapshot of BOTH mailboxes (this session's + the project's) as flat
# lines: id<TAB>kind<TAB>from<TAB>origin<TAB>one-line body head. Exits non-zero
# when the broker didn't answer with JSON (down, CLI missing), so a dead broker
# is a skipped tick — never mistaken for an empty inbox. Double quotes only
# inside the single-quoted program (backslash escapes there break under bash
# single quotes).
snapshot() {
  {
    "$CIPC" inbox "$ALIAS" 2>/dev/null
    echo "---IPC-SPLIT---"
    "$CIPC" inbox --project 2>/dev/null
  } | python3 -c '
import sys, json
raw = sys.stdin.read().split("---IPC-SPLIT---")
if len(raw) != 2:
    sys.exit(3)
for chunk, origin in ((raw[0], "session"), (raw[1], "project")):
    try:
        msgs = json.loads(chunk).get("messages", [])
    except Exception:
        if origin == "session":
            sys.exit(3)  # own inbox unreadable = broker down; project peek is best-effort
        continue
    for m in msgs:
        head = " ".join(str(m.get("body") or "").split())[:120]
        print(str(m.get("id")) + "\t" + str(m.get("kind")) + "\t" + str(m.get("fromAlias")) + "\t" + origin + "\t" + head)
'
}

baselined=""
while :; do
  if cur="$(snapshot)"; then
    printf '%s\n' "$cur" | cut -f1 | rg -v '^$' | sort -u > "$STATE/cur_ids" || true
    if [ -z "$baselined" ]; then
      cp -f "$STATE/cur_ids" "$STATE/seen"
      baselined=1
    else
      new="$(comm -13 "$STATE/seen" "$STATE/cur_ids")"
      if [ -n "$new" ]; then
        wake="$(printf '%s\n' "$cur" | python3 -c '
import sys
new_ids = set(sys.argv[1].split())
items, origins = [], set()
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 5 or parts[0] not in new_ids:
        continue
    if parts[1] in ("query", "request", "response"):
        tag = ", project" if parts[3] == "project" else ""
        origins.add(parts[3])
        items.append(parts[1] + " from " + parts[2] + " (" + parts[0] + tag + "): " + parts[4])
if items:
    reads = []
    if "session" in origins: reads.append("claude-ipc inbox " + sys.argv[2])
    if "project" in origins: reads.append("claude-ipc inbox --project")
    print(("ipc: " + str(len(items)) + " actionable — " + "; ".join(items))[:380] + " — read: " + " · ".join(reads))
' "$new" "$ALIAS")"
        [ -n "$wake" ] && printf '%s\n' "$wake"
        cat "$STATE/cur_ids" "$STATE/seen" | sort -u > "$STATE/seen.next"
        mv -f "$STATE/seen.next" "$STATE/seen"
      fi
    fi
  fi
  sleep "$INTERVAL"
done
