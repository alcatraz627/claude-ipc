# claude-ipc step-0 recon map (branch feat/i-dashboard)

<!-- sessions: cowork-build-c7@2026-07-17 · produced by Explore agent step0-recon (sonnet), persisted by parent -->

## 1. Boot injection (SessionStart)

- `src/hooks/sessionStart.ts:38-148` (`main()`) builds the whole boot block. It assembles four independent parts — `collision`, `backlog`, `roster`, `orphanNote` — filters out nulls, and joins them with `\n\n` (`sessionStart.ts:146-147`), emitted via `emitContext("SessionStart", …)` at `shared.ts:76-78`.
- The **peers roster** ("claude-ipc peers (message one with …)") is built by `formatRoster()` in `src/hooks/shared.ts:178-202`. It groups peers by session (collapsing sibling aliases into `"head (also: x, y)"`, `shared.ts:184-195`), sorts live→idle→offline, caps at **12** entries (`shared.ts:198`), and appends `"… +N more"` when truncated (`shared.ts:200`).
- The **orphan note** ("dead sessions of this project still hold unread mail") is built inline at `sessionStart.ts:118-144`. It calls `client.orphans(cwd)`, caps the *shown* list at **5** (`sessionStart.ts:131`), appends `"… +N more"` (`sessionStart.ts:132`), and claims a once-per-session marker via `markOrphanShown()` (`shared.ts:30-37`) so the UPS fallback doesn't repeat it.
- **Identity is NOT printed on the happy path.** The ONLY place the session's own alias is stated is the `collision` string at `sessionStart.ts:91-94`, and only when registration was REFUSED (alias taken/reserved). A normal successful boot never emits "you are registered as X" — confirmed by `rg "you are|your alias|addressable as" src/hooks/*.ts` returning only that one hit.
- The alias this session resolves to is computed once via `aliasFor(input)` at `shared.ts:67-74` (precedence: `CLAUDE_IPC_ALIAS` env → session title → stored alias-by-sid file → derived default).

## 2. Wake / per-turn hook (UserPromptSubmit) + B7

- `src/hooks/userPromptSubmit.ts:33-55` (`main()`) is the always-on per-turn delivery path. It calls `deliverContext()` then `orphanNoteOnce()` (`userPromptSubmit.ts:20-31`), joins non-null parts, emits via `emitContext("UserPromptSubmit", …)`.
- The injected actionable text comes from `formatMessages()` in `shared.ts:142-162`, which renders each pending message as an `⟨kind from sender · id⟩` block plus ready-to-run action commands (`actions()`, `shared.ts:105-121`), and appends `TRUST_RAIL` (`shared.ts:98-102`) only when a query/request is owed (`shared.ts:156`).
- **B7 mitigation**: `orphanNoteOnce()` (`userPromptSubmit.ts:20-31`) is explicitly the fallback for "SessionStart never fired for this resume". It checks `orphanAlreadyShown(sessionId)` (`shared.ts:26-28`) — a marker file at `config.metaDir/orphan-shown/<sessionId>` (`shared.ts:24`) — and claims the marker BEFORE building the note (`userPromptSubmit.ts:22`). Comment at `userPromptSubmit.ts:14-19` states the intent.
- **What's unverified about B7**: no code anywhere proves SessionStart actually fires (or doesn't) on a platform-level "resume" — the mitigation is entirely defensive (marker-gated fallback). `tests/wakePath.test.ts` and `tests/hookLifecycle.test.ts` test the hook's OWN logic, not whether the host re-invokes SessionStart on resume. Treat "does SessionStart fire on resume" as an open external assumption.
- Stop hook (`src/hooks/stop.ts`): heartbeats always (`stop.ts:101-105`), then one-time-block push for unanswered query/request via `decidePush()` (`stop.ts:68-75`) and `applyPush()` (`stop.ts:85-93`), gated by per-message marker files at `config.blockedDir/<id>` (`stop.ts:32-44`).

## 3. Inbox rendering (`inbox` op end-to-end)

- **CLI arg parse**: `src/cli.ts:493-512` (`case "inbox"`). Positional `alias` or `--project [dir]`; `--consume` boolean. `COMMAND_FLAGS.inbox = ["alias", "consume", "project"]` at `cli.ts:217`.
- **Client call**: alias path → `client.check(alias, consume)` (`client.ts:242-244`, wire op `"check"`); project path → `client.checkProject(dir, consume, resolveSelfAlias())` (`client.ts:250-252`).
- **Broker handler**: `Router.check()` at `router.ts:320-345`. Project branch requires `requireProjectMember()` (`router.ts:452-459`) only when `consume:true` — peeking a project mailbox is deliberately open (`router.ts:322-324`). Alias branch requires `requireOwner()` (`router.ts:336`) unconditionally.
- **Party-scoping / sibling-aware B12 fix** (commit `7fd4482`): `stillOwedBy()` (`router.ts:433-444`) filters project-mail results. The B12 bug was in `stripForCaller()`/`involves()` (`router.ts:896-924`), used by `status`/`history`/`show`, NOT by `check`/`inbox` — `check()` returns raw `backend.pending()`. The sibling-aware fix resolves the caller's WHOLE session (`selfEntry.sessionAliases`, `router.ts:901-902`) once per call.
- **Per-query "reply with: …" hint**: this is `actions()` in `shared.ts:105-121`, invoked from `formatMessages()` — NOT part of the raw `inbox` CLI output (`cli.ts:493-512` prints raw JSON via `out(box)`), only part of hook-rendered context. To attach it to plain `inbox` CLI output: add at the `case "inbox"` site in `cli.ts`, reusing `actions()` from `shared.ts` (currently private — needs exporting).
- **Default scope**: `inbox <alias>` reads exactly ONE alias's mailbox (`router.ts:335-345`), not all `sessionAliases`. The multi-alias sweep exists only in `owed` (`cli.ts:596-636`), which iterates `roster.find(p => p.alias === self)?.sessionAliases` (`cli.ts:606-607`).

## 4. Correlation (corrId minting)

- **`corrId` is never a field on the ORIGINAL query/request message** — per `models.ts:37` ("origin id, set on response/cancel"). The query's own `id` (== `msgId` from `send`) LATER becomes the `corrId` of the response.
- **`send` response has no `corrId` field at all** — the full return object at `router.ts:310-317` is `{ msgId, recipients, conversationId, replyByS, releaseAfterS, recipient }`. Every test correlates via `q.msgId`, never `q.corrId` (`tests/correlation.test.ts:36,49,53,74,79,150`).
- **`reply <msgId>` correlates** via `Router.reply()` at `router.ts:462-579`. Requires `a.corrId` (the ORIGINAL message's `id`), resolves origin via `backend.originOf(a.corrId)` (`router.ts:475`), builds a `response` with `corrId: a.corrId` (`router.ts:533`).
- **Awaiting state**: `Awaiting` at `models.ts:57-80`. `replyByS` (63, sender's chase deadline, null = opted out), `nudgedStage: 0|1|2` (67, persisted across broker restarts), `nudgeFrom` (69-72, recipient's nudge clock — pushed by snooze/partial), `closedReason` (73-79, includes `"parked"`). Awaiting rows open at `router.ts:295-300` (directed query/request only).

## 5. Sweeper / chases

- `src/broker/sweeper.ts` driven by `sweepOnce()` in `server.ts:158-196` on `setInterval(config.sweepIntervalS * 1000)` (`server.ts:263-271`).
- **`tickSweeper()`** (`sweeper.ts:75-104`): parks TTL-expired awaitings (`closeAwaiting(..., "parked")`, `sweeper.ts:84`), posts informational "parked" response to the ORIGINAL SENDER (`sweeper.ts:86-101`), fromAlias `"ipc"` (RESERVED at `router.ts:115`).
- **`sweepReplyDeadlines()`** (`sweeper.ts:116-188`), keyed off `a.replyByS`/`a.nudgedStage`:
  - Stage 1 **NUDGE** (`sweeper.ts:178-185`): `now() >= nudgeFrom + replyByS`, `nudgedStage < 1` → posts to RECIPIENT, terminal:false, `markNudged(origin.id, 1)`.
  - Stage 2 **LAST CALL** (`sweeper.ts:160-176`): `now() >= origin.ts + replyByS + finalGraceS`, `nudgedStage < 2` → posts recipient (terminal:false, "LAST CALL") AND sender (terminal:true, "NO REPLY YET"), marks stage 2, **closes awaiting as `"parked"`** (`sweeper.ts:174`).
  - All chase messages minted fromAlias `"ipc"` (`sweeper.ts:90,131`), delivered via normal `backend.append`+`enqueue` — nothing special renders them.
- **Parked/expired in counts**: parked notice queues to the SENDER's box as a normal pending response. `orphans()` (`router.ts:373-398`) counts ALL of `backend.pending(addr)` for a dead alias — including stale chases and the original unanswered query.

## 6. Roster / liveness (`peers` op)

- `Router.list` → `Registry.list()` (`registry.ts:148-165`): computes `sessionAliases` fresh (152-157), strips `token` (162), calls `statusOf(e)` per entry.
- **`statusOf()`** at `registry.ts:205-211`: `"offline"` is STICKY (only `leave()` sets it, `registry.ts:134-141`); otherwise age = `now() - lastSeen` vs `config.liveness` thresholds (`Liveness { idleS, offlineS }`, `registry.ts:17-20`, wired `server.ts:238`).
- **Dead-but-renders-live gap**: liveness is PURELY heartbeat-based — no PID check in `statusOf()`. A crashed process (no `leave()`) reads "live" until lastSeen ages out. `touchByAct()` (`registry.ts:109-115`) and `heartbeat()` (`registry.ts:93-100`) are the only lastSeen writers. `sessionStart.ts:75` resolves `ttyForPid()` at register — for tab-badging, not liveness.
- **Orphans counts**: `Router.orphans()` at `router.ts:373-398`. Entry is orphan-candidate only when genuinely offline (or pruned). `pending: msgs.length`, `oldestTs` from `backend.pending(addr)` (385-393).

## 7. Register (default alias minting)

- **CLI verb**: `cli.ts:267-335`. Requires `CLAUDE_CODE_SESSION_ID` (`cli.ts:279-287`). Calls `Router.register()` (`router.ts:117-141`).
- **Default alias**: `deriveAlias(cwd, sessionId)` in `aliasStore.ts:98-103` builds `"<slug-of-basename(cwd)>-<8charSid>"`, last-resort in `aliasFor()` (`shared.ts:67-74`).
- **No edit-distance/collision-warn path exists today.** `Router.register()` checks only exact ownership (`registry.ts:54-80`, token-gated) and `RESERVED` (`"ipc"`, `"*"`, `router.ts:115,127-129`). `clade-ipc` vs `claude-ipc` registers cleanly — a genuine gap to build.
- **"Rebound" confirmation**: `cli.ts:303` — `res.replaced` from `registry.ts:63` (`prev !== undefined && prev.sessionId !== info.sessionId`).
- Token issuance: `registry.ts:54-80`. First registration mints `tok-${crypto.randomUUID()}` (65); same-token reconnect keeps it; wrong/missing token refused (59-62).

## 8. Help text — the two disagreeing sites

- **USAGE const**: `cli.ts:175-206`; the `send` block at `cli.ts:178-185` shows body as trailing `<body...>` — no `--body` flag mentioned.
- **Allowlist**: `COMMAND_FLAGS.send` at `cli.ts:215` includes `"body"`/`"body-file"` deliberately — comment at `cli.ts:210-212`: "so the 'body is positional' hint fires instead of a generic rejection."
- **Specific error**: `cli.ts:383-392` — if `flags.body` set, emits "the message body is positional, not a flag" (`cli.ts:386-388`).
- **Broker twin**: `router.ts:203-208` `empty_send`; reply-side `router.ts:522-524`, `596-597` `empty_reply`; CLI-side `cli.ts:467-474`.
- **The lying surface**: the generic unknown-flag rejection at `cli.ts:253-263` enumerates COMMAND_FLAGS (the permissive allowlist including body/body-file) as if they were the documented interface. Preserve the allowlist-admits-wrong-flag pattern; fix the error text, don't remove body from COMMAND_FLAGS.

## 9. Tests a new flag/verb must touch

- **`tests/flag-wiring.test.ts`** — completeness gate (`:22`, `:60`): any flag added to `COMMAND_FLAGS` must get a case here or the test fails.
- **`tests/hardening.test.ts`** — allowlist-INTEGRITY (peer-targeting allowlist, Router's 7th ctor arg): `describe("allowlist")` at `:12`, privileged senders `:22-35`, `not_allowed` `:37+`, unrestricted default `:47`.
- **CLI-entry golden tests**: `tests/cli.test.ts` (`:11`) and `tests/cli-verbs.test.ts` (`:19`, e.g. `:51`) — call `run(argv, { socketPath })` and assert captured console output.
- **BOTH-backends**: `tests/storage.test.ts:14-21` `backendSuite(name, make)`, invoked for MemoryBackend + SqliteBackend at `:185-186`. New backend methods go inside the shared suite.
- **Isolated-broker rig**: per-test `tmpSock` helper (e.g. `broker.test.ts:12`), fresh MemoryBackend+Registry+Router per test, `startBroker({ router, socketPath })`, `broker.stop()` in afterEach. Global isolation: `tests/setup.ts:7` sets `CLAUDE_IPC_HOME` to mkdtemp BEFORE config loads, preloaded via `bunfig.toml:3`.
- **Compile-gate**: `tests/compile-gate.test.ts:16-32` — `bun build src/cli.ts --compile` into mkdtemp throwaway (NEVER dist/, docstring `:6-7`), runs `help`, asserts exit 0 + "cross-session messaging".

## Bonus

- **`⟨…⟩` frame + `neutralizeFrame()`**: `src/hooks/shared.ts:123-133`; swaps `⟨`/`⟩` for `‹`/`›` in body/alias before interpolation; called on both `from` and `body` at `shared.ts:144-145`.
- **`src/models.ts`**: `Message` `:30-45` (id 30, kind 32 with `Kind` at `:9`, from/to 33-34, body 35, conversationId 36, corrId 37, status/errorCode 39-40, terminal 40, op 41, contextPtr 42, ttlS 43, ts 44). `Awaiting` `:57-80`. `Delivery` `:48-54` (state machine `:16-22`: queued→delivered→surfaced→consumed | accepted/declined). `RegistryEntry` `:82-100` (`sessionAliases?` 93, `token` 99).
