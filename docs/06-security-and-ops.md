# Security & Operations

Post-v0.1 hardening (2026-06-01). This doc is the single reference for the
identity/consent model, its threat model and known limits, and the operational
properties (durability, retention, shutdown, deploy). It supersedes scattered
"no-auth model" notes in the earlier docs.

## Identity — capability tokens

Every alias is owned via a **capability token**, minted by the broker at register
time and held by the owner in a `0600` file under `~/.claude-ipc/tokens/<alias>`.
The broker checks it on every op that *acts as* an alias — `send`, `check`,
`deliver`, `accept`, `decline`, `reply`, `await`, `cancel`, `count`, `heartbeat`,
`leave` — via `Router.requireOwner`. A process without the token cannot send as
another alias, drain its inbox, or consent on its behalf.

```
register backend ──▶ broker mints token T ──▶ client writes ~/.claude-ipc/tokens/backend (0600)
                                                         │
later: send{from:backend} ── attaches T from file ──────┤
                                                         ▼
                              broker: T == registry.tokenOf(backend) ?  yes → act   no → unauthorized
```

Properties:
- **Persisted** in the registry snapshot, so tokens survive a broker restart.
- **Never leaked** — stripped from `list()`/`get()`; returned only in the
  `register` response to the owner.
- **Reconnect** works because the token file persists: a restarted session
  presents its saved token and keeps the same alias.
- **Anti-hijack**: any token-bearing alias requires its token to re-register —
  even one shown `offline` (warm-started entries after a restart are offline yet
  still owned). Only a legacy null-token alias (pre-upgrade) is freely claimable.
- **Cross-UID safe at two layers**: the broker socket is `0600` and its run/data
  dirs `0700`, so another UNIX user can't even *connect* (no listing peers, reading
  history, or flooding); and the `0600` token file means even a connected process
  can't impersonate a registered alias. Same-UID is the intentional trust line.

## Consent (unchanged, still load-bearing)

An action **`request`** is a proposal, never auto-run. The recipient must call
`ipc_accept` (which only flips a consent flag — no code path executes a request
body). Injected messages are wrapped as DATA markers in the hook output
(`hooks/shared.ts`), so a receiving agent treats them as content, not
instructions. Identity (above) makes the `from` on a request trustworthy.

## Threat model & known limits

This is a **local, single-user** system. Calibrate accordingly.

- **Closed**: cross-session impersonation of a *registered* alias, inbox draining,
  alias hijack (live or post-restart), token leakage, silent protocol mismatch.
- **Closed by default (strict mode)** — the **unregistered-alias window**: in
  strict mode (`CLAUDE_IPC_STRICT`, on by default) a send's `from` must be a
  registered alias, so you can't forge a message from an alias nobody has
  registered yet. Set `CLAUDE_IPC_STRICT=0` to allow ad-hoc unregistered senders
  (e.g. quick CLI tests); then this window reopens. Legacy null-token aliases
  still work in strict mode — they're *registered*, just unprotected, so they
  pass the "is registered" check and gain token protection on their next register.
- **Degraded mode under strict** still refuses to act as an alias the client
  holds no token for, so a forged `from` isn't persisted while the broker is down.
  This is **not a hard boundary** — a process bypassing the client can write the
  SQLite log directly; the broker is the real authority when it's up.
- **Not a boundary against same-UID code**: any process running as you can read
  your token files. The tokens defend across UIDs, not against your own shell.

## Operational properties

- **Durability / degraded mode**: with the broker down, hooks + the MCP server
  fall back to the durable SQLite log — a pending message still surfaces at the
  next turn, and sends persist for the broker to reconcile on return. (Wired into
  `userPromptSubmit`, `sessionStart` (register/drain decoupled), and the MCP
  server; the CLI stays fail-loud by design.)
- **Atomic delivery**: `claimForDelivery` is a single `UPDATE … RETURNING`, so two
  deliverers can't double-deliver the same message.
- **Back-pressure**: both broker and client drain partial socket writes on
  `drain`, so responses/requests larger than the ~8 KB send-buffer watermark
  aren't truncated (the bug that left `tail`/`history` empty).
- **Request deadline**: `client.request()` rejects after `requestTimeoutMs`
  (5 s) instead of hanging on an unresponsive broker.
- **Crash resistance**: a malformed frame yields one `bad_frame` error and drops
  only that connection; per-connection `error`/`close` handlers keep one bad
  socket from taking down the broker.
- **Retention**: the sweeper purges fully-settled messages (no actionable
  delivery, no open awaiting) older than `retentionS` (default 7 days,
  `CLAUDE_IPC_RETENTION_S`), so the log doesn't grow without bound.
- **Roster GC**: the registry only marks peers offline, never deletes — so every
  session that ever registered (including ephemeral sub-agents and headless runs)
  would accumulate. The sweeper prunes peers offline longer than
  `registryRetentionS` (default 1 day, `CLAUDE_IPC_REGISTRY_RETENTION_S`) that
  have no pending mail; `claude-ipc prune [--offline-for 30m|2h|1d]` does it on
  demand. `claude-ipc tail` collapses offline peers to a count so the roster stays
  readable. A peer with queued messages is kept (it's a live mailbox).
- **Logging**: the broker writes a size-rotated operational log at
  `~/.claude-ipc/logs/broker.log` (5 MB, one prior kept); launchd's stdout keeps
  a one-line-per-boot liveness trace.
- **Clean shutdown**: SIGTERM stops the sweeper, releases the socket, and closes
  SQLite (checkpoints the WAL) — no dirty WAL or stale socket on restart.
- **Protocol version**: the broker rejects a frame whose `v` ≠ `PROTOCOL_VERSION`
  with `bad_version`, so a stale client vs newer broker fails loudly.

## Communication patterns

**Incremental replies.** A responder need not finish before replying. It can
acknowledge on receipt, stream interim updates, then send the final result —
all correlated to the same `corrId`, each delivered as it lands:

```
alice ──query "design the cache?"──▶ bob
bob ──ipc_ack──────────────────────▶ alice   "received — working on it"   (interim)
bob ──ipc_update───────────────────▶ alice   "leaning LRU"                (interim)
bob ──ipc_reply────────────────────▶ alice   "done: LRU, 1k cap"          (final/terminal)
```

`ipc_ack` / `ipc_update` are non-terminal replies (the `awaiting` stays open);
`ipc_reply` is terminal and closes it. `ipc_await` is a **bounded wait** (up to
`timeoutMs`, default 30s) for the terminal reply — not an open-ended block; on
timeout it returns null and the reply still surfaces in the inbox at the caller's
next turn. Interim acks/updates land in the inbox but don't satisfy the wait;
`untilTerminal=false` returns on the first reply. CLI: `reply --partial`. This is the stateful primitive — no separate "threads/topics"
abstraction; correlation by `corrId` plus the auto `conversationId` is enough.
Follow-ups continue the exchange by reusing the `conversationId`.

## Deploy model — one binary

The broker and CLI are the **same compiled artifact**. The launchd agent runs
`dist/claude-ipc serve`; `bun run build` rebuilds it (and the hook binaries)
together, so there's no source-vs-dist drift. Rebuild before restarting after a
change:

```bash
bun run build                      # cli + hooks → dist/
bash scripts/install-launchd.sh    # builds, copies plist, bootstraps (idempotent)
# or, to just restart the running agent onto fresh bits:
launchctl kickstart -k gui/$(id -u)/com.alcatraz.claude-ipc
```

Observe: `claude-ipc daemon status`, `claude-ipc tail`, `~/.claude-ipc/logs/broker.log`.
