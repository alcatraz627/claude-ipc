# Adversarial failure hunt — degradation, environment, physical world

claude-ipc, read-only review. Every finding below cites the file:line actually
opened. "Proved" means the code path is read and the failure follows directly
from it (plus, where noted, well-established POSIX/SQLite/launchd semantics).
"Suspected" means the reasoning is grounded but I couldn't execute the repro
against a live broker (this was a read-only hunt against `~/.claude-ipc`, which
real agents are using).

---

## 1. Laptop sleep / suspend

### 1.1 REAL — the sweeper is not sleep-aware, and releases everything at once on wake

`src/broker/server.ts:177-181` drives the sweeper off a plain `setInterval`
(`config.sweepIntervalS * 1000` = 5000ms, `src/config.ts:44`), and every deadline
inside it is wall-clock (`nowS = () => Math.floor(Date.now()/1000)`,
`src/broker/server.ts:129`). macOS fully suspends the process during sleep — the
event loop doesn't run, so libuv/Bun timers don't "catch up" by firing N missed
ticks. What actually happens on wake is **one** tick, whose `now()` reflects the
full elapsed wall time (e.g. +8h). `sweeper.ts:65` (`sweepReplyDeadlines`) then
iterates **every** `openAwaitings()` unconditionally and `sweeper.ts:24`
(`tickSweeper`) does the same for `awaitingPastTtl(now())` — so every ask whose
`reply-by`/`finalGrace`/TTL fell inside the sleep window fires its nudge/last-call/
park **in that single tick**, synchronously, no jitter, no rate limit.

Concretely: a laptop closed for 8h with 10 outstanding asks across several
sessions wakes up and, within one 5s tick, appends and enqueues up to 20 new
messages (nudge + park/last-call pairs) in one pass. Every live
`plugin/scripts/watch-inbox.sh` watcher for those recipients picks the whole
batch up on its very next 10s poll and fires **one wake line each** (the script
does coalesce a single tick's arrivals into one line — `watch-inbox.sh:117-150` —
so it's not literally 20 separate re-invocations, but every affected session
still gets turned around simultaneously the moment the machine wakes).

This doesn't corrupt anything — it's the same set of notifications that would
have fired anyway, just batched — but it is an unmitigated **storm**: every
session with pending mail turns around at once on wake, with no spreading/backoff.
Nothing in the code softens this.

### 1.2 ALREADY HANDLED — the bash monitor's poll loop is suspend-safe

`plugin/scripts/watch-inbox.sh:155` (`sleep "$INTERVAL"`) has no wall-clock
deadline math — it's a bare `sleep`, and macOS suspend halts the process
(and therefore the sleep syscall) rather than letting wall time advance under
it. So the watcher doesn't drift or fire a backlog of "missed" ticks after a long
sleep; it just resumes its normal 10s cadence. Checked, found fine.

### 1.3 REAL / suspected — orphaned monitor processes have no self-termination and no cap

`plugin/scripts/watch-inbox.sh` is an unconditional `while :; do … sleep
"$INTERVAL"; done` loop (lines 86-156). There is **no check anywhere in the
script** of whether its parent Claude Code process is still alive (no `kill -0
$PPID`, no ppid-change detection). The only exit path is the `trap 'rm -rf
"$STATE"' EXIT` (line 43), which only fires on a **signal delivered to this
process** — it does nothing if the process is simply orphaned.

Per standard POSIX semantics, a parent that dies via `SIGKILL` / OOM-kill /
abrupt process-group teardown does **not** automatically kill its children —
they're reparented (to launchd/init) and keep running. So: if the harness that
owns Claude Code's "Monitor" subprocess ever fails to reap this script on a
non-graceful exit (force-quit, closed terminal window, battery death, `kill -9`
on the Claude process, the exact "laptop closes mid-flight" scenario the brief
names), the watcher survives indefinitely — polling the broker and appending to
its own uncapped log (§6.1 below) every 10s, forever, until the machine reboots
or someone `pkill`s it by hand. Nothing in this repo tracks watcher PIDs, so
there is no reaper anywhere for a stray one. Over the lifetime of a machine with
many short/crashy sessions, these accumulate one-per-crashed-session with no
upper bound.

I could not verify Claude Code's own subprocess-supervision code (out of this
repo), so I can't say how *often* this actually happens in practice — only that
if it ever does, this script does nothing to notice or stop itself.

---

## 2. Clock changes (NTP step, DST, skew, future timestamps)

### 2.1 REAL (same mechanism as 1.1) — a forward clock step produces the identical storm

Nothing distinguishes "8 hours actually passed" from "the clock got stepped
forward 8 hours" in `sweeper.ts` — both make every open awaiting's deadline
look simultaneously past-due on the very next tick. Same code, same lack of
mitigation as §1.1.

### 2.2 ALREADY HANDLED — negative-duration guard

`src/broker/sweeper.ts:89`: `const secs = Math.max(0, Math.round(now() -
origin.ts));` — explicitly clamps a clock-skew-induced negative duration
(recipient's `now()` behind the message's stored `ts`) before it's used to
format the "waited Xs/Xm" string. No `-3s` in a user-facing message. Good,
deliberate defensive code.

### 2.3 minor / suspected — a future-dated `ts` from client-side clock skew

Degraded-mode sends stamp their own `ts` client-side (`src/client.ts:180`,
`Math.floor(Date.now()/1000)`), independent of the broker's `now()`. If that
process's clock is briefly skewed ahead at send time, the resulting message
looks like it originated in the future once the broker (or a later reader)
compares against its own clock. Traced through the code, the only consequences
are benign: `senderDue`/`nudgeDue` in `sweeper.ts:91,95` land further out (a
delayed nudge, not a crash), and `purge()`'s `m.ts < ?` filter
(`src/storage/sqliteBackend.ts:410`) just doesn't consider the row for purge yet.
No negative-duration crash, no infinite-never-fires deadline found. Low severity.

---

## 3. Broker down / crashed / killed -9

### 3.1 REAL, centerpiece — the periodic sweeper has no exception guard, and a persistent cause crash-loops the broker

`src/broker/server.ts:177-181`:
```ts
const sweeper = setInterval(() => {
  tickSweeper(backend, nowS, mkId, config.retentionS);
  sweepReplyDeadlines(backend, nowS, mkId, config.reply.finalGraceS);
  registry.pruneOffline(nowS() - config.registryRetentionS);
}, config.sweepIntervalS * 1000);
```
No `try`/`catch` around any of this. Contrast with every real client request,
which **is** protected: `src/broker/router.ts:43-94` wraps the entire op
dispatch in `try { switch(...) } catch (e) { return fail("internal", ...) }`.
I confirmed via `rg -n "uncaughtException|unhandledRejection|process.on"
src/` that **no global handler exists anywhere** in the codebase — only
`SIGTERM`/`SIGINT` are handled (`server.ts:203-204`).

Any exception thrown inside a sweep tick — a `SQLITE_FULL` from `backend.append()`
inside `tickSweeper` (`sweeper.ts:42`) or `sweepReplyDeadlines`'s `post()`
(`sweeper.ts:84`) on a full disk, or a `JSON.parse` throw in `toMessage()`
(`src/storage/sqliteBackend.ts:108`) if a `context_ptr` column ever holds
malformed JSON — is an uncaught exception inside a `setInterval` callback,
which terminates the process. `sweepIntervalS` is **5 seconds**
(`src/config.ts:44`), so under a *persistent* cause (disk stays full) the
broker crashes on its very first tick after every launchd respawn — a tight
crash loop bounded only by launchd's default relaunch throttle (~10s,
undocumented in the plist — see §5), indefinitely, with zero backoff or
self-healing.

Worth stressing the asymmetry: the exact same failure (e.g. disk full) hit via
a normal client request degrades gracefully to an `internal` error response;
hit during a sweep tick, it takes the whole broker down for every connected
session at once. The docs' "Crash resistance" bullet
(`docs/06-security-and-ops.md:81-83`, "per-connection error/close handlers
keep one bad socket from taking down the broker") only covers the
per-connection path — it says nothing about, and doesn't cover, the sweeper.

### 3.2 REAL — `main()`'s startup sequence is equally unguarded, so DB corruption crash-loops forever with no self-healing

`src/broker/server.ts:154`: `const backend = new SqliteBackend(config.dbPath);`
— no `try`/`catch`. If the on-disk file is corrupt (partial write from a prior
crash, filesystem issue), `new Database(path)` throws synchronously and kills
the process before it ever binds the socket. Nothing renames, quarantines, or
recreates the corrupt file — the next launchd respawn opens the identical bad
path and dies identically. This is a **permanent** crash loop that only a human
manually intervening (move/delete the `.sqlite` file) can end. Same absence of
a guard applies to `startBroker()`'s `Bun.listen()` call at `server.ts:182`
(see §7.1 for a plausible trigger).

### 3.3 ALREADY HANDLED — every hook degrades silently on a genuinely down broker

`src/hooks/userPromptSubmit.ts:15-25`, `src/hooks/sessionStart.ts` (each
broker call independently try/caught, e.g. lines 54-70, 76-82, 87-92, 98-110),
and `src/hooks/stop.ts:81-108` all wrap their `Client` calls in `try/catch`
with comments explicitly stating "never block the turn." I read every hook
entry point end to end — none of them let a down-broker exception escape into
a Claude Code `decision:block` or an unhandled rejection. This is well done.

### 3.4 REAL — the Stop hook's one-time-block guarantee silently degrades to "block every turn" under sustained disk pressure

This is the specific check the brief asked for: **does anything block a
Claude turn, and can it wedge a session?**

`src/hooks/stop.ts:35-42`:
```ts
function markBlocked(id: string): void {
  try {
    mkdirSync(config.blockedDir, { recursive: true });
    writeFileSync(markerPath(id), "");
  } catch {
    // best-effort — a lost marker at worst blocks the same message a second time
  }
}
```
`alreadyBlocked()` (`stop.ts:33`) is `existsSync(markerPath(id))`. The
documented intent (`stop.ts:6-9`, "fires once… then never blocks on that
message again") depends entirely on that write succeeding. Under a **sustained**
cause — disk full is exactly the scenario the brief names — the write fails on
every turn, so `alreadyBlocked()` returns `false` every time, and
`decidePush()` (`stop.ts:66-73`) returns `{kind:"block", ...}` again on the
very next turn, and the one after that, for as long as (a) the underlying ask
stays unanswered **and** (b) disk stays full. The comment's "a second time"
undersells the real failure mode, which is unbounded, not one extra repeat.

In practice this is bounded by the agent's own behavior: replying to the ask
(or accepting/declining it) clears the pending condition that `decidePush`
checks, which breaks the loop independent of whether the marker file ever gets
written. So it's not an unconditional wedge — but it does mean the agent is
forced into a repeated involuntary continuation every single turn instead of
being nudged once, for the entire duration of a disk-full episode, which is a
real, user-visible degradation of exactly the surface the brief flagged as
"the worst outcome."

### 3.5 REAL — a live-but-slow broker adds up to ~10s of hidden latency to every Stop-hook turn

`src/hooks/stop.ts:78`: `const client = new Client(config.socketPath);` — no
fallback `dbPath`, unlike the other two hooks. So `client.heartbeat(alias)`
(line 82) and `client.check(alias)` (line 90) are each individually bounded
only by `requestTimeoutMs` = 5000ms (`src/config.ts:43`), awaited
**sequentially**, both wrapped in `catch` blocks that swallow the failure
silently ("never block the turn"). If the broker is up but slow (see §3.6 for
a concrete, self-inflicted cause), this hook can silently add up to ~10 seconds
to every single turn with no error ever surfacing to the user — a boring but
real perf tax that compounds for as long as the slowness lasts.

### 3.6 REAL — a live-but-slow broker gets silently bypassed by every hook/MCP call that hits the 5s ceiling, causing a live two-writer split

`src/client.ts:140-151` (`Client.call`):
```ts
try {
  res = await request(this.socketPath, ...);
} catch (e) {
  if (this.fallback) return this.degraded(op, args);
  throw e;
}
```
`request()` (`client.ts:44-105`) rejects identically whether the broker is
truly down, the connection dropped, **or the 5000ms timeout simply elapsed**
(`client.ts:57-60`). Any of those trips the same `catch`, and if a `fallback`
dbPath was supplied, the caller silently opens a **second, independent**
`SqliteBackend` (`client.ts:170`) directly against the same on-disk file and
writes/reads through it — completely bypassing the live broker's in-memory
`Router` (no `requireOwner`, no allowlist, no strict-mode registration check,
and critically no `openAwaiting()` bookkeeping, so a query/request sent this
way never gets chased — a gap the code candidly documents at
`client.ts:154-162`, but that comment frames it as a "broker down" limitation,
not a "broker merely slow" one).

Every one of the hot, per-turn call sites passes a fallback and is exposed to
this: `sessionStart.ts:28`, `userPromptSubmit.ts:18`, `mcpServer.ts:159`.

A concrete, self-inflicted way to make the broker slow enough to trip this:
`src/storage/sqliteBackend.ts:377-395` (`history()`) has **no `LIMIT`** —
`SELECT * FROM messages ${where} ORDER BY ts` over the whole table. `claude-ipc
tail` calls `client.history({})` on every redraw (`src/monitor.ts:64`) on a
**1-second** loop (`src/cli.ts:472-476`, `setTimeout(..., 1000)`), fetching
the entire messages table just to keep the last 10 rows
(`src/monitor.ts:65`). Bun's SQLite calls are synchronous and run on the
broker's single event-loop thread, so a large table (default retention keeps
7 days of "settled" traffic, plus an unbounded tail of never-settled rows —
see §6.4) combined with disk contention (Time Machine, an external/spun-down
drive, thermal throttling — all plausible on a laptop) can plausibly push a
single `history({})` call, and therefore every other concurrently-waiting
client, past the 5-second ceiling. A human leaving `claude-ipc tail` open for
observability (which the plist comment explicitly recommends,
`launchd/com.alcatraz.claude-ipc.plist:4`) is themselves a repeat cause of
exactly the load that trips this.

### 3.7 REAL / suspected — the two-broker startup guard is check-then-act, with no lock, and the pidfile write comes last

`src/broker/server.ts:134-142` (the "refuse a second broker" guard) reads
`config.pidPath` and checks `isAlive()` — but the corresponding
`writeFileSync(config.pidPath, ...)` doesn't happen until **line 183**, after
the entire startup sequence (SQLite open + registry warm-start, Router
construction, `replayInflight()`, the sweeper's `setInterval`, and the actual
`Bun.listen()` socket bind at line 182) has already completed. There is no
flock/lockfile — just a plain read-then-much-later-write. Two `serve`
processes started within that window both pass the guard.

`startBroker()` (`server.ts:65-69`) unconditionally `unlinkSync`s whatever is
at `socketPath` before rebinding — so the second process to reach that line
silently evicts the first process's listener from all future connections
without killing it. Both remain alive, both hold independent `SqliteBackend`
connections to the *same* file, both run their own 5s sweeper against it.
SQLite's WAL + `busy_timeout=2000` (`sqliteBackend.ts:144-145`) keeps the file
itself from corrupting, but the two processes' in-memory `Registry` state
(roster, tokens) permanently diverges — clients connecting after the eviction
see one broker's view, and orphaned in-memory state (e.g. any peer who
registered against the now-unreachable first broker) is invisible to the
survivor until it re-registers.

A plausible real trigger, not purely theoretical: launchd's `KeepAlive` (see
§5.1) relaunches the broker immediately after *any* exit, including one
triggered by `claude-ipc daemon stop`. If a script or an agent falls back to
the CLI's own `daemon start` (`cli.ts:414-429`, which only probes liveness via
`client.list()`, not the pidfile) around the same moment launchd is already
mid-relaunch, both spawn paths can land inside this window. I did not
reproduce this live (would require racing two real `serve` processes against
`~/.claude-ipc`, out of scope for a read-only hunt); flagging as
well-grounded-but-unreplicated.

### 3.8 ALREADY HANDLED — stale socket file after a crash

`src/broker/server.ts:65-69`: `startBroker()` proactively `unlinkSync`s
whatever file already sits at `socketPath` (wrapped in try/catch for "no stale
socket to remove") before calling `Bun.listen()`. A socket file left behind by
a `kill -9`'d prior broker never blocks the next boot. Handled correctly.

### 3.9 ALREADY HANDLED — socket + directory permissions, with one minor TOCTOU

`server.ts:105-153`: the socket is chmod'd `0600`, the run/data directories
`0700`, and — notably — pre-existing directories from an older install are
explicitly re-tightened on every boot (`for (const d of [...]) chmodSync(d,
0o700)`), so an upgrade doesn't inherit looser permissions. Careful, deliberate
work for the cross-UID boundary on a shared Mac.

Minor / suspected: the `chmodSync(opts.socketPath, 0o600)` call
(`server.ts:109`) happens *after* `Bun.listen()` has already returned
(`server.ts:70-104`), so there's a narrow window — milliseconds — where the
socket file exists at default (umask-derived) permissions before being locked
down. Low severity given the window size, worth a one-line note only.

---

## 4. SQLite — disk full / corrupt / locked / deleted underneath the broker

Covered above for crash behavior (§3.1, §3.2, §3.6). Additional SQLite-specific
findings:

### 4.1 REAL / suspected — deleting the DB file while the broker holds it open silently forks the data

Nothing in the code detects this. Per standard POSIX unlink-while-open
semantics, the broker's existing `SqliteBackend` connection keeps working
against the now-unlinked inode (data isn't freed until the fd closes) — but
any **new** `SqliteBackend` opened at that path (a degraded-mode hook call
per §3.6, or the broker's own next restart) silently creates a fresh, empty
file at the same path, since `new Database(path)` creates-if-missing with no
existence check. Whatever the original process was still holding is lost the
moment its process exits (crash, or even a clean restart). No
`PRAGMA integrity_check` is run anywhere (confirmed via grep across `src/`),
so there's no detection — it would just look like "the mailbox went empty" to
whoever notices later. This is reasoned from file-system semantics + the
absence of any guard in the code, not executed against a live broker.

### 4.2 REAL — the documented "log doesn't grow without bound" claim has two unmitigated exceptions

`docs/06-security-and-ops.md:84-86` states: "the sweeper purges fully-settled
messages … so the log doesn't grow without bound." `purge()`
(`src/storage/sqliteBackend.ts:405-430`) only deletes a message once **both**
no delivery is still `queued`/`delivered`/`surfaced` **and** no `awaiting`
row referencing it is still open. Two real, currently-unmitigated ways a row
never satisfies that:

- **A delivery claimed then abandoned.** If a hook `claimForDelivery`s a
  message (flips its delivery row to `'delivered'`) and then the session
  crashes before actually surfacing/consuming it, that row is stuck
  `'delivered'` forever — the code candidly documents this exact caveat at
  `server.ts:172-175` ("a message claimed by a hook that then crashed before
  surfacing it is stuck 'delivered' and not retried"), but doesn't connect it
  to the retention claim: that message and its `messages` row are now
  permanently ineligible for `purge()`. This is directly plausible on a
  laptop that "gets closed mid-flight" — exactly the brief's framing.
- **An ask sent with `--reply-by none` and no TTL** (the default — TTL is
  `null` unless `CLAUDE_IPC_DEFAULT_TTL_S` is set, `config.ts:42`) never
  auto-closes: `sweeper.ts:66` explicitly skips it (`if (a.replyByS === null)
  continue`), and `awaitingPastTtl` requires a non-null `expires_at`
  (`sqliteBackend.ts:329-334`). If nobody ever replies or cancels it, both the
  `awaiting` row and its origin message live forever.

### 4.3 ALREADY HANDLED — atomic claim, WAL + busy_timeout for lock contention

`claimForDelivery` (`sqliteBackend.ts:239-261`) is a single `UPDATE ...
RETURNING`, which the code correctly reasons prevents two concurrent
deliverers from double-delivering. `PRAGMA journal_mode = WAL` +
`PRAGMA busy_timeout = 2000` (`sqliteBackend.ts:144-145`) is the standard
answer to same-file lock contention between the live broker and any
degraded-mode direct-SQLite client (§3.6). What happens if `busy_timeout`
itself is exceeded (`SQLITE_BUSY` thrown) is exactly the general
exception-handling story from §3.1/§3.3: graceful if it happens inside a
router-handled request, fatal if it happens inside the unguarded sweeper tick.

---

## 5. launchd

### 5.1 REAL — `KeepAlive=true` means `claude-ipc daemon stop` doesn't actually stop the broker under the recommended install

`launchd/com.alcatraz.claude-ipc.plist:29-30`: `<key>KeepAlive</key><true/>`,
with no qualifying dictionary (no `SuccessfulExit`/`Crashed` condition) — this
means launchd relaunches the broker after **any** exit, deliberate or not.
`claude-ipc daemon stop` (`src/cli.ts:431-440`) only does
`process.kill(pid, "SIGTERM")` against the pidfile's PID — it never calls
`launchctl bootout` or otherwise unregisters from launchd. Under the
documented, recommended install path (`scripts/install-launchd.sh`), running
`claude-ipc daemon stop` kills the broker and launchd brings it right back
within its relaunch throttle (Apple's undocumented-in-this-plist default is
~10s). The install script itself is aware of this — it does
`launchctl bootout "$DOMAIN/$LABEL"` **before** `$CLI daemon stop`
(`scripts/install-launchd.sh:23-25`) — but that awareness isn't reflected in
the CLI command itself, so any other caller (a user, or an agent) reasonably
expecting `daemon stop` to actually stop the broker will be surprised when it
comes back seconds later.

### 5.2 not evaluated — no `ThrottleInterval` override

The plist doesn't set `ThrottleInterval`, so launchd's default applies. Not a
bug by itself, but it sets the cadence for how bad §3.1/§3.2's crash loops
actually are in practice — worth knowing when reading those findings.

---

## 6. Unbounded growth (side-channel directories + logs)

The brief asked directly: is anything under `~/.claude-ipc/{blocked,logs,
tokens,meta,alias-by-sid}/` ever reclaimed? Answer, checked by grepping every
write site against every delete site in `src/`:

| Dir | Written at | Ever unlinked? | Verdict |
|---|---|---|---|
| `blocked/` | `stop.ts:37-38`, one file per message-id ever Stop-blocked | **No — grepped, zero hits** | REAL, unbounded |
| `meta/` | `sessionStart.ts:41-42`, one file per alias, every SessionStart | **No** — `registry.pruneOffline` (`registry.ts:139-143`) only unlinks the matching `tokens/` file, not `meta/` | REAL, unbounded |
| `alias-by-sid/` | `aliasStore.ts:47-49`, one file per session_id (a UUID, never reused) | **No — grepped, zero hits** | REAL, unbounded, worst of the four (grows even for perfectly well-behaved sessions) |
| `tokens/` | `client.ts:32-35`, one file per alias | **Yes** — `registry.ts:139-143`, but only when `pruneOffline()` actually runs (gated on the sweeper — see §3.1) and only for aliases with zero pending mail | Handled in the common case, inherits §3.1's fragility |
| `logs/broker.log` | `log.ts:16-28` | **Yes** — explicit 5 MB size-rotation, one prior kept | ALREADY HANDLED |

### 6.1 REAL — per-session monitor log has no rotation and no cleanup at all

`plugin/scripts/watch-inbox.sh:49-51` writes to
`$IPC_HOME/logs/watch-inbox-$SID.log` with plain `>>` appends, unlike the
broker's own `brokerLog()` which is explicitly size-capped. There is no
rotation, no cap, and (grepped) no cleanup path anywhere — not even when a
session ends cleanly. Combined with §1.3 (orphaned watchers can run forever),
this is the single least-bounded piece of state in the whole system: a
process that never dies, appending to a file that's never capped, forever.

### 6.2 boring, real, adjacent — 5.3 GB of stale `bun-build` artifacts already sitting in the repo checkout

Not part of the `~/.claude-ipc` runtime state the brief is centered on, but
directly relevant to the "disk full" physical-world lens and worth one line:
`find . -maxdepth 1 -name "*.bun-build"` returns **90 files, 5.3 GB total**,
all dated 13 May (two months stale as of this review), sitting in the project
root. These look like leftovers from `bun build --compile`
(`package.json`'s `build:cli`/`build:hooks` scripts) that Bun's compiler
apparently doesn't clean up between builds. Not a claude-ipc bug per se, but
it's 5.3 GB of quiet bloat in the exact directory tree whose broker needs disk
headroom to keep running — worth a `trash *.bun-build` at some point (did
**not** delete anything — read-only task).

---

## Summary (max 8 bullets)

- **Sweeper has no exception guard** (`server.ts:177-181`, no global
  `uncaughtException` handler anywhere) while every client request does
  (`router.ts:43-94`) — a disk-full write or a corrupt row during a 5s sweep
  tick crashes the whole broker outright and crash-loops it every ~10-15s
  under launchd's default KeepAlive, with no self-healing (`server.ts:154`
  also has zero guard, so a corrupt DB file crash-loops forever).
- **Stop hook's "block once" guarantee degrades to "block every turn"** under
  sustained disk pressure: the one-time marker write is swallowed on failure
  (`stop.ts:35-42`), so `alreadyBlocked()` never returns true and the turn
  re-blocks every time until the ask is actually answered or disk frees up.
- **A merely-slow (not down) broker gets silently bypassed** by every hot hook
  call site (`sessionStart.ts:28`, `userPromptSubmit.ts:18`,
  `mcpServer.ts:159`) the instant a request exceeds the 5s timeout
  (`client.ts:140-151`), opening a second independent SQLite writer against
  the live broker's own DB file with none of the router's bookkeeping — and
  `claude-ipc tail`'s unbounded, no-`LIMIT` `history()` scan on a 1s loop
  (`monitor.ts:64`, `sqliteBackend.ts:377-395`) is a concrete, self-inflicted
  way to cause exactly that slowness.
- **Laptop wake = storm, not corruption**: 8h of sleep collapses into one
  sweeper tick that fires every pending nudge/park/last-call at once
  (`sweeper.ts`), with no rate limiting; the same thing happens on any forward
  clock step (NTP, DST, manual). Negative-duration display is already guarded
  (`sweeper.ts:89`).
- **`daemon stop` doesn't stop the broker** under the recommended launchd
  install (`KeepAlive=true`, plist:29-30) — it just gets relaunched; the
  install script itself works around this with `launchctl bootout` but the
  CLI command doesn't. This also plausibly seeds the check-then-act two-broker
  race in `main()` (pidfile write is the *last* line of startup, `server.ts:183`,
  well after the socket bind).
- **Three of four side-channel dirs never get reclaimed, ever**: `blocked/`,
  `meta/`, and especially `alias-by-sid/` (one file per session UUID, grows
  even for perfectly well-behaved sessions) have zero delete call sites
  anywhere in the repo. `tokens/` is the only one with a reaper, and it's
  gated on the same sweeper that §1 shows can crash-loop.
- **Orphaned monitor processes have no self-check and no cap**: `watch-inbox.sh`
  never verifies its parent is alive; a SIGKILL'd Claude Code process leaves it
  running forever per ordinary POSIX orphan-reparenting, polling every 10s and
  appending to an uncapped, never-rotated log — the single least-bounded piece
  of state in the system.
- **Two documented "purges everything" retention claims have real exceptions**:
  a delivery claimed-then-abandoned by a crashed hook stays `'delivered'`
  forever, and any ask sent with `--reply-by none` + no TTL never auto-closes
  — both make their origin message permanently un-purgeable, contradicting
  `docs/06-security-and-ops.md:84-86`.

Full report: `/Users/alcatraz627/Code/Claude/claude-ipc/.claude/output/20260714-0400-sweep/degradation.md`
