/**
 * In-memory storage backend.
 *
 * Used by tests for speed, and — equally important — as the SECOND implementation
 * that exercises the StorageBackend contract from day one, so the abstraction is
 * proven by two backends long before the honker variant exists.
 */

import type { Awaiting, Delivery, Message, OutboundIntent, RegistryEntry } from "../models.ts";
import { PENDING_STATES, type StorageBackend } from "./base.ts";

const delKey = (msgId: string, alias: string): string => `${msgId}\0${alias}`;
const isPending = (s: Delivery["state"]): boolean =>
  (PENDING_STATES as readonly string[]).includes(s);

export class MemoryBackend implements StorageBackend {
  private messages = new Map<string, Message>();
  private deliveries = new Map<string, Delivery>();
  private awaiting = new Map<string, Awaiting>();
  private registry: RegistryEntry[] = [];
  // P3b cursor state. The floor makes a restarted (= rebuilt) backend mint seqs
  // above anything the old life handed out, so a watcher's cursor never rewinds.
  private seqCounter: number;
  private addrSeq = new Map<string, number>();
  private leases = new Map<string, { id: string; until: number }>();
  private outbound = new Map<string, OutboundIntent>();
  private projectSurfaces = new Set<string>();
  private routes = new Map<string, string[]>();

  constructor(seqFloor = Math.floor(Date.now() / 1000)) {
    this.seqCounter = seqFloor;
  }

  private bumpSeq(addr: string): void {
    this.addrSeq.set(addr, ++this.seqCounter);
  }

  lastEventSeq(addresses: string[]): number {
    return addresses.reduce((max, a) => Math.max(max, this.addrSeq.get(a) ?? 0), 0);
  }

  append(m: Message): void {
    if (!this.messages.has(m.id)) this.messages.set(m.id, { ...m });
  }

  appendRouted(m: Message, targets: string[]): void {
    if (this.messages.has(m.id)) return;
    this.messages.set(m.id, { ...m });
    this.routes.set(m.id, [...targets]);
  }

  get(id: string): Message | null {
    const m = this.messages.get(id);
    return m ? { ...m } : null;
  }

  getByOperationId(operationId: string): Message | null {
    const m = [...this.messages.values()].find((candidate) => candidate.operationId === operationId);
    return m ? { ...m } : null;
  }

  queueOutbound(intent: OutboundIntent): void {
    if (!this.outbound.has(intent.operationId)) this.outbound.set(intent.operationId, structuredClone(intent));
  }

  pendingOutbound(fromAlias: string): OutboundIntent[] {
    return [...this.outbound.values()]
      .filter((intent) => intent.fromAlias === fromAlias)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((intent) => structuredClone(intent));
  }

  pendingOutboundAll(): OutboundIntent[] {
    return [...this.outbound.values()].sort((a, b) => a.createdAt - b.createdAt).map((intent) => structuredClone(intent));
  }

  deleteOutbound(operationId: string): void {
    this.outbound.delete(operationId);
  }

  enqueue(msgId: string, alias: string): void {
    const k = delKey(msgId, alias);
    if (this.deliveries.has(k)) return;
    const ts = this.messages.get(msgId)?.ts ?? 0;
    this.deliveries.set(k, { msgId, toAlias: alias, via: null, state: "queued", ts });
    this.bumpSeq(alias);
  }

  saveRoute(msgId: string, targets: string[]): void {
    if (!this.routes.has(msgId)) this.routes.set(msgId, [...targets]);
  }

  routeFor(msgId: string): string[] | null {
    const targets = this.routes.get(msgId);
    return targets ? [...targets] : null;
  }

  pending(alias: string, opts?: { consume?: boolean }): Message[] {
    const out: Message[] = [];
    let consumed = false;
    for (const d of this.deliveries.values()) {
      if (d.toAlias !== alias || !isPending(d.state)) continue;
      const m = this.messages.get(d.msgId);
      if (m) out.push({ ...m });
      if (opts?.consume) {
        d.state = "consumed";
        consumed = true;
      }
    }
    if (consumed) this.bumpSeq(alias);
    return out.sort((a, b) => a.ts - b.ts);
  }

  recoverable(alias: string): Message[] {
    const out = new Map(this.pending(alias).map((message) => [message.id, message]));
    for (const d of this.deliveries.values()) {
      if (d.toAlias !== alias || d.state !== "persisted") continue;
      const message = this.messages.get(d.msgId);
      if (message && (message.kind === "query" || message.kind === "request") && this.isAwaitingOpen(message.id)) {
        out.set(message.id, { ...message });
      }
    }
    return [...out.values()].sort((a, b) => a.ts - b.ts);
  }

  markDelivered(msgId: string, alias: string, via: Delivery["via"]): void {
    const d = this.deliveries.get(delKey(msgId, alias));
    if (d && d.state === "queued") {
      d.state = "delivered";
      d.via = via;
    }
  }

  markConsumed(msgId: string, alias: string): void {
    const d = this.deliveries.get(delKey(msgId, alias));
    if (!d) return;
    if (isPending(d.state)) this.bumpSeq(alias); // only leaving the pending set is an event
    d.state = "consumed";
  }

  markSurfaced(msgId: string, alias: string): boolean {
    const d = this.deliveries.get(delKey(msgId, alias));
    if (!d || !["queued", "delivered", "persisted"].includes(d.state)) return false;
    const enteredPending = d.state === "persisted";
    d.state = "surfaced";
    this.leases.delete(delKey(msgId, alias));
    if (enteredPending) this.bumpSeq(alias);
    return true;
  }

  claimForDelivery(alias: string, via: Delivery["via"]): Message[] {
    const out: Message[] = [];
    for (const d of this.deliveries.values()) {
      if (d.toAlias !== alias || d.state !== "queued") continue;
      d.state = "delivered";
      d.via = via;
      const m = this.messages.get(d.msgId);
      if (m) out.push({ ...m });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  leaseForDelivery(alias: string, via: Delivery["via"], leaseId: string, now: number, leaseUntil: number): Message[] {
    const out: Message[] = [];
    for (const d of this.deliveries.values()) {
      if (d.toAlias !== alias || (d.state !== "queued" && d.state !== "delivered")) continue;
      const key = delKey(d.msgId, alias);
      const lease = this.leases.get(key);
      if (lease && lease.until > now) continue;
      this.leases.set(key, { id: leaseId, until: leaseUntil });
      d.via = via;
      d.state = "delivered";
      const m = this.messages.get(d.msgId);
      if (m) out.push({ ...m });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  ackDelivery(alias: string, leaseId: string, msgIds: string[]): number {
    let acknowledged = 0;
    for (const msgId of msgIds) {
      const key = delKey(msgId, alias);
      if (this.leases.get(key)?.id !== leaseId) continue;
      this.leases.delete(key);
      const delivery = this.deliveries.get(key);
      if (!delivery || !["queued", "delivered"].includes(delivery.state)) continue;
      delivery.state = "persisted";
      acknowledged++;
    }
    return acknowledged;
  }

  setConsent(msgId: string, alias: string, accepted: boolean): void {
    const d = this.deliveries.get(delKey(msgId, alias));
    if (!d) return;
    if (isPending(d.state)) this.bumpSeq(alias);
    d.state = accepted ? "accepted" : "declined";
  }

  deliveriesFor(msgId: string): Delivery[] {
    return [...this.deliveries.values()].filter((d) => d.msgId === msgId).map((d) => ({ ...d }));
  }

  projectAddresses(): string[] {
    const out = new Set<string>();
    for (const d of this.deliveries.values()) {
      if (d.toAlias.startsWith("proj:") && isPending(d.state)) out.add(d.toAlias);
    }
    return [...out];
  }

  pendingAddresses(): string[] {
    const out = new Set<string>();
    for (const d of this.deliveries.values()) if (isPending(d.state)) out.add(d.toAlias);
    return [...out];
  }

  recoverableAddresses(): string[] {
    const out = new Set(this.pendingAddresses());
    for (const d of this.deliveries.values()) {
      const message = this.messages.get(d.msgId);
      if (d.state === "persisted" && message && (message.kind === "query" || message.kind === "request") && this.isAwaitingOpen(message.id)) {
        out.add(d.toAlias);
      }
    }
    return [...out];
  }

  openAwaiting(originId: string, expiresAt: number | null, replyByS: number | null = null, nudgeFrom = 0): void {
    this.awaiting.set(originId, {
      originId,
      expiresAt,
      closed: false,
      closedReason: null,
      replyByS,
      nudgedStage: 0,
      nudgeFrom,
    });
  }

  markNudged(originId: string, stage: 1 | 2): void {
    const a = this.awaiting.get(originId);
    if (a && a.nudgedStage < stage) a.nudgedStage = stage; // only ever forward
  }

  deferNudge(originId: string, from: number): void {
    const a = this.awaiting.get(originId);
    if (a) {
      a.nudgeFrom = from;
      a.nudgedStage = 0;
    }
  }

  private claims = new Map<string, string>();
  private passes = new Set<string>();
  private supersededByMap = new Map<string, string>();

  markSuperseded(supersededId: string, bySupersedingId: string): void {
    this.supersededByMap.set(supersededId, bySupersedingId);
  }

  supersededBy(msgId: string): string | null {
    return this.supersededByMap.get(msgId) ?? null;
  }

  claimProject(msgId: string, alias: string): boolean {
    if (this.claims.has(msgId)) return false; // somebody already has it
    this.claims.set(msgId, alias);
    return true;
  }

  releaseClaim(msgId: string): void {
    this.claims.delete(msgId);
  }

  projectClaim(msgId: string): string | null {
    return this.claims.get(msgId) ?? null;
  }

  passProject(msgId: string, alias: string): void {
    this.passes.add(`${msgId}\0${alias}`);
  }

  projectStanding(msgId: string, alias: string): "claimed" | "passed" | null {
    if (this.claims.get(msgId) === alias) return "claimed";
    return this.passes.has(`${msgId}\0${alias}`) ? "passed" : null;
  }

  markProjectSurfaced(msgId: string, alias: string): void {
    this.projectSurfaces.add(delKey(msgId, alias));
  }

  projectSurfaced(msgId: string, alias: string): boolean {
    return this.projectSurfaces.has(delKey(msgId, alias));
  }

  getAwaiting(originId: string): Awaiting | null {
    const a = this.awaiting.get(originId);
    return a ? { ...a } : null;
  }

  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void {
    const a = this.awaiting.get(originId);
    if (a && !a.closed) {
      a.closed = true;
      a.closedReason = reason;
    }
  }

  isAwaitingOpen(originId: string): boolean {
    const a = this.awaiting.get(originId);
    return a ? !a.closed : false;
  }

  awaitingPastTtl(now: number): Awaiting[] {
    return [...this.awaiting.values()]
      .filter((a) => !a.closed && a.expiresAt !== null && a.expiresAt <= now)
      .map((a) => ({ ...a }));
  }

  openAwaitings(): Awaiting[] {
    return [...this.awaiting.values()].filter((a) => !a.closed).map((a) => ({ ...a }));
  }

  originOf(corrId: string): Message | null {
    const m = this.get(corrId);
    // Only a query/request opens a correlation — you can't reply-correlate to a
    // response or an inform.
    return m && (m.kind === "query" || m.kind === "request") ? m : null;
  }

  saveRegistry(entries: RegistryEntry[]): void {
    this.registry = entries.map((e) => ({ ...e, caps: [...e.caps] }));
  }

  loadRegistry(): RegistryEntry[] {
    return this.registry.map((e) => ({ ...e, caps: [...e.caps] }));
  }

  history(q: { peer?: string; since?: number; conversationId?: string }): Message[] {
    let ms = [...this.messages.values()];
    if (q.peer !== undefined) ms = ms.filter((m) => m.fromAlias === q.peer || m.toAlias === q.peer);
    if (q.since !== undefined) ms = ms.filter((m) => m.ts >= (q.since as number));
    if (q.conversationId !== undefined) ms = ms.filter((m) => m.conversationId === q.conversationId);
    return ms.sort((a, b) => a.ts - b.ts).map((m) => ({ ...m }));
  }

  replayInflight(): { deliveries: Delivery[]; awaiting: Awaiting[] } {
    return {
      deliveries: [...this.deliveries.values()].filter((d) => isPending(d.state)).map((d) => ({ ...d })),
      awaiting: [...this.awaiting.values()].filter((a) => !a.closed).map((a) => ({ ...a })),
    };
  }

  purge(olderThanTs: number): number {
    const purgeable: string[] = [];
    for (const m of this.messages.values()) {
      if (m.ts >= olderThanTs) continue;
      const stillPending = [...this.deliveries.values()].some((d) => d.msgId === m.id && isPending(d.state));
      if (stillPending) continue;
      const aw = this.awaiting.get(m.id);
      if (aw && !aw.closed) continue;
      purgeable.push(m.id);
    }
    for (const id of purgeable) {
      this.messages.delete(id);
      this.awaiting.delete(id);
      this.routes.delete(id);
      for (const [k, d] of this.deliveries) if (d.msgId === id) this.deliveries.delete(k);
    }
    return purgeable.length;
  }

  tombstoneStale(olderThanTs: number): number {
    // Message-age only; says nothing about the recipient. Retire a message still
    // pending past the window so it leaves the inbox and the next purge deletes it.
    let n = 0;
    const bumped = new Set<string>();
    for (const d of this.deliveries.values()) {
      if (isPending(d.state) && d.ts < olderThanTs) {
        d.state = "consumed";
        bumped.add(d.toAlias);
        n++;
      }
    }
    for (const a of bumped) this.bumpSeq(a);
    return n;
  }

  close(): void {
    // nothing to release
  }
}
