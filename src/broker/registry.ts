/**
 * The live roster of registered peers.
 *
 * Tracks who is reachable under which alias, ages them from live → idle →
 * offline by how recently they were heard from, and snapshots to durable storage
 * on every change so a known alias survives a broker restart (the offline queue
 * still routes to it). Aliases are the addressing unit; a queue is alias-keyed,
 * so re-binding an alias to a new session does not strand its pending messages.
 */

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
    // Warm-start from the snapshot, but trust no liveness until a fresh heartbeat.
    for (const e of backend.loadRegistry()) {
      this.entries.set(e.alias, { ...e, status: "offline" });
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
      token,
    });
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
    }
  }

  leave(alias: string): void {
    const e = this.entries.get(alias);
    if (e) {
      e.status = "offline";
      this.snapshot();
    }
  }

  /** Has this alias ever registered? (Distinguishes "known but offline" from "unknown".) */
  has(alias: string): boolean {
    return this.entries.has(alias);
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].map((e) => ({
      ...e,
      caps: [...e.caps],
      status: this.statusOf(e),
      token: null, // never expose tokens in the public roster
    }));
  }

  liveAliases(exclude?: string): string[] {
    return this.list()
      .filter((e) => e.status !== "offline" && e.alias !== exclude)
      .map((e) => e.alias);
  }

  private statusOf(e: RegistryEntry): RegistryEntry["status"] {
    if (e.status === "offline") return "offline"; // an explicit leave sticks
    const age = this.now() - e.lastSeen;
    if (age > this.liveness.offlineS) return "offline";
    if (age > this.liveness.idleS) return "idle";
    return "live";
  }

  private snapshot(): void {
    this.backend.saveRegistry([...this.entries.values()]);
  }
}
