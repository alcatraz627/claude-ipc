/**
 * The thin client every caller (MCP server, CLI, hooks) uses to reach the broker.
 *
 * It holds no state: each call opens a short-lived Unix-socket connection, writes
 * one request frame, reads one response frame, and closes. The broker is the
 * single source of truth.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type Op, type Request, type Response } from "./protocol.ts";
import { SqliteBackend } from "./storage/sqliteBackend.ts";
import { makeMessage, type Message } from "./models.ts";
import { isProjectAddress, normalizeProjectPath, projectAddress, projectPath, sameLineage, withinProject } from "./projectAddress.ts";

/**
 * The capability token for an alias is kept in an owner-only file. Holding the
 * file is what proves ownership: the broker issues the token at register time
 * and checks it on every op that acts as the alias. 0600 so another UNIX user
 * can't read it (the local same-user trust boundary is intentional).
 */
const tokenFile = (dir: string, alias: string): string => join(dir, encodeURIComponent(alias));

function readToken(dir: string, alias: string): string | undefined {
  try {
    return readFileSync(tokenFile(dir, alias), "utf8").trim() || undefined;
  } catch {
    return undefined; // no token yet — the op goes out unauthenticated
  }
}

function writeToken(dir: string, alias: string, token: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(dir, alias), token, { mode: 0o600 });
}

/**
 * Send one request and resolve with the broker's one response.
 *
 * Bounded by a deadline: if the broker accepts the connection but never replies
 * (a hung handler, a half-sent frame), the call rejects instead of hanging
 * forever — which lets the caller fall back to degraded mode rather than wedge.
 */
export function request(socketPath: string, req: Request, timeoutMs: number = config.requestTimeoutMs): Promise<Response> {
  return new Promise((resolve, reject) => {
    const dec = new FrameDecoder();
    let settled = false;
    let sock: { end(): void } | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    timer = setTimeout(() => {
      settle(() => reject(new Error(`broker did not reply within ${timeoutMs}ms`)));
      sock?.end();
    }, timeoutMs);
    // A socket write only accepts up to the send-buffer watermark (~8 KB); a
    // large request (a fat message body, a long contextPtr) overflows it and is
    // written in pieces. Keep the unsent tail and resume on `drain`, or the
    // broker never receives a complete frame and this call hangs forever.
    let outbound = encodeFrame(req);
    const pump = (socket: { write(d: Uint8Array): number }): void => {
      if (outbound.byteLength === 0) return;
      const n = socket.write(outbound);
      if (n < 0) {
        settle(() => reject(new Error("connection write failed")));
        return;
      }
      outbound = outbound.subarray(n); // fully written → zero-length; partial → remainder
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          if (settled) {
            socket.end(); // the deadline already fired before we connected — don't leak it
            return;
          }
          sock = socket;
          pump(socket);
        },
        drain(socket) {
          pump(socket);
        },
        data(socket, data) {
          const first = dec.push(new Uint8Array(data))[0];
          if (first !== undefined) {
            settle(() => resolve(first as Response));
            socket.end();
          }
        },
        error(_socket, err) {
          settle(() => reject(err));
        },
        close() {
          settle(() => reject(new Error("connection closed before a response")));
        },
      },
    }).catch((err: unknown) => settle(() => reject(err)));
  });
}

/**
 * A refusal from the broker, as a typed error.
 *
 * `code` is the stable branch key (per rules/error-classification: callers switch on
 * codes, never on message text); `data` is optional structured context (e.g. no_peer
 * carries the live roster). The message keeps its `code: message` shape because
 * existing callers (sessionStart's register-rejection guard) match on that prefix.
 */
export class BrokerError extends Error {
  constructor(
    public readonly code: string,
    detail: string,
    public readonly data?: unknown,
  ) {
    super(`${code}: ${detail}`);
    this.name = "BrokerError";
  }
}

export interface RegisterInfo {
  sessionId: string;
  cwd: string;
  caps?: string[];
  pid?: number;
  tty?: string;
  service?: boolean; // a non-session identity: never heartbeats, never auto-pruned (E2)
}

export interface SendArgs {
  from: string;
  to: string;
  kind: "inform" | "query" | "request";
  body?: string;
  conversationId?: string;
  ttlS?: number;
  replyByS?: number | null; // how long before the ask gets chased; null = never, undefined = broker default
  contextPtr?: { sessionId: string; transcriptPath: string; cwd: string };
  operationId?: string;
}

export class Client {
  /**
   * @param fallback if set, broker-unreachable sends/checks persist and read
   *   straight from the SQLite DB instead of throwing (degraded mode).
   */
  constructor(
    private socketPath: string,
    private fallback?: { dbPath: string },
    private tokensDir: string = config.tokensDir,
  ) {}

  // Results are intentionally loosely typed at this boundary; callers assert shape.
  // `actingAlias` names the identity this op acts as; its capability token (if we
  // hold one) is attached so the broker can authorize ownership-bearing ops.
  private async call(op: Op, args: Record<string, unknown>, actingAlias?: string): Promise<any> {
    let res: Response;
    const token = actingAlias ? readToken(this.tokensDir, actingAlias) : undefined;
    try {
      res = await request(this.socketPath, { v: PROTOCOL_VERSION, op, args, token });
    } catch (e) {
      if (this.fallback) return this.degraded(op, args, actingAlias);
      throw e;
    }
    if (!res.ok) throw new BrokerError(res.error.code, res.error.message, res.error.data);
    return res.result;
  }

  /**
   * Broker unreachable: keep working with reduced function. Sends persist (the
   * broker routes/reconciles them on return); checks read the durable log. Lost
   * while down: proactive push and timeout synthesis.
   *
   * In strict mode the fallback still refuses to act as an alias this client
   * holds no token for — so a forged `from` can't be persisted while the broker
   * is down. This is not a hard boundary (a process bypassing this client can
   * write the DB directly); the broker is the real authority when it's up.
   */
  private degraded(op: Op, args: Record<string, any>, actingAlias?: string): unknown {
    if (config.strict) {
      const identity = op === "send" ? args.from : actingAlias;
      if (identity && !readToken(this.tokensDir, identity)) {
        throw new Error(`unauthorized: no token for "${identity}" (broker down, strict mode)`);
      }
    }
    const db = new SqliteBackend(this.fallback!.dbPath);
    try {
      if (op === "send") {
        // same fail-loud contract as the broker's empty_send — degraded mode is
        // the one path that bypasses the router, and it must not re-open the
        // zero-byte hole for MCP callers while the broker is down
        if (!String(args.body ?? "").trim()) {
          throw new Error(`empty_send: a message needs a body — nothing was sent (broker down, degraded mode)`);
        }
        if (args.from === "ipc") {
          throw new Error(`bad_args: "ipc" is reserved — you can't send as the broker (broker down, degraded mode)`);
        }
        if (isProjectAddress(args.to)) args.to = projectAddress(projectPath(args.to));
        const registry = new Map(db.loadRegistry().map((entry) => [entry.alias, entry]));
        const existing = db.getByOperationId(String(args.operationId));
        if (existing) {
          const requestedReplyBy =
            existing.toAlias !== "*" && (existing.kind === "query" || existing.kind === "request")
              ? (args.replyByS === undefined ? (existing.replyByS ?? null) : args.replyByS)
              : null;
          const samePayload =
            existing.fromAlias === args.from &&
            existing.toAlias === args.to &&
            existing.kind === args.kind &&
            existing.body === (args.body ?? "") &&
            existing.ttlS === (args.ttlS ?? null) &&
            (existing.replyByS ?? null) === requestedReplyBy &&
            (args.conversationId === undefined || existing.conversationId === args.conversationId) &&
            JSON.stringify(existing.contextPtr) === JSON.stringify(args.contextPtr ?? null);
          if (!samePayload) throw new Error("operation_conflict: operationId was already used for a different send payload");
          const senderSid = registry.get(existing.fromAlias)?.sessionId;
          const routed = db.routeFor(existing.id);
          const targets = routed !== null
            ? routed
            : existing.toAlias === "*"
              ? [...registry.values()]
                .filter((entry) => entry.status !== "offline" && entry.alias !== existing.fromAlias && entry.sessionId !== senderSid)
                .map((entry) => entry.alias)
              : [existing.toAlias];
          for (const target of targets) db.enqueue(existing.id, target);
          if (isProjectAddress(existing.toAlias) && senderSid) {
            for (const entry of registry.values()) {
              if (entry.sessionId === senderSid) db.passProject(existing.id, entry.alias);
            }
          }
          if (!db.getAwaiting(existing.id) && existing.toAlias !== "*" && (existing.kind === "query" || existing.kind === "request")) {
            const ttl = existing.ttlS ?? config.defaultTtlS;
            const replyBy = args.replyByS === undefined ? config.reply.byS : args.replyByS;
            db.openAwaiting(existing.id, ttl === null ? null : existing.ts + ttl, replyBy, existing.ts);
          }
          return {
            msgId: existing.id,
            operationId: args.operationId,
            recipients: targets,
            queued: true,
            daemonDown: true,
            idempotentReplay: true,
          };
        }
        if (!args.kind || !["inform", "query", "request"].includes(args.kind)) {
          throw new Error(`bad_args: kind must be inform|query|request, got ${String(args.kind)} (broker down, degraded mode)`);
        }
        if (config.strict && !registry.has(args.from)) {
          throw new Error(`not_registered: ${args.from} must register before sending (broker down, degraded mode)`);
        }
        if (!isProjectAddress(args.to) && args.to !== "*" && !registry.has(args.to)) {
          throw new Error(`no_peer: no peer named "${args.to}" is registered — nothing was sent (broker down, degraded mode)`);
        }
        const senderSid = registry.get(args.from)?.sessionId;
        if (senderSid && args.to !== "*" && !isProjectAddress(args.to) && registry.get(args.to)?.sessionId === senderSid) {
          throw new Error(`self_send: "${args.to}" belongs to this session — nothing was sent (broker down, degraded mode)`);
        }
        const allowed = config.allowlist[args.to];
        if (args.to !== "*" && allowed && !allowed.includes(args.from)) {
          throw new Error(`not_allowed: ${args.from} may not target ${args.to} — nothing was sent (broker down, degraded mode)`);
        }
        const messageId =
          args.messageId ??
          `msg-${new Bun.CryptoHasher("sha256").update(String(args.operationId)).digest("hex").slice(0, 16)}`;
        const now = Math.floor(Date.now() / 1000);
        const opensThread = args.to !== "*" && (args.kind === "query" || args.kind === "request");
        const conversationId = args.conversationId ?? (opensThread ? `conv-${messageId}` : null);
        args.conversationId = conversationId;
        db.queueOutbound({
          operationId: args.operationId,
          fromAlias: args.from,
          args: { ...args, messageId },
          createdAt: now,
        });
        const targets = args.to === "*"
          ? [...registry.values()]
            .filter((entry) => entry.status !== "offline" && entry.sessionId !== senderSid)
            .map((entry) => entry.alias)
          : [args.to];
        const message = makeMessage({
              id: messageId,
              operationId: args.operationId,
              kind: args.kind,
              fromAlias: args.from,
              toAlias: args.to,
              body: args.body,
              conversationId,
              contextPtr: args.contextPtr ?? null,
              ttlS: args.ttlS ?? null,
              replyByS:
                opensThread ? (args.replyByS === undefined ? config.reply.byS : args.replyByS) : null,
              ts: now,
            });
        db.appendRouted(message, targets);
        for (const target of targets) db.enqueue(messageId, target);
        if (args.to !== "*") {
          if (isProjectAddress(args.to) && senderSid) {
            for (const entry of registry.values()) {
              if (entry.sessionId === senderSid) db.passProject(messageId, entry.alias);
            }
          }
          if (args.kind === "query" || args.kind === "request") {
            const ttl = args.ttlS ?? config.defaultTtlS;
            const replyBy = args.replyByS === undefined ? config.reply.byS : args.replyByS;
            db.openAwaiting(messageId, ttl === null ? null : now + ttl, replyBy, now);
          }
        }
        return {
          msgId: messageId,
          operationId: args.operationId,
          recipients: targets,
          queued: true,
          daemonDown: true,
        };
      }
      if (op === "check") {
        const address = args.alias;
        const consume = args.consume ?? false;
        if (args.project) {
          const project = isProjectAddress(args.project) ? projectPath(args.project) : normalizeProjectPath(args.project);
          if (consume) this.requireDegradedProjectMember(db, projectAddress(project), actingAlias);
          const messages = this.degradedProjectMessages(db, project, actingAlias, consume);
          if (consume) for (const message of messages) db.markConsumed(message.id, message.toAlias);
          return { messages, daemonDown: true };
        }
        return { messages: consume ? db.pending(address, { consume: true }) : db.recoverable(address), daemonDown: true };
      }
      if (op === "deliver") {
        const address = args.alias;
        if (args.project) {
          const project = isProjectAddress(args.project) ? projectPath(args.project) : normalizeProjectPath(args.project);
          this.requireDegradedProjectMember(db, projectAddress(project), actingAlias);
          const messages = this.degradedProjectMessages(db, project, actingAlias, true);
          for (const message of messages) db.markDelivered(message.id, message.toAlias, args.via ?? "hook");
          return { messages, daemonDown: true };
        }
        return { messages: db.claimForDelivery(address, args.via ?? "hook"), daemonDown: true };
      }
      throw new Error(`broker down; "${op}" is unavailable in degraded mode`);
    } finally {
      db.close();
    }
  }

  private requireDegradedProjectMember(db: SqliteBackend, address: string, actingAlias?: string): void {
    const member = actingAlias ? db.loadRegistry().find((entry) => entry.alias === actingAlias) : undefined;
    if (!member?.cwd || !withinProject(member.cwd, projectPath(address))) {
      throw new Error("unauthorized: project mailbox consumption requires a member session (broker down, degraded mode)");
    }
  }

  private degradedProjectMessages(db: SqliteBackend, project: string, actingAlias?: string, consuming = false): Message[] {
    const addresses = db.projectAddresses().filter((address) =>
      consuming ? withinProject(project, projectPath(address)) : sameLineage(projectPath(address), project),
    );
    const source = addresses.flatMap((address) => consuming ? db.pending(address) : db.recoverable(address));
    if (!actingAlias) return source;
    const registry = new Map(db.loadRegistry().map((entry) => [entry.alias, entry]));
    const selfSid = registry.get(actingAlias)?.sessionId;
    return source.filter((message) => {
      const causalSender =
        message.fromAlias === "ipc" && message.corrId ? db.originOf(message.corrId)?.fromAlias : message.fromAlias;
      if (selfSid && causalSender && registry.get(causalSender)?.sessionId === selfSid) return false;
      if (db.projectStanding(message.id, actingAlias) === "passed") return false;
      const owner = db.projectClaim(message.id);
      return owner === null || owner === actingAlias || registry.get(owner)?.status === "offline";
    });
  }

  async register(alias: string, info: RegisterInfo): Promise<any> {
    // Present any token we already hold (proves a reconnect) and persist the one
    // the broker returns, so later ops from this and sibling processes authorize.
    const res = await this.call("register", { alias, ...info }, alias);
    if (res && typeof res === "object" && typeof res.token === "string") writeToken(this.tokensDir, alias, res.token);
    try {
      const reconciled = await this.reconcile(alias);
      if (reconciled.remaining > 0) {
        console.error(`[claude-ipc] ${reconciled.remaining} offline send intent(s) still need attention`);
      }
    } catch {
      // Registration succeeded. A later authenticated operation retries the outbox.
    }
    return res;
  }
  heartbeat(alias: string): Promise<any> {
    return this.call("heartbeat", { alias }, alias);
  }
  leave(alias: string): Promise<any> {
    return this.call("leave", { alias }, alias);
  }
  send(args: SendArgs): Promise<any> {
    const operationId = args.operationId ?? crypto.randomUUID();
    const suppliedMessageId = (args as SendArgs & { messageId?: string }).messageId;
    const messageId = suppliedMessageId ?? (this.fallback
      ? `msg-${new Bun.CryptoHasher("sha256").update(operationId).digest("hex").slice(0, 16)}`
      : undefined);
    return this.call(
      "send",
      {
        ...args,
        operationId,
        messageId,
      },
      args.from,
    );
  }
  reconcile(alias: string): Promise<any> {
    return this.call("reconcile", { alias }, alias);
  }
  check(alias: string, consume = false): Promise<any> {
    return this.call("check", { alias, consume }, alias);
  }
  deliver(alias: string, via: "hook" | "resume" | "channel"): Promise<any> {
    return this.call("deliver", { alias, via }, alias);
  }
  lease(alias: string, leaseId: string, leaseS = 30): Promise<any> {
    return this.call("lease", { alias, leaseId, leaseS, via: "channel" }, alias);
  }
  ackDelivery(alias: string, leaseId: string, msgIds: string[]): Promise<any> {
    return this.call("ack_delivery", { alias, leaseId, msgIds }, alias);
  }
  leaseProject(dir: string, asAlias: string, leaseId: string, leaseS = 30): Promise<any> {
    return this.call("lease", { project: dir, leaseId, leaseS, via: "channel" }, asAlias);
  }
  ackProject(dir: string, asAlias: string, leaseId: string, msgIds: string[]): Promise<any> {
    return this.call("ack_delivery", { project: dir, leaseId, msgIds }, asAlias);
  }
  // Project-mailbox reads: `asAlias` is the caller's own session alias — its
  // token is what proves project membership for consuming/claiming.
  checkProject(dir: string, consume = false, asAlias?: string): Promise<any> {
    return this.call("check", { project: dir, consume }, asAlias);
  }
  deliverProject(dir: string, via: "hook" | "resume" | "channel", asAlias: string): Promise<any> {
    return this.call("deliver", { project: dir, via }, asAlias);
  }
  countProject(dir: string): Promise<any> {
    return this.call("count", { project: dir });
  }
  projects(): Promise<any> {
    return this.call("projects", {});
  }
  orphans(dir?: string, triage = false): Promise<any> {
    return this.call("orphans", { ...(dir ? { project: dir } : {}), ...(triage ? { triage: true } : {}) });
  }
  supersede(old: string, by: string, from: string): Promise<any> {
    return this.call("supersede", { old, by, from }, from);
  }
  list(): Promise<any> {
    return this.call("list", {});
  }
  // `asAlias` is who is asking. Without it you still see the flow — who talked to whom —
  // but never the bodies, and never another session's transcript pointer.
  // `operator` opts into the full-machine view (every body); default false, so a
  // caller sees bodies only for messages it's a party to (or a project peer of).
  history(q: { peer?: string; since?: number; conversationId?: string } = {}, asAlias?: string, operator = false): Promise<any> {
    return this.call("history", { ...q, operator }, asAlias);
  }
  status(msgId: string, asAlias?: string, operator = false): Promise<any> {
    return this.call("status", { msgId, operator }, asAlias);
  }
  count(alias: string): Promise<any> {
    return this.call("count", { alias }, alias);
  }
  // hub-digest contract verbs (docs/contracts/hub-digest.md) — pure peeks, ungated
  digest(dir: string): Promise<any> {
    return this.call("digest", { project: dir });
  }
  asksAll(): Promise<any> {
    return this.call("asks", {});
  }
  prune(offlineForS?: number): Promise<any> {
    return this.call("prune", { offlineForS });
  }
  reply(args: {
    from: string;
    corrId: string;
    body?: string;
    terminal?: boolean;
    status?: "ok" | "error";
    errorCode?: string;
  }): Promise<any> {
    return this.call("reply", { ...args }, args.from);
  }
  accept(alias: string, msgId: string): Promise<any> {
    return this.call("accept", { alias, msgId }, alias);
  }
  decline(from: string, msgId: string, reason?: string): Promise<any> {
    return this.call("decline", { from, msgId, reason }, from);
  }
  snooze(alias: string, msgId: string): Promise<any> {
    return this.call("snooze", { alias, msgId }, alias);
  }
  cancel(corrId: string, as?: string): Promise<any> {
    return this.call("cancel", { corrId }, as);
  }

  /**
   * Wait up to `timeoutMs` for a correlated reply, then resolve (null on timeout).
   * Polls the inbox; it is a bounded wait, not an open-ended block. By default
   * waits for the FINAL (terminal) reply — interim acks/updates still land in the
   * inbox but don't satisfy the wait. Pass untilTerminal=false to return as soon
   * as any correlated reply (incl. an ack) arrives. A reply that arrives after
   * the timeout is not lost — it surfaces in the inbox at the caller's next turn.
   */
  async awaitReply(alias: string, corrId: string, timeoutMs = 30_000, untilTerminal = true, pollMs = 50): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.call("await", { alias, corrId, untilTerminal }, alias);
      if (r.response) return r.response;
      if (Date.now() >= deadline) return null;
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
}

/**
 * The Viewer Contract, typed (extensibility E1). A viewer is a read-only window
 * onto the fabric — dashboards, exporters, digests, watchers. It can look at
 * everything a client can look at and can change NOTHING: no sends, no
 * consumes, no registration, no heartbeat. The type has no mutating members,
 * so a consumer written against Viewer cannot drift into acting by accident —
 * the dashboard's politeness, promoted from discipline to compile-time law.
 */
export interface Viewer {
  list(): Promise<any>;
  peek(alias: string): Promise<any>; // check, consume forced false
  peekProject(dir: string, asAlias?: string): Promise<any>;
  history(q?: { peer?: string; since?: number; conversationId?: string }, asAlias?: string, operator?: boolean): Promise<any>;
  status(msgId: string, asAlias?: string): Promise<any>;
  projects(): Promise<any>;
  orphans(dir?: string, triage?: boolean): Promise<any>;
  count(alias: string): Promise<any>;
  countProject(dir: string): Promise<any>;
  digest(dir: string): Promise<any>;
  asksAll(): Promise<any>;
}

/** Wrap an existing Client as a Viewer. The wrapper is the whole implementation. */
export function viewerOf(c: Client): Viewer {
  return {
    list: () => c.list(),
    peek: (alias) => c.check(alias, false),
    peekProject: (dir, asAlias) => c.checkProject(dir, false, asAlias),
    history: (q, asAlias, operator) => c.history(q ?? {}, asAlias, operator ?? false),
    status: (msgId, asAlias) => c.status(msgId, asAlias, false),
    projects: () => c.projects(),
    orphans: (dir, triage) => c.orphans(dir, triage ?? false),
    count: (alias) => c.count(alias),
    countProject: (dir) => c.countProject(dir),
    digest: (dir) => c.digest(dir),
    asksAll: () => c.asksAll(),
  };
}
