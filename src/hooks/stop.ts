/**
 * Stop hook: heartbeat this session so its liveness stays fresh.
 *
 * Fires at the end of each turn. A cheap heartbeat keeps the registry's view of
 * who is alive accurate; like the other hooks it is best-effort and never blocks.
 */

import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, readHookInput } from "./shared.ts";

export async function main(): Promise<void> {
  const input = await readHookInput();
  try {
    await new Client(config.socketPath).heartbeat(aliasFor(input));
  } catch {
    // broker unreachable — heartbeat is best-effort
  }
}

if (import.meta.main) void main();
