# Phase 8 spike — honker backend: evaluated, not adopted

> Goal: validate the swappable `StorageBackend` against honker (an alpha SQLite
> queue/stream/pub-sub/scheduler engine). Outcome: **honker is the wrong shape
> for claude-ipc's model; SQLite stays the default.** The interface remains
> validated by the in-memory + sqlite parity suite (two real backends since
> Phase 1). Grounded in honker's actual source, not its marketing.

## What was done
Installed `@russellthehippo/honker-bun@0.2.2`; read `src/index.ts` and
`examples/basic.ts`. No assumptions — the findings below cite the real API.

## Finding 1 — abstraction mismatch (decisive)
honker exposes a **worker queue** (from `examples/basic.ts`):
```ts
const q = db.queue("emails");
q.enqueue({ to: "user@x" });
const job = q.claimOne("worker-1");   // one worker claims the job
job.ack();                            // ...and acks it
```
plus streams (`publish`/`read_since`/`save_offset`), `notify`, locks, rate-limit,
and a cron scheduler. That is **job distribution to workers**: a job is claimed
by one consumer and acked.

claude-ipc needs the opposite — a **per-recipient mailbox**: one immutable
message, fanned out to many recipients, each with its own lifecycle
(`queued → delivered → surfaced → consumed`) plus consent (`accepted`/`declined`)
and a read-without-consume, alongside `awaiting` (the sender's open request for
correlation/timeout). honker's `claimOne`/`ack` cannot represent "delivered to
bob but not consumed, and bob hasn't accepted." Mapping our `StorageBackend`
onto honker's queue loses fidelity; the only faithful path is to ignore honker's
primitives and use its extended SQLite with **our own** tables — which gains
nothing over plain `bun:sqlite`.

## Finding 2 — no in-memory databases
honker "does not support in-memory databases" (README) and `honker-bun` opens a
file DB. The claude-ipc unit + parity suites run on `:memory:` throughout, so
honker can't run the existing suite without restructuring every test to temp
files.

## Finding 3 — install friction (Rust build + custom SQLite)
`honker-bun/src/index.ts` requires:
- an **extension-enabled SQLite** — "Bun's bundled SQLite is compiled without
  SQLITE_ENABLE_LOAD_EXTENSION"; you must `brew install sqlite` and
  `Database.setCustomSQLite(path)`;
- the honker **Rust extension** `libhonker_extension.dylib`, which the npm
  package does NOT bundle — the example points at `target/release/...`, i.e. you
  `cargo build --release` it yourself.

## Finding 4 — alpha + single-writer
"Alpha software… not beta-quality." Single-machine, single-writer ("shard by
file, or switch to Postgres"). Fine for our scale, but not a reason to adopt it.

## Conclusion
honker is a capable worker-queue/stream runtime, but its model is orthogonal to
claude-ipc's per-recipient-delivery-with-consent mailbox. Adopting it would cost
a Rust build, a custom SQLite, and the loss of `:memory:` testing — to gain
nothing (its primitives don't fit; used as a plain engine it equals `bun:sqlite`).

**Decision:** keep `SqliteBackend` (`bun:sqlite`) as the default; do NOT add a
honker backend. The `StorageBackend` interface stays the swap seam, proven by the
in-memory + sqlite parity suite. The realistic future backend for the seam is a
networked store (e.g. Postgres) if cross-machine/multi-writer is ever needed — a
direction honker itself recommends.
