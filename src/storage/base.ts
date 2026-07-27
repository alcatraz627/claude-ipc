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
  /** Defer without losing: seen-and-deferred, still pending. No-op unless queued/delivered. */
  markSurfaced(msgId: string, alias: string): void;
  /** Atomically take this alias's freshly-queued messages, marking them delivered. */
  claimForDelivery(alias: string, via: Delivery["via"]): Message[];
  setConsent(msgId: string, alias: string, accepted: boolean): void;
  deliveriesFor(msgId: string): Delivery[];
  /** Every `proj:` address that still has pending mail — the live project-mailbox set. */
  projectAddresses(): string[];
  /** Every address (session or project) that still has pending mail. */
  pendingAddresses(): string[];

  /**
   * Newest inbox-event seq across these addresses; 0 = nothing ever happened.
   * Minted from one global counter on pending-set membership changes only, so a
   * net-zero window still moves the cursor; persisted + floored to the boot
   * clock so a restart can only jump it forward, never rewind a watcher.
   */
  lastEventSeq(addresses: string[]): number;

  // sender's outstanding query/request
  openAwaiting(originId: string, expiresAt: number | null, replyByS?: number | null, nudgeFrom?: number): void; // expiresAt null = no deadline
  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void;
  markNudged(originId: string, stage: 1 | 2): void;
  /** Push the recipient's nudge clock out (they snoozed, or acked with a partial). */
  deferNudge(originId: string, from: number): void;

  // Project mail is addressed to a directory, not a person, so consent cannot live on
  // the single delivery row the way it does for a direct message. These carry the
  // per-member state that row could never hold.

  /** Take exclusive ownership of a project ask. False when somebody already has it. */
  claimProject(msgId: string, alias: string): boolean;
  /** Drop a claim so the ask can be taken again — used when the claimer has gone. */
  releaseClaim(msgId: string): void;
  /** Who owns this project ask, if anyone. */
  projectClaim(msgId: string): string | null;
  /** "Not me" — this member steps back without settling the ask for anyone else. */
  passProject(msgId: string, alias: string): void;
  /** Has this member already claimed or passed on this ask? */
  projectStanding(msgId: string, alias: string): "claimed" | "passed" | null;
  /** Record that a later message supersedes an earlier one (D2 — mail order is not
   *  truth order). Advisory: it changes triage display, never delivery. */
  markSuperseded(supersededId: string, bySupersedingId: string): void;
  /** The message that superseded this one, or null. */
  supersededBy(msgId: string): string | null;
  isAwaitingOpen(originId: string): boolean;
  getAwaiting(originId: string): Awaiting | null;
  awaitingPastTtl(now: number): Awaiting[]; // only records with a deadline that has passed
  openAwaitings(): Awaiting[]; // every still-open ask, for the ghost sweep to inspect its recipient
  originOf(corrId: string): Message | null;

  // registry warm-restart snapshot
  saveRegistry(entries: RegistryEntry[]): void;
  loadRegistry(): RegistryEntry[];

  // audit
  history(q: { peer?: string; since?: number; conversationId?: string }): Message[];

  // lifecycle — rebuild the broker's working set after a restart
  replayInflight(): { deliveries: Delivery[]; awaiting: Awaiting[] };

  /**
   * Delete messages older than `olderThanTs` that are fully settled — no
   * actionable delivery left and no open awaiting on them — so the log doesn't
   * grow without bound. Returns how many were removed. A still-pending or
   * still-awaited message is kept regardless of age.
   */
  purge(olderThanTs: number): number;

  close(): void;
}

/** Delivery states that still count as actionable in a recipient's inbox. */
export const PENDING_STATES = ["queued", "delivered", "surfaced"] as const;
