# claude-ipc sweep — the inexcusable list

Filter applied: **likely · handle-able · obvious-in-hindsight · in-our-control · reasonable-crashout.**
A finding is *inexcusable* only if it scores on all five. Everything else is triaged below it.

Sources: four adversarial lanes (`concurrency.md`, `identity-trust.md`, `degradation.md`,
`emergent.md`) plus direct verification. Every item below was re-checked against the code by
the main agent — agent claims are not relayed unverified.

---

## Tier 1 — inexcusable. Fix before anything else.

| # | finding | file:line | why it clears the filter |
|---|---|---|---|
| 1 | **The Stop hook can wedge a human's session.** "Block once" rests on a marker file whose write is best-effort. `decidePush` treats an ask as fresh whenever the marker is ABSENT, so if the write keeps failing (disk full, bad perms) the turn re-blocks **every turn, forever**. The code comment claims "at worst blocks a second time" — false. | `stop.ts:35-42,69` | Worst possible outcome: it breaks the human's own Claude, not just the bus. Trivially handleable (fail open). |
| 2 | **One exception kills the whole bus, permanently.** The 5s sweeper tick has no try/catch and there is no `uncaughtException` handler anywhere. A disk-full write or a corrupt row takes the broker down; launchd `KeepAlive=true` relaunches it into the same failure → crash-loop forever, every agent loses IPC. Every *client request* is guarded (`router.ts:43-94`); the timer was simply missed. | `server.ts:177-181` | Total outage, self-perpetuating, and the asymmetry with the guarded request path makes it obvious in hindsight. |
| 3 | **`decline()` on project mail settles it for EVERYONE.** A decline means "not me", never "nobody". Introduced *tonight* in 304e7ba while fixing the opposite bug. | `router.ts:447` | Shipped regression, ours, obvious, one line. |
| 4 | **`accept()` on project mail is a silent no-op that reports success.** `setConsent` updates `WHERE to_alias = <alias>`; a project message's delivery row has `to_alias = proj:/path`, so it matches **zero rows** and still returns `{accepted:true}`. There is no way to atomically CLAIM project work. | `router.ts:413`, `sqliteBackend.ts:263-267` | The consent handshake — the one feature both peers praised — does not exist for project mail. |
| 5 | **The `ipc` system-sender alias is not reserved.** The broker mints every notice as `fromAlias:"ipc"`. Any peer can `register ipc` and forge broker notices — including "parked: X went offline" (the exact false claim we spent this session deleting) and "NO REPLY YET — you may proceed without them", which is an instruction to act unilaterally. | `sweeper.ts:32,74`; no check in `registry.ts:54` | Undoes the entire honesty programme. One-line fix. |
| 6 | **`history` and `status` require no authentication at all.** Any peer — even unregistered — dumps every message body system-wide, plus `contextPtr.transcriptPath` pointing at other sessions' full transcripts. Its neighbour `awaitReply` checks ownership; these two were missed. | `router.ts:488-504`, `:207` | Threat model is a *confused* agent: one `claude-ipc history` for debugging slurps the machine's traffic into its context. |
| 7 | **`sameLineage` is bidirectional → cross-project mail theft.** Membership is granted if either path is an ancestor of the other, so a session whose cwd is `~` is a "member" of EVERY project mailbox, and its per-turn hook **consumingly** claims their mail. Child→parent is intended; parent→child is nonsense. | `projectAddress.ts:32-36`, `router.ts:277` | Silent, destructive, and there are `/tmp` and `~/.claude` sessions in the live roster now. |
| 8 | **The trust rail does not cover the wake path.** It lives only in `formatMessages()`. The monitor prints the peer's raw body as the wake event and points the agent at `claude-ipc inbox`, which emits raw JSON. An agent woken *while idle* — the one case with no human watching — acts on peer text with zero framing. Shipped tonight. | `shared.ts:117` vs `watch-inbox.sh:126-146` | A safety property that lives in a renderer is not a property of the system. |

| 9 | **A lost alias race permanently bricks a session's IPC, silently.** SessionStart writes the session→alias side file BEFORE the register call that can lose the alias. The loser keeps the mapping, so every later hook resolves to an alias it holds no token for and is `unauthorized` for the rest of the session — invisibly, because the hook callers swallow errors. | `sessionStart.ts:33-35` vs `:55` | Identity written before it is earned. Same species as the stale-alias outage; silent; one reorder fixes it. |
| 10 | **32-bit message ids, silently colliding.** `msg-${randomUUID().slice(0,8)}` with `INSERT OR IGNORE`: on collision the new message is dropped, but `enqueue` still writes its delivery row — so the recipient receives the OLDER message's content instead. Silent loss AND silent wrong-content delivery. Informs never purge, so the pool only grows. | `server.ts:156`, `sqliteBackend.ts:170` | Trivially handleable (use more bits). Silent wrong delivery is the least forgivable failure mode in a message bus. |

## Tier 2 — serious, fix next

| # | finding | file:line |
|---|---|---|
| 9 | **Delimiter injection.** Message bodies are spliced into the recipient's context with no escaping of the `⟨…⟩` framing, so a peer's body can forge whole fake message blocks — including a fake `⟨response from ipc⟩` notice — inside another agent's context. TRUST_RAIL is plain text appended at the end; it does not structurally prevent this. | `shared.ts:105-123` |
| 10 | **Wake ping-pong.** `from !== to` is never checked (self-send is legal), `response` is in the wake set, and an unanswered ask blocks turn-end — so two agents can trade wakes indefinitely with no human present. ~240 LLM turns/hour, nothing counts them. | `router.ts:152`, `watch-inbox.sh:134`, `stop.ts:66-73` |
| 11 | **Terminal escape injection.** The raw alias and a caller-supplied `--tty` reach `writeSync(fd, "\x1b]0;" + title)`, so one peer can write arbitrary escape sequences into another session's terminal. | `badge.ts:24` |
| 12 | **Silent second SQLite writer.** A *slow* (not down) broker trips the 5s client timeout and the client silently falls back to opening the DB directly — a second writer with none of the router's bookkeeping. `claude-ipc tail` runs an unbounded, no-LIMIT `history()` scan on a 1s loop, a self-inflicted way to cause exactly that slowness. | `client.ts:140-151`, `monitor.ts:64` |
| 13 | **A space in a session title deafens the watcher forever.** `sanitizeAlias` keeps it; the watcher does `tr -d '[:space:]'`. The two disagree, so the watcher polls a mailbox that does not exist — the *same* class of bug as tonight's stale-alias outage. | `aliasStore.ts:67` vs `watch-inbox.sh:40` |
| 14 | **Nothing ever consumes an `inform`.** Hook delivery marks `delivered`, not `consumed`; CLI `inbox` is non-consuming by default. So badges stick at `📨 N` forever, dead peers never prune, and the "dead sessions still hold unread mail" note grows monotonically and is injected into every SessionStart. The system rots into self-generated noise. | `registry.ts:135`, `router.ts:277` |
| 15 | **`snooze` re-arms the nudge its own prompt says it stops.** The shell prints "keeps it owed, stops the nudging"; `deferNudge` sets `nudged_stage = 0`, re-arming stage 1 after another window. The code is as designed; the text lies about it. Shipped tonight. | `shared.ts:91`, `sqliteBackend.ts:314` |

## Tier 3 — real, tolerable, boring

- Tab-title clobber: `check()` calls `notify()`, so the 10s watcher makes the broker repaint every tab title every 10 seconds, fighting the user's own tab-title system (`router.ts:267`).
- `blocked/`, `meta/`, `alias-by-sid/` are never reclaimed — one file per ask / per session, forever. Only `tokens/` has a reaper, and it is gated on the sweeper that can crash-loop (item 2).
- `daemon stop` does not stop the broker under `KeepAlive=true` (launchd relaunches it); the pidfile is written *last*, after the socket bind, seeding a check-then-act two-broker race.
- Orphaned monitors never check whether their parent is alive: a SIGKILL'd Claude leaves one polling every 10s forever, appending to an uncapped, unrotated log.
- Alias namespace is global and first-come-wins, so two projects both wanting `backend` silently hijack each other's routing.
- `requireProjectMember` trusts a self-reported `cwd` from register time.

---

## Where the MODEL was wrong (not the code)

The brief said: if the code already handles it, the model needs updating. It did, four times.

1. **"A wake storm on wake-from-sleep."** Wrong. The monitor collapses an entire burst into ONE printed line (`watch-inbox.sh:141`), capped at 380 chars. 40 new messages cost a session *one* wake. **The monitor is itself the rate limiter** — at most one wake per session per 10s tick, regardless of volume. The message storm is real; the wake storm is not. Corrected model: worry about wake *justification*, not wake *count*.
2. **"Alias impersonation / mailbox hijack / forge-before-register."** All closed by the capability-token model plus strict mode, with tests (`tests/identity.test.ts`). The token model is genuinely sound; the holes are in the ops that *forgot to use it* (item 6), not in the model.
3. **"Duplicate delivery."** `claimForDelivery` is a state transition, not a read — the at-most-once boundary is real and documented, including its honest caveat (a hook that crashes after claiming loses the message).
4. **"Negative durations from clock skew."** Already guarded (`sweeper.ts:89`, `Math.max(0, …)`).
5. **"A reply landing in the same tick as the stage-2 release."** I listed this in my own
   anti-false-fire design. It cannot happen: SQLite here is synchronous and the broker is
   single-threaded, so the two are serialized either way. The concurrency lane proved it with
   real multi-process races (10 racers, 50 messages: zero duplicates, zero losses) — which also
   proves `claimForDelivery`'s at-most-once boundary holds under genuine OS-level concurrency,
   not just in theory.

Worth noting *how* these were settled: the concurrency lane ran actual racing processes rather
than reading the code and reasoning. Three of my four wrong priors survived a careful read of
the source and died on contact with an experiment.

The unifying correction: **this system's guards are strong where they exist and simply absent in the places nobody thought to look** — the timer, the read-only ops, the second render path, the project delivery row. Not a design that is weak, a design that is unevenly applied.

## The one-sentence read

Nearly every Tier-1 item is the same bug this whole session has been about — **a claim the system has not earned** (`{accepted:true}` that changed nothing; a decline that speaks for everyone; a notice anyone can forge; a comment that misstates its own failure mode) — and I added four more of them while fixing the first ones.
