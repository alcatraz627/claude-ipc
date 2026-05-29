/**
 * Turns a wire request into an effect on storage + registry, and a response.
 *
 * This is the broker's whole decision surface for Phase 2: registration,
 * liveness, message routing, inbox pulls, and peer listing. Correlation,
 * consent, and timeouts arrive in Phase 3. The router is synchronous — storage
 * is synchronous — so it is trivially testable with an injected clock + id source.
 */

import { makeMessage, type ErrorCode, type Kind, type Status } from "../models.ts";
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
    private defaultTtlS = 3600,
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
        case "reply":
          return this.reply(req);
        case "accept":
          return this.accept(req);
        case "decline":
          return this.decline(req);
        case "cancel":
          return this.cancel(req);
        case "await":
          return this.awaitReply(req);
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

    // A directed query/request is something the sender waits on — track it so it
    // can be correlated to a reply or timed out by the sweeper.
    if (a.to !== "*" && (a.kind === "query" || a.kind === "request")) {
      this.backend.openAwaiting(msg.id, this.now() + (a.ttlS ?? this.defaultTtlS));
    }

    return ok({ msgId: msg.id, recipients: targets });
  }

  private check(req: Request): Response {
    const a = req.args as { alias?: string; consume?: boolean };
    if (!a.alias) return fail("bad_args", "check needs alias");
    return ok({ messages: this.backend.pending(a.alias, { consume: a.consume ?? false }) });
  }

  /** Answer a query/request. A reply after the origin closed (timeout/cancel) is dropped. */
  private reply(req: Request): Response {
    const a = req.args as {
      from?: string;
      corrId?: string;
      body?: string;
      terminal?: boolean;
      status?: Status;
      errorCode?: ErrorCode;
    };
    if (!a.from || !a.corrId) return fail("bad_args", "reply needs from + corrId");
    const origin = this.backend.originOf(a.corrId);
    if (!origin) return fail("no_origin", `no message for corrId ${a.corrId}`);
    if (!this.backend.isAwaitingOpen(a.corrId)) {
      return ok({ dropped: true, reason: "awaiting_closed" }); // late or duplicate
    }
    const terminal = a.terminal ?? true;
    const resp = makeMessage({
      id: this.newId(),
      kind: "response",
      fromAlias: a.from,
      toAlias: origin.fromAlias,
      ts: this.now(),
      corrId: a.corrId,
      status: a.status ?? "ok",
      errorCode: a.errorCode ?? null,
      terminal,
      body: a.body ?? "",
      conversationId: origin.conversationId,
    });
    this.backend.append(resp);
    this.backend.enqueue(resp.id, origin.fromAlias);
    if (terminal) this.backend.closeAwaiting(a.corrId, "responded");
    return ok({ msgId: resp.id, terminal });
  }

  /** Consent to act on a request. Marks the delivery accepted; the work + reply follow. */
  private accept(req: Request): Response {
    const a = req.args as { alias?: string; msgId?: string };
    if (!a.alias || !a.msgId) return fail("bad_args", "accept needs alias + msgId");
    this.backend.setConsent(a.msgId, a.alias, true);
    return ok({ accepted: true });
  }

  /** Refuse a request; the sender gets a terminal response{error,declined}. */
  private decline(req: Request): Response {
    const a = req.args as { from?: string; msgId?: string; reason?: string };
    if (!a.from || !a.msgId) return fail("bad_args", "decline needs from + msgId");
    this.backend.setConsent(a.msgId, a.from, false);
    const origin = this.backend.originOf(a.msgId);
    if (origin && this.backend.isAwaitingOpen(a.msgId)) {
      const resp = makeMessage({
        id: this.newId(),
        kind: "response",
        fromAlias: a.from,
        toAlias: origin.fromAlias,
        ts: this.now(),
        corrId: a.msgId,
        status: "error",
        errorCode: "declined",
        terminal: true,
        body: a.reason ?? "",
        conversationId: origin.conversationId,
      });
      this.backend.append(resp);
      this.backend.enqueue(resp.id, origin.fromAlias);
      this.backend.closeAwaiting(a.msgId, "responded");
    }
    return ok({ declined: true });
  }

  /** The sender abandons an outstanding request; a later reply will be dropped. */
  private cancel(req: Request): Response {
    const a = req.args as { corrId?: string };
    if (!a.corrId) return fail("bad_args", "cancel needs corrId");
    this.backend.closeAwaiting(a.corrId, "cancelled");
    return ok({ cancelled: true });
  }

  /** Non-blocking peek: has a correlated response landed in this alias's inbox yet? */
  private awaitReply(req: Request): Response {
    const a = req.args as { alias?: string; corrId?: string };
    if (!a.alias || !a.corrId) return fail("bad_args", "await needs alias + corrId");
    const found = this.backend
      .pending(a.alias)
      .find((m) => m.kind === "response" && m.corrId === a.corrId);
    return ok(found ? { response: found } : { pending: true });
  }
}
