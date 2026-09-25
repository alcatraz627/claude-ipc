# Performance audit: 2026-09-25

## Scope

This audit measures the deployed local broker and reviews the hot paths added for managed Codex delivery. Measurements ran on the owner's Mac against the launchd broker built from merge commit `11a06cf`.

## Command latency

Each row contains 30 sequential runs of the compiled CLI against the live Unix socket.

| Command | Minimum | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| `daemon status` | 28.75 ms | 29.22 ms | 29.86 ms | 30.07 ms |
| `peers` | 28.93 ms | 30.04 ms | 31.26 ms | 31.30 ms |
| `projects` | 29.52 ms | 29.99 ms | 31.22 ms | 31.47 ms |
| `asks --all --json` | 32.44 ms | 34.26 ms | 35.67 ms | 36.69 ms |

Process startup dominates these commands. The four medians span 5.04 ms despite different broker queries.

## Broker footprint

An idle snapshot after the benchmark reported 61,424 KiB resident memory and 0.0% CPU for PID 60219. The compiled CLI is 62 MiB. Each compiled hook binary is 61 MiB.

The four standalone executables duplicate most of the Bun runtime on disk. This costs about 245 MiB across the CLI and hooks. Reducing this footprint needs a deployment design that preserves hook startup time and runtime isolation.

## Managed host path

The managed host polls once per second while the thread is idle. After `turn/start`, it checks persistence every 25 ms until the delivery IDs appear or the delivery deadline expires.

Codex 0.156.1 no longer supports full turn hydration through `thread/read`. The host now pages through `thread/turns/list` with 100 full turns per request. This preserves restart reconciliation, but history scan cost grows with thread length because every delivery refresh starts at the first page.

## Findings

1. CLI latency is stable at 29 to 35 ms for the measured read paths.
2. Idle broker CPU was below the process snapshot's reporting precision.
3. Compiled binary duplication is the largest measured storage cost.
4. Managed delivery history scanning is the clearest scaling risk. Long Codex threads can require many App Server pages per delivery and per 25 ms persistence check.
5. The broker's sweeper reads all open awaiting rows and marker directories on each sweep. Current local scale is small, but no large state benchmark covers that work.

## Reproduction

The command benchmark used 30 `Bun.spawnSync` runs per CLI command. Process footprint came from `ps`; binary sizes came from `du -h dist/claude-ipc dist/ipc-*`. The process ID is deployment specific.
