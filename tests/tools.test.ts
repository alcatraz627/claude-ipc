import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { createTools } from "../src/tools.ts";
import { buildMcpServer } from "../src/mcpServer.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("ipc_* tools", () => {
  let broker: BrokerHandle;
  let alice: ReturnType<typeof createTools>;
  let bob: ReturnType<typeof createTools>;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    broker = startBroker({ router, socketPath: tmpSock() });
    const client = new Client(broker.socketPath);
    alice = createTools(client, { alias: "alice", sessionId: "sA", cwd: "/a" });
    bob = createTools(client, { alias: "bob", sessionId: "sB", cwd: "/b" });
    await alice.ipc_register({});
    await bob.ipc_register({});
  });
  afterEach(() => broker.stop());

  test("query → reply through the tool layer", async () => {
    const sent = (await alice.ipc_send({ to: "bob", kind: "query", body: "base url?" })) as { msgId: string };
    const inbox = (await bob.ipc_check({ consume: false })) as { messages: { body: string }[] };
    expect(inbox.messages.map((m) => m.body)).toEqual(["base url?"]);
    await bob.ipc_reply({ corrId: sent.msgId, body: "localhost:3000" });
    const aInbox = (await alice.ipc_check({ consume: false })) as { messages: { body: string; corrId: string }[] };
    expect(aInbox.messages[0]?.body).toBe("localhost:3000");
    expect(aInbox.messages[0]?.corrId).toBe(sent.msgId);
  });

  test("ipc_send refuses a missing target (never inferred)", () => {
    expect(() => alice.ipc_send({ to: "", kind: "inform", body: "x" })).toThrow(/explicit/);
  });

  test("request accept and decline via tools", async () => {
    const r2 = (await alice.ipc_send({ to: "bob", kind: "request", body: "deploy" })) as { msgId: string };
    await bob.ipc_decline({ msgId: r2.msgId, reason: "no" });
    const aInbox = (await alice.ipc_check({ consume: false })) as {
      messages: { corrId: string; errorCode: string }[];
    };
    const declined = aInbox.messages.find((m) => m.corrId === r2.msgId);
    expect(declined?.errorCode).toBe("declined");
  });

  test("ipc_compose returns live peers excluding self", async () => {
    const res = (await alice.ipc_compose()) as { peers: { alias: string }[] };
    expect(res.peers.map((p) => p.alias)).toEqual(["bob"]); // alice (self) excluded
  });

  test("ipc_list and ipc_history", async () => {
    const peers = (await alice.ipc_list()) as { peers: { alias: string }[] };
    expect(peers.peers.map((p) => p.alias).sort()).toEqual(["alice", "bob"]);
    await alice.ipc_send({ to: "bob", kind: "inform", body: "note" });
    const hist = (await alice.ipc_history({ peer: "bob" })) as { messages: unknown[] };
    expect(hist.messages.length).toBeGreaterThan(0);
  });
});

describe("MCP server wiring", () => {
  test("buildMcpServer registers all tools without throwing", () => {
    const tools = createTools(new Client("/tmp/none.sock"), { alias: "x", sessionId: "s", cwd: "/x" });
    expect(() => buildMcpServer(tools)).not.toThrow();
  });
});
