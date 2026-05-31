# 05 · Roadmap

> The build plan: phases with goals and testing criteria, the review/test cadence,
> and the git + dogfood checkpoints. Derived from `04-technical-implementation.md`.
> This is the living execution doc — it is updated at every review gate.

---

## Operating cadence (the rule this project runs on)

- **Triads + review gates.** Phases are grouped in threes: **(1,2,3) (4,5,6)
  (7,8,9)**. Phase 0 is pre-build prep (not counted in a triad).
- **At the end of each triad — HALT and run a Review Gate:**
  1. Review all todos; confirm **no scope was dropped** (re-read the spec's
     FR/NFR/SC list against what exists).
  2. Update this roadmap **and** the Claude Code todo list to match reality.
  3. Run the **dedicated test-enumeration phase** (T1/T2/T3): list every test to
     write for the triad's work.
  4. Write those tests (unit + integration; mock data ok).
  5. Make the **entire suite green** — not just the new tests (resilience
     invariant: later work never breaks earlier behavior or the SC scenarios).
  6. **Commit & push** (permitted for this repo only).
- **Resilience invariant.** The SC1–SC7 scenarios are regression tests from the
  moment they exist and must stay green through every later phase.
- **Dogfooding.** From **Phase 4** onward, build claude-ipc using claude-ipc:
  the build session registers an alias and exchanges real handoffs with sibling
  sessions (notably a test session reporting failures back). Note: messages are
  durably persisted (append-before-ack) from Phase 1, so a Phase-4 broker crash
  does **not** lose acknowledged messages — only the graceful degraded-mode and
  auto-reconcile polish lands in Phase 6 (review #10). Keep early dogfood handoffs
  tolerant of a manual broker restart until Phase 6.

---

## Phase 0 — Host-fact spike + scaffold (prep)

- **Goal:** confirm the host assumptions before building on them; stand up the
  Bun/TS project.
- **Deliverables:** `package.json` + Bun env (`tsconfig.json`, smoke test);
  confirmation notes for —
  (a) UserPromptSubmit/SessionStart hooks receive `session_id`+`cwd` and inject
  via `additionalContext`; (b) SessionStart fires on `resume` with stable id;
  (c) transcript JSONL is appended live (a `tail -f` check); (d) `--channels`
  availability in the installed version; (e) each stdio MCP spawns one instance
  per session.
- **Testing criteria:** `bun install` + `tsc --noEmit` clean + `bun test` green;
  spike findings written to `docs/00-host-facts.md`.
- **Done when:** the four facts are recorded as confirmed/❌, and any that fail
  trigger a documented design adjustment.

## Triad 1 — Core engine

### Phase 1 — Models, protocol, storage
- **Goal:** the durable + queueing core, no network yet.
- **Deliverables:** `models.ts` (Message/Delivery/Awaiting + unions),
  `protocol.ts` (frame round-trip), `storage/base.ts` (StorageBackend interface),
  `storage/sqliteBackend.ts` (`bun:sqlite`; immutable `messages` + `deliveries` +
  `awaiting`), AND `storage/memoryBackend.ts` — a trivial in-memory backend as the
  SECOND implementation that validates the interface early (review #13). Also: a
  cheap empirical cross-session transcript-read check (review #16) folded in here.
- **Testing:** unit — message (de)serialization; protocol length-prefix round
  trips incl. truncation/oversize; backend append (idempotent) + per-recipient
  delivery & consent; awaiting open/close + **reply-after-timeout drop**; replay
  rebuilds un-consumed deliveries + open awaiting from a seeded DB. **Run the
  shared unit suite against BOTH backends** (parity from day one).
- **Done when:** both backends pass the shared unit suite.

### Phase 2 — Broker server + registry + thin client
- **Goal:** two processes exchange a message end-to-end (on-demand check).
- **Deliverables:** `broker/server.ts`, `broker/router.ts`, `broker/registry.ts`,
  `client.ts`; ops `register/heartbeat/leave/send/check/list`; registry snapshot
  on register/leave + periodic (aliases survive restart, review #21); alias
  rebind transfers the queue + reports collision (review #3).
- **Testing:** integration — start broker on temp socket; client A registers,
  client B registers; A `send` query to B; B `check` receives it; `list` shows
  both; unknown-alias send → `no_peer`; alias rebind re-routes the old queue.
- **Done when:** the integration round-trip passes; `SC-partial` (delivery via
  on-demand check) demonstrated.

### Phase 3 — Correlation, consent, sweeper, errors
- **Goal:** request/reply with consent and clean error semantics.
- **Deliverables:** `reply/accept/decline/cancel` ops; `ipc_await` (await op);
  `broker/sweeper.ts` (TTL → close awaiting + `response{error,timeout}`; a reply
  after close is dropped, review #9); `no_peer`/`declined` synthesis; correlation
  by `corr_id`; conversation threading fields.
- **Testing:** integration — query→response correlated; request→accept→terminal
  result; request→decline→`error,declined`; await returns reply or `timeout`;
  sweeper with injected clock expires awaiting → `timeout`.
- **Done when:** SC2 (request consent + decline + timeout) passes at the
  client/broker layer.

### ▣ Review Gate 1 (after Phase 3)
- Review todos / scope vs spec FR1–FR11. Update roadmap + CC todos.
- **Phase T1 — enumerate tests:** list every unit/integration test for the core
  engine (incl. SC1-partial, SC2). Write them. **Whole suite green.**
- **Commit & push.** Tag the engine milestone.

## Triad 2 — Surfaces & resilience

### Phase 4 — MCP server + CLI (dogfooding begins)
- **Goal:** agent and human can use the system; start dogfooding.
- **Deliverables:** `mcpServer.ts` (all `ipc_*` tools), `cli.ts`
  (send/inbox/peers/log/accept/decline/tail-stub/daemon). Register the build
  session; perform a first real handoff.
- **Testing:** integration — each tool maps to the right op + result shape; CLI
  verbs against a live broker; tool descriptions enforce explicit-target + the
  request-is-a-proposal contract.
- **Done when:** a real cross-session message is sent + read via tools/CLI
  (dogfood smoke).

### Phase 5 — Hooks + install + proactive receipt
- **Goal:** receive without being reminded (turn-boundary + resume rungs).
- **Deliverables:** `src/hooks/*.ts` (compiled to binaries) + bash shims; alias
  resolution; additive `settings.json` registration installer; idempotent hook
  delivery marks.
- **Testing:** integration — invoke hook entrypoints with synthetic stdin;
  assert injected `additionalContext` contains pending; assert idempotency (no
  double-inject); SessionStart drains an offline backlog in order.
- **Done when:** SC1 (proactive query receipt) and SC3 (offline→resume drain)
  pass via the hook entrypoints.

### Phase 6 — Degraded mode, launchd, replay, monitor
- **Goal:** resilience invariant + observability.
- **Deliverables:** degraded client path (send persists, check reads log);
  `launchd` plist + `daemon start/stop/status`; full `tail` monitor; broker
  replay hardening.
- **Testing:** resilience — kill broker mid-flow → degraded send persists →
  restart reconciles, no loss (SC5); replay rebuilds queues; `daemon status`
  reports down.
- **Done when:** SC5 passes; monitor shows flow + a down broker.

### ▣ Review Gate 2 (after Phase 6)
- Review scope vs FR12, NFR1–NFR6, SC1/SC3/SC5. Update roadmap + CC todos.
- **Phase T2 — enumerate tests:** list every test for surfaces + resilience
  (hooks, CLI, MCP tools, degraded mode, replay). Write them. **Whole suite green.**
- **Manual host-in-the-loop acceptance:** run the documented SC1 (proactive
  receipt on the real host) + SC6 (real guardrail stops a real action) scripts —
  NOT covered by `bun test`. Record pass/fail in the gate notes.
- **Commit & push.**

## Triad 3 — Enhancements & integration

### Phase 7 — Notify rung: broker→peer-TTY tab badge
- **Goal:** ambient awareness for a recipient even while idle — the broker badges
  the peer's Ghostty tab title with its pending count. Validated mechanism (see
  `docs/notes/tab-title-badge.md`): writing an OSC title escape to a peer's
  captured `/dev/ttysNNN` changes its tab title, independent of that session's
  (dead, if idle) hooks. A signal, not a wake — `--channels` remains the only
  true auto-wake. `channelAdapter` stays a stub for when `--channels` ships.
- **Deliverables:** registry captures each session's `tty` at register; a
  `badge.ts` (OSC escape writer behind an injectable sink); dispatcher writes/
  clears the badge on a peer's pending-count change; config flag to enable.
- **Testing:** unit — badge escape formatting; dispatcher calls the sink with the
  right `(tty, count)` on enqueue and on drain; absent-tty peers are skipped; off
  by config = no-op. (Real-tty write is manual, like SC1.)
- **Done when:** badge sink is driven correctly by message flow in tests; one
  manual cross-tab badge confirmed on a live tab.

### Phase 8 — honker backend (spike: evaluated, NOT adopted)
- **Goal:** validate storage swappability against a real second engine (honker).
- **Outcome (grounded in honker's source):** honker is a WORKER QUEUE
  (`queue().enqueue` → `claimOne` → `ack`), not a per-recipient mailbox — its
  primitives can't model our `delivered/consumed/accepted/declined`-per-recipient
  states; it also lacks `:memory:` (our whole test suite) and needs a Rust-built
  extension + a custom extension-enabled SQLite. Wrong shape. Writeup:
  `docs/notes/honker-spike.md`.
- **Decision:** keep `bun:sqlite` as default; do NOT add a honker backend. The
  `StorageBackend` seam stays — already validated by the in-memory + sqlite
  parity suite (two real backends since Phase 1). Realistic future seam use: a
  networked store (Postgres) if cross-machine/multi-writer is ever needed.
- **Done:** gaps documented, default stays sqlite (the roadmap's alternate
  done-when). ✅

### Phase 9 — Integrations & hardening
- **Goal:** dreaming hook-in (one-way), trust seam, polish, packaging.
- **Deliverables:** `i-dream/domains/ipc.toml` (reads the message log; no
  coupling); allowlist enforcement in router (reserved seam activated as opt-in);
  monitor/widget polish; doc refresh; TTL/log rotation.
- **Testing:** integration — i-dream domain ingest of the log (mock dream run);
  allowlist blocks a disallowed `request` target; rotation keeps the working set
  bounded.
- **Done when:** integrations demonstrated; SC6 (guardrail composition) and the
  allowlist seam tested.

### ▣ Review Gate 3 (after Phase 9)
- Full scope reconciliation vs the entire spec. Update roadmap + CC todos.
- **Phase T3 — enumerate tests:** complete the matrix (all SC1–SC7 as
  integration regressions + integration coverage). Write any gaps. **Full suite
  green.**
- **Manual host-in-the-loop acceptance:** re-run SC1/SC6 scripts + record SC7
  (a real developer handoff completed without manual copy-paste) — SC7 is manual
  by definition.
- **Commit & push.** Tag **v0.1 — dogfood-complete**.

---

## Test taxonomy (applies every gate)

- **Unit** — pure logic, in-memory/temp backend, injected clock + id generator
  for determinism.
- **Integration** — real broker on a temp socket + temp DB; stateless clients;
  hook entrypoints driven with synthetic stdin; fake channel adapter.
- **Resilience** — broker kill/restart, degraded-mode persistence, replay
  no-loss.
- **Regression** — SC1–SC7 scenarios, green from creation onward.
- **Backend-parity** — the core suite re-run against each `StorageBackend`
  (from Phase 1, via the in-memory + sqlite pair).
- **Manual host-in-the-loop** — SC1 (the *real* host fires the UPS hook →
  proactive receipt), SC6 (a *real* PreToolUse guardrail stops a *real* action),
  and SC7 (a real developer handoff) **cannot** be proven by `bun test`:
  synthetic-stdin tests prove the hook *formats* injection, not that the host
  *fires* it (review #17). Each has a documented manual acceptance script run at
  its gate; the roadmap marks these three SCs explicitly as not-`bun test`-provable.

## Definition of done (per phase)

A phase is done when its deliverables exist, its testing criteria pass, the
**full** suite is green (from the first gate on), and no spec FR/NFR/SC it
claims to satisfy is left unverified. Scope dropped silently is a gate failure.
