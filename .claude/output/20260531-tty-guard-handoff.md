# Handoff: tty-path Bash guard is too broad (blocks benign arg use)

From: ipc-dev (claude-ipc build session) · 2026-05-31 · via claude-ipc dogfood

## Symptom
A PreToolUse Bash guard denies **every** command whose string merely *contains*
a tty device path (`/dev/tty`, `/dev/ttysNNN`) — even when the path is just a
plain **argument value**, not a write target. It surfaces as
`Permission to use Bash ... has been denied` (no hook-reason line), so it's hard
to attribute. A hook edit was attempted but the match is still substring-level.

## Exact commands denied (all benign — none writes to the tty)
```
claude-ipc register badgetest --tty /dev/ttys010
bun run src/cli.ts register badgetest --tty /dev/ttys010
claude-ipc register badgetest --tty /dev/ttys010 && claude-ipc send --from ipc-dev --to badgetest ...
```
Earlier, a genuine write — `printf '\033]…' > /dev/tty` — was also denied; that
one is a real tty write and is arguably correct to gate. The `--tty <path>` arg
cases are NOT writes and should be allowed.

## Root cause (hypothesis)
The guard pattern-matches the substring `/dev/tty` anywhere in the command,
instead of matching an actual **write/redirect** to a tty device.

## The distinction it should draw
- **Block (risky):** writes/redirects to a tty —
  `> /dev/tty…`, `>> /dev/tty…`, `tee /dev/tty…`, `dd of=/dev/tty…`,
  `printf … > /dev/tty…`.
- **Allow (benign):** a tty path passed as an argument value —
  `--tty /dev/ttys010`, `register … /dev/ttys010`. No write happens; it's data.

## Suggested fix
Narrow the regex to write forms only, e.g. match
`(^|\s)(>|>>|tee|dd\s+of=)\s*/dev/tty` (plus the `printf … > /dev/tty` redirect),
rather than a bare `/dev/tty`. Or allowlist the `--tty <path>` flag form.

## Where to look
The PreToolUse Bash guards under `~/.claude/scripts/hooks/` (or wherever the
tty/terminal-safety guard lives).

## Why it matters
claude-ipc's Phase-7 tab-badge passes a tty **path** to `register`; the **broker**
(a trusted long-lived daemon) does the actual OSC write, never the agent's shell.
So the agent only ever needs to *name* a tty, not write to one — exactly the
benign case the guard is over-blocking. Net effect: the badge feature's live
visual confirmation is blocked, though the feature itself works.
