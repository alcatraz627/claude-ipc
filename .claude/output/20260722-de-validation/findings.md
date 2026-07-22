# D-E gate findings (opus validator, 2026-07-22) — ISSUES-FOUND

1. HIGH-1: `service` not persisted by sqliteBackend (schema/save/load all omit it) — a broker
   restart demotes every service to prunable, reintroducing the exact bug E2 kills. MemoryBackend
   tests blind by construction; violates the both-backends constraint. FIX: mirror succeededSid
   (column + ALTER migration + INSERT + load) + sqlite persistence test.
2. HIGH-2: ipc-await.sh exit-status-blind — broker-down and not_registered both exit 1, so a
   transient outage kills the watcher with WRONG advice. FIX: distinct exit 4 for not_registered
   at the CLI catch; script branches on it, tolerates other failures.
3. MED-1: count membership via list().some() ≈6000× costlier than registry.has() on the hot path.
4. LOW-1: no CLI-entry flag-wiring test for --service (client-direct tests bypass parse/BOOLEAN_FLAGS).
5. LOW-2: a real hand-typed service refresh flips sessionId to the human session + sets a spurious
   succession marker (stickiness holds). FIX: preserve svc: sid + skip succession for service rows.
Cleared: count info-leak ordering, hijack/promotion paths, leave auth, svc: sid collisions.
Mutation cycle: leave-exit guard RED→restore→green. 4 isolated probes; tree left clean.
