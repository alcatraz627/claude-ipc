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
import { makeMessage } from "./models.ts";
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type Op, type Request, type Response } from "./protocol.ts";
import { SqliteBackend } from "./storage/sqliteBackend.ts";

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
      if (this.fallback) return this.degraded(op, args);
      throw e;
    }
    if (!res.ok) throw new BrokerError(res.error.code, res.error.message, res.error.data);
    return res.result;
  }

  /**
   * Broker unreachable: keep working with reduced function. Sends persist (the
   * broker routes/reconciles them on return); checks read the durable log. Lost
   * while down: proactive push, no_peer classification, and timeout synthesis.
   *
   * In strict mode the fallback still refuses to act as an alias this client
   * holds no token for — so a forged `from` can't be persisted while the broker
   * is down. This is not a hard boundary (a process bypassing this client can
   * write the DB directly); the broker is the real authority when it's up.
   */
  private degraded(op: Op, args: Record<string, any>): unknown {
    if (config.strict) {
      const actingAlias = op === "send" ? args.from : args.alias;
      if (actingAlias && !readToken(this.tokensDir, actingAlias)) {
        throw new Error(`unauthorized: no token for "${actingAlias}" (broker down, strict mode)`);
      }
    }
    const db = new SqliteBackend(this.fallback!.dbPath);
    try {
      if (op === "send") {
        const id = `msg-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`; // 64 bits — see server.mkId
        db.append(
          makeMessage({
            id,
            kind: args.kind,
            fromAlias: args.from,
            toAlias: args.to,
            ts: Math.floor(Date.now() / 1000),
            body: args.body ?? "",
            conversationId: args.conversationId ?? null,
            ttlS: args.ttlS ?? null,
          }),
        );
        if (args.to !== "*") db.enqueue(id, args.to);
        return { msgId: id, recipients: args.to === "*" ? [] : [args.to], daemonDown: true };
      }
      if (op === "check") {
        return { messages: db.pending(args.alias, { consume: args.consume ?? false }), daemonDown: true };
      }
      if (op === "deliver") {
        return { messages: db.claimForDelivery(args.alias, args.via ?? "hook"), daemonDown: true };
      }
      throw new Error(`broker down; "${op}" is unavailable in degraded mode`);
    } finally {
      db.close();
    }
  }

  async register(alias: string, info: RegisterInfo): Promise<any> {
    // Present any token we already hold (proves a reconnect) and persist the one
    // the broker returns, so later ops from this and sibling processes authorize.
    const res = await this.call("register", { alias, ...info }, alias);
    if (res && typeof res === "object" && typeof res.token === "string") writeToken(this.tokensDir, alias, res.token);
    return res;
  }
  heartbeat(alias: string): Promise<any> {
    return this.call("heartbeat", { alias }, alias);
  }
  leave(alias: string): Promise<any> {
    return this.call("leave", { alias }, alias);
  }
  send(args: SendArgs): Promise<any> {
    return this.call("send", { ...args }, args.from);
  }
  check(alias: string, consume = false): Promise<any> {
    return this.call("check", { alias, consume }, alias);
  }
  deliver(alias: string, via: "hook" | "resume" | "channel"): Promise<any> {
    return this.call("deliver", { alias, via }, alias);
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
  orphans(dir?: string): Promise<any> {
    return this.call("orphans", dir ? { project: dir } : {});
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
