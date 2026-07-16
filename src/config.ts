/** Runtime configuration: where the broker lives and how it ages peers. */

import { homedir } from "node:os";
import { join } from "node:path";

// `||` on purpose: an empty CLAUDE_IPC_HOME means "default", matching the shell
// scripts' ${VAR:-default} — `??` would accept "" and scatter relative paths.
const home = process.env.CLAUDE_IPC_HOME || join(homedir(), ".claude-ipc");

/** A numeric env knob, preserving a deliberate 0 (which `Number(x) || d` would drop). */
export function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

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
  metaDir: join(home, "meta"), // per-alias side-channel the hook writes (e.g. transcript path)
  aliasDir: join(home, "alias-by-sid"), // session_id → friendly alias, so per-turn hooks poll the mailbox peers address
  blockedDir: join(home, "blocked"), // per-message markers: this ask already fired its one Stop-hook turn-end block

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

  // Transient/headless sessions opt out of joining the roster (set by a launcher
  // for sub-agents / `claude -p` runs that shouldn't appear as addressable peers).
  noRegister: process.env.CLAUDE_IPC_NO_REGISTER === "1",

  // How long since a peer's last heartbeat before it reads idle, then offline.
  // Env-tunable so a test (or a fast-moving deployment) can shrink the windows;
  // the offline threshold is also what marks a recipient "dark" for ghost escalation.
  liveness: {
    idleS: envNum("CLAUDE_IPC_IDLE_S", 300),
    offlineS: envNum("CLAUDE_IPC_OFFLINE_S", 1800),
  },

  // How long a sender waits before the broker chases their unanswered ask. At
  // reply-by the recipient's mailbox gets a nudge; finalGraceS later they get a last
  // call and the SENDER is released to act without an answer. Per-send override with
  // `--reply-by 90s` / `--reply-by none`. Nothing here asks whether the recipient is
  // alive, and no notice ever claims they are gone: docs/notes/no-liveness-claims.md
  reply: {
    byS: envNum("CLAUDE_IPC_REPLY_BY_S", 300),
    finalGraceS: envNum("CLAUDE_IPC_REPLY_FINAL_GRACE_S", 600),
  },

  // The human's editor, for the dashboard's compose escalation. Standard
  // VISUAL/EDITOR contract; vi is the POSIX-safe fallback.
  editor: process.env.VISUAL || process.env.EDITOR || "vi",

  // Where `claude-ipc feedback` files reports: the maintainer repo's project
  // mailbox, which waits across maintainer absence and broker downtime. The
  // default is THIS machine's checkout — off-host, set CLAUDE_IPC_FEEDBACK_ADDR.
  feedbackAddr: process.env.CLAUDE_IPC_FEEDBACK_ADDR ?? "proj:/Users/alcatraz627/Code/Claude/claude-ipc",

  badge: (process.env.CLAUDE_IPC_BADGE ?? "1") !== "0", // broker→peer-TTY tab badge
  allowlist: parseAllowlist(process.env.CLAUDE_IPC_ALLOWLIST), // {target: [allowed senders]}
} as const;
