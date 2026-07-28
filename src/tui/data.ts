/**
 * One polling pass over the broker: everything the dashboard shows, as a single
 * immutable snapshot the React tree renders from.
 *
 * All reads are non-consuming peeks — browsing must never eat a message out from
 * under the hooks' delivery. Peer inboxes are read with each peer's own token
 * (shared per-user tokens dir); a refusal nulls that one cell, never the snapshot.
 */

import { viewerOf, type Client, type Viewer } from "../client.ts";
import type { Message, RegistryEntry } from "../models.ts";

export interface PeerCounts {
  unread: number;
  owed: number;
}

export interface ProjectBox {
  address: string;
  path: string;
  pending: number;
}

export interface OrphanBox {
  alias: string;
  cwd: string | null;
  lastSeen: number | null;
  pending: number;
  oldestTs: number | null;
  // triage split (D2): open = still-live word, folded = superseded by the sender's own
  // later message. Advisory display only — folded mail stays in the box, still peekable.
  open?: number;
  folded?: number;
}

export interface FabricSnapshot {
  at: number; // epoch seconds of this pass
  brokerUp: boolean;
  peers: RegistryEntry[];
  myInbox: Message[]; // peeked, not consumed
  peerInboxes: Map<string, Message[] | null>; // alias → peeked pending mail (null = unreadable)
  history: Message[]; // recent flow; bodies party-scoped unless operator was asked for
  projects: ProjectBox[];
  orphans: OrphanBox[];
  // Reads that FAILED this pass: their arrays are empty for iteration, but a
  // view must render labeled-unknown, never "all caught up" over a refusal.
  unreadable: { myInbox: boolean; history: boolean; projects: boolean; orphans: boolean };
}

/** How far back the flow view reaches. History is uncapped broker-side; always bound it. */
export const HISTORY_WINDOW_S = 24 * 3600;

export const EMPTY_SNAPSHOT: FabricSnapshot = {
  at: 0,
  brokerUp: false,
  peers: [],
  myInbox: [],
  peerInboxes: new Map(),
  history: [],
  projects: [],
  orphans: [],
  unreadable: { myInbox: true, history: true, projects: true, orphans: true },
};

export async function fetchFabric(client: Client, selfAlias: string | undefined, operator = false): Promise<FabricSnapshot> {
  // Every read in this pass goes through the Viewer — the type has no consume,
  // no send, no register, so the polling loop CANNOT mutate the fabric.
  const v = viewerOf(client);
  const at = Math.floor(Date.now() / 1000);
  let peers: RegistryEntry[];
  try {
    peers = ((await v.list()) as { peers: RegistryEntry[] }).peers ?? [];
  } catch {
    return { ...EMPTY_SNAPSHOT, at };
  }

  // Count mailboxes only for sessions that can still act on them — peeking the
  // offline graveyard would be dozens of round trips for rows shown collapsed.
  const active = peers.filter((p) => p.status !== "offline").map((p) => p.alias);
  // A failed read flags itself — an empty array alone would render as a clean
  // fabric over a refusal (review #4).
  const unreadable = { myInbox: false, history: false, projects: false, orphans: false };
  const [myInbox, history, peeked, projects, orphans] = await Promise.all([
    selfAlias ? peek(v, selfAlias) : Promise.resolve<Message[] | null>([]),
    v
      .history({ since: at - HISTORY_WINDOW_S }, selfAlias, operator)
      .then((r: { messages: Message[] }) => r.messages ?? [])
      .catch(() => {
        unreadable.history = true;
        return [] as Message[];
      }),
    Promise.all(active.map(async (alias) => [alias, await peek(v, alias)] as const)),
    v
      .projects()
      .then((r: { projects: ProjectBox[] }) => r.projects ?? [])
      .catch(() => {
        unreadable.projects = true;
        return [] as ProjectBox[];
      }),
    v
      .orphans(undefined, true) // triage=true → each box carries its open/folded split
      .then((r: { orphans: OrphanBox[] }) => r.orphans ?? [])
      .catch(() => {
        unreadable.orphans = true;
        return [] as OrphanBox[];
      }),
  ]);
  if (selfAlias && myInbox === null) unreadable.myInbox = true; // peek's null = "not ours to read"

  return {
    at,
    brokerUp: true,
    peers,
    myInbox: myInbox ?? [],
    peerInboxes: new Map(peeked),
    history,
    projects,
    orphans,
    unreadable,
  };
}

/** Non-consuming inbox read; null when this alias's mailbox isn't ours to read. */
async function peek(v: Viewer, alias: string): Promise<Message[] | null> {
  try {
    return ((await v.peek(alias)) as { messages: Message[] }).messages ?? [];
  } catch {
    return null;
  }
}
