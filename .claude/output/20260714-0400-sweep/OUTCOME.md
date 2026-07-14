# Sweep fixes — what shipped, what's deferred

Branch `fix/wake-path-and-sweep`, driven through `/bloop` (plan → build → gate → fix →
re-validate). Spec: `VERDICT.md`. Contract judged against: `VALIDATION.md`. Adversarial
gate findings folded in. Suite 164 → **199 green**, all fixes deployed to the live broker
and exercised end-to-end.

## Shipped (all Tier-1, plus the wake path)

| # | fix | commit | live-verified |
|---|---|---|---|
| A | wake path: alias slugging (a space no longer deafens), trust rail on the wake line + `inbox` stderr, orphan-exit (grandparent pid), log cap, loud-on-missing-python, no repaint-on-peek | `bde20e8` | ✓ redeploy, space-alias wakes, orphan exits |
| 1/2 | containment: sweeper tick guarded + `uncaughtException` floor (bus can't crash-loop); Stop-hook blocks only when it can record the block (can't wedge a human) | `990dda8` | mutation-tested |
| 3/4 | project mail: exclusive atomic claim, per-member pass ("not me" ≠ "nobody"), no-op-accept killed | `42745a8` | ✓ claim/pass/reclaim on real broker |
| 5–10 | reserve `ipc`/`*`; authenticate + scope `history`/`status`; one-way claim lineage (peek stays bidirectional); alias mapping written only after the name is won; 64-bit message ids | `4657f61` | ✓ `register ipc` refused, foreign bodies redacted |
| gate | reserved-name deafness fallback; dead-claimer work-recovery; the wake guards A4–A9 given real tests; `leave` made immediately-offline without breaking restart-survival | `dce8ce8` | ✓ reclaim after claimer offline |

## The gate earned its place (13th run, caught real defects again)

Two defects it found were introduced BY the fixes, both the exact class the spec is about:

- A session titled `ipc` went silently deaf — the reserved-name check threw `bad_args`,
  which SessionStart didn't treat as "not mine", so it proceeded as owner of a name it
  couldn't use. Fixed: any register refusal falls back to the session id and says so.
- A project ask claimed by a session that then died was lost forever. Fixed: a claim only
  hides the work while its owner is live; a stale claim frees the job.

And its sharpest catch was methodological: the wake path's own safety guards (trust rail,
python-missing, log cap, notify-on-peek, id width) all passed VACUOUSLY — deleting any
left the suite green. They have real, mutation-tested coverage now.

## Deferred (Tier 2/3 — real, not blocking, honestly not done)

Not built this round. None is a correctness hole in what shipped; each is its own unit.

- **Delimiter injection** (Tier-2 #9): a peer body can still contain `⟨…⟩` framing. The
  trust rail names the risk but does not neutralise it; real fix is escaping the frame.
- **Wake ping-pong / self-send** (#10): `from !== to` still unchecked; two agents can
  trade wakes. Needs a self-send guard + a loop/rate cap.
- **Terminal-escape injection via alias/tty** (#11): `badge.ts` still writes an unescaped
  title. Slugging the alias narrows it; a crafted `--tty` is untouched.
- **Slow-broker second SQLite writer** (#12) and **`tail`'s unbounded history scan**.
- **Unbounded `blocked/` and `alias-by-sid/`, orphan-monitor accumulation** (#14, Tier-3):
  the marker dirs still never reclaim. (`project_claims` now DOES release on stale.)
- **`daemon stop` under KeepAlive**, **socket TOCTOU on double-start** — ops-tier.
- **A project ask every member passes, no TTL, no --reply-by** leaks its awaiting. Rare
  (needs opt-out + full pass-out); noted, untested.

## The through-line

Every Tier-1 fix was one of two shapes: **a claim the system couldn't back** (no-op
accept, bystander decline, forgeable `ipc`, the wedge comment) or **a guard that existed
elsewhere but not here** (unguarded timer, unauth reads, trust rail on one path,
bidirectional lineage). The defects the gate found were the same two shapes, re-created
inside the fixes. The discipline that caught them was not care — it was the mutation test:
break the guard, watch it go red, or you never had a guard.
