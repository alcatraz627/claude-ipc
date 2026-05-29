/**
 * Turns a wire request into an effect on storage + registry, and a response.
 *
 * This is the broker's whole decision surface for Phase 2: registration,
 * liveness, message routing, inbox pulls, and peer listing. Correlation,
 * consent, and timeouts arrive in Phase 3. The router is synchronous — storage
 * is synchronous — so it is trivially testable with an injected clock + id source.
 */

import { makeMessage, type Kind } from "../models.ts";
import type { Request, Response } from "../protocol.ts";
import type { StorageBackend } from "../storage/base.ts";
import type { Registry } from "./registry.ts";

const ok = (result: unknown): Response => ({ ok: true, result });
const fail = (code: string, message: string): Response => ({ ok: false, error: { code, message } });

const SENDABLE: readonly Kind[] = ["inform", "query", "request"];

export class Router {
  constructor(
    private backend: StorageBackend,
    private registry: Registry,
    private now: () => number,
    private newId: () => string,
  ) {}

  handle(req: Request): Response {
    try {
      switch (req.op) {
        case "register":
          return this.register(req);
        case "heartbeat":
          return this.heartbeat(req);
        case "leave":
          return this.leave(req);
        case "send":
          return this.send(req);
        case "check":
          return this.check(req);
        case "list":
          return ok({ peers: this.registry.list() });
        default:
          return fail("bad_op", `unsupported op: ${req.op}`);
      }
    } catch (e) {
      return fail("internal", e instanceof Error ? e.message : String(e));
    }
  }

  private register(req: Request): Response {
    const a = req.args as { alias?: string; sessionId?: string; cwd?: string; caps?: string[]; pid?: number };
    if (!a.alias || !a.sessionId) return fail("bad_args", "register needs alias + sessionId");
    const { replaced } = this.registry.register(a.alias, {
      sessionId: a.sessionId,
      cwd: a.cwd ?? "",
      caps: a.caps,
      pid: a.pid ?? null,
    });
    return ok({ alias: a.alias, registered: true, replaced });
  }

  private heartbeat(req: Request): Response {
    const a = req.args as { alias?: string };
    if (a.alias) this.registry.heartbeat(a.alias);
    return ok({ ok: true });
  }

  private leave(req: Request): Response {
    const a = req.args as { alias?: string };
    if (a.alias) this.registry.leave(a.alias);
    return ok({ left: true });
  }

  private send(req: Request): Response {
    const a = req.args as {
      from?: string;
      to?: string;
      kind?: Kind;
      body?: string;
      conversationId?: string;
      ttlS?: number;
    };
    if (!a.from || !a.to) return fail("bad_args", "send needs from + to");
    if (!a.kind || !SENDABLE.includes(a.kind)) {
      return fail("bad_args", `kind must be inform|query|request, got ${String(a.kind)}`);
    }

    if (a.to !== "*" && !this.registry.has(a.to)) {
      return ok({ msgId: null, error: { code: "no_peer", livePeers: this.registry.liveAliases() } });
    }

    const msg = makeMessage({
      id: this.newId(),
      kind: a.kind,
      fromAlias: a.from,
      toAlias: a.to,
      ts: this.now(),
      body: a.body ?? "",
      conversationId: a.conversationId ?? null,
      ttlS: a.ttlS ?? null,
    });
    this.backend.append(msg);

    const targets = a.to === "*" ? this.registry.liveAliases(a.from) : [a.to];
    for (const t of targets) this.backend.enqueue(msg.id, t);

    return ok({ msgId: msg.id, recipients: targets });
  }

  private check(req: Request): Response {
    const a = req.args as { alias?: string; consume?: boolean };
    if (!a.alias) return fail("bad_args", "check needs alias");
    return ok({ messages: this.backend.pending(a.alias, { consume: a.consume ?? false }) });
  }
}
