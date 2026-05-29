#!/usr/bin/env bun
/**
 * Command-line entry point for claude-ipc.
 *
 * The human's thin client for sending, inspecting, and approving messages, plus
 * broker control. The full verb set arrives in Phase 4; this stub keeps the
 * `claude-ipc` entry point runnable and gives a clear status until then.
 */

export function main(_argv: string[]): number {
  console.log("claude-ipc: CLI is implemented in Phase 4 (see docs/05-roadmap.md).");
  return 0;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
