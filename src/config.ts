/** Runtime configuration: where the broker lives and how it ages peers. */

import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.CLAUDE_IPC_HOME ?? join(homedir(), ".claude-ipc");

/** Parse `{"privileged":["auto-fe"]}` from env; empty/invalid = no restriction. */
function parseAllowlist(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
}

export const config = {
  home,
  socketPath: process.env.CLAUDE_IPC_SOCKET ?? join(home, "run", "ipc.sock"),
  dbPath: process.env.CLAUDE_IPC_DB ?? join(home, "data", "ipc.sqlite"),
  pidPath: join(home, "run", "broker.pid"),
  logPath: join(home, "logs", "broker.log"), // broker's own size-rotated operational log
  tokensDir: join(home, "tokens"), // per-alias capability files (0600), owner-only

  defaultTtlS: 3600,
  requestTimeoutMs: 5000, // a single broker round-trip; exceeded → caller stops waiting
  sweepIntervalS: 5,
  retentionS: Number(process.env.CLAUDE_IPC_RETENTION_S) || 7 * 24 * 3600, // purge settled msgs older than this

  liveness: { idleS: 300, offlineS: 1800 },
  badge: (process.env.CLAUDE_IPC_BADGE ?? "1") !== "0", // broker→peer-TTY tab badge
  allowlist: parseAllowlist(process.env.CLAUDE_IPC_ALLOWLIST), // {target: [allowed senders]}
} as const;
