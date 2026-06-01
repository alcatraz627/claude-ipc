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
- **Cross-UID safe**: the `0600` token file is the boundary — another UNIX user
  can't read it, so can't impersonate. Same-UID is the intentional trust line.

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
- **Accepted limit — unregistered-alias window**: you may send `from:"X"` for an
  alias nobody has registered yet. An attacker could forge a message from
  `"backend"` *before* the real backend session starts. It closes the moment the
  victim registers (with a token). Fully closing it would require "must register
  before sending," which would break legacy null-token sessions mid-upgrade.
- **Accepted limit — degraded mode bypasses tokens**: when the broker is down,
  clients read/write the SQLite log directly with no token check. Intentional:
  broker-down is the local-trust fallback.
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
- **Logging**: the broker writes a size-rotated operational log at
  `~/.claude-ipc/logs/broker.log` (5 MB, one prior kept); launchd's stdout keeps
  a one-line-per-boot liveness trace.
- **Clean shutdown**: SIGTERM stops the sweeper, releases the socket, and closes
  SQLite (checkpoints the WAL) — no dirty WAL or stale socket on restart.
- **Protocol version**: the broker rejects a frame whose `v` ≠ `PROTOCOL_VERSION`
  with `bad_version`, so a stale client vs newer broker fails loudly.

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
