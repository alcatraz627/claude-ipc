# Design note — Ghostty tab badge as the Phase 7 "push rung" (no tmux)

> Goal: make a recipient *aware* of pending IPC messages on the surface the human
> already watches (the Ghostty tab), without a multiplexer, focus-steal, or
> `--channels` (unavailable in the installed Claude Code).

## VERDICT (post skeptical-review 2026-05-30)

**The "each session badges its own tab on its Stop hook" approach is DEAD.** A
session's Stop hook fires at end-of-turn; an *idle* session takes no turns, so
its hook never fires and its badge never updates — for exactly the idle-session
case this existed to solve. It's the turn-boundary rung re-skinned. Other nails
(all file:line-cited in `.claude/output/20260530-tabtitle-review/review.md`):
the hook's `/dev/tty` write fails in practice (`tab-title-emit.log` shows
`tty=0`); there is no cheap count op; tab-title is keyed by `session_id` but IPC
by `alias` (no join); and the title is fully re-emitted each turn, clobbering any
independent write (the decorator contract forbids network calls anyway).

## The viable direction — broker writes to the peer's TTY

The only non-dead variant: **the broker emits the OSC title escape directly to
each peer's captured pty, out-of-band.** Idle-proof, because the *broker* does
the write — the dormant session's hooks are not involved.

- At registration (SessionStart hook), capture the session's `TTY_PATH` (the
  tab-title system already caches it) and send it to the broker; store it on the
  registry entry alongside `session_id`/`alias`/`pid`.
- When a message is routed to a peer, the broker writes `\033]0;<title with
  badge>\007` to that peer's pty. The title escape is invisible (no display
  corruption) and is honoured by Ghostty regardless of what the Claude process is
  doing.

### Honest ceiling
This is a **signal, not a wake**: it badges the tab even while idle, but does not
make the idle session *act*. Waking-to-act needs input injection (`TIOCSTI` —
generally blocked on modern macOS) or real `--channels`. So: glance → see badged
tab → click it → your next turn delivers. Ambient awareness, idle-proof, no tmux.

### Unknowns to settle BEFORE building (prototype first)
- Prove ONE cross-tab write: from process A, write an OSC title escape to process
  B's `/dev/ttysNNN` and confirm B's Ghostty tab title changes. If this doesn't
  work cross-process, the whole direction is dead too.
- Permission/ownership of another session's pty (same user — expected OK).
- Capturing `TTY_PATH` reliably from the SessionStart hook context.
- Clearing/refreshing the badge as the inbox drains (broker re-writes on change).
- Coexistence with the gcc tab-title system's own per-turn title (the broker
  write and the session's own write will race — needs a defined owner or a
  reserved badge segment).
