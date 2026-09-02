/**
 * Periodic housekeeping the broker runs on a timer.
 *
 * Two jobs: PARK query/requests whose TTL has passed, and purge fully-settled
 * messages older than the retention window. Returns how many were parked.
 *
 * Parking, not timeout-error: an unanswered ask hasn't failed — a turn-based
 * recipient just isn't attending now. So the sender gets an informational parked
 * notice (status ok) that resolves their await without blocking; the message
 * stays deliverable on the recipient's next turn/open; and the real reply still
 * reaches the sender whenever it comes. Replaces the old terminal timeout error.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeMessage } from "../models.ts";
import type { StorageBackend } from "../storage/base.ts";

/**
 * Reclaim the per-message and per-session marker files that nothing else deletes.
 *
 * `blocked/` and `alias-by-sid/` accrete forever otherwise. A blocked-marker is
 * dead once its message is purged; an alias file is dead once no live session
 * claims it AND it's sat untouched past the retention window. Both checks are
 * deliberately conservative — deleting a live session's alias file deafens it.
 */
export function reclaimStaleMarkers(deps: {
  blockedDir: string;
  aliasDir: string;
  hasMessage: (id: string) => boolean;
  liveSessionIds: Set<string>;
  now: number;
  aliasStaleS: number;
}): { blocked: number; alias: number } {
  let blocked = 0;
  let alias = 0;
  const dead = deps.now - deps.aliasStaleS;

  try {
    for (const name of readdirSync(deps.blockedDir)) {
      const id = decodeURIComponent(name);
      if (deps.hasMessage(id)) continue; // still a real message — keep its marker
      try {
        unlinkSync(join(deps.blockedDir, name));
        blocked++;
      } catch {
        // raced with another sweep or already gone
      }
    }
  } catch {
    // no blocked dir yet — nothing to reclaim
  }

  try {
    for (const name of readdirSync(deps.aliasDir)) {
      if (name.endsWith(".tmp")) continue; // a rename in flight, not a mapping
      const sid = decodeURIComponent(name);
      if (deps.liveSessionIds.has(sid)) continue; // a registered session owns this name
      const path = join(deps.aliasDir, name);
      try {
        if (statSync(path).mtimeMs / 1000 >= dead) continue; // touched recently — a live session may still hold it
        unlinkSync(path);
        alias++;
      } catch {
        // raced or already gone
      }
    }
  } catch {
    // no alias dir yet
  }

  return { blocked, alias };
}

export function tickSweeper(
  backend: StorageBackend,
  now: () => number,
  newId: () => string,
  retentionS?: number,
  tombstoneS?: number,
): number {
  // Retire messages that have sat undelivered past the tombstone window BEFORE the
  // purge, so a settled-and-aged row is deleted in the same tick. Message-age only.
  if (tombstoneS !== undefined) backend.tombstoneStale(now() - tombstoneS);
  if (retentionS !== undefined) backend.purge(now() - retentionS);
  const expired = backend.awaitingPastTtl(now());
  for (const a of expired) {
    backend.closeAwaiting(a.originId, "parked");
    const origin = backend.originOf(a.originId);
    if (!origin) continue;
    const resp = makeMessage({
      id: newId(),
      kind: "response",
      fromAlias: "ipc",
      toAlias: origin.fromAlias,
      ts: now(),
      corrId: a.originId,
      status: "ok",
      errorCode: null,
      terminal: true,
      body: `parked: "${origin.toAlias}" hasn't answered your ${origin.kind} yet. It's queued for their next turn/open, and their reply will still reach you. Escalate if it's urgent.`,
      conversationId: origin.conversationId,
    });
    backend.append(resp);
    backend.enqueue(resp.id, origin.fromAlias);
  }
  return expired.length;
}

const preview = (body: string): string => (body.length > 120 ? `${body.slice(0, 120)}…` : body);

/**
 * Chase an unanswered ask, and tell the sender when to stop waiting.
 *
 * Asks nothing about whether the recipient is alive — only how long it waited and
 * whether it was answered. A passed deadline releases the SENDER to act; it is never
 * a verdict on the peer. Stage 2 must keep closing the awaiting: nothing else closes
 * an ask with no TTL. Background: docs/notes/no-liveness-claims.md
 */
export function sweepReplyDeadlines(
  backend: StorageBackend,
  now: () => number,
  newId: () => string,
  finalGraceS: number,
): number {
  let fired = 0;
  for (const a of backend.openAwaitings()) {
    if (a.replyByS === null) continue; // sender opted out — never chase this one
    const origin = backend.originOf(a.originId);
    if (!origin) continue; // not a query/request origin — nothing to chase

    const post = (toAlias: string, body: string, terminal: boolean): void => {
      const m = makeMessage({
        id: newId(),
        kind: "response", // already in every monitor's wake set, so it reaches an idle session
        fromAlias: "ipc",
        toAlias,
        ts: now(),
        corrId: origin.id,
        status: "ok",
        errorCode: null,
        terminal,
        body,
        conversationId: origin.conversationId,
      });
      backend.append(m);
      backend.enqueue(m.id, toAlias);
      fired++;
    };

    const secs = Math.max(0, Math.round(now() - origin.ts));
    const waited = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
    const senderDue = origin.ts + a.replyByS + finalGraceS;
    // The recipient's clock, unlike the sender's, can be pushed out: a snooze or a
    // partial ("on it, 20 min") is an answer of a kind, and nagging past it would be
    // a claim about their state we have no business making.
    const nudgeDue = a.nudgeFrom + a.replyByS;

    // They pushed their own clock out, which only a snooze or a partial ("on it, 20
    // min") does. The sender is still released on their own schedule, but they get to
    // hear it — "no final answer, but they acked" is a different decision from silence.
    const acked = a.nudgeFrom > origin.ts;

    if (now() >= senderDue && a.nudgedStage < 2) {
      post(
        origin.toAlias,
        `[claude-ipc] LAST CALL — ${origin.fromAlias} has been waiting ${waited} on ${origin.kind} ${origin.id}: "${preview(origin.body)}". Their reply deadline has passed, so they may now act without your answer. Reply now if one is coming: claude-ipc reply ${origin.id} --from <you> "<answer>"`,
        false,
      );
      post(
        origin.fromAlias,
        `[claude-ipc] NO REPLY YET — ${origin.id} to "${origin.toAlias}", ${waited}, no final answer` +
          (acked ? " (they DID acknowledge it — a snooze or a partial — but haven't answered)" : "") +
          `. You set --reply-by, so you may proceed without one. It is NOT a verdict on them: the ask stays open, and a late reply will still reach you.`,
        true,
      );
      backend.markNudged(origin.id, 2);
      backend.closeAwaiting(origin.id, "parked");
      continue;
    }

    if (now() >= nudgeDue && a.nudgedStage < 1) {
      post(
        origin.toAlias,
        `[claude-ipc] NUDGE — ${origin.fromAlias} is waiting on ${origin.kind} ${origin.id} (${waited}): "${preview(origin.body)}". Reply: claude-ipc reply ${origin.id} --from <you> "<answer>" — or snooze/decline it.`,
        false,
      );
      backend.markNudged(origin.id, 1);
    }
  }
  return fired;
}
