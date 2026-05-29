/**
 * The durability contract every storage substrate implements.
 *
 * Keeping this interface narrow and backend-agnostic is what lets the broker
 * swap SQLite for honker (or an in-memory fake in tests) without any change to
 * the tool, hook, or wire contracts. Messages are immutable; all mutable state
 * lives in the delivery and awaiting records.
 */

import type { Awaiting, Delivery, Message, RegistryEntry } from "../models.ts";

export interface StorageBackend {
  // messages — immutable facts
  append(m: Message): void; // idempotent on id
  get(id: string): Message | null;

  // per-recipient delivery + consent
  enqueue(msgId: string, alias: string): void;
  pending(alias: string, opts?: { consume?: boolean }): Message[];
  markDelivered(msgId: string, alias: string, via: Delivery["via"]): void;
  markConsumed(msgId: string, alias: string): void;
  setConsent(msgId: string, alias: string, accepted: boolean): void;
  deliveriesFor(msgId: string): Delivery[];

  // sender's outstanding query/request
  openAwaiting(originId: string, expiresAt: number): void;
  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void;
  isAwaitingOpen(originId: string): boolean;
  awaitingPastTtl(now: number): Awaiting[];
  originOf(corrId: string): Message | null;

  // registry warm-restart snapshot
  saveRegistry(entries: RegistryEntry[]): void;
  loadRegistry(): RegistryEntry[];

  // audit
  history(q: { peer?: string; since?: number; conversationId?: string }): Message[];

  // lifecycle — rebuild the broker's working set after a restart
  replayInflight(): { deliveries: Delivery[]; awaiting: Awaiting[] };

  close(): void;
}

/** Delivery states that still count as actionable in a recipient's inbox. */
export const PENDING_STATES = ["queued", "delivered", "surfaced"] as const;
