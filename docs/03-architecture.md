# 03 · Architecture

> The components that realize the behaviors in `02-behavior.md`, how they
> connect, and the load-bearing decisions. Component- and data-flow-level; exact
> signatures, schemas, and file layout are in `04-technical-implementation.md`.

---

## 1. Overview

claude-ipc is a **broker with a write-ahead log**. A single long-lived **broker**
is the live authority (routing, ordering, correlation, timeouts, liveness).
Every message is also appended to a **durable log** for audit and crash replay.
Each Claude session reaches the broker through **thin clients** — an MCP server
(for the agent) and a CLI (for the human) — and is fed incoming messages through
the **delivery ladder** (channel push / hooks / on-demand).

```
   Session A (backend)                 BROKER (one process)            Session B (frontend)
 ┌───────────────────────┐        ┌────────────────────────┐      ┌───────────────────────┐
 │ MCP server (thin)      │        │  router + correlation   │      │ MCP server (thin)      │
 │  ipc_* tools ──────────┼──sock─▶│  registry (live peers)  │◀sock─┼── ipc_* tools          │
 │ hooks: UPS/SStart/Stop │        │  timeout sweeper        │      │ hooks: UPS/SStart/Stop │
 │ channel adapter (opt)  │◀push───┤  delivery dispatcher    ├─push─▶│ channel adapter (opt) │
 └───────────┬───────────┘        │  storage backend (iface)│      └───────────┬───────────┘
             │                     └───────────┬────────────┘                  │
        CLI / monitor ────────sock────────────▶│ appends every message         │
        (human)                                ▼                               │
                                   durable log + registry store ◀──────────────┘
                                   (SQLite/honker | JSONL)
```

## 2. Components

### 2.1 Broker (daemon)
The live authority. Responsibilities:
- Accept client connections over a Unix domain socket.
- Maintain the **in-memory registry** of live peers (alias → session, cwd,
  last-seen, status), fed by `register`/`heartbeat`/`leave`.
- **Route** each message to the recipient's queue; fan out broadcasts.
- **Correlate** responses to their origin by `corr_id`; track awaiting
  query/request and their TTLs.
- **Sweep timeouts**, synthesizing `response{error,timeout|no_peer}`.
- **Dispatch delivery** via the best available ladder rung for each recipient.
- Append every message to the **storage backend** before acknowledging.
- **Replay** the log on startup to rebuild in-flight state.
Independent of the gcc subconscious daemon (separate crash domain).

### 2.2 Storage backend (swappable interface) — key decision
A single interface (`StorageBackend`) abstracts durability + queueing so the
substrate is replaceable without touching tool/hook contracts [NFR7].
Implementations:
- **in-memory** — a trivial backend used by tests AND as the *second*
  implementation that validates the abstraction EARLY (Phase 1–2), so the
  interface is proven by two impls long before honker — not discovered at Phase 8
  (review #13).
- **SQLite hand-rolled** (`bun:sqlite`) — the default: immutable `messages` +
  `deliveries` + `awaiting` tables. Full control, zero exotic deps.
- **honker** (SQLite extension: durable pub/sub + streams w/ offsets +
  at-least-once queue + scheduler) — maps deliveries to `queue()`, the log to a
  `stream()`, timeouts to the scheduler, broadcast to `notify()`. **Alpha**, so
  opt-in and deferred to Phase 8.
The broker holds one backend instance; the choice is config, not a rewrite.

### 2.3 MCP server (per-session thin client)
Each session spawns its own stdio MCP server (the host spawns one instance per
session — a stdio server therefore *cannot* be the shared broker). It is
**stateless**: every `ipc_*` tool call is forwarded to the broker over the
socket and the result returned. This is how the agent sends, checks, replies,
accepts, cancels, and lists peers.

### 2.4 Hooks (delivery + lifecycle)
Thin shims registered in the host's settings, each a client of the broker:
- **UserPromptSubmit** — query the broker for this session's pending messages and
  inject them as context at the next turn (the always-works delivery rung).
  Injection-only; never blocks.
- **SessionStart** — register/re-register the alias and drain the offline queue
  (resume replay).
- **Stop** — emit heartbeat/idle; on session teardown, `control:leave`.
No `PostToolUse` hook (cost) [NFR2]. None ever returns `decision:block` [NFR6].

### 2.5 Channel adapter (optional push)
When the host's `--channels` push is available, a small adapter lets the broker
push a message into a *running, idle* session — the top ladder rung. Optional
and feature-detected; absence degrades to the hook rung, not failure.

### 2.6 CLI (human thin client)
`claude-ipc <verb>` — the human's socket client for send / inbox / peers / log /
accept / decline / tail / daemon control. Independent of any session.

### 2.7 Monitor
A live view (CLI `tail` TUI, optionally a pane in the existing claude-instances
widget) of message flow + peer liveness, for human observability [NFR5].

## 3. Data flows

**Send (query/request):**
```
 agent ipc_send ─▶ MCP ─sock▶ broker: persist(log) → enqueue(recipient)
                                     → mark QUEUED → return msg-id
                              if recipient live: dispatch delivery
                              if unknown alias: response{error,no_peer}
```

**Receive (turn-boundary rung):**
```
 host fires UserPromptSubmit ─▶ hook ─sock▶ broker: pending(session)
   ─▶ hook injects as context (idempotent) ─▶ broker marks DELIVERED
   agent reads it (SURFACED); ipc_check/accept ─▶ CONSUMED
```

**Receive (push rung):** broker dispatcher → channel adapter → running session,
proactively.

**Receive (resume rung):** host fires SessionStart → hook drains queue → ordered
backlog injected.

**Consent (request):** surfaced as proposal → `ipc_accept` ─sock▶ broker marks
ACCEPTED → agent acts (through host guards) → `ipc_reply(terminal)` →
broker correlates → sender's message RESPONDED.

**Timeout/error:** sweeper finds an awaiting message past TTL → synthesizes
`response{error,timeout}` → routes to sender.

## 4. Data model (logical)

- **Message (immutable):** `id, conversation_id, corr_id, from_alias, to_alias|*,
  kind, status, error_code, terminal, op, body, context_ptr{session_id,path,cwd},
  ttl, ts`. Never mutated after append.
- **Delivery (per recipient):** `msg_id, to_alias, via, state, ts` — a broadcast
  yields one row per recipient; this table *is* the queue (rows in `state=queued`).
- **Awaiting (sender's open request):** `origin_id, expires_at, closed,
  closed_reason`.
- **Registry entry:** `alias, session_id, cwd, caps[], pid, last_seen, status`.
The log is the source of truth for history; the registry is in-memory with a
periodic snapshot for restart warm-up; the queue is derivable from the log but
materialized for fast lookup.

## 5. Transport

Unix domain socket (local; binds no TCP port, so the multi-instance port-conflict
class is avoided entirely). Length-prefixed JSON request/response frames; one
short-lived connection per client call (clients are stateless). The socket path
and a protocol version live in config. Cross-machine transport is a future
backend swap, not a Phase-1 concern [N2].

## 6. Delivery ladder (mechanism mapping)

| Rung | Mechanism | Availability |
|------|-----------|--------------|
| push | channel adapter → `--channels` | when host supports it (feature-detected) |
| turn-boundary | UserPromptSubmit hook injection | always |
| resume | SessionStart hook drain | always |
| on-demand | `ipc_check` tool / CLI `inbox` | always |

The dispatcher picks the highest available rung per recipient; lower rungs are
always-on fallbacks. Idempotency is enforced **per recipient** by the `deliveries`
row's `state`: a message already marked `delivered` for an alias is not re-injected
by the proactive path.

## 7. Liveness & registry

Liveness is fed by IPC's own `register`/`heartbeat`/`Stop` hooks — the broker does
NOT depend on any external/gcc heartbeat signal (review #18 dropped that claim).
The broker ages entries: fresh → `live`, stale → `idle`, very stale → `offline`.
`ipc_list` reads the in-memory registry (snapshotted to disk on change +
periodically), not file timestamps, so it is authoritative and cheap — and known
aliases survive a broker restart.

## 8. Integration seams

- **Guardrail composition (host):** IPC hooks are additive and injection-only;
  acting on any delivered message flows through the host's existing PreToolUse
  guards. IPC cannot weaken them [NFR6, B4].
- **Dreaming (i-dream), one-way, deferred:** register an `ipc` domain manifest so
  the dreaming layer *reads* the message log as a behavioral signal. IPC never
  calls into dreaming; removable; no process coupling. Phase 5.
- **gcc reuse:** model the daemon on the existing socket+launchd daemon pattern;
  reuse the append-only JSONL/event emission and heartbeat patterns; model the
  MCP server and CLI dispatcher on existing exemplars. (Patterns, not processes.)

## 9. Failure & degradation model

- Broker is `KeepAlive`-restarted; on restart it replays the log to rebuild
  in-flight state — no acknowledged message lost [NFR3, SC5].
- If a client cannot reach the socket: **degraded mode** — sends append directly
  to the durable log; receipts read the log directly; the broker reconciles on
  return. Lost while down: proactive push + active timeout synthesis [NFR4].
- A downed broker is surfaced by `daemon status` and the monitor, never as an
  empty inbox [NFR5].
- The honker backend narrows the failure surface (no daemon to die for storage),
  at the cost of alpha-stability — an explicit tradeoff captured in §11.

## 10. Security & trust

No peer authentication (all participants are one user) [N3]. Consent is enforced
structurally: a `request` is inert until `ipc_accept`. A reserved seam — a
per-target allowlist consulted by the broker before routing/surfacing a
`request` — allows a future "only X may task the broad-permission peer" rule
without building an auth system now [§11 spec].

## 11. Key decisions (ADR-style)

- **D1 — Dedicated broker, not the subconscious daemon.** Separate crash domain;
  messaging and introspection have different reliability contracts.
- **D2 — Broker + WAL, not filesystem-only.** Only an active process can
  synthesize timeouts/no_peer, guarantee ordering, and push; the log gives
  durability. Filesystem-only cannot fail loudly.
- **D3 — Swappable storage behind one interface.** Hand-rolled default; honker
  prototyped behind it. Avoids betting the system on alpha software while
  keeping its upside reachable.
- **D4 — Delivery is a ladder, not one mechanism.** Build the always-works rungs
  first; treat `--channels` push as an enhancement (it is a research preview).
- **D5 — Stateless thin clients.** MCP server and CLI hold no state; the broker
  is the single source of truth. Forced by one-stdio-MCP-instance-per-session.
- **D6 — Speech-act taxonomy with lifecycle as fields.** Five kinds; ack /
  progress / error are fields on `response`, keeping the set small and complete.
