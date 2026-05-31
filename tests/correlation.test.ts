import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { tickSweeper } from "../src/broker/sweeper.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import type { StorageBackend } from "../src/storage/base.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("correlation, consent, timeouts", () => {
  let broker: BrokerHandle;
  let client: Client;
  let backend: StorageBackend;
  let clock = 1000;
  let idn = 0;
  const mkId = (): string => `msg-${++idn}`;

  beforeEach(async () => {
    clock = 1000;
    idn = 0;
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => clock, mkId, 60); // 60s default TTL
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
  });
  afterEach(() => broker.stop());

  test("a query and its reply share an auto-generated conversationId thread", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    expect(q.conversationId).toBe(`conv-${q.msgId}`); // the query opens a thread
    await client.reply({ from: "bob", corrId: q.msgId, body: "yes" });
    const thread = await client.history({ conversationId: q.conversationId });
    expect(thread.messages.length).toBe(2); // query + response, one thread
    expect(thread.messages.every((m: { conversationId: string }) => m.conversationId === q.conversationId)).toBe(true);
  });

  test("a bare inform is not threaded (no conversationId)", async () => {
    const i = await client.send({ from: "alice", to: "bob", kind: "inform", body: "fyi" });
    expect(i.conversationId).toBeNull();
  });

  test("query → reply correlates back to the sender's inbox", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "base url?" });
    await client.reply({ from: "bob", corrId: q.msgId, body: "http://api.localhost:3000" });
    const inbox = await client.check("alice");
    expect(inbox.messages.length).toBe(1);
    const r = inbox.messages[0];
    expect(r.kind).toBe("response");
    expect(r.corrId).toBe(q.msgId);
    expect(r.status).toBe("ok");
    expect(r.body).toBe("http://api.localhost:3000");
  });

  test("awaitReply resolves with the correlated response", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await client.reply({ from: "bob", corrId: q.msgId, body: "answer" });
    const r = await client.awaitReply("alice", q.msgId, 1000);
    expect(r?.body).toBe("answer");
  });

  test("request → accept → terminal result", async () => {
    const req = await client.send({ from: "alice", to: "bob", kind: "request", body: "run typecheck" });
    await client.accept("bob", req.msgId);
    expect(backend.deliveriesFor(req.msgId)[0]?.state).toBe("accepted");
    await client.reply({ from: "bob", corrId: req.msgId, body: "0 errors" });
    const inbox = await client.check("alice");
    expect(inbox.messages.map((m: { status: string; body: string }) => [m.status, m.body])).toEqual([
      ["ok", "0 errors"],
    ]);
  });

  test("an interim (non-terminal) reply delivers but does NOT close the awaiting", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "request", body: "build", ttlS: 60 });
    await client.reply({ from: "bob", corrId: q.msgId, body: "accepted, running", terminal: false });
    expect(backend.isAwaitingOpen(q.msgId)).toBe(true); // ack/progress keeps it open
    await client.reply({ from: "bob", corrId: q.msgId, body: "done" }); // terminal
    expect(backend.isAwaitingOpen(q.msgId)).toBe(false);
    const inbox = await client.check("alice");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["accepted, running", "done"]);
  });

  test("request → decline → error{declined} reaches the sender", async () => {
    const req = await client.send({ from: "alice", to: "bob", kind: "request", body: "rm -rf /" });
    await client.decline("bob", req.msgId, "nope");
    expect(backend.deliveriesFor(req.msgId)[0]?.state).toBe("declined");
    const r = (await client.check("alice")).messages[0];
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("declined");
  });

  test("sweeper times out an unanswered query and closes the awaiting", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" }); // expires at 1060
    expect(backend.isAwaitingOpen(q.msgId)).toBe(true);
    clock = 1100;
    expect(tickSweeper(backend, () => clock, mkId)).toBe(1);
    expect(backend.isAwaitingOpen(q.msgId)).toBe(false);
    const r = (await client.check("alice")).messages[0];
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("timeout");
    expect(r.corrId).toBe(q.msgId);
  });

  test("a late reply (after a timeout fired) still delivers — the real answer wins", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?", ttlS: 60 });
    clock = 1100;
    tickSweeper(backend, () => clock, mkId); // timeout synthesized at +60
    const late = await client.reply({ from: "bob", corrId: q.msgId, body: "actually, here it is" });
    expect(late.dropped).toBeUndefined();
    expect(late.late).toBe(true);
    const inbox = await client.check("alice");
    // both the provisional timeout AND the real late answer are present
    expect(inbox.messages.length).toBe(2);
    expect(inbox.messages.some((m: { body: string }) => m.body === "actually, here it is")).toBe(true);
  });

  test("a reply after the sender cancelled is dropped", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await client.cancel(q.msgId, "alice"); // alice cancels her own ask
    const r = await client.reply({ from: "bob", corrId: q.msgId, body: "nvm" });
    expect(r.dropped).toBe(true);
    expect(r.reason).toBe("cancelled");
    expect((await client.check("alice")).messages.length).toBe(0);
  });

  test("a query with no TTL is never auto-timed-out", async () => {
    const q = await client.send({ from: "alice", to: "bob", kind: "query", body: "no deadline", ttlS: undefined });
    // router default ttl in this suite is 60, so pass an explicit null-equivalent: send with a huge ttl is finite;
    // instead assert directly at the storage layer that a null-deadline awaiting is never swept.
    backend.openAwaiting("manual-no-ttl", null);
    clock = 9_999_999;
    expect(tickSweeper(backend, () => clock, mkId)).toBe(1); // only q (ttl 60) expires; the null one does not
    expect(backend.isAwaitingOpen("manual-no-ttl")).toBe(true);
    expect(backend.getAwaiting(q.msgId)?.closed).toBe(true);
  });
});
