/**
 * Out-of-band tab badging: the broker shows a peer's pending-message count on
 * its Ghostty tab title, by writing an OSC title escape directly to that peer's
 * pty. Idle-proof — it works even when the recipient session is dormant, because
 * the broker does the write, not the session's (non-firing) hooks. It is a
 * signal, not a wake: it tells you a tab has mail; you still switch to it.
 */

import { closeSync, openSync, writeSync } from "node:fs";
import type { Registry } from "./broker/registry.ts";
import type { StorageBackend } from "./storage/base.ts";

/** Where a badge title is delivered. The real sink writes an OSC escape to a pty. */
export interface BadgeSink {
  write(ttyPath: string, title: string): void;
}

/** Writes the OSC-0 "set title" escape straight to a peer's pty. Best-effort. */
export const ttyBadgeSink: BadgeSink = {
  write(ttyPath, title) {
    try {
      const fd = openSync(ttyPath, "w");
      try {
        writeSync(fd, `\x1b]0;${title}\x07`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // pty gone or no permission — badging is best-effort, never fatal
    }
  },
};

/** The tab title for a peer given its pending count. */
export function badgeTitle(alias: string, count: number): string {
  return count > 0 ? `📨 ${count} · ${alias}` : alias;
}

/** Best-effort: the controlling tty of a process id, as /dev/ttysNNN, or null. */
export function ttyForPid(pid: number): string | null {
  try {
    const out = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]).stdout.toString().trim();
    return out && out !== "??" ? `/dev/${out}` : null;
  } catch {
    return null;
  }
}

/**
 * Keeps a peer's tab title in sync with its pending-message count. Called
 * whenever a peer's inbox changes. No-op when disabled or when the peer has no
 * known tty.
 */
export class BadgeNotifier {
  constructor(
    private backend: StorageBackend,
    private registry: Registry,
    private sink: BadgeSink,
    private enabled: boolean,
  ) {}

  update(alias: string): void {
    if (!this.enabled) return;
    const tty = this.registry.get(alias)?.tty;
    if (!tty) return;
    this.sink.write(tty, badgeTitle(alias, this.backend.pending(alias).length));
  }
}
