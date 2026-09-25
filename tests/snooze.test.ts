import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const tmpTokens = (): string => mkdtempSync(join(tmpdir(), "cipc-tok-"));

// Snooze is the non-destructive deferral: the recipient marks a message
// seen-and-deferred (`surfaced`) instead of consuming it, so the obligation
// stays in the inbox, the count, and the turn-end reminder.
describe("snooze (surfaced delivery state)", () => {
  let broker: BrokerHandle;
  let backend: MemoryBackend;
  let owner: Client;
  let attacker: Client;

  beforeEach(() => {
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    owner = new Client(broker.socketPath, undefined, tmpTokens());
    attacker = new Client(broker.socketPath, undefined, tmpTokens());
  });
  afterEach(() => broker.stop());

  test("snoozed message stays pending, counted, and consumable later", async () => {
    await owner.register("alice", { sessionId: "sA", cwd: "/a" });
    await owner.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await owner.send({ from: "alice", to: "bob", kind: "query", body: "later?" });

    const res = await owner.snooze("bob", sent.msgId);
    expect(res.surfaced).toBe(true);
    expect(backend.deliveriesFor(sent.msgId)[0]?.state).toBe("surfaced");

    const inbox = await owner.check("bob");
    expect(inbox.messages.map((x: { id: string }) => x.id)).toEqual([sent.msgId]); // still owed
    expect((await owner.count("bob")).count).toBe(1);

    await owner.check("bob", true); // consume works as before
    expect((await owner.count("bob")).count).toBe(0);
  });

  test("snooze refuses a consumed delivery instead of reporting a false success", async () => {
    await owner.register("alice", { sessionId: "sA", cwd: "/a" });
    await owner.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await owner.send({ from: "alice", to: "bob", kind: "inform", body: "fyi" });
    await owner.check("bob", true);
    await expect(owner.snooze("bob", sent.msgId)).rejects.toThrow(/invalid_state/);
    expect(backend.deliveriesFor(sent.msgId)[0]?.state).toBe("consumed");
    expect((await owner.count("bob")).count).toBe(0);
  });

  test("snooze returns host-persisted mail to the owed set without auto-leasing it again", async () => {
    await owner.register("alice", { sessionId: "sA", cwd: "/a" });
    await owner.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await owner.send({ from: "alice", to: "bob", kind: "query", body: "later?" });
    backend.leaseForDelivery("bob", "channel", "host-lease", 1000, 1300);
    expect(backend.ackDelivery("bob", "host-lease", [sent.msgId])).toBe(1);

    expect((await owner.check("bob")).messages.map((x: { id: string }) => x.id)).toEqual([sent.msgId]);
    expect((await owner.count("bob")).count).toBe(1);

    expect((await owner.snooze("bob", sent.msgId)).surfaced).toBe(true);
    expect(backend.pending("bob").map((x) => x.id)).toEqual([sent.msgId]);
    expect(backend.leaseForDelivery("bob", "channel", "next-host", 1001, 1301)).toEqual([]);
  });

  test("host-persisted asks stay in obligation views until the reply settles them", async () => {
    await owner.register("alice", { sessionId: "sA", cwd: "/a" });
    await owner.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await owner.send({ from: "alice", to: "bob", kind: "query", body: "answer?" });
    backend.leaseForDelivery("bob", "channel", "host-lease", 1000, 1300);
    expect(backend.ackDelivery("bob", "host-lease", [sent.msgId])).toBe(1);

    expect((await owner.count("bob")).count).toBe(1);
    expect((await owner.check("bob")).messages.map((item: { id: string }) => item.id)).toEqual([sent.msgId]);
    expect((await owner.digest("/b")).sessions.sB.owed.map((item: { corr_id: string }) => item.corr_id)).toEqual([sent.msgId]);

    await owner.reply({ from: "bob", corrId: sent.msgId, body: "done", terminal: true });
    expect((await owner.count("bob")).count).toBe(0);
    expect((await owner.check("bob")).messages).toEqual([]);
    expect((await owner.digest("/b")).sessions.sB.owed).toEqual([]);
  });

  test("only the recipient may snooze its own delivery", async () => {
    await owner.register("alice", { sessionId: "sA", cwd: "/a" });
    await owner.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await owner.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await expect(attacker.snooze("bob", sent.msgId)).rejects.toThrow(/unauthorized/);
  });
});
