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

import { makeMessage } from "../models.ts";
import type { StorageBackend } from "../storage/base.ts";

export function tickSweeper(
  backend: StorageBackend,
  now: () => number,
  newId: () => string,
  retentionS?: number,
): number {
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

const ghostPreview = (body: string): string => (body.length > 120 ? `${body.slice(0, 120)}…` : body);

/**
 * Tell a sender when the peer it asked has gone dark holding the ask — as a PARK,
 * not a failure. The recipient is offline, so the ask can't resolve now, but the
 * message stays deliverable on their next open and a late reply still reaches the
 * sender. For each still-open ask whose recipient is offline (`isDark`) and older
 * than `ghostAfterS`, route an informational parked notice (status ok) and close
 * the ask as "parked". The grace runs from send time so a note left for an
 * offline session gets its window to surface first.
 */
export function sweepGhosts(
  backend: StorageBackend,
  isDark: (alias: string) => boolean,
  now: () => number,
  newId: () => string,
  ghostAfterS: number,
): number {
  let fired = 0;
  for (const a of backend.openAwaitings()) {
    const origin = backend.originOf(a.originId);
    if (!origin) continue; // not a query/request origin — nothing to escalate
    if (now() - origin.ts < ghostAfterS) continue; // still inside the grace window
    if (!isDark(origin.toAlias)) continue; // recipient still reachable — keep waiting

    // Word it from the recipient's delivery state: did they see it before going dark?
    const del = backend.deliveriesFor(origin.id).find((d) => d.toAlias === origin.toAlias);
    const saw = del ? del.state !== "queued" : false;
    const what = saw
      ? `saw your ${origin.kind} then went offline`
      : `went offline before your ${origin.kind} reached them`;
    const resp = makeMessage({
      id: newId(),
      kind: "response",
      fromAlias: "ipc",
      toAlias: origin.fromAlias,
      ts: now(),
      corrId: origin.id,
      status: "ok",
      errorCode: null,
      terminal: true,
      body: `parked: "${origin.toAlias}" ${what}: "${ghostPreview(origin.body)}". It's held for their next open, and their reply will still reach you. Escalate if it's urgent.`,
      conversationId: origin.conversationId,
    });
    backend.append(resp);
    backend.enqueue(resp.id, origin.fromAlias);
    backend.closeAwaiting(origin.id, "parked");
    fired++;
  }
  return fired;
}
