/**
 * UserPromptSubmit hook: surface pending IPC messages at the recipient's next turn.
 *
 * This is the always-available delivery rung. It injects each pending message
 * exactly once and never blocks the prompt — if the broker is down it stays
 * silent rather than failing the turn.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, deliverContext, emitContext, readHookInput } from "./shared.ts";

/**
 * Once per session, name the dead mailboxes still holding this project's mail —
 * the safety net under the register-time surfacing, which a session that never
 * fires a fresh SessionStart register (checkpoint resumes were the suspected
 * case) would otherwise miss entirely. The marker is written BEFORE the note is
 * built so a partial failure can never turn this into an every-turn nag.
 */
async function orphanNoteOnce(client: Client, sessionId: string | undefined, cwd: string): Promise<string | null> {
  if (!sessionId) return null;
  const dir = join(config.metaDir, "orphan-shown");
  const marker = join(dir, encodeURIComponent(sessionId));
  if (existsSync(marker)) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, String(Date.now()));
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
