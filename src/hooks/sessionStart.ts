/**
 * SessionStart hook: register this session and drain its offline backlog.
 *
 * Fires on startup and on resume. Registering re-binds the alias so peers can
 * reach it; draining replays messages that queued while the session was gone,
 * delivering the "leave a note for an agent that's not running yet" guarantee.
 */

import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, deliverContext, emitContext, readHookInput } from "./shared.ts";

export async function main(): Promise<void> {
  const input = await readHookInput();
  const alias = aliasFor(input);
  try {
    const client = new Client(config.socketPath);
    await client.register(alias, {
      sessionId: input.session_id ?? `hook-${alias}`,
      cwd: input.cwd ?? process.cwd(),
      pid: process.ppid, // the Claude process — broker derives the tty from it
      tty: process.env.CLAUDE_IPC_TTY, // explicit override if the launcher set it
    });
    const ctx = await deliverContext(client, alias, "resume");
    if (ctx) emitContext("SessionStart", ctx);
  } catch {
    // broker unreachable — nothing to register or inject
  }
}

if (import.meta.main) void main();
