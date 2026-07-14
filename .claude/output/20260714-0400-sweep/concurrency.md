# claude-ipc — adversarial concurrency / ordering / state-machine sweep

Session: read-only audit against the repo at `/Users/alcatraz627/Code/Claude/claude-ipc`
(commit `034df67`). No write verb of the real `claude-ipc` CLI was ever invoked, and
`~/.claude-ipc` was never touched. Every runtime claim below was proven by exercising
the actual `Router`/`SqliteBackend`/broker code — either in-process against an
in-memory or `:memory:` SQLite backend, or as real, separate OS processes talking to a
real broker over a real unix socket, all rooted at scratch `CLAUDE_IPC_HOME` directories
under `/private/tmp/.../scratchpad/` that were removed afterward. Probe scripts are not
retained. Findings are marked **PROVEN** (I ran the repro and captured the output) or
**SUSPECTED** (reasoned from the code, not executed) throughout.

## tl;dr severity table

| # | Finding | Status | Severity |
|---|---|---|---|
| 1 | Double broker-start guard is TOCTOU; tight race crashes both, or one, with an ugly uncaught exception instead of the intended graceful message | REAL, PROVEN | High (availability) |
| 2 | SessionStart hook writes the alias-by-sid file *before* the register call succeeds; the loser of an alias race is permanently locked out of its own IPC hooks for the rest of the session | REAL, PROVEN | High (correctness, silent) |
| 3 | Replying twice to the same `corrId` delivers the response twice, no dedup | REAL, PROVEN | Medium (duplicate delivery) |
| 4 | `inform`/`response` messages delivered via the hook path (`deliver`/`claimForDelivery`) never transition past `delivered`; they block `purge()` forever and inflate every pending-count/orphan view forever | REAL, PROVEN | Medium (unbounded growth + stale state) |
| 5 | Message/response IDs are 32 bits (`crypto.randomUUID().slice(0,8)`); birthday-bound collisions are plausible at realistic multi-agent volumes, and collide *silently* (`INSERT OR IGNORE` / `INSERT OR REPLACE`) | REAL, not exercised at scale (math only) | Medium (silent loss/corruption, low probability) |
| 6 | `~/.claude-ipc/blocked/<msgId>` marker files are never cleaned up — permanent, unbounded growth | REAL, confirmed by absence-of-cleanup grep | Low–Medium |
| 7 | `~/.claude-ipc/alias-by-sid/<sessionId>` files are never cleaned up — one file per session ever started, forever | REAL, confirmed by grep | Low |
| 8 | Per-session `watch-inbox-$SID.log` files are never rotated or deleted | REAL, confirmed by reading the script | Low |
| 9 | `client.ts`'s `writeToken()` is a non-atomic `writeFileSync`, unlike the project's own atomic tmp+rename convention (`aliasStore.ts`) | REAL, low practical risk | Low |
| 10 | The broker's `register` handler can synchronously `Bun.spawnSync(["ps", ...])` on its own event loop, blocking every connected client, when a CLI `register` call omits `--tty` | REAL, code-proven | Low–Medium (latency spike, not correctness) |
| 11 | No `uncaughtException` handler on the broker process — any unexpected synchronous throw anywhere in the request path kills every connected session at once | REAL, contributing factor to #1 | Medium (blast radius) |
| 12 | `claimForDelivery` (the actual "multiple sessions racing the same mailbox" question) is safe under real multi-process concurrency | ALREADY HANDLED, PROVEN | n/a |
| 13 | A late reply arriving in/around the sweeper's stage-2 release tick is handled correctly; no interior race is possible (single-threaded, synchronous SQLite) | ALREADY HANDLED, PROVEN + tested | n/a |
| 14 | Two sessions cannot both come to legitimately own the same alias without sharing a token file; the token-gate prevents "both drain" scenarios entirely | ALREADY HANDLED, code-proven | n/a |
| 15 | `Awaiting.closedReason` has 5 states in the type but only 3 are reachable from live code (`timeout`/`ghosted` are documented back-compat-only) | ALREADY HANDLED / documented, not a bug | n/a |
| 16 | An opted-out (`--no-reply-expected`, no TTL) ask that is never answered or cancelled keeps its `awaiting` row — and therefore its origin message — alive forever | REAL, code-proven | Low |

---

## 1. Double-broker-start guard is TOCTOU — PROVEN, High

**Where:** `src/broker/server.ts:131-153` (the guard) vs `src/broker/server.ts:154` (`new SqliteBackend`) vs `src/broker/server.ts:64-117` (`startBroker`, the `unlinkSync` + `Bun.listen` pair) vs `src/broker/server.ts:183` (pidfile write, which happens *after* both of the above).

The guard is:
```
136:    if (existing && existing !== process.pid && isAlive(existing)) {
137:      console.error(`[claude-ipc] broker already running (pid ${existing}); not starting a second`);
138:      return;
```
This is a classic check-then-act race: the pidfile is read once at the top of `main()`, and is only *written* at line 183, well after the SQLite backend is opened (line 154) and the socket is bound (`startBroker`, called at line 182). Nothing holds an OS-level lock (`flock`, `O_EXCL`) across that whole window — the only serialization is whatever SQLite's own locking and the kernel's `bind(2)` semantics happen to provide, and neither one produces the graceful "already running" message the guard intends.

**Repro (PROVEN, ran 3 separate experiments against scratch `CLAUDE_IPC_HOME`s, never `~/.claude-ipc`):**

- **First-ever boot, two processes started in the same shell invocation (0ms stagger):** both processes crashed with an *uncaught* `SQLiteError: database is locked (SQLITE_BUSY / SQLITE_BUSY_RECOVERY)` at `sqliteBackend.ts:144` (`PRAGMA journal_mode = WAL`) — this line runs *before* `PRAGMA busy_timeout = 2000` is set (line 145), so there's no retry cushion at all for the very first pragma. Result: **zero live brokers**, no pidfile, and a scary stack trace where the guard promised a one-line log message.
- **Existing DB file, 5 repeated rounds of the same 0ms-stagger race:** exactly one of the two processes died each round, but *how* it died was non-deterministic across rounds — round 1 died on the same `SQLITE_BUSY_RECOVERY` as above; rounds 2-5 instead died on `Bun.listen` with a raw, uncaught `EADDRINUSE`/`EEXIST` at `server.ts:70` (the `unlinkSync` + `Bun.listen` pair in `startBroker`). In every case the loser's failure is an **unhandled exception with a full stack trace**, not the intended `console.error` + clean `return`.
- **Staggered by ~1s (not a tight race):** the guard works exactly as documented — the second process cleanly logs `"broker already running (pid X); not starting a second"` and exits 0. This confirms the guard's *logic* is correct; only the *timing window* is unguarded.
- **Recovery:** a subsequent single start against the crash-littered scratch dir came up clean (`replayed 0 deliveries, 0 awaiting`) — no lasting DB corruption from the aborted concurrent opens. The failure mode is availability (a crash-loop risk under `launchd KeepAlive`, or a confusing "why did the broker just die" report), not data corruption.

**Why this matters operationally:** the exact interleaving the code comment (`server.ts:132-134`) worries about — *"otherwise startBroker would unlink the live socket out from under it, orphaning every connected peer"* — is a real hazard the comment correctly identifies, but the fix in place (pidfile check) does not close the window that would let it happen when a fully-bound broker A gets its socket file unlinked-and-replaced by a broker B that started fractionally later but still within A's guard-check-to-pidfile-write gap. I could not force that exact "A stays alive with a decoupled orphaned socket" interleaving through external process scheduling (the window is sub-millisecond in practice), so that specific split-brain shape is **SUSPECTED, not proven** — but the crash-both/crash-one outcomes above are proven, and they demonstrate the same root defect (no real mutual exclusion) with a different, easier-to-hit failure surface.

**Fix shape (not implemented — read-only audit):** an `flock`/`O_EXCL`-based lock file held for the whole startup sequence, checked and acquired atomically before touching the DB or the socket; release on clean shutdown, and treat "lock held by a dead pid" as stale and reclaimable.

---

## 2. SessionStart hook clobbers its own alias mapping *before* verifying ownership — PROVEN, High

**Where:** `src/hooks/sessionStart.ts:33-35` (the write) vs `src/hooks/sessionStart.ts:53-70` (the register attempt, which can fail with `alias_taken`).

```
33:  if (input.session_id && alias !== input.session_id) {
34:    writeAliasForSession(input.session_id, alias);
35:  }
...
53:  let owned = true;
54:  try {
55:    await client.register(alias, { ... });
...
63:  } catch (e) {
64:    if (e instanceof Error && e.message.startsWith("alias_taken")) {
65:      owned = false;
```

The session→alias side-file (read by every later hook via `aliasFor()`, `src/hooks/shared.ts:42-49`) is written **unconditionally**, before the code even knows whether this session actually won the alias. When two sessions race to claim the *same* friendly name — the realistic case is an orchestration/launcher script that always assigns a fixed, predictable alias per project (e.g. two tabs both auto-registering as `"backend"`), or a human `/rename`-ing two windows to the same string — the router correctly rejects the second registration (`router.ts:113-115`, gated by `registry.ts:59-62`'s token check), but the losing session's own `alias-by-sid` file is *already* pointing at the name it just failed to own.

**Repro (PROVEN):** Ran the actual `writeAliasForSession`/`readAliasForSession` (from `aliasStore.ts`) and `Router.handle` (in-process, `:memory:` backend) in the exact order `sessionStart.ts` uses:
1. Session A registers `"shared-name"` first → succeeds, gets a token.
2. Session B writes its alias-by-sid file to `"shared-name"` (mirroring line 34), *then* attempts to register it → router returns `{ok:false, error:{code:"alias_taken", ...}}`, exactly as `owned=false` expects.
3. **B's alias-by-sid file still resolves to `"shared-name"`.**
4. Simulated B's subsequent Stop-hook calls (`heartbeat`, `check`) with the token B actually holds for that alias (none — `client.register()`'s `writeToken()` call, `client.ts:205`, is never reached because the register call threw before returning): **both come back `{ok:false, error:{code:"unauthorized", message:"not authorized to act as shared-name"}}`.**

Because `owned` correctly gates the *drain* (`sessionStart.ts:75-77`), B never reads A's mail — the property the existing test (`tests/aliasIdentity.test.ts`, "C1 · alias_taken is a distinguishable error") actually checks. But that test only asserts the router's rejection message; it never exercises `sessionStart.ts`'s own write-then-register ordering end to end, so this regression is invisible to the suite. The practical effect: **for the rest of that session, every Stop/UserPromptSubmit hook call silently fails with `unauthorized`** (all wrapped in try/catch — `stop.ts:89-108`, `userPromptSubmit.ts:15-25` — so nothing surfaces to the user). The losing session goes IPC-deaf: no heartbeat, no delivery, no turn-end nudge, with zero diagnostic short of reading the hook debug log. Only a manual `claude-ipc register <different-name>` recovers it.

**Fix shape:** don't write the side-file until `client.register()` has actually returned success; on `alias_taken`, either leave the previous mapping alone or fall back to the derived-unique name (`deriveAlias`) so the session stays reachable under *something*.

---

## 3. A duplicate `reply` delivers the response twice — PROVEN, Medium

**Where:** `src/broker/router.ts:337-391` (`reply`).

```
352:    if (aw?.closed && aw.closedReason === "cancelled") {
353:      return ok({ dropped: true, reason: "cancelled" });
354:    }
```
The comment above this line says *"A reply after the origin closed (timeout/cancel) is dropped"* — but the code only drops on `cancelled`. A second `reply` call for an origin that's already `closed:true, closedReason:"responded"` (i.e., already answered once) sails straight through: it mints a *new* message id, appends it, enqueues it to the original sender, and returns `ok`.

**Repro (PROVEN):** in-process `Router` + `:memory:` `SqliteBackend`. Bob replies to alice's request once (`late:false`), then replies again with the identical body (simulating an accidental re-run of the same `claude-ipc reply` command, or a client that retried after appearing to hang). Result:
```
reply #1: { msgId: "msg-1", terminal: true, late: false }
reply #2: { msgId: "msg-2", terminal: true, late: true }
alice's inbox response count for this corrId: 2
```
Alice's inbox now holds two separate `response` messages with the same `corrId`, identical bodies, different ids. Every downstream consumer that renders "the answer" (the hook's `formatMessages`, `src/hooks/shared.ts:105-123`) would show both.

**Note on scope:** this is deliberately *not* the same bug as the well-tested "late reply after the sender was released" path (`tests/replyDeadline.test.ts`, "a late reply still reaches the sender after the release") — that one is a single, intentional, *first* reply arriving late, and it's correctly handled (see §13). This finding is specifically about a *second* reply to an origin that already has a terminal answer. `client.ts`'s `request()` has no built-in retry, so the most likely real trigger is human/agent-level: re-running the CLI command, or two racing processes for the same alias (see §9's token-sharing caveat) both replying to the same ask.

**Fix shape:** in `reply()`, also drop (or coalesce into an update) when `aw?.closed && aw.closedReason === "responded"` and the new reply is `terminal:true` — a terminal answer should be a one-shot transition, matching the `closeAwaiting` guard's own `WHERE closed=0` idempotency elsewhere in the same file.

---

## 4. Delivered informs/responses never leave `delivered` state — PROVEN, Medium (unbounded growth)

**Where:** `src/storage/sqliteBackend.ts:239-261` (`claimForDelivery`, only ever writes `state='delivered'`) vs the **only** callers of `markConsumed`: `router.ts:384` and `router.ts:388` (both inside `reply()`), and `router.ts:447` (inside `decline()`). Grepped the whole `src/` tree for `markConsumed` — those are the only three call sites.

`claimForDelivery` is what both `SessionStart` (`sessionStart.ts:77` → `deliverContext` → `client.deliver`) and `UserPromptSubmit` (`userPromptSubmit.ts:19`) use to inject pending mail into the agent's context. It moves a delivery from `queued` → `delivered` and stops there. Nothing ever promotes a `delivered` row to `consumed` unless the recipient (or something acting on their behalf) later calls `check(..., {consume:true})` — i.e. `claude-ipc inbox <alias> --consume`, which neither hook ever calls. `query`/`request` messages *do* eventually get cleared, but only as a side effect of `reply()`/`decline()` marking the *origin* consumed — `inform` messages (which nothing ever replies to) and `response` messages read via `ipc-await.sh` (`scripts/ipc-await.sh:37-49`, which deliberately peeks with plain `inbox`, no `--consume`) have no such path at all.

Because `purge()`'s eligibility check is `NOT EXISTS (... d.state IN ('queued','delivered','surfaced'))` (`sqliteBackend.ts:411-413`), a message stuck at `delivered` **can never be purged**, regardless of `CLAUDE_IPC_RETENTION_S`.

**Repro (PROVEN):** in-process `Router` + `:memory:` backend. Alice sends Bob a plain `inform`; Bob's hook claims it (`deliver`) → state is `delivered`. Fast-forward the clock 30 days and run `tickSweeper` (which calls `purge()`) 5 times with the default 7-day retention:
```
delivery state right after hook-claim: delivered
delivery state 30 days later, after repeated purge ticks: delivered
message still in DB? true
bob still counted as having pending mail? 1
pendingAddresses() still lists bob? true
```
Only an explicit `inbox --consume` clears it — confirmed in the same run (`consumed`, and the *next* purge tick deletes the message immediately).

**Consequences:** (a) permanent growth of `messages`/`deliveries` for the majority message kind (`inform`) in a system whose own comment (`server.ts:170-175`) already flags a *related but distinct* gap ("a message claimed by a hook that then crashed... is stuck 'delivered'") as a known, accepted tradeoff — this finding shows the "stuck delivered" state isn't just a crash-window edge case, it's the **default steady state for every inform ever shown once**; (b) `orphans()` (`router.ts:296-315`) and the badge notifier's pending count (`badge.ts:62-67`) will over-report indefinitely, since both read the same `deliveries` table; (c) `pruneOffline` (`registry.ts:131-148`) already refuses to drop a peer with `pending(alias).length > 0` — a dead alias that only ever received informs it "saw" once can **never be pruned from the registry either**, compounding the growth into the registry snapshot too.

**Fix shape:** either treat `delivered` as itself eligible for a time-boxed transition to `consumed` (e.g., a delivery that's sat at `delivered` for N days with no `surfaced`/consent activity is presumed seen), or have the hook path explicitly consume non-correlatable kinds (`inform`) at claim time while leaving `query`/`request` at `delivered` until answered.

---

## 5. 32-bit message IDs — REAL, math-only (not exercised at scale)

**Where:** `src/broker/server.ts:156` (`const mkId = (): string => \`msg-${crypto.randomUUID().slice(0, 8)}\`;`) and identically at `src/client.ts:173` (the degraded-mode fallback generator).

`crypto.randomUUID()` produces `xxxxxxxx-xxxx-...`; `.slice(0, 8)` takes only the first 8 hex characters, which — since the first dash sits at index 8 — is exactly the UUID's first 32 bits, no more. That's a 2^32 keyspace for every message, response, park-notice, and nudge the system ever mints.

By the birthday bound, a 50% collision probability is reached at ~77,000 concurrently-*live* ids (~sqrt(2×ln 2)×2^16), and 1% at ~9,300. Because `purge()` removes fully-settled messages, the practically-relevant denominator is the **currently-live working set** (unsettled + still-pending mail), not lifetime volume — which softens this in normal use, but the sweeper itself is a steady id-consumer (every nudge/last-call/park notice mints a fresh id), and a busy multi-agent deployment with many open asks, long retention, or a `--no-reply-expected` backlog (see §16) can plausibly sit in the thousands-of-live-ids range.

The failure mode on collision is **silent**, not an error:
- `messages.append()` uses `INSERT OR IGNORE` (`sqliteBackend.ts:167-191`) — a colliding new message is dropped without a trace; the sender believes it sent, the recipient never sees it.
- `enqueue()` likewise `INSERT OR IGNORE`s the delivery row.
- `openAwaiting()` uses `INSERT OR REPLACE` (`sqliteBackend.ts:291-299`) — if a freshly-generated origin id collides with an *existing, currently-open* awaiting's `origin_id` (astronomically rarer, but the worst-case outcome), it silently overwrites that unrelated ask's deadline/nudge tracking.

I did not attempt to force an actual 2^32-space collision (that's an intentionally-expensive brute force, not a meaningful use of this audit's time), so this is reported as a proven-by-arithmetic, unexercised-at-scale risk rather than a captured repro.

**Fix shape:** widen the id to the full UUID, or at minimum 12-16 hex chars (48-64 bits), and make `append`/`enqueue` collisions loud (return/log a conflict) rather than silently swallowed.

---

## 6-8. Unbounded filesystem growth — REAL, confirmed by absence-of-cleanup

Three separate directories under `config.home` (`~/.claude-ipc/`) accumulate one file per {message, session, session} respectively, forever, with **no unlink call anywhere in the codebase** (verified by grepping every write site against every `unlinkSync`/`rmSync` call in `src/`, `plugin/`, `scripts/`):

- **`config.blockedDir` (`~/.claude-ipc/blocked/`)** — `src/hooks/stop.ts:32-42`: one zero-byte marker file per `(query|request)` message id that ever triggered the Stop hook's one-time turn-end block. Written at `markBlocked()`, never removed — not on reply, not on decline, not on purge of the underlying message. `registry.ts:139-143`'s `pruneOffline` cleans up **token** files but has no equivalent for blocked markers. In a busy multi-agent setup this accumulates one file per unanswered-at-turn-end ask, indefinitely.
- **`config.aliasDir` (`~/.claude-ipc/alias-by-sid/`)** — `src/aliasStore.ts:43-58`: one file per **session id ever started** (not per alias — every distinct Claude Code session, including ones that only ever registered once and never returned). No cleanup path exists.
- **Per-session watcher logs (`~/.claude-ipc/logs/watch-inbox-$SID.log`)** — `plugin/scripts/watch-inbox.sh:49-51`: appended on every 10s tick for the session's entire lifetime, with **no rotation** (unlike the broker's own `brokerLog`, which caps at 5MB and rotates — `src/broker/log.ts:14-24`), and the file is left behind after the session ends (only the `mktemp -d` seen-set state dir is cleaned via the `trap ... EXIT` at `watch-inbox.sh:43`, not the log).

All three are low-severity in isolation (small files, and modern filesystems tolerate large flat directories reasonably well) but are genuinely unbounded and specifically **not** the kind of thing `purge()`/`pruneOffline()` touch — they're a separate leak surface from the DB-level one in §4.

---

## 9. Non-atomic token write — REAL, low practical risk

**Where:** `src/client.ts:32-35` (`writeToken`) vs `src/aliasStore.ts:43-58` (`writeAliasForSession`, which explicitly does tmp-file + `renameSync` and documents why: *"Written by rename so no reader can catch it half-updated"*).

```js
function writeToken(dir: string, alias: string, token: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(dir, alias), token, { mode: 0o600 });
}
```

Two concurrent `client.register()` calls that both end up persisting a token for the same alias (e.g. a re-registration racing a fresh registration from a sibling process sharing the same `tokensDir`) write directly, no temp+rename. Token strings are short (`tok-<uuid>`, ~40 bytes, well under the ~4KB atomic-write guarantee most filesystems give a single `write(2)` for small buffers), so a torn read is unlikely in practice on APFS/most POSIX filesystems — this is reported as a real inconsistency with the project's own established convention (and thus a latent risk on a filesystem/OS combination without that small-write guarantee) rather than a proven corruption.

---

## 10. Broker can synchronously shell out to `ps` on its own event loop — REAL, code-proven

**Where:** `src/broker/router.ts:107` (`const tty = a.tty ?? (a.pid ? ttyForPid(a.pid) : null);`) inside `register()`, which runs on the broker's single thread — vs `src/badge.ts:40-47` (`ttyForPid`, which calls `Bun.spawnSync(["ps", "-o", "tty=", "-p", ...])`, a **blocking** subprocess spawn).

The project is explicitly aware this is bad: `src/hooks/sessionStart.ts:59-61` comments *"Resolve the tty here (in this short-lived hook) rather than letting the broker spawn `ps` on its event loop"* — and indeed `sessionStart.ts` always supplies `tty` explicitly, so the *hook* path never triggers the broker fallback. But `src/cli.ts:189-194` (the raw `claude-ipc register <alias>` command a human runs from a shell) passes `pid: process.ppid` unconditionally while `tty` is only set `if (flags.tty)` — and the documented usage (`cli.ts:131`, `register <alias> (claim a mailbox from the shell)`) never mentions needing `--tty`. So every plain `claude-ipc register <name>` (the common manual re-registration/rename flow) sends a `pid` with no `tty`, and the router falls back to `ttyForPid(a.pid)` — **inside the broker**, blocking every other connected client and the sweeper for however long spawning `ps` takes.

This is architecturally the same class of issue as §1/§11 (a synchronous operation with unbounded worst-case latency sitting on the broker's single serialization point), just triggered by ordinary, documented usage rather than a race. Severity is capped by `ps`'s typical latency (single-digit to low-double-digit milliseconds), but it's a real, provable violation of the project's own stated intent.

---

## 11. No process-level exception boundary — REAL, contributing factor

**Where:** `src/broker/server.ts` — only `process.on("SIGTERM", cleanup)` and `process.on("SIGINT", cleanup)` are installed (lines 203-204); no `process.on("uncaughtException", ...)`.

Node/Bun's default behavior on an uncaught synchronous exception is to crash the process. Since `router.handle()` already wraps its `switch` in a `try { ... } catch (e) { return fail("internal", ...) }` (`router.ts:43-94`), a bug *inside* one of the op handlers is caught and turned into a normal error response — but anything that throws **outside** that boundary (the sweeper's `setInterval` callback, `startBroker`'s socket setup, `main()`'s own top-level statements — exactly where §1's `SQLITE_BUSY` crash and §10's hypothetical `ps` spawn failure would land) takes down the entire broker, disconnecting every session at once. This amplifies the blast radius of §1 specifically: the double-start race doesn't just fail to start a second broker, it can crash a broker that would otherwise have started cleanly.

---

## 12. Multiple sessions racing the *same* mailbox — ALREADY HANDLED, PROVEN

**Where:** `src/storage/sqliteBackend.ts:239-261` (`claimForDelivery`), whose own comment states the invariant: *"Claim and read in one atomic statement... if a second deliverer... runs the same UPDATE, it sees the rows already flipped and returns none."*

This is the literal "can two sessions claim the same alias and both drain the mailbox" question from the brief, and the answer is a well-evidenced **no** — but not for the reason I expected going in (I assumed the risk was in-process JS interleaving; the real risk, per §14, is at the token/ownership layer, and *that* one has a real bug — see §2). At the storage layer itself, the claim is atomic by construction (`UPDATE deliveries SET state='delivered' ... WHERE state='queued' RETURNING msg_id`), and I verified it across genuine OS-process concurrency, not just single-threaded reasoning:

**Repro (PROVEN):** started a real broker against a scratch `CLAUDE_IPC_HOME`, queued 50 `inform` messages to one alias, wrote its real capability token to disk, then spawned **10 separate `bun` subprocesses** (real OS processes, not just concurrent promises in one process) that all raced a real `deliver()` call against the live broker at the same instant:
```
10 separate OS processes raced deliver() concurrently.
total messages claimed across all racers: 50
distinct message ids claimed: 50
any duplicate claim across processes? false
all N messages accounted for exactly once? true
```
Zero duplicates, zero losses, exact partition of the 50 messages across the 10 racing processes. This holds regardless of the broker's own single-threaded event loop, because the actual mutual exclusion is provided by SQLite's writer serialization on the `UPDATE ... RETURNING` statement, which is correct across process boundaries by design (WAL mode, `busy_timeout=2000`).

---

## 13. Reply landing in/around the sweeper's stage-2 release tick — ALREADY HANDLED, PROVEN + tested

**Where:** `src/broker/server.ts:176-181` (the single `setInterval` running `tickSweeper` + `sweepReplyDeadlines` + `pruneOffline` back to back) vs `src/broker/server.ts:76-92` (the socket `data` handler that invokes `router.handle`) — both are fully synchronous call chains with no `await` inside either, confirmed by reading both in full.

Because Bun/Node's event loop is single-threaded and run-to-completion, a `setInterval` callback and a socket `data` callback can never partially interleave — whichever the runtime dequeues first runs to full completion before the other starts. There is no instruction-level race to find here; "the same tick" is a wall-clock coincidence, not a concurrency hazard, for a single broker process. What actually matters is which one the JS runtime happens to schedule first, and **both orderings are already correct**:

- **Reply processed first, sweeper stage-2 second:** `router.reply()` (`router.ts:337-391`) closes the awaiting with `closeAwaiting(a.corrId, "responded")` (only when not already closed, via the `WHERE closed=0` guard at `sqliteBackend.ts:302`). The sweeper's next tick reads `openAwaitings()` (`WHERE closed=0`) and simply never sees this ask — no stage-2 notice fires for an already-answered ask.
- **Sweeper stage-2 first, reply second:** `sweepReplyDeadlines` closes the awaiting with reason `"parked"` (`sweeper.ts:116`). The subsequent `reply()` call checks `aw?.closed && aw.closedReason === "cancelled"` (`router.ts:352`) — `"parked" !== "cancelled"`, so the reply is **not dropped**; it's delivered and flagged `late:true` (`router.ts:359, 390`). This exact path is directly exercised by `tests/replyDeadline.test.ts`'s *"alice is released, bob answers anyway, and alice still gets the answer"* test, which I read in full and which passes a real sweep-then-reply sequence through a real broker.

Only genuine two-**process** concurrency (two live brokers, from §1) would introduce an actual race here — within one broker, this is a non-issue by construction.

---

## 14. Alias-ownership token gate prevents "both drain" scenarios structurally — ALREADY HANDLED

**Where:** `src/broker/registry.ts:54-79` (`register`, the token-match-or-refuse gate) and `src/broker/router.ts:126-130` (`requireOwner`, applied to every ownership-bearing op: `heartbeat`, `leave`, `send`-as, `check`, `deliver`, `reply`, `accept`, `decline`, `snooze`).

A session can only act as an alias if it presents that alias's exact capability token. Since `register()` only ever mints a *fresh* token when there is no existing token or the presented one matches (`registry.ts:64-65`), and every mutating/reading op on that alias's mailbox is gated by `requireOwner` checking the presented token against the registry's stored one, there is no code path by which two sessions holding genuinely *different* tokens can both successfully call `deliver()`/`check()` against the same alias — one will always get `unauthorized`. The only way two processes can legitimately both act as one alias is if they **share the same token file on disk** (e.g. two panes of the same shared environment, or a sub-agent inheriting the parent's `~/.claude-ipc/tokens/<alias>` file) — and in that specific case §12's proof already shows the outcome is still safe (atomic claim, no duplicate delivery), because the safety property lives at the SQL layer, not the token layer.

---

## 15. `Awaiting.closedReason` — not a totality bug, documented legacy

**Where:** `src/models.ts:79` (`closedReason: "responded" | "timeout" | "cancelled" | "ghosted" | "parked" | null`) vs every live `closeAwaiting` call site (grepped exhaustively): `sweeper.ts:26`, `sweeper.ts:116` (both `"parked"`), `router.ts:375`, `router.ts:441` (both `"responded"`), `router.ts:462` (`"cancelled"`).

`"timeout"` and `"ghosted"` are never written by any code path in this version of the system — `models.ts:76-78`'s own comment confirms this is deliberate: *"Those reasons are retained for back-compat reads"* (i.e., reading old rows written before the ghost-sweep redesign, referenced in `docs/notes/no-liveness-claims.md`). This is the one item in the brief's "unreachable state" question that turns out to be an intentional, documented design decision rather than a defect — flagged here for completeness, not as a finding.

Separately: `closed=false` with a non-null `closedReason` is structurally unreachable (every write to `closed_reason` happens in the same `UPDATE` statement that sets `closed=1`, per `sqliteBackend.ts:301-303`), so the state machine's *live* subset (`{open,null} → {closed,responded|cancelled|parked}`) is total and well-formed for what it actually uses.

---

## 16. An opted-out, never-answered ask never settles — REAL, low severity

**Where:** `src/broker/sweeper.ts:65-66` (`if (a.replyByS === null) continue;` — skips chasing entirely) vs `src/broker/sweeper.ts:17-46` (`tickSweeper`'s TTL-based park, gated on `expires_at IS NOT NULL`) vs `src/storage/sqliteBackend.ts:405-416` (`purge`'s exclusion of any message with an open awaiting).

A `send --no-reply-expected` (or any send with `replyByS: null` and no `--ttl`) opens an `awaiting` row that is *never* subject to either closing mechanism: the TTL sweep only fires when `expiresAt` is set, and the reply-deadline sweep explicitly skips `replyByS === null`. If the recipient never replies and the sender never explicitly `cancel`s, this `awaiting` row — and therefore its origin `query`/`request` message, per `purge()`'s exclusion clause — lives forever. This is narrower than §4 (only affects the opted-out combination, not the default-chased path) but is the same underlying shape: a state that's reachable by design (opting out of chasing is a documented, intentional feature — `cli.ts:133-137`) with no corresponding terminal transition when nobody ever acts on it.

---

## Notes on what I did *not* find

- No evidence of a **lost** message under any interleaving I could construct — every duplicate/leak finding above is either "delivered too many times" (§3) or "never garbage collected" (§4/§6-8/§16), never "vanished before delivery," except for the theoretical, math-only ID-collision case (§5).
- The `pump()`/outbox partial-write handling in `server.ts:46-62` and the mirrored logic in `client.ts:44-105` both correctly handle a socket send-buffer watermark by keeping the unsent tail and resuming on `drain` — read both in full, found no gap.
- `FrameDecoder` (`protocol.ts:62-79`) correctly reassembles frames split across `data` events and correctly drains multiple frames packed into one chunk; not exploitable since no current client in this codebase pipelines more than one in-flight request per connection (confirmed in `client.ts:44-105`, one request/response per connection, then `socket.end()`).
