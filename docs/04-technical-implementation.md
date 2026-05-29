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
      server.ts                 # Bun.listen Unix-socket server; dispatch loop; main
      router.ts                 # route, correlate, broadcast
      registry.ts               # in-memory liveness; aging
      sweeper.ts                # TTL/timeout → response{error}
      dispatch.ts               # delivery-ladder selection
    channelAdapter.ts           # optional --channels push (feature-detected)
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
export type State =
  | "queued" | "delivered" | "surfaced" | "consumed"
  | "accepted" | "responded" | "expired";
export type ControlOp =
  | "register" | "heartbeat" | "leave" | "cancel" | "claim" | "release";
export type DeliveredVia = "channel" | "hook" | "resume" | "pull" | null;

export interface ContextPtr { sessionId: string; transcriptPath: string; cwd: string; }

export interface Message {
  id: string;                 // "msg-" + short id
  kind: Kind;
  fromAlias: string;
  toAlias: string;            // alias or "*"
  body: string;
  conversationId: string | null;
  corrId: string | null;      // set on response/cancel
  status: Status | null;
  errorCode: ErrorCode | null;
  terminal: boolean;
  op: ControlOp | null;
  contextPtr: ContextPtr | null;
  ttlS: number | null;
  priority: number;
  ts: number;                 // epoch seconds
  state: State;
  deliveredVia: DeliveredVia;
}

export interface RegistryEntry {
  alias: string; sessionId: string; cwd: string; caps: string[];
  pid: number | null; lastSeen: number; status: "live" | "idle" | "offline";
}
```

## 4. Storage interface (`storage/base.ts`)

```ts
export interface StorageBackend {
  // durability
  append(m: Message): void;                       // idempotent on id
  get(id: string): Message | null;
  updateState(id: string, state: State, fields?: Partial<Message>): void;
  // queueing
  enqueue(alias: string, id: string): void;
  pending(alias: string, opts?: { consume?: boolean }): Message[];
  markDelivered(id: string, via: DeliveredVia): void;
  markConsumed(id: string): void;
  // correlation / timeouts
  originOf(corrId: string): Message | null;
  awaitingPastTtl(now: number): Message[];
  // registry snapshot (warm restart)
  saveRegistry(entries: RegistryEntry[]): void;
  loadRegistry(): RegistryEntry[];
  // audit
  history(q: { peer?: string; since?: number; conversationId?: string }): Message[];
  // lifecycle
  replayInflight(): { queues: Record<string, string[]>; awaiting: Message[] };
}
```

### 4.1 SQLite backend (default, `bun:sqlite`)
```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, kind TEXT, from_alias TEXT, to_alias TEXT, body TEXT,
  conversation_id TEXT, corr_id TEXT, status TEXT, error_code TEXT,
  terminal INTEGER, op TEXT, context_ptr TEXT, ttl_s INTEGER, priority INTEGER,
  ts REAL, state TEXT, delivered_via TEXT);
CREATE INDEX IF NOT EXISTS ix_msg_inbox ON messages(to_alias, state);
CREATE INDEX IF NOT EXISTS ix_msg_corr  ON messages(corr_id);
CREATE INDEX IF NOT EXISTS ix_msg_ts    ON messages(ts);
CREATE TABLE IF NOT EXISTS registry_snapshot (
  alias TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, caps TEXT,
  pid INTEGER, last_seen REAL, status TEXT);
```
`bun:sqlite` runs in WAL mode (`PRAGMA journal_mode=WAL`) for concurrent reads.
Append-only semantics: rows inserted once; `updateState` mutates only
`state`/`delivered_via`/response-linkage. The table is the full message history.

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
  `StorageBackend`, `replayInflight()` to rebuild queues + awaiting set, and loads
  the registry snapshot (peers start `offline` until a heartbeat arrives).
- The socket handler frames requests and dispatches via `router`.
- A `setInterval` task runs `sweeper.tick(now)` (default 5 s): expire awaiting
  query/request past `ttlS` → synthesize `response{error,timeout}` → route to
  origin; age registry entries (live→idle→offline).
- `dispatch.deliver(msg)` picks the highest available ladder rung; channel push
  only if `channelAdapter.available()`.

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
directly and appends with `degraded:true` (the message persists and the broker
reconciles on return); (b) for checks, reads pending directly from the DB. It
surfaces `daemonDown:true` so CLI/monitor can report it. Push + timeout-synthesis
are unavailable until the broker returns.

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
