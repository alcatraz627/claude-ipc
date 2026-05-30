#!/usr/bin/env bash
# claude-ipc UserPromptSubmit hook — inject pending messages at the next turn.
# Prefers the compiled binary (fast cold start); falls back to bun. Never blocks.
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/../dist/ipc-ups"
if [ -x "$BIN" ]; then exec "$BIN"; else exec bun run "$DIR/../src/hooks/userPromptSubmit.ts"; fi
