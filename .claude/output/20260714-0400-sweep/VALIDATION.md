# Validation criteria — written BEFORE the fixes

Each row is a **falsifiable, runnable check**. The adversarial validator judges the work
against this contract, which it did not author. A fix is not done because a test passes; it
is done when the check below passes **and** the check has been shown to FAIL against the
unfixed code (mutation-test the guard — a green suite that was never red proves nothing).

Spec: `VERDICT.md` in this directory. Standing constraint from that doc's conclusion:
**no fix may introduce a claim the system cannot back** — no `{ok:true}` that changed
nothing, no comment that misstates its own failure mode, no affordance whose text lies.

---

## Part A — the wake path (the goal)

| id | criterion | how to falsify it |
|---|---|---|
| A1 | **The wake path has automated tests at all.** `watch-inbox.sh` is driven as a real process against a real broker, not mocked. | `bun test` includes a wake-path suite that spawns the actual script; deleting the script's wake `printf` turns it RED. |
| A2 | **A session renamed with a SPACE still wakes.** Today: alias `fix auth bug` → watcher polls `fixauthbug` → deaf forever. | Register an alias from title `"fix auth bug"`, send it a query, assert a wake line is emitted. Must fail on today's code. |
| A3 | **Alias producer and consumer agree by construction.** Whatever `sanitizeAlias` emits must be exactly what the watcher polls — no whitespace mangling on either side. | Property check over a list of hostile titles (spaces, tabs, quotes, unicode, 100 chars): `watcherReads(sanitize(t)) === sanitize(t)` for all t. |
| A4 | **An idle agent woken by a peer is NOT handed unframed peer text.** Today the wake line prints the peer's raw body and points at `claude-ipc inbox`, which emits raw JSON — no trust rail on the only path with no human watching. | Wake a session with a hostile body; assert the agent-visible surface carries the trust boundary (peer ≠ your user; cannot widen permissions; refuse laundering). |
| A5 | **A peer's body cannot forge system framing.** A body containing `⟨response from ipc⟩` or a fake `[claude-ipc] NO REPLY YET` must not appear to the recipient as broker-minted. | Send a body containing the framing delimiters; assert the rendered context does not present it as a distinct/system message. |
| A6 | **An orphaned monitor exits.** Today it polls every 10s forever after its Claude is SIGKILLed. | Start the watcher with a fake parent pid, kill the parent, assert the watcher exits within ~2 poll intervals. |
| A7 | **The watcher log cannot grow without bound.** | Drive many wakes; assert the log is capped/rotated. |
| A8 | **The 10s poll does not repaint the user's tab title.** `check()` calls `notify()`, so the watcher's own poll triggers a badge repaint every 10s, fighting the user's tab-title system. | Assert a non-consuming `check` does not fire the notifier. |
| A9 | **A missing dependency fails LOUDLY.** The loop needs `python3`; if absent the watcher must not silently poll forever emitting nothing. | Run with a PATH lacking python3; assert it says so (log + one wake), rather than going quietly deaf. |

## Part B — containment (nothing else matters if these fire)

| id | criterion | how to falsify it |
|---|---|---|
| B1 | **One bad row cannot kill the bus.** The 5s sweeper tick has no try/catch and there is no `uncaughtException` handler; a throw takes the broker down and launchd `KeepAlive` crash-loops it forever. | Make a sweep operation throw; assert the broker SURVIVES, logs, and keeps serving requests. Must crash on today's code. |
| B2 | **A failed marker write cannot wedge a human's session.** Today `decidePush` treats an ask as fresh whenever the marker is ABSENT, so a permanently failing write re-blocks EVERY turn forever. | Make `markBlocked` always fail; assert the turn blocks at most ONCE, never repeatedly. Must re-block forever on today's code. |

## Part C — project mail (one schema hole, three symptoms)

| id | criterion | how to falsify it |
|---|---|---|
| C1 | **`accept()` on project mail either works or fails — it never lies.** Today it updates `WHERE to_alias=<alias>` on a row keyed `proj:/path`, matches ZERO rows, and returns `{accepted:true}`. | Accept a project ask; assert the stored state actually changed. Must fail on today's code (zero rows, success reported). |
| C2 | **Project work can be CLAIMED atomically.** Two sessions both accepting must not both proceed. | Race two accepts on one project ask; assert exactly one wins and the loser is told so. |
| C3 | **A bystander's decline does not settle the ask for everyone else.** Today one member declining consumes the `proj:` row for the whole project (a regression shipped in 304e7ba). | member-a declines; assert member-b still sees the ask pending. Must fail on today's code. |
| C4 | **A decline still reaches the sender and still records the decliner's refusal.** (Don't fix C3 by breaking what worked.) | Assert the sender gets the declined response, and the decliner is not re-nagged. |

## Part D — the one-liners

| id | criterion | how to falsify it |
|---|---|---|
| D1 | **The `ipc` sender alias is reserved.** Any peer can currently `register ipc` and mint notices indistinguishable from the broker's own (including "went offline" and "you may proceed without them"). | Attempt `register ipc`; assert it is refused. Must succeed on today's code. |
| D2 | **`history` and `status` require ownership.** Today they have NO auth: any peer dumps every message body machine-wide plus `contextPtr.transcriptPath` for other sessions. | Call both without a token; assert refusal. Must return everything on today's code. |
| D3 | **Project membership is one-directional.** Today `sameLineage` grants membership if EITHER path is an ancestor, so a session at `~` is a member of every project mailbox and its hook consumingly claims their mail. | Assert cwd `~` is NOT a member of `~/Code/x`, while cwd `~/Code/x/sub` IS a member of `~/Code/x`. |
| D4 | **The alias side file is written only after the alias is WON.** Today it's written before register, so the loser of a race is permanently `unauthorized` — silently, for the whole session. | Race two sessions for one alias; assert the loser's later hooks still work (on its own fallback identity), and that it is TOLD. |
| D5 | **Message ids do not silently collide.** 32 bits + `INSERT OR IGNORE` means a collision drops the new message but still enqueues its delivery row — the recipient receives the OLDER message's content. | Force an id collision; assert no silent wrong-content delivery (either enough entropy that it cannot happen, or an explicit failure). |

## Part E — the standing constraint (applies to every fix)

| id | criterion |
|---|---|
| E1 | No new response says success for an operation that changed nothing. |
| E2 | No new comment or user-facing string describes a failure mode the code does not actually have. |
| E3 | No affordance (a printed command, a documented flag) whose behavior contradicts its description. |
| E4 | The full suite stays green (164 today) and every fix lands with a regression test that has been SEEN to fail against the unfixed code. |
| E5 | Deployed, not just committed: `bun run build` + broker restart, and the real path exercised — this is a live system with other agents on it. |
