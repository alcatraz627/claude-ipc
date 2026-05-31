import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("broker end-to-end", () => {
  let broker: BrokerHandle;
  let client: Client;
  let clock = 1000;
  let idn = 0;

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => clock, () => `msg-${++idn}`);
    const sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    client = new Client(sock);
  });
  afterEach(() => broker.stop());

  test("register, send a query, check receives it, list shows both peers", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "query", body: "base url?" });
    expect(sent.msgId).toBe("msg-1");
    const inbox = await client.check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["base url?"]);
    const peers = await client.list();
    expect(peers.peers.map((p: { alias: string }) => p.alias).sort()).toEqual(["alice", "bob"]);
  });

  test("send to an unknown alias returns no_peer with the live-peer list", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    const res = await client.send({ from: "alice", to: "ghost", kind: "query", body: "?" });
    expect(res.error.code).toBe("no_peer");
    expect(res.error.livePeers).toContain("alice");
  });

  test("alias rebind keeps the alias-keyed queue intact", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB1", cwd: "/b" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "hi" });
    const r = await client.register("bob", { sessionId: "sB2", cwd: "/b" }); // bob reconnects
    expect(r.replaced).toBe(true);
    const inbox = await client.check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["hi"]);
  });

  test("broadcast fans out to live peers except the sender", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    await client.register("carol", { sessionId: "sC", cwd: "/c" });
    await client.send({ from: "alice", to: "*", kind: "inform", body: "standup" });
    expect((await client.check("bob")).messages.length).toBe(1);
    expect((await client.check("carol")).messages.length).toBe(1);
    expect((await client.check("alice")).messages.length).toBe(0);
  });

  // Regression: a response bigger than the socket send-buffer watermark (~8 KB)
  // is written in pieces. The broker must drain the unsent tail on `drain`, or
  // the client's length-prefix decoder hangs forever waiting for the lost bytes.
  // This is the bug that left `history`/`tail` empty for any non-trivial log.
  test("a >8 KB history response is delivered whole, not truncated", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const body = "x".repeat(600); // ~30 of these clears the 8 KB watermark comfortably
    for (let i = 0; i < 30; i++) {
      await client.send({ from: "alice", to: "bob", kind: "inform", body: `${i}:${body}` });
    }
    const log = await client.history({});
    expect(log.messages.length).toBe(30);
    expect(log.messages.at(-1).body).toBe(`29:${body}`);
  });
});
