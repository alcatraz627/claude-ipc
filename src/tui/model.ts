/**
 * Pure view-model functions for the dashboard: broker JSON in, display rows out.
 *
 * Nothing here touches the terminal, React, or the Client — every function is a
 * pure transform, which is what makes the dashboard's logic testable without a
 * tty (the rendered components stay thin). Peer bodies and aliases are untrusted
 * text: everything that ends up on screen passes through `sanitizeInline`.
 */

import type { Message, RegistryEntry } from "../models.ts";
import { humanAge } from "../models.ts";

/**
 * Neutralize a peer-controlled string for one-line terminal display.
 *
 * A message body can carry ANSI escapes (would restyle or forge parts of the
 * frame), control bytes (would break the renderer), or newlines (would forge
 * extra rows). Escapes and control bytes are dropped, newlines become a visible
 * ␤ so multi-line content is evident without being enacted.
 */
export function sanitizeInline(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC (title/hyperlink) sequences
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]?/g, "") // CSI sequences
    .replace(/\x1b./g, "") // bare ESC + one (charset shifts etc.)
    .replace(/\r?\n/g, "␤")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x1f\x7f]/g, "");
}

/** Truncate for a fixed-width cell, ellipsized, after sanitizing. */
export function inlineHead(s: string, max: number): string {
  const clean = sanitizeInline(s);
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** One roster row = one session, however many aliases it holds. */
export interface RosterRow {
  key: string; // stable session key (sorted aliases joined)
  alias: string; // head alias — the name to address / display
  also: string[]; // sibling aliases of the same session
  sessionId: string;
  cwd: string;
  status: "live" | "idle" | "offline";
  lastSeen: number;
  you: boolean; // this row is the session driving the dashboard
}

const STATUS_RANK: Record<string, number> = { live: 0, idle: 1, offline: 2 };

/**
 * Collapse the alias-keyed registry into one row per session, you first.
 *
 * Same grouping as `formatRoster` (hooks/shared.ts): a session's several aliases
 * are one actor, shown as "head (also: …)" — listed separately, agents probed a
 * teammate's second name as a stranger. Unlike the hook's roster this KEEPS your
 * own row (marked "you"): copying your own sid/alias is a use of this screen.
 */
export function groupRoster(peers: RegistryEntry[], selfAlias?: string): RosterRow[] {
  const groups = new Map<string, RegistryEntry[]>();
  for (const p of peers) {
    const key = (p.sessionAliases && p.sessionAliases.length ? p.sessionAliases : [p.alias]).join(" ");
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const rows = [...groups.values()].map((group) => {
    group.sort(
      (a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) || a.alias.localeCompare(b.alias),
    );
    const head = group[0]!;
    const aliases = group.map((g) => g.alias);
    return {
      key: [...aliases].sort().join(" "),
      alias: sanitizeInline(head.alias),
      also: group.slice(1).map((g) => sanitizeInline(g.alias)),
      sessionId: head.sessionId,
      cwd: head.cwd,
      status: head.status,
      lastSeen: Math.max(...group.map((g) => g.lastSeen)),
      you: selfAlias !== undefined && aliases.includes(selfAlias),
    };
  });
  rows.sort(
    (a, b) =>
      Number(b.you) - Number(a.you) ||
      (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
      b.lastSeen - a.lastSeen ||
      a.alias.localeCompare(b.alias),
  );
  return rows;
}

/** Case-insensitive substring match over alias, sibling aliases, and cwd. */
export function filterRoster(rows: RosterRow[], query: string): RosterRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.alias.toLowerCase().includes(q) ||
      r.also.some((a) => a.toLowerCase().includes(q)) ||
      r.cwd.toLowerCase().includes(q),
  );
}

/** Unread = everything still pending; owed = the subset that expects an answer. */
export function pendingStats(messages: Message[]): { unread: number; owed: number } {
  return {
    unread: messages.length,
    owed: messages.filter((m) => m.kind === "query" || m.kind === "request").length,
  };
}

/** The most recent message that touches any of a session's aliases, if any. */
export function lastMessageFor(history: Message[], aliases: string[]): Message | undefined {
  const names = new Set(aliases);
  let latest: Message | undefined;
  for (const m of history) {
    if (!names.has(m.fromAlias) && !names.has(m.toAlias)) continue;
    if (!latest || m.ts > latest.ts) latest = m;
  }
  return latest;
}

/** The newest still-unanswered ask FROM one of `aliases` TO `self` — what `r`/reply targets. */
export function lastOpenAskFrom(myInbox: Message[], aliases: string[]): Message | undefined {
  const names = new Set(aliases);
  let latest: Message | undefined;
  for (const m of myInbox) {
    if (m.kind !== "query" && m.kind !== "request") continue;
    if (!names.has(m.fromAlias)) continue;
    if (!latest || m.ts > latest.ts) latest = m;
  }
  return latest;
}

export interface CopyField {
  label: string;
  value: string;
}

/**
 * The copy-menu contents for a roster selection: every identifier someone keeps
 * needing, plus a ready-to-paste command. When the peer has an open ask to you
 * the command answers it; otherwise it's a send addressed to them.
 */
export function copyFieldsForPeer(
  row: RosterRow,
  selfAlias: string | undefined,
  lastMsg: Message | undefined,
  openAsk: Message | undefined,
): CopyField[] {
  const from = selfAlias ?? "<you>";
  const fields: CopyField[] = [
    { label: "alias", value: row.alias },
    { label: "session-id", value: row.sessionId },
    { label: "cwd", value: row.cwd },
  ];
  if (lastMsg) {
    fields.push({ label: "last-msg-id", value: lastMsg.id }, { label: "last-msg-body", value: lastMsg.body });
  }
  fields.push(
    openAsk
      ? { label: "reply command", value: `claude-ipc reply ${openAsk.id} --from ${from} "<answer>"` }
      : { label: "send command", value: `claude-ipc send --to ${row.alias} --from ${from} "<message>"` },
  );
  return fields;
}

/** "45s" / "12m" / "3h" ago-label for a roster row, from epoch seconds. */
export function ageLabel(ts: number, nowS: number): string {
  return humanAge(ts, nowS);
}

/** Preview-pane lines for a roster selection. Pure data; the component styles them. */
export interface PreviewData {
  title: string;
  rows: { label: string; value: string; accent?: boolean }[];
}

export function peerPreview(
  row: RosterRow,
  nowS: number,
  counts: { unread: number; owed: number } | null | undefined,
  lastMsg: Message | undefined,
): PreviewData {
  const rows: PreviewData["rows"] = [
    { label: "alias", value: row.alias + (row.you ? "  (you)" : "") },
    ...(row.also.length ? [{ label: "also", value: row.also.join(", ") }] : []),
    { label: "session", value: row.sessionId },
    { label: "cwd", value: row.cwd || "?" },
    { label: "status", value: `${row.status} · seen ${ageLabel(row.lastSeen, nowS)} ago` },
    {
      label: "inbox",
      // counts are read with the peer's own token from the shared per-user tokens
      // dir; a miss (token pruned, broker refused) renders "?" — never a crash.
      value: counts ? `${counts.unread} unread · ${counts.owed} owed` : "?",
      accent: Boolean(counts && counts.owed > 0),
    },
  ];
  if (lastMsg) {
    rows.push({
      label: "last msg",
      value: `${lastMsg.kind} ${lastMsg.fromAlias}→${lastMsg.toAlias} · ${ageLabel(lastMsg.ts, nowS)} ago`,
    });
    rows.push({ label: "", value: inlineHead(lastMsg.body, 200) });
  }
  return { title: row.alias, rows };
}
