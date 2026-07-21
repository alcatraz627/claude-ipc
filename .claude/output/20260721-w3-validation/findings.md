# Wave-3 adversarial validation — findings (opus gate, 2026-07-21)

<!-- sessions: catch-cowrk-b7@2026-07-21 · validator: w3-validator (opus) -->

VERDICT: **ISSUES-FOUND** (one major D1 spec-gap; D3/D2/D1-race guards sound, mutation-verified)

## Findings

1. **[MAJOR] D1 `surfaced`/`accepted`/`declined` render as bare undocumented words.**
   `src/tui/model.ts` deliveryLines LABEL maps only queued/delivered/consumed; the broker
   stores six states (models.ts:16-22; sqliteBackend markSurfaced/setConsent) and status()
   returns them raw. The friction spec (D1 §Mitigation 102-104) requires `surfaced` be
   glossed "placed in their context at their last wake, NOT read/acknowledged" — the exact
   false-confidence bug D1 exists to prevent. Test gap: only queued/delivered/consumed +
   "weird" covered. FIX: add the three labels + red-first tests.
2. **[MINOR] Delivery ledger doesn't track auto-refresh** — effect deps lack snapshot.at
   (app.tsx logDeliv effect), so a watched message's state won't advance until selection
   moves. FIX: add snapshot.at to deps.
3. **[MINOR] LOG-search Esc inconsistency** — after Enter-submit, Esc opens the quit guard
   instead of clearing the query (roster filter clears). FIX: clear logQuery on Esc first.
4. **[NIT] `consumed` label copy** claims "read, accepted, declined, or cancelled" — stale
   now that accepted/declined render as their own states.
5. **[NIT] succeededSid rendered without sanitizeInline** (consistency with broker-trust
   model; not a new exposure).
6. **[NIT] myNames fallback** can miss sibling aliases if grouped.find(you) is momentarily
   absent — fails SAFE (shows nothing, never wrong data). Accepted as-is.

## Defended (attacked, found sound)

- **D3 aging anchoring** — mutation-tested: reverting snapAt anchoring turned the aging
  test RED (frozen age under pause), restore → green. No sibling bugs; snapAt provenance
  same-host-clock sound.
- **D1 race** — double-guarded (stale flag + render id check); read-only/identity-null
  never shows a ledger.
- **D2 fold** — open = pending − folded (router.ts:481); weak-fold never folds
  obligations; peek shows ALL mail incl. folded. Live-verified both split and fallback.
- **Owed filter + mark-seen** — pure view-state, zero client calls; actions act on the
  filtered selection; clamping holds.
- **Sort** — you-pinned across all sorts (live-verified); owed sort null-safe.
- **Input gating** — live-verified: typed q inside search is a character, not quit.

Out of scope (pre-existing): broker status() has no per-caller auth for deliveries.

## Dispositions (fix round, same day)

| # | Finding | Disposition |
|---|---|---|
| 1 | surfaced/accepted/declined unmapped | **FIXED** — CLI vocabulary adopted verbatim + red-first tests for all three |
| 2 | ledger doesn't track auto-refresh | **FIXED** — snapshot.at added to effect deps |
| 3 | LOG-search Esc inconsistency | **FIXED** — Esc clears the query before it means quit |
| 4 | consumed label copy | **REJECTED** — it is the CLI's deliberate wording (covers system settles incl. cancel); forking it dashboard-side would break the vocabulary-consistency claim |
| 5 | succeededSid unsanitized | **FIXED** — sanitizeInline applied |
| 6 | myNames sibling-alias fallback | **ACCEPTED AS-IS** — fails safe (shows nothing, never wrong data); revisit if a real multi-alias send surfaces it |

Exercised: full suite 438/0 before + after; one mutation cycle; live read-only tmux walk
(roster/D3 preview, sort, LOG search + gating, orphans triage + peek, owed filter);
six-state deliveryLines repro.
