/**
 * Shared plumbing for the Claude Code hooks that deliver IPC messages.
 *
 * The hooks are how a recipient becomes aware of messages without being told to
 * check: at a turn boundary (UserPromptSubmit) or on resume (SessionStart). This
 * module reads the host's hook JSON, resolves which alias this session is, claims
 * its freshly-queued messages, and renders them for context injection.
 */

import { basename } from "node:path";
import { deriveAlias, readAliasForSession, sanitizeAlias } from "../aliasStore.ts";
import type { Client } from "../client.ts";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  source?: string;
  session_title?: string; // present on SessionStart only (set via --name / /rename)
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
 * This session's alias — the one identity all three hooks resolve to.
 *
 * Precedence: an explicit CLAUDE_IPC_ALIAS override wins; then the session title
 * (SessionStart only) so naming your session auto-registers it; then the alias
 * SessionStart recorded for this session id (how the per-turn hooks, which never
 * see the title, reach the same mailbox); then a readable name derived from the
 * cwd and session id, so an unnamed session is still addressable by something a
 * human would type instead of a raw UUID (zero config, deterministic per hook).
 */
export function aliasFor(input: HookInput): string {
  if (process.env.CLAUDE_IPC_ALIAS) return process.env.CLAUDE_IPC_ALIAS;
  const fromTitle = sanitizeAlias(input.session_title);
  if (fromTitle) return fromTitle;
  const stored = readAliasForSession(input.session_id);
  if (stored) return stored;
  return deriveAlias(input.cwd, input.session_id);
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

interface Peer {
  alias: string;
  cwd: string;
  status: string;
}

/**
 * A compact "who else is working" block for the SessionStart injection, or null
 * when this session is alone. Lets a session ambiently know which peers exist and
 * where, so it can decide on its own to message one before touching shared work.
 * Peers are ordered live → idle → offline and the list is capped so a long roster
 * (or a graveyard of not-yet-pruned peers) can't flood the injection.
 */
export function formatRoster(peers: Peer[], self: string): string | null {
  const others = peers.filter((p) => p.alias !== self);
  if (others.length === 0) return null;
  const rank: Record<string, number> = { live: 0, idle: 1, offline: 2 };
  others.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.alias.localeCompare(b.alias));
  const shown = others.slice(0, 12);
  const lines = shown.map((p) => `  • ${p.alias} · ${basename(p.cwd) || p.cwd || "?"} · ${p.status}`);
  if (others.length > shown.length) lines.push(`  … +${others.length - shown.length} more`);
  return ["claude-ipc peers (message one with claude-ipc send --to <alias>):", ...lines].join("\n");
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
