# 04 · Technical Implementation

> Build-level detail realizing `03-architecture.md`: stack, layout, schemas,
> wire protocol, and the exact tool/hook/CLI contracts. Specific enough to
> implement against; deliberately leaves room for the roadmap to sequence it.

---

## 1. Stack & conventions

- **Language:** Python 3.11+ (matches gcc tooling; `honker` ships a Python
  binding). Stdlib `asyncio` + `sqlite3`; no heavy framework.
- **Env:** `uv` for venv + lockfile. Package name `claude_ipc`.
- **Style:** type hints throughout; `ruff` + `mypy` in CI; dataclasses for models.
- **MCP:** the official Python MCP SDK for the stdio server.
- **Runtime home:** `${CLAUDE_IPC_HOME:-~/.claude-ipc}` →
  `run/ipc.sock`, `data/ipc.sqlite`, `logs/`. Never committed (`.gitignore`).

## 2. Repository layout

```
claude-ipc/
  pyproject.toml                # deps, entry points (claude-ipc CLI), tool config
  docs/                         # 01..05
  src/claude_ipc/
    __init__.py
    config.py                   # load config.toml + env; paths; TTLs; backend choice
    models.py                   # Message, RegistryEntry, enums (Kind, Status, State…)
    protocol.py                 # frame encode/decode; Request/Response schemas; version
    client.py                   # thin socket client (used by MCP, CLI, hooks)
    storage/
      base.py                   # StorageBackend ABC
      sqlite_backend.py         # default: SQLite log + queue + registry snapshot
      honker_backend.py         # optional (alpha): honker queue/stream/scheduler
    broker/
      server.py                 # asyncio Unix-socket server; dispatch loop; main()
      router.py                 # route, correlate, broadcast
      registry.py               # in-memory liveness; aging
      sweeper.py                # TTL/timeout → response{error}
      dispatch.py               # delivery-ladder selection
    channel_adapter.py          # optional --channels push (feature-detected)
    mcp_server.py               # stdio MCP server exposing ipc_* tools
    cli.py                      # claude-ipc dispatcher
    hooks/
      user_prompt_submit.py     # inject pending (turn-boundary rung)
      session_start.py          # register + drain offline queue (resume rung)
      stop.py                   # heartbeat/idle; leave on teardown
  hooks/                        # bash shims registered in host settings.json
    ups.sh  session-start.sh  stop.sh
  launchd/
    com.alcatraz.claude-ipc.plist
  tests/
    conftest.py  fixtures/
    unit/  integration/
```

## 3. Models (`models.py`)

```python
class Kind(StrEnum):      INFORM="inform"; QUERY="query"; REQUEST="request"
                          RESPONSE="response"; CONTROL="control"
class Status(StrEnum):    OK="ok"; ERROR="error"        # response only
class ErrorCode(StrEnum): TIMEOUT="timeout"; NO_PEER="no_peer"
                          DECLINED="declined"; INTERNAL="internal"
class State(StrEnum):     QUEUED="queued"; DELIVERED="delivered"; SURFACED="surfaced"
                          CONSUMED="consumed"; ACCEPTED="accepted"
                          RESPONDED="responded"; EXPIRED="expired"
class ControlOp(StrEnum): REGISTER; HEARTBEAT; LEAVE; CANCEL; CLAIM; RELEASE

@dataclass
class Message:
    id: str                     # "msg-" + short uuid
    kind: Kind
    from_alias: str
    to_alias: str               # alias or "*"
    body: str = ""
    conversation_id: str | None = None
    corr_id: str | None = None  # set on response/cancel
    status: Status | None = None
    error_code: ErrorCode | None = None
    terminal: bool = True
    op: ControlOp | None = None
    context_ptr: dict | None = None   # {session_id, transcript_path, cwd}
    ttl_s: int | None = None
    priority: int = 0
    ts: float = 0.0
    state: State = State.QUEUED
    delivered_via: str | None = None  # channel|hook|resume|pull

@dataclass
class RegistryEntry:
    alias: str; session_id: str; cwd: str; caps: list[str]
    pid: int | None; last_seen: float; status: str   # live|idle|offline
```

## 4. Storage interface (`storage/base.py`)

```python
class StorageBackend(ABC):
    # durability
    def append(self, m: Message) -> None: ...          # write to log; idempotent on id
    def get(self, msg_id: str) -> Message | None: ...
    def update_state(self, msg_id, state, **fields) -> None: ...
    # queueing
    def enqueue(self, alias: str, msg_id: str) -> None: ...
    def pending(self, alias: str, *, consume=False) -> list[Message]: ...
    def mark_delivered(self, msg_id, via: str) -> None: ...
    def mark_consumed(self, msg_id) -> None: ...
    # correlation / timeouts
    def origin_of(self, corr_id: str) -> Message | None: ...
    def awaiting_past_ttl(self, now: float) -> list[Message]: ...
    # registry snapshot (warm restart)
    def save_registry(self, entries: list[RegistryEntry]) -> None: ...
    def load_registry(self) -> list[RegistryEntry]: ...
    # audit
    def history(self, *, peer=None, since=None, conversation_id=None) -> list[Message]: ...
    # lifecycle
    def replay_inflight(self) -> tuple[dict[str,list[str]], list[Message]]: ...  # queues, awaiting
```

### 4.1 SQLite backend (default)
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY, kind TEXT, from_alias TEXT, to_alias TEXT, body TEXT,
  conversation_id TEXT, corr_id TEXT, status TEXT, error_code TEXT,
  terminal INTEGER, op TEXT, context_ptr TEXT, ttl_s INTEGER, priority INTEGER,
  ts REAL, state TEXT, delivered_via TEXT);
CREATE INDEX ix_msg_inbox ON messages(to_alias, state);
CREATE INDEX ix_msg_corr  ON messages(corr_id);
CREATE INDEX ix_msg_ts    ON messages(ts);
CREATE TABLE registry_snapshot (
  alias TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, caps TEXT,
  pid INTEGER, last_seen REAL, status TEXT);
```
Append-only semantics: messages are inserted once; `update_state` mutates only
`state`/`delivered_via`/response-linkage fields. The log = full message history.

### 4.2 honker backend (optional, alpha)
Maps: queue→`queue()`, log→`stream()` (per-consumer offsets), broadcast→`notify()`,
TTL/timeout→honker scheduler. Same ABC; selected by `config.backend = "honker"`.
Kept behind the interface so the system never hard-depends on alpha software.

## 5. Wire protocol (`protocol.py`)

- Unix socket, length-prefixed JSON: `<4-byte big-endian length><utf8 json>`.
- One request/response per short-lived connection (clients are stateless).
- Request: `{"v":1,"op":<op>,"args":{...},"session_id":...}`.
- Response: `{"ok":true,"result":{...}}` or `{"ok":false,"error":{"code","message"}}`.
- Ops: `register, heartbeat, leave, send, check, reply, accept, decline,
  cancel, list, history, status`.
- Version mismatch → `error{code:"version"}`; client logs and degrades.

## 6. MCP tool surface (`mcp_server.py`)

Each tool forwards to a broker op via `client.py`. Schemas (args → result):

| Tool | Args | Result |
|------|------|--------|
| `ipc_register` | `alias`, `caps?[]` | `{alias, registered:true, replaced?:alias}` |
| `ipc_list` | — | `{peers:[{alias,cwd,last_seen,status}]}` |
| `ipc_send` | `to`, `kind∈{inform,query,request}`, `body`, `conversation_id?`, `ttl_s?` | `{msg_id, state}` or `{error:{code:no_peer,...}}` |
| `ipc_check` | `consume?=true` | `{messages:[Message…]}` |
| `ipc_reply` | `corr_id`, `body`, `terminal?=true`, `status?=ok` | `{msg_id}` |
| `ipc_accept` | `msg_id` | `{accepted:true}` |
| `ipc_decline` | `msg_id`, `reason?` | `{declined:true}` |
| `ipc_cancel` | `corr_id` | `{cancelled:true}` |
| `ipc_await` | `corr_id`, `timeout_s` | `{response:Message}` or `{error:timeout}` |
| `ipc_history` | `peer?`, `since?`, `conversation_id?` | `{messages:[…]}` |

Tool descriptions instruct: **send names an explicit target** (never inferred);
an incoming `request` is a **proposal** requiring `ipc_accept` before acting.

## 7. Hook contracts (`hooks/`)

Bash shim → python entrypoint. Each reads the host hook JSON on stdin
(`{session_id, cwd, transcript_path, hook_event_name, source}`) and prints
context-injection JSON on stdout, exit 0:
```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"⟨IPC · …⟩"}}
```
- `user_prompt_submit.py` — `client.check(session_id)`; if pending, format the
  `⟨IPC · …⟩` reminders, inject, and the broker marks them `delivered_via=hook`
  (idempotent — never re-inject a message already hook-delivered).
- `session_start.py` — `client.register(alias_for(cwd|session))`; drain offline
  queue ordered; inject backlog. (`source` ∈ startup|resume|clear|compact.)
- `stop.py` — `client.heartbeat(session_id, idle=true)`; on teardown `leave`.
- Hooks **must be fast** (<~20 ms typical) and **never** emit `decision:block`.
  Alias resolution: explicit `CLAUDE_IPC_ALIAS` env wins; else derived from cwd
  basename; collisions reported by the broker on register.

The actual `settings.json` registration is performed during the install phase,
appending IPC hook entries alongside existing guardrail hooks (additive).

## 8. CLI (`cli.py`, entry point `claude-ipc`)

Argparse dispatcher (modeled on the gcc `shell-mem.sh` pattern):
```
claude-ipc send --to <alias> --kind <inform|query|request> [--ttl N] "<body>"
claude-ipc inbox [<alias>] [--consume]
claude-ipc peers
claude-ipc log [--peer <a>] [--since <t>] [--conversation <id>]
claude-ipc accept <msg-id> | decline <msg-id> [--reason ...]
claude-ipc tail                     # live monitor (flow + liveness)
claude-ipc daemon status|start|stop
```
All verbs are socket clients; `daemon` manages the launchd service / foreground
run. Help text follows the gcc CLI-help convention.

## 9. Broker runtime (`broker/server.py`)

- `main()` opens the socket, instantiates the configured `StorageBackend`,
  `replay_inflight()` to rebuild queues + awaiting set, loads the registry
  snapshot (all peers start `offline` until a heartbeat arrives).
- An asyncio accept loop handles framed requests via `router`.
- A periodic task runs `sweeper.tick(now)` (default every 5 s): expire awaiting
  query/request past `ttl_s` → synthesize `response{error,timeout}` → route to
  origin; age registry entries (live→idle→offline).
- `dispatch.deliver(msg)` picks the highest available rung; channel push only if
  `channel_adapter.available()`.

## 10. Launchd & lifecycle

`launchd/com.alcatraz.claude-ipc.plist`: `RunAtLoad`, `KeepAlive=true`,
`ProgramArguments=[python,-m,claude_ipc.broker.server]`, stdout/err →
`${CLAUDE_IPC_HOME}/logs/`. The TTL **sweeper runs inside the daemon** (interval
task), so there is no separate scheduled cron — the cron-calendar-companion rule
does not apply; instead a `daemon status` check + the monitor provide the
observability surface for a dead persistent daemon.

## 11. Degraded-mode client

`client.py` tries the socket; on connect failure it (a) for sends, appends
directly to the SQLite log via the backend in `degraded=true` (so the message
persists and is reconciled when the broker returns); (b) for checks, reads
pending directly from the backend. It surfaces `daemon_down=true` in results so
the CLI/monitor can report it. Push + timeout-synthesis are unavailable until
the broker returns.

## 12. Configuration (`config.toml`)

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

## 13. Testing approach (detailed in `05-roadmap.md`)

- **Unit:** each module against an in-memory/temp-file backend; protocol
  round-trips; sweeper logic with injected clock; alias resolution; idempotent
  delivery marks.
- **Integration:** spin a real broker on a temp socket + temp DB; drive two
  stateless clients to exercise full flows (query→response, request→accept→
  result, decline, no_peer, timeout, offline-queue→resume-drain, broadcast).
  Simulate hooks by invoking the hook entrypoints with synthetic stdin and
  asserting the injected `additionalContext`.
- **Resilience:** kill the broker mid-flow; assert degraded send persists and
  reconciles on restart; assert log replay rebuilds queues with no message loss.
- **Mock data is acceptable**; tests must be deterministic (injected clock/ids).
- **Regression guard:** the SC1–SC7 scenarios become integration tests that must
  stay green across all later phases (the resilience invariant).
