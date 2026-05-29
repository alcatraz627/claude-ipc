# 02 · Behavior

> How claude-ipc behaves as observed from the outside — by the human operator and
> by a Claude session. Derived from `01-spec.md`; every behavior traces to a
> requirement (FR/NFR/SC) noted in brackets. Still no implementation detail —
> this is the contract a tester or user can hold the system to.

---

## 1. Behavioral principles

- **B1 — Send is explicit, receive is proactive.** A peer only ever sends to an
  alias a human or agent named; it never picks a target. A peer surfaces
  incoming messages on its own. [G2, G3, NFR1, N4]
- **B2 — Delivered content is inert until acted on deliberately.** An incoming
  `inform`/`query`/`response` is information. An incoming `request` is a
  *proposal* — nothing happens until an explicit accept. [G5, FR6]
- **B3 — Nothing is silently lost or silently failed.** Every acknowledged send
  has a queryable lifecycle; undeliverable messages produce a visible error;
  a downed broker is visible. [G6, G8, NFR3, NFR5]
- **B4 — Acting on a message is just acting.** Once a peer acts on a message, the
  action passes through every normal host check exactly as if the peer had
  decided it alone. [G9, NFR6, SC6]
- **B5 — Degrade, don't break.** With the broker down the system does less, not
  wrong: sends persist, receipts still happen at turn boundaries. [G10, NFR4]

## 2. Message lifecycle (state machine)

Every message moves through observable states. `query`/`request` additionally
spawn a correlated `response` chain.

```
   send
    │
    ▼
 ┌────────┐   routed to live peer    ┌───────────┐  hook/channel  ┌───────────┐
 │ QUEUED │ ───────────────────────▶ │ DELIVERED │ ─────────────▶ │ SURFACED  │
 └────────┘                          └───────────┘                └─────┬─────┘
    │  no live peer / TTL                                                │
    │  (broker synthesizes)                              checked / read  │
    ▼                                                                    ▼
 ┌──────────────────────┐                                       ┌──────────────┐
 │ response{error,       │           inform/response: done       │   CONSUMED   │
 │  no_peer | timeout}   │◀──────────────────────────────────── │ (query/req:  │
 └──────────────────────┘     query/request unanswered past TTL  │  awaiting    │
                                                                  │  response)   │
                                                                  └──────┬───────┘
                              request only:                              │
            ┌─────────────┬──────────────────────────────────┐          │
            ▼             ▼                                    ▼          ▼
        ACCEPTED      DECLINED                            (query) reply emitted
            │      (→ response{error,declined})                  │
            ▼                                                     ▼
     acted on → response{ok|error, terminal:true}         RESPONDED (terminal)
            │  (interim: response{terminal:false} = ack/progress)
            ▼
       RESPONDED (terminal)
```

- `DELIVERED` means a delivery mechanism placed it in front of the recipient;
  `SURFACED` means the recipient's context actually showed it; `CONSUMED` means
  the recipient checked/accepted it. Delivery is **not** consumption — a message
  surfaced by a hook stays actionable until explicitly checked/accepted. [FR3, FR4]

## 3. Registration & liveness

- On session start a peer registers an alias (auto at SessionStart, or by an
  explicit tool/CLI call) with optional capability tags and its cwd. [FR1]
- A peer emits liveness periodically; a peer whose liveness is stale beyond a
  threshold is reported `idle`, and beyond a longer threshold `offline`. [FR9]
- `peers` / `ipc_list` returns each live peer's alias, cwd, last-seen, and
  status. Re-registering the same alias from a new session rebinds it (last
  writer wins) and the prior binding is reported as replaced. [FR9]
- On clean exit a peer emits `control:leave`; on unclean exit, liveness staleness
  is the fallback signal. [FR1]

## 4. Send behavior (by kind)

- `inform` — accepted, persisted, routed; no response is expected; broadcast
  (`*`) fans out to all live peers and to the queue of any matching offline
  alias. [FR2]
- `query` — persisted, routed; the sender's message enters `awaiting response`;
  a `corr_id` is returned for tracking. [FR2, FR5]
- `request` — same as query, but flagged as requiring consent; the sender is told
  it is awaiting accept + result. [FR2, FR6]
- Any send to an unknown/never-registered alias is accepted and queued only if
  the alias is *known but offline*; a send to a wholly unknown alias returns
  `response{error,no_peer}` immediately (with the live peer list). [FR7, SC2]
- Every send returns a message id and lands in the durable log before the call
  reports success. [G6, NFR3]

## 5. Receive behavior (the ladder)

The recipient surfaces pending messages at the earliest opportunity for its
state, per the spec's delivery ladder [§10, FR3]:

- **Running with a push channel:** messages surface proactively while the session
  is otherwise idle.
- **Running without a push channel:** messages surface at the next turn boundary
  (the next time the recipient takes a turn).
- **Offline:** messages are held and surface on next start/resume (§8).
- **On demand:** the recipient (or human) can pull pending messages at any time.

Surfacing is **idempotent**: a given message is injected into context at most
once by the proactive/turn-boundary path; pulling on demand may re-show it until
it is consumed. [FR3, FR4, NFR2]

## 6. Consent behavior (request → action)

```
 request arrives ─▶ surfaced as PROPOSAL (clearly marked, not an instruction)
                       │
        ┌──────────────┼───────────────┐
        ▼              ▼                ▼
     accept         decline          ignore
        │              │                │ (no action; sender sees timeout
        ▼              ▼                │  → response{error,timeout} after TTL)
  interim ack      response{error,
  (optional)        declined}
        │
        ▼
   peer performs the work — every action goes through normal host checks
        │
        ▼
   response{ok|error, terminal:true} with the result
```

- A proposal never auto-runs; absent an accept, nothing happens. [B2, G5, FR6]
- The recipient may send a non-terminal `response` ("accepted, running") before
  the terminal result. [FR5]
- If the work the recipient attempts trips a host guardrail, the guardrail wins;
  the recipient reports the outcome as a `response` (likely `error,internal`),
  and the broker/IPC never overrides the guard. [B4, SC6]

## 7. Reply, correlation & sustained threads

- A `response` is always correlated to its origin by `corr_id`; the sender sees
  it attached to the original message, not as an orphan. [FR5]
- A multi-message exchange shares a `conversation_id`. Each incoming message
  folds into the recipient's own accumulating context, so follow-ups are
  context-aware on each side **without** restating prior turns. [G4]
- There is **no shared context window**: each peer retains only what arrived in
  its own session. Bulk context is referenced by pointer (sender's transcript
  path/cwd), not copied. [N5, FR13]
- Two interaction styles are observable:
  - **fire-and-continue** (default): the sender keeps working; the reply arrives
    later via the ladder.
  - **await** (opt-in): the sender blocks until the reply or a timeout. [G4]

## 8. Offline queueing & resume replay

- A message addressed to a known-but-offline alias is held. [G7, FR8]
- When that alias's session next starts or resumes, the backlog is replayed and
  surfaced in order at session start. [FR8, SC3]
- Replay is bounded by TTL: messages older than their TTL are expired to
  `response{error,timeout}` rather than delivered stale. [FR7]

## 9. Error behaviors

| Situation | Observable result |
|-----------|-------------------|
| Send to unknown alias | immediate `response{error,no_peer}` + live-peer list |
| Query/request unanswered past TTL | `response{error,timeout}` to sender |
| Recipient declines a request | `response{error,declined}` to sender |
| Recipient's action fails a guardrail / errors | `response{error,internal}` with detail |
| Broker unavailable | degraded mode (§10); a status surface shows it is down |

## 10. Degraded behavior (broker down) [G10, NFR4, SC5]

- **Sends** still persist to the durable log directly; they are routed when the
  broker returns.
- **Receipts** still occur at turn boundaries by reading the durable log.
- **Lost while down:** proactive push and active error-synthesis (timeouts are
  evaluated on broker return).
- The downed broker is reported by the status command and the monitor; it does
  not present as "no messages." On broker return, queued work resumes and no
  acknowledged message is lost.

## 11. What the human sees (CLI & monitor) [FR12, NFR5]

- A `claude-ipc` CLI offers, independent of any session:
  - `send --to <alias> --kind <k> "<body>"` — inject a message (e.g. as the human)
  - `inbox [<alias>]` — pending messages for an alias
  - `peers` — live peers + status
  - `log [--peer <a>] [--since <t>]` — message history
  - `accept <msg-id>` / `decline <msg-id>` — approve/refuse a pending action
  - `tail` — live message-flow monitor
  - `daemon status|start|stop` — broker control
- The monitor shows message flow and peer liveness at a glance, so the human can
  observe handoffs without reading each session.

## 12. What a Claude session sees

- Incoming messages appear in the session's context as a clearly-marked
  system reminder, e.g.:
  - `⟨IPC · query from backend (msg-7f3a): "…"; reply with ipc_reply(...)⟩`
  - `⟨IPC · ACTION REQUEST from auto-fe (msg-9b2c): "…"; PROPOSAL — will not run
    unless you ipc_accept it⟩`
- The session has tools to register, send, check, reply, accept/decline, cancel,
  and list peers. The exact tool surface is defined in `04-…`.

## 13. Worked scenarios

**Scenario A — UC1 query→response (proactive receipt):**
```
── Shell 1 · backend ─────────────────────────────────────────────────────
 you ▸ ask frontend what base URL it calls the API on
 backend ▸ ipc_send(to="frontend", kind="query",
                    body="What base URL does the frontend call the API on?")
           ✓ msg-7f3a · awaiting response

── Shell 2 · frontend (mid other work) ───────────────────────────────────
   ⟨IPC · query from backend (msg-7f3a): "What base URL …?"⟩
 frontend ▸ ipc_reply(corr_id="msg-7f3a",
                      body="http://api.localhost:3000 dev, /api prod")

── Shell 1 · backend ─────────────────────────────────────────────────────
   ⟨IPC · response from frontend (re msg-7f3a): "http://api.localhost:3000 …"⟩
 backend ▸ Got it — frontend uses http://api.localhost:3000 in dev.
```

**Scenario B — UC3 request→consent→result, privilege handoff:**
```
── Shell 1 · auto-fe (restricted mode) ───────────────────────────────────
 you ▸ have "privileged" run the destructive migration reset on the test DB
 auto-fe ▸ ipc_send(to="privileged", kind="request",
                    body="Run `make db-reset` on the TEST db, report result")
           ✓ msg-9b2c · awaiting accept + result

── Shell 2 · privileged (broad permissions) ──────────────────────────────
   ⟨IPC · ACTION REQUEST from auto-fe (msg-9b2c): "Run `make db-reset` …"
     PROPOSAL — will not run unless you ipc_accept it.⟩
 privileged ▸ ipc_accept("msg-9b2c")
              ipc_reply(corr_id="msg-9b2c", terminal=false, body="accepted")
              (runs make db-reset → passes host guardrails → succeeds)
              ipc_reply(corr_id="msg-9b2c", body="test db reset · ok")
```

**Scenario C — error, no peer:**
```
 backend ▸ ipc_send(to="mobile", kind="query", body="build status?")
   ⟨IPC · response{error,no_peer}: no live peer "mobile" (online: frontend,
     privileged)⟩
 backend ▸ There's no "mobile" session online — only frontend and privileged.
```

## 14. Dogfooding behavior [SC7]

From the phase where send + proactive receive work, the project is built using
itself: the session building claude-ipc registers an alias and exchanges real
handoffs with sibling sessions (e.g. a test session reporting failures back to
the build session). Dogfooding findings feed back into the roadmap.

## 15. Acceptance mapping

Each success criterion in the spec maps to observable behavior here:
SC1→§13-A/§5, SC2→§6/§9, SC3→§8, SC4→§11(`log`)/§2, SC5→§10, SC6→§6/B4,
SC7→§14. These are the behaviors the test suite must demonstrate.
