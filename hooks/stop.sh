#!/usr/bin/env bash
# claude-ipc Stop hook — heartbeat this session so its liveness stays fresh.
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/../dist/ipc-stop"
if [ -x "$BIN" ]; then exec "$BIN"; else exec bun run "$DIR/../src/hooks/stop.ts"; fi
