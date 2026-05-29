# 00 · Host facts (Phase 0 spike)

> Empirical + doc-grounded confirmation of the Claude Code host assumptions the
> design rests on. Verified 2026-05-29 against Claude Code **v2.1.156**. Re-check
> on host upgrades — facts marked *(docs)* are validated against documentation
> and get an empirical test in the phase that first depends on them.

| # | Assumption | Status | Evidence / impact |
|---|------------|--------|-------------------|
| 1 | UPS/SessionStart hooks receive `session_id`,`cwd`,`transcript_path` on stdin and inject context via `additionalContext` | ✅ *(docs)* | Hooks reference. Empirical test in Phase 5 when hooks are built. |
| 2 | SessionStart fires on `resume` with a stable `session_id` | ✅ *(docs)* | Enables offline-queue replay on resume (FR8/SC3). |
| 3 | Transcript JSONL is appended **live** during a session | ✅ empirical | This session's transcript `ed7207c0….jsonl` actively grew (553 lines, live mtime) while open. Cross-session `tail -f` confirm deferred to Phase 5. Validates one agent reading another's output (FR13). |
| 4 | `--channels` push into a running session is available | ❌ not in v2.1.156 | `claude --help` shows no channel flag. **Impact:** the top delivery-ladder rung is unavailable now — build on the UPS-hook rung (always works); treat channels as a feature-detected future upgrade. May be gated behind an env/newer version — revisit on upgrade. |
| 5 | Each stdio MCP server spawns **one instance per session** | ✅ *(docs)* | MCP reference. **Impact:** the stdio MCP is a thin per-session client; shared state lives in the broker (architecture D5). |

## Toolchain

- **Python:** system is 3.9.6 (lacks `StrEnum` and other 3.11 features the models
  use). `uv` is installed → the project pins `requires-python >=3.11` and uv
  provisions a conforming interpreter. Do not run against system python directly.
- **uv:** present at `~/.local/bin/uv`.

## Net design impact

No architectural rework. The delivery ladder already treats channels as optional;
Phase 0 simply confirms we ship on the hook rung first. Channels becomes a
Phase 7 enhancement guarded by feature detection.
