import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { sweepGhosts } from "../src/broker/sweeper.ts";
import { Client } from "../src/client.ts";
import { makeMessage } from "../src/models.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const mkId = (() => {
  let n = 0;
  return () => `msg-g${++n}`;
})();

// Seed a directed request from alice to bob at t=1000 with an open awaiting.
function seedAsk(backend: MemoryBackend, kind: "request" | "query" = "request", delivered = false): void {
  const m = makeMessage({ id: "ask-1", kind, fromAlias: "alice", toAlias: "bob", ts: 1000, body: "run the migration" });
  backend.append(m);
  backend.enqueue(m.id, "bob");
  if (delivered) backend.claimForDelivery("bob", "hook"); // bob saw it, then went dark
  backend.openAwaiting(m.id, null); // no ttl — only a ghost can close it
}

// The sweeper now PARKS rather than ghost-errors: a non-error notice whose body
// starts "parked", corrId'd to the ask.
const parkNoticeTo = (backend: MemoryBackend, alias: string) =>
  backend.pending(alias).find((m) => m.kind === "response" && (m.body ?? "").startsWith("parked"));

describe("P1 · ghost → PARK escalation (V5)", () => {
  test("undelivered ask + recipient offline past grace → sender gets a PARK notice, not an error", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, "request", false);
    const fired = sweepGhosts(backend, (a) => a === "bob", () => 2000, mkId, 100); // 2000-1000 ≥ 100
    expect(fired).toBe(1);
    const notice = parkNoticeTo(backend, "alice");
    expect(notice?.corrId).toBe("ask-1");
    expect(notice?.status).toBe("ok"); // parked is NOT a failure
    expect(notice?.errorCode).toBeNull();
    expect(notice?.body).toContain("went offline before"); // never-delivered wording
    expect(backend.getAwaiting("ask-1")?.closedReason).toBe("parked");
  });

  test("delivered-but-unanswered ask + recipient offline → 'saw it' wording, parked", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, "request", true); // bob drained it, then went offline
    expect(sweepGhosts(backend, () => true, () => 2000, mkId, 100)).toBe(1);
    expect(parkNoticeTo(backend, "alice")?.body).toContain("saw your request");
  });

  test("within the grace window → no escalation yet (offline-queued mail keeps its chance)", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, "request", false);
    expect(sweepGhosts(backend, () => true, () => 1050, mkId, 100)).toBe(0); // 1050-1000 < 100
    expect(backend.getAwaiting("ask-1")?.closed).toBe(false);
  });

  test("recipient still reachable → no escalation", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, "query", false);
    expect(sweepGhosts(backend, () => false, () => 9999, mkId, 100)).toBe(0);
  });

  test("a ghosted ask fires exactly once (a second sweep is a no-op)", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, "request", false);
    expect(sweepGhosts(backend, () => true, () => 2000, mkId, 100)).toBe(1);
    expect(sweepGhosts(backend, () => true, () => 3000, mkId, 100)).toBe(0); // already closed
  });
});

describe("P1 · a genuine late reply still delivers after a ghost (V5)", () => {
  let broker: BrokerHandle;
  let backend: MemoryBackend;
  let registry: Registry;
  let clock = 1000;
  let idn = 0;

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    backend = new MemoryBackend();
    registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => clock, () => `msg-${++idn}`);
    broker = startBroker({ router, socketPath: tmpSock() });
  });
  afterEach(() => broker.stop());

  test("bob goes dark → alice gets a PARK notice → bob returns and replies late → alice gets that too", async () => {
    const client = new Client(broker.socketPath);
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await client.send({ from: "alice", to: "bob", kind: "request", body: "reset the test db" });

    clock += 5000; // bob's heartbeat ages past offlineS=1800 → registry marks him offline
    const isDark = (a: string): boolean => {
      const e = registry.get(a);
      return !e || e.status === "offline";
    };
    expect(sweepGhosts(backend, isDark, () => clock, () => `msg-${++idn}`, 300)).toBe(1);

    type Msg = { errorCode?: string | null; status?: string; corrId?: string; body?: string };
    let inbox = (await client.check("alice")).messages as Msg[];
    // The park notice: a non-error response corr'd to the ask, body starting "parked".
    expect(inbox.some((m) => (m.body ?? "").startsWith("parked") && m.corrId === q.msgId)).toBe(true);

    // bob comes back and answers the ask the sweeper had parked.
    await client.register("bob", { sessionId: "sB2", cwd: "/b" });
    const r = await client.reply({ from: "bob", corrId: q.msgId, body: "done, db reset" });
    expect(r.late).toBe(true); // delivered, flagged late — NOT dropped
    inbox = (await client.check("alice")).messages as Msg[];
    expect(inbox.some((m) => m.body === "done, db reset")).toBe(true);
  });
});
