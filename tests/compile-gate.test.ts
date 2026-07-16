/**
 * The compile gate: prove `bun build --compile` still produces a runnable
 * standalone binary now that the dashboard (React + ink-terminal) is bundled
 * in. A future bun upgrade that breaks embedding fails HERE, loudly — not at a
 * user's terminal. Builds to a throwaway dir, NEVER dist/ (launchd runs the
 * live broker from dist/claude-ipc; a test must not stage code into it).
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

test(
  "bun build --compile yields a standalone binary that runs",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "ipc-compile-gate-"));
    const out = join(dir, "claude-ipc-gate");
    try {
      const build = Bun.spawnSync(["bun", "build", "src/cli.ts", "--compile", "--outfile", out], {
        cwd: repoRoot,
      });
      expect(build.exitCode).toBe(0);
      // Run from the temp dir so a working binary proves it needs no node_modules.
      const run = Bun.spawnSync([out, "help"], { cwd: dir });
      expect(run.exitCode).toBe(0);
      expect(new TextDecoder().decode(run.stdout)).toContain("cross-session messaging");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);
