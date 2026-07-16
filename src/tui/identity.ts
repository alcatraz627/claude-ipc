/**
 * Who the dashboard acts as. Inside a Claude session that's the session's own
 * alias, resolved the same way every hook does it. From a bare shell the human
 * picks an existing registered alias to act as — never free text: an
 * unregistered name can't send under strict mode, so offering one would be a
 * dead end at the last step. Every action then carries that identity.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAliasForSession } from "../aliasStore.ts";
import { config } from "../config.ts";
import type { RegistryEntry } from "../models.ts";

export interface Identity {
  alias: string;
  // "session" = this shell IS a registered session; "acting-as" = a human
  // borrowed an alias (shown in the status bar); "none" = read-only.
  mode: "session" | "acting-as" | "none";
}

export function sessionIdentity(): Identity | null {
  const alias = readAliasForSession(process.env.CLAUDE_CODE_SESSION_ID);
  return alias ? { alias, mode: "session" } : null;
}

/**
 * Aliases the dashboard could act as: registered peers whose capability token
 * is readable in the shared per-user tokens dir. Live sessions first.
 */
export function actingCandidates(peers: RegistryEntry[]): string[] {
  const rank: Record<string, number> = { live: 0, idle: 1, offline: 2 };
  return peers
    .filter((p) => existsSync(join(config.tokensDir, encodeURIComponent(p.alias))))
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.lastSeen - a.lastSeen)
    .map((p) => p.alias);
}
