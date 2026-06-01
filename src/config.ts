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

  // Default TTL for a directed query/request when the sender gives none. null
  // (the default) means it stays open until answered — set CLAUDE_IPC_DEFAULT_TTL_S
  // to auto-time-out unanswered asks after N seconds.
  defaultTtlS: process.env.CLAUDE_IPC_DEFAULT_TTL_S ? Number(process.env.CLAUDE_IPC_DEFAULT_TTL_S) : null,
  requestTimeoutMs: 5000, // a single broker round-trip; exceeded → caller stops waiting
  sweepIntervalS: 5,
  retentionS: Number(process.env.CLAUDE_IPC_RETENTION_S) || 7 * 24 * 3600, // purge settled msgs older than this
  registryRetentionS: Number(process.env.CLAUDE_IPC_REGISTRY_RETENTION_S) || 24 * 3600, // drop peers offline longer than this

  // Strict identity: a send's `from` must be a registered alias, closing the
  // "forge a message from an alias nobody registered yet" window. On by default
  // (real sessions register via the SessionStart hook); set =0 to allow ad-hoc
  // unregistered senders (e.g. quick CLI tests).
  strict: (process.env.CLAUDE_IPC_STRICT ?? "1") !== "0",

  liveness: { idleS: 300, offlineS: 1800 },
  badge: (process.env.CLAUDE_IPC_BADGE ?? "1") !== "0", // broker→peer-TTY tab badge
  allowlist: parseAllowlist(process.env.CLAUDE_IPC_ALLOWLIST), // {target: [allowed senders]}
} as const;
