/**
 * SessionStart hook: register this session and drain its offline backlog.
 *
 * Fires on startup and on resume. Registering re-binds the alias so peers can
 * reach it; draining replays messages that queued while the session was gone,
 * delivering the "leave a note for an agent that's not running yet" guarantee.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAliasForSession } from "../aliasStore.ts";
import { ttyForPid } from "../badge.ts";
import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, deliverContext, emitContext, formatRoster, readHookInput } from "./shared.ts";

/** Transient/headless sessions shouldn't join the roster — sub-agents and
 *  `claude -p` runs (typically from a temp cwd) would pile up as dead peers. */
function isEphemeral(cwd: string): boolean {
  return config.noRegister || /^\/(private\/)?(tmp|var\/folders)\//.test(cwd);
}

export async function main(): Promise<void> {
  const input = await readHookInput();
  const cwd = input.cwd ?? process.cwd();
  if (isEphemeral(cwd)) return; // don't register transient sessions
  const alias = aliasFor(input);
  const client = new Client(config.socketPath, { dbPath: config.dbPath });

  // Bridge session id → friendly alias so the per-turn hooks (which never see the
  // title) poll this same mailbox. Only when the two differ: a session with no
  // title resolves to its raw id and needs no mapping (unchanged behavior).
  if (input.session_id && alias !== input.session_id) {
    writeAliasForSession(input.session_id, alias);
  }

  // Capture this session's transcript path for the MCP send path to attach as a
  // contextPtr — the hook is the only place it's natively available.
  if (input.transcript_path) {
    try {
      mkdirSync(config.metaDir, { recursive: true });
      writeFileSync(join(config.metaDir, encodeURIComponent(alias)), input.transcript_path);
    } catch {
      // best-effort side channel; a missing transcript pointer is non-fatal
    }
  }

  // Registration needs the live broker (the registry is in-broker) — best-effort.
  // If the broker refuses because another session owns this alias and we can't
  // prove ownership, the mailbox isn't ours: draining it would hand their mail to
  // us. Track ownership and gate the drain on it. Broker-down is a different error
  // — the drain still works off local SQLite there, so ownership stays true.
  let owned = true;
  try {
    await client.register(alias, {
      sessionId: input.session_id ?? `hook-${alias}`,
      cwd: input.cwd ?? process.cwd(),
      pid: process.ppid, // the Claude process
      // Resolve the tty here (in this short-lived hook) rather than letting the
      // broker spawn `ps` on its event loop. Explicit env override wins.
      tty: process.env.CLAUDE_IPC_TTY ?? ttyForPid(process.ppid) ?? undefined,
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("alias_taken")) {
      owned = false;
      console.error(`[claude-ipc] "${alias}" is owned by another session; not draining (name collision).`);
    }
    // else: broker down at startup — the backlog drain below still works off the
    // durable log, so the offline-note guarantee holds.
  }

  // Drain the offline backlog independently: degraded mode reads it from SQLite,
  // so a session started while the broker is down still receives its queued notes.
  // Skipped when the alias is owned by another session — never drain their mailbox.
  let backlog: string | null = null;
  try {
    if (owned) backlog = await deliverContext(client, alias, "resume");
  } catch (e) {
    // Don't block startup — but log to stderr so a buggy drain (broker up) is
    // visible in the hook debug log rather than silently dropping the backlog.
    console.error("[claude-ipc] SessionStart drain:", e instanceof Error ? e.message : e);
  }

  // Roster of who else is registered, so this session ambiently knows its peers.
  // Silent when alone; needs the live broker (no roster in degraded mode).
  let roster: string | null = null;
  try {
    const peers = (await client.list()).peers as { alias: string; cwd: string; status: string }[];
    roster = formatRoster(peers, alias);
  } catch {
    // broker down — skip the roster, the backlog drain above still works
  }

  const parts = [backlog, roster].filter((p): p is string => p !== null);
  if (parts.length) emitContext("SessionStart", parts.join("\n\n"));
}

if (import.meta.main) void main();
