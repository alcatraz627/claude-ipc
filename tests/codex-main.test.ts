import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  acquireOwner,
  isTopLevelThread,
  managedAppServerArgs,
  notificationThreadCandidate,
  spawnManagedCodex,
} from "../src/codex/main.ts";
import { managedIdentityInAncestry } from "../src/config.ts";

describe("managed Codex host ownership", () => {
  test("rejects a second live owner before any host work can start", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-host-owner-"));
    const owner = acquireOwner("thread-1", "cx-owner", root);
    expect(() => acquireOwner("thread-1", undefined, root)).toThrow("already has a delivery host");
    owner.release();
    const replacement = acquireOwner("thread-1", undefined, root);
    expect(replacement.alias).toBe("cx-owner");
    replacement.release();
  });

  test("rejects one alias owning two live threads", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-host-alias-owner-"));
    const owner = acquireOwner("thread-1", "cx-shared", root);
    expect(() => acquireOwner("thread-2", "cx-shared", root)).toThrow("alias cx-shared already has a delivery host");
    owner.release();
  });

  test("moves one host alias to the TUI's next thread atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-host-alias-handoff-"));
    const first = acquireOwner("thread-1", "cx-shared", root);
    const second = acquireOwner("thread-2", "cx-shared", root, first.ownerId);
    first.release();
    expect(() => acquireOwner("thread-3", "cx-shared", root)).toThrow("alias cx-shared already has a delivery host");
    second.release();
  });

  test("atomically replaces a dead owner row left by a crashed host", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-host-stale-owner-"));
    const db = new Database(join(root, "owners.sqlite"), { create: true });
    db.exec("CREATE TABLE owners (thread_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner_id TEXT NOT NULL)");
    db.query("INSERT INTO owners VALUES (?,?,?)").run("thread-dead", 999_999_999, "dead-owner");
    db.close();
    const owner = acquireOwner("thread-dead", undefined, root);
    expect(owner.alias).toBe("cx-codex-threadde");
    owner.release();
  });

  test("passes identity through App Server infrastructure children", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-managed-env-"));
    const directOut = join(root, "direct.json");
    const helper = join(root, "helper.ts");
    const fakeCodex = join(root, "codex");
    const configUrl = new URL("../src/config.ts", import.meta.url).href;
    writeFileSync(helper, `import { config, ipcIdentityEnv } from ${JSON.stringify(configUrl)}; await Bun.write(process.env.DIRECT_OUT!, JSON.stringify({ managed: config.managedCodexHost, alias: ipcIdentityEnv("CLAUDE_IPC_ALIAS"), session: ipcIdentityEnv("CLAUDE_IPC_SESSION") }));\n`);
    writeFileSync(fakeCodex, `#!/bin/sh\nbun "$HELPER_SCRIPT"\n`);
    chmodSync(fakeCodex, 0o700);
    const child = spawnManagedCodex([], root, {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      HELPER_SCRIPT: helper,
      DIRECT_OUT: directOut,
      CLAUDE_IPC_ALIAS: "cx-test",
      CLAUDE_IPC_SESSION: "codex-host:cx-test",
      CLAUDE_IPC_MANAGED_HOST: "1",
    }, ["ignore", "ignore", "inherit"]);
    await once(child, "exit");
    expect(JSON.parse(readFileSync(directOut, "utf8"))).toEqual({
      managed: true,
      alias: "cx-test",
      session: "codex-host:cx-test",
    });
  });

  test("follows only top-level TUI threads", () => {
    expect(isTopLevelThread({ id: "main", parentThreadId: null, source: "cli" })).toBe(true);
    expect(isTopLevelThread({ id: "child", parentThreadId: "main", source: { subAgent: {} } })).toBe(false);
    expect(isTopLevelThread({ id: "child", parentThreadId: null, source: { subAgent: {} } })).toBe(false);
  });

  test("recognizes resume goal notifications but requires top-level verification", () => {
    expect(notificationThreadCandidate("thread/goal/cleared", { threadId: "resumed" })).toEqual({
      id: "resumed",
      topLevelVerified: false,
      historyKnownEmpty: false,
    });
    expect(notificationThreadCandidate("thread/goal/updated", { threadId: "resumed", goal: {} })).toEqual({
      id: "resumed",
      topLevelVerified: false,
      historyKnownEmpty: false,
    });
    expect(notificationThreadCandidate("turn/started", { threadId: "resumed" })).toBeUndefined();
    expect(notificationThreadCandidate("thread/started", {
      thread: { id: "child", parentThreadId: "parent", source: { subAgent: {} } },
    })).toBeUndefined();
    expect(notificationThreadCandidate("thread/started", {
      thread: { id: "fresh", parentThreadId: null, source: "cli" },
    })).toEqual({ id: "fresh", topLevelVerified: true, historyKnownEmpty: true });
  });

  test("starts App Server without replacing the user's shell environment policy", () => {
    expect(managedAppServerArgs("ws://127.0.0.1:1234", {
      alias: "cx-test",
      sessionId: "codex-host:cx-test",
      home: "/ipc",
      socketPath: "/ipc/run/ipc.sock",
      dbPath: "/ipc/data/ipc.sqlite",
    }, "/repo/src/mcpServer.ts")).toEqual([
      "app-server",
      "-c",
      `mcp_servers.claude_ipc.command=${JSON.stringify(process.execPath)}`,
      "-c",
      'mcp_servers.claude_ipc.args=["run","/repo/src/mcpServer.ts"]',
      "-c",
      'mcp_servers.claude_ipc.env={CLAUDE_IPC_ALIAS="cx-test",CLAUDE_IPC_SESSION="codex-host:cx-test",CLAUDE_IPC_MANAGED_MCP="1",CLAUDE_IPC_HOME="/ipc",CLAUDE_IPC_SOCKET="/ipc/run/ipc.sock",CLAUDE_IPC_DB="/ipc/data/ipc.sqlite"}',
      "--listen",
      "ws://127.0.0.1:1234",
    ]);
  });

  test("rejects managed identity when another agent appears before the host marker", () => {
    const fields = new Map([
      [40, { ppid: "30", comm: "bun", command: "bun hook.ts" }],
      [30, { ppid: "20", comm: "claude", command: "claude -p nested" }],
      [20, { ppid: "1", comm: "codex", command: "codex app-server" }],
    ]);
    const read = (pid: number, field: "ppid" | "comm" | "command") => fields.get(pid)?.[field] ?? "";
    expect(managedIdentityInAncestry(20, 40, read)).toBe(false);
    expect(managedIdentityInAncestry(20, 30, (_pid, field) => field === "ppid" ? "20" : "bash")).toBe(true);
  });
});
