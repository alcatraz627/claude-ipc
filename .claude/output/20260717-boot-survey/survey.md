# Boot-experience survey — all live peers, post-restart (2026-07-17)

<!-- sessions: cowork-build-c7@2026-07-17 -->

The owner restarted every session and asked the claude-ipc lane to collect each
peer's lived ipc experience at boot, as design guidance for the coworker-coordination
layer ("some of them feel confused"). Method: one `kind=query` per live SESSION
(deduped by sessionId, not alias — the B12 lesson), reply-by 600s, late-booters
surveyed as they registered (a Monitor watched the roster). 7 sessions asked,
6 answered, 1 (catch-audit-7f) never took the survey — its reply contract parked
after LAST CALL, which is itself a datum on chase efficacy.

Respondents: cl-inst-ce (claude-instances) · gcc-drift-3e (gcc) · claude-ipc-cd426403
and claude-ipc-09e0344f (this repo, same cwd as surveyor) · triage-map-89 (gcc) ·
vb-fable (versable-builder, the buddy-workflow lane).

## The unanimous findings (6/6, independently)

1. **Nobody knew who they were.** Identity is self-assigned and never surfaced:
   every respondent either invented its alias via the register ritual or learned
   its own name from my survey's reply-hint (`--from claude-ipc-cd426403`). Three
   literally discovered their identity by receiving mail.
2. **Boot pushes inventory; agents need obligations.** The 339-peer roster is "a
   directory, not orientation" (triage-map-89); "decoration at that scale"
   (gcc-drift-3e). Nothing distinguishes lane-relevant peers from the other 300+.
   The one boot line everyone acted on was the orphan-mail line — the only
   obligation-shaped signal.
3. **All six asked for the same wake line, unprompted.** Composite spec:
   `You are <alias> (sid). Buddy: <alias> (live at Z). Predecessor: <alias> (dead);
   N messages await you, K carry an open reply contract: <ids> — reply with: <exact command>.`
   Identity + debts + the command. Roster behind an on-demand verb only.

## Per-respondent uniques

| session | sharpest finding |
|---|---|
| cl-inst-ce | Dead obligations should decay visibly: 3d-expired NUDGE/LAST-CALLs still sat "pending"; aliases and raw UUIDs mixed in one list. |
| gcc-drift-3e | Inbox is non-consuming with no seen/handled marker — a fresh boot cannot tell processed mail from new. `terminal:true` on a response "earned its place." The mid-session Monitor wake + Stop-hook unanswered-query reminder was "the single most orienting ipc touch of the whole boot." |
| cd426403 | Own alias never stated at boot; no relevance ranking; orphan mail has no ownership signal ("unclear if any is mine to inherit"). |
| 09e0344f | Same identity gap; couldn't tell if dead project sessions (ipc-doctor, ipc-dev…) were "my past incarnations or unrelated agents." |
| triage-map-89 | **corrId=null trap, live-proven**: query showed `corrId=null` → read as "no thread here" → answered with fresh `send` instead of `reply <msg-id>` → contract dangled until a Stop hook flagged it; then self-corrected with a proper correlated reply. Also: dead predecessor `triage-86` still on the roster as "idle" beside its successor — two aliases for one lane, nothing marks succession. |
| vb-fable | **Concern-6 evidence**: buddy identity took cross-referencing a stale checkpoint ("address vb-opus") against a peer correction that pointed at the TYPO alias ("use clade-ipc"). Predecessor's aliases showed "live" pre-registration ("briefly read as a second me"). Per-alias boxes hid sibling-alias mail until every held alias was enumerated. "Mail order is not truth order": inherited a peer GO that a later owner ruling superseded. |

## Bugs/friction found DURING the survey itself (surveyor's own boot + sends)

- **Help-text contradicts parser**: the unknown-flag error for `send` lists `--body`
  as valid; using `--body` errors "body is positional." (The F1 fix made the swallow
  loud — good — but the help text still advertises the flag. Two respondents still
  BELIEVE --body silently swallows; belief in a fixed bug outlives the fix.)
- **Chase noise 2:1**: the dead box inherited at catchup held 2 real queries under
  4 broker nudges; successors read the nudges first. Fold chases under their parent.
- **CLI-name collision is built in**: the surveyor session auto-held alias
  `claude-ipc` (project-name default) — the same confusable class as clade-ipc.
- **cwd rides the alias, not the session**: gcc-drift-3e's one session shows
  different cwds per alias. "Role-in-place" needs a per-session place definition.
- **Live near-collision, manually defused**: two same-cwd sessions (surveyor +
  cd426403) were independently dispatched at src/tui/widgets/textarea-ops.ts by the
  same machine-wide style-ledger finding; surfaced only because the survey PS asked
  "what are you working on." Feature 5 (claims) would have made this ambient.

## What this changes in the build (fold into the design doc)

1. **The push spine (step 0) now has an acceptance spec**: the wake digest IS the
   composite line above — identity first, obligations second, inventory never.
   Survey unanimity = the spine's payload requirements, not just plumbing.
2. **Concern 6 upgraded from owner-pain to systemic**: identity is invisible even
   to its own holder; succession is unmarked on the roster; the alias chain in
   checkpoints goes stale AND wrong (vb-fable). Role/buddy decoupling + live
   re-resolution at catchup is the fix for all three.
3. **New fixes-list items (system bugs, pre-feature)**: (a) corrId non-null on any
   reply-expecting message OR inbox prints the per-query reply command; (b) expired
   chases decay visibly (parked ≠ pending); (c) roster liveness honesty — dead
   sessions never render "live"/"idle" beside their successor; (d) send help-text
   --body mismatch; (e) fold nudges under parent in inbox/orphan views; (f) inbox
   defaults to all-my-aliases (per-session), enumeration never required; (g) orphan
   lines carry an ownership hint (same-lane vs unrelated).
4. **Feature 4 (successor) evidence**: every session that found predecessor mail
   found it via /catchup's ritual, never via ipc itself — the lane/successor
   machinery is currently a skill-layer courtesy, not a broker fact.
