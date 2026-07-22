# Making claude-ipc extendable without breaking what it is

<!-- sessions: catch-cowrk-b7@2026-07-22 · companion: 20260722-ipc-interface-papercuts-proposal.md -->

This arc accidentally ran three extension experiments: the `-i` dashboard (a
read-only embedded consumer), decision-pages' doorbell proposal (a non-session
producer), and the papercuts feedback loop (agents extending each other's
interfaces). Each worked, and each hit the same missing abstractions. These are
my proposals for closing that gap — ideas, not builds; owner picks.

## What the experiments proved

- Embedding the `Client` read-only works TODAY (the dashboard: peeks invisible
  to owners — live-verified count-unchanged; no heartbeat pollution; tokens dir
  as the capability surface). But nothing ENFORCES a consumer staying
  read-only; the dashboard is polite by discipline, not by type.
- Non-session producers (decision-pages) work only by ritual: register from a
  borrowed session, pray pruneOffline doesn't eat the token (it does — twice
  observed 2026-07-22, including this session's own aliases).
- Every new consumer invents its own watcher (ipc-await --for, the proposed
  --any, hand-rolled count-gating) and its own event grammar.

## E1 — The Viewer Contract, typed · S · pairs with nothing, enables everything

Codify the dashboard's discipline as API: `Client.viewer(sock?, tokensDir?)`
returning a type exposing ONLY list/check(peek)/checkProject(peek)/history/
status/projects/orphans/count — no send/reply/register, no consume parameter.
Compile-time honesty: a statusline, web exporter, meld digest, or future TUI
embeds the viewer and CANNOT accidentally consume mail or fake liveness.
Doc: one "build a viewer" page citing the dashboard as the worked example.

## E2 — Service identities as a first-class tier · M · demand exists NOW

`register --service <name>` (from any session, once): a non-session sender
with (a) prune immunity while its token file exists, or an explicit
`--ttl-days`; (b) its own roster section so the graveyard stays legible;
(c) same strict-mode token auth as everyone. Solves decision-pages, future
build bots, cron reporters — the whole "machines that speak but never wake"
class the doorbell architecture creates. (P4's prune policy is the session
half of this same problem; do them together.)

## E3 — One event grammar, written down · S · do before a second producer exists

`event:<subsystem> <slug> <verb>` as the body prefix for doorbell informs, in
`docs/contracts/events.md`, with the two laws stated: payload lives in files
(the message is a doorbell, loss/dup tolerable) and bodies are ROUTED, never
executed (untrusted input). The meld hub-digest parses one grammar instead of
N. decision-pages is about to mint the first producer — bless the grammar
before there are two.

## E4 — `events --follow --json` streaming firehose · M · WAIT for a second poller

One party-scoped, read-only streaming verb (viewer-tier) so programmatic
consumers subscribe instead of each polling count. Subsumes doorbell polling
once the P3 seq cursor exists (seq = resume point after disconnect). Deliberately
deferred: exactly one standing consumer exists today (adrev's watcher); build
the firehose when the second appears, not before.

## E5 — The extension guardrails, stated once · S · costs a page, saves an audit

Any extension PR is checked against three laws this codebase already lives by:
1. Every personal-mailbox surface routes through `Router.sessionBoxes`
   (tests/session-scope.test.ts enumerates — extend it, don't bypass it).
2. Peek-don't-consume: display never mutates; consume is an explicit act.
3. None-not-fabricate, including ABSENCE: an unreadable/unknown value renders
   as labeled-unknown, and a query about a nonexistent thing FAILS rather than
   returning a plausible zero (the pruned-alias count=0 defect is the
   cautionary tale).
Write them into CLAUDE.md § extensions so future lanes inherit constraints
with the same weight as features.

## Sequencing recommendation

E3 (before a second event producer) → E5 (one page, immediate) → E1 (S, and
P1/P2 papercuts ride the same release) → E2+P4 together (the identity/prune
pair, M) → E4 only on demonstrated second consumer. Everything binds to the
standing constraint battery; nothing here changes wire protocol or message
semantics — extension by addition, never by reinterpretation.
