import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeMessage, type Message } from "../src/models.ts";
import type { StorageBackend } from "../src/storage/base.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";

let seq = 0;
/** Build a Message with sensible defaults; pass `over` to set what a test cares about. */
function m(id: string, over: Partial<Message> = {}): Message {
  return makeMessage({ id, kind: "inform", fromAlias: "a", toAlias: "b", ts: ++seq, ...over });
}

/** The same contract suite, run against every backend — parity from day one. */
function backendSuite(name: string, make: () => StorageBackend): void {
  describe(name, () => {
    let db: StorageBackend;
    beforeEach(() => {
      db = make();
    });
    afterEach(() => {
      db.close();
    });

    test("append is idempotent on id; get returns null for unknown", () => {
      db.append(m("m1", { body: "first" }));
      db.append(m("m1", { body: "second" }));
      expect(db.get("m1")?.body).toBe("first");
      expect(db.get("nope")).toBeNull();
    });

    test("delivery is per-recipient and independent (broadcast fan-out)", () => {
      db.append(m("b1", { ts: 1 }));
      db.enqueue("b1", "bob");
      db.enqueue("b1", "carol");
      expect(db.pending("bob").map((x) => x.id)).toEqual(["b1"]);
      expect(db.pending("carol").map((x) => x.id)).toEqual(["b1"]);
      expect(db.pending("dave")).toEqual([]);
      db.markConsumed("b1", "bob");
      expect(db.pending("bob")).toEqual([]);
      expect(db.pending("carol").map((x) => x.id)).toEqual(["b1"]); // carol unaffected
      expect(db.deliveriesFor("b1").length).toBe(2);
    });

    test("pending with consume removes from subsequent pending", () => {
      db.append(m("c1", { ts: 1 }));
      db.enqueue("c1", "bob");
      expect(db.pending("bob", { consume: true }).map((x) => x.id)).toEqual(["c1"]);
      expect(db.pending("bob")).toEqual([]);
    });

    test("markDelivered records the rung but stays actionable", () => {
      db.append(m("d1", { ts: 1 }));
      db.enqueue("d1", "bob");
      db.markDelivered("d1", "bob", "hook");
      const d = db.deliveriesFor("d1")[0];
      expect(d?.state).toBe("delivered");
      expect(d?.via).toBe("hook");
      expect(db.pending("bob").map((x) => x.id)).toEqual(["d1"]);
    });

    test("a request stays acceptable after being consumed (consume != consent)", () => {
      db.append(m("req1", { kind: "request", ts: 1 }));
      db.enqueue("req1", "bob");
      db.markConsumed("req1", "bob"); // recipient read it
      db.setConsent("req1", "bob", true); // ...then later accepts
      expect(db.deliveriesFor("req1")[0]?.state).toBe("accepted");
    });

    test("awaiting opens, expires only when past TTL, and closes", () => {
      db.openAwaiting("q1", 100);
      expect(db.isAwaitingOpen("q1")).toBe(true);
      expect(db.awaitingPastTtl(50)).toEqual([]);
      expect(db.awaitingPastTtl(150).map((a) => a.originId)).toEqual(["q1"]);
      db.closeAwaiting("q1", "responded");
      expect(db.isAwaitingOpen("q1")).toBe(false);
      expect(db.awaitingPastTtl(150)).toEqual([]);
    });

    test("a timed-out awaiting is closed, and its reason is readable", () => {
      db.openAwaiting("q2", 100);
      db.closeAwaiting("q2", "timeout");
      expect(db.isAwaitingOpen("q2")).toBe(false);
      expect(db.getAwaiting("q2")?.closedReason).toBe("timeout");
    });

    test("a no-deadline awaiting stays open and is never swept", () => {
      db.openAwaiting("nd1", null);
      expect(db.isAwaitingOpen("nd1")).toBe(true);
      expect(db.awaitingPastTtl(9_999_999_999)).toEqual([]); // null expiry → never returned
      expect(db.getAwaiting("nd1")?.expiresAt).toBeNull();
    });

    test("originOf resolves a correlation id to its message", () => {
      db.append(m("o1", { ts: 1 }));
      expect(db.originOf("o1")?.id).toBe("o1");
      expect(db.originOf("nope")).toBeNull();
    });

    test("registry snapshot round-trips", () => {
      const e = {
        alias: "frontend",
        sessionId: "s1",
        cwd: "/x",
        caps: ["fe", "next"],
        pid: 123,
        lastSeen: 5,
        status: "live" as const,
      };
      db.saveRegistry([e]);
      expect(db.loadRegistry()).toEqual([e]);
    });

    test("history filters by peer, since, and conversation, ordered by ts", () => {
      db.append(m("h1", { fromAlias: "A", toAlias: "B", ts: 10 }));
      db.append(m("h2", { fromAlias: "C", toAlias: "D", ts: 20 }));
      db.append(m("h3", { fromAlias: "C", toAlias: "E", ts: 30, conversationId: "X" }));
      expect(db.history({ peer: "A" }).map((x) => x.id)).toEqual(["h1"]);
      expect(db.history({ since: 20 }).map((x) => x.id)).toEqual(["h2", "h3"]);
      expect(db.history({ conversationId: "X" }).map((x) => x.id)).toEqual(["h3"]);
    });

    test("replayInflight rebuilds un-consumed deliveries + open awaiting", () => {
      db.append(m("r1", { ts: 1 }));
      db.enqueue("r1", "bob"); // queued → replayed
      db.append(m("r2", { ts: 2 }));
      db.enqueue("r2", "carol");
      db.markConsumed("r2", "carol"); // consumed → excluded
      db.openAwaiting("aw1", 100); // open → replayed
      db.openAwaiting("aw2", 100);
      db.closeAwaiting("aw2", "responded"); // closed → excluded
      const { deliveries, awaiting } = db.replayInflight();
      expect(deliveries.map((d) => d.msgId)).toEqual(["r1"]);
      expect(awaiting.map((a) => a.originId)).toEqual(["aw1"]);
    });
  });
}

backendSuite("MemoryBackend", () => new MemoryBackend());
backendSuite("SqliteBackend", () => new SqliteBackend(":memory:"));
