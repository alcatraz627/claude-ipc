/**
 * Turns a wire request into an effect on storage + registry, and a response.
 *
 * The broker's whole decision surface: registration, liveness, routing,
 * correlation, consent, inbox pulls. Synchronous end to end — storage is
 * synchronous — so it is trivially testable with an injected clock + id source.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeAlias } from "../aliasStore.ts";
import { ttyForPid } from "../badge.ts";
import { config } from "../config.ts";
import { makeMessage, type DeliveredVia, type ErrorCode, type Kind, type Message, type Status } from "../models.ts";
import {
  isProjectAddress,
  normalizeProjectPath,
  projectAddress,
  projectPath,
  sameLineage,
  withinProject,
} from "../projectAddress.ts";
import { HUB_CONTRACT_VERSION, PROTOCOL_VERSION, type Request, type Response } from "../protocol.ts";
import type { StorageBackend } from "../storage/base.ts";
import type { Registry } from "./registry.ts";

const ok = (result: unknown): Response => ({ ok: true, result });
const fail = (code: string, message: string, data?: unknown): Response => ({
  ok: false,
  error: data === undefined ? { code, message } : { code, message, data },
});

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

  /** Replay outage intents when the broker returns, even if the sender session ended. */
  reconcilePendingOutbox(): { attempted: number; remaining: number } {
    const intents = this.backend.pendingOutboundAll();
    for (const intent of intents) {
      const context = intent.args.contextPtr as { sessionId?: unknown; cwd?: unknown } | undefined;
      let preservedToken: string | undefined;
      try {
        preservedToken = readFileSync(join(config.tokensDir, encodeURIComponent(intent.fromAlias)), "utf8").trim() || undefined;
      } catch {
        // A genuinely pruned sender has no token file. The durable intent is
        // still replayable inside the broker's same-user trust boundary.
      }
      const existingToken = this.registry.tokenOf(intent.fromAlias);
      const token = existingToken ?? this.registry.restoreOutboxOwner(
        intent.fromAlias,
        typeof context?.sessionId === "string" ? context.sessionId : `outbox:${intent.fromAlias}`,
        typeof context?.cwd === "string" ? context.cwd : "",
        preservedToken,
      );
      this.reconcile({
        v: PROTOCOL_VERSION,
        op: "reconcile",
        args: { alias: intent.fromAlias },
        token,
      });
      if (!existingToken) this.registry.dropRestoredOutboxOwner(intent.fromAlias, token);
    }
    return { attempted: intents.length, remaining: this.backend.pendingOutboundAll().length };
  }

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
        case "reconcile":
          return this.reconcile(req);
        case "check":
          return this.check(req);
        case "deliver":
          return this.deliver(req);
        case "lease":
          return this.lease(req);
        case "ack_delivery":
          return this.ackDelivery(req);
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
        case "supersede":
          return this.supersede(req);
        case "digest":
          return this.digest(req);
        case "asks":
          return this.asks(req);
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
      service?: boolean;
    };
    if (!a.alias || !a.sessionId) return fail("bad_args", "register needs alias + sessionId");
    if (Router.RESERVED.has(a.alias)) {
      return fail("bad_args", `"${a.alias}" is reserved — the broker speaks under that name. Pick another.`);
    }
    // "user" is the human owner's sentinel: a message from it means a PERSON typed
    // it, so no session may wear it as its own name. It is claimable only as a
    // service identity (a deliberate act, token-guarded and prune-exempt after).
    if (a.alias === "user" && a.service !== true) {
      return fail(
        "bad_args",
        `"user" is the human owner's sentinel — a session can't register it as its alias. ` +
          `The owner claims it once, deliberately: claude-ipc register user --service`,
      );
    }
    // An alias is interpolated raw into every rendered ⟨…⟩ frame; neutralization
    // covers brackets but not control chars — a newline would forge a whole extra
    // line in a peer's context. Reject anything the slug wouldn't preserve, at this
    // boundary (every entry point — CLI, MCP, hooks — passes through here).
    if (sanitizeAlias(a.alias) !== a.alias) {
      const safe = sanitizeAlias(a.alias);
      return fail(
        "bad_args",
        `"${a.alias.replace(/[\n\r\t]/g, "·")}" isn't a safe alias — use lowercase letters, digits, dots, and dashes` +
          (safe ? ` (e.g. "${safe}")` : "") + ".",
      );
    }
    const tty = a.tty ?? (a.pid ? ttyForPid(a.pid) : null);
    const result = this.registry.register(
      a.alias,
      { sessionId: a.sessionId, cwd: a.cwd ?? "", caps: a.caps, pid: a.pid ?? null, tty, service: a.service === true },
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
      operationId?: string;
      messageId?: string;
    };
    if (!a.from || !a.to) return fail("bad_args", "send needs from + to");
    if (isProjectAddress(a.to)) a.to = projectAddress(projectPath(a.to));
    if (a.messageId && !/^msg-[a-f0-9]{16}$/.test(a.messageId)) {
      return fail("bad_args", "messageId must use the broker's msg- plus 16 lowercase hex format");
    }
    // "ipc" has no token, so requireOwner can't protect it — but it IS the broker's
    // signature (nudges, park notices). Reject it as a sender unconditionally, not
    // behind the disableable strict flag, or a peer can forge a broker notice.
    if (Router.RESERVED.has(a.from)) return fail("bad_args", `"${a.from}" is reserved — you can't send as the broker.`);
    const denied = this.requireOwner(req, a.from); // you may only send AS yourself
    if (denied) return denied;
    // A token-authenticated send proves the owner is alive right now — refresh
    // liveness before the content guards: a send refused for an empty body or bad
    // kind still came from a live agent, and requireOwner blocked anyone who isn't.
    this.registry.touchByAct(a.from);
    if (a.operationId) {
      const existing = this.backend.getByOperationId(a.operationId);
      if (existing) {
        const requestedReplyBy =
          existing.toAlias !== "*" && (existing.kind === "query" || existing.kind === "request")
            ? (a.replyByS === undefined ? (existing.replyByS ?? null) : a.replyByS)
            : null;
        if (existing.fromAlias !== a.from) return fail("operation_conflict", "operationId belongs to another sender");
        const samePayload =
          existing.toAlias === a.to &&
          existing.kind === a.kind &&
          existing.body === (a.body ?? "") &&
          existing.ttlS === (a.ttlS ?? null) &&
          (existing.replyByS ?? null) === requestedReplyBy &&
          (a.conversationId === undefined || existing.conversationId === a.conversationId) &&
          JSON.stringify(existing.contextPtr) === JSON.stringify(a.contextPtr ?? null);
        if (!samePayload) return fail("operation_conflict", "operationId was already used for a different send payload");
        const routed = this.backend.routeFor(existing.id);
        const senderSid = this.registry.get(existing.fromAlias)?.sessionId ?? null;
        const targets = routed !== null
          ? routed
          : existing.toAlias === "*"
            ? this.registry.liveAliases(existing.fromAlias).filter((target) => !senderSid || this.registry.get(target)?.sessionId !== senderSid)
            : [existing.toAlias];
        for (const target of targets) this.backend.enqueue(existing.id, target);
        if (isProjectAddress(existing.toAlias)) {
          for (const alias of this.sessionBoxes(existing.fromAlias)) this.backend.passProject(existing.id, alias);
        }
        let awaiting = this.backend.getAwaiting(existing.id);
        if (!awaiting && existing.toAlias !== "*" && (existing.kind === "query" || existing.kind === "request")) {
          const ttl = existing.ttlS ?? this.defaultTtlS;
          const replyBy = a.replyByS === undefined ? this.defaultReplyByS : a.replyByS;
          this.backend.openAwaiting(existing.id, ttl === null ? null : existing.ts + ttl, replyBy, existing.ts);
          awaiting = this.backend.getAwaiting(existing.id);
        }
        for (const target of targets) this.notify(target);
        return ok({
          msgId: existing.id,
          recipients: targets,
          conversationId: existing.conversationId,
          replyByS: awaiting?.replyByS ?? null,
          releaseAfterS: awaiting?.replyByS === null || awaiting?.replyByS === undefined ? null : awaiting.replyByS + this.finalGraceS,
          idempotentReplay: true,
        });
      }
    }
    // Strict identity: an unregistered `from` can't send — closes the window
    // where you forge a message from an alias before its owner registers.
    if (this.strict && !this.registry.has(a.from)) {
      return fail("not_registered", `${a.from} must register before sending (strict mode)`);
    }
    // A message with no words delivers nothing and reads as ghosting on the
    // receiving end — refuse at the broker so EVERY client is covered, not just
    // the CLI's own guard (a whole agent lane once talked in zero bytes).
    if (!(a.body ?? "").trim()) {
      return fail(
        "empty_send",
        `a message needs a body — nothing was sent. (The body is positional: send --to ${a.to} --from ${a.from} "<message>")`,
      );
    }
    if (!a.kind || !SENDABLE.includes(a.kind)) {
      // "response" is the top confusion: it's a real kind, but you don't SEND one —
      // you `reply` to a query, which is what creates it. Name the fix rather than
      // just listing the legal kinds.
      const hint =
        a.kind === "response"
          ? ' — to ANSWER a query/request use "claude-ipc reply <id> --from <you>", not send --kind response'
          : "";
      return fail("bad_args", `kind must be inform|query|request, got ${String(a.kind)}${hint}`);
    }

    // A project address needs no registered peer — the mailbox IS the address,
    // and it may be created before anyone works there. Canonicalize so
    // `proj:/x/` and `proj:/x` are one mailbox.
    if (!isProjectAddress(a.to) && a.to !== "*" && !this.registry.has(a.to)) {
      return fail("no_peer", `no peer named "${a.to}" is registered — nothing was sent. See who's reachable: claude-ipc peers`, {
        livePeers: this.registry.liveAliases(),
      });
    }

    // A session may hold several aliases (a launch --name plus the session-id
    // registration is the common way). A send whose recipient resolves to the
    // sender's OWN session would be accepted, delivered, and then chased by the
    // nudge machinery — the broker nagging a session to answer itself. Refuse it
    // while nothing has happened yet.
    const senderSid = this.registry.get(a.from)?.sessionId ?? null;
    if (senderSid && a.to !== "*" && !isProjectAddress(a.to) && this.registry.get(a.to)?.sessionId === senderSid) {
      return fail(
        "self_send",
        `"${a.to}" is another name for THIS session — you are "${a.from}", and a message to "${a.to}" would only ` +
          `come back to you. Nothing was sent. Pick a peer: claude-ipc peers`,
      );
    }

    // Allowlist guards who may target a peer (e.g. only certain senders may task a
    // broad-permission session). A guardrail against accidental targeting, not a
    // security boundary under the no-auth model.
    const allowed = this.allowlist[a.to];
    if (a.to !== "*" && allowed && !allowed.includes(a.from)) {
      return fail("not_allowed", `${a.from} may not target ${a.to} — nothing was sent`);
    }

    const id = a.messageId ?? this.newId();
    const idOwner = this.backend.get(id);
    if (idOwner) return fail("message_conflict", `message id ${id} already exists`);
    // A directed query/request opens a thread: stamp it with a conversationId
    // (derived from its own id) so the correlated reply — which inherits the
    // origin's conversationId — and any follow-ups share one thread key that
    // history can filter on. An explicit id from the caller always wins.
    const opensThread = a.to !== "*" && (a.kind === "query" || a.kind === "request");
    const conversationId = a.conversationId ?? (opensThread ? `conv-${id}` : null);
    const msg = makeMessage({
      id,
      operationId: a.operationId ?? null,
      kind: a.kind,
      fromAlias: a.from,
      toAlias: a.to,
      ts: this.now(),
      body: a.body ?? "",
      conversationId,
      ttlS: a.ttlS ?? null,
      replyByS:
        opensThread ? (a.replyByS === undefined ? this.defaultReplyByS : a.replyByS) : null,
      contextPtr: a.contextPtr ?? null,
    });
    // Snapshot routing in the same storage transaction as the immutable message.
    // A retry must never add peers that appeared after the original send, and a
    // crash partway through fan-out must still know the complete target set.
    const targets =
      a.to === "*"
        ? this.registry.liveAliases(a.from).filter((target) => !senderSid || this.registry.get(target)?.sessionId !== senderSid)
        : [a.to];
    this.backend.appendRouted(msg, targets);
    // Asking a project must not make the sending session answer itself. Keep the
    // shared mailbox available to every other current or future project member,
    // while every alias of the sending session is treated as having passed.
    if (isProjectAddress(a.to)) {
      for (const alias of this.sessionBoxes(a.from)) this.backend.passProject(msg.id, alias);
    }
    if (a.operationId) {
      const committed = this.backend.getByOperationId(a.operationId);
      const samePayload =
        committed?.id === id &&
        committed.fromAlias === a.from &&
        committed.toAlias === a.to &&
        committed.kind === a.kind &&
        committed.body === (a.body ?? "") &&
        committed.conversationId === conversationId &&
        committed.ttlS === (a.ttlS ?? null) &&
        (committed.replyByS ?? null) === (msg.replyByS ?? null) &&
        JSON.stringify(committed.contextPtr) === JSON.stringify(a.contextPtr ?? null);
      if (!samePayload) return fail("operation_conflict", "operationId was concurrently used for a different send payload");
    }

    for (const t of targets) this.backend.enqueue(msg.id, t);
    // Project mail can't notify its own address — nudge the live sessions
    // working in that tree instead, so their channels/badges see it.
    if (isProjectAddress(a.to)) {
      for (const e of this.registry.list()) {
        if (e.status !== "offline" && withinProject(e.cwd, projectPath(a.to))) this.notify(e.alias);
      }
    }

    // A directed query/request opens an awaiting (no auto-timeout unless a ttl was
    // given). The reply-by deadline resolves HERE, not in the CLI, so an MCP ask or
    // a stale compiled binary still gets chased; `replyByS: null` = the sender
    // opted out, undefined = they didn't say, so they get the default.
    let replyBy: number | null = null;
    if (a.to !== "*" && (a.kind === "query" || a.kind === "request")) {
      const ttl = a.ttlS ?? this.defaultTtlS;
      replyBy = a.replyByS === undefined ? this.defaultReplyByS : a.replyByS;
      this.backend.openAwaiting(msg.id, ttl !== null ? this.now() + ttl : null, replyBy, this.now());
    }

    for (const t of targets) this.notify(t);
    // Hand back the deadline the broker will actually honour (a CLI guess is a
    // number nothing enforces) and the roster's view of the recipient — a send to
    // a long-dark alias succeeds by design, but the sender deserves to know.
    const rec = a.to !== "*" && !isProjectAddress(a.to) ? this.registry.get(a.to) : null;
    return ok({
      msgId: msg.id,
      recipients: targets,
      conversationId,
      replyByS: replyBy,
      releaseAfterS: replyBy === null ? null : replyBy + this.finalGraceS,
      recipient: rec ? { status: rec.status, lastSeen: rec.lastSeen } : undefined,
    });
  }

  /** Route complete send intents persisted by a client during broker downtime. */
  private reconcile(req: Request): Response {
    const a = req.args as { alias?: string };
    if (!a.alias) return fail("bad_args", "reconcile needs alias");
    const denied = this.requireOwner(req, a.alias);
    if (denied) return denied;
    const outcomes: { operationId: string; ok: boolean; result?: unknown; error?: unknown; permanent?: boolean }[] = [];
    for (const intent of this.backend.pendingOutbound(a.alias)) {
      const response = this.send({ ...req, op: "send", args: intent.args });
      if (response.ok) {
        this.backend.deleteOutbound(intent.operationId);
        outcomes.push({ operationId: intent.operationId, ok: true, result: response.result });
      } else {
        const permanent = ["bad_args", "empty_send", "not_allowed", "self_send", "operation_conflict", "message_conflict"].includes(
          response.error.code,
        );
        if (permanent) this.backend.deleteOutbound(intent.operationId);
        outcomes.push({ operationId: intent.operationId, ok: false, error: response.error, permanent });
      }
    }
    return ok({ outcomes, remaining: this.backend.pendingOutbound(a.alias).length });
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
        consuming ? this.backend.pending(addr) : this.backend.recoverable(addr),
      );
      const visible = this.stillOwedBy(messages, this.aliasOfToken(req));
      if (consuming) for (const message of visible) this.backend.markConsumed(message.id, message.toAlias);
      return ok({ messages: this.annotateChases(visible) });
    }
    if (!a.alias) return fail("bad_args", "check needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner reads its inbox
    if (denied) return denied;
    const consume = a.consume ?? false;
    const boxes = this.sessionBoxes(a.alias);
    const messages = this.dedupeById(boxes.flatMap((addr) =>
      consume ? this.backend.pending(addr, { consume: true }) : this.backend.recoverable(addr),
    ));
    // Only a read that CHANGED the mailbox is worth announcing. The inbox watcher peeks
    // every 10 seconds; notifying on a peek meant the broker repainted the session's tab
    // badge forever, fighting whatever the user had put there.
    if (consume) for (const addr of boxes) this.notify(addr);
    return ok({ messages: this.annotateChases(messages) });
  }

  /**
   * Stamp each recipient-facing chase notice with the fate of the ask it chases.
   *
   * A NUDGE outlives its ask: inherited boxes carried days-old chases for settled
   * asks, indistinguishable from live obligations. askState lets readers fold the
   * settled ones and keep parked ones visible (a parked ask is still answerable).
   * Sender-facing notices (terminal:true) are one-shot info, never annotated.
   */
  private annotateChases(messages: Message[]): (Message & { askState?: string })[] {
    return messages.map((m) => {
      if (m.fromAlias !== "ipc" || !m.corrId || m.terminal !== false) return m;
      const a = this.backend.getAwaiting(m.corrId);
      const askState = !a || !a.closed ? "open" : (a.closedReason ?? "parked");
      return { ...m, askState };
    });
  }

  /**
   * Record that a later message supersedes an earlier one (D2). Advisory: it changes
   * how a successor triages inherited mail, never delivery — the superseded message
   * stays in its box and a late reply still lands. You may retire only YOUR OWN
   * earlier word with YOUR OWN later one: the caller's session must have SENT both,
   * so nobody can fold an obligation they never issued (a peer can't hide the asks it
   * owes from a successor). And it must be later — no superseding a newer message.
   */
  private supersede(req: Request): Response {
    const a = req.args as { old?: string; by?: string; from?: string };
    if (!a.old || !a.by) return fail("bad_args", "supersede needs old + by (message ids)");
    if (a.old === a.by) return fail("bad_args", "a message can't supersede itself");
    const oldMsg = this.backend.get(a.old);
    const byMsg = this.backend.get(a.by);
    if (!oldMsg || !byMsg) return fail("not_found", "both the superseded and superseding messages must exist");
    if (byMsg.ts < oldMsg.ts) {
      return fail("bad_args", "a message cannot supersede one newer than itself — check the argument order");
    }
    // Sender of BOTH: you retire your own earlier instruction with your own later one.
    // Checking only the superseding message let a caller fold mail it merely received
    // — including pre-folding the asks it owes so a successor never chases them.
    const self = this.aliasOfToken(req);
    const mine = new Set(self ? this.sessionBoxes(self) : []);
    if (!(mine.has(oldMsg.fromAlias) && mine.has(byMsg.fromAlias))) {
      return fail("unauthorized", "supersede retires YOUR earlier message with YOUR later one — you must have sent both");
    }
    this.backend.markSuperseded(a.old, a.by);
    return ok({ superseded: a.old, by: a.by });
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
      return ok({ messages: this.annotateChases(this.stillOwedBy(messages, this.aliasOfToken(req))) });
    }
    if (!a.alias) return fail("bad_args", "deliver needs alias");
    const denied = this.requireOwner(req, a.alias); // only the owner drains its queue
    if (denied) return denied;
    // Session-scoped: the wake must claim EVERY box this session owns, or sibling-box
    // mail never wakes it (vb-fable's expired-TTL bug). A broadcast lands in each box,
    // so dedupe by id before handing it back.
    const boxes = this.sessionBoxes(a.alias);
    const messages = this.dedupeById(boxes.flatMap((addr) => this.backend.claimForDelivery(addr, a.via ?? "hook")));
    for (const addr of boxes) this.notify(addr);
    return ok({ messages: this.annotateChases(messages) });
  }

  /**
   * Reserve messages for a host without removing them from the actionable set.
   * The host acknowledges only after App Server persisted the tool output. An
   * expired lease can be reclaimed after a crash, so delivery is at least once.
   */
  private lease(req: Request): Response {
    const a = req.args as { alias?: string; project?: string; via?: DeliveredVia; leaseId?: string; leaseS?: number };
    if (!a.leaseId) return fail("bad_args", "lease needs leaseId");
    const leaseUntil = this.now() + Math.max(1, a.leaseS ?? 30);
    if (a.project) {
      const denied = this.requireProjectMember(req, a.project);
      if (denied) return denied;
      const self = this.aliasOfToken(req)!;
      const messages = this.stillOwedBy(
        this.projectMailboxes(a.project).flatMap((addr) => this.backend.pending(addr)),
        self,
      ).filter((message) => !this.backend.projectSurfaced(message.id, self));
      return ok({ leaseId: a.leaseId, leaseUntil, messages: this.annotateChases(messages) });
    }
    if (!a.alias) return fail("bad_args", "lease needs alias");
    const denied = this.requireOwner(req, a.alias);
    if (denied) return denied;
    const boxes = this.sessionBoxes(a.alias);
    const messages = this.dedupeById(
      boxes.flatMap((addr) => this.backend.leaseForDelivery(addr, a.via ?? "channel", a.leaseId!, this.now(), leaseUntil)),
    );
    return ok({ leaseId: a.leaseId, leaseUntil, messages: this.annotateChases(messages) });
  }

  private ackDelivery(req: Request): Response {
    const a = req.args as { alias?: string; project?: string; leaseId?: string; msgIds?: string[] };
    if (!a.leaseId || !Array.isArray(a.msgIds)) return fail("bad_args", "ack_delivery needs leaseId + msgIds");
    if (a.project) {
      const denied = this.requireProjectMember(req, a.project);
      if (denied) return denied;
      const self = this.aliasOfToken(req)!;
      const boxes = new Set(this.projectMailboxes(a.project));
      let acknowledged = 0;
      for (const msgId of a.msgIds) {
        const message = this.backend.get(msgId);
        if (!message) continue;
        const alreadySettled = this.backend
          .deliveriesFor(msgId)
          .some((delivery) => delivery.toAlias === message.toAlias && !["queued", "delivered", "surfaced"].includes(delivery.state));
        if (alreadySettled) {
          acknowledged++;
          continue;
        }
        if (!boxes.has(message.toAlias) || this.backend.projectSurfaced(msgId, self)) continue;
        this.backend.markProjectSurfaced(msgId, self);
        acknowledged++;
      }
      return ok({ acknowledged });
    }
    if (!a.alias) return fail("bad_args", "ack_delivery needs alias");
    const denied = this.requireOwner(req, a.alias);
    if (denied) return denied;
    const boxes = this.sessionBoxes(a.alias);
    const acknowledged = a.msgIds.filter((msgId) => {
      if (boxes.reduce((n, addr) => n + this.backend.ackDelivery(addr, a.leaseId!, [msgId]), 0) > 0) return true;
      return this.backend
        .deliveriesFor(msgId)
        .some((delivery) => boxes.includes(delivery.toAlias) && !["queued", "delivered", "surfaced"].includes(delivery.state));
    }).length;
    return ok({ acknowledged });
  }

  /**
   * Session mailboxes whose owner is gone but whose mail still waits — what a
   * successor agent should know about when it picks the work back up. Scoped
   * to a directory's lineage when `project` is given; a dead alias whose cwd
   * is unknown (pruned from the registry) only shows in the global listing.
   */
  private orphans(req: Request): Response {
    const a = req.args as { project?: string; triage?: boolean };
    const dir = a.project ? normalizeProjectPath(a.project) : null;
    const entries = new Map(this.registry.list().map((e) => [e.alias, e]));
    const out: {
      alias: string;
      cwd: string | null;
      lastSeen: number | null;
      pending: number;
      chases: number;
      oldestTs: number | null;
      folded?: number;
      open?: number;
    }[] = [];
    for (const addr of this.backend.recoverableAddresses()) {
      if (isProjectAddress(addr)) continue; // project mail is not orphaned — it waits by design
      const e = entries.get(addr);
      if (e && e.status !== "offline") continue; // owner can still wake — not an orphan
      if (dir && (!e?.cwd || !withinProject(e.cwd, dir))) continue;
      const msgs = this.backend.recoverable(addr);
      const row: (typeof out)[number] = {
        alias: addr,
        cwd: e?.cwd ?? null,
        lastSeen: e?.lastSeen ?? null,
        pending: msgs.length,
        // Broker bookkeeping (nudges, last calls, park notices) is not real mail;
        // successors read the split so noise can't masquerade as obligations.
        chases: msgs.filter((m) => m.fromAlias === "ipc").length,
        // The oldest waiting message's age is the staleness signal: mail from several
        // lineages ago is the case most likely to have been superseded, so a successor
        // can weigh it before acting rather than treating a raw unread as fresh.
        oldestTs: msgs.length ? Math.min(...msgs.map((m) => m.ts)) : null,
      };
      if (a.triage) {
        const folded = msgs.filter((m) => this.isSuperseded(m, msgs)).length;
        row.folded = folded;
        row.open = msgs.length - folded;
      }
      out.push(row);
    }
    out.sort((x, y) => y.pending - x.pending);
    return ok({ orphans: out });
  }

  /**
   * Is this message a countermanded arc a successor can fold? Two signals, honest
   * about strength: STRONG is an explicit `supersede` marker; WEAK is a later turn in
   * the SAME thread and box (a likely-stale earlier turn, never a cross-thread guess).
   * Folding only hides it from the summary count — it stays in the box, answerable.
   */
  private isSuperseded(msg: Message, boxPeers: Message[]): boolean {
    if (this.backend.supersededBy(msg.id) !== null) return true; // strong: explicit, folds anything
    // The weak signal NEVER folds an obligation — an unanswered query/request drops out
    // of `open` only on an explicit marker, or a benign later message in the thread would
    // silently hide live work (the exact hazard the design set out to avoid).
    if (msg.kind === "query" || msg.kind === "request") return false;
    if (!msg.conversationId) return false;
    return boxPeers.some(
      (p) => p.id !== msg.id && p.conversationId === msg.conversationId && p.ts > msg.ts,
    ); // weak: a later turn in the same thread, same box — only for non-obligation kinds
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
   * Every alias-addressed mailbox this session owns — the chokepoint that makes a
   * personal mailbox belong to the SESSION, not a single name.
   *
   * Callers pass an anchor that already cleared requireOwner; its siblings share one
   * session by the registry, so returning their boxes hands back only the caller's
   * own mail. check/deliver/count route through here so no surface can be per-alias;
   * the session-scope test enumerates them.
   */
  private sessionBoxes(anchorAlias: string): string[] {
    const entry = this.registry.list().find((e) => e.alias === anchorAlias);
    return entry?.sessionAliases ?? [anchorAlias];
  }

  /** Union of several boxes, deduped by message id — a broadcast lands in every
   *  sibling box, so a naive concat would show or count it once per alias. */
  private dedupeById(messages: Message[]): Message[] {
    const seen = new Set<string>();
    return messages.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
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
    const selfSid = this.registry.get(self)?.sessionId ?? null;
    return messages.filter((m) => {
      const causalSender = m.fromAlias === "ipc" && m.corrId ? this.backend.originOf(m.corrId)?.fromAlias : m.fromAlias;
      if (selfSid && causalSender && this.registry.get(causalSender)?.sessionId === selfSid) return false;
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
    if (Router.RESERVED.has(a.from)) return fail("bad_args", `"${a.from}" is reserved — you can't reply as the broker.`);
    const denied = this.requireOwner(req, a.from); // you may only reply AS yourself
    if (denied) return denied;
    this.registry.touchByAct(a.from); // an authorized reply is proof of life
    const origin = this.backend.originOf(a.corrId);
    if (!origin) {
      const msg = this.backend.get(a.corrId);
      if (msg) {
        // An inform's RECIPIENT may reply — it threads a correlated response back
        // to the author without any of the ask machinery (informs never open an
        // awaiting, so nothing is owed, nudged, or chased). The author continuing
        // their own inform, or a response, still steers to send.
        if (msg.kind === "inform" && msg.fromAlias !== a.from) {
          return this.replyToInform(
            { from: a.from, corrId: a.corrId, body: a.body, status: a.status, errorCode: a.errorCode, terminal: a.terminal },
            msg,
          );
        }
        const other = msg.fromAlias === a.from ? msg.toAlias : msg.fromAlias;
        // Suggest only a command that would currently succeed: a broadcast or a
        // project mailbox is never a registered peer alias (they'd hit the pruned
        // branch and get advice that cannot work), and a pruned alias gets lane
        // addressing instead of a dead end (papercuts 4b + gate finding 1).
        const cont =
          other === "*"
            ? `to continue the thread, broadcast again: claude-ipc send --to "*" --from ${a.from} "<your message>"`
            : isProjectAddress(other)
              ? `to continue the thread in that lane: claude-ipc send --to-project ${projectPath(other)} --from ${a.from} "<your message>"`
              : this.registry.list().some((p) => p.alias === other)
                ? `to continue the thread, send: claude-ipc send --to ${other} --from ${a.from} "<your message>"`
                : `"${other}" is no longer registered — reach their lane instead: claude-ipc send --to-project <their repo dir> --from ${a.from} "<your message>"`;
        return fail(
          "not_an_ask",
          `${a.corrId} is ${msg.kind === "inform" ? "an" : "a"} ${msg.kind}${msg.kind === "inform" ? " you sent" : ""}, not a question you can answer — ${cont}`,
        );
      }
      return fail("no_origin", `no message with id ${a.corrId}`);
    }
    const aw = this.backend.getAwaiting(a.corrId);
    // Only an explicit cancel refuses — a real late answer beats a provisional
    // timeout. And refuse LOUDLY with the way out: `ok({dropped:true})` once binned
    // a composed reply while reading as success (a field agent lost its report to
    // that, twice in one day). The dead ask's pending copy is consumed so it stops nagging.
    if (aw?.closed && aw.closedReason === "cancelled") {
      this.backend.markConsumed(a.corrId, a.from);
      if (isProjectAddress(origin.toAlias)) this.backend.markConsumed(a.corrId, origin.toAlias);
      return fail(
        "ask_cancelled",
        `${origin.fromAlias} cancelled ${a.corrId} — your reply was NOT delivered, and no reply is owed. ` +
          `If the answer still matters, send it directly: claude-ipc send --to ${origin.fromAlias} --from ${a.from} "<your answer>"`,
      );
    }
    // An answer with no words is not an answer. Acking an empty reply as `terminal:true`
    // told the sender they'd been answered while delivering zero bytes. Checked AFTER
    // the cancellation above: "the ask is dead" outranks "your body is empty" — the
    // composer should learn there's nothing to answer before they fix the body and
    // retry into the same refusal. An error reply may be body-less (errorCode carries it).
    if (a.status !== "error" && !(a.body ?? "").trim()) {
      return fail("empty_reply", "a reply needs a body — nothing was delivered. (The body is positional: reply <id> --from <you> \"<answer>\")");
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
    // Answering consumes the replier's own still-queued copy of the ask, or the
    // turn-end push keeps reminding about an answered request (found live 2026-07-10).
    this.backend.markConsumed(a.corrId, a.from);
    // An ask delivered to a SIBLING alias of the replier (one session) is consumed
    // there too, or the addressed alias keeps showing an answered ask as owed.
    const fromSid = this.registry.get(a.from)?.sessionId ?? null;
    if (
      fromSid &&
      origin.toAlias !== a.from &&
      !isProjectAddress(origin.toAlias) &&
      this.registry.get(origin.toAlias)?.sessionId === fromSid
    ) {
      this.backend.markConsumed(a.corrId, origin.toAlias);
    }
    // A project-addressed ask has its delivery row under the proj: address,
    // not the replier's alias — consume that too, or every other member keeps
    // seeing an already-answered ask as pending.
    if (isProjectAddress(origin.toAlias)) this.backend.markConsumed(a.corrId, origin.toAlias);
    this.notify(origin.fromAlias);
    // Say who the answer is waiting on if the asker has gone dark — a reply into
    // a dead session's mailbox reads as delivered while nobody may ever read it.
    const asker = this.registry.get(origin.fromAlias);
    return ok({
      msgId: resp.id,
      terminal,
      late,
      asker: asker ? { status: asker.status, lastSeen: asker.lastSeen } : undefined,
    });
  }

  /**
   * Thread an answer onto an inform (owner-ruled): the recipient's response is
   * correlated and delivered, but nothing is owed — informs have no awaiting,
   * so no deadline, nudge, or release machinery ever runs for these.
   */
  private replyToInform(
    a: { from: string; corrId: string; body?: string; status?: Status; errorCode?: ErrorCode; terminal?: boolean },
    origin: Message,
  ): Response {
    // only someone the inform was actually delivered to (or a project member) has standing
    const bad = this.notActable(a.corrId, a.from);
    if (bad) return bad;
    // Same exemption as the ask path: an error reply may be body-less because
    // its errorCode carries the meaning; a normal answer with no words is not
    // an answer.
    if (a.status !== "error" && !(a.body ?? "").trim()) {
      return fail("empty_reply", "a reply needs a body — nothing was delivered. (The body is positional: reply <id> --from <you> \"<answer>\")");
    }
    const resp = makeMessage({
      id: this.newId(),
      kind: "response",
      fromAlias: a.from,
      toAlias: origin.fromAlias,
      ts: this.now(),
      corrId: a.corrId,
      status: a.status ?? "ok",
      errorCode: a.errorCode ?? null,
      terminal: a.terminal ?? true,
      body: a.body ?? "",
      conversationId: origin.conversationId,
    });
    this.backend.append(resp);
    this.backend.enqueue(resp.id, origin.fromAlias);
    // The replier has acted on the inform — their own pending copy (and a sibling
    // alias's) stops counting. Project copies stay: an inform to a directory is
    // information for everyone, and one member answering claims nothing.
    this.backend.markConsumed(a.corrId, a.from);
    const fromSid = this.registry.get(a.from)?.sessionId ?? null;
    if (fromSid && origin.toAlias !== a.from && !isProjectAddress(origin.toAlias)) {
      if (this.registry.get(origin.toAlias)?.sessionId === fromSid) this.backend.markConsumed(a.corrId, origin.toAlias);
    }
    this.notify(origin.fromAlias);
    const asker = this.registry.get(origin.fromAlias);
    return ok({
      msgId: resp.id,
      terminal: resp.terminal,
      late: false,
      asker: asker ? { status: asker.status, lastSeen: asker.lastSeen } : undefined,
    });
  }

  /** Defer a message without losing it: marked seen-and-deferred, still pending + owed. */
  private snooze(req: Request): Response {
    const a = req.args as { alias?: string; msgId?: string };
    if (!a.alias || !a.msgId) return fail("bad_args", "snooze needs alias + msgId");
    const denied = this.requireOwner(req, a.alias); // only the recipient defers
    if (denied) return denied;
    this.registry.touchByAct(a.alias);
    const bad = this.notActable(a.msgId, a.alias);
    if (bad) return bad;
    if (!this.backend.markSurfaced(a.msgId, a.alias)) {
      return fail("invalid_state", `message ${a.msgId} is already settled and cannot be snoozed`);
    }
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
    this.registry.touchByAct(a.alias);
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
    this.registry.touchByAct(a.from);
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

  /** The sender abandons an outstanding request; a later reply will be refused. */
  private cancel(req: Request): Response {
    const a = req.args as { corrId?: string };
    if (!a.corrId) return fail("bad_args", "cancel needs corrId");
    const origin = this.backend.originOf(a.corrId); // only the asker cancels their ask
    // No origin = nothing to cancel — saying `cancelled:true` about a message that
    // doesn't exist (or was never an ask) is a claim nothing backs, the same no-op-
    // reports-success class the consent verbs were cured of.
    if (!origin) {
      const msg = this.backend.get(a.corrId);
      if (msg) {
        return fail(
          "not_an_ask",
          `${a.corrId} is ${msg.kind === "inform" ? "an" : "a"} ${msg.kind} — only your own open query/request can be cancelled`,
        );
      }
      return fail("no_message", `no message with id ${a.corrId} — nothing to cancel`);
    }
    const denied = this.requireOwner(req, origin.fromAlias);
    if (denied) return denied;
    // A recipient who SAW the ask is told it was withdrawn (kind "response" so the
    // wake path carries it) rather than finding out by composing an answer into a
    // refusal; a copy never seen is consumed silently. A second cancel is a no-op.
    const wasOpen = this.backend.isAwaitingOpen(a.corrId);
    this.backend.closeAwaiting(a.corrId, "cancelled");
    if (origin && wasOpen) {
      for (const d of this.backend.deliveriesFor(a.corrId)) {
        if (d.state !== "queued" && d.state !== "delivered" && d.state !== "surfaced" && d.state !== "persisted") continue;
        this.backend.markConsumed(a.corrId, d.toAlias);
        if (d.state === "queued") continue; // never seen — nothing to un-tell
        const note = makeMessage({
          id: this.newId(),
          kind: "response",
          fromAlias: "ipc",
          toAlias: d.toAlias,
          ts: this.now(),
          corrId: a.corrId,
          status: "ok",
          errorCode: null,
          terminal: false,
          body:
            `[claude-ipc] CANCELLED — ${origin.fromAlias} withdrew ${origin.kind} ${a.corrId}; no reply is owed. ` +
            `A reply to it now would be refused.`,
          conversationId: origin.conversationId,
        });
        this.backend.append(note);
        this.backend.enqueue(note.id, d.toAlias);
        // A project mailbox has no tty of its own — badge the live sessions
        // working in that tree instead, the same way send() does.
        if (isProjectAddress(d.toAlias)) {
          for (const e of this.registry.list()) {
            if (e.status !== "offline" && withinProject(e.cwd, projectPath(d.toAlias))) this.notify(e.alias);
          }
        } else {
          this.notify(d.toAlias);
        }
      }
    }
    return ok({ cancelled: true });
  }

  /**
   * Cheap pending-count for an alias — for a tab-title segment that runs every turn.
   * `seq` rides along (P3b): a monotonic inbox-event cursor that moves on any
   * pending-set change, so a watcher can see a net-zero window the count hides.
   */
  private count(req: Request): Response {
    const a = req.args as { alias?: string; project?: string };
    if (a.project) {
      // Ungated like a peek — a cheap number, and openness is the anti-silo stance.
      const boxes = this.projectMailboxes(a.project);
      const n = this.dedupeById(boxes.flatMap((addr) => this.backend.recoverable(addr))).length;
      return ok({ count: n, seq: this.backend.lastEventSeq(boxes) });
    }
    if (!a.alias) return fail("bad_args", "count needs alias");
    // Absence is an error, never a zero: an unregistered alias has NO inbox, and
    // answering 0 is indistinguishable from an empty one — a count-gated watcher
    // whose alias got pruned would poll a void forever with no signal (observed
    // live 2026-07-22). Fail so the caller learns to re-register.
    if (!this.registry.has(a.alias)) {
      return fail("not_registered", `${a.alias} is not registered — no inbox exists to count. Re-register: claude-ipc register ${a.alias}`);
    }
    const denied = this.requireOwner(req, a.alias); // your own inbox size only
    if (denied) return denied;
    const boxes = this.sessionBoxes(a.alias);
    const messages = this.dedupeById(boxes.flatMap((addr) => this.backend.recoverable(addr)));
    return ok({ count: messages.length, seq: this.backend.lastEventSeq(boxes) });
  }

  /** alias → sid from the alias-by-sid side files, for aliases the registry no longer knows. */
  private aliasSidSideMap(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (const name of readdirSync(config.aliasDir)) {
        if (name.endsWith(".tmp")) continue; // a rename in flight, not a mapping
        try {
          const alias = readFileSync(join(config.aliasDir, name), "utf8").trim();
          if (alias) out.set(alias, decodeURIComponent(name));
        } catch {
          // unreadable side file — skip, the registry may still resolve it
        }
      }
    } catch {
      // no alias dir yet
    }
    return out;
  }

  /**
   * One project's fabric state, session-keyed — the hub-digest contract §5.1
   * (docs/contracts/hub-digest.md). A pure peek under the Viewer Contract: serving
   * it consumes nothing, notifies nobody, and touches no liveness. Value laws:
   * sessions are the unit (aliases are labels), absence is null never 0, and an
   * obligation whose alias resolves to no session lands under `_unresolved`.
   */
  private digest(req: Request): Response {
    const a = req.args as { project?: string };
    if (!a.project) return fail("bad_args", "digest needs a project dir");
    const dir = normalizeProjectPath(a.project);
    const now = this.now();
    const roster = this.registry.list();
    const side = this.aliasSidSideMap();
    const open = this.backend.openAwaitings();

    const bySid = new Map<string, typeof roster>();
    for (const e of roster) {
      if (!e.cwd || !withinProject(e.cwd, dir)) continue;
      bySid.set(e.sessionId, [...(bySid.get(e.sessionId) ?? []), e]);
    }

    // Dead boxes of this project still holding mail — one project-scoped number,
    // repeated on every session row (the contract's orphaned_in_cwd).
    const entries = new Map(roster.map((e) => [e.alias, e]));
    let orphanedInCwd = 0;
    for (const addr of this.backend.pendingAddresses()) {
      if (isProjectAddress(addr)) continue;
      const e = entries.get(addr);
      if (e && e.status !== "offline") continue;
      if (!e?.cwd || !withinProject(e.cwd, dir)) continue;
      orphanedInCwd += this.backend.pending(addr).length;
    }

    const sessions: Record<string, unknown> = {};
    for (const [sid, members] of bySid) {
      const aliases = [...new Set(members.flatMap((m) => m.sessionAliases ?? [m.alias]))].sort();
      const pendingMsgs = this.dedupeById(aliases.flatMap((addr) => this.backend.recoverable(addr)));
      const chase = pendingMsgs.filter((m) => m.fromAlias === "ipc").length;
      // Owed = an ask whose origin still sits pending in the session's boxes (the
      // same rule the `owed` verb applies); ask_state carries the ledger's word.
      const owed = pendingMsgs
        .filter((m) => m.kind === "query" || m.kind === "request")
        .map((m) => {
          const aw = this.backend.getAwaiting(m.id);
          return {
            corr_id: m.id,
            kind: m.kind,
            age_s: Math.max(0, now - m.ts),
            reply_by_s: aw?.replyByS ?? null,
            ask_state: !aw || !aw.closed ? "open" : (aw.closedReason ?? "parked"),
          };
        });
      const waitingOn = open.filter((w) => {
        const o = this.backend.originOf(w.originId);
        return o !== null && aliases.includes(o.fromAlias);
      }).length;
      const deadlines = owed
        .filter((o) => o.ask_state === "open" && o.reply_by_s !== null)
        .map((o) => (o.reply_by_s as number) - o.age_s);
      const liveness = members.some((m) => m.status === "live")
        ? "live"
        : members.some((m) => m.status === "idle")
          ? "idle"
          : "offline";
      sessions[sid] = {
        aliases,
        role: null, // reserved until role semantics ship
        liveness_claim: liveness,
        unread: pendingMsgs.length - chase,
        owed,
        waiting_on: waitingOn,
        orphaned_in_cwd: orphanedInCwd,
        oldest_deadline_s: deadlines.length ? Math.min(...deadlines) : null,
        chase_noise_folded: chase,
      };
    }

    // Never dropped: obligations whose recipient alias resolves to no session at
    // all (registry AND side files both silent) are bucketed, machine-wide.
    const unresolved = new Set<string>();
    for (const w of open) {
      const o = this.backend.originOf(w.originId);
      if (!o || o.toAlias === "*" || isProjectAddress(o.toAlias)) continue;
      if (this.registry.get(o.toAlias) || side.has(o.toAlias)) continue;
      unresolved.add(o.toAlias);
    }
    sessions["_unresolved"] = {
      aliases: [...unresolved].sort(),
      note: "obligations whose alias has no alias-by-sid entry; bucketed, never dropped",
    };

    return ok({
      protocol_version: PROTOCOL_VERSION,
      contract_version: HUB_CONTRACT_VERSION,
      ts: new Date(now * 1000).toISOString(),
      sessions,
    });
  }

  /**
   * Every open ask on the broker plus the orphan roster — the hub-digest
   * contract §5.2. Same Viewer-Contract law as digest: a pure peek.
   */
  private asks(req: Request): Response {
    void req; // ungated, no args beyond the op itself
    const now = this.now();
    const side = this.aliasSidSideMap();
    const sidOf = (alias: string): string | null => this.registry.get(alias)?.sessionId ?? side.get(alias) ?? null;
    const NUDGE = ["none", "nudge", "last-call"] as const;

    const asks = this.backend.openAwaitings().flatMap((w) => {
      const o = this.backend.originOf(w.originId);
      if (!o) return [];
      const direct = o.toAlias !== "*" && !isProjectAddress(o.toAlias);
      const rec = direct ? this.registry.get(o.toAlias) : null;
      return [
        {
          corr_id: w.originId,
          from_alias: o.fromAlias,
          to_alias: o.toAlias,
          to_sid: direct ? sidOf(o.toAlias) : null,
          kind: o.kind,
          age_s: Math.max(0, now - o.ts),
          reply_by_s: w.replyByS,
          nudge_stage: NUDGE[w.nudgedStage],
          ask_state: "open",
          project_cwd: isProjectAddress(o.toAlias) ? projectPath(o.toAlias) : (rec?.cwd || null),
        },
      ];
    });

    const orphans: Record<string, unknown>[] = [];
    for (const addr of this.backend.pendingAddresses()) {
      if (isProjectAddress(addr)) continue;
      const e = this.registry.get(addr);
      if (e && e.status !== "offline") continue;
      const msgs = this.backend.pending(addr);
      const chase = msgs.filter((m) => m.fromAlias === "ipc").length;
      orphans.push({
        alias: addr,
        sid: sidOf(addr),
        cwd: e?.cwd ?? null,
        real_mail: msgs.length - chase,
        chase_noise: chase,
        oldest_ts: msgs.length ? new Date(Math.min(...msgs.map((m) => m.ts)) * 1000).toISOString() : null,
      });
    }

    return ok({
      protocol_version: PROTOCOL_VERSION,
      contract_version: HUB_CONTRACT_VERSION,
      ts: new Date(now * 1000).toISOString(),
      asks,
      orphans,
    });
  }

  /** Drop offline peers idle past a window — clears the dead-session graveyard. */
  private prune(req: Request): Response {
    const a = req.args as { offlineForS?: number };
    const window = a.offlineForS ?? 24 * 3600;
    return ok({ pruned: this.registry.pruneOffline(this.now() - window) });
  }

  /** A message's full lifecycle: the message, its per-recipient deliveries, and any responses. */
  private status(req: Request): Response {
    const a = req.args as { msgId?: string; operator?: boolean };
    if (!a.msgId) return fail("bad_args", "status needs msgId");
    const message = this.backend.get(a.msgId);
    if (!message) return fail("not_found", `no message ${a.msgId}`);
    const strip = this.stripForCaller(req, a.operator === true);
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
    const a = req.args as { peer?: string; since?: number; conversationId?: string; operator?: boolean };
    const strip = this.stripForCaller(req, a.operator === true);
    return ok({ messages: this.backend.history(a).map(strip) });
  }

  /**
   * What a caller may see of a message it isn't a party to.
   *
   * A party (sender/recipient, or a session in the message's project tree) sees
   * everything; everyone else gets routing metadata but not the body or transcript
   * pointer — the content that turns "monitor the fabric" into "read private
   * traffic". The operator opts into the full firehose explicitly (`--operator`);
   * a confused agent's reflexive history() never carries that flag.
   */
  private static readonly HIDDEN_BODY = "[hidden — you are not a party to this message; run with --operator to see all bodies]";
  private stripForCaller(req: Request, operator: boolean): (m: Message) => Message {
    const self = this.aliasOfToken(req);
    // Resolve the caller's whole session — all its aliases + its cwd — ONCE, not
    // per message: history/status strip every row through this closure, and a
    // registry scan per row is O(rows × peers) on a long log.
    const selfEntry = self ? this.registry.list().find((e) => e.alias === self) : undefined;
    const mine = new Set(selfEntry?.sessionAliases ?? (self ? [self] : []));
    const cwd = selfEntry?.cwd;
    return (m) => {
      if (operator) return m;
      if (self && this.involves(m, mine, cwd)) return m;
      // bodyHidden is the unforgeable form of the marker text (review #15)
      return { ...m, body: Router.HIDDEN_BODY, contextPtr: null, bodyHidden: true };
    };
  }

  /**
   * Was the caller's SESSION either end of the message — or a member of the
   * project it went to? Checked against every alias the session holds, not just
   * the one whose token was presented: a session addressed under one name and
   * reading under a sibling (i-dream / catch-audit-7f) is the same agent, and
   * blanking its own mail's body as "not a party" was the sibling-blindness the
   * obligation and liveness fixes already cured elsewhere.
   */
  private involves(m: Message, mine: Set<string>, cwd: string | undefined): boolean {
    if (mine.has(m.fromAlias) || mine.has(m.toAlias)) return true;
    if (m.toAlias === "*") return true;
    if (!isProjectAddress(m.toAlias)) return false;
    return Boolean(cwd && withinProject(cwd, projectPath(m.toAlias)));
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
