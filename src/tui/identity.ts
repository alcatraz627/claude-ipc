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

/** One pickable identity, carrying enough session context to tell lookalikes apart. */
export interface ActingCandidate {
  alias: string;
  sessionId: string;
  status: RegistryEntry["status"];
  cwd: string;
  siblings: string[]; // the session's other aliases — "two names, one lane" made visible
  service: boolean;
  sinceSeenS?: number;
}

export function sessionIdentity(): Identity | null {
  // Mirrors cli.ts resolveSelfAlias (import would cycle): explicit override, then side-file.
  const alias = process.env.CLAUDE_IPC_ALIAS || readAliasForSession(process.env.CLAUDE_CODE_SESSION_ID);
  return alias ? { alias, mode: "session" } : null;
}

/** The human owner's sentinel identity — registered `--service`, never a session's name. */
export const USER_SENTINEL = "user";

/**
 * Aliases the dashboard could act as: registered peers whose capability token is
 * readable in the shared per-user tokens dir. Hygiene: the dead-alias graveyard
 * is cut unless asked for (or unless it is ALL there is — an empty picker is a
 * dead end); the `user` sentinel outranks everything, then live before idle.
 */
export function actingCandidates(peers: RegistryEntry[], includeOffline = false): ActingCandidate[] {
  const rank: Record<string, number> = { live: 0, idle: 1, offline: 2 };
  const held = peers.filter((p) => existsSync(join(config.tokensDir, encodeURIComponent(p.alias))));
  const alive = held.filter((p) => p.status !== "offline");
  const pool = includeOffline || alive.length === 0 ? held : alive;
  return pool
    .map((p) => ({
      alias: p.alias,
      sessionId: p.sessionId,
      status: p.status,
      cwd: p.cwd,
      siblings: (p.sessionAliases ?? []).filter((a) => a !== p.alias),
      service: p.service === true,
      sinceSeenS: p.sinceSeenS,
    }))
    .sort(
      (a, b) =>
        Number(b.alias === USER_SENTINEL) - Number(a.alias === USER_SENTINEL) ||
        (rank[a.status] ?? 3) - (rank[b.status] ?? 3) ||
        (a.sinceSeenS ?? Infinity) - (b.sinceSeenS ?? Infinity) ||
        a.alias.localeCompare(b.alias),
    );
}

