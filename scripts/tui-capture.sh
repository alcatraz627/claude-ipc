#!/bin/bash
# Capture dashboard frames for verification: raw ANSI is color truth; the
# optional PNG (freeze) DROPS background SGR and dim tints, so judge structure
# there and color only in the .ansi file or a real terminal. Frames settle
# before capture (measured 2026-07-20: ~6s to steady state).
#
#   scripts/tui-capture.sh [--cmd "<cmd>"] [--keys "<key> ..."] [--settle N]
#                          [--out <dir>] [--png] [--keep] [--name <slug>]
#
#   --cmd     what to run in the pane (default: bun src/cli.ts -i from the repo root)
#   --keys    tmux send-keys arguments sent after the settle (e.g. "Escape" or "@")
#   --settle  seconds to wait before capturing (default 6)
#   --png     also render a PNG via freeze, with the color caveat above
#   --keep    leave the tmux session running for a by-hand walk
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CMD="bun src/cli.ts -i"
KEYS=""
SETTLE=6
OUT="$REPO/.claude/output/tui-captures"
PNG=0
KEEP=0
NAME="frame-$(date +%H%M%S)"
while [ $# -gt 0 ]; do
  case "$1" in
    --cmd) CMD="$2"; shift 2 ;;
    --keys) KEYS="$2"; shift 2 ;;
    --settle) SETTLE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --png) PNG=1; shift ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown flag: $1 (see the header of this script)" >&2; exit 2 ;;
  esac
done

command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
mkdir -p "$OUT"
SESH="ipccap-$$"
tmux kill-session -t "$SESH" 2>/dev/null || true
tmux new-session -d -s "$SESH" -x 120 -y 32
tmux send-keys -t "$SESH" "cd $REPO && $CMD" C-m
sleep "$SETTLE"
if [ -n "$KEYS" ]; then
  # shellcheck disable=SC2086 -- keys are deliberately word-split for tmux
  tmux send-keys -t "$SESH" $KEYS
  sleep 1
fi

ANSI="$OUT/$NAME.ansi"
TXT="$OUT/$NAME.txt"
tmux capture-pane -e -p -t "$SESH" > "$ANSI"   # color truth
tmux capture-pane -p -t "$SESH" > "$TXT"       # grep-friendly
echo "ansi (color truth): $ANSI"
echo "text:               $TXT"

if [ "$PNG" -eq 1 ]; then
  if command -v freeze >/dev/null; then
    freeze --execute "cat '$ANSI'" -o "$OUT/$NAME.png" >/dev/null 2>&1 &&
      echo "png (structure only; bg colors + dim tints are DROPPED): $OUT/$NAME.png"
  else
    echo "freeze not installed; skipping png (brew install charmbracelet/tap/freeze)" >&2
  fi
fi

if [ "$KEEP" -eq 1 ]; then
  echo "session kept: tmux attach -t $SESH   (kill: tmux kill-session -t $SESH)"
else
  tmux kill-session -t "$SESH" 2>/dev/null || true
fi
