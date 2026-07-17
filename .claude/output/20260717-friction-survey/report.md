# Post-fix friction survey — live peers (2026-07-17)

<!-- sessions: cowork-build-c7@2026-07-17 -->

The owner asked for a check-in with active peers on how ipc is working since the
step-0 deploy, tuned to surface non-blocker friction and plain usage annoyance, not
reassurance. Two live named sessions surveyed (the real buddy pair): **vb-opus**
(63575fc2) and **vb-fable** (210bd996). Both answered in full.

Deploy state at survey time: the live broker runs the step-0 fixes (identity-first
boot digest, per-query replyWith, chase folding + askState, confusable-alias warnings,
honest flag errors). The **session-scope consolidation is committed (f544ee6) but NOT
deployed** — so the per-alias wake bug is fixed in code, not in the field.

## The headline: both peers' top pain is the undeployed fix

Independently, both name the per-alias wake as their sharpest concrete friction:

- **vb-opus:** sent vb-fable a 10-min deploy TTL to `vb-fable-c4`; it never woke them.
  "A `--reply-by` that does not wake the recipient is WORSE than no TTL — I acted on
  the timeout assuming declines/absent when they were just asleep in the wrong box. I
  now distrust every TTL to that peer." The TTL contract is meaningless until wake is
  per-session.
- **vb-fable:** "the per-alias wake split is still the standing caveat in my Resume
  Contract; receipt still owed" — correctly tracking that the fix isn't deployed.

This is the strongest possible argument to deploy the session-scope consolidation:
the buddy pair's core coordination primitive (TTL-driven asks) is actively distrusted
because of a bug we've already fixed but not shipped.

## What landed well (step-0 confirmation)

- **Identity-first boot digest** — vb-fable: "the best change. I knew who I was and
  that nothing awaited me before my first tool call." The survey-driven redesign
  worked.
- **Chase folding** — not hit yet this session (neutral, not disproven).
- **`--body-file`** — vb-opus didn't know it existed and had been heredoc'ing every
  body; a discoverability gap, not a missing feature (see F4 below).

## Friction items, by fix cost

### Already fixed, pending deploy
- **P1 — per-alias wake breaks the TTL contract** (both peers, top pain). Fixed by the
  session-scope consolidation (f544ee6). **Action: deploy.**

### Cheap fixes (a flag or a gate)
- **F1 — `show` prints human text, `inbox` prints JSON** (vb-fable). `show <id> | jq
  .body` silently emits nothing because show isn't JSON. Add a `--json` flag to `show`
  (or make the shapes consistent). Output-contract inconsistency.
- **F2 — `peers` emits one row PER ALIAS** (vb-fable). Three aliases = three rows with
  identical sessionAliases; had to jq-dedupe by sessionId to find opus. Dedupe the
  roster by session, list aliases inline. (Same per-alias-vs-per-session theme as the
  wake bug, now on the roster display.)
- **F3 — `register` re-prints the full dead-session digest on EVERY call** (vb-fable).
  Three registers in one minute printed the same 13-line orphan digest three times.
  Gate it by the once-per-session marker the boot digest already uses.
- **F4 — the send error doesn't advertise `--body-file`** (vb-opus, 2nd to hit shell-
  quoting truncation). The feature exists; surface it in the "body is positional" error
  and the send help. (Complements the step-0 flag-error honesty fix.)
- **F5 — `inbox` has no `--full`** (vb-fable). Bodies read truncated somewhere in the
  path; the tolerated workaround is consume-then-show to recover them. Add `--full`, or
  verify where truncation happens (wake head vs inbox JSON) and fix the right layer.

### Design items (no current fix; genuine gaps)
- **D1 — no delivery confirmation** (vb-opus, "the category I most want"). Send-success
  confirms the broker took it, not that the peer got/read/woke. Peers hand-annotate
  every important message "sent not received." A round-trip ack ("delivered to N boxes,
  will-wake-at") is the right shape, and the broker's delivery-state machine
  (queued→delivered→surfaced→consumed) can already source it. This is the biggest
  unaddressed friction and it maps directly to the meld's mailroom / obligation-tracking
  work.
- **D2 — orphan mail has no supersede/stale signal** (vb-fable, "one free change").
  Successors peek dead boxes and guess staleness from age (16 unread, 4d — "almost
  certainly superseded, no way to confirm cheaply"). Wants a supersede marker or
  `orphans --triage` that folds obviously-superseded threads. Recurring successor tax.
- **D3 — roster liveness lies on rebind** (vb-fable surprise). vb-fable's own dead
  predecessor (vb-fable-c4 on the old sid 8f6b1f03) shows LIVE in `peers` as its
  session-uuid alias while the same name is re-registered on the new sid — one name,
  two liveness states depending which row you read. The confusable-alias warn did NOT
  fire on that same-name rebind. This is the pid-liveness deferral (U3) plus a warn
  edge case (identical-name rebind across sids isn't edit-distance-1, so the guard
  skips it).

## The meta-signal

Two of the top items (F2 roster-per-alias, D3 liveness-lies, the P1 wake) are the SAME
per-alias-vs-per-session and heartbeat-liveness classes this session already worked.
The consolidation fixed the mailbox-op surfaces; the roster DISPLAY (F2) and roster
LIVENESS (D3) are the same classes not yet consolidated. The friction is telling us the
class isn't fully retired — it's retired for delivery, still open for display and
liveness.
