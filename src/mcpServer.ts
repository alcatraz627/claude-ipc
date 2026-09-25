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
import { config, ipcIdentityEnv } from "./config.ts";
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
      replyByS: z.number().nullable().optional(),
      operationId: z.string().optional(),
    },
    async (a) => asText(await tools.ipc_send(a)),
  );

  server.tool(
    "ipc_check",
    "Check this session's pending incoming messages. Managed Codex hosts peek by default; other hosts preserve the consuming default.",
    { consume: z.boolean().optional() },
    async (a) => asText(await tools.ipc_check(a)),
  );

  server.tool(
    "ipc_check_project",
    "Peek at pending messages for a project mailbox. Defaults to this session's cwd and never consumes unless explicitly requested.",
    { project: z.string().optional(), consume: z.boolean().optional() },
    async (a) => asText(await tools.ipc_check_project(a)),
  );

  server.tool(
    "ipc_reply",
    "Send the FINAL reply to a query/request by its corrId (terminal). For incremental work, ipc_ack on receipt and ipc_update as you go, then ipc_reply with the result.",
    {
      corrId: z.string(),
      body: z.string(),
      terminal: z.boolean().optional(),
      status: z.enum(["ok", "error"]).optional(),
      errorCode: z.string().optional(),
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
    "Abandon a query/request you sent (by corrId); the recipient is told, and a later reply to it is refused.",
    { corrId: z.string() },
    async (a) => asText(await tools.ipc_cancel(a)),
  );

  server.tool(
    "ipc_snooze",
    "Defer an incoming ask without losing it; it remains pending and its recipient nudge clock restarts.",
    { msgId: z.string() },
    async (a) => asText(await tools.ipc_snooze(a)),
  );

  server.tool(
    "ipc_await",
    "Wait up to timeoutMs (default 30s) for the FINAL reply to your query/request, then return (null on timeout). It's a bounded wait, not an open-ended block — a later reply still surfaces in your inbox at your next turn, so for long-running work don't block here. Interim acks/updates land in your inbox separately; untilTerminal=false returns on the first reply.",
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
    "ipc_supersede",
    "Mark an earlier message you sent as superseded by a later message you sent. Delivery remains auditable.",
    { old: z.string(), by: z.string() },
    async (a) => asText(await tools.ipc_supersede(a)),
  );

  server.tool(
    "ipc_orphans",
    "Inspect mail waiting for offline sessions in this project. triage=true folds settled or superseded entries.",
    { project: z.string().optional(), triage: z.boolean().optional() },
    async (a) => asText(await tools.ipc_orphans(a)),
  );

  server.tool("ipc_projects", "List project mailboxes that still contain pending mail.", {}, async () =>
    asText(await tools.ipc_projects()),
  );

  server.tool(
    "ipc_count",
    "Count pending mail for this session or for an explicit project mailbox.",
    { project: z.string().optional() },
    async (a) => asText(await tools.ipc_count(a)),
  );

  server.tool(
    "ipc_digest",
    "Read the non-consuming project coordination digest for this session's cwd or an explicit project.",
    { project: z.string().optional() },
    async (a) => asText(await tools.ipc_digest(a)),
  );

  server.tool("ipc_asks", "List every open ask across the fabric without consuming mail.", {}, async () =>
    asText(await tools.ipc_asks()),
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
  const sessionId = ipcIdentityEnv("CLAUDE_IPC_SESSION") ?? crypto.randomUUID();
  const alias = ipcIdentityEnv("CLAUDE_IPC_ALIAS") ?? sessionId; // addressable by id; friendly name optional
  // Transcript path: explicit env wins; else the value the SessionStart hook
  // captured for this alias (works when hook + MCP share an alias, i.e.
  // CLAUDE_IPC_ALIAS is set — see docs/06-security-and-ops.md).
  const transcriptPath = process.env.CLAUDE_IPC_TRANSCRIPT ?? readMeta(alias) ?? "";
  return { alias, sessionId, cwd, transcriptPath, managedHost: config.managedCodexHost };
}

export async function main(): Promise<void> {
  const me = resolveIdentity();
  // Fallback lets ipc_send/ipc_check/ipc_deliver keep working off the durable log
  // when the broker is down, instead of throwing at the agent.
  const tools = createTools(new Client(config.socketPath, { dbPath: config.dbPath }), me);
  // Best-effort: register makes this session addressable, but the broker may be
  // down. Don't let that abort startup — the degraded fallback still serves
  // ipc_send/check/deliver off the durable log, and a later op re-registers.
  if (!me.managedHost) {
    try {
      await tools.ipc_register({});
    } catch {
      // Start without the broker and register when it returns.
    }
  }
  await buildMcpServer(tools).connect(new StdioServerTransport());
}

if (import.meta.main) void main();
