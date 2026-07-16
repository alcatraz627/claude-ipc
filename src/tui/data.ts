/**
 * One polling pass over the broker: everything the dashboard shows, as a single
 * immutable snapshot the React tree renders from.
 *
 * All reads are non-consuming peeks — browsing must never eat a message out from
 * under the hooks' delivery. Peer inboxes are read with each peer's own token
 * (shared per-user tokens dir); a refusal nulls that one cell, never the snapshot.
 */

import type { Client } from "../client.ts";
import type { Message, RegistryEntry } from "../models.ts";

export interface PeerCounts {
  unread: number;
  owed: number;
}

export interface FabricSnapshot {
  at: number; // epoch seconds of this pass
  brokerUp: boolean;
  peers: RegistryEntry[];
  myInbox: Message[]; // peeked, not consumed
  peerInboxes: Map<string, Message[] | null>; // alias → peeked pending mail (null = unreadable)
  history: Message[]; // recent flow, party-scoped bodies
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
};

export async function fetchFabric(client: Client, selfAlias: string | undefined): Promise<FabricSnapshot> {
  const at = Math.floor(Date.now() / 1000);
  let peers: RegistryEntry[];
  try {
    peers = ((await client.list()) as { peers: RegistryEntry[] }).peers ?? [];
  } catch {
    return { ...EMPTY_SNAPSHOT, at };
  }

  // Count mailboxes only for sessions that can still act on them — peeking the
  // offline graveyard would be dozens of round trips for rows shown collapsed.
  const active = peers.filter((p) => p.status !== "offline").map((p) => p.alias);
  const [myInbox, history, peeked] = await Promise.all([
    selfAlias ? peek(client, selfAlias) : Promise.resolve<Message[] | null>([]),
    client
      .history({ since: at - HISTORY_WINDOW_S }, selfAlias, false)
      .then((r: { messages: Message[] }) => r.messages ?? [])
      .catch(() => [] as Message[]),
    Promise.all(active.map(async (alias) => [alias, await peek(client, alias)] as const)),
  ]);

  return { at, brokerUp: true, peers, myInbox: myInbox ?? [], peerInboxes: new Map(peeked), history };
}

/** Non-consuming inbox read; null when this alias's mailbox isn't ours to read. */
async function peek(client: Client, alias: string): Promise<Message[] | null> {
  try {
    return ((await client.check(alias, false)) as { messages: Message[] }).messages ?? [];
  } catch {
    return null;
  }
}
