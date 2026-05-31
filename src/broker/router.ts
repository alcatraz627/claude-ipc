/**
 * Turns a wire request into an effect on storage + registry, and a response.
 *
 * This is the broker's whole decision surface for Phase 2: registration,
 * liveness, message routing, inbox pulls, and peer listing. Correlation,
 * consent, and timeouts arrive in Phase 3. The router is synchronous — storage
 * is synchronous — so it is trivially testable with an injected clock + id source.
 */

import { ttyForPid } from "../badge.ts";
import { makeMessage, type DeliveredVia, type ErrorCode, type Kind, type Status } from "../models.ts";
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
    private defaultTtlS: number | null = null, // null = queries don't auto-time-out
    private notify: (alias: string) => void = () => {}, // fired when a peer's inbox changes
    private allowlist: Record<string, string[]> = {}, // {target: [allowed senders]}; empty = open
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
        case "deliver":
          return this.deliver(req);
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
        case "history":
          return this.history(req);
        case "status":
          return this.status(req);
        case "count":
          return this.count(req);
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
    const a = req.args as {
      alias?: string;
      sessionId?: string;
      cwd?: string;
      caps?: string[];
      pid?: number;
      tty?: string;
    };
    if (!a.alias || !a.sessionId) return fail("bad_args", "register needs alias + sessionId");
    const tty = a.tty ?? (a.pid ? ttyForPid(a.pid) : null);
    const result = this.registry.register(
      a.alias,
      { sessionId: a.sessionId, cwd: a.cwd ?? "", caps: a.caps, pid: a.pid ?? null, tty },
      req.token,
    );
    if (!result.ok) {
      return fail("alias_taken", `${a.alias} is live and owned by another session`);
    }
    // The token goes back ONLY here, to the owner who just registered.
    return ok({ alias: a.alias, registered: true, replaced: result.replaced, token: result.token });
  }

  /**
   * Gate an op that acts as `alias`: the caller must present its capability token.
   * Returns a fail Response to short-circuit, or null when the op may proceed.
   * An alias with no registered token (never registered, or a legacy pre-token
   * entry) is unprotected — you can't impersonate an identity nobody claimed.
   */
  private requireOwner(req: Request, alias: string): Response | null {
    const tok = this.registry.tokenOf(alias);
    if (tok && req.token !== tok) return fail("unauthorized", `not authorized to act as ${alias}`);
    return null;
  }

  private heartbeat(req: Request): Response {
    const a = req.args as { alias?: string };
    if (a.alias) {
      const denied = this.requireOwner(req, a.alias);
      if (denied) return denied;
      this.registry.heartbeat(a.alias);
    }
    return ok({ ok: true });
  }

  private leave(req: Request): Response {
    const a = req.args as { alias?: string };
    if (a.alias) {
      const denied = this.requireOwner(req, a.alias);
      if (denied) return denied;
      this.registry.leave(a.alias);
    }
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
      contextPtr?: { sessionId: string; transcriptPath: string; cwd: string };
    };
    if (!a.from || !a.to) return fail("bad_args", "send needs from + to");
    const denied = this.requireOwner(req, a.from); // you may only send AS yourself
    if (denied) return denied;
    if (!a.kind || !SENDABLE.includes(a.kind)) {
      return fail("bad_args", `kind must be inform|query|request, got ${String(a.kind)}`);
    }

    if (a.to !== "*" && !this.registry.has(a.to)) {
      return ok({ msgId: null, error: { code: "no_peer", livePeers: this.registry.liveAliases() } });
    }

    // Allowlist guards who may target a peer (e.g. only certain senders may task a
    // broad-permission session). A guardrail against accidental targeting, not a
    // security boundary under the no-auth model.
    const allowed = this.allowlist[a.to];
    if (a.to !== "*" && allowed && !allowed.includes(a.from)) {
      return ok({ msgId: null, error: { code: "not_allowed", message: `${a.from} may not target ${a.to}` } });
    }

    const id = this.newId();
    // A directed query/request opens a thread: stamp it with a conversationId
    // (derived from its own id) so the correlated reply — which inherits the
    // origin's conversationId — and any follow-ups share one thread key that
    // history can filter on. An explicit id from the caller always wins.
    const opensThread = a.to !== "*" && (a.kind === "query" || a.kind === "request");
    const conversationId = a.conversationId ?? (opensThread ? `conv-${id}` : null);
    const msg = makeMessage({
      id,
      kind: a.kind,
      fromAlias: a.from,
      toAlias: a.to,
      ts: this.now(),
      body: a.body ?? "",
      conversationId,
      ttlS: a.ttlS ?? null,
      contextPtr: a.contextPtr ?? null,
    });
    this.backend.append(msg);

    const targets = a.to === "*" ? this.registry.liveAliases(a.from) : [a.to];
    for (const t of targets) this.backend.enqueue(msg.id, t);

    // A directed query/request is something the sender waits on — track it for
    // correlation. It auto-times-out only if an explicit ttl was given (or a
    // default configured); by default it stays open until answered.
    if (a.to !== "*" && (a.kind === "query" || a.kind === "request")) {
      const ttl = a.ttlS ?? this.defaultTtlS;
      this.backend.openAwaiting(msg.id, ttl !== null ? this.now() + ttl : null);
    }

    for (const t of targets) this.notify(t);
    return ok({ msgId: msg.id, recipients: targets, conversationId });
  }

  private check(req: Request): Response {
    const a = req.args as { alias?: string; consume?: boolean };
    if (!a.alias) return fail("bad_args", "check needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner reads its inbox
    if (denied) return denied;
    const messages = this.backend.pending(a.alias, { consume: a.consume ?? false });
    this.notify(a.alias);
    return ok({ messages });
  }

  /** Hand a hook the alias's freshly-queued messages exactly once (idempotent inject). */
  private deliver(req: Request): Response {
    const a = req.args as { alias?: string; via?: DeliveredVia };
    if (!a.alias) return fail("bad_args", "deliver needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner drains its queue
    if (denied) return denied;
    const messages = this.backend.claimForDelivery(a.alias, a.via ?? "hook");
    this.notify(a.alias);
    return ok({ messages });
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
    const denied = this.requireOwner(req, a.from); // you may only reply AS yourself
    if (denied) return denied;
    const origin = this.backend.originOf(a.corrId);
    if (!origin) return fail("no_origin", `no message for corrId ${a.corrId}`);
    const aw = this.backend.getAwaiting(a.corrId);
    // Drop only if the sender explicitly cancelled. Otherwise deliver — even after
    // a timeout fired: a real (if late) answer beats a provisional timeout, and a
    // human-paced reply hours later is the normal case, not an error to discard.
    if (aw?.closed && aw.closedReason === "cancelled") {
      return ok({ dropped: true, reason: "cancelled" });
    }
    const terminal = a.terminal ?? true;
    const late = aw?.closed === true;
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
    if (terminal && (aw === null || !aw.closed)) this.backend.closeAwaiting(a.corrId, "responded");
    this.notify(origin.fromAlias);
    return ok({ msgId: resp.id, terminal, late });
  }

  /** Consent to act on a request. Marks the delivery accepted; the work + reply follow. */
  private accept(req: Request): Response {
    const a = req.args as { alias?: string; msgId?: string };
    if (!a.alias || !a.msgId) return fail("bad_args", "accept needs alias + msgId");
    const denied = this.requireOwner(req, a.alias); // only the recipient consents
    if (denied) return denied;
    this.backend.setConsent(a.msgId, a.alias, true);
    return ok({ accepted: true });
  }

  /** Refuse a request; the sender gets a terminal response{error,declined}. */
  private decline(req: Request): Response {
    const a = req.args as { from?: string; msgId?: string; reason?: string };
    if (!a.from || !a.msgId) return fail("bad_args", "decline needs from + msgId");
    const denied = this.requireOwner(req, a.from); // only the recipient declines
    if (denied) return denied;
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
    const origin = this.backend.originOf(a.corrId); // only the asker cancels their ask
    if (origin) {
      const denied = this.requireOwner(req, origin.fromAlias);
      if (denied) return denied;
    }
    this.backend.closeAwaiting(a.corrId, "cancelled");
    return ok({ cancelled: true });
  }

  /** Cheap pending-count for an alias — for a tab-title segment that runs every turn. */
  private count(req: Request): Response {
    const a = req.args as { alias?: string };
    if (!a.alias) return fail("bad_args", "count needs alias");
    const denied = this.requireOwner(req, a.alias); // your own inbox size only
    if (denied) return denied;
    return ok({ count: this.backend.pending(a.alias).length });
  }

  /** A message's full lifecycle: the message, its per-recipient deliveries, and any responses. */
  private status(req: Request): Response {
    const a = req.args as { msgId?: string };
    if (!a.msgId) return fail("bad_args", "status needs msgId");
    const message = this.backend.get(a.msgId);
    if (!message) return fail("not_found", `no message ${a.msgId}`);
    return ok({
      message,
      deliveries: this.backend.deliveriesFor(a.msgId),
      responses: this.backend.history({}).filter((m) => m.corrId === a.msgId),
    });
  }

  /** Audit query: who/what/when, filterable by peer, time, and conversation. */
  private history(req: Request): Response {
    const a = req.args as { peer?: string; since?: number; conversationId?: string };
    return ok({ messages: this.backend.history(a) });
  }

  /** Non-blocking peek: has a correlated response landed in this alias's inbox yet? */
  private awaitReply(req: Request): Response {
    const a = req.args as { alias?: string; corrId?: string };
    if (!a.alias || !a.corrId) return fail("bad_args", "await needs alias + corrId");
    const denied = this.requireOwner(req, a.alias); // only the asker polls its inbox
    if (denied) return denied;
    const found = this.backend
      .pending(a.alias)
      .find((m) => m.kind === "response" && m.corrId === a.corrId);
    return ok(found ? { response: found } : { pending: true });
  }
}
