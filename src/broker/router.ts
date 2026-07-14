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
import {
  isProjectAddress,
  normalizeProjectPath,
  projectAddress,
  projectPath,
  sameLineage,
  withinProject,
} from "../projectAddress.ts";
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

  /**
   * Names no session may take.
   *
   * The broker signs its own notices "ipc" — the nudges, the parked notices, the "no
   * reply yet, you may act without them". A peer holding that name could mint any of
   * those, and a recipient has no way to tell the difference. "*" is the broadcast
   * address and belongs to nobody either.
   */
  private static readonly RESERVED = new Set(["ipc", "*"]);

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
    if (Router.RESERVED.has(a.alias)) {
      return fail("bad_args", `"${a.alias}" is reserved — the broker speaks under that name. Pick another.`);
    }
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
        if (e.status !== "offline" && withinProject(e.cwd, projectPath(a.to))) this.notify(e.alias);
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
      const consuming = a.consume ?? false;
      const messages = this.projectMailboxes(a.project, !consuming).flatMap((addr) =>
        this.backend.pending(addr, { consume: consuming }),
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
      if (dir && (!e?.cwd || !withinProject(e.cwd, dir))) continue;
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
  private projectMailboxes(dir: string, peek = false): string[] {
    const d = normalizeProjectPath(dir);
    // Peeking runs BOTH ways on purpose — a repo-root session may read what its
    // subdirectories were sent, and vice versa; visibility of a project mailbox is
    // deliberately open. CONSUMING does not: you may only claim mail addressed to a
    // directory you actually work inside. Otherwise a session opened in the home
    // directory is a "member" of every project on the machine and its per-turn hook
    // quietly drains all of them.
    return this.backend
      .projectAddresses()
      .filter((addr) => (peek ? sameLineage(projectPath(addr), d) : withinProject(d, projectPath(addr))));
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
      // A claim only hides the work while its owner is still around to do it. Derive
      // that from liveness at read time rather than trusting the claim forever: a
      // session that claimed a job and then died would otherwise take it to the grave,
      // invisible to every other member — a silent way to lose work.
      return owner === null || owner === self || !this.claimStillHeld(owner);
    });
  }

  /** True while the claimer is a session we'd still route to (registered, not offline). */
  private claimStillHeld(owner: string): boolean {
    const e = this.registry.get(owner);
    return Boolean(e && e.status !== "offline");
  }

  private requireProjectMember(req: Request, dir: string): Response | null {
    if (!req.token) return fail("unauthorized", "consuming project mail needs a session token");
    const d = normalizeProjectPath(dir);
    for (const e of this.registry.list()) {
      if (this.registry.tokenOf(e.alias) === req.token && withinProject(e.cwd, d)) return null;
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
    // An answer with no words is not an answer. Acking an empty reply as `terminal:true`
    // told the sender they'd been answered while delivering zero bytes — the caller had
    // its body dropped (e.g. passed as an unread flag) and never learned. An error reply
    // is the one exception: its errorCode carries the meaning, so it may be body-less.
    if (a.status !== "error" && !(a.body ?? "").trim()) {
      return fail("empty_reply", "a reply needs a body — nothing was delivered. (The body is positional: reply <id> --from <you> \"<answer>\")");
    }
    const denied = this.requireOwner(req, a.from); // you may only reply AS yourself
    if (denied) return denied;
    const origin = this.backend.originOf(a.corrId);
    if (!origin) {
      // The id may be a real message that simply isn't a repliable ASK — a response or
      // an inform. You reply to answer an open question; to keep a thread going past
      // that, you SEND. Say which it is and give the exact command, instead of the
      // dead-end "no message" (the message is right there in their inbox).
      const msg = this.backend.get(a.corrId);
      if (msg) {
        const other = msg.fromAlias === a.from ? msg.toAlias : msg.fromAlias;
        return fail(
          "not_an_ask",
          `${a.corrId} is a ${msg.kind}, not a question — you reply to answer an ask, not to continue a thread. ` +
            `To reply to ${other}, send them a new message: claude-ipc send --to ${other} --from ${a.from} "<your message>"`,
        );
      }
      return fail("no_origin", `no message with id ${a.corrId}`);
    }
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
    const bad = this.notActable(a.msgId, a.alias);
    if (bad) return bad;
    this.backend.markSurfaced(a.msgId, a.alias);
    // Deliberately deferring an ask is a kind of answer: stop nudging them about it.
    // The SENDER's deadline is untouched — when to stop waiting is their call, and a
    // recipient must not be able to extend it by snoozing.
    this.backend.deferNudge(a.msgId, this.now());
    return ok({ surfaced: true });
  }

  /**
   * A message this alias may accept / decline / snooze — one that was actually delivered
   * to it. Without this, all three verbs ran an UPDATE keyed on (msgId, alias) that matched
   * zero rows for a wrong or mistyped id and still returned success — telling an agent it
   * consented to something that isn't there. A no-op that reports success is the worst kind.
   */
  private notActable(msgId: string, alias: string): Response | null {
    const msg = this.backend.get(msgId);
    if (!msg) return fail("no_message", `no message with id ${msgId}`);
    const direct = this.backend.deliveriesFor(msgId).some((d) => d.toAlias === alias);
    const e = this.registry.get(alias);
    const viaProject = isProjectAddress(msg.toAlias) && Boolean(e?.cwd) && withinProject(e!.cwd, projectPath(msg.toAlias));
    if (!direct && !viaProject) {
      return fail("not_yours", `${msgId} was not delivered to you — you can only act on your own mail`);
    }
    return null;
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
    const bad = this.notActable(a.msgId, a.alias);
    if (bad) return bad;

    const origin = this.backend.get(a.msgId);
    if (origin && isProjectAddress(origin.toAlias)) {
      // A claim held by a session that has since gone offline is stale — the work went
      // unfinished. Free it so a live member can pick it up, then race for it normally.
      const holder = this.backend.projectClaim(a.msgId);
      if (holder && holder !== a.alias && !this.claimStillHeld(holder)) this.backend.releaseClaim(a.msgId);
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
    const bad = this.notActable(a.msgId, a.from);
    if (bad) return bad;
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
    const strip = this.stripForCaller(req);
    return ok({
      message: strip(message),
      deliveries: this.backend.deliveriesFor(a.msgId),
      responses: this.backend
        .history({})
        .filter((m) => m.corrId === a.msgId)
        .map(strip),
    });
  }

  /**
   * The flow, visible to any local caller — the operator's own `log`/`tail` is first-class.
   *
   * Reaching this same-uid 0700 socket already proves you own the machine, so bodies and
   * routing are yours to read; blanking them blinded the monitoring the tool exists for.
   * The transcript POINTER is the one thing not sprayed cross-session (see stripForCaller).
   */
  private history(req: Request): Response {
    const a = req.args as { peer?: string; since?: number; conversationId?: string };
    const strip = this.stripForCaller(req);
    return ok({ messages: this.backend.history(a).map(strip) });
  }

  /** Redact the transcript pointer from any message the caller isn't a party to. */
  private stripForCaller(req: Request): (m: Message) => Message {
    const self = this.aliasOfToken(req);
    return (m) => (self && this.involves(m, self) ? m : { ...m, contextPtr: null });
  }

  /** Was this session either end of the message — or a member of the project it went to? */
  private involves(m: Message, self: string): boolean {
    if (m.fromAlias === self || m.toAlias === self) return true;
    if (m.toAlias === "*") return true;
    if (!isProjectAddress(m.toAlias)) return false;
    const e = this.registry.get(self);
    return Boolean(e?.cwd && withinProject(e.cwd, projectPath(m.toAlias)));
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
