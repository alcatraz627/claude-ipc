# The broker does not claim to know who is alive

A design constraint, not a preference: **no message claude-ipc sends may assert a
peer's state.** Escalation reports only what the broker holds outright — how long an
ask has waited, and whether it was answered.

## What went wrong

The old ghost sweep asked `isDark(recipient)` and, if the registry said offline, told
the sender: *"X went offline before your request reached them."* The registry could
not know that. Three ways it was wrong at once:

1. **`heartbeat()` only fires from the Stop hook** (`src/hooks/stop.ts`), i.e. at turn
   end. So "liveness" measured *recently finished a turn*, not *alive*. A session
   grinding through one long tool call emitted no heartbeat and crossed into
   "offline" while working perfectly. **Busy read as dead.**
2. **A session idling at its prompt** — alive, watched, wakeable in seconds — likewise
   stopped heartbeating and was declared offline.
3. **A broker restart marked everyone offline** and made it stick, because the
   warm-start default shared a value with the explicit-`leave` sentinel. Only a *turn*
   could clear it, so every idle session was permanently dead to us, and
   `send --to '*'` fanned out to nobody. See `tests/registryRestart.test.ts`.

A project address (`proj:/path`) was never in the registry at all, so `isDark` was
unconditionally true and **every project ask was falsely ghosted**, always.

## Why it mattered

Agents act on confident claims. Told a peer had "gone offline", one agent edited a
source file without the go-ahead it was still waiting for, and killed a Chrome process
on a shared profile believing it was a dead session's orphan — it was the live peer's
browser, mid-verification.

**A false liveness signal is worse than none.** Nobody hedges against a confident
statement. Absence of a heartbeat is absence of evidence, and the system kept
converting it into evidence of absence.

## The rule

`sweepReplyDeadlines` (`src/broker/sweeper.ts`) asks nothing about the recipient. It
fires on `ask still open AND deadline passed`, and says only:

- how long the ask has been waiting (we know)
- that it has not been answered (we know)
- that it is still answerable, and a late reply will still arrive (true)

A passed deadline releases the **sender** to act. That is a decision the sender is
entitled to make, not a verdict on the peer.

Liveness still exists in the roster (`live` / `idle` / `offline`) as decoration for a
human reading `claude-ipc peers`. It must never gate a decision, and it must never
appear inside a message as an assertion about someone.

## When you next touch this

Before adding any sentence to an outgoing broker message, ask: **can I name the row
that proves this?** If not, do not say it. That question is what this whole subsystem
failed, repeatedly, in every direction.
