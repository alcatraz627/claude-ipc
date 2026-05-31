#!/usr/bin/env bash
# Install/refresh the claude-ipc broker as an always-on launchd agent.
# Modern API (bootstrap/bootout); no sudo (it's a per-user gui agent). Falls back
# to the foreground daemon if bootstrap fails. Run: bash scripts/install-launchd.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.alcatraz.claude-ipc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
CLI="claude-ipc"
command -v "$CLI" >/dev/null 2>&1 || CLI="bun run $REPO/src/cli.ts"

mkdir -p "$HOME/.claude-ipc/logs" "$HOME/Library/LaunchAgents"
cp -f "$REPO/launchd/$LABEL.plist" "$PLIST"

echo "→ stopping any existing broker (launchd + foreground)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
$CLI daemon stop 2>/dev/null || true
sleep 1

echo "→ bootstrapping launchd agent"
if launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "  bootstrap ok (KeepAlive — survives reboot)"
else
  echo "  bootstrap failed; starting foreground daemon instead (persists across"
  echo "  sessions, not reboot)"
  ( cd "$REPO" && bun run src/cli.ts daemon start >/dev/null 2>&1 )
fi

sleep 2
echo -n "→ status: "
$CLI daemon status
echo "(to stop the launchd agent later: launchctl bootout $DOMAIN/$LABEL)"
