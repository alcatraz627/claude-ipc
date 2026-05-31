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

  register(
    alias: string,
    info: { sessionId: string; cwd: string; caps?: string[]; pid?: number | null; tty?: string | null },
  ): { replaced: boolean } {
    const prev = this.entries.get(alias);
    const replaced = prev !== undefined && prev.sessionId !== info.sessionId;
    this.entries.set(alias, {
      alias,
      sessionId: info.sessionId,
      cwd: info.cwd,
      caps: info.caps ?? [],
      pid: info.pid ?? null,
      tty: info.tty ?? prev?.tty ?? null,
      lastSeen: this.now(),
      status: "live",
    });
    this.snapshot();
    return { replaced };
  }

  get(alias: string): RegistryEntry | null {
    const e = this.entries.get(alias);
    return e ? { ...e, caps: [...e.caps], status: this.statusOf(e) } : null;
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
