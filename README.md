# claude-ipc

Cross-process messaging between independently-launched Claude Code sessions.
Let the agent in your **frontend** terminal hand work to the agent in your
**backend** terminal — ask a question, get an answer, request an action — without
you manually copy-pasting context between them.

> Status: **v0.2** — broker + MCP tools + CLI + proactive hooks + idle-proof tab
> badge, plus a post-v0.1 hardening pass: capability-token identity, conversation
> threading, retention/registry GC, and a single-binary deploy. Full `bun test`
> suite green; proven by real cross-session handoffs.

## Run it
```
bun install
bun test                                   # the suite
bun run build                              # compile CLI + hooks → dist/
bash scripts/install-launchd.sh            # run the broker as an always-on agent
claude-ipc register backend                # claim a mailbox (or it auto-registers via hooks)
claude-ipc send --from me --to backend --kind query "what's the API shape?"
claude-ipc tail                            # watch the flow (offline peers collapse to a count)
claude-ipc prune --offline-for 30m         # drop dead peers from the roster
```
The broker runs as the compiled binary (`dist/claude-ipc serve` via launchd), so
`bun run build` updates the broker and CLI together — no source/dist drift.

## The idea in one breath

Each `claude` session registers an alias (`frontend`, `backend`, …) and gets a
**capability token** — a `0600` file that proves ownership, so no other process
can send as you or read your inbox. One session sends a message addressed to
another; the recipient receives it **proactively** (no "check your messages"
reminder needed) and can reply or act. A responder can **acknowledge on receipt,
stream interim updates, then send the final** — all correlated to one request,
so work-in-progress is visible without waiting for the whole task. Actions
require explicit consent before they run. Every message is durably logged for
audit and replay; the roster and log are garbage-collected so neither grows
without bound.

## Why it's not trivial

A running `claude` can't be interrupted mid-turn. Delivery therefore rides a
**ladder** by recipient state: native `--channels` push into a running session →
a `UserPromptSubmit` hook injecting at the next turn → a `SessionStart` hook
replaying a queue on resume → an on-demand `ipc_check` tool. See the docs.

## Documentation (read in order)

1. [`docs/01-spec.md`](docs/01-spec.md) — what it is, goals, requirements, scope
2. [`docs/02-behavior.md`](docs/02-behavior.md) — externally observable behavior + scenarios
3. [`docs/03-architecture.md`](docs/03-architecture.md) — components, data flow, decisions
4. [`docs/04-technical-implementation.md`](docs/04-technical-implementation.md) — build-level detail
5. [`docs/05-roadmap.md`](docs/05-roadmap.md) — phases, goals, testing criteria, cadence
6. [`docs/06-security-and-ops.md`](docs/06-security-and-ops.md) — identity/token model, threat model, retention, deploy

## Design provenance

Planning artifact (full landscape, Q&A, alternatives considered):
`~/.claude/assets/reports/20260529-claude-ipc-plan/PLAN.md`.
