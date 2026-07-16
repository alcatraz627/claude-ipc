# `claude-ipc -i` dashboard — end-to-end build plan

> A handoff spec for the agent who builds this. It is self-contained: read the three
> pointers below and you have everything. Nothing here needs re-deriving — the framework
> question is settled, the compile risk is retired, and every decision is locked.

## 0. Read-first pointers

| Source | What it gives you |
|---|---|
| `docs/notes/interactive-dashboard-design.md` | The locked decisions + the screen-by-screen interaction spec (view hierarchy, keys, the compose flow, degradation). **The interaction contract.** |
| `.claude/output/20260715-i-dashboard-research/web-research.md` | Why a framework (not fzf), why `ink-terminal`, the compile-gate risk, and the **COMPILE GATE RESULT** section proving it passed. **The rationale.** |
| This file | Intent, expectations, the execution-ready spec, validation strategy, per-phase acceptance criteria, risks, and where to start. **The build order.** |

Orientation in one paragraph: `claude-ipc` is a cross-session message bus (a bun+TypeScript broker + CLI shipping as one `bun build --compile` binary). `-i` adds a full-screen, live, multi-panel terminal dashboard — a genuine power-user TUI in the spirit of k9s/lazygit, built on `ink-terminal` (Claude Code's own renderer, open-sourced), talking to the broker through the existing `Client` class. It exists because the raw CLI makes you retype your own sid/alias and gives no live view; the dashboard is the surface for "I keep needing accurate, live ipc info and a fast way to act on it."

---

## 1. Intent, goals, non-goals

**Intent.** One always-live, never-dead-end surface to see the fabric (who's alive, what's owed, what's flowing) and act on it (send/reply/accept/decline/snooze/cancel/copy) without dropping to a shell or retyping identity.

**Goals (what "good" means here).**
- A human running `claude-ipc -i` sees the live roster within one frame and never has to relaunch to get a fresh view.
- Every CLI verb that a human uses interactively is reachable from inside the app (list below); `serve` is the only deliberate exclusion.
- The copy-any-field menu removes the #1 friction the CLI has: needing the sid/alias/msg-id and a ready-to-run reply command.
- It degrades honestly: no tty, broker down, empty roster, missing binary — each is a clear state, never a crash.

**Non-goals (scope ceiling — do not build these).**
- Not a broker/admin console. `serve`, config editing, and prune-all are out.
- Not a rewrite of any broker or Client logic. The dashboard is a **view + action layer** over the existing `Client`; if you find yourself changing `src/broker/*`, stop — that's out of scope.
- Not a chat client. Compose is for the existing message kinds (inform/query/request), not a threaded IM.
- No new broker endpoints. Everything the dashboard needs already exists on `Client` (see §8). If something genuinely doesn't, raise it, don't quietly add a broker op.

---

## 2. Locked decisions (owner-answered, 2026-07-15)

| # | Decision | Choice |
|---|---|---|
| D1 | Architecture tier | **Full-screen framework app** (not fzf; fzf structurally can't do multi-pane + modal compose) |
| D2 | Framework | **`ink-terminal`** (Claude Code's renderer extraction; pure-TS Yoga, no WASM, Bun ≥1.0) |
| D3 | Compile gate | **Done first, PASSED** — `bun build --compile` yields a working standalone binary (§3) |
| D4 | Compile fallback | Manual `yoga.wasm` copy — **not needed** (pure-TS Yoga); keep in back pocket only |
| D5 | Entry point | **`claude-ipc -i`** (+ `interactive` alias) on the existing binary |
| D6 | Refresh cadence | **5s** auto-refresh, `R` forces now |
| D7 | Compose editor | **In-app textarea by default + a key to escalate to `$EDITOR`** (owner upgraded from textarea-only) |
| D8 | Build scope | **Phased by feature surface** (peers+inbox+copy → compose → projects/orphans/log) |
| D9 | V1 affordance bar | **Full V3 set** (owner upgraded): roster+inbox simultaneous, in-app modal compose, flicker-free live-refresh, copy-any-field, **mouse click-targets, per-pane contextual keymaps** |
| D10 | gcc lesson | **Extract a reusable V3-dashboard blueprint + convention** into `~/.claude/conventions/tui-design.md` |

The two owner upgrades (D7c, D9c) both raise the bar: compose offers both editors, and V1 must hit the full power-user affordance set — the phasing (D8) is by *feature surface*, the *quality bar* is high from phase 1.

---

## 3. Foundation already proven — do not re-litigate

- **Framework decided by fzf's own ceiling.** fzf has one list per process and no back-steppable modal state machine (confirmed against fzf reference docs). Roster+inbox-at-once and the compose modal are the two things it can't do — so a framework is required, not merely nicer. Details in the research doc, Q2/Q3.
- **Compile gate PASSED on this machine (bun 1.3.14).** A Box/Text/flex/border/gap `ink-terminal` hello-world compiled via `bun build --compile` to a 62 MB standalone arm64 binary that runs **from `/tmp` with no `node_modules`** and renders the Yoga layout — no missing-module/WASM error. The spike lives in the scratchpad (throwaway); reproduce it in-repo as the first CI check (§9).
- **ink-terminal is at `0.1.0-alpha.1`.** It IS the real Claude Code renderer extraction (deps contain no `yoga-layout`/`yoga-wasm-web`), but it's alpha: **pin the exact version** in `package.json` and treat any minor bump as an API-review event.

---

## 4. Architecture

- **Entry.** A new `case "-i"` / `"interactive"` in `src/cli.ts` that launches the app in-process (no exec hand-off) so the whole thing stays inside the one `dist/claude-ipc` binary. Guard non-tty before launching (print the "needs a terminal" line, exit 1).
- **Data source.** The app holds a `Client` (the existing `src/client.ts`) and calls it directly — `list()`, `check()`, `history()`, `status()`, `send()`, `reply()`, etc. **No shelling out to itself.** The roster/inboxes are live objects it polls and diffs.
- **Identity.** Auto-resolve this session's alias exactly as the CLI does (`readAliasForSession(process.env.CLAUDE_CODE_SESSION_ID)`). If there's no sid (a bare shell), prompt once for a `--from` to act as, hold it in app state. Everything the app sends is `--from` that identity; the human never types it.
- **App model.** `ink-terminal` React tree under one `AlternateScreen mouseTracking`. Top-level state machine: `level-0 view` (peers|inbox|projects|orphans|log) × an optional `modal` (compose | copy-menu | confirm). A single `useInterval(5000)` drives the refresh; `R` triggers an immediate refetch. `FocusManager` owns which pane has focus so keymaps are contextual.
- **Single binary.** `bun run build` must produce a working `dist/claude-ipc` that includes the dashboard. Add the compile-gate smoke (§9) to the build so a future bun upgrade that breaks embedding fails loudly.

---

## 5. `ink-terminal` API cheat-sheet (verified against 0.1.0-alpha.1)

Everything the affordance bar needs exists; use these, don't hand-roll:

| Need | API |
|---|---|
| Render / lifecycle | `render(<App/>)` or `createRoot({stdout})` → `root.render()/unmount()`; `instance.waitUntilExit()` |
| Full-screen + mouse | `<AlternateScreen mouseTracking>` (SGR click/drag/wheel; default on) |
| Layout / panes | `<Box flexDirection borderStyle gap padding>`; **`<ScrollBox>` for independently-scrolling panes** (the multi-pane win); `<Spacer>`, `measureElement`, `useTerminalViewport` (responsive) |
| Long lists (roster/log) | `<VirtualList>` / `useVirtualScroll` (don't render 200 rows by hand) |
| Keyboard + mouse input | `useInput((input, key) => …)`; event props `onClick`, `onMouseEnter/Leave`, `onKeyDown`, `onFocus/Blur` on elements |
| Focus (contextual keymaps) | `FocusManager`, `useTerminalFocus`, `TerminalFocusEvent` — route keys by focused pane |
| Exit | `useApp().exit()` |
| Timers (5s refresh) | `useInterval` / `useAnimationTimer` |
| Text / links | `<Text>`, `<Link>`, `<Button onAction>`, **`<FileLink>` + `buildEditorUri`** (useful for open/copy and the `$EDITOR` escalation) |
| Tab title (optional flourish) | `useTerminalTitle` — could badge unread count on the terminal tab |

Confirm any hook signature against `node_modules/ink-terminal/README.md` and `dist/index.d.ts` at build time (alpha).

---

## 6. Interaction spec

The screen-by-screen spec (view hierarchy, per-view keys, the 5-step compose flow, the copy menu, the degradation ladder, the never-trap guarantees) is in `interactive-dashboard-design.md` §"The screens" through §"Degradation". Build to that. **Translate its fzf-era phrasing ("every view is one fzf instance", "reload") into the framework model** — those were the old implementation; the *behavior* they describe (a filterable list + live preview + contextual keybar, actions that return you to the list) is the spec. Where the doc and this plan differ on implementation, this plan wins; where they differ on *behavior*, raise it.

**The four invariants (acceptance-level — every one is testable):**
1. **Never a dead end.** `Esc` always pops exactly one level; from home it hits the quit-guard, never a bare shell. Mid-compose, `Esc` steps back one field.
2. **Never needs a restart.** One persistent app; every action completes and returns to the list; the roster auto-refreshes (live, not a snapshot).
3. **Covers every interactive CLI verb** (§7).
4. **Read / query / compose / copy, all in place.** Live preview reads full bodies; `y` copies any field; compose is guided and always escapable.

**The V3 affordance bar (D9c — all in V1):**
roster + inbox visible and independently scrolling at once · in-app modal compose that never drops to a shell · flicker-free live-refresh (diffed, not wholesale redraw — ink-terminal's double-buffer gives this free) · copy-any-field menu · mouse click-targets (select a row, switch pane, scroll) · per-pane contextual keymaps (same key, different action by focused pane).

---

## 7. CLI-verb coverage matrix

| Verb | Where it lives in the dashboard |
|---|---|
| `peers` (list) | PEERS view = home (the live roster) |
| `inbox` / `check` | INBOX view (mine) + `enter` on a PROJECT/ORPHAN opens that mailbox |
| `send` | COMPOSE modal (recipient can be a peer, a project, or `*`) |
| `reply` | `enter`/`r` on a query in INBOX or on a peer's last ask |
| `accept` / `decline` | `a` / `d` on a request in INBOX |
| `snooze` | `s` on any owed ask |
| `cancel` | on an outbound ask you sent (from a "sent/awaiting" filter or the LOG) |
| `projects` | PROJECTS view |
| `orphans` | ORPHANS view (dead sessions of this cwd holding mail) |
| `log` / `history` | LOG view (read-only flow) — pass `operator:false` by default; a key toggles `--operator` for the full-machine bodies |
| `status` | preview/detail on a selected message |
| `register` / `rename` | a small action (prompt a name, call `register`) — low priority |
| `count` | folded into roster/inbox unread badges |
| `serve` | **out of scope** (the broker itself) |
| `daemon start` | the broker-down state offers `[d] start daemon` |

---

## 8. Data contracts (what the views consume)

All from `src/client.ts`; shapes from `src/models.ts` and the router. Build pure view-model functions that take these and return rows/preview strings (see §9 — these are the unit-tested seam).

- `client.list()` → `{ peers: RegistryEntry[] }` where each is `{ alias, sessionId, cwd, caps, pid, tty, lastSeen, status: "live"|"idle"|"offline", sessionAliases: string[] }`. **Group by `sessionAliases`** so one session is one roster row with an "(also: …)" label (the wave-2 identity fix — match `formatRoster` in `src/hooks/shared.ts`).
- `client.check(alias, consume=false)` / `client.checkProject(dir, consume, asAlias)` → `{ messages: Message[] }`. In the dashboard, **peek (consume=false)** for display; only consume on an explicit read/act, and be deliberate — consuming is a state change.
- `client.history(q, asAlias, operator=false)` → `{ messages: Message[] }`. Bodies are party-scoped unless `operator:true` (the D2 middle-path; the LOG view's `--operator` toggle flips it).
- `client.status(msgId, asAlias, operator=false)` → `{ message, deliveries: Delivery[], responses: Message[] }`.
- `client.orphans(dir?)` → `{ orphans: [{ alias, cwd, lastSeen, pending }] }`.
- `client.projects()` → `{ projects: [{ address, path, pending }] }`.
- `client.count(alias)` / `countProject(dir)` → `{ count }`.
- Actions: `send({from,to,kind,body,ttlS,replyByS})`, `reply({from,corrId,body,terminal,status})`, `accept(alias,msgId)`, `decline(from,msgId,reason)`, `snooze(alias,msgId)`, `cancel(corrId,as)`. **All throw `BrokerError{code,message,data}` on refusal** (the wave-2 honest-failures change) — surface `code` as a toast, never swallow.

`Message` shape: `{ id, kind, fromAlias, toAlias, body, conversationId, corrId, status, errorCode, terminal, contextPtr, ttlS, ts }`.

---

## 9. Validation & testing strategy

The handbook's "test a TUI without a tty" split applies: **pure logic is unit-tested; the rendered frame is smoke-tested; the never-trap navigation is a manual tty walk.**

1. **Pure view-model functions (the main automated surface).** Every "shape a Client response into rows / a preview string / a keybar" function is a pure function of JSON in → strings out. Unit-test each off a captured fixture (reuse the test style in `tests/*.test.ts`; fixtures can be real `client` output dumped once). This is where roster-grouping, unread/owed counts, body-scoping display, and empty-states get their coverage. **Target: every data-shaping fn has a test; mutation-test the load-bearing ones.**
2. **Compile-gate smoke (CI).** Reproduce the spike in-repo: a `bun build --compile` of the app must produce a binary that runs `--version`-style and exits 0. Wire it into `bun run build` or a test so a future bun upgrade that breaks WASM/asset embedding fails loudly, not at a user's terminal.
3. **Render smoke.** Render the app to a string (ink-terminal supports non-interactive render; the spike rendered to piped stdout) against a fixture broker state and assert key rows/labels appear — catches layout regressions without a tty.
4. **The never-trap walk (manual, tty-only, per phase).** A checklist walked by hand in a real terminal: `Esc` from every screen lands one level up (never a bare shell); every action returns to a list; the quit-guard fires at home; broker-down shows the banner not a crash; an empty roster/inbox shows a friendly state. This is invariant #1/#2 and can't be asserted headless — it's a required manual gate before each phase is "done".
5. **Live exercise (the exercise-based-verification rule).** Drive the real dashboard against an **isolated broker**, never the live one — see §11 safety. Read the actual rendered pixels (screenshot / `lm see`) for at least the peers + inbox + compose states, in both dark and light if the palette is theme-aware.

**Definition of done for the whole thing:** the four invariants pass the manual walk; every CLI verb in §7 is reachable; the copy menu produces a paste-ready reply command; the compiled binary runs standalone; the pure-fn suite is green and the load-bearing guards are mutation-tested.

---

## 10. Phased build sequence (each phase ships independently, to the full affordance bar)

Each phase: **scope → files → acceptance ("done when") → the manual walk.** Do not start a phase until the prior phase's acceptance passes.

### Phase 1 — app shell + PEERS + preview + copy-menu (the everyday 80%)
- **Scope.** The outer app (AlternateScreen, the level-0 view switch, the 5s refresh loop, the quit-guard, the degradation states as React conditionals). PEERS view: the live roster (grouped by `sessionAliases`), a live preview pane (alias · full sid · cwd · status · unread/owed · last msg), the copy-any-field menu (`y` → alias/sid/cwd/msg-id/body/ready-to-run reply command → `pbcopy`). Mouse row-select + per-pane focus wired from the start (D9c).
- **Files (suggested).** `src/tui/app.tsx` (shell + state machine), `src/tui/views/peers.tsx`, `src/tui/preview.tsx`, `src/tui/copy.tsx`, `src/tui/model.ts` (the pure view-model fns), `src/tui/theme.ts` (palette, theme-aware, mirrors `std::claude::tui` intent), and the `-i` case in `src/cli.ts`.
- **Done when.** `claude-ipc -i` opens, shows a live roster that refreshes every 5s and on `R`, preview updates on selection, `y` copies a working reply command, `Esc`/`q` hits the quit-guard, broker-down shows the banner, mouse selects a row. Pure-fn tests green. Compile-gate smoke green. Manual walk passes.

### Phase 2 — INBOX + reply/accept/decline/snooze
- **Scope.** INBOX view (my messages, full-body preview, thread context via `status`), shown alongside the roster (the roster+inbox-simultaneous win). Per-kind contextual actions: query→reply, request→accept/decline, any→snooze. Contextual keymaps switch with focused pane.
- **Done when.** Both panes visible and independently scrollable; the correct action set shows per focused message kind; a refusal surfaces its `BrokerError.code` as a toast; an empty inbox is a friendly state. Manual walk passes.

### Phase 3 — COMPOSE modal (+ reply-with-body)
- **Scope.** The anti-dead-end 5-step modal: recipient (peer/project/`*`) → kind → body → reply-by (presets 5m/15m/1h/none, only for query/request) → confirm. `Esc` steps back one field. Body: in-app textarea by default, a key (`e`) escalates to `$EDITOR` (D7c) via `buildEditorUri`/spawn; **empty body cancels the step, never sends zero bytes** (the empty-reply guard at the UI). Confirm shows the assembled message + the deadline contract before send; on send, back to home with a toast.
- **Done when.** Every step is escapable back one level; `$EDITOR` escalation returns cleanly into the TUI; an empty body cannot be sent; the deadline contract is shown; a successful send toasts and returns home. Manual walk passes (this is the highest never-trap risk — walk it hard).

### Phase 4 — PROJECTS / ORPHANS / LOG + gcc convention
- **Scope.** The remaining level-0 views. PROJECTS (mailboxes + pending → `enter` opens the inbox), ORPHANS (dead sessions of this cwd + `enter` peeks, `y` copies the read command), LOG (read-only flow; a key toggles `--operator` bodies). Then **D10** (§12).
- **Done when.** All views reachable via the level-0 switch; LOG parses defensively (never crash on a weird body); `--operator` toggle works; the gcc convention + blueprint are written and linked. Full manual walk of all four invariants. Then a review-gate pass (a fresh adversarial reviewer over the diff) before calling the dashboard done.

---

## 11. Risks, fallbacks, gotchas

- **ink-terminal is alpha.** Pin the exact version; on any bump, re-read `dist/index.d.ts` for API drift and re-run the compile-gate smoke. If a bump breaks `bun build --compile`, the D4 fallback is the documented manual `yoga.wasm`-copy build step — but the pure-TS Yoga means this is unlikely.
- **62 MB binary.** Expected (bun runtime embedded; the existing binary is similar). Not a blocker; don't chase it.
- **LIVE-BROKER SAFETY (mandatory for any test).** A live broker with real agents runs under launchd. **Never** run a dashboard action (send/reply/register/…) against the live broker while testing. Stand up a throwaway broker with `CLAUDE_IPC_HOME`/`SOCKET`/`DB` overridden into a scratch dir + `bun run src/cli.ts serve`; **pass a scratch tokens dir as `new Client(sock, undefined, scratchDir)`'s 3rd arg** (the default writes into the real `~/.claude-ipc/tokens`). Never `pkill -f watch-inbox`.
- **Non-tty / degradation is a first-class path, not an afterthought.** `-i` with no tty must exit 1 with a clear message; broker-down must render the banner; empty states must be friendly. These are React conditionals — build them in phase 1, not "later".
- **Consuming vs peeking.** Display uses non-consuming peeks. Only consume on an explicit act. A dashboard that silently drains inboxes as you browse would be a real bug.
- **Body scoping (D2).** The LOG/history view shows party-scoped bodies by default; the `--operator` toggle is a deliberate, visible action, not the default. Don't accidentally pass `operator:true`.
- **Refusals are `BrokerError`.** Every action can throw `BrokerError{code}`. Surface the code; never show a success toast on a throw. The self_send / no_peer / ask_cancelled codes each have a useful message — show it.

---

## 12. gcc convention extraction (D10)

After phase 4, extract the reusable lessons so the next power-user TUI doesn't re-derive them:
- Add a **V3-dashboard section** to `~/.claude/conventions/tui-design.md`, sibling to the existing fzf-launcher blueprint. It should state: *when* a tool crosses from fzf-launcher (V2) to a framework dashboard (V3) — the trigger is "≥2 panes visible at once OR a modal form with back-stepping", the exact bar fzf can't clear; the recommended stack for a bun/TS repo (**ink-terminal**, one binary, no language boundary); the **compile-gate-first discipline** (prove `bun build --compile` on a hello-world before building); and the four invariants as the acceptance contract.
- Optionally drop a minimal **ink-terminal starter** (the shell + a live-list + a modal) into `~/.claude/scripts/tui/` or a referenced gist, so the next dashboard starts from a proven skeleton.
- Cross-link the research doc and this plan as the worked example.

---

## 13. Start here (the builder's first hour)

1. In the repo: `bun add ink-terminal@0.1.0-alpha.1 react` (pin exact) and re-run the compile-gate smoke (§9.2) to confirm it still passes on your bun.
2. Add the `-i`/`interactive` case in `src/cli.ts` (non-tty guard → launch `render(<App/>)`), and the `--help`/`USAGE` entry.
3. Build `src/tui/app.tsx`: the AlternateScreen shell, the level-0 view state, the 5s `useInterval` refetch, the quit-guard, and the broker-down/non-tty/empty conditionals. This is the riskiest structural piece — get it standing before any view content.
4. Build PEERS + preview + copy-menu (phase 1) against the real `Client`.
5. Write the pure-fn tests as you go (roster grouping, preview, copy-command assembly), and walk the never-trap checklist in a real terminal before declaring phase 1 done.

Then proceed phase by phase, holding the full affordance bar and the four invariants as the gate at each step.

---

## 14. Audit deltas (2026-07-16, pre-build verification against the tree)

Every §5/§8 claim was checked against the actual source and the published
`ink-terminal@0.1.0-alpha.1` tarball before building. The cheat-sheet and data
contracts held up; these are the corrections and the load-bearing facts the
sections above miss.

**Hidden scope (the one big one).**
- **ink-terminal ships NO text-input component** — its components are Box, Text,
  Button, ScrollBox, VirtualList, Link, FileLink, Spacer, AlternateScreen,
  Newline, NoSelect, RawAnsi (verified against the package). D7c's in-app
  textarea therefore means **hand-rolling an editable text widget** on
  `useInput` + the paste event (cursor nav, insert/delete, wrapping). Decision:
  build it as a shared `src/tui/widgets/` primitive — the compose body needs the
  multi-line form, the recipient filter needs the single-line form, and the D10
  starter kit wants it anyway. Scope it consciously in phase 1 (single-line) and
  phase 3 (multi-line); do not discover it mid-modal.

**Plan corrections.**
- **Bare-shell identity (§4): the "prompt once for a --from" MUST be a picker
  over registered aliases, never free text.** A name that isn't registered
  cannot send under strict mode (`router.ts` `not_registered`), and the CLI's
  own `register` refuses outside a session (`cli.ts` requires
  `CLAUDE_CODE_SESSION_ID`). Acting as an existing alias works because the
  tokens dir (`~/.claude-ipc/tokens`) is shared per-user — the app reads that
  alias's token like any sibling process. Show a persistent "acting as X"
  status-bar note while in this mode.
- **Per-peer preview counts (§10 phase 1) work by the same mechanism** — the
  dashboard peeks `check(alias, consume=false)` with the peer's own token from
  the shared dir. State it, scope it: live/idle peers only (never the offline
  graveyard), `Promise.all`, never consume, and a token-file miss (pruned by
  `registry.pruneOffline`, which deletes token files) renders "?" — not a crash.
- **No broker op lists my open asks.** The §7 `cancel` surface ("sent/awaiting"
  filter) and any owed-to-me display must be derived client-side: my sent
  query/requests from `history({peer: me, since})` minus those with a terminal
  response (`corrId` match). Name it as a pure view-model fn and test it.
- **`history()` is uncapped** (`sqliteBackend.history` has no LIMIT; the only
  bound is 7-day retention). Every dashboard use of history MUST pass `since`
  (default: last 24h) — never poll the full table every 5s.
- **The send path has NO broker-side empty-body guard** (only `reply` has
  `empty_reply`). The compose UI's "never sends zero bytes" is the *only* line
  of defense for send — treat that guard as load-bearing, not belt-and-braces.
- **Body sanitization is mandatory in the view-model.** The tail/monitor
  control-char gap is still open (`monitor.ts` renders a raw `body.slice`);
  commit 3e5ed62 fixed the hook context renderer and the tab title, not this.
  Strip/neutralize control bytes and newlines in every body and alias the TUI
  renders; don't rely on ink-terminal's Text.
- **Toolchain gaps:** tsconfig needs `"jsx": "react-jsx"` (+ `@types/react`
  dev-dep); peers are `react ^19.0.0` AND `react-reconciler ^0.33.0` — pin
  react exact alongside ink-terminal. Keep `src/tui/` imported only from the
  `-i` case so the three hook binaries never pull React.
- **Extract `daemon start` into a helper** — its compiled-vs-source relaunch
  logic is inline in `cli.ts`; the broker-down `[d]` action reuses it, not
  duplicates it.
- **The dashboard never heartbeats** its acting alias. A viewer is not
  liveness; heartbeating would repaint an idle session as live to every peer.

**Verified clean (no action).** All §8 Client signatures; BrokerError{code,data}
on every refusal; `list()` computes `sessionAliases` and strips tokens
server-side; peek-don't-consume leaves hook delivery + tab badges untouched
(notify fires only on consume); `readAliasForSession` identity path; reply-by
presets match broker defaults (5m); `Client(sock, undefined, scratchDir)` test
isolation; bun 1.3.14 gate result reproduced in the research doc; every §5 API
verified present in the tarball — `render`/`createRoot`/`renderSync`,
`waitUntilExit`, AlternateScreen `mouseTracking` (default true), `onClick`/
`onMouse*` event props, ScrollBox, VirtualList, FocusManager, useInterval,
useInput, useTerminalViewport, useTerminalTitle, FileLink, buildEditorUri,
measureElement.
