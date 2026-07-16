/**
 * UserPromptSubmit hook: surface pending IPC messages at the recipient's next turn.
 *
 * This is the always-available delivery rung. It injects each pending message
 * exactly once and never blocks the prompt — if the broker is down it stays
 * silent rather than failing the turn.
 */

import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, deliverContext, emitContext, markOrphanShown, orphanAlreadyShown, readHookInput } from "./shared.ts";

/**
 * The fallback under the register-time orphan surfacing: a session that resumed
 * without a fresh SessionStart never got that note, so name the dead mailboxes
 * here instead. Skips when SessionStart already showed it (shared marker), so a
 * fresh session is never told twice. The marker is claimed BEFORE building the
 * note so a partial failure can't turn this into an every-turn nag.
 */
async function orphanNoteOnce(client: Client, sessionId: string | undefined, cwd: string): Promise<string | null> {
  if (!sessionId || orphanAlreadyShown(sessionId)) return null;
  markOrphanShown(sessionId);
  const list = (((await client.orphans(cwd)) as { orphans?: { alias: string; pending: number }[] }).orphans ?? []).filter(
    (o) => o.pending > 0,
  );
  if (!list.length) return null;
  return (
    `claude-ipc: ${list.length} dead mailbox(es) in this project still hold mail ` +
    `(e.g. ${list[0]!.alias}, ${list[0]!.pending} msg${list[0]!.pending === 1 ? "" : "s"}) — see: claude-ipc orphans --project`
  );
}

export async function main(): Promise<void> {
  const input = await readHookInput();
  try {
    // Fall back to the durable SQLite log when the broker is down, so a pending
    // message still surfaces at the next turn instead of being silently skipped.
    const client = new Client(config.socketPath, { dbPath: config.dbPath });
    const cwd = input.cwd ?? process.cwd();
    const parts: string[] = [];
    const ctx = await deliverContext(client, aliasFor(input), "hook", cwd);
    if (ctx) parts.push(ctx);
    try {
      const note = await orphanNoteOnce(client, input.session_id, cwd);
      if (note) parts.push(note);
    } catch {
      // advisory only — a down broker or unwritable marker never costs the turn
    }
    if (parts.length) emitContext("UserPromptSubmit", parts.join("\n\n"));
  } catch (e) {
    // Never block the turn — but log to stderr (the hook debug log, not the
    // turn output) so a broker-up-but-buggy deliver isn't invisible (NFR5).
    console.error("[claude-ipc] UserPromptSubmit hook:", e instanceof Error ? e.message : e);
  }
}

if (import.meta.main) void main();
