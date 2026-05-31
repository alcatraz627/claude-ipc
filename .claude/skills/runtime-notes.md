## session: claude-ipc full build (v0.1) — 2026-05-31

Purpose: design + build cross-process IPC for Claude Code sessions, plan → docs →
9 phases → v0.1 shipped + globally installed (ambient).

Insights:
- **The host bounds the design.** No `--channels` in the installed CC → delivery
  is a LADDER (channel-push absent → UPS-hook inject at next turn → SessionStart
  resume drain → on-demand pull). "Proactive while idle" is only true via the
  Phase-7 broker→TTY badge (the broker writes the OSC title to a peer's pty
  itself — idle-proof). It's a SIGNAL, not a wake; true wake needs channels or
  TIOCSTI (blocked). Don't promise idle-push the host can't do.
- **Storage model is per-recipient, not a queue.** Immutable `messages` +
  per-recipient `deliveries` (queued/delivered/surfaced/consumed/accepted/
  declined) + sender `awaiting`. This is why honker was rejected (its worker
  queue claim/ack can't model per-recipient delivery+consent). The split came
  from the pre-build skeptical review — worth doing before any storage code.
- **Dogfooding falsified our own decisions.** Using it on itself caught: the 1h
  default TTL + reply-after-timeout-drop threw away a real 2h-late reply (fixed:
  no default timeout, late replies deliver unless cancelled). And a bug report
  handed to another session over IPC got fixed + reported back — the system
  working as designed.
- **tty is the recurring wall.** Hooks/agent subprocesses have no controlling
  tty (tty=0); only the broker (holding a peer's cached TTY_PATH) can write to a
  tab. Same wall blocks agent-launched TUIs → the compose wizard rides the host's
  input UI, not curses. And never add a network call to the gcc tab_compose hot
  path (decorator no-network contract) — use a broker-written count FILE instead.
- **Guards are load-bearing.** cli-gating blocked the publish; index-guard
  blocked `git rm`; a settings.json deny-glob blocked tty-path args. Each correct;
  surface + hand to the user via `!`, don't route around.

---
