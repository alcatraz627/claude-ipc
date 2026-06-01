/**
 * The broker's own operational log, with size-based rotation.
 *
 * launchd owns the process's stdout/stderr files and keeps them open, so the
 * broker can't rotate those from the inside. Instead it writes its diagnostics
 * here — one rotated file it fully controls — so an operator has a bounded,
 * timestamped record (boot, retention sweeps, handled errors) that can't grow
 * without bound. Logging is best-effort: it must never throw into the hot path.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const CAP_BYTES = 5 * 1024 * 1024; // rotate once the file passes 5 MB, keeping one prior

export function brokerLog(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > CAP_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no existing file to rotate — first write
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never break the broker
  }
}
