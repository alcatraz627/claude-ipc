/**
 * Stop hook: heartbeat this session, and turn it around if it has unanswered asks.
 *
 * Fires at the end of each turn. It always heartbeats so the registry's view of
 * who is alive stays fresh. It then does the turn-end push: if a peer's
 * request/query is still waiting, it blocks the turn once — the session gets one
 * nudge to reply before going idle, then never blocks on that message again.
 * Informs never block. Like the other hooks it is best-effort and never blocks on
 * a downed broker.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "../client.ts";
import { config } from "../config.ts";
import { aliasFor, emitContext, readHookInput } from "./shared.ts";

interface Ask {
  id: string;
  kind: string;
  fromAlias: string;
  body: string;
}

/** What the turn-end push should do with this session's pending mail. */
export type PushDecision =
  | { kind: "block"; reason: string; mark: string[] } // block once; mark these ids as blocked
  | { kind: "remind"; context: string } // already blocked — a quiet additionalContext nudge
  | { kind: "none" }; // nothing waiting worth turning the session around for

/** A per-message marker: a truthy file means this ask already fired its one block. */
const markerPath = (id: string): string => join(config.blockedDir, encodeURIComponent(id));
const alreadyBlocked = (id: string): boolean => existsSync(markerPath(id));

function markBlocked(id: string): void {
  try {
    mkdirSync(config.blockedDir, { recursive: true });
    writeFileSync(markerPath(id), "");
  } catch {
    // best-effort — a lost marker at worst blocks the same message a second time
  }
}

const preview = (body: string): string => (body.length > 140 ? `${body.slice(0, 140)}…` : body);

/** The one-time turn-end block: name the sender, the ask, and how to answer it. */
function blockReason(fresh: Ask[], self: string): string {
  const m = fresh[0] as Ask;
  const more = fresh.length > 1 ? ` (+${fresh.length - 1} more waiting)` : "";
  const decline = m.kind === "request" ? ", or ipc_accept / decline it" : "";
  return (
    `${m.fromAlias} sent you a ${m.kind} you haven't answered${more}: "${preview(m.body)}" (${m.id}). ` +
    `Reply with: claude-ipc reply ${m.id} --from ${self} "<your answer>"${decline}. ` +
    `This turn-end reminder fires once for this message.`
  );
}

/**
 * Decide the turn-end push from this session's pending mail — the pure core.
 *
 * Only a request/query is worth turning a session around for; an inform never
 * blocks. A waiting ask blocks the turn exactly once (`wasBlocked` reports which
 * ids already fired), then degrades to a quiet reminder so we never fight the
 * platform's consecutive-block cap.
 */
export function decidePush(pending: Ask[], self: string, wasBlocked: (id: string) => boolean): PushDecision {
  const asks = pending.filter((m) => m.kind === "request" || m.kind === "query");
  if (asks.length === 0) return { kind: "none" };
  const fresh = asks.filter((m) => !wasBlocked(m.id));
  if (fresh.length > 0) return { kind: "block", reason: blockReason(fresh, self), mark: fresh.map((m) => m.id) };
  const items = asks.map((m) => `${m.fromAlias}'s ${m.kind} (${m.id})`).join(", ");
  return { kind: "remind", context: `Still awaiting your reply: ${items}. Use claude-ipc reply … or decline.` };
}

export async function main(): Promise<void> {
  const input = await readHookInput();
  const alias = aliasFor(input);
  const client = new Client(config.socketPath);

  // Heartbeat first — best-effort, independent of the push below.
  try {
    await client.heartbeat(alias);
  } catch {
    // broker unreachable — heartbeat is best-effort
  }

  // Turn-end push. A broker-down check throws → we fall through and never block:
  // a dead broker must not wedge a session at its turn boundary.
  try {
    const pending = ((await client.check(alias)).messages ?? []) as Ask[];
    // Project asks nag every member session the same way — whoever replies
    // first consumes the ask for the whole project. Peek is non-consuming.
    try {
      const cwd = input.cwd ?? process.cwd();
      pending.push(...(((await client.checkProject(cwd, false, alias)).messages ?? []) as Ask[]));
    } catch {
      // project peek is best-effort; session mail already covered above
    }
    const d = decidePush(pending, alias, alreadyBlocked);
    if (d.kind === "block") {
      for (const id of d.mark) markBlocked(id);
      process.stdout.write(JSON.stringify({ decision: "block", reason: d.reason }));
    } else if (d.kind === "remind") {
      emitContext("Stop", d.context);
    }
  } catch {
    // broker down or check failed — never block the turn
  }
}

if (import.meta.main) void main();
