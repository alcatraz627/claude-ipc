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

/**
 * A path safe for the broker to open and write a terminal escape to.
 *
 * The path comes from a peer's `--tty`; a crafted one could aim the broker's
 * write at any file its uid owns. Only real terminal device nodes qualify.
 */
export function isTtyPath(path: string): boolean {
  return /^\/dev\/(tty[a-z]*[0-9]*|pts\/\d+)$/.test(path);
}

/**
 * Strip the bytes that would let a title escape its own OSC sequence.
 *
 * An embedded BEL/ESC/newline could end the title sequence early and leave the
 * rest running as raw terminal commands on the peer's screen. Last gate before
 * bytes reach another session's pty.
 */
function sanitizeTitle(title: string): string {
  // eslint-disable-next-line no-control-regex — control bytes are exactly what we strip
  return title.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
}

/** The full OSC-0 "set title" byte sequence for a title, sanitized so it can't break out. */
export function oscTitle(title: string): string {
  return `\x1b]0;${sanitizeTitle(title)}\x07`;
}

/** Writes the OSC-0 "set title" escape straight to a peer's pty. Best-effort. */
export const ttyBadgeSink: BadgeSink = {
  write(ttyPath, title) {
    if (!isTtyPath(ttyPath)) return; // never open a non-tty path for writing
    try {
      const fd = openSync(ttyPath, "w");
      try {
        writeSync(fd, oscTitle(title));
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
