# Hardening backlog: 2026-09-25

## Purpose

This backlog records follow up work found during the managed Codex deployment and performance audit. Each row describes a failure boundary and the evidence needed to close it.

| Priority | Work | Why it matters | Closure evidence |
| --- | --- | --- | --- |
| P0 | Make the installed `codex-gcc` launcher start the managed host when proactive IPC is requested. | The managed host exists, but the normal Codex launcher does not select it. Users can miss the new receive path unless they remember a separate command. | A fresh `codex-gcc` session registers one managed owner and receives project and personal mail without manual setup. |
| P0 | Pin App Server compatibility with a real installed Codex smoke test. | Codex 0.156.1 rejected the older `thread/read` history path although mocks accepted it. | A release gate starts the installed CLI, persists one IPC delivery, resumes the thread, and reconciles it exactly once. |
| P1 | Add an incremental history cursor for managed delivery reconciliation. | `thread/turns/list` currently scans all turns. Long threads increase delivery latency and App Server traffic. | A benchmark on a 1,000 turn thread shows bounded pages per delivery, including restart recovery. |
| P1 | Back off repeated host errors and aggregate identical log lines. | A protocol failure currently logs once per second. This obscures the first error and grows logs during an outage. | A forced incompatible method produces bounded retries and one summary with count and duration. |
| P1 | Exercise App Server loss while the TUI remains active. | Reconnect logic is implemented, but a real process test has not killed only the delivery WebSocket during an active turn. | Mail remains unacknowledged during loss, reconnects, persists once, and reaches the same thread. |
| P1 | Exercise top level navigation and subagent isolation in a live TUI. | The host follows top level threads and rejects subagent candidates using notification metadata. | A live navigation test proves ownership moves once and subagent activity never receives project or personal mail. |
| P1 | Record explicit audit events for lease, persistence, acknowledgement, supersession, and cancellation. | Current state is queryable, but reconstructing the reason for a transition can require several tables and logs. | `status` shows timestamped actors and causes for every delivery transition. |
| P2 | Benchmark sweeps with large retained state. | Sweep jobs scan open asks, registry entries, and marker directories. No load test identifies the first nonlinear threshold. | Published results for 10k, 100k, and 1m messages with a defined time and memory budget. |
| P2 | Evaluate one multicall binary for CLI and hook entrypoints. | Four compiled Bun binaries occupy about 245 MiB. | A prototype measures startup latency, installed size, and launchd compatibility before any migration. |
| P2 | Define cancellation visibility for stale project nudges. | A canceled or superseded project ask can still leave human facing context without a direct retraction event. | Recipient scenarios show a clear cancellation or supersession state at every delivery rung. |
