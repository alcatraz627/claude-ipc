## session: post-v0.1 review + hardening — 2026-06-01

Purpose: root-caused the empty-`tail` bug, then a full review → fixed Tiers A
(robustness), B1 (identity), C (threading), D (ops). 93 tests, 0 fail; all live.
Follow-up same day → roster GC + strict identity + housekeeping (v0.2.0, 95 tests),
then incremental replies + worth-doing gaps (98 tests).

Insights (incremental replies):
- **The capability was already in the data model.** `reply` has a `terminal`
  flag; a non-terminal reply leaves the awaiting open. So "ack → update → final"
  needed only ergonomics (`ipc_ack`/`ipc_update` verbs) + fixing `await` to wait
  for the terminal (it returned on the first reply). The user explicitly rejected
  a threads/topics abstraction as premature — corrId + auto-conversationId is the
  whole stateful primitive. Resisted the urge to build more.
- **Dogfooding caught a bug 98 tests missed.** The live CLI `reply --from bob
  --partial "on it"` produced an EMPTY interim — the arg parser treated `--partial`
  as a value flag and ate the body. Tests passed (they call the client API, not
  the CLI parser). Lesson reaffirmed: run the actual user-facing path once, don't
  trust "tests pass." Fixed with a BOOLEAN_FLAGS set + a CLI regression test.

Insights (follow-up):
- **Tokens authenticate; they don't curate the roster.** `tail` showed 35 peers,
  mostly dead `/private/tmp` UUID sub-agents — because the global SessionStart
  hook makes EVERY claude process (incl. Task sub-agents, headless runs) register,
  and the registry only marks offline, never deletes. Fix is GC, not auth:
  `registry.pruneOffline` in the sweeper + `claude-ipc prune` + a `tail` that
  collapses the offline graveyard to a count. Don't conflate "who can act" (tokens)
  with "who's worth showing" (roster hygiene).
- **Strict identity closes the one real B1 hole cheaply.** The "send as an
  unregistered alias" window shut by requiring `from` to be registered
  (`CLAUDE_IPC_STRICT`, default on) — safe because real sessions register via the
  hook before they send, and legacy null-token aliases are still *registered* so
  they pass. Degraded-mode strict refuses to act on an alias with no local token
  (honest soft check, not a hard boundary — documented).

Insights:
- **The empty `tail` was unhandled socket back-pressure.** `socket.write()`
  accepts only up to the ~8 KB send-buffer watermark and returns the count; the
  broker (and client) ignored it, so an 11.5 KB `history` frame was truncated and
  the length-prefix decoder waited forever. A hang, not an error — and size-gated,
  so every hand-tested small op passed. Fix: per-connection outbox + `drain` pump,
  both directions. The #1 lesson: stream `write` is not a datagram.
- **A skeptical-review sub-agent caught two HIGH bugs I'd just written** — the MCP
  server crashing on a broker-down startup (degraded `register` throws, right next
  to the fallback I added), and a post-restart alias-hijack window (warm-started
  entries are `offline`, and my guard only protected non-offline). Fresh adversarial
  context > self-review. Both were "tests pass, wiring routes around it."
- **Held independent judgment on B1.** The review framed identity as "bind
  connection→alias", but connections are per-request/stateless and "hijack" is the
  same op as the legit "reconnect alias" feature. Surfaced the fork to the user
  rather than shipping a watered-down or feature-breaking version → chose tokens.
- **`bun:sqlite` is synchronous + Bun is single-threaded**, so the reviewer's
  "claimForDelivery TOCTOU" was NOT an in-broker race (no yield between SELECT and
  UPDATE). It only becomes real once a degraded client writes the same DB. Made the
  claim atomic (`UPDATE … RETURNING`) anyway — cheap, and A4 makes it load-bearing.
- **Single-binary deploy kills drift.** Added `claude-ipc serve`; launchd now runs
  `dist/claude-ipc serve`, so `bun run build` updates broker + CLI together. The
  broker had been running from source while the CLI shipped from dist.

---

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
