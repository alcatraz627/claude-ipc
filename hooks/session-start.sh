#!/usr/bin/env bash
# claude-ipc SessionStart hook — register this session, drain its offline backlog.
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/../dist/ipc-session-start"
if [ -x "$BIN" ]; then exec "$BIN"; else exec bun run "$DIR/../src/hooks/sessionStart.ts"; fi
