# Session-scope consolidation — one chokepoint for a recurring bug class

<!-- sessions: cowork-build-c7@2026-07-17 -->

## The class

A personal mailbox belongs to a **session**, but every mailbox operation is addressed
by **alias**. A session can hold several aliases (a rebind from a dead predecessor, a
second registered name). So any op that reads or delivers only the one named alias's
box leaves a sibling box invisible. This shipped three times as three separate "bugs,"
each patched on the surface where it was noticed:

- **B12** (2026-07-16): `check` / `show` / `status` party-scoping missed sibling aliases
  — a session reading under one name saw its own mail under another blanked as a
  stranger's. Fixed inline in `stripForCaller`.
- **U5** (2026-07-17, this session's step 0): the bare `inbox` CLI read missed siblings.
  Fixed inline in the CLI with a per-alias sweep loop.
- **The wake bug** (vb-fable, 2026-07-17): the `deliver` op — the actual wake path —
  claimed only one alias's box, so sibling-box mail never woke the session. A 15-minute
  reply-by TTL expired unanswered because of it. Reported at the owner's direction.

Three patches to one class in a week is the tell: the instances were being fixed while
the structural default that generates them (per-alias storage under per-session
identity, re-resolved independently at each surface) stayed intact.

## The consolidation

One broker chokepoint, `Router.sessionBoxes(anchorAlias)`, resolves the caller's whole
session (all its live aliases, via the registry's `sessionAliases`) into the set of
boxes to read. Every personal-mailbox op routes through it:

- `check` (inbox read) — pending across all session boxes, deduped by message id.
- `deliver` (the wake/claim path) — `claimForDelivery` across all boxes, deduped.
- `count` — pending count across all boxes, deduped.

Authorization is unchanged and sound: the anchor alias has already cleared
`requireOwner` (the caller proved it owns that alias), and the registry is authoritative
that the anchor's siblings share one session, so returning their boxes hands the caller
only its own mail. This is the same reasoning `stripForCaller` (B12) already used; the
consolidation hoists it from three inline copies to one method.

Dedup by message id matters because a broadcast (`to *`) lands the same message in every
one of a session's boxes, so a naive union would show or count it once per alias.

## Downstream simplifications (the same logic, removed where it was duplicated)

- **The CLI bare `inbox` sweep (U5)** is now redundant — a single `check` returns the
  whole session — but left in place; it dedupes and costs nothing.
- **The plugin watcher (`watch-inbox.sh`)** re-derived session-scoping in shell: a
  `peers` query filtered to sibling aliases, then a read per box. That was a *second*
  implementation of the same logic, and it carried a documented failure mode (B10: a
  truncated `peers` blob silently collapsed the watch to one box and ghosted a live
  session). Removed. The watcher now reads its own alias box and trusts the broker to
  session-scope it, which also retires the B10 collapse path.

## The anti-regression piece that was missing every prior time

`tests/session-scope.test.ts` enumerates the personal-mailbox ops and asserts each is
session-scoped for a two-alias session (plus broadcast-dedup and cross-session
isolation). The rule it encodes: a new mailbox op gets a case there and must pass, so a
single-box read goes red in CI, not in a peer's bug report a week later. The `deliver`
case was mutation-verified — reverting the chokepoint to a single-box claim turns it red
and restores to green.

## Verification

`bun test` 390/390, `tsc` clean. Live-smoked on an isolated broker: a request sent to
`vb-fable-c4` is visible and claimable when the session reads as its sibling `vb-fable`,
with the reply command stamped. The watcher's own suites (`wakePath`, `wakeGuards`) pass;
the previously-flaky sibling-wake test ran clean 3/3 after the change (fewer box reads
per poll shrank the timing race — an improvement, not a claim of a fixed flake).
