/**
 * Turns a wire request into an effect on storage + registry, and a response.
 *
 * This is the broker's whole decision surface for Phase 2: registration,
 * liveness, message routing, inbox pulls, and peer listing. Correlation,
 * consent, and timeouts arrive in Phase 3. The router is synchronous — storage
 * is synchronous — so it is trivially testable with an injected clock + id source.
 */

import { ttyForPid } from "../badge.ts";
import { makeMessage, type DeliveredVia, type ErrorCode, type Kind, type Message, type Status } from "../models.ts";
import { isProjectAddress, normalizeProjectPath, projectAddress, projectPath, sameLineage } from "../projectAddress.ts";
import { PROTOCOL_VERSION, type Request, type Response } from "../protocol.ts";
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
    private strict = false, // require a send's `from` to be registered (closes the forge-before-register window)
    private defaultReplyByS: number | null = null, // how long a sender waits before the ask gets chased; null = never
    private finalGraceS = 600, // ...and how much longer before the sender is released to act
  ) {}

  handle(req: Request): Response {
    // Reject a frame from an incompatible client loudly rather than mis-parsing
    // it silently — a stale compiled CLI talking to a newer broker (or vice
    // versa) gets a clear error instead of confusing behavior.
    if (req.v !== PROTOCOL_VERSION) {
      return fail("bad_version", `broker speaks protocol ${PROTOCOL_VERSION}, client sent ${req.v}`);
    }
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
        case "snooze":
          return this.snooze(req);
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
        case "prune":
          return this.prune(req);
        case "list":
          return ok({ peers: this.registry.list() });
        case "projects": {
          const boxes = this.backend.projectAddresses().map((addr) => ({
            address: addr,
            path: projectPath(addr),
            pending: this.backend.pending(addr).length,
          }));
          return ok({ projects: boxes });
        }
        case "orphans":
          return this.orphans(req);
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
      replyByS?: number | null; // null = opted out; undefined = use the default
      contextPtr?: { sessionId: string; transcriptPath: string; cwd: string };
    };
    if (!a.from || !a.to) return fail("bad_args", "send needs from + to");
    const denied = this.requireOwner(req, a.from); // you may only send AS yourself
    if (denied) return denied;
    // Strict identity: an unregistered `from` can't send — closes the window
    // where you forge a message from an alias before its owner registers.
    if (this.strict && !this.registry.has(a.from)) {
      return fail("not_registered", `${a.from} must register before sending (strict mode)`);
    }
    if (!a.kind || !SENDABLE.includes(a.kind)) {
      return fail("bad_args", `kind must be inform|query|request, got ${String(a.kind)}`);
    }

    // A project address needs no registered peer — the mailbox IS the address,
    // and it may be created before anyone works there. Canonicalize so
    // `proj:/x/` and `proj:/x` are one mailbox.
    if (isProjectAddress(a.to)) a.to = projectAddress(projectPath(a.to));
    else if (a.to !== "*" && !this.registry.has(a.to)) {
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
    // Project mail can't notify its own address — nudge the live sessions
    // working in that tree instead, so their channels/badges see it.
    if (isProjectAddress(a.to)) {
      for (const e of this.registry.list()) {
        if (e.status !== "offline" && sameLineage(e.cwd, projectPath(a.to))) this.notify(e.alias);
      }
    }

    // A directed query/request is something the sender waits on — track it for
    // correlation. It auto-times-out only if an explicit ttl was given (or a
    // default configured); by default it stays open until answered.
    //
    // The reply-by deadline is resolved HERE rather than in the CLI, so an ask sent
    // over MCP — or by a stale compiled binary that predates the flag — still gets
    // chased. `replyByS: null` is the sender explicitly opting out (a last message in
    // a chain); undefined just means they didn't say, so they get the default.
    let replyBy: number | null = null;
    if (a.to !== "*" && (a.kind === "query" || a.kind === "request")) {
      const ttl = a.ttlS ?? this.defaultTtlS;
      replyBy = a.replyByS === undefined ? this.defaultReplyByS : a.replyByS;
      this.backend.openAwaiting(msg.id, ttl !== null ? this.now() + ttl : null, replyBy, this.now());
    }

    for (const t of targets) this.notify(t);
    // Hand the deadline back rather than letting the caller assume one: the broker is
    // the only party that knows what it will actually honour, and a CLI that guesses
    // would be telling the sender a number nothing enforces.
    return ok({
      msgId: msg.id,
      recipients: targets,
      conversationId,
      replyByS: replyBy,
      releaseAfterS: replyBy === null ? null : replyBy + this.finalGraceS,
    });
  }

  private check(req: Request): Response {
    const a = req.args as { alias?: string; consume?: boolean; project?: string };
    if (a.project) {
      // Anyone may peek a project mailbox (visibility is deliberately open —
      // no new silos); only a member session may consume.
      if (a.consume) {
        const denied = this.requireProjectMember(req, a.project);
        if (denied) return denied;
      }
      const messages = this.projectMailboxes(a.project).flatMap((addr) =>
        this.backend.pending(addr, { consume: a.consume ?? false }),
      );
      return ok({ messages: this.stillOwedBy(messages, this.aliasOfToken(req)) });
    }
    if (!a.alias) return fail("bad_args", "check needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner reads its inbox
    if (denied) return denied;
    const consume = a.consume ?? false;
    const messages = this.backend.pending(a.alias, { consume });
    // Only a read that CHANGED the mailbox is worth announcing. The inbox watcher peeks
    // every 10 seconds; notifying on a peek meant the broker repainted the session's tab
    // badge forever, fighting whatever the user had put there.
    if (consume) this.notify(a.alias);
    return ok({ messages });
  }

  /** Hand a hook the alias's freshly-queued messages exactly once (idempotent inject). */
  private deliver(req: Request): Response {
    const a = req.args as { alias?: string; via?: DeliveredVia; project?: string };
    if (a.project) {
      const denied = this.requireProjectMember(req, a.project); // claiming is member-only
      if (denied) return denied;
      const messages = this.projectMailboxes(a.project).flatMap((addr) =>
        this.backend.claimForDelivery(addr, a.via ?? "hook"),
      );
      // Don't hand a session work that somebody else already took, or work it passed on.
      return ok({ messages: this.stillOwedBy(messages, this.aliasOfToken(req)) });
    }
    if (!a.alias) return fail("bad_args", "deliver needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner drains its queue
    if (denied) return denied;
    const messages = this.backend.claimForDelivery(a.alias, a.via ?? "hook");
    this.notify(a.alias);
    return ok({ messages });
  }

  /**
   * Session mailboxes whose owner is gone but whose mail still waits — what a
   * successor agent should know about when it picks the work back up. Scoped
   * to a directory's lineage when `project` is given; a dead alias whose cwd
   * is unknown (pruned from the registry) only shows in the global listing.
   */
  private orphans(req: Request): Response {
    const a = req.args as { project?: string };
    const dir = a.project ? normalizeProjectPath(a.project) : null;
    const entries = new Map(this.registry.list().map((e) => [e.alias, e]));
    const out: { alias: string; cwd: string | null; lastSeen: number | null; pending: number }[] = [];
    for (const addr of this.backend.pendingAddresses()) {
      if (isProjectAddress(addr)) continue; // project mail is not orphaned — it waits by design
      const e = entries.get(addr);
      if (e && e.status !== "offline") continue; // owner can still wake — not an orphan
      if (dir && (!e?.cwd || !sameLineage(e.cwd, dir))) continue;
      out.push({
        alias: addr,
        cwd: e?.cwd ?? null,
        lastSeen: e?.lastSeen ?? null,
        pending: this.backend.pending(addr).length,
      });
    }
    out.sort((x, y) => y.pending - x.pending);
    return ok({ orphans: out });
  }

  /** Project addresses whose path shares lineage with the given directory. */
  private projectMailboxes(dir: string): string[] {
    const d = normalizeProjectPath(dir);
    return this.backend.projectAddresses().filter((addr) => sameLineage(projectPath(addr), d));
  }

  /**
   * Gate a project-consuming op: the caller's token must belong to a
   * registered session whose cwd shares lineage with the project path.
   */
  /** Which session is talking, per the capability token it presented. */
  private aliasOfToken(req: Request): string | null {
    if (!req.token) return null;
    for (const e of this.registry.list()) if (this.registry.tokenOf(e.alias) === req.token) return e.alias;
    return null;
  }

  /**
   * Project mail this session is still on the hook for.
   *
   * Work somebody else has claimed, and work this session already passed on, is no
   * longer owed by it — showing it anyway is how a shared mailbox turns into everyone
   * nagging each other about a job that is already being done. An anonymous peek still
   * sees everything: visibility of a project mailbox is deliberately open.
   */
  private stillOwedBy(messages: Message[], self: string | null): Message[] {
    if (!self) return messages;
    return messages.filter((m) => {
      if (this.backend.projectStanding(m.id, self) === "passed") return false;
      const owner = this.backend.projectClaim(m.id);
      return owner === null || owner === self;
    });
  }

  private requireProjectMember(req: Request, dir: string): Response | null {
    if (!req.token) return fail("unauthorized", "consuming project mail needs a session token");
    const d = normalizeProjectPath(dir);
    for (const e of this.registry.list()) {
      if (this.registry.tokenOf(e.alias) === req.token && sameLineage(e.cwd, d)) return null;
    }
    return fail("unauthorized", `no session you own works under ${d}`);
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
    // A partial ("on it, 20 min") leaves the ask open on purpose. It is still an
    // answer, so the recipient stops being chased — nudging someone who just told you
    // they're working on it is a claim about their state that their own reply refutes.
    if (!terminal) this.backend.deferNudge(a.corrId, this.now());
    // Answering a message consumes it: the replier has clearly acted on the ask,
    // so their own still-queued delivery of the origin must stop counting as
    // pending — otherwise the turn-end push keeps reminding about an
    // already-answered request until the next inbox drain (found live 2026-07-10).
    this.backend.markConsumed(a.corrId, a.from);
    // A project-addressed ask has its delivery row under the proj: address,
    // not the replier's alias — consume that too, or every other member keeps
    // seeing an already-answered ask as pending.
    if (isProjectAddress(origin.toAlias)) this.backend.markConsumed(a.corrId, origin.toAlias);
    this.notify(origin.fromAlias);
    return ok({ msgId: resp.id, terminal, late });
  }

  /** Defer a message without losing it: marked seen-and-deferred, still pending + owed. */
  private snooze(req: Request): Response {
    const a = req.args as { alias?: string; msgId?: string };
    if (!a.alias || !a.msgId) return fail("bad_args", "snooze needs alias + msgId");
    const denied = this.requireOwner(req, a.alias); // only the recipient defers
    if (denied) return denied;
    this.backend.markSurfaced(a.msgId, a.alias);
    // Deliberately deferring an ask is a kind of answer: stop nudging them about it.
    // The SENDER's deadline is untouched — when to stop waiting is their call, and a
    // recipient must not be able to extend it by snoozing.
    this.backend.deferNudge(a.msgId, this.now());
    return ok({ surfaced: true });
  }

  /**
   * Consent to act on a request — and for project mail, take exclusive ownership of it.
   *
   * Project mail is addressed to a directory, so accepting it must be a CLAIM: exactly
   * one session can win, and the loser is told who has it rather than both starting the
   * same job. A direct request needs no claim; its recipient is already the only one.
   */
  private accept(req: Request): Response {
    const a = req.args as { alias?: string; msgId?: string };
    if (!a.alias || !a.msgId) return fail("bad_args", "accept needs alias + msgId");
    const denied = this.requireOwner(req, a.alias); // only the recipient consents
    if (denied) return denied;

    const origin = this.backend.get(a.msgId);
    if (origin && isProjectAddress(origin.toAlias)) {
      const won = this.backend.claimProject(a.msgId, a.alias);
      const owner = this.backend.projectClaim(a.msgId);
      if (!won) {
        return ok({
          accepted: false,
          claimedBy: owner,
          note: `"${owner}" already took ${a.msgId}. Leave it to them; nothing is owed by you.`,
        });
      }
      return ok({ accepted: true, claimedBy: a.alias, note: "It's yours. Do the work, then reply." });
    }

    this.backend.setConsent(a.msgId, a.alias, true);
    return ok({ accepted: true });
  }

  /**
   * Refuse a request. For a direct ask that is a terminal "no"; for project mail it is
   * only "not me".
   *
   * A project ask was addressed to a directory, so one member stepping back does not
   * speak for the rest: the ask stays open, everyone else still sees it, and the sender
   * is told who passed rather than being told they were refused.
   */
  private decline(req: Request): Response {
    const a = req.args as { from?: string; msgId?: string; reason?: string };
    if (!a.from || !a.msgId) return fail("bad_args", "decline needs from + msgId");
    const denied = this.requireOwner(req, a.from); // only the recipient declines
    if (denied) return denied;
    const origin = this.backend.originOf(a.msgId);

    if (origin && isProjectAddress(origin.toAlias)) {
      this.backend.passProject(a.msgId, a.from);
      if (this.backend.isAwaitingOpen(a.msgId)) {
        const note = makeMessage({
          id: this.newId(),
          kind: "inform", // NOT a terminal decline: nobody has refused this yet
          fromAlias: "ipc",
          toAlias: origin.fromAlias,
          ts: this.now(),
          corrId: a.msgId,
          status: "ok",
          errorCode: null,
          terminal: false,
          body:
            `[claude-ipc] PASSED — "${a.from}" stepped back from ${a.msgId}` +
            (a.reason ? `: ${a.reason}` : "") +
            `. It was addressed to ${projectPath(origin.toAlias)}, not to them, so it stays open for the others.`,
          conversationId: origin.conversationId,
        });
        this.backend.append(note);
        this.backend.enqueue(note.id, origin.fromAlias);
        this.notify(origin.fromAlias);
      }
      return ok({ passed: true, scope: "you", note: "The ask stays open for other members of this project." });
    }

    this.backend.setConsent(a.msgId, a.from, false);
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
      this.notify(origin.fromAlias);
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
    const a = req.args as { alias?: string; project?: string };
    if (a.project) {
      // Ungated like a peek — a cheap number, and openness is the anti-silo stance.
      const n = this.projectMailboxes(a.project).reduce((s, addr) => s + this.backend.pending(addr).length, 0);
      return ok({ count: n });
    }
    if (!a.alias) return fail("bad_args", "count needs alias");
    const denied = this.requireOwner(req, a.alias); // your own inbox size only
    if (denied) return denied;
    return ok({ count: this.backend.pending(a.alias).length });
  }

  /** Drop offline peers idle past a window — clears the dead-session graveyard. */
  private prune(req: Request): Response {
    const a = req.args as { offlineForS?: number };
    const window = a.offlineForS ?? 24 * 3600;
    return ok({ pruned: this.registry.pruneOffline(this.now() - window) });
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

  /** Non-blocking peek: has a correlated reply landed in this alias's inbox yet? */
  private awaitReply(req: Request): Response {
    const a = req.args as { alias?: string; corrId?: string; untilTerminal?: boolean };
    if (!a.alias || !a.corrId) return fail("bad_args", "await needs alias + corrId");
    const denied = this.requireOwner(req, a.alias); // only the asker polls its inbox
    if (denied) return denied;
    const matches = this.backend.pending(a.alias).filter((m) => m.kind === "response" && m.corrId === a.corrId);
    // Default: wait for the FINAL (terminal) reply, skipping acks/interim updates
    // — those still surface in the inbox at the asker's turns, they just don't
    // satisfy a blocking await. untilTerminal=false returns the latest reply.
    const found = (a.untilTerminal ?? true) ? matches.find((m) => m.terminal) : matches.at(-1);
    return ok(found ? { response: found } : { pending: true, updates: matches.length });
  }
}
