#!/usr/bin/env bun
/**
 * Registers claude-ipc's hooks into a Claude Code settings.json — additively.
 *
 * The hooks are injection-only and never block, so they compose alongside any
 * existing guardrail hooks. By default this PRINTS the fragment + instructions;
 * it only writes when given an explicit `--write <path>`, and never silently
 * touches a live settings file. The merge is idempotent (safe to re-run).
 */

import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

export function ipcHookCommands(repoDir: string): Record<string, string> {
  return {
    UserPromptSubmit: `${repoDir}/hooks/ups.sh`,
    SessionStart: `${repoDir}/hooks/session-start.sh`,
    Stop: `${repoDir}/hooks/stop.sh`,
  };
}

interface HookEntry {
  type: "command";
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Add the IPC hook commands to each event, skipping any already present. */
export function mergeHooks(settings: Settings, repoDir: string): Settings {
  const out: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const hooks = out.hooks as Record<string, HookGroup[]>;
  for (const [event, command] of Object.entries(ipcHookCommands(repoDir))) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as HookGroup[])] : [];
    const present = groups.some((g) => g.hooks.some((h) => h.command === command));
    if (!present) groups.push({ hooks: [{ type: "command", command }] });
    hooks[event] = groups;
  }
  return out;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const writeIdx = argv.indexOf("--write");
  const fragment = mergeHooks({}, REPO);

  if (writeIdx === -1) {
    console.log("# Add these hooks to your Claude Code settings.json (additive, injection-only):\n");
    console.log(JSON.stringify(fragment, null, 2));
    console.log(
      "\n# To merge into a settings file:  bun run scripts/install.ts --write <path>" +
        "\n# (This never writes unless you pass --write with an explicit path.)",
    );
    return;
  }

  const path = argv[writeIdx + 1];
  if (!path) {
    console.error("--write needs a path");
    process.exit(2);
  }
  const file = Bun.file(path);
  const existing = (await file.exists()) ? ((await file.json()) as Settings) : {};
  await Bun.write(path, JSON.stringify(mergeHooks(existing, REPO), null, 2) + "\n");
  console.log(`merged claude-ipc hooks into ${path}`);
}

if (import.meta.main) void main();
