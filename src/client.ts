/**
 * The thin client every caller (MCP server, CLI, hooks) uses to reach the broker.
 *
 * It holds no state: each call opens a short-lived Unix-socket connection, writes
 * one request frame, reads one response frame, and closes. The broker is the
 * single source of truth.
 */

import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type Op, type Request, type Response } from "./protocol.ts";

/** Send one request and resolve with the broker's one response. */
export function request(socketPath: string, req: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const dec = new FrameDecoder();
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(encodeFrame(req));
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

export interface RegisterInfo {
  sessionId: string;
  cwd: string;
  caps?: string[];
  pid?: number;
}

export interface SendArgs {
  from: string;
  to: string;
  kind: "inform" | "query" | "request";
  body?: string;
  conversationId?: string;
  ttlS?: number;
}

export class Client {
  constructor(private socketPath: string) {}

  // Results are intentionally loosely typed at this boundary; callers assert shape.
  private async call(op: Op, args: Record<string, unknown>, sessionId?: string): Promise<any> {
    const res = await request(this.socketPath, { v: PROTOCOL_VERSION, op, args, sessionId });
    if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
    return res.result;
  }

  register(alias: string, info: RegisterInfo): Promise<any> {
    return this.call("register", { alias, ...info });
  }
  heartbeat(alias: string): Promise<any> {
    return this.call("heartbeat", { alias });
  }
  leave(alias: string): Promise<any> {
    return this.call("leave", { alias });
  }
  send(args: SendArgs): Promise<any> {
    return this.call("send", { ...args });
  }
  check(alias: string, consume = false): Promise<any> {
    return this.call("check", { alias, consume });
  }
  deliver(alias: string, via: "hook" | "resume" | "channel"): Promise<any> {
    return this.call("deliver", { alias, via });
  }
  list(): Promise<any> {
    return this.call("list", {});
  }
  history(q: { peer?: string; since?: number; conversationId?: string } = {}): Promise<any> {
    return this.call("history", { ...q });
  }
  reply(args: { from: string; corrId: string; body?: string; terminal?: boolean; status?: "ok" | "error" }): Promise<any> {
    return this.call("reply", { ...args });
  }
  accept(alias: string, msgId: string): Promise<any> {
    return this.call("accept", { alias, msgId });
  }
  decline(from: string, msgId: string, reason?: string): Promise<any> {
    return this.call("decline", { from, msgId, reason });
  }
  cancel(corrId: string): Promise<any> {
    return this.call("cancel", { corrId });
  }

  /** Block until a correlated response lands in `alias`'s inbox, or the timeout passes. */
  async awaitReply(alias: string, corrId: string, timeoutMs = 2000, pollMs = 15): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.call("await", { alias, corrId });
      if (r.response) return r.response;
      if (Date.now() >= deadline) return null;
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
}
