/**
 * UserPromptSubmit hook: surface pending IPC messages at the recipient's next turn.
 *
 * This is the always-available delivery rung. It injects each pending message
 * exactly once and never blocks the prompt — if the broker is down it stays
 * silent rather than failing the turn.
 */

import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, deliverContext, emitContext, readHookInput } from "./shared.ts";

export async function main(): Promise<void> {
  const input = await readHookInput();
  try {
    // Fall back to the durable SQLite log when the broker is down, so a pending
    // message still surfaces at the next turn instead of being silently skipped.
    const client = new Client(config.socketPath, { dbPath: config.dbPath });
    const ctx = await deliverContext(client, aliasFor(input), "hook");
    if (ctx) emitContext("UserPromptSubmit", ctx);
  } catch {
    // broker unreachable — inject nothing, never block the turn
  }
}

if (import.meta.main) void main();
