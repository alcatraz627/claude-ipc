# claude-ipc — consolidated issue list (dash-audit-09, 2026-07-16)

Sources: vb-fable msg-38592c5f (dead-address report), msg-882c4b81 (liveness
timeline), msg-39fdfad6 (formal silent-flag filing), the zero-byte specimen
msg-37e5aa80; vb-opus COMMS REPORT msg-9c76998b (recovered from ipc-dr-4e's
orphan box); yesterday's digested feedback (msg-6284c2ec catch-fable-7c,
msg-f3318baa vb-opus — see 20260715-vb-feedback/findings.md); owner mid-turn
feedback; live finds this session. Fresh pings sent: vb-fable answered
(folded in), vb-opus pending (msg-fd170964, 15m reply-by).

## A. Confirmed bugs — FIXED on feat/i-dashboard (nothing deployed)

| # | Issue | Diagnosis (basic) | Fix |
|---|---|---|---|
| A1 | `send --body` sent zero-byte messages, exit 0, success JSON — vb lanes ran blind ~2h | body is positional; `--body` was allowlisted for a hint that was only ever implemented in `reply` | 005d35f CLI guard |
| A2 | Dashboard keys went dead under key-repeat / fast typing | tokenizer coalesces runs into one multi-char event; dispatcher matched single chars; React batches collapsed closure updates | b059c77 |
| A3 | Identity picker unusable at ~140 aliases; read-only was a dead end | unwindowed list; no re-entry key | b059c77 |
| A4 | main was typecheck-red (`humanAge` unimported in sessionStart) | prior batch shipped without `tsc` run | fff79e7 |

## B. Confirmed bugs — OPEN

| # | Issue | Diagnosis (basic) | Source |
|---|---|---|---|
| B1 | Broker accepts empty bodies from ANY client (MCP, degraded, old binaries) | router `send` has `body: a.body ?? ""`; only `reply` has an empty refusal | audit §14; A1's sibling |
| B2 | Liveness flaps: active sessions read offline; live-list returned EMPTY to a session actively calling the broker (repeated, ~11:05 and ~12:40) | `lastSeen` refreshes only on register/heartbeat (hook-driven); no ordinary broker op (send/check/peers) counts as liveness, so long agent turns decay to offline. vb-fable's client-side JSON rules out filter error | msg-882c4b81 |
| B3 | Dead-address sends indistinguishable from success — asks to 8h-dead `catch-fable-7c` expired unanswered → blind shared-index collision | by-design "mail waits for offline aliases", but the sender gets zero signal that the recipient is dead/aged | msg-38592c5f |
| B4 | Replies to dead askers rot invisibly (the two "missing" feedback replies sat in ipc-dr-4e's box) | replies route to the asker's mailbox; register-time orphan surfacing capped at top-5 buried it in "+13 more" | this session |
| B5 | `log --operator` (large output) emits truncated/invalid JSON at ~72KB | `process.exit(code)` races async stdout drain (cli.ts tail); big outputs cut mid-string | found live this turn |
| B6 | ~~Orphan-box accounting anomaly: 4 sent to ipc-dr-4e, only 1 pending~~ **RESOLVED (not a bug)**: delivery states show 3 of 4 were `consumed` by the ipc-dr-4e session while alive (their content was digested into 20260715-vb-feedback/findings.md); only the post-death COMMS REPORT stayed pending. Accounting is correct | this session (probe of msg-f3318baa et al.) |
| B7 | A3 successor-surfacing may not fire for checkpoint-resumed sessions ("I did NOT see it fire; it needed my hand" — vb-opus) | unverified — resume path may skip the SessionStart register that triggers it | msg-f3318baa |
| B8 | Duplicate roster rows: one sessionId, sibling aliases with different pids (62504 + 72600) | per-alias rows each keep registration-time pid; reads as two processes | msg-882c4b81 |

| B9 | `reply` to an inform is refused (`not_an_ask`) — vb-opus composed a full two-part answer to vb-fable's inform (msg-c0f6706f) and hit the wall; the suggested `send` workaround drops the corrId thread linkage | deliberate refusal (router `reply` → `originOf` only matches asks) added for legibility, but it blocks a natural agent motion: threading a response onto an inform. **OWNER RULING 2026-07-16: allow it.** Replying to a non-ask should work — deliver the correlated response, inherit the conversation, consume the origin for the replier; the only difference is sender-side vigilance: an inform has no awaiting, so no reply-owed tracking, no nudges, no timeout (which falls out naturally — informs never open an awaiting). Empty-body guard still applies | owner, live specimen from vb-opus |

| B10 | **Multi-alias watcher blindness (CONFIRMED LIVE 07-16 ~15:15)**: a session's inbox watcher follows ONE alias — vb-fable's watcher log reads "watching mailboxes: catch-ipc-9e" while two fresh asks sat `queued`/undelivered in its vb-fable box for 6-8m (msg-7a5028a7, msg-a3600ea5), session alive-but-idle 28m | the watcher's alias-follow tracks a single mailbox (the side-file holds one alias; renames/multi-alias leave the other boxes unwatched) → no wake → no turn → no delivery. Same family as the 07-14 wake-path fix, one level up. Mitigated live by a wake-around inform to the watched box | this session, live |

| B12 | **Party-scoping ignores sibling aliases (found in post-deploy round-trip, i-dream 2026-07-16)**: `show`/`status`/`history` blank the body as `[hidden — not a party]` for a message addressed to a SIBLING alias of the caller's session. i-dream (session holds catch-audit-7f + i-dream-7f66b053) was the addressee of a message to i-dream-7f66b053, consumed it, yet `show` hid the body because `resolveSelfAlias()` returned the other sibling | `router.ts` `involves()` checks `m.fromAlias/toAlias === self` for the ONE resolved alias; it should match ANY alias of the caller's session (same sibling-aware fix as the wave-2 obligation/liveness work). Pre-existing in history/status; the new `show` verb made it visible | this session, live verification |

## C. Paper cuts / UX (agent-reported)

- C1 No single-message `show <id>` — agents jq-filter the whole inbox (msg-9c76998b).
- C2 `inbox --project` omits alias-addressed pending mail for aliases the session holds — startup poll missed an owed request (msg-9c76998b).
- C3 No proactive "what do I owe" view; first visibility of a pending ask was the turn-END nudge, a full turn late (msg-9c76998b).
- C4 Orphan mail older than the lane's last checkpoint can resurrect overruled directives — wants a staleness flag relative to checkpoint/handshake (msg-6284c2ec). **Dispositioned 07-16: deferred to #8 successor-adoption design** (needs lane-checkpoint awareness the broker lacks).
- C5 Orphan surfacing ages into noise (20-unread boxes from 3 lanes ago) (msg-6284c2ec). **Dispositioned 07-16: deferred to #8** (the orphan-aging half of successor adoption).
- C6 Fail-loud argument contracts as a class: "agents pattern-match flags from sibling tools; a silent accept converts one bad guess into hours of invisible failure" — audit every allowlisted-but-unread flag (msg-39fdfad6).

## D. Owner feature queue (tasks, not bugs)

- #7 priority-mode asks (short TTL, louder nudges, receiver still decides)
- #8 ghosting handling — B2/B3/B4 + vb-fable's four asks are its design list:
  dead-letter distinguishability on send · successor alias adoption + forwarding
  at register · nudge/last-call escalation to project mailbox or successor ·
  liveness from signals sessions actually emit
- #9 /ipc skill (message/reply/re-nudge + feedback + proposal filing)
- #10 dashboard: gcc V3 convention (D10) + adversarial review gate
- #11 .jsonl fallback mailbox pair (proposal + implementation spec)

## vb-opus reply (msg-b510d678, landed after first cut) — corroborates + extends

- Corroborates B3 (dead-address: names the two lost hold-requests and the blind
  shared-index collision that followed), B2 (liveness: empty live-list, live
  peer shown offline), C1 (`show <id>`), C3 (owed-reply not surfaced until the
  turn-end hook; startup `inbox --project` missed an owed alias-addressed ask).
- Extends #7: they independently filed a gcc proposal for a `--priority/--urgent`
  flag that wakes + pins — merge with the owner's priority-mode task.
- Their item 2 ("body-drop when a multi-alias session sends without `--from`;
  explicit `--from` sends intact") was TESTED and FALSIFIED this session:
  a 2-alias session sending positionally without `--from` delivered a 32-byte
  body intact on a scratch broker. The correlation was confounded — the empty
  sends were the `--body` invocations (vb-fable's filing admits ~10 over 2h,
  matching the 5 empties vb-opus received). One mechanism (A1), not two.
- Their stated workaround, again: handshake by sessionId, never alias — "both
  lanes independently hit the dead-alias trap today."

## Ping status

- vb-fable: answered both pings within minutes (round-trip healthy post-fix).
- vb-opus: answered ping msg-fd170964 with the full report above; ask closed.

## Incidental find while collecting

- Failed pty-walk scripts leaked two scratch brokers (`bun run src/cli.ts
  serve` survived a setup-abort exit path). Killed; live dist/ broker
  untouched. Walk scripts should trap-kill their broker on every exit path.
