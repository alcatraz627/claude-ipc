import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { AppServerWebSocketRpc, DEFER_TO_OTHER_CLIENT } from "./webSocketRpc.ts";
import { CodexIpcHost } from "./host.ts";
import { Client } from "../client.ts";
import { config } from "../config.ts";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reservePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

export function spawnManagedCodex(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdio: "inherit" | ["ignore", "ignore", "inherit"],
): ChildProcess {
  return spawn(
    "/bin/sh",
    ["-c", 'export CLAUDE_IPC_MANAGED_HOST_PID=$$; exec codex "$@"', "codex", ...args],
    { cwd, stdio, env },
  );
}

export function managedAppServerArgs(
  appUrl: string,
  ipc?: { alias: string; sessionId: string; home: string; socketPath: string; dbPath: string },
  mcpPath = join(import.meta.dir, "..", "mcpServer.ts"),
): string[] {
  const args = [
    "app-server",
    "-c",
    `mcp_servers.claude_ipc.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.claude_ipc.args=["run",${JSON.stringify(mcpPath)}]`,
  ];
  if (ipc) {
    const env = {
      CLAUDE_IPC_ALIAS: ipc.alias,
      CLAUDE_IPC_SESSION: ipc.sessionId,
      CLAUDE_IPC_MANAGED_MCP: "1",
      CLAUDE_IPC_HOME: ipc.home,
      CLAUDE_IPC_SOCKET: ipc.socketPath,
      CLAUDE_IPC_DB: ipc.dbPath,
    };
    const inline = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
    args.push("-c", `mcp_servers.claude_ipc.env={${inline}}`);
  }
  args.push("--listen", appUrl);
  return args;
}

export function isTopLevelThread(thread: {
  id?: string;
  parentThreadId?: string | null;
  source?: unknown;
}): thread is { id: string; parentThreadId?: string | null; source?: unknown } {
  if (!thread.id || thread.parentThreadId) return false;
  return !(thread.source && typeof thread.source === "object" && "subAgent" in thread.source);
}

export function notificationThreadCandidate(method: string, params: unknown): {
  id: string;
  topLevelVerified: boolean;
  historyKnownEmpty: boolean;
} | undefined {
  if (method === "thread/started") {
    const thread = (params as {
      thread?: { id?: string; parentThreadId?: string | null; source?: unknown };
    } | undefined)?.thread;
    return thread && isTopLevelThread(thread)
      ? { id: thread.id, topLevelVerified: true, historyKnownEmpty: true }
      : undefined;
  }
  if (method !== "thread/goal/updated" && method !== "thread/goal/cleared") return undefined;
  const id = (params as { threadId?: unknown } | undefined)?.threadId;
  return typeof id === "string" ? { id, topLevelVerified: false, historyKnownEmpty: false } : undefined;
}

export function acquireOwner(
  threadId: string,
  requestedAlias?: string,
  root = join(config.home, "codex-hosts"),
  replacingOwnerId?: string,
): { alias: string; ownerId: string; release(): void } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "owners.sqlite"), { create: true });
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("CREATE TABLE IF NOT EXISTS owners (thread_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner_id TEXT NOT NULL, alias TEXT, active INTEGER NOT NULL DEFAULT 1)");
  const columns = db.query("PRAGMA table_info(owners)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "alias")) db.exec("ALTER TABLE owners ADD COLUMN alias TEXT");
  if (!columns.some((column) => column.name === "active")) db.exec("ALTER TABLE owners ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  const ownerId = crypto.randomUUID();
  let alias = requestedAlias;
  try {
    db.exec("BEGIN IMMEDIATE");
    const prior = db.query("SELECT pid, alias, active FROM owners WHERE thread_id=?").get(threadId) as {
      pid: number;
      alias: string | null;
      active: number;
    } | null;
    if (prior?.active && pidAlive(prior.pid)) {
      db.exec("ROLLBACK");
      db.close();
      throw new Error(`thread ${threadId} already has a delivery host (pid ${prior.pid})`);
    }
    alias ??= prior?.alias ?? `cx-codex-${threadId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 8)}`;
    const aliasOwners = db.query("SELECT thread_id, pid, owner_id FROM owners WHERE alias=? AND thread_id<>? AND active=1").all(alias, threadId) as {
      thread_id: string;
      pid: number;
      owner_id: string;
    }[];
    for (const candidate of aliasOwners) {
      if (pidAlive(candidate.pid) && candidate.owner_id !== replacingOwnerId) {
        db.exec("ROLLBACK");
        db.close();
        throw new Error(`alias ${alias} already has a delivery host for thread ${candidate.thread_id} (pid ${candidate.pid})`);
      }
      db.query("UPDATE owners SET active=0 WHERE thread_id=? AND pid=?").run(candidate.thread_id, candidate.pid);
    }
    db.query(
      "INSERT INTO owners(thread_id,pid,owner_id,alias,active) VALUES (?,?,?,?,1) ON CONFLICT(thread_id) DO UPDATE SET pid=excluded.pid, owner_id=excluded.owner_id, alias=excluded.alias, active=1",
    ).run(threadId, process.pid, ownerId, alias);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
    try { db.close(); } catch { /* already closed */ }
    throw error;
  }
  let released = false;
  return {
    alias: alias!,
    ownerId,
    release: () => {
      if (released) return;
      released = true;
      db.query("UPDATE owners SET active=0 WHERE thread_id=? AND owner_id=?").run(threadId, ownerId);
      db.close();
    },
  };
}

async function main(): Promise<void> {
  const requestedThread = arg("--thread");
  const cwd = arg("--cwd") ?? process.cwd();
  const requestedAlias = arg("--alias") ?? config.codex.alias;
  let owner = requestedThread ? acquireOwner(requestedThread, requestedAlias) : undefined;
  const alias = owner?.alias ?? requestedAlias ??
    `cx-${basename(cwd).toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}-${process.pid.toString(16)}`;
  const ipcSessionId = `codex-host:${alias}`;
  const managedEnv = {
    ...process.env,
    CLAUDE_IPC_ALIAS: alias,
    CLAUDE_IPC_SESSION: ipcSessionId,
    CLAUDE_IPC_MANAGED_HOST: "1",
  };
  const port = reservePort();
  const appUrl = `ws://127.0.0.1:${port}`;
  const server = spawnManagedCodex(managedAppServerArgs(appUrl, {
    alias,
    sessionId: ipcSessionId,
    home: config.home,
    socketPath: config.socketPath,
    dbPath: config.dbPath,
  }), cwd, managedEnv, ["ignore", "ignore", "inherit"]);

  // The TUI and IPC owner share one App Server. This avoids the active-writer
  // conflict produced by attaching a second standalone app-server process.
  let resolveStarted: ((threadId: string) => void) | undefined;
  const tuiThread = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  let tui: ChildProcess | undefined;
  let appServer: AppServerWebSocketRpc | undefined;
  let activeThreadId = requestedThread;
  let pendingThread: { id: string; topLevelVerified: boolean; historyKnownEmpty: boolean } | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    const connected = appServer;
    appServer = undefined;
    connected?.stop();
    tui?.kill("SIGTERM");
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const releaseOwner = (): void => {
      owner?.release();
      owner = undefined;
    };
    if (server.exitCode !== null || server.signalCode !== null) releaseOwner();
    else server.once("exit", releaseOwner);
    server.kill("SIGTERM");
  };
  const onNotification = (method: string, params: unknown): void => {
    const candidate = notificationThreadCandidate(method, params);
    if (!candidate) return;
    if (!activeThreadId && candidate.topLevelVerified) resolveStarted?.(candidate.id);
    else if (activeThreadId && candidate.id !== activeThreadId) pendingThread = candidate;
  };
  const connectDelivery = async (): Promise<AppServerWebSocketRpc> => {
    const connected = await AppServerWebSocketRpc.connect(
      appUrl,
      async () => DEFER_TO_OTHER_CLIENT,
      onNotification,
      15_000,
      () => {
        if (appServer === connected) appServer = undefined;
      },
    );
    await connected.initialize();
    return connected;
  };
  try {
  for (let attempt = 0; attempt < 100 && !appServer; attempt++) {
    try {
      appServer = await connectDelivery();
    } catch {
      await Bun.sleep(25);
    }
  }
  if (!appServer) {
    server.kill("SIGTERM");
    throw new Error(`could not connect to Codex App Server at ${appUrl}`);
  }
  let threadId = requestedThread;
  if (threadId) {
    await appServer.request("thread/resume", { threadId, excludeTurns: true });
    tui = spawnManagedCodex(["resume", "--remote", appUrl, threadId], cwd, managedEnv, "inherit");
  } else {
    // Let the TUI create the thread, then bind the IPC identity from the
    // broadcast thread/started notification. This avoids a synthetic model turn
    // solely to make an empty host-created rollout resumable.
    tui = spawnManagedCodex(["--remote", appUrl, "-C", cwd], cwd, managedEnv, "inherit");
    const tuiExited = new Promise<never>((_resolve, reject) => {
      tui!.once("exit", (code, signal) => {
        reject(new Error(`Codex TUI exited before announcing its thread (${signal ?? code ?? "unknown"})`));
      });
    });
    threadId = await Promise.race([
      tuiThread,
      tuiExited,
    ]);
  }
  activeThreadId = threadId;
  owner ??= acquireOwner(threadId, alias);
  const broker = new Client(config.socketPath);
  const register = async (): Promise<void> => {
    await broker.register(alias, {
      sessionId: ipcSessionId,
      cwd,
      caps: ["codex", "app-server", "ipc-host"],
      pid: process.pid,
    });
  };
  await register();
  let heartbeatRunning = false;
  heartbeatTimer = setInterval(() => {
    if (heartbeatRunning || stopped) return;
    heartbeatRunning = true;
    void broker.heartbeat(alias).catch(async (error: unknown) => {
      if (error instanceof Error && error.message.startsWith("not_registered")) await register();
      else throw error;
    }).catch((error: unknown) => {
      console.error(`[claude-ipc codex host heartbeat] ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      heartbeatRunning = false;
    });
  }, 10_000);
  const host = new CodexIpcHost(broker, {
    request: (method, params, timeoutMs) => {
      if (!appServer) return Promise.reject(new Error("Codex App Server delivery connection is reconnecting"));
      return appServer.request(method, params, timeoutMs);
    },
  }, {
    alias,
    threadId,
    cwd,
    historyKnownEmpty: requestedThread === undefined,
    ensureRegistered: register,
    stillOwnsThread: (candidate) => candidate === activeThreadId && pendingThread === undefined,
  });

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  tui.once("exit", stop);
  server.once("exit", stop);
  while (!stopped) {
    if (!appServer) {
      try {
        appServer = await connectDelivery();
      } catch (error) {
        console.error(`[claude-ipc codex host] delivery reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        await Bun.sleep(1000);
        continue;
      }
    }
    if (pendingThread && pendingThread.id !== activeThreadId) {
      try {
        if (!pendingThread.topLevelVerified) {
          const read = await appServer.request("thread/read", {
            threadId: pendingThread.id,
            includeTurns: false,
          }) as { thread?: { id?: string; parentThreadId?: string | null; source?: unknown } };
          if (!read.thread || !isTopLevelThread(read.thread)) {
            pendingThread = undefined;
            continue;
          }
        }
        const nextOwner = acquireOwner(pendingThread.id, alias, undefined, owner?.ownerId);
        const previousOwner = owner;
        const historyKnownEmpty = pendingThread.historyKnownEmpty;
        owner = nextOwner;
        activeThreadId = pendingThread.id;
        pendingThread = undefined;
        host.switchThread(activeThreadId, historyKnownEmpty);
        previousOwner?.release();
      } catch (error) {
        console.error(`[claude-ipc codex host] cannot follow TUI thread: ${error instanceof Error ? error.message : String(error)}`);
        // The TUI owns navigation. A lock conflict or transient read failure
        // must not terminate the user's interactive session. Keep the candidate
        // pending and pause old-thread delivery until it can be followed.
        await Bun.sleep(1000);
        continue;
      }
    }
    try {
      await host.pumpOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[claude-ipc codex host] ${message}`);
      if (message.includes("did not answer") || message.includes("delivery deadline")) {
        const stale = appServer;
        appServer = undefined;
        stale?.stop();
      }
    }
    await Bun.sleep(1000);
  }
  try {
    await broker.leave(alias);
  } catch {
    // The broker may already be down; the registry will age the alias normally.
  }
  } catch (error) {
    stop();
    throw error;
  }
}

if (import.meta.main) void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
