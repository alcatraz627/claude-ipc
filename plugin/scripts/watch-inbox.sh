#!/usr/bin/env bash
# Standing inbox watcher for a Claude Code session — the plugin-monitor half of
# claude-ipc's wake path. Claude Code starts this automatically at session start
# (and again on every resume) and turns each line it prints into an event that
# re-invokes the agent, so new ipc mail wakes an idle session with no human turn.
#
# Identity: the session's alias comes from the alias-by-sid side file, and it is
# re-read on every tick because it MOVES. A session that renames itself (the usual
# `claude-ipc register <name>` at startup) rewrites that file, and a watcher holding
# the old name would poll an empty mailbox for the rest of the session, silently,
# while its real mail piled up elsewhere. A session with no alias yet keeps waiting
# rather than exiting, so a slow hook costs a few ticks instead of the wake surface.
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

# Which mailbox to watch is decided fresh on every tick, never cached. A session
# renames itself mid-flight — `claude-ipc register <name>` rewrites this very file,
# and the SessionStart hook writes it moments after this process starts — so an
# alias read once at startup goes stale and leaves the watcher polling a mailbox
# nobody sends to. That failure is silent and total: mail lands under the new name
# and no wake ever fires again. A missing file is likewise a wait, not an exit.
ALIAS_FILE="$IPC_HOME/alias-by-sid/$SID"
current_alias() { [ -s "$ALIAS_FILE" ] && tr -d '[:space:]' < "$ALIAS_FILE"; }

STATE="$(mktemp -d "${TMPDIR:-/tmp}/ipc-watch.XXXXXX")"
trap 'rm -rf "$STATE" 2>/dev/null' EXIT
: > "$STATE/seen"

# Diagnostics go to a file, never to stdout: every stdout line here IS a wake, so a
# debug print would spend a whole agent turn saying nothing. This log is the only
# place to see which mailbox a watcher settled on and why it went quiet.
LOG="$IPC_HOME/logs/watch-inbox-$SID.log"
mkdir -p "$IPC_HOME/logs" 2>/dev/null || true
log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }
log "watcher up (sid=$SID interval=${INTERVAL}s)"

# One snapshot of BOTH mailboxes (this session's + the project's) as flat
# lines: id<TAB>kind<TAB>from<TAB>origin<TAB>one-line body head. Exits non-zero
# when the broker didn't answer with JSON (down, CLI missing), so a dead broker
# is a skipped tick — never mistaken for an empty inbox. Double quotes only
# inside the single-quoted program (backslash escapes there break under bash
# single quotes).
snapshot() {
  {
    "$CIPC" inbox "$1" 2>/dev/null
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

ALIAS=""
baselined=""
broker_ok=""
while :; do
  now_alias="$(current_alias || true)"

  # No alias yet (SessionStart hasn't written it, or this session never joined):
  # keep waiting. Exiting here is what used to strand a session with no wake
  # surface and no error to show for it.
  if [ -z "$now_alias" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # The session adopted a new name. Follow it, but KEEP the seen-set: message ids
  # are globally unique, so nothing is confused by the switch, and mail already
  # waiting in the adopted mailbox is mail nobody has handed us yet — a successor
  # session inheriting a dead peer's alias (see `claude-ipc orphans`) must be woken
  # for it, not silently robbed of it. Re-baselining here would mark that unread
  # backlog as history and drop it for good.
  if [ "$now_alias" != "$ALIAS" ]; then
    log "watching mailbox: $now_alias${ALIAS:+ (renamed from $ALIAS)}"
    ALIAS="$now_alias"
  fi

  if cur="$(snapshot "$ALIAS")"; then
    [ -n "$broker_ok" ] || { log "broker answering"; broker_ok=1; }
    printf '%s\n' "$cur" | cut -f1 | rg -v '^$' | sort -u > "$STATE/cur_ids" || true
    # The one baseline, taken at startup only: whatever is already in the mailbox
    # when the session opens was handed over by the SessionStart drain, so it is
    # history rather than a wake. Every later tick — including after a rename —
    # diffs against the seen-set instead, so nothing that arrives afterwards can
    # be mistaken for backlog.
    if [ -z "$baselined" ]; then
      cp -f "$STATE/cur_ids" "$STATE/seen"
      baselined=1
      log "baseline: $(wc -l < "$STATE/cur_ids" | tr -d ' ') already-known message(s)"
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
        if [ -n "$wake" ]; then
          printf '%s\n' "$wake"
          log "WAKE: $wake"
        fi
        cat "$STATE/cur_ids" "$STATE/seen" | sort -u > "$STATE/seen.next"
        mv -f "$STATE/seen.next" "$STATE/seen"
      fi
    fi
  else
    [ -z "$broker_ok" ] || { log "broker not answering; ticks skipped until it returns"; broker_ok=""; }
  fi
  sleep "$INTERVAL"
done
