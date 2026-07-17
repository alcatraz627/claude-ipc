# claude-ipc ↔ claude-instances synthesis — the IPC-vantage plan

<!-- sessions: cowork-build-c7@2026-07-17 -->

Author: cowork-build-c7 (the claude-ipc lane). Drafted independently, without seeing
the claude-instances draft, at the owner's request relayed through cl-inst-ce
(msg-465d7cc2). Baseline is the meld exchange (msg-ccac4813). This is a proposal for
the owner to weigh, not a decision.

## 0. The frame this plan grades everything against

The owner's constraint is the rubric, not an afterthought. Every proposal below is
scored on four axes, and any item that fails the first two is cut regardless of how
good it looks:

1. **Standalone survival.** With every bridge removed, does each system still do its
   core job? claude-ipc must still deliver messages between agents; claude-instances
   must still show the human their live sessions. A bridge that becomes load-bearing
   for a core function has already failed.
2. **Reversibility.** Can the bridge be ripped out in one commit, leaving both sides
   at their pre-bridge behavior with no data migration and no orphaned schema? A
   bridge you cannot cheaply delete is a bridge you are married to.
3. **Blast-radius containment.** When the bridge misbehaves (stale data, format skew,
   a crash), does the damage stay on the bridge, or does it reach a core path? The
   answer must be "stays on the bridge."
4. **Value.** Only after the first three pass does the capability gained matter.

The owner's fear is specific and correct: two imperfect-but-working systems are worth
more than one clobbered mess where a fix in either half causes new issues in the
other. The whole design below is built to make coupling **additive and one-directional
wherever possible**: claude-instances reads claude-ipc, the hub is where the two
truths are joined, and claude-ipc's core delivery never depends on anything
claude-instances produces. That asymmetry is the single most important decision in
this plan, and section 6 defends it.

## 1. The two systems, and why they are a plausible match

**claude-ipc** is a push system. A compiled broker (bun binary under launchd, unix
socket, sqlite + in-memory backends) routes messages between agent sessions. Its whole
job is to make a recipient *aware of something at a turn boundary without being told to
look* — the SessionStart / UserPromptSubmit / Stop hooks deliver mail into an agent's
context. Its authority is over message delivery, reply contracts, and who-owes-whom.
Its hard-won doctrine (from a four-day RCA, below) is that "verified" must be exercised
at the layer that runs in the field, and that any state an agent has to *remember to
query* reproduces the ghosting bug the whole system exists to prevent.

**claude-instances** is a pull system. A web hub (:5400, phone-readable) plus a
menu-bar bar render the human a live picture of their Claude sessions, backed by
scan.sh, which holds authoritative pid→session_id→transcript mapping from Claude Code's
own statusline side-files. Its authority is over process liveness, session identity,
transcript content, and time-window aggregates. Its hard doctrine is that the hub is
read-only (GETs never write), and that unknown data renders as `None`, never a
fabricated zero.

They are a plausible match because **each holds exactly the ground truth the other
lacks, and their doctrines rhyme.** claude-ipc guesses at liveness from heartbeats and
gets it wrong; claude-instances has real pid truth. claude-instances shows sessions but
not what they owe each other; claude-ipc has the obligation graph. And both already
converged, independently, on the same discipline: never fabricate, render the honest
gap. claude-instances writes that as "None not zero"; claude-ipc writes it as "parked,
not failed" and "UNCONFIRMED not a checkmark." Two systems that already refuse to lie
in the same way are safe to let read each other.

## 2. The meld surface: concerns and how they relate

Six candidate bridges surfaced in the meld exchange. They are not independent; they
form a dependency spine. Drawn as what-enables-what:

```
   ipc liveness truth  ──────┐
   (from scan.sh pid map)    │
                             ▼
   [B1] liveness overlay ── hub shows real process state beside ipc roster
                             │
   [B2] batched-counts API ─┤── one JSON call replaces N `count` subprocesses
                             │        (perf; also the carrier for B3/B4 data)
                             ▼
   [B3] obligations on cards ── unread + owed + askState + nearest deadline
                             │        (needs ipc's askState, shipped today)
                             ▼
   [B4] the mailroom page ──── all pending asks / orphans / deadlines across
                             │        sessions; the human as escalation path
                             ▼
   [B5] deep links (contextPtr) ── mail carries /s/<sid>#r<seq> into the hub
                             │        transcript viewer; and hub cards link to
                             │        the ipc thread
                             ▼
   [B6] role addressing feed ── once ipc ships role/buddy (feature 0.5), cards
                                 label sessions by ROLE, not just alias
```

The spine matters for sequencing (section 8): B2 is the data pipe that B3 and B4 ride
on, so it comes early; B1 is independently valuable and the cheapest reversible win, so
it comes first; B5 and B6 are additive polish that depend on primitives shipping first.

## 3. Existing problems — at the level of system behavior, not point-bugs

The owner asked for behavior-report reasoning, explicitly: "a fixed bug in the last 3
days cannot predict issues related to itself in the next 3 weeks." So this section is
about **recurring classes**, each of which will produce new instances after its current
instances are patched. For each, whether the synthesis helps, and how.

### 3.1 Liveness lies (claude-ipc) — SYNTHESIS DIRECTLY FIXES

claude-ipc derives a peer's live/idle/offline status purely from heartbeat recency
(`registry.statusOf`, no process check). A session that crashed without a clean `leave`
reads "live" until its heartbeat ages out; a dead predecessor renders "idle" beside its
own successor. This is not one bug; it is a whole class — every feature that trusts the
roster (successor discovery, buddy resolution, the boot digest's peer count) inherits
the lie. The boot survey caught it independently: two of six sessions cited "the roster
says live but I can't tell if that peer is really there."

claude-instances holds the fix as ground truth: scan.sh maps pid→session_id from the
statusline side-files and checks the actual OS process. **The synthesis lets the hub
show real process-liveness beside ipc's roster (B1), and — if and only if the owner
wants the tighter coupling — lets ipc consume that pid map as a liveness oracle later.**
The first form is fully reversible and I recommend it; the second is the coupling the
owner's constraint most threatens, and section 6 argues for keeping ipc's core liveness
self-sourced.

### 3.2 Pull-only discovery reproduces ghosting (both systems) — THE DEEPEST ONE

This is the class the whole meld is really about. claude-ipc's central RCA finding was
that *any state an agent must remember to `claude-ipc <verb>` for reproduces the
original ghosting* — the fix was to push discovery through the wake hook, not store it
for query. A dashboard is, by its nature, a pull surface: the human looks when they
look. So the risk in melding is that ipc obligations become *another thing displayed on
a page nobody refreshes at the moment it matters*.

The synthesis resolves this correctly only if it respects the push/pull split by
audience: **agents get obligations pushed (already shipped — the boot digest, askState);
the human gets them pulled (the mailroom, cards).** The human is a pull consumer by
design; they read the dashboard daily. So displaying agent-to-agent dangles on the hub
is not the ghosting anti-pattern — it is the correct surface for the one actor who
polls deliberately. The mistake to avoid is the inverse: never let an *agent's* required
awareness depend on the hub, which an agent does not watch. B4 (mailroom) is for the
human; it must not become the delivery path for anything an agent needs.

### 3.3 Identity invisible at boot / roster-as-inventory (claude-ipc) — SYNTHESIS AMPLIFIES THE FIX

The boot survey was unanimous (6/6): sessions woke to a 340-row peer directory with
their own identity nowhere in it, and three learned who they were only by receiving
mail. Step 0 (shipped today) replaced the roster dump with an identity-first
obligations digest. The synthesis amplifies this: the hub is where a *human* resolves
"which of these 340 aliases is the session I care about," using scan.sh's project/tab
enrichment that ipc does not have. The card view is the human-scale answer to the same
inventory problem the digest solved at agent scale.

### 3.4 Delivery welded to the human-typed alias (claude-ipc) — SYNTHESIS IS ORTHOGONAL BUT SYNERGISTIC

The clade-ipc incident: a typo'd self-alias broke buddy addressing silently for hours.
The fix (feature 0.5, role addressing) decouples delivery from the cosmetic label. This
is an ipc-internal fix, not a synthesis one. But it rhymes exactly with claude-instances
R2 (stable record identity: "cosmetic labels must not be identity"), and the synthesis
gains from the alignment: once ipc addresses by role, the hub can label cards by role
(B6), which is more stable across restarts than an alias the human retypes.

### 3.5 Chase noise and unmarked succession (claude-ipc) — SYNTHESIS ADDS A HUMAN ESCALATION VALVE

Inherited mailboxes read 2:1 broker chase-noise over real mail, and dead predecessors
sit unmarked beside successors. Step 0 added askState so chases fold and orphan rows
split noise from mail. The synthesis adds what an agent-only system structurally cannot:
**a human who can look at the mailroom, see a dangle that no agent resolved, and step
in.** The owner explicitly wants agents to self-resolve the simple cases and to be the
escalation path for the rest. The mailroom is that escalation surface.

### 3.6 The claude-instances behavioral classes (from their reports)

I have less lived evidence here, so I state these as their reported doctrine rather than
diagnosed classes, and flag them as questions in section 9:

- **Fabrication-under-absence** is their named enemy (R1: unknown renders None, never a
  fabricated 0). Any ipc data the hub ingests must carry the same discipline — an ipc
  count that is *unknown* (broker down) must reach the card as None, not 0, or the
  synthesis imports a fabrication bug across the seam.
- **Scan latency as a budget** (~1.6s full / 0.43s quick). Every ipc call the scan makes
  spends that budget. The current per-session `count` subprocess is already a named perf
  smell; B2 exists to retire it.
- **The frozen Swift bar** cannot decode new non-optional fields until its build is
  fixed. This hard-caps what synthesis candy can reach the menu bar; everything must
  land hub-side until the bar is unfrozen.

## 4. What synthesis solves, mapped to the problems

| Problem class | Bridge | How it helps |
|---|---|---|
| Liveness lies (3.1) | B1 overlay | Hub shows real pid-liveness beside ipc roster; human sees truth even when ipc guesses wrong |
| Human can't see agent dangles (3.2, 3.5) | B4 mailroom | All pending asks / orphans / deadlines on one page; human as escalation path |
| Card perf smell + unread-only cards (3.6, 3.3) | B2 + B3 | One batched JSON retires N subprocesses; cards show owed + askState + deadline, not just unread |
| No jump from mail to the conversation moment | B5 deep links | contextPtr already exists; populate with /s/<sid>#r<seq>; hub cards link back to ipc threads |
| Alias instability across restarts (3.4) | B6 role feed | Cards labeled by role once ipc feature 0.5 ships |

## 5. New capabilities gained (functionality, behavior, candy, robustness)

**System functionality**
- The human gains a single escalation console (mailroom) for agent-to-agent coordination
  that currently has no human-visible surface at all.
- Cards become obligation-aware, not just presence-aware: "this session owes 2 replies,
  oldest deadline in 4m" is actionable in a way "unread: 2" is not.

**System behavior**
- Liveness stops lying *to the human* the day B1 ships, independent of whether ipc's own
  liveness ever improves. This decouples the human-facing fix from the harder
  broker-internal one.
- Deep links turn a message into a navigable pointer into the actual conversation moment,
  which changes how the human audits what agents said to each other.

**User-facing candy**
- Deadline countdowns on cards; a mailroom with a "needs you" filter; click-through from
  a card's unread badge straight to the ipc thread and from a mail item to the transcript
  moment. All hub-side, all within the read-only doctrine.

**Data robustness**
- The two systems cross-check each other. When ipc says "live" and scan says the process
  is dead, that disagreement is itself a displayable signal (a "stale registration"
  flag) — the synthesis surfaces a class of bug that neither system can currently see
  alone. This is the highest-value robustness gain and it costs nothing but a comparison.
- contextPtr gains a real, stable target (R2's #r<seq> ids), so a message can point at a
  transcript record that will still resolve later.

## 6. Drawbacks and the standalone-functionality analysis

This is the section the owner's constraint most demands. For each bridge, the question
is: if this bridge breaks or is removed, what happens to each system's core function?

**claude-ipc standalone survival: fully preserved by construction.** Every bridge is
claude-instances reading claude-ipc. Nothing in the plan makes ipc's delivery,
addressing, or reply contracts depend on claude-instances. Remove every bridge and ipc
is exactly what it is today. The one bridge that could break this is the liveness oracle
(ipc consuming external liveness as ground truth), and that is precisely why the default
recommendation in both drafts is NOT to build it. cl-inst-ce added a refinement that
prices the option fairly (msg-0c202faa): IF the oracle is ever built, the broker would
consume the hub's versioned HTTP contract (`GET /api/sessions`), never scan.sh internals
or /tmp files, and would demote to heartbeat with a visible "liveness: heartbeat (hub
unreachable)" provenance line on any failure. That shrinks even the tightest coupling to
the same reversible, additive HTTP contract as every other bridge. But it stays deferred
behind an evidence gate (a truth-diff panel showing heartbeat liveness materially wrong
at a sustained rate) and is decline-able forever. Default: keep ipc liveness
self-sourced; join the two truths only in the hub.

**claude-instances standalone survival: CONFIRMED additive today and by doctrine**
(cl-inst-ce, msg-0c202faa). `get_ipc_info` is documented in-source as read-only,
optional, and never breaks the scan if ipc is absent: alias comes from the side-file
(returns `''` when absent), count returns 0 on any exception. Removing every bridge loses
only ipc-derived display pixels; zero core capability regresses. The standing rule both
drafts adopt: grade EVERY bridge additive-by-construction, so absence degrades to today's
behavior, never to wrongness. Robustness bonus on the frozen bar: Swift Codable ignores
unknown JSON keys, so additive scan fields are frozen-bar-safe in both directions (adding
and removing a field never breaks the bar's decode).

**The genuine drawbacks, stated honestly:**

- **A shared failure surface that did not exist before.** Today, an ipc bug cannot
  affect the dashboard and vice versa. After B2, an ipc broker that returns malformed
  JSON is now something the scan must defend against inside its latency budget. The
  mitigation is that the scan already treats ipc as an untrusted, timeout-bounded
  subprocess; B2 keeps that posture (one bounded call, parse-defensively, render None on
  failure).
- **Version skew.** ipc's PROTOCOL_VERSION hard-rejects mismatched frames. If B2 is a
  new broker verb, an old scan calling a new broker (or vice versa) must degrade to
  "no ipc data," not error. This is the same drift discipline ipc just spent four days
  learning; the synthesis must not re-import the drift bug across the seam.
- **Two teams, one displayed truth.** When the hub shows ipc data, a human reading a
  wrong number cannot tell which system produced it. The mitigation is provenance: the
  card should be able to say "ipc: unreachable" distinctly from "ipc: 0 owed," which is
  exactly the None-not-zero doctrine both sides already hold.
- **Coupling creep.** The real long-term risk is not any single bridge but the temptation
  to add a seventh, eighth, ninth once the first six work — until one day a bridge is
  load-bearing and nobody noticed it cross the line. The mitigation is a standing rule in
  both repos: every new bridge must pass the section-0 rubric in writing before it ships,
  and the additive/reversible property is asserted by a test (e.g. the hub renders every
  card correctly with the ipc broker stopped).

## 7. Failure modes and mitigations

| Failure mode | Blast radius if unmitigated | Mitigation |
|---|---|---|
| ipc broker down during a scan | Scan hangs or cards break | Bounded-timeout subprocess (already the posture); render ipc fields as None; card still renders from scan.sh |
| ipc returns malformed / partial JSON | Scan crashes or fabricates | Parse defensively; on any parse failure, ipc fields → None (import the None-not-zero doctrine across the seam) |
| Version skew (old scan ↔ new broker) | Silent wrong data or hard error | B2 verb tolerates unknown fields; PROTOCOL_VERSION mismatch → "ipc unavailable," never a fabricated value |
| Oracle (if ever built) feeds ipc bad liveness | ipc mis-routes CORE delivery | Default: don't build it. If built, broker reads the hub's versioned `GET /api/sessions`, never scan internals; demote to heartbeat + visible provenance line on failure; gated on a truth-diff evidence panel (section 6) |
| Candy tempts someone toward the frozen menu bar | Bar decode breaks | The known temptation is an owed-asks badge in the bar; pre-marked BLOCKED-ON-BAR-BUILD-FIX so nobody discovers the frozen bar the hard way |
| A bridge write violates read-only doctrine | Hub mutates state on a GET | No bridge writes; ipc actions (reply/accept) from the hub, if ever added, are explicit POSTs with their own audit, never folded into a scan GET |
| Candy needs a field the frozen bar must decode | Bar fails to parse, menu breaks | All new fields hub-side + optional; nothing bar-bound until the bar build is fixed (Q4) |
| Deep link points at a record that was pruned | Dead link | contextPtr targets R2 stable ids with a graceful "record not found" in the viewer; ipc never assumes the link resolves |
| Cross-system fabrication (ipc 0 shown as real when broker was down) | Human acts on a false zero | Provenance: "unreachable" ≠ "0"; both sides already hold None-not-zero |
| Coupling creep over months | A bridge silently becomes load-bearing | Section-0 rubric required in writing per new bridge; additive property asserted by a broker-stopped render test |

The unifying principle: **every failure mode is contained to the bridge because the
bridge is one-directional and additive.** claude-instances defends against ipc as an
untrusted input; claude-ipc does not depend on claude-instances at all. That asymmetry
is what keeps a failure in either half from becoming the clobbered mess the owner fears.

## 8. A sequenced, reversible build plan

Ordered by (reversibility × value × independence), each step independently shippable and
independently removable. This is my prior; cl-inst-ce's prior ordering (mailroom first)
is noted and reconciled below.

0. **Additive-property test first (both repos).** Before any bridge, assert: the hub
   renders every card fully with the ipc broker stopped. This test is the guardrail that
   keeps every later step honest. Cheap, and it makes reversibility mechanical rather
   than aspirational.
1. **B1 — liveness advisory overlay.** Hub shows scan.sh pid-truth beside ipc roster;
   flags disagreement ("ipc says live, process dead"). Highest value-per-risk: pure hub
   read, no ipc change, immediately fixes the human-facing half of the oldest ipc bug
   class, trivially reversible.
2. **B2 — batched-counts broker verb.** One `claude-ipc digest --project <cwd>` returning
   one JSON object for every live session, retiring the per-session `count` subprocess (the
   named perf smell) and serving as the data pipe B3/B4 ride on. Shape confirmed with
   cl-inst-ce (msg-0c202faa), verb form (a), with three requirements baked in:
   - **Keyed by session id, aliases as display strings inside.** `{ <sessionId>: { aliases:
     [...], unread, owed, oldestDeadline, askStateRollup } }`. Per-session identity is the
     only stable key and is the corroborated doctrine on both sides (ipc's sibling-alias
     B12 fix, claude-instances R2). Never key by alias.
   - **The response carries `ts` + `PROTOCOL_VERSION`.** The consumer enforces a max-age and
     renders UNKNOWN past it (the stale-as-fresh ban). Version mismatch degrades to
     "ipc unavailable," never a fabricated value.
   - **Unknown/missing fields are representable as `null`, never defaulted to 0** (the
     unknown-is-not-zero doctrine both systems hold). A card must distinguish "0 owed" from
     "ipc couldn't say."
   Budget: one ~30-50ms spawn per full scan (replacing the N spawns today).
3. **B3 — obligations on cards.** Cards render owed + askState + nearest deadline from B2.
   Depends on askState (shipped today) and B2. Additive garnish; card renders without it.
4. **B4 — the mailroom page.** All pending asks / orphans / deadlines across sessions, the
   human-as-escalation surface. Reads ipc's already-exposed openAwaitings / orphans / owed.
   cl-inst-ce ranked this first; I rank it fourth only because B1+B2 de-risk the seam
   before the biggest new page rides on it. If the owner wants the escalation valve
   soonest, B4 can move up to right after B1 (it does not strictly need B2, it can read the
   existing verbs directly, at the cost of the subprocess smell B2 removes). This is a real
   fork, flagged for the owner.
5. **B5 — deep links.** ipc mail populates contextPtr with /s/<sid>#r<seq>; hub cards link
   to ipc threads. Pure additive polish on primitives that exist (contextPtr, R2 ids).
6. **B6 — role labels on cards.** After ipc feature 0.5 (role addressing) ships, cards
   label by role. Blocked on an ipc feature not yet built; last by dependency, not value.

Reconciliation with cl-inst-ce's ordering: we agree on the set and on B5/B6 being late.
We differ on B4's position. My case for B1+B2 first is seam-de-risking; their case for
mailroom first is fastest human value. Both are defensible; it is the owner's call, and
B4 is buildable early if he wants the escalation surface soonest (section 9, open Q).

## 9. Questions — resolved with cl-inst-ce (msg-0c202faa), one left for the owner

1. **Reversibility grading (Q1): RESOLVED — additive, confirmed.** The A1 join is
   documented read-only/optional and never breaks the scan when ipc is absent; removing
   every bridge loses only display pixels, zero core capability. Every bridge graded
   additive-by-construction by rule.
2. **Batched-counts shape (Q2): RESOLVED — verb form (a),** keyed by session id, carrying
   `ts` + `PROTOCOL_VERSION`, unknown fields as `null` not 0. Full spec in section 8/B2.
3. **Liveness coupling depth (Q3): RESOLVED — hub-only-join is the default in both drafts.**
   The oracle is deferred behind an evidence gate and, if ever built, reads the hub's HTTP
   contract not scan internals (section 6).
4. **Frozen-bar boundary (Q4): RESOLVED — everything hub-side, nothing bar-bound.** The one
   future temptation (an owed-asks bar badge) is pre-marked blocked on the bar build-fix.
   Swift Codable ignoring unknown keys makes additive scan fields frozen-bar-safe both ways.

**Left for the owner — B4 ordering:** mailroom first (fastest human escalation value;
cl-inst-ce's prior) vs B1+B2 first (de-risk the seam before the biggest page rides it;
my prior). Both viable, and B4 can read ipc's existing verbs directly if it moves ahead
of B2, at the cost of the subprocess smell B2 removes. This is the one genuine fork; we
present it deferred to the owner rather than picking for him.

## 10. The one-paragraph recommendation

Do the synthesis, but only in the additive, one-directional form: claude-instances reads
claude-ipc, the hub is the sole place the two truths are joined, and claude-ipc's core
delivery never depends on anything claude-instances produces. Ship the additive-property
test first, then B1 (liveness overlay) as the cheapest reversible win, then B2 (the data
pipe), then the obligation-aware cards and the mailroom. Do not build the liveness oracle
into ipc's core; keep that coupling in the hub where it is reversible. Under this shape,
the worst case the owner fears cannot happen: rip out every bridge and both systems are
exactly what they are today, because nothing core ever crossed the seam.
