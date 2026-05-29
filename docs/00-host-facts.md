# 00 · Host facts (Phase 0 spike)

> Empirical + doc-grounded confirmation of the Claude Code host assumptions the
> design rests on. Verified 2026-05-29 against Claude Code **v2.1.156**. Re-check
> on host upgrades — facts marked *(docs)* are validated against documentation
> and get an empirical test in the phase that first depends on them.

| # | Assumption | Status | Evidence / impact |
|---|------------|--------|-------------------|
| 1 | UPS/SessionStart hooks receive `session_id`,`cwd`,`transcript_path` on stdin and inject context via `additionalContext` | ✅ *(docs)* | Hooks reference. Empirical test in Phase 5 when hooks are built. |
| 2 | SessionStart fires on `resume` with a stable `session_id` | ✅ *(docs)* | Enables offline-queue replay on resume (FR8/SC3). |
| 3 | Transcript JSONL is appended **live** during a session | ✅ empirical (same-session) | This session's transcript `ed7207c0….jsonl` actively grew (553 lines, live mtime) while open. **CROSS-session** read (one `claude` reading another live session's file) + path stability across `/compact` move to **Phase 1** to confirm (cheap) before FR13 depends on it. Mitigation: a `context_ptr` stores `session_id` and resolves the path at read time, since transcript paths can change on compaction (review #16). |
| 4 | `--channels` push into a running session is available | ❌ not in v2.1.156 | `claude --help` shows no channel flag. **Impact:** the top delivery-ladder rung is unavailable now — build on the UPS-hook rung (always works); treat channels as a feature-detected future upgrade. May be gated behind an env/newer version — revisit on upgrade. |
| 5 | Each stdio MCP server spawns **one instance per session** | ✅ *(docs)* | MCP reference. **Impact:** the stdio MCP is a thin per-session client; shared state lives in the broker (architecture D5). |

## Toolchain

- **Runtime:** Bun 1.3.14 at `/opt/homebrew/bin/bun` (verified). Provides
  built-in SQLite (`bun:sqlite`), test runner (`bun:test`), Unix-socket
  primitives (`Bun.listen`/`Bun.connect`), and `bun build --compile` for
  standalone binaries.
- **Language decision:** Bun + TypeScript chosen over Python — compile-to-binary
  removes the per-prompt hook startup cost and runtime/version drift (the system
  python was 3.9, lacking required features), alongside the most mature MCP SDK
  and zero-dep SQLite. See `04-technical-implementation.md` §1.

## Net design impact

No architectural rework. The delivery ladder already treats channels as optional;
Phase 0 simply confirms we ship on the hook rung first. Channels becomes a
Phase 7 enhancement guarded by feature detection.
