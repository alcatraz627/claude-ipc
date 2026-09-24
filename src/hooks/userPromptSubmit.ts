/**
 * UserPromptSubmit hook: surface pending IPC messages at the recipient's next turn.
 *
 * This is the always-available delivery rung. It injects each pending message
 * exactly once and never blocks the prompt — if the broker is down it stays
 * silent rather than failing the turn.
 */

import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, bootDigest, deliverContext, emitContext, markOrphanShown, orphanAlreadyShown, readHookInput } from "./shared.ts";

/**
 * The full boot briefing, delivered here when SessionStart never ran.
 *
 * Whether the platform re-fires SessionStart on a resume is an assumption we
 * can't verify (B7) — so it no longer matters: whichever hook runs first claims
 * the shared marker and delivers the same digest + orphan note. The marker is
 * claimed BEFORE building so a partial failure can't become an every-turn nag.
 */
async function bootOnce(client: Client, input: { session_id?: string }, self: string, cwd: string): Promise<string | null> {
  const sessionId = input.session_id;
  if (!sessionId || orphanAlreadyShown(sessionId)) return null;
  markOrphanShown(sessionId);
  const pieces: string[] = [];
  try {
    pieces.push(await bootDigest(client, self, sessionId, cwd));
  } catch {
    // digest is broker-dependent past its first line; the orphan note below may still work
  }
  // The orphan note is best-effort on its own: this whole briefing is marker-gated
  // and fires once, so an orphans() failure must NOT discard a digest already built.
  try {
    // Chase notices don't count as mail: a box holding only the broker's own stale
    // nudges is not inherited work and doesn't earn a nag (it stays in the orphans verb).
    const rows = (((await client.orphans(cwd)) as { orphans?: { alias: string; pending: number; chases?: number }[] }).orphans ?? [])
      .map((o) => ({ alias: o.alias, real: o.pending - (o.chases ?? 0) }))
      .filter((o) => o.real > 0);
    if (rows.length) {
      pieces.push(
        `claude-ipc: ${rows.length} dead mailbox(es) in this project still hold mail ` +
          `(e.g. ${rows[0]!.alias}, ${rows[0]!.real} msg${rows[0]!.real === 1 ? "" : "s"}) — see: claude-ipc orphans --project`,
      );
    }
  } catch {
    // orphan discovery failed — the digest already in pieces still ships
  }
  return pieces.length ? pieces.join("\n\n") : null;
}

export async function main(): Promise<void> {
  const input = await readHookInput();
  if (config.managedCodexHost) return;
  try {
    // Fall back to the durable SQLite log when the broker is down, so a pending
    // message still surfaces at the next turn instead of being silently skipped.
    const client = new Client(config.socketPath, { dbPath: config.dbPath });
    const cwd = input.cwd ?? process.cwd();
    const parts: string[] = [];
    const self = aliasFor(input);
    const ctx = await deliverContext(client, self, "hook", cwd);
    if (ctx) parts.push(ctx);
    try {
      const note = await bootOnce(client, input, self, cwd);
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
