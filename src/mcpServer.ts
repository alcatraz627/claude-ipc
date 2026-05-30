/**
 * The per-session MCP server: exposes the ipc_* tools over stdio.
 *
 * Claude Code spawns one of these per session (a stdio MCP server is one process
 * per session), so it holds no state — every tool forwards to the shared broker
 * via the thin client. The server auto-registers this session's alias on start
 * so peers can address it immediately.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "./client.ts";
import { config } from "./config.ts";
import { createTools, type IpcTools, type SelfIdentity } from "./tools.ts";

function asText(result: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function buildMcpServer(tools: IpcTools): McpServer {
  const server = new McpServer({ name: "claude-ipc", version: "0.0.1" });

  server.tool(
    "ipc_register",
    "Register this session under an alias so other Claude sessions can address it. Defaults to this session's alias.",
    { alias: z.string().optional(), caps: z.array(z.string()).optional() },
    async (a) => asText(await tools.ipc_register(a)),
  );

  server.tool("ipc_list", "List live peer sessions (alias, cwd, last-seen, status).", {}, async () =>
    asText(await tools.ipc_list()),
  );

  server.tool(
    "ipc_send",
    "Send a message to ANOTHER session you name explicitly in `to` (never inferred). kind: inform (FYI, no reply), query (ask, expect a reply), request (ask them to DO something — a proposal they must explicitly accept before acting).",
    {
      to: z.string(),
      kind: z.enum(["inform", "query", "request"]),
      body: z.string(),
      conversationId: z.string().optional(),
      ttlS: z.number().optional(),
    },
    async (a) => asText(await tools.ipc_send(a)),
  );

  server.tool(
    "ipc_check",
    "Pull this session's pending incoming messages.",
    { consume: z.boolean().optional() },
    async (a) => asText(await tools.ipc_check(a)),
  );

  server.tool(
    "ipc_reply",
    "Reply to a query/request by its corrId. Set terminal=false for an interim ack/progress note before the final result.",
    {
      corrId: z.string(),
      body: z.string(),
      terminal: z.boolean().optional(),
      status: z.enum(["ok", "error"]).optional(),
    },
    async (a) => asText(await tools.ipc_reply(a)),
  );

  server.tool(
    "ipc_accept",
    "Consent to act on an incoming request (by msgId) BEFORE doing the work. An incoming request is a proposal — it never runs automatically; you must accept it first.",
    { msgId: z.string() },
    async (a) => asText(await tools.ipc_accept(a)),
  );

  server.tool(
    "ipc_decline",
    "Refuse an incoming request; the sender receives an error{declined}.",
    { msgId: z.string(), reason: z.string().optional() },
    async (a) => asText(await tools.ipc_decline(a)),
  );

  server.tool(
    "ipc_cancel",
    "Abandon a query/request you sent (by corrId); a later reply to it is dropped.",
    { corrId: z.string() },
    async (a) => asText(await tools.ipc_cancel(a)),
  );

  server.tool(
    "ipc_await",
    "Block until a correlated reply to your query/request arrives, or the timeout passes.",
    { corrId: z.string(), timeoutMs: z.number().optional() },
    async (a) => asText(await tools.ipc_await(a)),
  );

  server.tool(
    "ipc_history",
    "Audit log of messages (who/what/when), filterable by peer, since (epoch seconds), and conversation.",
    { peer: z.string().optional(), since: z.number().optional(), conversationId: z.string().optional() },
    async (a) => asText(await tools.ipc_history(a)),
  );

  return server;
}

export function resolveIdentity(): SelfIdentity {
  const cwd = process.cwd();
  const alias = process.env.CLAUDE_IPC_ALIAS ?? cwd.split("/").filter(Boolean).pop() ?? "session";
  const sessionId = process.env.CLAUDE_IPC_SESSION ?? crypto.randomUUID();
  return { alias, sessionId, cwd };
}

export async function main(): Promise<void> {
  const me = resolveIdentity();
  const tools = createTools(new Client(config.socketPath), me);
  await tools.ipc_register({}); // make this session addressable immediately
  await buildMcpServer(tools).connect(new StdioServerTransport());
}

if (import.meta.main) void main();
