# Proposal: a centralized .jsonl mailbox pair as the last-resort fallback

Status: PROPOSAL, not built. Owner decision pending. Origin: backlog item #11
(session a510cc5f), written up as part of the 2026-07-29 backlog clearance.

## The gap this covers

Today's degradation ladder ends at the SQLite store: when the broker is down,
`Client.fallback` (where wired) reads the database directly. Two failure modes
fall through it: (a) the CLI's own client has no fallback wired (gate finding,
`src/cli.ts`), so a down broker means a dead CLI; (b) a corrupt or locked
database takes both rungs down at once. The proposal adds one lower rung that
cannot share a failure mode with SQLite: two append-only JSONL files.

## Shape

```
~/.claude-ipc/fallback/outbox.jsonl   # any writer appends; the broker drains on boot
~/.claude-ipc/fallback/ledger.jsonl   # broker-written record of drained ids (append-only)
```

- A send that fails to reach the socket AND the store appends one Message JSON
  line to `outbox.jsonl` (O_APPEND single-line writes; the same body-safety
  rules as the wire).
- On boot (and on each sweep), the broker drains the outbox: each line whose id
  is not in the ledger is appended to real storage and routed as an ordinary
  send, then its id is appended to the ledger. Duplicate drains are idempotent
  (`append` ignores known ids).
- Readers never serve from the outbox: it is a spool, not a mailbox. A degraded
  `inbox` may SAY "N spooled sends are waiting for the broker", never show them
  as delivered mail (none-not-fabricate).

## Laws carried over

1. Spooled sends are not deliveries: no send-side "delivered" claim, and the
   sender is told "spooled: delivery is not confirmed until the broker drains".
2. The pair is append-only; no process ever rewrites either file (rotation is a
   deliberate operator act while the broker is stopped).
3. Token rules do not weaken: a spooled send still carries no capability the
   drain would not verify. The drain re-runs the FULL router path (strict
   identity, empty-body refusal, reserved names), so the spool cannot bypass a
   single guard.

## Open questions for the owner

- Is (b) worth covering at all? SQLite corruption has not been observed here;
  the spool's real value may be only the CLI-without-fallback gap, which could
  instead be closed by wiring `Client.fallback` in the CLI.
- Should hooks read the spool count for the tab badge, or stay silent when
  degraded? (Silent risks "looks clean while spooling"; loud risks noise.)
- TTL for spooled lines: drain-regardless-of-age, or refuse lines older than
  the reply-by horizon with a bounce notice?

## Non-goals

No second mailbox system: the spool never grows read/consume/consent verbs.
If the broker is down long enough that reading spooled mail matters, the fix
is starting the broker, not teaching the spool to be one.
