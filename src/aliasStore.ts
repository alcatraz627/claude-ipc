/**
 * The durable session → alias map that lets every hook agree on one identity.
 *
 * A session's friendly name is only handed to the SessionStart hook (as the
 * session title); the per-turn UserPromptSubmit and Stop hooks see only the raw
 * session id. Without a bridge they would poll the UUID mailbox while peers send
 * to the friendly name, and mail would sit undelivered. SessionStart records the
 * resolved alias here keyed by session id, and every later hook reads it back, so
 * all three hooks poll the one mailbox peers actually address.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.ts";

/** A session-id keyed file; the id is a UUID, so it is always a safe file name. */
const aliasFile = (sessionId: string): string => join(config.aliasDir, encodeURIComponent(sessionId));

/**
 * The friendly alias last bound to this session, or undefined if none.
 *
 * Undefined means "no side-file yet" — the caller falls back to the raw session
 * id, which is the pre-side-file behavior (a session with no title is addressable
 * by its UUID exactly as before).
 */
export function readAliasForSession(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    return readFileSync(aliasFile(sessionId), "utf8").trim() || undefined;
  } catch {
    return undefined; // no mapping recorded — fall back to the raw id
  }
}

/** Bind this session id to a friendly alias for later hooks to read. Best-effort. */
export function writeAliasForSession(sessionId: string, alias: string): void {
  try {
    mkdirSync(config.aliasDir, { recursive: true });
    writeFileSync(aliasFile(sessionId), alias);
  } catch {
    // best-effort side channel; a missing mapping just falls back to the raw id
  }
}

/**
 * Normalize a session title into an alias, or undefined if it can't be one.
 *
 * The title is used as the alias verbatim (trimmed) so the name a human sees on
 * the tab is the name they message — no hidden slugging. Empty/whitespace titles
 * and an over-long title (capped) are rejected so they fall through to the id.
 */
export function sanitizeAlias(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  return t.length > 64 ? t.slice(0, 64) : t;
}

/** Lowercase kebab slug of a path segment, or "" if nothing usable survives. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * A stable, human-friendly name for a session that never claimed one.
 *
 * The old last resort was the raw session UUID, so most sessions were reachable
 * only by an id nobody would type. This gives a readable default (a `.claude`
 * session becomes `claude-4fd4ca0e`): the directory name plus an 8-char id fragment.
 * Eight chars (the full leading UUID segment) keeps it effectively unique, so two
 * sessions in one directory never collide onto one mailbox and steal each other's
 * mail. Deterministic from its inputs, so every hook derives the same name uncoordinated.
 */
export function deriveAlias(cwd: string | undefined, sessionId: string | undefined): string {
  const base = slug(basename(cwd ?? ""));
  const tag = (sessionId ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
  if (base && tag) return `${base}-${tag}`;
  return base || tag || "session";
}
