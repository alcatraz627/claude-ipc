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
  toAlias?: string;
  replyByS?: number | null;
}

interface OwedRow {
  corr_id: string;
  reply_by_s: number | null;
}

/**
 * Copy each ask's reply window from the broker's digest onto the pending mail. A broadcast
 * never gets a ledger row, so the digest's null means "no record" there, not "nobody waits",
 * and it stays owed.
 */
export function markReplyWindows(pending: Ask[], digest: unknown): void {
  const sessions = (digest as { sessions?: Record<string, { owed?: OwedRow[] }> })?.sessions ?? {};
  const owed = Object.values(sessions).flatMap((s) => s?.owed ?? []);
  const waitFor = new Map(owed.map((o) => [o.corr_id, o.reply_by_s]));
  for (const m of pending) {
    if (m.toAlias !== "*" && waitFor.has(m.id)) m.replyByS = waitFor.get(m.id);
  }
}

/** What the turn-end push should do with this session's pending mail. */
export type PushDecision =
  | { kind: "block"; reason: string; mark: string[] } // block once; mark these ids as blocked
  | { kind: "remind"; context: string } // already blocked — a quiet additionalContext nudge
  | { kind: "none" }; // nothing waiting worth turning the session around for

/** A per-message marker: a truthy file means this ask already fired its one block. */
const markerPath = (id: string): string => join(config.blockedDir, encodeURIComponent(id));
const alreadyBlocked = (id: string): boolean => existsSync(markerPath(id));

/** Record that this ask has had its one block. False when we could not write it down. */
function markBlocked(id: string): boolean {
  try {
    mkdirSync(config.blockedDir, { recursive: true });
    writeFileSync(markerPath(id), "");
    return true;
  } catch {
    return false;
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
 * blocks. Nor does a request sent with --no-reply-expected: it wakes the session
 * to do something, and nobody is waiting on an answer. A waiting ask blocks the
 * turn exactly once (`wasBlocked` reports which ids already fired), then degrades
 * to a quiet reminder so we never fight the platform's consecutive-block cap.
 */
export function decidePush(pending: Ask[], self: string, wasBlocked: (id: string) => boolean): PushDecision {
  const asks = pending.filter((m) => (m.kind === "request" || m.kind === "query") && m.replyByS !== null);
  if (asks.length === 0) return { kind: "none" };
  const fresh = asks.filter((m) => !wasBlocked(m.id));
  if (fresh.length > 0) return { kind: "block", reason: blockReason(fresh, self), mark: fresh.map((m) => m.id) };
  const items = asks.map((m) => `${m.fromAlias}'s ${m.kind} (${m.id})`).join(", ");
  return { kind: "remind", context: `Still awaiting your reply: ${items}. Use claude-ipc reply … or decline.` };
}

/**
 * Turn the decision into an action, and never block on a promise we can't keep.
 *
 * "Blocks once" rests entirely on being able to write the marker down: an ask with no
 * marker reads as fresh, so a write that keeps failing would re-block at EVERY turn end,
 * for good — the human wedged out of their own session by a reminder about someone
 * else's mail. If we cannot record it, we say it quietly instead.
 */
export function applyPush(
  d: PushDecision,
  record: (id: string) => boolean,
): { kind: "block"; reason: string } | { kind: "context"; text: string } | { kind: "none" } {
  if (d.kind === "remind") return { kind: "context", text: d.context };
  if (d.kind !== "block") return { kind: "none" };
  const recorded = d.mark.map(record).every(Boolean);
  return recorded ? { kind: "block", reason: d.reason } : { kind: "context", text: d.reason };
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
    // Whether anyone waits on an ask lives on the broker's ledger, not on the message.
    // Should this look-up fail, every ask stays owed, as it would with no flag at all.
    if (pending.some((m) => m.kind === "request" || m.kind === "query")) {
      try {
        markReplyWindows(pending, await client.digest(input.cwd ?? process.cwd()));
      } catch {
        // owed by default, see above
      }
    }
    const out = applyPush(decidePush(pending, alias, alreadyBlocked), markBlocked);
    if (out.kind === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: out.reason }));
    else if (out.kind === "context") emitContext("Stop", out.text);
  } catch {
    // broker down or check failed — never block the turn
  }
}

if (import.meta.main) void main();
