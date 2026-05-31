import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { createTools } from "../src/tools.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("allowlist", () => {
  let broker: BrokerHandle;
  let client: Client;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null, () => {}, {
      privileged: ["auto-be"],
    });
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
    await client.register("privileged", { sessionId: "sP", cwd: "/p" });
    await client.register("frontend", { sessionId: "sF", cwd: "/f" });
  });
  afterEach(() => broker.stop());

  test("an allowed sender may target the guarded peer", async () => {
    const r = await client.send({ from: "auto-be", to: "privileged", kind: "request", body: "deploy" });
    expect(r.msgId).toBe("msg-1");
  });

  test("a disallowed sender is rejected with not_allowed", async () => {
    const r = await client.send({ from: "rando", to: "privileged", kind: "request", body: "rm -rf" });
    expect(r.error.code).toBe("not_allowed");
  });

  test("peers with no allowlist entry are unrestricted", async () => {
    const r = await client.send({ from: "anyone", to: "frontend", kind: "inform", body: "hi" });
    expect(r.msgId).toBeTruthy();
  });
});

describe("status + context pointer", () => {
  let broker: BrokerHandle;
  let client: Client;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
  });
  afterEach(() => broker.stop());

  test("status returns a message's deliveries + responses", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await client.reply({ from: "bob", corrId: q.msgId, body: "answer" });
    const s = await client.status(q.msgId);
    expect(s.message.id).toBe(q.msgId);
    expect(s.deliveries.length).toBe(1);
    expect(s.deliveries[0].toAlias).toBe("bob");
    expect(s.responses.length).toBe(1);
    expect(s.responses[0].body).toBe("answer");
  });

  test("count returns the pending message count", async () => {
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "1" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "2" });
    expect((await client.count("bob")).count).toBe(2);
  });

  test("ipc_send carries a context pointer back to the sender's session", async () => {
    const alice = createTools(client, { alias: "alice", sessionId: "sess-A", cwd: "/work/be" });
    const sent = (await alice.ipc_send({ to: "bob", kind: "inform", body: "fyi" })) as { msgId: string };
    const s = await client.status(sent.msgId);
    expect(s.message.contextPtr.sessionId).toBe("sess-A");
    expect(s.message.contextPtr.cwd).toBe("/work/be");
  });
});
