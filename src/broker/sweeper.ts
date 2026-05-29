/**
 * Expires outstanding query/requests whose TTL has passed.
 *
 * For each awaiting record past its deadline, closes it and routes a synthetic
 * response{error,timeout} back to the original sender. Only an active process can
 * turn "no answer" into a visible failure — which is why the broker owns this,
 * not the filesystem. Returns how many timeouts fired; pure given its injected
 * clock + id source.
 */

import { makeMessage } from "../models.ts";
import type { StorageBackend } from "../storage/base.ts";

export function tickSweeper(backend: StorageBackend, now: () => number, newId: () => string): number {
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
