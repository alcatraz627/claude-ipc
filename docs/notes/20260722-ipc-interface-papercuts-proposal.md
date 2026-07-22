# ipc interface papercuts — reviewed proposal for the owner

<!-- sessions: catch-cowrk-b7@2026-07-22 · source: adrev-kanbn-4b field feedback (msg-cf9e4e1363524d8d), owner-relayed -->

A gcc agent (adrev-kanbn-4b) spent one session doing two ordinary things —
resolve a recipient, build a doorbell watcher — and logged what obstructed it.
Owner asked (relayed) that this lane review the items and present a proposal.
Verdicts below are mine, checked against the code at HEAD (70994d7); nothing
here is built yet. Evidence for P3/P4 was reproduced live during this review.

## P2 — teach `not_registered` to finish its sentence · KEEP · S · DO FIRST

Today's error names the roster but not the near-misses, and never mentions
`--to-project` even when the failed name is plainly a lane, not a session. The
reporter reached this project twice via `--to-project` and both times found it
by accident. Also (their 4b): the error's suggested fix command was itself
unsendable (`send --to <pruned-alias>`) — suggested commands must be
roster-checked before being printed.
Change: on no_peer/not_registered append (a) top-3 near-matches
(edit-distance + same-cwd rank, with status + lastSeen), (b) one
`--to-project` discoverability line, (c) only suggest commands that would
currently succeed. Pure error-surface work, the honest-flag-errors lineage.

## P1 — `who <query>` resolution verb · KEEP (reshaped) · M

"Find the alias the user means" currently costs a full-roster JSON firehose
(220+ rows, mostly graveyard) piped through rg — the reporter still picked a
dead predecessor. The dashboard now covers the HUMAN path; agents need the
one-round-trip form. Reshape: fuzzy over alias + sessionAliases + cwd, ranked
compact lines (alias · status(basis) · seen-ago · cwd), grouped per session
like groupRoster, successor-aware via the D3 `succeededSid` data ("dead, but
catch-cowrk-b7 succeeded it in the same cwd"). Read-only verb, no broker
schema change; CLI + tests only.

## P3 — a watcher cursor with honest absence · KEEP (reshaped, hardening) · M

`count` looks like the watcher primitive and hides its semantics: it is
session-scoped, DECREASES on TTL sweep or sibling consume, and net-zero
windows are invisible. Worse, verified today: `count <unregistered-alias>`
returns `0` — indistinguishable from an empty box — so a count-gated watcher
whose alias gets pruned polls a void forever with no error. Change:
(a) `count --cursor` (or `inbox --seq`) returning a monotonic lastEventSeq;
(b) count/cursor on an unregistered alias FAILS (none-not-fabricate);
(c) one help-text sentence on decrease semantics. Broker-schema touch → the
full constraint battery applies (both backends, sessionBoxes chokepoint,
flag-wiring tests). Sequenced after P2/P1: drain-on-wake already self-heals
the races for the doorbell use-case.

## P4 — prune vs long-idle LIVE sessions · NEW, needs an owner policy call

Evidence from today, twice: this session's own aliases (catch-cowrk-b7 +
claude-ipc) were pruned by `registry.pruneOffline` (registry.ts:183) during a
~25h turn gap — while the session was alive, mid-conversation, with a standing
Monitor armed. Token files are deleted on prune, so the session's sends fail
`not_registered` until it happens to re-register. Options (owner picks):
(a) longer prune grace for aliases whose sid matches a session with recent
transcript activity; (b) mechanize re-register-on-wake (the Monitor wake path
re-registers before acting — cheap, no broker change; this session now does it
manually); (c) prune marks-then-reaps with a grace window instead of
delete-on-first-pass. My lean: (b) now (convention, zero broker risk) +
(c) later.

## Not adopted

Nothing killed outright — the reporter's scoping was honest and each item
reproduced. The only reshapes are noted inline (P1 successor-awareness, P3
absence-honesty + sequencing).

## Standing constraints that bind any build

Checkpoint constraints 1–7 (2026-07-18) apply: flag-wiring + CLI-entry tests,
both storage backends, sessionBoxes chokepoint for any mailbox surface,
neutralizeFrame on peer strings, PORTS_OK=1, no casual dist/ rebuild.
