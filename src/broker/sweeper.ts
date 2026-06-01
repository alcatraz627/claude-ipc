/**
 * Periodic housekeeping the broker runs on a timer.
 *
 * Two jobs: expire outstanding query/requests whose TTL has passed (closing each
 * and routing a synthetic response{error,timeout} back to the sender — only an
 * active process can turn "no answer" into a visible failure), and, when a
 * retention window is given, purge fully-settled messages older than it so the
 * durable log doesn't grow forever. Returns how many timeouts fired; pure given
 * its injected clock + id source.
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
    backend.closeAwaiting(a.originId, "timeout");
    const origin = backend.originOf(a.originId);
    if (!origin) continue;
    const resp = makeMessage({
      id: newId(),
      kind: "response",
      fromAlias: "ipc",
      toAlias: origin.fromAlias,
      ts: now(),
      corrId: a.originId,
      status: "error",
      errorCode: "timeout",
      terminal: true,
      body: "no response within TTL",
      conversationId: origin.conversationId,
    });
    backend.append(resp);
    backend.enqueue(resp.id, origin.fromAlias);
  }
  return expired.length;
}
