/**
 * Shared plumbing for the Claude Code hooks that deliver IPC messages.
 *
 * The hooks are how a recipient becomes aware of messages without being told to
 * check: at a turn boundary (UserPromptSubmit) or on resume (SessionStart). This
 * module reads the host's hook JSON, resolves which alias this session is, claims
 * its freshly-queued messages, and renders them for context injection.
 */

import type { Client } from "../client.ts";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  source?: string;
}

export async function readHookInput(): Promise<HookInput> {
  try {
    const text = await Bun.stdin.text();
    return text ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * This session's alias. Defaults to the session's own id so every session is
 * addressable with zero config; CLAUDE_IPC_ALIAS sets a friendly name (e.g. a
 * human label like "backend", or a gcc session id like "mistakes-infra").
 */
export function aliasFor(input: HookInput): string {
  return process.env.CLAUDE_IPC_ALIAS ?? input.session_id ?? "session";
}

export function emitContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

interface InMsg {
  id: string;
  kind: string;
  fromAlias: string;
  corrId: string | null;
  status: string | null;
  errorCode: string | null;
  body: string;
}

/** Render incoming messages as a marked, action-framed context block. */
export function formatMessages(messages: InMsg[]): string {
  const lines = messages.map((m) => {
    const head = `⟨IPC · ${m.kind} from ${m.fromAlias} (${m.id})`;
    if (m.kind === "request") {
      return `${head}: ${m.body}\n   ACTION REQUEST — a proposal. Do NOT act unless you first ipc_accept("${m.id}").⟩`;
    }
    if (m.kind === "query") {
      return `${head}: ${m.body}\n   Reply with ipc_reply(corrId="${m.id}", body=…).⟩`;
    }
    if (m.kind === "response") {
      const err = m.status === "error" ? `[${m.errorCode}] ` : "";
      return `${head} re ${m.corrId}: ${err}${m.body}⟩`;
    }
    return `${head}: ${m.body}⟩`;
  });
  return ["You have new claude-ipc messages (you received these without asking):", ...lines].join("\n");
}

/** Claim this alias's freshly-queued messages and render them, or null if none. */
export async function deliverContext(
  client: Client,
  alias: string,
  via: "hook" | "resume",
): Promise<string | null> {
  const res = (await client.deliver(alias, via)) as { messages: InMsg[] };
  return res.messages.length ? formatMessages(res.messages) : null;
}
