# `claude-ipc -i` — interactive dashboard design

Status: **DECIDED 2026-07-15** (owner answered the decision page; research at
`.claude/output/20260715-i-dashboard-research/web-research.md`). Building deferred.

> **Execution spec for the builder: `docs/notes/dashboard-build-plan.md`** — intent,
> the ink-terminal API cheat-sheet, data contracts, validation strategy, per-phase
> acceptance criteria, risks, and where to start. This design doc is the interaction
> contract; the build plan is the build order.

## Decisions (locked)

- **Architecture:** a real full-screen framework app, NOT an fzf-orchestration.
  fzf structurally can't show roster+inbox at once or run a back-steppable modal
  compose (confirmed against fzf's own docs) — so the earlier "every view is one
  fzf instance" build plan below is SUPERSEDED; treat it as the interaction spec,
  not the implementation.
- **Framework:** `ink-terminal` — the open-sourced extraction of Claude Code's own
  renderer (pure-TS Yoga, no WASM, Bun ≥1.0), so no language boundary and no
  `bun build --compile` WASM bug. Not vanilla ink, not a Go sidecar.
- **Gate:** prototype `bun build --compile` on an ink-terminal hello-world FIRST;
  only build the dashboard if it produces a working binary. Fallback if it fails:
  manual `yoga.wasm` copy in the build script (keeps the single binary).
- **Entry:** `claude-ipc -i` (+ `interactive` alias) on the existing binary. 5s
  auto-refresh, `R` forces.
- **Compose editor:** in-app textarea by default, a key to escalate to `$EDITOR`.
- **Scope:** phased by feature surface (peers+inbox+copy first, then compose, then
  projects/orphans/log) — but each phase built to the FULL V3 affordance bar:
  roster+inbox simultaneous, in-app modal compose, flicker-free live-refresh, the
  copy-any-field menu, mouse click-targets, and per-pane contextual keymaps.
- **gcc lesson:** extract a reusable V3-dashboard blueprint + a convention
  (ink-terminal starter, the four invariants, the compile-gate) alongside the
  existing fzf-launcher convention in `tui-design.md`.

## Design target: `revdiff`, not `zap`

The reference is `revdiff` — a full-screen **Bubble Tea / Lipgloss** application (Go +
charmbracelet): a persistent multi-panel layout (a tree panel + a content panel + a status
bar), modal navigation, mouse support, syntax highlighting. That is a genuine *dashboard*.
The `zap`/`zcmd` family is the tier below it — one-shot fzf pipelines with a preview pane,
good but rudimentary, and explicitly **not** the bar for this.

So this is not an fzf-reload-loop. It is a real full-screen TUI app: an alternate-screen
program with panels that hold state, a status bar, and keyboard (and mouse) navigation
between focus regions.

**Framework — the open decision.** `revdiff` is Go+Bubbletea, but `claude-ipc` is
TypeScript+bun. The natural fit that keeps one stack and one `bun build --compile` binary is
**Ink** (React-for-the-terminal, the JS analog of Bubble Tea, runs under bun). That gives
the panel/stateful/full-screen feel without a Go toolchain in a bun repo. Alternative: a Go
Bubbletea sidecar to match `revdiff` exactly, at the cost of a second stack. Recommendation:
Ink under bun. **Your call before any build.**

The four invariants below still hold; they are now rendered as panels and focus regions
rather than fzf binds. They exist because the current `compose` command (blocking
`prompt()`, one linear path) fails every one of them.

## The four invariants (the whole point)

1. **Never a dead end.** Every screen is a level. `Esc` pops one level up, never out of a
   sub-flow into a blank shell. Halfway through composing a message and change your mind →
   `Esc` steps back one field, then back to the list — you are never stranded.
2. **Never needs a restart.** One persistent outer loop. Every action (send, reply, accept,
   copy) completes and returns you to the list via an fzf `reload`, so the session lives
   until you `q`. The roster auto-refreshes on a timer, so it is a live view, not a snapshot.
3. **Covers everything the CLI does.** Every verb below is reachable without dropping to a
   raw shell: `peers · inbox · send · reply · accept · decline · snooze · cancel · projects ·
   orphans · log/history · status · register/rename · count · daemon`. (`serve` is the broker
   itself, out of scope.)
4. **Read / query / compose / copy, all in place.** A live preview pane reads full message
   bodies and peer details; `y` copies any field (alias · sid · cwd · msg-id · body · a
   ready-to-run command) to the clipboard; compose is a guided, always-escapable flow.

## Where it lives & how it's invoked

- **`claude-ipc -i`** (alias `claude-ipc interactive`) — a new case in `src/cli.ts` that
  launches the Ink app (in-process under bun, no exec hand-off; the whole thing compiles into
  the one `dist/claude-ipc` binary).
- **Identity is auto-resolved.** It reads this session's own alias the same way the CLI does
  (`alias-by-sid/$CLAUDE_CODE_SESSION_ID`), so `--from` is never typed. If the shell isn't a
  session (no sid), it asks once for a `--from` to act as, then holds it in app state.
- **Data source:** the app talks to the broker through the existing `Client` directly (no
  shelling out to itself), so the roster and inboxes are live objects it can poll and diff.

## Built on Ink (the pieces)

Ink gives the Bubble Tea equivalents: `<Box>` for the panel layout (flex-direction, borders,
widths — the tree/content/status split), `useInput` for the keymap and focus movement,
`useApp`/state for the modal navigation, and full-redraw on state change. A small palette
module mirrors the `std::claude::tui` color intent (theme-aware, truncation, tabular digits).
The non-tty / broker-down / empty states are React conditionals, not crashes.

## The screens (view hierarchy)

```
  ┌─ LEVEL 0 · home ───────────────────────────────────────────────┐
  │  PEERS  (the roster — live/idle first, offline collapsed)        │
  │  tab ↹ cycles views · ? help · q quit (guarded)                 │
  └────────────────────────────────────────────────────────────────┘
        ↹                ↹                ↹              ↹
   ┌────────┐      ┌──────────┐     ┌──────────┐   ┌──────────┐
   │ INBOX  │      │ PROJECTS │     │ ORPHANS  │   │  LOG     │  ← level-0 views
   │ (mine) │      │ (mboxes) │     │ (dead)   │   │ (flow)   │
   └────────┘      └──────────┘     └──────────┘   └──────────┘
        │
   ┌────────────── LEVEL 1 · compose (guided, escapable) ───────────┐
   │  recipient → kind → body → reply-by → confirm                   │
   │  Esc at any step = back one step; never abandons blindly        │
   └────────────────────────────────────────────────────────────────┘
```

**Every view is one fzf instance** with the same frame: a filterable list on the left, a
live preview on the right, a keybar at the bottom. `Tab` cycles the level-0 views. Actions
`--bind` to keys and `reload` the list in place.

### PEERS (home)
- List: `● alias   cwd-basename   last-seen`, live→idle→offline, offline collapsed to a
  `+N offline (o to expand)` row.
- Preview: `alias · sid (full) · cwd · status · last-seen · inbox: N unread / M owed · last
  msg`. This is the "find myself needing accurate ipc info" surface.
- Keys: `enter` send to selected · `r` reply to their last ask · `a` accept · `i` open their
  inbox · `y` copy menu · `/` filter · `R` refresh · `?` help · `q` quit.

### INBOX (mine)
- List of my messages, newest first, `kind from · corrId · body-head`.
- Preview: the **full body** (this is where an eaten/empty body would be obvious), plus
  thread context (the origin it answers).
- Keys by kind: a `query` → `enter` reply; a `request` → `a` accept / `d` decline; any →
  `s` snooze, `y` copy (id/body/reply-command), `Esc` back to home.

### PROJECTS / ORPHANS / LOG
- PROJECTS: project mailboxes with pending counts; `enter` opens that mailbox's inbox.
- ORPHANS: dead sessions of this cwd still holding mail; `enter` peeks; `y` copies the read
  command.
- LOG: recent flow (who → whom, kind), read-only, `y` copies. (Note: `log` currently breaks
  on a control-char body — a known open bug; the TUI will parse defensively.)

### COMPOSE (the anti-dead-end flow)
A stepped flow, each step its own picker, `Esc` = back one step:
1. **recipient** — fzf over live peers + a "project…" and "broadcast \*" option.
2. **kind** — `inform · query · request` (fzf).
3. **body** — opens `$EDITOR` (or a `gum write` fallback); empty body cancels the step, never
   sends zero bytes (the empty-reply bug, prevented at the UI).
4. **reply-by** — presets `5m · 15m · 1h · none` (only for query/request).
5. **confirm** — `tui_confirm` shows the assembled message + the deadline contract; `y` sends,
   anything else returns to step 4. On send, back to home with a toast.

## Copy (`y`) — the menu
`alias · session-id (full) · cwd · msg-id · body · "reply command" (a ready-to-paste
`claude-ipc reply … --from you`)`. Piped to `pbcopy`. This is why the dashboard beats the raw
CLI for the "I keep needing the sid / alias" pain.

## Degradation & the never-trap guarantees, concretely
- **No tty** → `tui_have_tty` fails → print "interactive mode needs a terminal" and exit 1.
- **fzf missing** → `tui_require fzf` prints the install line, exits. (gum optional; falls
  back to `read`.)
- **Broker down** → the home frame shows a `⚠ broker down` banner and a single action `[d]
  start daemon`; it does not crash or empty-out.
- **Empty roster / inbox** → a friendly empty state that still offers compose + refresh.
- **Quit guard** → at home, `q`/`Esc` runs `tui_confirm "quit?"` (default no), so you never
  drop out by a stray keypress — invariant #2.
- **Every action reloads the list**, so completion never leaves you at a bare prompt —
  invariant #1.

## Build plan (once approved) — SUPERSEDED

> **Do not build from this section.** It describes the abandoned fzf implementation.
> The real build order is `docs/notes/dashboard-build-plan.md` §10. Kept only as
> historical context for the phasing shape (which survived into D8).

1. `plugin/scripts/ipc-tui.sh` skeleton: the outer loop, the peers view, the preview, the
   quit-guard, tui-lib wiring, degradation ladder. (The riskiest part — the fzf frame.)
2. Copy menu + inbox view (read/query/copy — the everyday 80%).
3. Compose + reply/accept/decline/snooze actions.
4. Projects / orphans / log views.
5. `-i`/`interactive` case in `src/cli.ts` → `exec`. Docs + a `--help` entry.

Testing (per the handbook's test-without-a-tty guidance): each data-shaping function is
pure and unit-testable off a captured JSON fixture; the fzf frame is smoke-tested by piping
a fixture and asserting the rendered rows; the never-trap navigation is walked by hand
(a tty-only property).

## Open questions — ANSWERED 2026-07-15 (decision page)
- **Auto-refresh cadence** → 5s, `R` forces (D6).
- **`claude-ipc -i` vs a standalone `ipc` command** → `-i` on the existing binary (D5).
- **Editor for compose** → in-app textarea by default, a key escalates to `$EDITOR` (D7c).
