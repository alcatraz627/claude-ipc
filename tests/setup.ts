// Test isolation: point CLAUDE_IPC_HOME at a throwaway temp dir before any
// source module reads config. Without this, token files (and default socket/db
// paths) would land in the real ~/.claude-ipc and could collide with live data.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDE_IPC_HOME = mkdtempSync(join(tmpdir(), "cipc-test-"));
