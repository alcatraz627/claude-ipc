# RCA fix batch — plan (2026-07-16, dash-audit-09)

> **STATUS: IMPLEMENTED, awaiting hostile review.** Commits on feat/i-dashboard:
> flag-wiring+gate+count · router (empty_send/liveness/reply-to-inform/status) ·
> CLI verbs (show/owed/feedback) + exitCode · pipe-drain correction + watcher ·
> hook lifecycle + UPS fallback. 315 tests green, tsc clean. Fix→F# map:
> F1 empty_send (router+degraded) ✓ · F2 touchByAct acting-only ✓ · F3/F4
> recipient/asker status + CLI warns ✓ · F5 reply-to-inform ✓ · F6 stdout drain
> (took a correction — see the commit; the naive exitCode fix was falsified) ✓ ·
> F7 show ✓ · F8 owed ✓ · F9 flag-wiring golden test ✓ · F10 gate ✓ · F11 UPS
> fallback + lifecycle test (answered the A3 question: SessionStart is
> source-agnostic) ✓ · F12 feedback verb ✓ · F15 watcher loud-fail + already
> multi-alias ✓. NOT deployed — dist/ untouched, needs owner approval.
> NExt: hostile /skeptical-review over the whole diff.


Fixes every OPEN defect from the consolidated issue list
(`.claude/output/20260716-issue-consolidation/report.md`) plus the RCA's
testable guards (`.claude/output/20260716-rca/RCA.md` §4) plus the owner's
offline-feedback intake. Reviewed before implementation; implemented on
`feat/i-dashboard`; verified per-fix; then a hostile /skeptical-review over the
whole diff.

Out of scope, deliberately: #7 priority-mode (own design round), the full
broker-independent .jsonl fallback lane (#11 — the feedback intake below covers
broker-up AND broker-degraded; a broker-DEAD lane remains #11's proposal), B8
duplicate-pid rows (cosmetic; the roster already groups by session — document,
don't change).

Model plan:
  plan review  → opus · medium · adversarial judgment seat, persisted output
  implement    → main agent (no sub-agents)
  verify       → main agent: red-first units + isolated-broker walks + 3 targeted repros
  final review → /skeptical-review (hostile framing per owner), full context in note

## F1 — broker refuses empty-bodied sends (`empty_send`)

`router.send()` gains: `if (!(a.body ?? "").trim()) return fail("empty_send", ...)`
for ALL kinds. Rationale: an empty inform has no use; MCP's body is a required
string; the CLI guard (005d35f) covers only one client. Risk: unknown callers
sending deliberate empties — none exist in-repo (grep). Red-first test; the
refusal message names the fix per verb.

## F2 — liveness refreshes on ACTING ops, never on polling ops

The defect: heartbeat has exactly one caller (turn-end Stop hook), so liveness
= turn cadence, and an agent mid-long-turn reads offline (both 07-16 incidents).

The fix: `router` treats a token-authenticated **acting** op as a liveness
signal — `send`, `reply`, `accept`, `decline`, `snooze`, `cancel`, `register`
(already), `heartbeat` (already) → `registry.heartbeat(actingAlias)` (which
touchSiblings-propagates session-wide).

**The sharp edge (do NOT widen):** `check` / `deliver` / `count` / `await` /
`list` must NOT refresh liveness. The inbox watcher polls `check` every ~10s as
a detached process; watchers can orphan their session (three watch-inbox
processes were found running today, some from dead sessions). If polling
counted as life, a dead session with an orphaned watcher would read live
forever — strictly worse than today's false-offline. Acting ops require an
agent turn by construction; that is the honest signal. This line must be a
code comment AND a test (a check-poll storm must not resurrect an idle peer).

Tests: red-first — send refreshes lastSeen of all session aliases; check does
not; sweeper/status transitions honor the new signal. Also update
`docs/notes/no-liveness-claims.md` if its assumptions shift.

## F3 — sends to a stale recipient say so

`router.send()` result gains `recipientStatus: {status, lastSeenS}` for direct
sends. CLI prints a stderr warning when offline: "delivered to <alias>'s
mailbox — they've been offline <age>; mail waits, successors in <cwd> are told
at register." No behavior change to delivery (mail still waits, by design);
the sender just stops being blind. MCP passes the field through untouched.

## F4 — replies to a dead asker say so

Same shape on `router.reply()`: result gains `askerStatus`; CLI warns when the
asker is offline ("your answer waits in their box").

## F5 — reply-to-inform allowed (owner ruling, task #12)

`router.reply()`: when origin exists but is not an ask (inform/response),
accept — append correlated response (corrId + inherited conversationId),
enqueue to origin sender, markConsumed for replier + sibling aliases, skip ALL
awaiting/nudge machinery (none exists for informs — falls out naturally), keep
`empty_reply`. `not_an_ask` refusal narrows to genuinely nonexistent ids
(merges with `no_origin`). CLI/MCP hint text updated. Tests: reply-to-inform
threads + delivers; no awaiting row created; reply-to-response continues a
thread; nudges never fire for these.

## F6 — CLI output survives its own exit

Replace the tail `run(...).then((code) => process.exit(code))` with a
flush-then-exit: set `process.exitCode`, explicitly flush stdout/stderr
(write-callback drain), and only then hard-exit if lingering handles would
otherwise hang (`serve`/`tail` never return; unchanged). Verified against the
live repro: `claude-ipc log --operator | wc -c` on the real broker's ~2500-line
history currently truncates at ~72KB mid-JSON; after the fix it must parse.
(Mechanism was UNKNOWN in the RCA; this fix + repro converts it to KNOWN.)

## F7 — `show <msg-id>` (C1)

New CLI verb: `show <id>` → `status()` under the hood, rendered as ONE message
(headers + party-scoped body + thread summary: what it answers, reply count),
JSON with `--json`. The verb both vb agents asked for.

## F8 — `owed` verb: what do I owe, across all my aliases (C3 + C2's intent)

New CLI verb `owed [--as <alias>]`: resolves the session's aliases via
`list().sessionAliases`, peeks each alias inbox + the cwd's project mailboxes,
prints pending asks only (query/request, with age + reply command). Pure
client-side composition — no broker change. This is the startup-poll answer to
vb-opus's "inbox --project returned empty while an alias-addressed ask was
owed": one verb that cannot miss either mailbox class.

## F9 — allowlist-integrity test (RCA guard 1)

A test reads `src/cli.ts` source, extracts `COMMAND_FLAGS`, and asserts every
allowlisted flag name is textually consumed inside its verb's case block
(`flags.<name>` / `flags["<name>"]`). Crude static tripwire, kills the
certified-but-unwired class (`--body`) forever. Red-proof: temporarily
allowlist a fake flag → test must fail.

## F10 — typecheck joins the gate (RCA guard 7)

`package.json`: `"gate": "tsc --noEmit && bun test"`; `build` runs `gate`
first. Rationale: main sat tsc-red ~11h because `bun test` and `tsc` are
independent gates and only one ran. Deploys physically can't skip it now.

## F11 — A3 on resumed sessions: verify, then de-single-point it

(a) Empirically determine whether the platform re-fires SessionStart on
`--resume`/`/clear` (probe: instrument a scratch session — or read the hook
input's `source` values from recent transcripts, cheaper). (b) Regardless of
the answer, stop depending on a single hook firing: the UPS (per-turn) hook
surfaces the predecessor-orphan note ONCE per session (marker file in
`config.metaDir` keyed by session id) if SessionStart didn't. Tests: the
lifecycle rig — sessionStart main() driven end-to-end asserting the orphan
note in output (closing the zero-coverage gap the archaeology found), plus the
UPS fallback fires exactly once.

## F12 — feedback intake that survives my absence (owner part 3)

- New CLI verb `claude-ipc feedback "<text>"` → sends kind=inform to
  `proj:<claude-ipc repo path>` with a `[feedback]` body prefix. Works when no
  maintainer session is running (project mail waits, by design) AND when the
  broker is down (the client's degraded mode persists sends to the DB
  directly). The repo path is compiled in via a config field with env override.
- Surfacing on wake-up: already exists — /catchup peeks the project mailbox,
  the UPS hook drains project mail, and the dashboard's PROJECTS view shows it.
  Add one line to `register`'s output and `help` so peer agents discover the
  verb.
- Live feedback: unchanged — the maintainer session asks peers directly (as
  done today); the `owed` verb (F8) keeps those asks visible.

## F15 — watcher watches ALL of its session's aliases (B10, confirmed live 07-16)

The inbox watcher follows one alias (the side-file's single entry), so a
renamed/multi-alias session is deaf on its other mailboxes: vb-fable's watcher
watched only `catch-ipc-9e` while asks queued undelivered in `vb-fable` — the
live ghosting the owner caught at 15:1x. Fix in
`plugin/scripts/watch-inbox.sh` (and reconcile the installed copy under
`~/.claude/skills/claude-ipc/scripts/` — two copies is its own drift bug, note
which is canonical): each poll cycle resolves the FULL alias set for its
sessionId (side-file alias + derived alias + registry sessionAliases via a
cheap `peers` filter, unioned) and peeks every box; wake lines dedupe by
message id across boxes. Verification: isolated-broker walk — register two
aliases for one sid, mail the non-side-file alias, assert the watcher log
shows the wake (the exact scenario that failed live).

## Hostile skeptical-review dispositions (all 8 findings — `.claude/output/20260716-1549-skeptical-review-rcafix/review.md`)

The review found NO blockers and confirmed the load-bearing guards
(empty_send, touchByAct exclusion, sticky-leave, reply-to-inform scope) are
real and mutation-verified. Both MAJORs were the RCA's own mechanisms
re-offending inside this batch — the most valuable thing the gate could catch.

1. **MAJOR — flag-wiring not exhaustive (M3).** FIXED. The test now iterates
   COMMAND_FLAGS and fails on any verb×flag its verb never reads — the
   mechanical completeness guard the RCA actually specified. Red-proven against
   the count.alias regression. Docstring overclaim removed.
2. **MAJOR — pipe-drain weak regression guard (M1).** FIXED, and it taught a
   real lesson: the reviewer's slow-reader idea made it WORSE (0/5 caught — a
   concurrent reader keeps the pipe drained). The truncation is a genuinely
   non-reproducible exit-flush race, so no behavioral test can be its tripwire.
   Split into two honest guards: a behavioral test that proves the FIX works,
   and a structural test that deterministically catches the regression (a
   re-added process.exit / unbuffered out()). The claim now matches what each
   test can do.
3. **MINOR — UPS/SessionStart double orphan note.** FIXED. A shared
   `orphan-shown/<sid>` marker (in shared.ts) is claimed by SessionStart when it
   surfaces the note; UPS skips when it exists and only surfaces on a resume
   that never fired SessionStart. New lifecycle test asserts no double-note.
4. **MINOR — "A3 answered" conflates two questions.** DISPOSITIONED (doc). The
   test proved main() is source-agnostic (real). Whether the PLATFORM re-fires
   SessionStart on resume is UNKNOWN from this repo and stays open — MITIGATED,
   not answered, by the UPS fallback (F11). This note is the correction; the
   commit's headline overreached.
5. **MINOR — touchByAct before the content guards.** KEPT, with reasoning in the
   code: it fires after requireOwner, so it's a token-authenticated request from
   the alias's real owner — the process is provably alive whether or not the
   send's body/kind is valid. requireOwner blocks anyone who isn't the owner, so
   no dead session can fake it. "Liveness = the process is alive and acting" is
   the honest reading; a content-refused act still proves that.
6. **MINOR — "20650d ago" for explicitly-left aliases.** FIXED. offlineSince()
   distinguishes a `leave` (lastSeen=0 → "they left the roster explicitly") from
   a decayed-quiet peer.
7. **MINOR — replyToInform missing the error-status empty exemption.** FIXED —
   an error reply may be body-less (errorCode carries it), matching the ask
   path. Test added. The project-delivery non-consume is intentional and
   documented in-code ("Project copies stay").
8. **INFO — ccabcf8 shipped a since-retracted lucky-run claim.** ACKNOWLEDGED,
   no action — 293e649 already retracted it. This is the batch catching its own
   M3 mid-stream: evidence the discipline works, not a live defect.

DISPROVEN by the reviewer (recorded for honesty): the out() console.log vs
process.stdout.write split does NOT reorder or lose output (tested with a 300KB
back-pressure repro, 5/5 clean).

## Second hostile review (the revived first agent, over HEAD incl. B12+perf) — residuals

No blocker, no MAJOR; both RCA mechanisms confirmed NOT re-committed; all four
load-bearing guards independently mutation-proven red. Residuals, dispositioned:

- **R1 — F2 disposition #4 (real-client lane) was dropped.** FIXED — a client→
  broker→registry test now proves the poll-storm exclusion and acting-op refresh
  at the field layer, not just the router unit. Honors the "no silent drops" rule
  the drop violated.
- **R2 — hookLifecycle littered $HOME with .ipc-hooktest-* on a mid-run crash.**
  FIXED — the non-ephemeral test project dir moved to a gitignored repo-local
  `.test-tmp/`; a leak now stays in the repo's ignored space, never $HOME.
- **R3 — the flag completeness guard is source-text matching (the grep the
  plan-review warned against).** DEFERRED with reason: it's the belt to the
  behavioral golden layer's suspenders (the argv→request assertions are the
  durable check); the text scan only adds new-verb coverage the behavioral cases
  structurally can't. Hardening it to parse-per-verb is a nice-to-have, LOW.
- **R4 — stdoutDrain tracks only the LAST large write.** DEFERRED (latent): no
  verb emits two >32KB payloads in one run, so it can't fire today. Fix (chain
  the drains) rides the next CLI build; noted so it isn't rediscovered as new.
- **R5 — ccabcf8's "535KB parses" was a lucky-run M3 claim.** ACKNOWLEDGED — 293e649
  already retracted it; the batch caught its own M3 mid-stream.

## Sequencing & verification

Order: F9+F10 (guards first — they gate the rest) → F1, F5 (router, tested
together) → F2 (riskiest; isolated design line) → F3+F4 (result plumbing) →
F6 (exit path, repro-verified) → F7, F8, F12 (CLI verbs) → F11 (hook rig last;
independent). Each fix: red-first test, then implementation, then the suite +
`tsc`. End-to-end: an isolated-broker walk exercising F1/F3/F4/F5/F7/F8/F12
via the real CLI, the F6 repro against the LIVE broker (read-only), and an F2
fast-clock liveness simulation (acting op keeps session live through a
simulated 35-min turn; poll storm does not).

Then the hostile /skeptical-review with the issue list, RCA, this plan, and
the diff as context; its brief: assume the batch is fundamentally wrong and
prove it. Findings get fixed or explicitly dispositioned — no silent drops
(that's RCA mechanism M2).

---

## Plan-review dispositions (all 14 findings, `.claude/output/20260716-rca/plan-review.md`)

1. **ACCEPTED — F2 reframed.** F2 *narrows* false-offline for actively-messaging
   sessions and cannot fix idle-but-alive under turn-gated liveness; that
   residual is inherent and mitigated by F3/F4 wording + mail-waits, not F2.
   No "liveness: fixed" claim anywhere. An idle-agents-read-live mechanism
   (hardened watcher heartbeat) is a future design round, noted in #8.
2. **ACCEPTED, RESOLVED — B6 gets its disposition.** Already root-caused this
   session by delivery-state probe: 3 of 4 ipc-dr-4e messages were `consumed`
   by the session while it was alive (findings digested into
   20260715-vb-feedback/findings.md); only the post-death COMMS REPORT remained
   pending. Not a data-loss bug. Action: correct the issue report's B6 row (done
   alongside this edit).
3. **ACCEPTED — F1 also guards `client.degraded`** (`op === "send"` throws on
   empty/whitespace body, matching the CLI contract). No makeMessage assertion:
   broker-authored notices legitimately construct messages centrally and a
   throw there risks taking the broker down on an edge — the two guarded
   entrances (router + degraded) cover every external writer.
4. **ACCEPTED — F2 verification adds a real-client lane**: poll-storm
   (`client.check`/`client.list`) and acting-op (`client.send`) tests against an
   isolated broker with env-shrunk thresholds; unit wiring tests kept but not
   load-bearing.
5. **ACCEPTED — acting-op refresh respects stored offline** (mirrors
   touchSiblings): refresh iff stored status !== "offline", so an explicit
   `leave` stays sticky. Direct-path test added.
6. **ACCEPTED — F9 becomes a golden argv→request test** (spy on the request per
   verb×flag with sentinel values), not a text grep; and the live
   `count --alias` unwired flag is FIXED (count reads `flags.alias`, parity with
   inbox) and serves as the natural red fixture.
7. **ACCEPTED — F5 scoped to reply-to-INFORM by a RECIPIENT.** Response origins
   keep the `not_an_ask` steer (owner ruled on informs; response threading is a
   separate decision). Recipient check via the notActable pattern (direct
   delivery or project membership); the reply targets the origin's author; an
   inform's author "replying" to their own message stays refused with the
   steer. Flip `correlation.test.ts:193` + `honestFailures.test.ts:148`.
8. **ACCEPTED — F6 is exitCode-only** (no hard exit for returning verbs; serve/
   tail unchanged). Live repro must parse post-fix; if any returning verb
   hangs, fix that handle, never re-add process.exit.
9. **ACCEPTED — C4/C5 dispositioned**: deferred to #8 (ghosting/successor
   design round) — C4 needs lane-checkpoint awareness the broker doesn't have;
   C5 is the orphan-aging half of successor adoption. Recorded in the issue
   report.
10. **ACCEPTED — F11 marker in `metaDir/orphan-shown/<sid>`** (own subdir);
    marker written before emit so a partial failure cannot re-fire every turn.
11. **ACCEPTED — F12 default documented as this-host-only**; env override
    `CLAUDE_IPC_FEEDBACK_ADDR` is the off-host path; help text says so.
    (Reviewer confirmed the [feedback] prefix is not frame-injectable.)
12. **ACCEPTED — F7 passes `resolveSelfAlias()`** for party-scoped bodies.
13. **ACCEPTED — F10 wired only after confirming gate green** (reviewer ran
    tsc: green on branch now).
14. **ACCEPTED — F3/F4 warn at OFFLINE only (not idle), wording fixed to
    "mail waits / successors told", never implying death** — consistent with
    no-liveness-claims.md, and honest about the F2 residual.
