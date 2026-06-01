/**
 * The per-session MCP server: exposes the ipc_* tools over stdio.
 *
 * Claude Code spawns one of these per session (a stdio MCP server is one process
 * per session), so it holds no state — every tool forwards to the shared broker
 * via the thin client. The server auto-registers this session's alias on start
 * so peers can address it immediately.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "./client.ts";
import { config } from "./config.ts";
import { createTools, type IpcTools, type SelfIdentity } from "./tools.ts";

/** The transcript path the SessionStart hook captured for this alias, if any. */
function readMeta(alias: string): string | undefined {
  try {
    return readFileSync(join(config.metaDir, encodeURIComponent(alias)), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

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
    "Send the FINAL reply to a query/request by its corrId (terminal). For incremental work, ipc_ack on receipt and ipc_update as you go, then ipc_reply with the result.",
    {
      corrId: z.string(),
      body: z.string(),
      terminal: z.boolean().optional(),
      status: z.enum(["ok", "error"]).optional(),
    },
    async (a) => asText(await tools.ipc_reply(a)),
  );

  server.tool(
    "ipc_ack",
    "Acknowledge a query/request immediately on receipt, before you start — tells the asker you got it and are working. Non-final; the exchange stays open for ipc_update / ipc_reply.",
    { corrId: z.string(), note: z.string().optional() },
    async (a) => asText(await tools.ipc_ack(a)),
  );

  server.tool(
    "ipc_update",
    "Send an interim update on a query/request you're working — a partial result, an idea, a status. Non-final; correlates to the same corrId. Send as many as useful, then ipc_reply with the final result.",
    { corrId: z.string(), body: z.string() },
    async (a) => asText(await tools.ipc_update(a)),
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
    "Block until the FINAL reply to your query/request arrives, or the timeout passes. Interim acks/updates land in your inbox separately. Pass untilTerminal=false to return on the first reply (incl. an ack).",
    { corrId: z.string(), timeoutMs: z.number().optional(), untilTerminal: z.boolean().optional() },
    async (a) => asText(await tools.ipc_await(a)),
  );

  server.tool(
    "ipc_history",
    "Audit log of messages (who/what/when), filterable by peer, since (epoch seconds), and conversation.",
    { peer: z.string().optional(), since: z.number().optional(), conversationId: z.string().optional() },
    async (a) => asText(await tools.ipc_history(a)),
  );

  server.tool(
    "ipc_status",
    "Inspect a message's lifecycle by id: the message, its per-recipient deliveries, and any responses.",
    { msgId: z.string() },
    async (a) => asText(await tools.ipc_status(a)),
  );

  server.tool(
    "ipc_compose",
    "Start a hand-off: returns the live peers so YOU can let the USER pick the target and add notes (present them with pick_one + form, never choose the target yourself), then call ipc_send.",
    {},
    async () => asText(await tools.ipc_compose()),
  );

  return server;
}

export function resolveIdentity(): SelfIdentity {
  const cwd = process.cwd();
  const sessionId = process.env.CLAUDE_IPC_SESSION ?? crypto.randomUUID();
  const alias = process.env.CLAUDE_IPC_ALIAS ?? sessionId; // addressable by id; friendly name optional
  // Transcript path: explicit env wins; else the value the SessionStart hook
  // captured for this alias (works when hook + MCP share an alias, i.e.
  // CLAUDE_IPC_ALIAS is set — see docs/06-security-and-ops.md).
  const transcriptPath = process.env.CLAUDE_IPC_TRANSCRIPT ?? readMeta(alias) ?? "";
  return { alias, sessionId, cwd, transcriptPath };
}

export async function main(): Promise<void> {
  const me = resolveIdentity();
  // Fallback lets ipc_send/ipc_check/ipc_deliver keep working off the durable log
  // when the broker is down, instead of throwing at the agent.
  const tools = createTools(new Client(config.socketPath, { dbPath: config.dbPath }), me);
  // Best-effort: register makes this session addressable, but the broker may be
  // down. Don't let that abort startup — the degraded fallback still serves
  // ipc_send/check/deliver off the durable log, and a later op re-registers.
  try {
    await tools.ipc_register({});
  } catch {
    // broker unreachable at startup — come up anyway, register when it returns
  }
  await buildMcpServer(tools).connect(new StdioServerTransport());
}

if (import.meta.main) void main();
