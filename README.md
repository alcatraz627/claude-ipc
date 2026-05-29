# claude-ipc

Cross-process messaging between independently-launched Claude Code sessions.
Let the agent in your **frontend** terminal hand work to the agent in your
**backend** terminal — ask a question, get an answer, request an action — without
you manually copy-pasting context between them.

> Status: **bootstrapping** (docs first, then phased build). Not yet runnable.

## The idea in one breath

Each `claude` session registers an alias (`frontend`, `backend`, …). One session
sends a message addressed to another; the recipient receives it **proactively**
(no "check your messages" reminder needed) and can reply or act. Actions require
explicit consent before they run. Every message is durably logged for audit and
replay.

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

## Design provenance

Planning artifact (full landscape, Q&A, alternatives considered):
`~/.claude/assets/reports/20260529-claude-ipc-plan/PLAN.md`.
