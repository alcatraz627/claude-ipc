# Design note — tab-title badge as the Phase 7 "push rung" (Ghostty, no tmux)

> Status: proposal, not built. Replaces the tmux "wake" adapter (rejected — the
> user keeps plain Ghostty tabs, no multiplexer). This is the ambient-awareness
> alternative to `--channels` (unavailable in the installed Claude Code).

## Goal

Make a recipient *aware* of pending IPC messages without the human remembering to
check, and without a multiplexer or focus-stealing automation. Not true
auto-wake (only `--channels` does that) — ambient signalling on the surface the
human already watches: the Ghostty tab.

## Mechanism

Each session stamps **its own** Ghostty tab title with a pending-IPC badge:
- On the **Stop hook** (fires end of every turn — the tab-title system's stated
  refresh point), the session runs `claude-ipc inbox <self> --count` (a new cheap
  count op) and sets a badge like `📨 2` via the gcc tab-title CLI.
- When the inbox is empty, clear the badge.
- Optionally, a macOS notification for the first arrival / high-priority.

The human glances at the tab strip, sees a tab with mail, clicks it; their next
prompt there fires the UPS hook → the message is delivered. No tmux, no
focus-steal, no auto-execute.

## Assumptions that MUST be verified (do not pattern-match)

- **A1** — the gcc tab-title CLI (`~/.claude/scripts/tab-title/tab-title.sh`)
  sets the *current* session's Ghostty tab title, and can be invoked from an
  arbitrary hook process (not just interactively).
- **A2** — a Stop-hook invocation per turn is the right cadence; the tab-title
  doc claims "visible refresh happens once per turn at end-of-turn Stop hook".
- **A3** — badging coexists with the existing tab-title slots
  (`status`/`mode`/`intent`/`focus`/glyphs) — is there a free slot, or does IPC
  need a new decorator slot? Will it fight gcc's own per-turn title churn?
- **A4** — the title set by one hook persists until the next turn (not clobbered
  mid-turn by other tab-title writers).
- **A5** — cost: an inbox-count socket round-trip on every Stop hook, in every
  session, globally. Acceptable per-turn overhead?
- **A6** — clearing semantics: badge must clear when the inbox drains, and not
  flicker.
- **A7** — which session badges when two share an alias; and a session addressed
  by UUID (no friendly alias) still badges correctly.
- **A8** — macOS notification path (terminal-notifier? osascript?) and whether it
  needs permissions / is disruptive.

## Open questions

- Does this need a new `ipc` tab-title slot, or can it ride an existing one?
- Is a per-turn inbox count cheap enough, or should the broker push a count to a
  per-session file the hook just reads (no socket round-trip)?
- Is "ambient badge" actually enough for the user's "ask an idle session" case,
  or does that specific case still require `--channels`?
