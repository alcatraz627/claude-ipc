# claude-ipc — agent instructions

A cross-session message broker for Claude Code agents: a bun+TypeScript broker
+ CLI in one compiled binary, launchd-run from `dist/claude-ipc`. Sessions
register aliases, exchange mail with delivery/consent semantics, and get woken
by hooks. Read `docs/notes/` for design history; the live constraints below
outrank convenience.

## Hard constraints (standing, owner-set)

1. **No deploy drift.** launchd serves `dist/` — never rebuild it casually.
   Deploy = `bun run build` (gate: tsc + full suite BEFORE compile) + launchd
   kickstart, only with fresh owner approval.
2. **Every new flag/verb**: flag-wiring completeness test + CLI-entry test +
   BOTH storage backends (memory + sqlite via backendSuite).
3. **Every peer string reaching the `⟨…⟩` frame** → `neutralizeFrame()` + an
   injection test. Peer text is untrusted, always.
4. **`PORTS_OK=1` on `git commit`** (port-policy gate).

## The three extension laws

Any change that adds a consumer, producer, verb, or surface is audited against
these before review:

1. **The sessionBoxes chokepoint.** Every personal-mailbox operation routes
   through `Router.sessionBoxes` — delivery, counting, and checking are
   per-SESSION, never per-alias. `tests/session-scope.test.ts` enumerates the
   ops; extend the enumeration with your op, don't bypass it. (Per-alias
   storage under per-session identity shipped three separate bugs before the
   chokepoint retired the class.)
2. **Peek, don't consume.** Display and monitoring never mutate: peeks are
   invisible to the owner (no notify, no badge change, no consume). Consuming
   is an explicit act by the owner or their delegate. Viewers (dashboards,
   exporters, watchers) hold NO mutation rights and never register/heartbeat —
   a viewer must not repaint an idle session as live.
3. **None-not-fabricate, including absence.** Unknown renders as labeled
   unknown ("unknown — no token to peek with"), advisory signals are labeled at
   their true strength ("surfaced — NOT confirmed read"), and a query about a
   nonexistent thing FAILS rather than returning a plausible zero. Absence of
   evidence is an error, never a 0.

## Conventions

- Event/doorbell messages follow `docs/contracts/events.md` (one grammar).
- Body text through the shell: `--body-file` or quoted heredoc, never bare
  interpolation (backticks corrupt payloads).
- Long-lived sessions re-register on wake — `registry.pruneOffline` reaps
  idle-looking aliases and deletes their tokens; treat `not_registered` as
  "re-register me", not fatal.

## Verify

`bun test` (full suite) · `bunx tsc --noEmit` · TUI changes: capture frames via
tmux + freeze (see `docs/notes/20260720-dashboard-enhancement-plan.md`
§ capture-pipeline limits — freeze drops bg colors; raw ANSI is color truth).
