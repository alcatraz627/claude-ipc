# The hub digest contract — what claude-ipc promises meld consumers

A machine-wide dashboard (the claude-instances hub, and any future read-only
consumer) needs one cheap, honest snapshot of the mail fabric: who has unread
mail, who owes an answer, what's orphaned. This contract defines the two JSON
responses that carry that snapshot. The verbs that serve them ship in meld
Phase 2; the shape is law from v1, so both repos can build and deploy
independently against it.

This file is the CANONICAL spec. The consumer side vendors a fixture copy
(`claude-instances/tests/fixtures/ipc-digest-fixture.json`); a live response
must always be a field-superset of that fixture. Changes land here first, in
this file, before either repo ships them.

## Versioning and the handshake

- Every response carries `protocol_version` (integer — ipc's wire constant,
  `src/protocol.ts`) and `contract_version` (integer, starts at 1).
- The contract is **additive-only after v1**: new fields may appear, existing
  fields never change meaning or type. Consumers ignore unknown fields.
- A consumer accepts `contract_version ∈ {N, N-1}` and otherwise renders the
  whole payload as version skew — never a partial parse. The N-1 window is
  what makes independent deploys safe; skew is a steady state to render, not
  an error to page on.
- Note for fixture tooling: the vendored fixture holds a string placeholder
  for `protocol_version`; parity checks compare field PRESENCE, and this
  contract pins the live TYPE (integer).

## Digest response — `claude-ipc digest --project <cwd> --json`

One project's fabric state, keyed by session. Read-only: serving a digest
consumes nothing, notifies nobody, and updates no heartbeat (it is a peek
under the Viewer Contract, `src/tui/data.ts` / `viewerOf`).

```json
{
  "protocol_version": 1,
  "contract_version": 1,
  "ts": "2026-07-24T10:00:00.000Z",
  "sessions": {
    "<session-uuid>": {
      "aliases": ["vb-fable", "catch-vb-3f"],
      "role": null,
      "liveness_claim": "live",
      "unread": 3,
      "owed": [
        { "corr_id": "msg-…", "kind": "query", "age_s": 1200,
          "reply_by_s": 300, "ask_state": "open" }
      ],
      "waiting_on": 1,
      "orphaned_in_cwd": 0,
      "oldest_deadline_s": 300,
      "chase_noise_folded": 4
    },
    "_unresolved": {
      "aliases": ["clade-ipc"],
      "note": "obligations whose alias has no alias-by-sid entry; bucketed, never dropped"
    }
  }
}
```

### The three value laws

1. **Sessions are the unit, aliases are labels.** Keys are session uuids,
   resolved by reverse-join over the broker's `alias-by-sid/` store
   (`src/config.ts` `aliasDir`). All of a session's aliases collapse into one
   entry — a consumer never treats two aliases as two agents.
2. **Absence is `null`, never `0`.** A numeric the broker cannot know (no
   token to peek with, backend error) is `null`. `0` always means "counted,
   and the count is zero."
3. **Nothing is silently dropped.** An obligation whose alias resolves to no
   session lands under the reserved `_unresolved` key (the `alias-by-sid/`
   store is swept over time — `src/broker/sweeper.ts` — so unresolvable
   entries are a designed steady state). `_unresolved` is never a session id;
   consumers must treat the key as reserved.

### Field semantics

| Field | Type | Meaning |
|---|---|---|
| `aliases` | string[] | Every alias registered to this session, newest last. |
| `role` | string \| null | Reserved; `null` until role semantics ship (meld Phase 5). |
| `liveness_claim` | `"live" \| "idle" \| "offline"` | The broker's OWN heartbeat-derived view — the same statuses `claude-ipc peers` prints. It is a claim, not process truth: consumers display it only when diffing against their own liveness source, never as the primary liveness of a card. |
| `unread` | int \| null | Messages sitting unconsumed in the session's mailbox. |
| `owed` | array | Open or recently-closed asks this session has not answered. Shape below. |
| `waiting_on` | int \| null | Asks this session sent that are still open. |
| `orphaned_in_cwd` | int \| null | Mail held by dead sessions of the same project. |
| `oldest_deadline_s` | int \| null | Seconds until the nearest reply-by expiry; `null` when nothing carries a deadline. |
| `chase_noise_folded` | int \| null | Broker-generated chase/park notices folded out of `unread`. |

### Obligation shape (frozen)

Each `owed` entry is exactly `{ corr_id, kind, age_s, reply_by_s, ask_state }`.
This five-field shape is pinned: fields the coworker rebuild adds later
(priority, topic, lane, claims) are IGNORED by the bridge until a deliberate
`contract_version` bump — stable keys are not enough when value semantics move.

- `kind` — `"query" | "request"`, verbatim from the message.
- `reply_by_s` — the ask's reply-by budget in seconds; `null` when the sender
  set none.
- `ask_state` — verbatim from the broker's awaiting ledger:
  `"open" | "responded" | "timeout" | "cancelled" | "ghosted" | "parked"`.
  `open` means the awaiting has no close reason yet; the other five are the
  broker's real close reasons (`src/models.ts` `closedReason`). This set is
  WIDER than meld plan v2 §5.1 (which listed only open/responded/cancelled/
  parked): `timeout` and `ghosted` are distinct outcomes the broker records,
  and folding them into `parked` would fabricate a friendlier state.

## Machine-wide awaitings — `claude-ipc asks --all --json`

Every open ask on the broker, across all projects, plus the orphan roster.
New verb (today the awaiting ledger is only readable inside the storage
backend, `src/storage/sqliteBackend.ts` `openAwaitings`); same read-only law
as the digest.

```json
{
  "protocol_version": 1,
  "contract_version": 1,
  "ts": "2026-07-24T10:00:00.000Z",
  "asks": [
    { "corr_id": "msg-…", "from_alias": "…", "to_alias": "…",
      "to_sid": "…", "kind": "query", "age_s": 0, "reply_by_s": 0,
      "nudge_stage": "none", "ask_state": "open", "project_cwd": "…" }
  ],
  "orphans": [
    { "alias": "…", "sid": null, "cwd": "…",
      "real_mail": 2, "chase_noise": 4, "oldest_ts": "…" }
  ]
}
```

- `to_sid` / `sid` — `null` when the alias has no `alias-by-sid` entry (the
  `_unresolved` condition, surfaced per-row here).
- `nudge_stage` — presentation name for the broker's numeric chase ladder
  (`nudgedStage` in the awaiting ledger): `0 → "none"`, `1 → "nudge"`,
  `2 → "last-call"`; an awaiting closed as parked reports `"parked"`. It
  describes chase progress; `ask_state` remains the authority on aliveness.
- `real_mail` vs `chase_noise` — an orphan box's genuine messages vs
  broker-generated chase/park notices, split so consumers can rank by what a
  human would actually want to read.

## Consumer budget

Consumers invoke both verbs as subprocesses with a hard 2-second cap and
treat overruns as their `unknown` state. The verbs must therefore answer from
existing broker state — no network, no per-alias fan-out subprocesses.

## What this contract does not cover

- **Heartbeat mechanics** — `liveness_claim` derivation is the broker's
  existing model, unchanged by the bridge; disagreement handling lives on the
  consumer side.
- **Render states** (fresh/stale/skew/unknown/unreachable) — consumer-side
  law, meld plan v2 §7.
- **The event grammar** — doorbell bodies are a separate contract
  (`docs/contracts/events.md`).

Provenance: meld plan v2 (`claude-instances/docs/20260718-meld-unified-plan.md`
§4, §5.1, §5.2, §12 Phase 0/2). The ipc-side consumer fixture
(`tests/fixtures/hub-consumer.json`) is vendored in Phase 2 together with the
verbs and the can-i-deploy parity smoke.
