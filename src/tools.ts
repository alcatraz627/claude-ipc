/**
 * The agent-facing ipc_* operations, decoupled from any MCP transport.
 *
 * Each returns a plain result the MCP layer serializes. `me` pins this session's
 * identity so the agent cannot spoof who it is: a send's author, a check's inbox,
 * and a reply's sender are all this session's alias. Targets are the opposite —
 * always explicit, never inferred: the agent must name `to`.
 */

import type { Client } from "./client.ts";

export interface SelfIdentity {
  alias: string;
  sessionId: string;
  cwd: string;
}

export function createTools(client: Client, me: SelfIdentity) {
  return {
    ipc_register: (a: { alias?: string; caps?: string[] } = {}): Promise<unknown> =>
      client.register(a.alias ?? me.alias, { sessionId: me.sessionId, cwd: me.cwd, caps: a.caps }),

    ipc_list: (): Promise<unknown> => client.list(),

    ipc_send: (a: {
      to: string;
      kind: "inform" | "query" | "request";
      body: string;
      conversationId?: string;
      ttlS?: number;
    }): Promise<unknown> => {
      if (!a.to) throw new Error("ipc_send requires an explicit `to` alias — targets are never inferred");
      return client.send({
        from: me.alias,
        to: a.to,
        kind: a.kind,
        body: a.body,
        conversationId: a.conversationId,
        ttlS: a.ttlS,
        // carry a pointer back to this session so the recipient can find context
        contextPtr: { sessionId: me.sessionId, transcriptPath: "", cwd: me.cwd },
      });
    },

    ipc_check: (a: { consume?: boolean } = {}): Promise<unknown> => client.check(me.alias, a.consume ?? true),

    ipc_reply: (a: { corrId: string; body: string; terminal?: boolean; status?: "ok" | "error" }): Promise<unknown> =>
      client.reply({ from: me.alias, corrId: a.corrId, body: a.body, terminal: a.terminal, status: a.status }),

    ipc_accept: (a: { msgId: string }): Promise<unknown> => client.accept(me.alias, a.msgId),

    ipc_decline: (a: { msgId: string; reason?: string }): Promise<unknown> =>
      client.decline(me.alias, a.msgId, a.reason),

    ipc_cancel: (a: { corrId: string }): Promise<unknown> => client.cancel(a.corrId, me.alias),

    ipc_await: (a: { corrId: string; timeoutMs?: number }): Promise<unknown> =>
      client.awaitReply(me.alias, a.corrId, a.timeoutMs),

    ipc_history: (a: { peer?: string; since?: number; conversationId?: string } = {}): Promise<unknown> =>
      client.history(a),

    ipc_status: (a: { msgId: string }): Promise<unknown> => client.status(a.msgId),

    // The compose flow: returns live peers for the HUMAN to pick from. The agent
    // must surface these in the host's input UI (pick_one + form) and let the user
    // choose the target + write notes — it must NOT choose the target itself.
    ipc_compose: async (): Promise<unknown> => {
      const { peers } = (await client.list()) as {
        peers: { alias: string; cwd: string; status: string }[];
      };
      return {
        peers: peers
          .filter((p) => p.status !== "offline" && p.alias !== me.alias)
          .map((p) => ({ alias: p.alias, cwd: p.cwd, status: p.status })),
        instructions:
          "Present these peers to the USER (e.g. pick_one) and let them choose a target + add notes (form). " +
          "Never pick the target yourself. Then call ipc_send(to=<their pick>, kind, body=<their notes>).",
      };
    },
  };
}

export type IpcTools = ReturnType<typeof createTools>;
