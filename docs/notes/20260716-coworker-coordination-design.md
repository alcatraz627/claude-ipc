# claude-ipc — the coworker-coordination layer (design spec)

Status: **DESIGNED 2026-07-16, owner-decided; pre-implementation skeptical-review pending.**
Scope: the fields + mechanisms that turn ipc from message-passing into arbitrary-org
coworker coordination — urgency, topic, request-type, successor contact, same-folder
work scoping. This doc is the build contract; nothing here is coded yet.

Grounding: the message model today (`src/models.ts`) has `kind`, `conversationId`,
`corrId`, `status/errorCode/terminal`, `contextPtr`, `ttlS`; `Awaiting` has `replyByS`,
`nudgedStage`. Everything below is additive and nullable — old binaries and un-set
fields behave exactly as today.

---

## 1. Priority (urgency) — the #7 lane

**Owner decisions:** optional; default `normal`.

- New field on `Message`: `priority: "fyi" | "normal" | "high" | "urgent"` (nullable →
  treated as `normal`). CLI `--priority` / `-p`; MCP `priority` field.
- **Policy, keyed off priority (over the existing `replyByS`, not a new deadline field):**
  | priority | default reply-by | nudge cadence | wake/badge |
  |---|---|---|---|
  | fyi | none (no chase) | none | normal |
  | normal | 5m (current default) | current (5m + grace) | normal |
  | high | 2m | ~90s | brighter badge |
  | urgent | 90s | ~60s, escalating tone | distinct badge, pinned |
  An explicit `--reply-by` always overrides the priority default.
- **`urgent` is the #7 behavior, and it COMPETES for attention, never preempts** (owner
  ruling, carried from the earlier task): louder + faster nudges, a distinct tab-badge,
  shorter TTL — but NEVER auto-replies and NEVER halts the receiver's current task. The
  receiver still decides. "Attention sway, even back-and-forth" is acceptable; forced
  reply is not.
- Cross-ref: vb-opus independently filed a gcc proposal for a `--priority/--urgent` flag —
  merge that expectation here.

## 2. Topic — sustained-subject slug

**Owner decisions:** optional; may be OFF-task (not just work subjects); must NOT (a) end
up an ignored field, nor (b) be the reason an agent mis-types an arg and has to retry.
The misspelling/discovery worry is the core design constraint.

**Design that resolves both worries — hex-anchored canonical topics:**

- A topic has a **canonical id** `<hex3>-<slug>`, e.g. `a3f-auth-refactor`. The `hex3` is
  minted by the broker the first time a topic is seen; the slug is the human label.
- **Send with `--topic <anything>`:** the broker normalizes (lowercase, kebab) and
  **exact-matches** against existing canonical slugs. Match → reuse that canonical id.
  No match → mint `<newhex>-<slug>`. The send RESPONSE always echoes the canonical id
  (`topic: a3f-auth-refactor (existing)` / `(new)`), so the agent copies the canonical
  form forward. This is the "prompt them to reuse" mechanism — non-blocking, informational.
- **Filter by EITHER the hex or the slug:** `claude-ipc log --topic a3f` (drift-proof —
  matches regardless of slug misspelling) or `--topic auth-refactor` (human). The hex is
  the insurance the owner asked for: even if a later agent writes `auth-refctor`, as long
  as they carry the `a3f-` prefix the channel filters together.
- **Never a retry:** ANY topic string is accepted and normalized; an unknown topic is a
  NEW topic, never an error. Topic is inert metadata — it can't fail a send.
- **Discovery / sharing (>2 agents):** `claude-ipc topics` lists canonical ids +
  last-activity + participant count, so an agent joining "ipc bug report collection" finds
  and reuses `bf2-ipc-bug-reports` instead of inventing a near-duplicate. A send can also
  name a topic explicitly to pull others in.
- Reply/send inherits the topic like `conversationId` does (a reply carries the origin's
  topic unless overridden).
- **Orthogonal to `conversationId`** — DO NOT overload it. conversationId = one
  ask-and-its-replies (machine grain, drives correlation/await/nudge). topic = a sustained
  subject across many threads (human grain, drives filter/recall/continuity). A message
  can carry both.
- New field on `Message`: `topic: string | null` (the canonical id). Storage: a `topics`
  table (canonical id, slug, hex, created ts, last-activity) OR derive from message rows —
  reviewer to weigh (a table gives cheap `topics` listing + participant counts; deriving
  avoids a new table but is O(scan)).

## 3. Request type (`kind`) — add `other`

**Owner decisions:** add an `other` fallback kind; audit the `other`-classified log to
harvest new enum values over time.

- `Kind` gains `other`. `SENDABLE = inform | query | request | other` (`response` stays
  internal, minted by reply).
- **An UNRECOGNIZED `--kind <label>` maps to `other`** instead of erroring, preserving the
  raw label for audit (new nullable `kindLabel: string | null`, set only when the caller's
  kind wasn't a known enum). Today an unknown kind is a hard `bad_args`; this converts a
  dead-end into a harvest signal.
- `other` gets no ask machinery (like `inform`): no awaiting, no nudge — it's an
  unclassifiable note until we learn what it should be.
- Harvest: `claude-ipc log --kind other` (or a periodic review) surfaces the `kindLabel`
  values agents reached for → candidates for new first-class kinds.
- Default for an un-`--kind`'d send stays `inform` (unchanged) — `other` is a deliberate
  choice or the unknown-label fallback, not the silent default.

## 4. Successor contact — lane addressing + core-dump/catchup integration

**Owner decisions:** LOVE IT; make lanes known in `/core-dump` and `/catchup` too.

- **Lane address `lane:<cwd>`** — a message addressed to a directory's *current live
  worker*, not a fixed alias. The broker resolves `lane:/path` to the live session whose
  cwd is `/path` (exact match; if several, most-recent `lastSeen`). None live → queue to
  the most-recent prior session's mailbox, which the successor sees as predecessor/orphan
  mail (already built). This is the principled fix for the dead-address ghosting from the
  RCA: message the ROLE-IN-A-PLACE, the broker finds the live holder.
- **`claude-ipc successor <cwd|alias>`** (or folded into `peers`): "who is the current lane
  for this cwd / who succeeded this dead alias?" → the live session sharing that cwd.
- **`/core-dump` integration:** the checkpoint records the session's lane identity
  (`lane: <cwd> held as <alias>, sessionId <sid>`) in its Resume Contract, so a successor
  knows what lane it is inheriting.
- **`/catchup` integration:** on resume, surface "you are resuming the lane for <cwd>;
  predecessor <alias> (dead), N unread — peek: claude-ipc inbox <alias>" and register the
  lane. This makes the successor handoff a first-class part of the resume flow rather than
  something an agent stumbles into via orphan mail.
- Reviewer: lane resolution across the project TREE vs EXACT cwd (a repo-root session vs a
  subdir session) — exact cwd is the safe default; within-tree is a broader, riskier match.

## 5. Same-folder coordination — work claims

**Owner decisions:** YES; the live pain is agents in the SAME folder (esp. ~/.claude / gcc)
leaving uncommitted changes or editing under each other's noses. Explicitly NOT the
workspace feature — this is same-exact-folder, ambient.

- **`claude-ipc claim "<resource>" [--note "..."]`** — an agent announces it's working on a
  resource (a file `router.ts`, `the git index`, `uncommitted changes in src/`). Recorded
  as (alias, sessionId, cwd, resource, note, ts) and pushed to same-cwd live peers.
- **`claude-ipc claims [--here]`** — active claims in this cwd (who holds what, how long).
  A session's SessionStart / per-turn hook can surface "2 peers are working here:
  alice holds router.ts, bob holds the git index" so an agent knows before it edits.
- **`claude-ipc release "<resource>"`** — drop a claim; claims also auto-expire (TTL, e.g.
  30m) and release on `leave`, so a dead agent doesn't hold a resource forever (the same
  liveness discipline as the roster).
- **The uncommitted-changes case** the owner named: v1 = an agent explicitly
  `claim`s "uncommitted changes in <dir>" as a courtesy flag. A git-status-aware AUTO
  warning (broker/hook notices dirty tree + another live peer here) is a bigger feature —
  noted as a FUTURE follow-on, not v1.
- Scope: claims are same-EXACT-cwd (the ambient-coworker case), addressed by pushing to
  live peers whose cwd equals mine. Reviewer: is this a new op family, or does it ride the
  existing `send`/`proj:` machinery with a `resource` field + a `claim` kind?

## Data-model summary (all additive, nullable)

`Message` gains: `priority`, `topic` (canonical id), `kindLabel` (raw unknown-kind label),
and `resource` (for claims / resource requests). `Kind` gains `other`. New concepts:
`topics` registry, `claims` registry, `lane:` address resolution. Back-compat: every new
field is nullable and defaults to today's behavior; a stale binary that doesn't send them
is unaffected; the broker treats absent = default.

## Build order (proposed — reviewer may resequence)

1. `priority` + deadline-defaults (smallest, highest value, isolated).
2. `kind: other` + unknown-kind→other + `kindLabel` (small, self-contained).
3. `topic` (hex-anchored) + `topics` verb + `--topic` filter (medium; the storage choice
   is the main decision).
4. `lane:` addressing + `successor` + core-dump/catchup integration (medium; touches the
   skill layer, not just the broker).
5. same-folder `claim`/`claims`/`release` (largest, most novel; its own mini-design within
   this).

Each ships to the full bar: red-first tests, mutation-proof the guards, isolated-broker
live exercise, and NO deploy-drift (build from the deployed branch, verify the live broker
runs the new code — the RCA's lessons).

## Open questions for the skeptical-review (attack these)

- **Topic storage:** dedicated `topics` table vs derive-from-messages — cost of `topics`
  listing + participant counts vs a new migration surface.
- **Topic reuse semantics:** exact-normalized-match-reuses is predictable but two genuinely
  different subjects with the same slug collide onto one hex. Is that acceptable, or does
  reuse need a confirmation? (Owner wants NO retry friction — lean predictable.)
- **`lane:` resolution:** exact cwd vs within-tree; tie-break when two live sessions share a
  cwd (most-recent vs both); what happens to a `lane:` send when NO session is live there
  (queue to whom?).
- **Claims vs the existing machinery:** new op family vs `resource` field on a `claim`
  kind. Auto-expiry interplay with the sweeper.
- **`kindLabel` harvest:** does an unknown-kind→other silently swallow a genuine typo the
  sender wanted flagged? (Weigh against the send-never-fails goal.)
- **Priority + existing nudge/reply-by:** does `urgent`'s 90s deadline collide with the
  parked/release machinery? Does a high-priority broadcast make sense (nudge everyone)?
- **Scope creep check:** is any of this a field that ends up ignored (the owner's explicit
  fear), or does each earn its place? Flag any that won't get used.

---

## Design-review dispositions (2026-07-17, `.claude/output/20260717-0015-coworker-design-review/review.md`)

3 blockers, 8 majors, 1 cross-cutting insight. Two blockers would have re-opened
RCA classes. All folded in below; the reshaped design supersedes the sections above
where they conflict.

**THE CROSS-CUTTING SPINE (reshapes everything).** 4 of 5 features live-or-die on
**push vs pull**: their state must reach the agent at a turn boundary (the wake /
SessionStart / per-turn hook that already delivers mail), not sit in a store the
agent must remember to query. Pull-only discovery IS the RCA's B10 "it needed my
hand," feature-by-feature. So: **every new discovery surface (active topics here,
claims here, successor-lane) is pushed through the hook**, and **B7 (the SessionStart
wiring, still unverified for platform-resume) is closed FIRST** — feature 4/5 build
on that wire, so it must be trustworthy before they land. This is the highest-leverage
decision in the whole design.

**BLOCKER fixes:**
- **B1 — `lane:` dead-case re-opened the dead-address bug.** FIX: `lane:` is a
  *resolution mode* of the existing `proj:<cwd>`, not a third address scheme.
  Live-first (fan out to ALL live sessions in the cwd — see M1), else fall through to
  the durable `proj:<cwd>` mailbox that waits for any future session. NEVER queue to a
  specific dead alias's box. This also avoids threading a new scheme through
  isProjectAddress/notActable/stripForCaller.
- **B2 — topic derive-from-messages dies under `purge()`.** FIX: a `topics` table is
  REQUIRED (the canonical id + hex must survive message retention). No migration fear —
  the backend uses `CREATE TABLE IF NOT EXISTS` + idempotent `ADD COLUMN` at boot; the
  real work is the parallel `memoryBackend.ts` impl + the participant-count query.
- **B3 — priority TTL/reply-by race silently kills the urgent chase.** FIX: priority
  drives `replyByS` + nudge cadence/copy ONLY. It does NOT touch TTL. **Invariant
  written into the design: an ask's TTL is never shorter than its reply-by deadline**
  (else tickSweeper parks the ask before the urgent escalation fires).

**MAJOR fixes (folded in):**
- **M1 — `lane:` vs claims contradiction:** a cwd has N workers, not one. `lane:` fans
  out to all live sessions in the cwd (reuse the project-notify loop), consistent with
  claims. Resolves into B1's proj:-mode fix.
- **M2 — `kindLabel` is peer-controlled and hits the `⟨…⟩` frame:** route it through
  `neutralizeFrame()` (the 3e5ed62 hardening) + add it to the injection test. Any new
  peer string reaching a rendered frame gets the same.
- **M3 — hex oversold as misspelling insurance (matches the owner's own worry):** be
  HONEST — hex is a stable *filter handle*, not typo insurance. It protects reuse (you
  already hold `a3f-…`), NOT first-join (typo the slug on first send → new hex). Real
  first-join dedup = exact-normalized-match + **pushed** "active topics here" at wake.
  AND: hex is a **broker-allocated unique key** (next free 3-hex), not a slug hash —
  else birthday math makes 4096 really ~64 before a collision cross-links two channels.
- **M4 — claims auto-expiry is a TTL over externally-mutated liveness (the
  `cache-externally-mutated-state` antipattern):** DROP the TTL. A claim is valid iff
  its `sessionId` is live at READ time (reuse `claimStillHeld`/`stillOwedBy`). "Release
  on leave" then falls out free; no fourth sweeper job.
- **M5 — nudge cadence the state machine can't deliver:** the sweeper's nudge is a fixed
  two-shot (stage 1 NUDGE → stage 2 LAST CALL + park). `urgent` = SAME two-shot with
  tighter deadlines + louder copy + distinct badge (honest, cheap). Do NOT promise
  "repeated escalating every 60s" — the count model can't express it without a new
  Awaiting field + sweeper branch (deferred unless the owner wants it).
- **M6 — back-compat is a DECISION, not an assertion (OWNER CALL — see below).**
- **M7 — argv layer is where the RCA bled:** every new flag (`--priority`, `--topic`,
  `--resource`) + every new verb (`topics`/`claim`/`claims`/`release`/`successor`) ships
  with the allowlist-integrity test (now exists) + a CLI-entry golden test + BOTH
  backends. No flag lands allowlisted-but-unread.
- **M8 — priority on inform/broadcast is cosmetic** (no awaiting opened): scope
  priority's chase contract to directed query/request; on inform/broadcast it's
  badge-only, documented as such (or rejected). Don't let the cosmetic half be the
  ignored surface.

**MINOR:** participant-count + `claims --here` dedupe by **sessionId**, not alias
(B8/B12 sibling class) — reuse `sessionAliases`. `kind:other` default-stays-inform is
correct, don't "simplify" it away.

## Concern 6 — Addressing / identity integrity (owner-surfaced 2026-07-17, AGENT-CORROBORATED)

**The owner's recurring pain is delivery-to-the-right-agent, which none of features 1-5
targets.** Root cause of the 2026-07-17 clade-ipc incident: identity/addressing is
unguarded free-text — a session registered a typo self-alias (`clade-ipc`, edit-distance
1 from `claude-ipc`), a peer addressed it by that typo, and the broker delivered blindly.
Today's deployed sibling-alias fixes are the only reason mail wasn't lost (it reached
vb-opus's sibling box), but the confusion cost a human escalation.

**Independent corroboration — vb-fable's own bug report (msg-f81d41c8) + msg-3fc14f99,
from lived pain, asked for exactly this:**
- register WARNS on an alias within edit-distance 1 of an existing agent or the CLI name
  (`clade-ipc` vs `claude-ipc`) — catch the typo at birth, not an hour later.
- inbox defaults to ALL of a session's aliases / **deliver per SESSION, aliases as routing
  keys** (the per-alias mailbox fragmentation was the incident: 13 msgs to `clade-ipc` sat
  unread while the holder polled `vb-opus`; reply-by chases fired into the unwatched box).
- send WARNS when a live session's target alias has gone unread N minutes (delivery-health
  signal — sends succeeded, the watched inbox looked empty, no failure on either side).
- surface per-SESSION liveness on `peers` (broker liveness "lies" on aliases bound to dead
  sessions; the lanes handshake by sessionId as a workaround).

**REFRAMED by owner's workflow (2026-07-17) — the did-you-mean guardrails treat the
symptom; the disease is that DELIVERY IS WELDED TO THE HUMAN-TYPED ALIAS.** Owner's actual
workflow: two FIXED-ROLE agents (main=fable, assistant=opus) that persist their buddy
state via /core-dump + /catchup across restarts; after catchup the owner /renames them to
vb-opus/vb-fable *so they can address each other*. Owner: "I don't care what their ipc id
is, AS LONG AS they can find each other." The /rename-to-a-shared-string IS the addressing
mechanism today — and it's the failure point: a typo (clade-ipc) or a missed rename breaks
delivery, and the statusline `ipc:` label shifts the burden of a valid delivery name onto
the human.

**The fix is DECOUPLING, not guardrails:**
- **Human label ≠ delivery address.** The vb-opus/vb-fable name becomes COSMETIC
  (statusline glanceability only). A typo there no longer breaks delivery.
- **Delivery runs on ROLE-IN-PLACE**, which is what's actually stable in the workflow
  (fixed roles + fixed project cwd). Make role first-class:
  - a session registers its ROLE in its project: `register --role fable` (or role rides
    identity). cwd + role = a stable lane that re-resolves after ANY restart.
  - buddies address each other by role, NOT alias: `--to role:opus` resolves within my
    project to the current live opus-role session. No human-typed string in the delivery
    path.
- **The bond persists via the workflow they already run:** /core-dump records "my buddy =
  role:opus in <cwd>"; /catchup re-registers my role + re-resolves my buddy. The pair
  re-find each other AUTOMATICALLY on restart — the owner's manual /rename becomes
  optional cosmetic, not load-bearing.
- Folds into Concern 4 (lane:/successor): `lane:<cwd>` = everyone here; `role:<name>@<cwd>`
  = the specific role here. Same place-anchored resolution, both degrade to `proj:<cwd>`.
- Keep the small guardrails as belt (register edit-distance warn; per-session inbox +
  liveness — the sibling-watcher fix already leans this way) but they are NO LONGER the
  answer; the role/buddy decoupling is.

**This is the owner's actual recurring pain — recommend it as feature 0.5, ahead of
priority/topic. Pending owner: confirm the role/buddy-decouple model, then re-rank.**

### Concern-6 CONFIRMED (owner verdicts 2026-07-17) — the two negotiated protocols

Owner's cross-cutting intent, verbatim spirit: *equip the agents with tools and
instructions to TRY to resolve identity/continuity themselves via ipc conversation
for the simple cases* — mechanisms deliver the signal, the instructions, and the
exact commands; agents negotiate the outcome; the human is the escalation path, not
the resolver. Every protocol below is written to that shape.

**Displacement protocol (D2).** When session B registers a role live session A holds,
B wins immediately (delivery re-points; refusing would havoc the common retire+rearm
case). The broker then pushes a STRONG nudge to A carrying both shift ids and
self-triage instructions:
- *If you are retiring* (expected takeover — you typically just ran /core-dump):
  ignore this and end quietly.
- *If you are NOT retiring*: notify your ipc peers of the old→new shift ids, choosing
  either (i) **deference** — announce B as your replacement and stop holding the
  role, or (ii) **continuity negotiation** — establish two-way id knowledge with B
  (talk to it, decide who holds the role, re-register accordingly).
The nudge includes the exact commands for both branches so A acts without digging.

**Dead-address discovery protocol (D4).** A send to an address whose holder is dead
never fails silently and never dead-ends: the message queues durably to `proj:<cwd>`,
AND the sender gets a structured notice: target is dead; continuity may be held by
another session — discover it via ipc (typical continuity keys: project dir, session
name, alias; `peers` / `successor <cwd>`), and **ask the candidate to VERIFY it
inherits this thread** before treating it as the successor. Verification matters:
a same-dir session is a candidate, not automatically the heir.

## Boot-experience survey (2026-07-17) — 6 live sessions, unanimous

Full data: `.claude/output/20260717-boot-survey/survey.md`. The owner restarted all
sessions; every live peer was surveyed on its ipc boot experience. Convergence was
total and it binds the build:

- **Step 0's wake digest has an acceptance spec now** (all 6 asked for the same line,
  unprompted): `You are <alias> (sid). Buddy: <alias> (live at Z). Predecessor:
  <alias> (dead); N await you, K carry an open reply contract: <ids> — reply with:
  <exact command>.` Identity first, obligations second, inventory NEVER (roster goes
  behind an on-demand verb). Push what an agent OWES, not who exists.
- **Concern 6 is systemic, not just the owner's pain**: identity is invisible to its
  own holder (all 6); succession is unmarked (dead predecessor renders "idle"/"live"
  beside its successor — triage-map-89, vb-fable); the checkpointed alias chain goes
  stale AND wrong (vb-fable was corrected toward the TYPO alias). Live role/bond
  re-resolution at catchup fixes all three.
- **Pre-feature fixes harvested** (system bugs, build before/alongside step 0):
  (a) corrId=null on reply-expecting messages is a live-proven trap → non-null corrId
  or per-query reply command in inbox; (b) expired chases must decay visibly;
  (c) roster liveness honesty for dead sessions; (d) send help-text still advertises
  `--body` which the parser rejects; (e) fold nudge/LAST-CALL chases under their
  parent message in inbox/orphan views; (f) inbox defaults to all-my-aliases
  (per-session); (g) orphan lines carry an ownership hint; (h) the project-name
  default alias collides with the CLI name by construction.
- **Feature-5 evidence, live**: two same-cwd sessions were independently dispatched
  at the same file by the same machine-wide style finding during the survey itself;
  defused only by a manual "what are you working on" PS. Claims make this ambient.
- **Feature-4 evidence**: every predecessor-mail discovery happened via /catchup's
  ritual, never via ipc — successor/lane must become a broker fact, not a skill
  courtesy.

## Step 0 — built vs deferred (2026-07-17, session cowork-build-c7)

**Gate: PASS-WITH-NOTES** (opus adversarial validator, worktree) —
`.claude/output/20260717-step0-gate/findings.md`. No blockers; all four new guards
mutation-pinned (all four mutations went red). Two MAJORs (unsanitized-alias newline
injection; forgeable `--from ipc` broker signature) + two MINORs (boot-marker blast
radius; marker TOCTOU) all FIXED in commit 797d131, both MAJORs live-smoked through
the CLI. Final: 384/384 tests, tsc clean, at 797d131 (NOT deployed).

**Built** (branch feat/i-dashboard, a30b162..797d131):
identity-first boot digest + obligations with exact reply commands + roster demoted
to a count (survey spec, verbatim); UPS full-digest fallback closing B7 by design;
bare `inbox` = whole-session sweep with broadcast dedupe; per-query `replyWith`
stamps (corrId-null trap); askState on chase notices + chases split in orphan rows
and all renderers; register warns on Damerau-1 confusable aliases incl. the CLI
name; honest flag errors; `CLAUDE_IPC_ALIAS` honored at both identity boundaries.

**Deferred, with reasons:**
- *Process-truth liveness* (dead session renders live/idle until lastSeen ages):
  CLI registers record the transient shell's ppid, so a kill-probe would false-kill
  healthy sessions. Real fix = the claude-instances pid→session oracle (meld
  exploration, msg-ccac4813). Boot-level harm is already reduced: the digest
  replaced the status-chip roster.
- *Orphan ownership hints* ("is this dead box MY lane?") → feature 4 (successor),
  where lane identity makes the question answerable instead of heuristic.
- *Buddy line in the digest* → feature 0.5 (role/buddy) — the digest's identity
  block gains `Buddy: role:<r> (live at <alias>)` when roles exist.

## Owner decisions this review surfaced

> **Decided 2026-07-17 (owner, via cowork-build-c7):** #1 = (a) DON'T bump. #2 = re-rank
> CONFIRMED (0 push-spine+B7 → 0.5 role/buddy → 1 priority → 2 kind:other → 3 topic →
> 4 lane → 5 claims). #3 rides the #2 confirm (push-first spine accepted); flag if that
> reading is wrong.
>
> **Concern-6 + build-scope verdicts (owner, 2026-07-17, decision page `concern6-model`):
> ALL six recommendations accepted (D1a–D6a).** D1: role/buddy-decouple CONFIRMED as
> feature 0.5, one role per session v1. D2: latest-register-wins + displacement protocol
> (below). D3: bond carries explicit @cwd. D4: dead-buddy degrades to proj: for v1 +
> sender-side discovery prompt (below). D5: free-text roles + pushed roles-here +
> unknown degrades to proj:. D6: the 8 survey-harvested fixes FOLD INTO STEP 0.
> This is the build go.

1. **Back-compat (M6):** `PROTOCOL_VERSION` hard-rejects on mismatch. Two options:
   (a) DON'T bump — old CLIs keep working, but a new-CLI-vs-old-broker drift window
   silently drops the new fields (the "ignored field" fear wearing version-skew);
   (b) BUMP — a mismatch breaks loudly for ALL traffic, not just new-feature traffic.
   **My recommendation: (a) don't bump.** New fields are additive and only meaningful
   on a redeployed broker; we control deploy as one unit and just fixed drift + added
   the tsc/gate build discipline, so the drift window is short and controlled. New
   *ops* already fail loud (`bad_op`). Confirm or override.
2. **The push-first spine + B7-first ordering:** the review's headline — build the
   hook-surfacing spine first (and close B7's unverified wiring) so the 4 discovery
   features aren't born ignored. This reorders the build: 0) push-surfacing + B7,
   then 1) priority, 2) kind:other, 3) topic (+pushed discovery), 4) lane-as-proj-mode
   + skill integration, 5) claims (+auto-surface). Confirm this reshaping.
3. **The honest topic framing:** hex is a filter handle, NOT the misspelling fix you
   worried about — the real fix is pushing "active topics here" at wake so agents reuse
   the canonical id instead of minting near-duplicates. This matches your own instinct;
   just confirming we solve it via push, not via hex alone.
