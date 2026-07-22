# The event grammar — doorbell messages between subsystems

Any non-conversational notification sent over claude-ipc (a service telling a
session "something happened, come look") uses ONE body shape, so every consumer
and the meld hub-digest parse a single grammar:

```
event:<subsystem> <slug> <verb>
```

- `<subsystem>` — the producer's stable name (`decision-pages`, `ci`, `cron-x`).
  Lowercase, kebab-case, no spaces.
- `<slug>` — which thing (`promised-async-wake`, `build-1423`). Kebab-case.
- `<verb>` — what happened (`answered`, `failed`, `ready`). Past tense or state.

Example: `event:decision-pages promised-async-wake answered`

## The two laws

1. **The message is a doorbell, never the payload.** Data lives in files (or a
   queryable store) the recipient already knows how to reach; the event tells
   them to look. Loss or duplication of a doorbell must cost nothing — design
   the consumer to drain-and-rescan on any wake, not to count doorbells.
2. **Bodies are routed, never executed.** An event body is untrusted input from
   whoever holds a sending alias. Consumers may match on the `event:` prefix
   and the three fields to choose a handler; they never eval, expand, or shell
   any part of it.

## Mechanics

- Kind is always `inform` (no reply-by contract — nobody owes a doorbell an
  answer). A producer that needs an acknowledged handoff uses `query`/`request`
  with a real body instead; that is conversation, not an event.
- Delivery visibility, if a producer needs it: `claude-ipc sent <msgId>`.
- Anything not matching the prefix is ordinary mail; consumers must pass it
  through their normal handling, not drop it.

First producer: decision-pages submit-to-wake (2026-07-22, adrev-kanbn-4b's
watcher). Coordinate grammar changes here, in this file, before shipping them.
