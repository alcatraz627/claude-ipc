import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "../src/client.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker } from "../src/broker/server.ts";

const repo = join(import.meta.dir, "..");
const root = `/private/tmp/claude-ipc-host-failure-${process.pid}`;
mkdirSync(root, { recursive: true });
const fakeCodex = join(root, "codex");
writeFileSync(fakeCodex, `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE_CODEX_MODE;
const statePath = process.env.FAKE_CODEX_STATE;
const state = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { connections: 0, deliveries: [], roles: {}, closedRoles: [], turnStarts: 0 };
const save = (value) => writeFileSync(statePath, JSON.stringify(value));
setInterval(() => { try { process.kill(process.ppid, 0); } catch { process.exit(0); } }, 100);
if (process.argv[2] !== "app-server") {
  writeFileSync(statePath + ".tui-pid", String(process.pid));
  const remoteAt = process.argv.indexOf("--remote");
  const socket = new WebSocket(process.argv[remoteAt + 1]);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fake-tui", version: "1" } } }));
  await new Promise(() => {});
}
writeFileSync(statePath + ".appserver-pid", String(process.pid));
const at = process.argv.indexOf("--listen");
const url = new URL(process.argv[at + 1]);
let nextTurn = 0;
const server = Bun.serve({
  hostname: url.hostname,
  port: Number(url.port),
  fetch(request, server) {
    const current = state();
    current.connections += 1;
    save(current);
    return server.upgrade(request, { data: { connection: current.connections } }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    message(socket, raw) {
      const request = JSON.parse(String(raw));
      if (typeof request.id !== "number") return;
      const respond = (result) => socket.send(JSON.stringify({ id: request.id, result }));
      if (request.method === "initialize") {
        const current = state();
        const role = request.params?.clientInfo?.name ?? "unknown";
        socket.data.role = role;
        current.roles[role] = (current.roles[role] ?? 0) + 1;
        save(current);
        respond({});
        return;
      }
      if (request.method === "thread/resume") {
        respond({ thread: { id: request.params.threadId } });
        if (mode === "reconnect" && socket.data.connection === 1) setTimeout(() => socket.close(), 10);
        if (mode === "switch-conflict") setTimeout(() => socket.send(JSON.stringify({
          method: "thread/started",
          params: { thread: { id: "thread-owned", parentThreadId: null, source: "cli" } },
        })), 50);
        return;
      }
      if (request.method === "thread/read") {
        const current = state();
        if ((mode === "crash" && request.params.includeTurns && current.deliveries.length > 0) ||
            (mode === "leased" && request.params.includeTurns)) return;
        respond({ thread: {
          id: request.params.threadId,
          parentThreadId: null,
          source: "cli",
          status: { type: "idle" },
          turns: request.params.includeTurns ? current.deliveries.map((delivery) => ({
            id: delivery.turnId,
            status: "completed",
            items: [{ type: "functionCallOutput", namespace: delivery.namespace, name: delivery.name, output: delivery.output }],
          })) : [],
        } });
        return;
      }
      if (request.method === "turn/start") {
        const current = state();
        const turnId = \`fake-turn-\${++nextTurn}\`;
        current.turnStarts += 1;
        current.deliveries.push({ turnId, ...request.params.toolOutput });
        save(current);
        respond({ turn: { id: turnId, status: "completed" } });
        return;
      }
      socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: \`unsupported \${request.method}\` } }));
    },
    close(socket) {
      const current = state();
      current.closedRoles.push(socket.data.role ?? "unknown");
      save(current);
    },
  },
});
console.error(\`fake app-server listening on \${server.port}\`);
await new Promise(() => {});
`);
chmodSync(fakeCodex, 0o700);

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

function hostProcess(args: { alias: string; thread: string; home: string; socket: string; state: string; mode: string; resetState?: boolean }) {
  if (args.resetState !== false) {
    writeFileSync(args.state, JSON.stringify({ connections: 0, deliveries: [], roles: {}, closedRoles: [], turnStarts: 0 }));
  }
  return spawn("bun", ["run", "src/codex/main.ts", "--thread", args.thread, "--alias", args.alias], {
    cwd: repo,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      CLAUDE_IPC_HOME: args.home,
      CLAUDE_IPC_SOCKET: args.socket,
      CLAUDE_IPC_DB: join(args.home, "data", "ipc.sqlite"),
      FAKE_CODEX_STATE: args.state,
      FAKE_CODEX_MODE: args.mode,
    },
  });
}

async function setupBroker(name: string, now: () => number) {
  const home = join(root, name);
  const socket = join(home, "run", "ipc.sock");
  const tokens = join(home, "tokens");
  mkdirSync(join(home, "run"), { recursive: true });
  const backend = new MemoryBackend();
  const registry = new Registry(backend, now, { idleS: 300, offlineS: 1800 });
  let nextId = 0;
  const broker = startBroker({ socketPath: socket, router: new Router(backend, registry, now, () => `msg-${name}-${++nextId}`, 60) });
  const sender = new Client(socket, undefined, tokens);
  await sender.register(`sender-${name}`, { sessionId: `sender:${name}`, cwd: repo, pid: process.pid });
  return { home, socket, tokens, backend, registry, broker, sender };
}

test("reconnects delivery and recovers a persisted unacknowledged lease after host death", async () => {
let now = Math.floor(Date.now() / 1000);
const reconnect = await setupBroker("reconnect", () => now);
const reconnectState = join(root, "reconnect-state.json");
const reconnectHost = hostProcess({ alias: "host-reconnect", thread: "thread-reconnect", home: reconnect.home, socket: reconnect.socket, state: reconnectState, mode: "reconnect" });
try {
  await waitFor(() => reconnect.registry.list().some((peer) => peer.alias === "host-reconnect"), "reconnect host registration");
  await waitFor(() => existsSync(reconnectState + ".tui-pid") && existsSync(reconnectState + ".appserver-pid"), "host child pids");
  const sent = await reconnect.sender.send({ from: "sender-reconnect", to: "host-reconnect", kind: "query", body: "reconnect mail" });
  await waitFor(() => reconnect.backend.deliveriesFor(sent.msgId)[0]?.state === "persisted", "delivery after reconnect");
  const reconnectRecord = JSON.parse(readFileSync(reconnectState, "utf8"));
  const tuiPid = Number(readFileSync(reconnectState + ".tui-pid", "utf8"));
  const appServerPid = Number(readFileSync(reconnectState + ".appserver-pid", "utf8"));
  process.kill(tuiPid, 0);
  process.kill(appServerPid, 0);
  if (reconnectRecord.roles["claude-ipc-codex-host"] < 2 || reconnectRecord.roles["fake-tui"] !== 1 ||
      reconnectRecord.closedRoles.includes("fake-tui") || reconnectRecord.deliveries.length !== 1 || reconnectRecord.turnStarts !== 1) {
    throw new Error(`bad reconnect record ${JSON.stringify(reconnectRecord)}`);
  }
  const reconnectOutput = JSON.parse(reconnectRecord.deliveries[0].output);
  if (!String(reconnectOutput.trustBoundary).includes("peer agent, not from your user")) {
    throw new Error(`query crossed the live managed host without its trust boundary ${JSON.stringify(reconnectOutput)}`);
  }
} finally {
  reconnectHost.kill("SIGTERM");
  await once(reconnectHost, "exit").catch(() => undefined);
  reconnect.broker.stop();
}

now = Math.floor(Date.now() / 1000);
const crash = await setupBroker("crash", () => now);
const crashState = join(root, "crash-state.json");
const firstHost = hostProcess({ alias: "host-crash", thread: "thread-crash", home: crash.home, socket: crash.socket, state: crashState, mode: "crash" });
let secondHost: ReturnType<typeof hostProcess> | undefined;
try {
  await waitFor(() => crash.registry.list().some((peer) => peer.alias === "host-crash"), "first crash host registration");
  const sent = await crash.sender.send({ from: "sender-crash", to: "host-crash", kind: "query", body: "crash mail" });
  await waitFor(() => JSON.parse(readFileSync(crashState, "utf8")).deliveries.length === 1, "persist before forced crash");
  const beforeKill = crash.backend.deliveriesFor(sent.msgId)[0]?.state;
  if (beforeKill !== "delivered") throw new Error(`host acknowledged before forced crash: ${String(beforeKill)}`);
  firstHost.kill("SIGKILL");
  await once(firstHost, "exit");
  now += 31;
  secondHost = hostProcess({ alias: "host-crash", thread: "thread-crash", home: crash.home, socket: crash.socket, state: crashState, mode: "recover", resetState: false });
  await waitFor(() => crash.backend.deliveriesFor(sent.msgId)[0]?.state === "persisted", "replacement host acknowledgement");
  const recovered = JSON.parse(readFileSync(crashState, "utf8"));
  if (recovered.deliveries.length !== 1 || recovered.turnStarts !== 1) throw new Error(`replacement duplicated delivery ${JSON.stringify(recovered)}`);
  if (!String(JSON.parse(recovered.deliveries[0].output).trustBoundary).includes("peer agent, not from your user")) {
    throw new Error(`recovered query lost its trust boundary ${JSON.stringify(recovered)}`);
  }
} finally {
  firstHost.kill("SIGTERM");
  secondHost?.kill("SIGTERM");
  if (secondHost) await once(secondHost, "exit").catch(() => undefined);
  crash.broker.stop();
}

now = Math.floor(Date.now() / 1000);
const leased = await setupBroker("leased", () => now);
const leasedState = join(root, "leased-state.json");
const leasedFirstHost = hostProcess({ alias: "host-leased", thread: "thread-leased", home: leased.home, socket: leased.socket, state: leasedState, mode: "leased" });
let leasedSecondHost: ReturnType<typeof hostProcess> | undefined;
try {
  await waitFor(() => leased.registry.list().some((peer) => peer.alias === "host-leased"), "first leased host registration");
  const sent = await leased.sender.send({ from: "sender-leased", to: "host-leased", kind: "query", body: "leased crash mail" });
  await waitFor(() => leased.backend.deliveriesFor(sent.msgId)[0]?.state === "delivered", "lease before persistence");
  const beforeKill = JSON.parse(readFileSync(leasedState, "utf8"));
  if (beforeKill.deliveries.length !== 0 || beforeKill.turnStarts !== 0) throw new Error(`leased host persisted before kill ${JSON.stringify(beforeKill)}`);
  leasedFirstHost.kill("SIGKILL");
  await once(leasedFirstHost, "exit");
  now += 31;
  leasedSecondHost = hostProcess({ alias: "host-leased", thread: "thread-leased", home: leased.home, socket: leased.socket, state: leasedState, mode: "recover", resetState: false });
  await waitFor(() => leased.backend.deliveriesFor(sent.msgId)[0]?.state === "persisted", "replacement persistence after leased crash");
  const recovered = JSON.parse(readFileSync(leasedState, "utf8"));
  if (recovered.deliveries.length !== 1 || recovered.turnStarts !== 1) throw new Error(`leased replacement delivery mismatch ${JSON.stringify(recovered)}`);
  if (!String(JSON.parse(recovered.deliveries[0].output).trustBoundary).includes("peer agent, not from your user")) {
    throw new Error(`leased recovery query lost its trust boundary ${JSON.stringify(recovered)}`);
  }
} finally {
  leasedFirstHost.kill("SIGTERM");
  leasedSecondHost?.kill("SIGTERM");
  if (leasedSecondHost) await once(leasedSecondHost, "exit").catch(() => undefined);
  leased.broker.stop();
}
}, 30_000);

test("a thread ownership conflict does not terminate the user's TUI", async () => {
  const now = Math.floor(Date.now() / 1000);
  const fixture = await setupBroker("switch-conflict", () => now);
  const ownersDir = join(fixture.home, "codex-hosts");
  mkdirSync(ownersDir, { recursive: true });
  const owners = new Database(join(ownersDir, "owners.sqlite"), { create: true });
  owners.exec("CREATE TABLE owners (thread_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, owner_id TEXT NOT NULL, alias TEXT, active INTEGER NOT NULL DEFAULT 1)");
  owners.query("INSERT INTO owners VALUES (?,?,?,?,?)").run("thread-owned", process.pid, "other-owner", "host-other", 1);
  owners.close();
  const state = join(root, "switch-conflict-state.json");
  const host = hostProcess({
    alias: "host-switch",
    thread: "thread-initial",
    home: fixture.home,
    socket: fixture.socket,
    state,
    mode: "switch-conflict",
  });
  try {
    await waitFor(() => existsSync(state + ".tui-pid"), "switch-conflict TUI");
    await Bun.sleep(1200);
    const tuiPid = Number(readFileSync(state + ".tui-pid", "utf8"));
    process.kill(tuiPid, 0);
    if (host.exitCode !== null || host.signalCode !== null) throw new Error("host exited on thread ownership conflict");
  } finally {
    host.kill("SIGTERM");
    await once(host, "exit").catch(() => undefined);
    fixture.broker.stop();
  }
}, 10_000);
