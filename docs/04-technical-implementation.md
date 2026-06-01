# 04 · Technical Implementation

> Build-level detail realizing `03-architecture.md`: stack, layout, schemas,
> wire protocol, and the exact tool/hook/CLI contracts. Specific enough to
> implement against; the roadmap sequences it. **Stack: Bun + TypeScript.**

---

## 1. Stack & conventions

- **Runtime/language:** Bun + TypeScript. Chosen over Python for two concrete
  reasons (see decision log): `bun build --compile` yields standalone binaries —
  killing both the per-prompt **hook startup cost** (the only real hot path) and
  **runtime/version drift** — and Bun ships a fast **built-in SQLite** and **test
  runner**, so the durability core and tests need zero external deps.
- **Built-ins used:** `bun:sqlite` (storage), `bun:test` (tests), `Bun.listen`/
  `Bun.connect` (Unix-socket transport), TOML import (config). No framework.
- **External dep (Phase 4 only):** `@modelcontextprotocol/sdk` (TS MCP SDK).
- **Style:** `strict` TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`);
  `tsc --noEmit` as the typecheck gate; small modules; discriminated unions over
  classes for messages.
- **Runtime home:** `${CLAUDE_IPC_HOME:-~/.claude-ipc}` →
  `run/ipc.sock`, `data/ipc.sqlite`, `logs/`. Never committed (`.gitignore`).
- **Distribution:** dev runs via `bun run`; the broker, CLI, and the hot-path
  hook are compiled to standalone binaries under `dist/` for production use.

## 2. Repository layout

```
claude-ipc/
  package.json                  # scripts, bin, deps; type=module
  tsconfig.json                 # strict; bun-types
  bunfig.toml                   # (optional) test/runtime config
  docs/                         # 00..05
  src/
    index.ts                    # version + public surface
    config.ts                   # load config.toml + env; paths; TTLs; backend
    models.ts                   # Message + unions/const-enums (Kind, State…)
    protocol.ts                 # frame encode/decode; Request/Response types
    client.ts                   # thin Unix-socket client (MCP, CLI, hooks use it)
    storage/
      base.ts                   # StorageBackend interface
      sqliteBackend.ts          # default: bun:sqlite log + queue + registry snapshot
      honkerBackend.ts          # optional (alpha): honker queue/stream/scheduler
    broker/
      server.ts                 # Bun.listen Unix-socket server; sweeper; main
      router.ts                 # route, correlate, broadcast, consent, identity
      registry.ts               # in-memory liveness + tokens; aging; roster GC
      sweeper.ts                # TTL/timeout → response{error}; retention purge
      log.ts                    # broker's size-rotated operational log
    mcpServer.ts                # stdio MCP server exposing ipc_* tools
    cli.ts                      # claude-ipc dispatcher (bin)
    hooks/
      userPromptSubmit.ts       # inject pending (turn-boundary rung) — compiled
      sessionStart.ts           # register + drain offline queue (resume rung)
      stop.ts                   # heartbeat/idle; leave on teardown
  hooks/                        # bash shims registered in host settings.json
    ups.sh  session-start.sh  stop.sh   # each exec's the compiled hook binary
  launchd/
    com.alcatraz.claude-ipc.plist
  tests/
    unit/  integration/  fixtures/      # bun:test (*.test.ts)
```

## 3. Models (`models.ts`)

String-literal unions (erasable, `verbatimModuleSyntax`-friendly) + a `Message`
type. Discriminated where useful.

```ts
export type Kind = "inform" | "query" | "request" | "response" | "control";
export type Status = "ok" | "error";
export type ErrorCode = "timeout" | "no_peer" | "declined" | "internal";
// Per-recipient delivery lifecycle — lives on Delivery, NOT on Message. A
// broadcast has one Delivery per recipient, each with its own state.
export type DeliveryState =
  | "queued" | "delivered" | "surfaced" | "consumed"  // read lifecycle
  | "accepted" | "declined";                          // request consent (per recipient)
export type ControlOp =
  | "register" | "heartbeat" | "leave" | "cancel" | "claim" | "release";
export type DeliveredVia = "channel" | "hook" | "resume" | "pull" | null;

export interface ContextPtr { sessionId: string; transcriptPath: string; cwd: string; }

// A Message is an IMMUTABLE fact: once appended it never changes. Mutable
// per-recipient lifecycle lives in Delivery; the sender's open/closed view of a
// query/request lives in Awaiting. This split is what lets one broadcast message
// carry N independent delivery states (review findings #7/#8/#14).
export interface Message {
  id: string;                 // "msg-" + short id
  kind: Kind;
  fromAlias: string;
  toAlias: string;            // a concrete alias, or "*" for broadcast
  body: string;
  conversationId: string | null;
  corrId: string | null;      // origin id, on response/cancel
  status: Status | null;      // response only — intrinsic, immutable
  errorCode: ErrorCode | null;// response only
  terminal: boolean;          // response only — false = ack/progress
  op: ControlOp | null;
  contextPtr: ContextPtr | null;
  ttlS: number | null;
  ts: number;                 // epoch seconds, set at append
}

// Per-(message, recipient) delivery + consent. A broadcast yields one row per
// recipient, each with its own rung and state — what a single column on Message
// could not represent.
export interface Delivery {
  msgId: string;
  toAlias: string;            // the concrete recipient
  via: DeliveredVia;          // channel | hook | resume | pull | null
  state: DeliveryState;
  ts: number;
}

// The sender's view of an outstanding query/request: open until answered,
// timed out (only if an explicit deadline was set), or cancelled. A late reply
// still delivers; only a cancel drops it. expiresAt is null by default.
export interface Awaiting {
  originId: string;           // the query/request id (== corrId of its responses)
  expiresAt: number;
  closed: boolean;
  closedReason: "responded" | "timeout" | "cancelled" | null;
}

export interface RegistryEntry {
  alias: string; sessionId: string; cwd: string; caps: string[];
  pid: number | null; lastSeen: number; status: "live" | "idle" | "offline";
}
```

## 4. Storage interface (`storage/base.ts`)

```ts
export interface StorageBackend {
  // messages are immutable facts
  append(m: Message): void;                       // idempotent on id
  get(id: string): Message | null;
  // per-recipient delivery + consent (Delivery rows)
  enqueue(msgId: string, alias: string): void;            // insert Delivery(queued)
  pending(alias: string, opts?: { consume?: boolean }): Message[]; // queued|delivered|surfaced
  markDelivered(msgId: string, alias: string, via: DeliveredVia): void;
  markConsumed(msgId: string, alias: string): void;
  setConsent(msgId: string, alias: string, accepted: boolean): void; // request accept/decline
  deliveriesFor(msgId: string): Delivery[];               // all recipients (broadcast fan-out)
  // sender's outstanding query/request (Awaiting rows)
  openAwaiting(originId: string, expiresAt: number | null): void; // null = no deadline (default)
  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void;
  isAwaitingOpen(originId: string): boolean;
  getAwaiting(originId: string): Awaiting | null;         // closedReason=cancelled ⇒ drop a reply
  awaitingPastTtl(now: number): Awaiting[];               // open, with a deadline, that has passed
  originOf(corrId: string): Message | null;
  // registry snapshot (warm restart)
  saveRegistry(entries: RegistryEntry[]): void;
  loadRegistry(): RegistryEntry[];
  // audit
  history(q: { peer?: string; since?: number; conversationId?: string }): Message[];
  // lifecycle — rebuild from un-consumed deliveries + open awaiting
  replayInflight(): { deliveries: Delivery[]; awaiting: Awaiting[] };
}
```

### 4.1 SQLite backend (default, `bun:sqlite`)
```sql
-- immutable message facts (never UPDATEd)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, kind TEXT, from_alias TEXT, to_alias TEXT, body TEXT,
  conversation_id TEXT, corr_id TEXT, status TEXT, error_code TEXT,
  terminal INTEGER, op TEXT, context_ptr TEXT, ttl_s INTEGER, ts REAL);
CREATE INDEX IF NOT EXISTS ix_msg_corr ON messages(corr_id);
CREATE INDEX IF NOT EXISTS ix_msg_ts   ON messages(ts);

-- per-recipient delivery + consent (one row per recipient; broadcast => N rows)
CREATE TABLE IF NOT EXISTS deliveries (
  msg_id TEXT, to_alias TEXT, via TEXT, state TEXT, ts REAL,
  PRIMARY KEY (msg_id, to_alias));
CREATE INDEX IF NOT EXISTS ix_del_inbox ON deliveries(to_alias, state);

-- sender's outstanding query/request: open until a terminal response or timeout
CREATE TABLE IF NOT EXISTS awaiting (
  origin_id TEXT PRIMARY KEY, expires_at REAL, closed INTEGER, closed_reason TEXT);
CREATE INDEX IF NOT EXISTS ix_await_open ON awaiting(closed, expires_at);

-- registry warm-restart snapshot
CREATE TABLE IF NOT EXISTS registry_snapshot (
  alias TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, caps TEXT,
  pid INTEGER, last_seen REAL, status TEXT);
```
`bun:sqlite` runs in WAL mode (`PRAGMA journal_mode=WAL`) for concurrent reads.
`messages` is strictly append-only (the full history, never mutated). All mutable
state lives in `deliveries` (per-recipient read/consent lifecycle) and `awaiting`
(the sender's open/closed request view). Separating them is what makes broadcast
fan-out, per-recipient idempotency, and reply-after-timeout well-defined.

### 4.2 honker backend (optional, alpha)
Implements the same interface using honker's `queue()` (per-recipient queue),
`stream()` (the durable log), `notify()` (broadcast), and scheduler (TTL).
Selected via `config.backend = "honker"`; behind the interface so the system
never hard-depends on alpha software.

## 5. Wire protocol (`protocol.ts`)

- Unix socket (`Bun.listen({ unix })` / `Bun.connect({ unix })`).
- Length-prefixed JSON: `<4-byte BE length><utf8 json>`. One request/response per
  short-lived connection (clients are stateless).
- Request: `{ v: 1, op, args, sessionId? }`. Response: `{ ok: true, result } |
  { ok: false, error: { code, message } }`.
- Ops: `register, heartbeat, leave, send, check, reply, accept, decline, cancel,
  list, history, status`.
- Version mismatch → `error{code:"version"}`; client logs and degrades.

## 6. MCP tool surface (`mcpServer.ts`)

Built on `@modelcontextprotocol/sdk` (stdio transport). Each tool forwards to a
broker op via `client.ts`. Schemas (args → result):

| Tool | Args | Result |
|------|------|--------|
| `ipc_register` | `alias`, `caps?[]` | `{ alias, registered, replaced? }` |
| `ipc_list` | — | `{ peers: [{alias,cwd,lastSeen,status}] }` |
| `ipc_send` | `to`, `kind∈{inform,query,request}`, `body`, `conversationId?`, `ttlS?` | `{ msgId, state }` \| `{ error:{code:no_peer} }` |
| `ipc_check` | `consume?=true` | `{ messages: Message[] }` |
| `ipc_reply` | `corrId`, `body`, `terminal?=true`, `status?=ok` | `{ msgId }` |
| `ipc_accept` | `msgId` | `{ accepted: true }` |
| `ipc_decline` | `msgId`, `reason?` | `{ declined: true }` |
| `ipc_cancel` | `corrId` | `{ cancelled: true }` |
| `ipc_await` | `corrId`, `timeoutS` | `{ response: Message }` \| `{ error: timeout }` |
| `ipc_history` | `peer?`, `since?`, `conversationId?` | `{ messages: Message[] }` |

Tool descriptions instruct: **send names an explicit target** (never inferred);
an incoming `request` is a **proposal** requiring `ipc_accept` before acting.

**`ipc_check` consume vs. consent (review #14).** `consume` marks the recipient's
*Delivery* `consumed` (read) — a read-tracking concern only. It does NOT drop a
`request`'s consent obligation: `ipc_accept`/`ipc_decline` operate by `msgId` and
flip the Delivery to `accepted|declined` regardless of consume state. So reading a
request (even with `consume=true`) never makes it unaccept-able, and a request is
never silently lost between "read" and "decided."

## 7. Hook contracts (`src/hooks/*`, shims in `hooks/`)

Each host hook is a tiny bash shim that exec's a **compiled** hook binary
(`dist/ipc-ups`, …) — compilation is what makes the per-prompt path cheap. Each
reads the host hook JSON on stdin (`{ session_id, cwd, transcript_path,
hook_event_name, source }`) and prints injection JSON on stdout, exit 0:
```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"⟨IPC · …⟩"}}
```
- `userPromptSubmit.ts` — `client.check(sessionId)`; format `⟨IPC · …⟩`
  reminders, inject; broker marks them `deliveredVia="hook"` (idempotent — never
  re-inject a hook-delivered message).
- `sessionStart.ts` — register/re-register the alias; drain the offline queue in
  order; inject backlog. (`source` ∈ startup|resume|clear|compact.)
- `stop.ts` — heartbeat/idle; on teardown emit `control:leave`.
- Hooks **must be fast** (compiled binary → low-single-digit-ms start) and
  **never** emit `decision:block`. Alias: `CLAUDE_IPC_ALIAS` env wins; else the
  cwd basename; collisions reported by the broker on register.

`settings.json` registration is done during the install phase, appending IPC
hook entries alongside existing guardrail hooks (additive).

## 8. CLI (`cli.ts`, bin `claude-ipc`, compiled to `dist/claude-ipc`)

```
claude-ipc send --to <alias> --kind <inform|query|request> [--ttl N] "<body>"
claude-ipc inbox [<alias>] [--consume]
claude-ipc peers
claude-ipc log [--peer <a>] [--since <t>] [--conversation <id>]
claude-ipc accept <msg-id> | decline <msg-id> [--reason ...]
claude-ipc tail                     # live monitor (flow + liveness)
claude-ipc daemon status|start|stop
```
All verbs are Unix-socket clients; `daemon` manages the launchd service / a
foreground run. Help text follows the gcc CLI-help convention.

## 9. Broker runtime (`broker/server.ts`)

- `main()` opens the socket (`Bun.listen({ unix })`), instantiates the configured
  `StorageBackend`, `replayInflight()` to rebuild un-consumed deliveries + open
  awaiting, and loads the registry snapshot (peers start `offline` until a
  heartbeat arrives — but their aliases remain *known*, see snapshot cadence).
- The socket handler frames requests and dispatches via `router`.
- A `setInterval` task runs `sweeper.tick(now)` (default 5 s): for each
  `awaitingPastTtl(now)`, `closeAwaiting(reason:"timeout")` and synthesize
  `response{error,timeout}` → route to origin; age registry entries
  (live→idle→offline). Queries have **no deadline by default** (timeouts are
  opt-in via an explicit `ttlS`); a late reply still **delivers** (the real answer
  beats a provisional timeout), and a reply is dropped only if the sender
  **cancelled**. [dogfood-corrected: a 1h default + late-drop threw away real,
  human-paced answers.]
- **Registry snapshot cadence (review #21):** the snapshot is written on every
  `register`/`leave` plus a periodic flush, so a known alias survives a broker
  restart — offline-queueing (FR8/SC3) holds *across* restarts, not just within
  one broker lifetime.
- **`pending` returns ALL undelivered (review #19):** the UPS-hook `check` and
  delivery use the same `pending` set (any `deliveries` row not yet `consumed`),
  so a running peer mis-marked `offline` after a broker restart still receives
  queued messages at its next turn — it does not need to "resume".
- Ladder-rung selection is **inlined at the callers**, not a separate
  `dispatch`/`channelAdapter` module: hooks call the `deliver` op directly
  (`userPromptSubmit` = turn-boundary, `sessionStart` = resume), `ipc_check` is
  the on-demand pull, and the broker→TTY badge is the idle signal. A
  `--channels` push rung would slot in here when the host gains the feature.

## 10. Launchd & lifecycle

`launchd/com.alcatraz.claude-ipc.plist`: `RunAtLoad`, `KeepAlive=true`,
`ProgramArguments=["<dist>/claude-ipc-broker"]` (compiled binary → no runtime
drift; `bun run src/broker/server.ts` for dev), stdout/err →
`${CLAUDE_IPC_HOME}/logs/`. The TTL **sweeper runs inside the daemon** (interval
task), so there is no separate scheduled cron — the cron-calendar-companion rule
does not apply; a `daemon status` check + the monitor provide the observability
surface for a dead persistent daemon.

## 11. Degraded-mode client (`client.ts`)

Tries the socket; on connect failure it (a) for sends, opens the SQLite DB
directly, `append`s the immutable message and `enqueue`s a `deliveries` row
(`state=queued`); (b) for checks, reads `pending` directly and `markConsumed`s
what it surfaces. It surfaces `daemonDown:true` so CLI/monitor can report it.

**Reconcile pass (review #4).** Because all state lives in the shared tables, the
broker needs no special degraded log: on return it simply processes `deliveries`
rows still in `state=queued` (dispatch + `markDelivered`) and `awaiting` rows
still `open`. A delivery a degraded reader already `consumed` is skipped, so there
is **no double-surface**; a `queued` row the degraded sender wrote is picked up,
so there is **no loss**. The single mutable-state location is the coordination
mechanism — there are not "two writers with separate views."

**Limits while down (review #2):** the degraded client has no in-memory registry,
so it cannot classify a send to an *unknown* alias as `no_peer` — it persists the
message; on broker return the router resolves it (routes if the alias is known, or
`closeAwaiting(no_peer)` if not). Proactive push and active timeout-synthesis are
also unavailable until the broker returns. Nothing acknowledged is lost.

## 12. Configuration (`config.toml`, imported by `config.ts`)

```toml
backend = "sqlite"          # or "honker"
socket_path = "~/.claude-ipc/run/ipc.sock"
db_path     = "~/.claude-ipc/data/ipc.sqlite"
default_ttl_s = 3600
sweep_interval_s = 5
liveness = { idle_s = 300, offline_s = 1800 }
channels = "auto"           # auto-detect | on | off
allowlist = {}              # reserved: {target_alias = [permitted_sender,...]}
```

## 13. Testing approach (`bun:test`; detailed in `05-roadmap.md`)

- **Unit:** each module against an in-memory/temp-file `bun:sqlite` DB; protocol
  round-trips; sweeper with an injected clock; alias resolution; idempotent
  delivery marks. (`new Database(":memory:")` for speed.)
- **Integration:** spin a real broker on a temp Unix socket + temp DB; drive two
  stateless clients through full flows (query→response, request→accept→result,
  decline, no_peer, timeout, offline-queue→resume-drain, broadcast). Invoke hook
  entrypoints with synthetic stdin and assert the injected `additionalContext`.
- **Resilience:** kill the broker mid-flow; assert degraded send persists and
  reconciles on restart; assert log replay rebuilds queues with no loss.
- **Determinism:** inject clock + id generator. **Mock data is acceptable.**
- **Regression guard:** SC1–SC7 become integration tests that stay green across
  all later phases (the resilience invariant). Run with `bun test`.
