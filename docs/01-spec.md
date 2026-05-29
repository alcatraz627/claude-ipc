# 01 · Specification

> What claude-ipc is, the problem it solves, and the requirements it must meet.
> This document is the root of the chain — behavior, architecture, and
> implementation all derive from it. It describes **what** and **why**, never
> **how**.

---

## 1. Problem statement

A developer often runs several Claude Code sessions in parallel against one
codebase — e.g. one on the Next.js frontend, one on the Python backend, one on
repo tooling / CI / docs, sometimes one doing live end-to-end testing. Each
session has its own context and history, which is the point: focused attention
per surface. The cost appears at **task boundaries**:

- A backend change needs frontend support, but the frontend session has no idea
  what the backend session just did.
- Bridging two systems with very different project contexts (e.g. the atone and
  dreaming layers) forces the developer to hand-carry messages between sessions.
- Risky work arises in a session running in a restricted permission mode and
  should be handed to a session running with broader permissions.

Today the developer is the message bus: they read one session, summarize, and
paste into another. claude-ipc removes the developer from that loop for the
**transport**, while keeping them in the loop for **intent and consent**.

## 2. Vision

Independently-launched Claude sessions address each other by alias and exchange
messages. A recipient becomes aware of a message **without being reminded to
look**. Messages can be informational, a question, or a request to act; actions
are surfaced for explicit consent before they run. Every exchange is durably
recorded so any participant — human or agent — can later reconstruct who said
what, when, and how it resolved.

## 3. Goals

- **G1 — Cross-process delivery.** Move a message from one independently-started
  `claude` process to another on the same machine.
- **G2 — Proactive receipt.** The recipient surfaces a message on its own, at
  the earliest delivery opportunity, without the user prompting it to check.
- **G3 — Explicit send.** The sender (and the human behind it) always names the
  target. The system never infers or guesses a recipient.
- **G4 — Request / reply.** Support correlated question→answer and
  request→result exchanges, including sustained multi-message threads.
- **G5 — Consent-gated actions.** A message asking a recipient to *do* something
  is surfaced as a proposal and runs only after explicit acceptance.
- **G6 — Durability & audit.** Every message is persisted; history is queryable
  after the fact (who / what / when / result).
- **G7 — Offline queueing.** A message addressed to a session that is not
  currently running is held and delivered when that session next starts/resumes.
- **G8 — Liveness & status.** A participant can see which peers are alive and the
  delivery/handling status of any message it sent.
- **G9 — Safe by composition.** Delivered content cannot bypass the host's
  existing guardrails; acting on a message goes through the same checks as any
  other action.
- **G10 — Resilience.** Degrade gracefully when the broker is down; iterative
  development must not break fundamental goals or previously shipped behavior.

## 4. Non-goals (explicitly out of scope, at least initially)

- **N1** — Synchronous interrupt of a running turn. Delivery is asynchronous by
  the nature of the host; we do not attempt to preempt a session mid-turn.
- **N2** — Cross-machine / networked transport. Same-machine first; the design
  keeps transport swappable, but LAN/cloud is deferred.
- **N3** — Untrusted multi-tenant security. All participants are assumed to be
  the same user. Authn/authz between mutually-distrusting peers is deferred
  (a seam is reserved, not built).
- **N4** — Automatic target selection or auto-replying on the user's behalf.
- **N5** — A shared global context window. Each agent keeps its own context;
  the system carries deltas and pointers, not a merged transcript.
- **N6** — Replacing native Agent Teams for single-session subagent fan-out.

## 5. Primary use cases

- **UC1 — Parallel-surface handoff.** Backend session changes an API response
  shape and informs the frontend session; or requests the frontend regenerate
  its types. The frontend adapts without a manual relay.
- **UC2 — Cross-context bridge.** Two sessions with very different project
  contexts exchange messages that self-describe their origin context, so neither
  developer nor agent has to restate it.
- **UC3 — Privilege handoff.** A restricted-mode session hands genuinely risky
  work to a broader-permission session as a consented request.

## 6. Actors

- **Human operator** — runs sessions, names targets, approves actions, watches a
  monitor. The only actor that initiates intent.
- **Claude session (peer)** — a registered participant; sends explicitly,
  receives proactively, may reply or (with consent) act.
- **Broker** — the component that stores, routes, and tracks messages and
  liveness. (Its form is an architecture decision, not a spec concern.)

## 7. Domain vocabulary — message taxonomy

Messages are categorized by **speech-act**. Lifecycle (acknowledgement,
progress, error) is expressed as fields on these kinds, not as additional kinds.

| Kind | Meaning | Expects response? | Consent to act? |
|------|---------|-------------------|-----------------|
| `inform` | Share something; FYI; broadcast | no | n/a |
| `query` | Ask for information (read-only) | yes | no |
| `request` | Ask the peer to perform work (side-effects) | yes | **yes** |
| `response` | Correlated outcome of a query/request | n/a | n/a |
| `control` | Registry/coordination, no user content | n/a | n/a |

- A `response` carries `status: ok | error` and `terminal: true | false`
  (`false` = an interim ack or progress note; `true` = the final outcome).
- An error is a `response{status:error}` with an `error_code`
  (`timeout | no_peer | declined | internal`), not a separate kind.
- `control` operations: `register | heartbeat | leave | cancel | claim | release`.
- Messages are addressed to a single alias or to broadcast (`*`).
- Correlated exchanges share a `corr_id`; sustained threads share a
  `conversation_id`.

**Deferred kinds (named, not built):** topic `subscribe`/pub-sub fan-out,
streaming/chunked payloads, a distinct `capability` kind (capabilities ride the
`register` payload).

## 8. Functional requirements

- **FR1** — A session can register an alias and optional capability tags, and
  deregister on exit.
- **FR2** — A session can send a message of any conversational kind to a named
  alias or broadcast.
- **FR3** — A recipient is made aware of pending messages proactively at the
  earliest delivery opportunity available for its current state (see §10).
- **FR4** — A recipient can pull pending messages on demand.
- **FR5** — A recipient can reply to a `query`/`request`, including interim
  (non-terminal) replies, correlated by `corr_id`.
- **FR6** — A `request` is surfaced as a proposal; the recipient must explicitly
  accept before any action is taken on it; it may also decline.
- **FR7** — The broker synthesizes `response{error}` for undeliverable or
  unanswered messages (`no_peer`, `timeout`), and a recipient can emit
  `declined`.
- **FR8** — A message to an offline alias is queued and delivered when that
  alias's session next starts or resumes.
- **FR9** — A participant can list live peers with their alias, context (cwd),
  and last-seen time.
- **FR10** — A participant can query the status/lifecycle of a message it sent.
- **FR11** — A participant can query message history (who/what/when/result),
  filterable by peer and time.
- **FR12** — A human can perform send / inbox / peers / log / accept / monitor
  operations from a CLI, independent of any session.
- **FR13** — A message may carry a pointer to the sender's transcript/context
  (session id, path, cwd) instead of copying bulk content.

## 9. Non-functional requirements

- **NFR1 — Proactivity without nagging.** Receipt must not depend on the user
  telling the agent to check.
- **NFR2 — Low overhead.** Per-turn cost on the host session is bounded and
  small (target: a single indexed lookup, low tens of milliseconds); no
  per-tool-call hooks.
- **NFR3 — Durability.** No acknowledged message is lost across broker restarts.
- **NFR4 — Graceful degradation.** With the broker unavailable, sends still
  persist and receipts still occur at the next turn; only proactive push and
  active error-synthesis are lost.
- **NFR5 — Observability.** A dead broker and message flow are visible to the
  human (status command + monitor), never silently failing.
- **NFR6 — Composable safety.** The system adds only injection/observation to
  the host; it never weakens existing guardrails. Acting on a message is
  subject to all normal pre-action checks.
- **NFR7 — Swappable transport/storage.** The storage+queue substrate sits
  behind a stable interface so it can be replaced without changing tool or hook
  contracts.
- **NFR8 — Testability.** Every component is exercisable with mock data via
  unit and integration tests; resilience is a tested property, not an aspiration.

## 10. Hard constraint — the delivery ladder

Delivery capability depends on the recipient's state. This is a property of the
host (Claude Code), not a design choice, and it bounds every behavior:

| Recipient state | Reachable | Earliest opportunity |
|-----------------|-----------|----------------------|
| running, push channel available | yes, proactively while idle | immediately |
| running, no push channel | yes | its next turn boundary |
| exited / closed | yes (queued) | next start/resume |
| any | yes | on-demand pull |

The system must function on the always-available rungs (turn-boundary injection,
resume replay, on-demand pull) and treat proactive push as an enhancement, not a
prerequisite.

## 11. Trust & consent model

All participants are the same user, so the system does **not** authenticate
peers (N3). It does enforce **consent**: a delivered `request` is inert context
until explicitly accepted. "Trusted" removes authentication, not consent — an
injected instruction never auto-executes. A seam is reserved for a future
per-target allowlist (e.g. only certain peers may target a broad-permission
session) without committing to an auth system now.

## 12. Success criteria

- **SC1** — Two sessions in two terminals complete a `query`→`response` round
  trip with the recipient surfacing the question unprompted (UC1).
- **SC2** — A `request` is delivered, surfaced as a proposal, accepted, acted
  on, and its result returned; declining and timeout both yield a clean
  `response{error}`.
- **SC3** — A message left for an offline alias is delivered on that session's
  next launch.
- **SC4** — History for a completed exchange reconstructs who/what/when/result.
- **SC5** — Killing the broker mid-operation loses no acknowledged message and
  the system continues in degraded mode; restart resumes full function.
- **SC6** — Acting on a delivered `request` that names a guarded operation is
  still stopped by the host's existing guardrail.
- **SC7** — The developer reports a real parallel-session handoff completed
  without manual copy-paste (dogfooding milestone).

## 13. Glossary

- **Peer / instance** — a registered Claude session.
- **Alias** — a human-chosen name addressing a peer (`frontend`).
- **Broker** — stores, routes, tracks messages + liveness.
- **Delivery ladder** — the state-dependent set of delivery mechanisms (§10).
- **Proactive receipt** — recipient surfaces a message without a user reminder.
- **Consent / accept** — explicit approval required before acting on a `request`.
- **corr_id** — correlates a `response` to its originating `query`/`request`.
- **conversation_id** — groups a sustained multi-message thread.
- **WAL / log** — durable append-only record of every message.
- **Dogfooding** — using claude-ipc to build claude-ipc.
