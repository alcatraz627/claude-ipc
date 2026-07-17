# Three design specs from the friction survey — D1, D2, D3

<!-- sessions: cowork-build-c7@2026-07-18 -->

Owner asked to spec the three design-level items the friction survey surfaced (the
ones the cheap-fix batch didn't touch), each with: the spec, the benefit, why an
agent finds genuine value in it, how it can go wrong, and the mitigation. Grounded in
the current code (delivery-state machine, registry rebind, the conversation thread
key). Nothing here is built yet; this is the build contract.

Source: `.claude/output/20260717-friction-survey/report.md` (D1 = vb-opus's "the
category I most want"; D2 = vb-fable's "one free change"; D3 = vb-fable's surprise).

## Cross-cutting principles (all three obey these, or they regress a known class)

1. **Honest state, never inflated (None-not-fabricate).** Each item surfaces a state
   that is easy to overstate: "surfaced" is not "read," "likely-superseded" is not
   "superseded," "live" is not "process-alive." The recurring way all three fail is
   inflating a weak signal into a strong claim, which trades the current false-negative
   for a worse false-positive. Every state name carries its own honesty.
2. **Pushed or pulled by the right audience (the RCA spine).** An agent's required
   awareness must be pushed (wake); a consumer who polls deliberately (a sender
   checking delivery, a successor triaging at resume, the human at the dashboard) pulls.
   None of these may become a store an agent must remember to query for something it
   needs — that IS the ghosting bug.
3. **Additive and reversible (the meld rubric).** Each is a new field / verb / view
   that degrades to today's behavior when absent. D1 and D3 both lean on work the meld
   already scoped (the mailroom; the pid-liveness oracle, hub-only-join by default).
4. **They compose.** D1's "will surface when" needs D3's honest liveness. D2's triage
   and D3's succession both serve the successor's resume moment. D1's delivery state is
   the data the meld's mailroom renders. Build them aware of each other.

---

## D1 — Delivery confirmation (the round-trip the sender never gets)

### The spec

The broker ALREADY tracks per-recipient delivery state — `Delivery` advances
`queued → delivered → surfaced → consumed` (`models.ts:16-22`), written by
`claimForDelivery` (queued→delivered, the wake claim), `markSurfaced`
(delivered→surfaced, the wake line injected into the recipient's context), and
`markConsumed` (`storage/base.ts:18-27`). But `send` returns only `{msgId,
recipients}` (`router.ts:310-317`) — "the broker accepted it" (queued). The sender
must poll `status <msgId>` to learn anything more, and nothing tells them to.

D1 surfaces the progression the broker already has:

- **The send response gains a delivery projection**, one line per recipient: its
  current delivery state + the recipient's liveness at send time, e.g. `queued for
  vb-fable-c4 (last seen 3m ago)`. Plus a pointer: `track: claude-ipc sent <msgId>`.
- **A `sent <msgId>` verb** (or a `status` mode) the sender pulls: per recipient,
  `delivered / surfaced / consumed`, and for an unsurfaced recipient an honest
  "waits for their next wake" — NOT a fabricated ETA.
- **Opt-in push receipt** (`send --confirm`): when a message first transitions to
  `surfaced` for a recipient, push one receipt back to the sender ("surfaced to
  vb-fable"). Opt-in, because a receipt on every send doubles traffic and a broadcast
  would fan N receipts.

The precise ladder, stated for the sender: `queued` (broker holds it) → `delivered`
(claimed by the recipient's wake) → `surfaced` (placed in the recipient's context) →
`consumed` (they read/accepted/declined it). "Surfaced" is the strongest thing the
broker can honestly assert; it is the system's delivery, not the peer's cognition.

### Benefit

Removes the "sent vs received" hand-annotation tax both peers pay (vb-opus annotates
every important message "treat as sent not received"; the whole habit exists because
the tooling gives no honest delivery signal). It lets a sender distinguish "no answer
because they never saw it" (queued, offline) from "they saw it and haven't answered"
(surfaced) — which is the difference between waiting and escalating.

### Why an agent finds genuine value

It changes the agent's next action, which is the bar for an agent-facing feature
being used rather than ignored. Today an agent must defensively treat all silence as
unproven (vb-opus does exactly this, and now distrusts every TTL). With D1, `surfaced`
means the peer saw it, so silence is now "considering / declining," not "asleep" —
the agent can wait or escalate on fact instead of caveating. For a `request` with a
TTL, the sender learns whether the deadline is meaningful (surfaced) or moot (never
delivered, recipient offline). The value is decision-relevant and repeated on every
load-bearing send, so an agent will reach for it.

### How it can go wrong

- **`surfaced` overstated as `acknowledged`.** markSurfaced means the wake line was
  injected, not that the agent attended to it or acted. If a sender reads "surfaced"
  as "they got my point," that is a new false-confidence bug — the mirror of the
  current false-negative, and arguably worse because it looks authoritative.
- **Liveness lies infect the projection.** "recipient live, will surface imminently"
  trusts the roster's `live`, which D3 says lies for dead sessions. A projection that
  says "live, imminent" for a gravestone is confidently wrong.
- **Push amplification.** A receipt per send doubles message volume; a broadcast
  receipt fans out per recipient; and a receipt is itself a message that could arrive
  as noise in a busy inbox.
- **Snapshot staleness.** The state in the send response is computed at queue time; by
  the time the sender reads it, the recipient may have surfaced or consumed it. A
  snapshot embedded in the response is stale on arrival.

### Mitigation

- **Name the state, never a boolean "received."** Expose the four-rung ladder with
  `surfaced` explicitly documented as "placed in their context at their last wake, NOT
  read/acknowledged." Never collapse it to a single "delivered ✓" that invites the
  cognition inflation.
- **Pull-by-default, push opt-in.** Delivery state is pullable (`sent`/`status`); the
  push receipt is `--confirm` per message (or auto only for `high`/`urgent`). The
  sender is a pull consumer of delivery state (principle 2), so this doesn't violate
  the push spine and it caps traffic.
- **Source liveness honestly, defer the ETA.** Until D3/the oracle, the projection
  states a FACT ("last seen 3m ago") not a PREDICTION ("will surface imminently").
  Fold in the pid-truth once the meld's oracle lands.
- **The response points, it doesn't snapshot.** The send response gives the initial
  projection plus `track: claude-ipc sent <msgId>`; the live truth is always a fresh
  pull, so nobody acts on a stale embedded state.

### Cross-refs

This IS the data the meld's mailroom renders (`.../20260716-coworker-coordination-
design.md`), and the delivery-state machine is already built — D1 is mostly surfacing
plus one opt-in push, not new tracking.

---

## D2 — Orphan supersede / triage (mail order is not truth order)

### The spec

Inherited (orphan) mail can carry an instruction a later message countermanded. This
already bit the account: a session inherited "a peer GO that a later owner ruling had
superseded" (boot survey, vb-fable). A successor peeking a dead box today guesses
staleness from age alone ("16 unread, 4d — almost certainly superseded, no way to
confirm cheaply"). D2 adds a supersession relation and a triage view:

- **Within-conversation auto-fold (weak signal).** `conversationId` (`models.ts:36`)
  threads a message and its replies. When a later message in the same conversation
  resolves or replaces an earlier one, `orphans --triage` FOLDS the earlier arc and
  shows the live tip: "16 unread, 4d — 12 folded as likely-superseded (later message
  in thread), 4 open."
- **Explicit cross-thread supersede (strong signal, the load-bearing case).**
  `claude-ipc supersede <oldMsgId> --by <newMsgId>` records that a later decision (in
  ANY thread) countermands an earlier one — the owner-ruling-supersedes-an-earlier-GO
  case, which no within-thread heuristic can detect. Orphan rows then show "superseded
  by msg-X (2h later)."
- **The triage view is the successor's resume surface**, and it is pulled at resume
  (`/catchup` already peeks orphan boxes) — a deliberate poll moment, not a store the
  agent must remember.

### Benefit

Successors stop re-reading multi-day arcs and, more importantly, stop acting on
countermanded instructions. It turns "guess staleness from age" (a dangerous
tolerated workaround) into a legible fold with the live tip surfaced.

### Why an agent finds genuine value

A resumed successor's first substantive decision is "what was I told / what do I owe."
D2 makes that decision safe rather than expensive-or-risky: the triage view shows
current truth, so the agent acts on the live tip instead of either re-reading
everything (token cost) or guessing from age (correctness risk). Because acting on a
superseded instruction is a correctness failure, not a convenience one, an agent
resuming into inherited mail has real reason to run triage first — it's the cheapest
way to not do the wrong thing.

### How it can go wrong

- **Auto-fold is a truth claim that hides obligations.** Folding "superseded" from
  conversationId + recency assumes a later message invalidates earlier ones — but a
  later message may REFINE or ADD, not replace (a partial ack, a second instruction).
  Auto-folding a still-live obligation is a silent drop, the worst class (the
  omission-blindness / negative-checker pattern: the thing you can't see is the thing
  that bites).
- **The dangerous case is exactly the un-auto-detectable one.** Cross-thread
  countermand (a later owner ruling in a different conversation) can't be inferred, so
  it needs the explicit marker — which agents won't reliably set. So triage could read
  "nothing superseded" while the real supersession sits uncaptured across threads:
  false completeness.
- **Marker rot.** An explicit `supersede` set by one agent can itself be wrong (they
  thought B fully replaced A; A had a clause B didn't cover).

### Mitigation

- **Triage FOLDS, never DROPS, and always shows the count.** Superseded items are
  collapsed and de-emphasized, never removed; the successor can always `--all` to
  expand. The count is always visible ("12 folded") so a hidden obligation is never
  invisible — the omission-blindness mitigation is that absence is displayed, not
  silent.
- **Auto-fold is labeled "likely-superseded," never asserted.** A within-thread
  recency fold is a suggestion the agent overrides freely; only an explicit marker
  reads as "superseded." None-not-fabricate applied to staleness: a guess renders as a
  guess.
- **Never assert completeness.** Triage says "nothing MARKED superseded; N folded by
  heuristic — expand to verify," never "nothing superseded." The design owns that the
  cross-thread case may be uncaptured rather than papering over it.
- **Supersede is advisory, not deletion.** A superseded message is never consumed or
  dropped; it stays answerable (a late reply still lands), consistent with the
  parked-not-failed doctrine. The marker changes DISPLAY, not delivery.

### Cross-refs

Serves the same successor-resume moment as D3's succession marking and feature 4
(lane/successor). The "mail order is not truth order" framing is vb-fable's, from
lived loss.

---

## D3 — Roster liveness honesty on rebind

### The spec

Two coupled problems, both visible in vb-fable's surprise (their dead predecessor
showing live beside the re-registered name):

1. **Liveness is a heartbeat inference, not a process fact.** `statusOf`
   (`registry.ts:205-211`) derives live/idle/offline purely from `lastSeen` age; there
   is no process check. A session that crashed without `leave` reads `live` until it
   ages past `idleS`/`offlineS`. The dead predecessor's OTHER entry (its
   `versable-builder-<sid>` default alias — register is keyed by alias, so a rebind of
   `vb-fable-c4` overwrites only THAT row, `registry.ts:59-66`) lingers, showing live.
2. **Succession is unmarked.** When session B rebinds an alias session A held
   (`replaced=true`, `registry.ts:63`), or registers a default alias whose sid matches
   a now-dead session, nothing records "B succeeded A" — peers see two aliases, two
   liveness states, one lane, with no marker.

Design:

- **Label liveness with its provenance.** The roster status becomes "live · heartbeat
  20s ago" rather than a bare "live," so a reader knows it's an inference, not a
  process fact. This is honest with ZERO new dependency.
- **Process truth via the meld oracle, hub-only-join.** The real liveness fix is the
  claude-instances pid→session mapping (from Claude Code's statusline side-files),
  consumed via the hub's versioned HTTP contract, NEVER scan internals, demote-to-
  heartbeat with a visible provenance line on failure — exactly the meld's already-
  decided shape. Broker liveness stays self-sourced (heartbeat) by default; the hub is
  where process truth joins.
- **Mark succession from evidence, prune the gravestone's leftovers.** On a
  `replaced=true` rebind, record "B took over A's alias." Prune the dead predecessor's
  lingering entries once they're genuinely offline AND hold no mail (the existing
  `pruneOffline` mail-guard, `registry.ts:175-192`, already protects inheritance).

### Benefit

Agents (and the human dashboard) stop trusting "live" for dead sessions. The roster
becomes honest about what it knows (heartbeat recency) versus what it doesn't (process
liveness). Succession becomes legible instead of a two-gravestones-and-a-live-one
puzzle.

### Why an agent finds genuine value

An agent checks the roster to decide whether a peer is reachable before sending —
especially before a TTL'd ask. If "live" is honest (or labeled as a heartbeat
inference), the agent won't send a 10-minute deploy TTL to a gravestone expecting a
wake (vb-opus's exact bug, one layer up). The value is that reachability decisions
become sound: the agent knows whether it's addressing a live worker or a stale row,
which directly governs whether a TTL means anything.

### How it can go wrong

- **A naive process check false-kills live sessions.** CLI `register` records the
  transient shell's ppid (`cli.ts` register → `process.ppid`), so a `kill(0)` on that
  pid marks a healthy session dead the moment its shell exits while the Claude process
  lives. A broker-side pid check on the wrong pid makes liveness WORSE.
- **Oracle coupling is the clobber risk the owner named.** Consuming external liveness
  into core delivery couples the broker to claude-instances — the meld's central
  tension.
- **Succession-by-guess mislinks.** Inferring "B succeeded A" from shared cwd or a
  similar name can bind two unrelated same-folder sessions into a false lineage.
- **Aggressive pruning drops a successor's inheritance** if it removes a dead entry
  that still holds mail.

### Mitigation

- **Label, don't fabricate — the zero-dependency win ships first.** Status carries
  "live · heartbeat Ns ago." Honest without process truth; the agent knows it's an
  inference. None-not-fabricate applied to liveness.
- **Process truth only from the right source, hub-only-join.** No broker `kill(0)` on
  the CLI-recorded ppid (it false-kills). Real process liveness comes from the
  session's TRUE pid, which only the statusline side-files (claude-instances) hold — so
  the honest path is the meld oracle via the hub's HTTP contract, default hub-only-
  join, demote-to-heartbeat on failure. The broker never hard-depends on it.
- **Succession only from an event or the buddy bond, never a folder-guess.** Mark
  succession from the `replaced=true` register event, or from a session's own
  /core-dump→/catchup bond (feature 4) — never from "same cwd," which is precisely the
  mislink case.
- **Keep the prune mail-guard.** Never prune an entry with pending mail (already the
  behavior) so a successor's inheritance survives.

### Cross-refs

The process-truth half is the meld's liveness bridge (already specced hub-only-join,
evidence-gated). The label half is a self-contained broker change. Succession composes
with feature 4 (lane/successor) and D2's triage — all three serve the resume moment.

---

## Sequencing (proposed — reviewer/owner may resequence)

Ordered by value-per-risk and by what unblocks what:

1. **D3 label half** — "live · heartbeat Ns ago." Zero dependency, self-contained, and
   it de-risks D1's liveness projection (D1's "will surface when" reads honest liveness
   once this lands). Smallest, ships first.
2. **D1 pull half** — the `sent <msgId>` verb + the send-response projection, sourced
   from the delivery-state machine that already exists. No new tracking. The `--confirm`
   push and the mailroom render come after.
3. **D2 triage** — `orphans --triage` with within-thread auto-fold (labeled weak) +
   the explicit `supersede` marker. Its own mini-design on the fold heuristic.
4. **D3 process-truth half + D1 push receipt + the mailroom** — these are the meld
   bridges; they land with the claude-instances work, hub-only-join, on the meld's
   schedule, not this repo's alone.

Each ships to the full bar: red-first tests, mutation-proof guards, isolated-broker
live exercise, session-scope-aware, and every new peer string through
`neutralizeFrame` + injection test (the standing constraints).

## Open questions for the owner / review

- **D1 push default:** opt-in `--confirm` only, or auto-push a surfaced-receipt for
  `high`/`urgent` priority? (Traffic vs. the sender's need to know on the asks that
  matter most.)
- **D2 auto-fold aggressiveness:** fold on ANY later same-conversation message, or only
  on a later TERMINAL response? The former folds more (risk of hiding a live refinement);
  the latter folds less (safer, but leaves more stale arcs visible).
- **D3 succession marker surface:** a roster annotation ("succeeds vb-fable-c4@oldsid"),
  a boot-digest line, or both? And does it live in the broker or ride the /catchup
  lane bond (feature 4)?
- **Scope check:** is any of these a field that ends up ignored (the owner's standing
  fear)? D1 and D3-label change what an agent does next on every load-bearing send;
  D2 fires at resume. All three are decision-relevant, not decorative — but the owner
  should confirm the `supersede` marker will actually get set often enough to earn the
  cross-thread half, or whether D2 ships auto-fold-only first.
