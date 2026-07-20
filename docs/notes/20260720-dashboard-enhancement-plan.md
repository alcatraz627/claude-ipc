# `-i` dashboard enhancement plan — consolidated from both reviews

<!-- sessions: catch-cowrk-b7@2026-07-20 -->

Inputs: designer review (`.claude/output/20260720-design-review/designer-review.md`,
6.6/10, 11 findings) + revdiff/btop research
(`.claude/output/20260720-tui-refs-research/revdiff-btop-research.md`, 20 ranked
ideas). Adoption calls below are the owner-delegated final calls (this session).

## Adoption calls on the research list

| R# | Idea | Call | Note |
|---|---|---|---|
| 1 | pause/freeze live refresh (btop `u`) | **ADOPT** | client state only; "paused" glyph in header |
| 2 | header state-glyph row (revdiff status bar) | **ADOPT** | terminal-safe glyphs only (designer F-1); operator-ON must be visible |
| 3 | `+`/`-` refresh-rate nudge (btop) | **ADOPT** | bounded 1s–30s; header shows `· 5s` |
| 4 | owed-only filter + local mark-seen (revdiff Space/F) | **ADOPT** | view-state only, never consumes |
| 5 | scrollbar thumb on panes (revdiff) | **ADOPT** | geometry already in `followSelection` |
| 6 | fabric overview popup (revdiff `i`) | **ADOPT** | rebind — `i` taken (inbox focus); use `v` |
| 7 | body search in LOG + `n`/`N` (revdiff `/`) | **ADOPT** | wave 3 |
| 8 | clickable keybar, accented hotkeys (btop) | **ADOPT** | merges with designer FIX-4; same dispatchOne handlers |
| 9 | sortable columns + reverse (btop `←`/`→`, `r`) | **ADOPT** | rebind to `<`/`>` (`→` = inbox focus, `r` = reply) |
| 10 | honest color-depth degradation (btop truecolor→256→tty) | **ADOPT** | pairs with the token rework |
| 11 | auto dark/light from terminal bg (revdiff `--theme auto`) | **ADOPT** | with R10 |
| 12 | `!`-regex filter + explicit clear (btop) | **ADOPT** | tiny upgrade to existing `/` |
| 13 | per-peer activity sparkline | **DEFER** | charming, niche; after core waves |
| 14 | word-wrap toggle + `«»` overflow markers | **DEFER** | detail panes already wrap; lists later |
| 15–20 | theme picker, vim counts, remappable keys, layout presets, options menu, resizable panes | **SKIP v1** | agree with researcher; 20 partly mooted by the width fix |

Designer fixes 1–11: all adopted (FIX-11 verify-live-first — the caret may exist
outside the freeze capture).

## Build waves (each independently shippable + verifiable)

**Wave 0 — feels-broken fixes.**
Terminal-safe glyphs (F-1) · visible selection cursor, liveness color moves to
glyph only (F-5) · the width-split bug: `width="55%"` loses to content pressure,
panes jump on focus change — pin real column widths from `useTerminalViewport`,
60/40 home split, collapse empty inbox strip to 3 rows (F-7 + session find).

**Wave 1 — one job for cyan (color tokens).**
Body=text token, meta=accent, id=dim (F-2) · one label/value rule everywhere
(F-3) · footer keys accented + clickable (F-4 + R8) · dim `[hidden]` boilerplate
(F-6) · orphan short-ids (F-8) · priority footer truncation, `q quit` survives
(F-9) · `inbox unknown — peer offline` (F-10) · compose caret verify (F-11).

**Wave 2 — live-surface control (all S-effort).**
Pause (R1) · state-glyph row (R2) · refresh nudge (R3) · scroll thumb (R5) ·
`!`-regex filter (R12) · fabric overview `v` (R6).

**Wave 3 — power features + honest data (M-effort).**
Owed filter + mark-seen (R4) · LOG body search (R7) · sortable columns (R9) ·
color-depth degradation + auto dark/light (R10+R11) · **surface the shipped
D1/D2/D3 data**: livenessBasis/sinceSeenS/succession in roster+preview (fixes
the dishonest `offline · seen 62m` self-row), orphans triage open/folded split,
`sent` delivery-state in message detail. This is where the live shakedown rides.

## Verification per wave

Pure view-model fns unit-tested (`tests/tui-model.test.ts` pattern) · frame
capture via the tmux+freeze pipeline (promote `capture.sh` into `scripts/`) with
before/after PNGs read visually · full manual never-trap walk after wave 3 ·
adversarial review gate (phase-4b, still owed) after the waves land.

## Constraints carried forward

Client-only data, no new broker endpoints · peek-don't-consume · no fabricated
liveness (dashboard never heartbeats) · one `dispatchOne` input path · `dist/`
untouched until an explicitly confirmed deploy · standing constraints 1–7 in the
2026-07-18 checkpoint remain binding.
