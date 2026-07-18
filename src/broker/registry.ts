/**
 * The live roster of registered peers.
 *
 * Tracks who is reachable under which alias, ages them from live → idle →
 * offline by how recently they were heard from, and snapshots to durable storage
 * on every change so a known alias survives a broker restart (the offline queue
 * still routes to it). Aliases are the addressing unit; a queue is alias-keyed,
 * so re-binding an alias to a new session does not strand its pending messages.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { RegistryEntry } from "../models.ts";
import type { StorageBackend } from "../storage/base.ts";

export interface Liveness {
  idleS: number;
  offlineS: number;
}

export class Registry {
  private entries = new Map<string, RegistryEntry>();

  constructor(
    private backend: StorageBackend,
    private now: () => number,
    private liveness: Liveness,
  ) {
    // Warm-start from the snapshot and let each peer's status fall out of when we
    // last heard from it. Booting everyone as "offline" looks cautious and is the
    // opposite: only a *turn* clears that flag, so every session sitting idle at
    // its prompt — alive, watched, wakeable — stayed permanently dead to us, its
    // senders were told it "went offline", and a broadcast skipped it entirely.
    // We don't know less after a restart than the snapshot says; assert exactly
    // that much and no more.
    for (const e of backend.loadRegistry()) {
      this.entries.set(e.alias, { ...e });
    }
  }

  /**
   * Bind an alias to a session and return its capability token.
   *
   * First registration mints a fresh token. A re-registration by the rightful
   * holder (the presented token matches) keeps the same token, so a reconnecting
   * session that kept its token file stays authorized. Any token-bearing alias
   * whose token is presented wrong (or not at all) is refused — even when it's
   * shown as offline, because warm-started entries after a broker restart are
   * marked offline yet are still owned; reclaiming them tokenlessly was a hijack
   * window. Only a legacy alias with no token (pre-upgrade) is freely claimable.
   * `ok:false` means the alias is owned and you didn't prove ownership.
   */
  register(
    alias: string,
    info: { sessionId: string; cwd: string; caps?: string[]; pid?: number | null; tty?: string | null },
    presentedToken?: string,
  ): { ok: boolean; replaced: boolean; token: string | null } {
    const prev = this.entries.get(alias);
    if (prev?.token && presentedToken !== prev.token) {
      return { ok: false, replaced: false, token: null }; // owned alias, wrong/missing token
    }
    const replaced = prev !== undefined && prev.sessionId !== info.sessionId;
    const keep = prev?.token && presentedToken === prev.token;
    const token = keep ? prev.token : `tok-${crypto.randomUUID()}`;
    this.entries.set(alias, {
      alias,
      sessionId: info.sessionId,
      cwd: info.cwd,
      caps: info.caps ?? [],
      pid: info.pid ?? null,
      tty: info.tty ?? prev?.tty ?? null,
      lastSeen: this.now(),
      status: "live",
      // A takeover of a different session's alias is marked, so "two names, one lane"
      // is legible instead of a same-name-two-liveness-states puzzle (D3). A takeover
      // sets it; the successor's own later re-registers CARRY IT FORWARD (else the
      // marker would evaporate on the next heartbeat-register).
      ...(replaced && prev ? { succeededSid: prev.sessionId } : prev?.succeededSid ? { succeededSid: prev.succeededSid } : {}),
      token,
    });
    this.touchSiblings(info.sessionId, alias); // registering IS a liveness signal for the whole session
    this.snapshot();
    return { ok: true, replaced, token };
  }

  /** The capability token registered for an alias, or null if unknown/legacy. */
  tokenOf(alias: string): string | null {
    return this.entries.get(alias)?.token ?? null;
  }

  get(alias: string): RegistryEntry | null {
    const e = this.entries.get(alias);
    // token is a secret — never hand it back through a read accessor.
    return e ? { ...e, caps: [...e.caps], status: this.statusOf(e), token: null } : null;
  }

  heartbeat(alias: string): void {
    const e = this.entries.get(alias);
    if (e) {
      e.lastSeen = this.now();
      e.status = "live";
      this.touchSiblings(e.sessionId, alias);
    }
  }

  /**
   * An acting op (send/reply/consent) is proof of life right now — refresh the
   * whole session. An explicitly-LEFT alias stays retired (same sticky rule as
   * touchSiblings): register is the way back, an act must not resurrect it.
   * Polling ops (check/deliver/count/list/await) must NEVER route here — a
   * detached watcher polls forever and would keep a dead session alive.
   */
  touchByAct(alias: string): void {
    const e = this.entries.get(alias);
    if (!e || e.status === "offline") return;
    e.lastSeen = this.now();
    e.status = "live";
    this.touchSiblings(e.sessionId, alias);
  }

  /**
   * A liveness signal through ANY of a session's aliases speaks for all of them.
   *
   * Sessions often hold several names; when only one heartbeated, a live session
   * read `idle` under its new name and `offline` under its old one, and peers
   * acted on the false half. An explicitly-left alias stays retired — that was a
   * statement of intent, not a missed heartbeat.
   */
  private touchSiblings(sessionId: string, except: string): void {
    for (const s of this.entries.values()) {
      if (s.alias === except || s.sessionId !== sessionId) continue;
      if (s.status === "offline") continue; // an explicit leave sticks
      s.lastSeen = this.now();
      s.status = "live";
    }
  }

  leave(alias: string): void {
    const e = this.entries.get(alias);
    if (e) {
      e.status = "offline";
      e.lastSeen = 0; // backdated so the leave survives a broker restart on its own
      this.snapshot();
    }
  }

  /** Has this alias ever registered? (Distinguishes "known but offline" from "unknown".) */
  has(alias: string): boolean {
    return this.entries.has(alias);
  }

  list(): RegistryEntry[] {
    // Name each entry's sibling aliases, so a reader can tell "two names, one
    // session" apart from two sessions — the confusion that had agents sending
    // IDENTIFY YOURSELF probes and one session messaging itself.
    const bySid = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      const list = bySid.get(e.sessionId) ?? [];
      list.push(e.alias);
      bySid.set(e.sessionId, list);
    }
    return [...this.entries.values()].map((e) => ({
      ...e,
      caps: [...e.caps],
      status: this.statusOf(e),
      token: null, // never expose tokens in the public roster
      sessionAliases: [...(bySid.get(e.sessionId) ?? [e.alias])].sort(),
      // Liveness is heartbeat recency, never a process check — hand the reader the
      // age so "live" is a legible inference, not a claim about a running process.
      sinceSeenS: Math.max(0, this.now() - e.lastSeen),
    }));
  }

  /**
   * Drop offline peers last seen before `beforeTs` that have no pending mail.
   *
   * Without this the roster accumulates every session that ever registered —
   * ephemeral sub-agents and headless runs that die without calling `leave`
   * pile up as dead entries. A peer with queued messages is kept (it's a live
   * mailbox awaiting its owner's return). Returns how many were removed.
   */
  pruneOffline(beforeTs: number): number {
    let removed = 0;
    for (const [alias, e] of this.entries) {
      if (this.statusOf(e) !== "offline" || e.lastSeen >= beforeTs) continue;
      if (this.backend.pending(alias).length > 0) continue; // keep live mailboxes
      this.entries.delete(alias);
      // The token authorizes nobody once the row is gone; delete the owner's
      // token file too so the tokens dir doesn't outgrow the registry.
      try {
        unlinkSync(join(config.tokensDir, encodeURIComponent(alias)));
      } catch {
        // no token file (legacy/unregistered) — nothing to remove
      }
      removed++;
    }
    if (removed > 0) this.snapshot();
    return removed;
  }

  liveAliases(exclude?: string): string[] {
    return this.list()
      .filter((e) => e.status !== "offline" && e.alias !== exclude)
      .map((e) => e.alias);
  }

  // An explicit `leave` sticks immediately, and only a `leave` sets status to offline
  // now that the constructor preserves the snapshotted status instead of force-writing
  // "offline" on every warm-start. That decoupling is what makes the sticky check safe:
  // "you told us you're going" is honoured at once, while "we just haven't heard from
  // you yet" is left to decay by age like any live peer.
  private statusOf(e: RegistryEntry): RegistryEntry["status"] {
    if (e.status === "offline") return "offline";
    const age = this.now() - e.lastSeen;
    if (age > this.liveness.offlineS) return "offline";
    if (age > this.liveness.idleS) return "idle";
    return "live";
  }

  private snapshot(): void {
    this.backend.saveRegistry([...this.entries.values()]);
  }
}
