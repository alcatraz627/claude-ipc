# A-C gate findings (sonnet validator, 2026-07-22) — PASS-WITH-NOTES

1. MEDIUM not_an_ask wrong advice for `*`/proj: counterparties (router.ts:619-625) — reproduced via live Router probe. FIX due.
2. LOW/MED who succession line untested (weak same-alias test, hedge comment noted). FIX due: genuine two-alias takeover scenario.
3. LOW who --json shape untested. FIX due.
4. Cleared with evidence: offline-penalty floor (mutation-tested red→green), adversarial ranker probes, to-undefined impossible, not_registered strictly sender-side, neutralizeFrame out of scope, viewer zero-mutators + behaviorally identical refactor, docs consistent.

Exercised: full diff read (concurrent-E2-aware), suite 457/0, 3 standalone probes, 1 mutation cycle. Delivered on chase-up after idle-without-delivering (2nd occurrence of that stall).
