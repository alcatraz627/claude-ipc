# Activating the claude-ipc i-dream domain

One-way feed: i-dream reads the claude-ipc message log as a behavioural signal;
claude-ipc never depends on dreaming. Removable any time.

## Activate
1. `cp extract-events.sh ~/.claude-ipc/extract-events.sh && chmod +x ~/.claude-ipc/extract-events.sh`
2. `cp dream/prompt.md ~/.claude-ipc/ipc-dream-prompt.md`
3. `cp ipc.toml ~/.claude/i-dream/domains/ipc.toml`
4. Ensure `claude-ipc` is on PATH and the broker has run (so `claude-ipc log` works)
   and `jq` is installed.

i-dream auto-discovers the domain and dreams over it on its cadence.

## Remove
Delete `~/.claude/i-dream/domains/ipc.toml`. Nothing in claude-ipc depends on it.
