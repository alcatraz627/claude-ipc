import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { makeMessage, type Message } from "../src/models.ts";
import type { StorageBackend } from "../src/storage/base.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    test("operation ids resolve the original immutable message", () => {
      db.append(m("op-1", { operationId: "send-abc", body: "once" }));
      expect(db.getByOperationId("send-abc")?.id).toBe("op-1");
      expect(db.getByOperationId("unknown")).toBeNull();
    });

    test("route snapshots preserve empty and populated recipient sets", () => {
      db.saveRoute("empty", []);
      db.saveRoute("fanout", ["bob", "carol"]);
      db.saveRoute("fanout", ["late"]);
      expect(db.routeFor("missing")).toBeNull();
      expect(db.routeFor("empty")).toEqual([]);
      expect(db.routeFor("fanout")).toEqual(["bob", "carol"]);
    });

    test("offline send intents retain complete arguments and delete by operation id", () => {
      db.queueOutbound({
        operationId: "offline-1",
        fromAlias: "alice",
        args: { from: "alice", to: "*", kind: "query", body: "status?", replyByS: 90, ttlS: 300 },
        createdAt: 12,
      });
      db.queueOutbound({
        operationId: "offline-1",
        fromAlias: "alice",
        args: { body: "replacement must not win" },
        createdAt: 13,
      });
      expect(db.pendingOutbound("alice")).toEqual([
        expect.objectContaining({ operationId: "offline-1", args: expect.objectContaining({ to: "*", replyByS: 90 }) }),
      ]);
      db.deleteOutbound("offline-1");
      expect(db.pendingOutbound("alice")).toEqual([]);
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

    test("markSurfaced defers without losing: still pending, never resurrects settled", () => {
      db.append(m("s1", { ts: 1 }));
      db.enqueue("s1", "bob");
      db.markDelivered("s1", "bob", "hook");
      db.markSurfaced("s1", "bob");
      expect(db.deliveriesFor("s1")[0]?.state).toBe("surfaced");
      expect(db.pending("bob").map((x) => x.id)).toEqual(["s1"]); // still owed
      expect(db.pending("bob", { consume: true }).map((x) => x.id)).toEqual(["s1"]); // consumable later
      expect(db.pending("bob")).toEqual([]);
      db.markSurfaced("s1", "bob"); // snooze after consume must not resurrect
      expect(db.deliveriesFor("s1")[0]?.state).toBe("consumed");
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

    test("claimForDelivery is atomic: a second claim returns nothing (no double-delivery)", () => {
      db.append(m("k1", { ts: 1 }));
      db.append(m("k2", { ts: 2 }));
      db.enqueue("k1", "bob");
      db.enqueue("k2", "bob");
      const first = db.claimForDelivery("bob", "hook");
      expect(first.map((x) => x.id)).toEqual(["k1", "k2"]); // ts-ordered, both claimed
      expect(db.claimForDelivery("bob", "hook")).toEqual([]); // already claimed → empty
      expect(db.deliveriesFor("k1")[0]?.via).toBe("hook");
    });

    test("delivery leases retry after expiry and settle only on matching ack", () => {
      db.append(m("lease-1", { ts: 1 }));
      db.enqueue("lease-1", "bob");
      const future = Date.now() / 1000 + 60;
      const now = Date.now() / 1000;
      expect(db.leaseForDelivery("bob", "channel", "lease-a", now, future).map((x) => x.id)).toEqual(["lease-1"]);
      expect(db.leaseForDelivery("bob", "channel", "lease-b", now, future)).toEqual([]);
      expect(db.ackDelivery("bob", "wrong", ["lease-1"])).toBe(0);
      expect(db.pending("bob").map((x) => x.id)).toEqual(["lease-1"]);
      expect(db.ackDelivery("bob", "lease-a", ["lease-1"])).toBe(1);
      expect(db.pending("bob")).toEqual([]);
      expect(db.deliveriesFor("lease-1")[0]?.state).toBe("persisted");
      expect(db.markSurfaced("lease-1", "bob")).toBe(true);
      expect(db.pending("bob").map((x) => x.id)).toEqual(["lease-1"]);
      expect(db.leaseForDelivery("bob", "channel", "lease-c", now, future)).toEqual([]);

      db.append(m("lease-2", { ts: 2 }));
      db.enqueue("lease-2", "bob");
      expect(db.leaseForDelivery("bob", "channel", "expired", now, 0).map((x) => x.id)).toEqual(["lease-2"]);
      expect(db.leaseForDelivery("bob", "channel", "retry", now, future).map((x) => x.id)).toEqual(["lease-2"]);
    });

    test("snoozing a leased delivery invalidates that lease", () => {
      db.append(m("lease-snoozed", { kind: "query", ts: 1 }));
      db.enqueue("lease-snoozed", "bob");
      expect(db.leaseForDelivery("bob", "channel", "lease-a", 100, 200).map((x) => x.id)).toEqual(["lease-snoozed"]);
      expect(db.markSurfaced("lease-snoozed", "bob")).toBe(true);
      expect(db.ackDelivery("bob", "lease-a", ["lease-snoozed"])).toBe(0);
      expect(db.deliveriesFor("lease-snoozed")[0]?.state).toBe("surfaced");
    });

    test("an ack cannot overwrite a delivery settled while its lease was open", () => {
      db.append(m("lease-settled", { ts: 1 }));
      db.enqueue("lease-settled", "bob");
      db.leaseForDelivery("bob", "channel", "lease-a", 100, 200);
      db.markConsumed("lease-settled", "bob");
      expect(db.ackDelivery("bob", "lease-a", ["lease-settled"])).toBe(0);
      expect(db.deliveriesFor("lease-settled")[0]?.state).toBe("consumed");
    });

    test("purge removes old settled messages but keeps pending and awaited ones", () => {
      db.append(m("old1", { ts: 10 })); // old + consumed → purgeable
      db.saveRoute("old1", ["bob"]);
      db.enqueue("old1", "bob");
      db.markConsumed("old1", "bob");
      db.append(m("old2", { ts: 10 })); // old + still queued → kept (actionable)
      db.enqueue("old2", "bob");
      db.append(m("old3", { kind: "query", ts: 10 })); // old + open awaiting → kept
      db.openAwaiting("old3", null);
      db.append(m("recent", { ts: 100 })); // settled but too new → kept
      db.enqueue("recent", "bob");
      db.markConsumed("recent", "bob");

      expect(db.purge(50)).toBe(1); // cutoff ts=50 → only old1 qualifies
      expect(db.get("old1")).toBeNull();
      expect(db.routeFor("old1")).toBeNull();
      expect(db.get("old2")).not.toBeNull();
      expect(db.get("old3")).not.toBeNull();
      expect(db.get("recent")).not.toBeNull();
    });

    test("tombstoneStale retires messages left undelivered past the window", () => {
      db.append(m("stale", { ts: 10 })); // old + still queued to a gone inbox
      db.enqueue("stale", "ghost");
      db.append(m("fresh", { ts: 100 })); // queued but within the window
      db.enqueue("fresh", "ghost");

      // cutoff ts=50: only "stale" is old enough
      expect(db.tombstoneStale(50)).toBe(1);
      // the stale one left the inbox (no longer pending); the fresh one stayed
      expect(db.pending("ghost").map((x) => x.id).sort()).toEqual(["fresh"]);
      // and having settled, a purge at the same cutoff now deletes it
      expect(db.purge(50)).toBe(1);
      expect(db.get("stale")).toBeNull();
      expect(db.get("fresh")).not.toBeNull();
      // asserts nothing about the recipient: an already-consumed row is untouched
      expect(db.tombstoneStale(50)).toBe(0);
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

    test("originOf resolves a query/request correlation id; not an inform or response", () => {
      db.append(m("o1", { kind: "query", ts: 1 }));
      expect(db.originOf("o1")?.id).toBe("o1");
      db.append(m("inf1", { kind: "inform", ts: 2 })); // informs don't open a correlation
      expect(db.originOf("inf1")).toBeNull();
      expect(db.originOf("nope")).toBeNull();
    });

    test("registry snapshot round-trips", () => {
      const e = {
        alias: "frontend",
        sessionId: "s1",
        cwd: "/x",
        caps: ["fe", "next"],
        pid: 123,
        tty: "/dev/ttys003",
        lastSeen: 5,
        status: "live" as const,
        token: "tok-abc",
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

    // D2 — a later message can be recorded as superseding an earlier one, so a
    // successor triaging inherited mail can fold the countermanded arc.
    test("supersession is recorded and read back; unset reads null; survives nothing extra", () => {
      db.append(m("old-1"));
      db.append(m("new-1"));
      expect(db.supersededBy("old-1")).toBeNull();
      db.markSuperseded("old-1", "new-1");
      expect(db.supersededBy("old-1")).toBe("new-1");
      expect(db.supersededBy("new-1")).toBeNull(); // the superseding message is not itself superseded
    });

    // P3b — the event cursor: seqs move on pending-set MEMBERSHIP changes only.
    test("event seq: enqueue and consume bump it; delivered/surfaced shuffles don't", () => {
      expect(db.lastEventSeq(["bob"])).toBe(0); // nothing ever happened — honestly 0
      db.append(m("e1", { ts: 1 }));
      db.enqueue("e1", "bob");
      const s1 = db.lastEventSeq(["bob"]);
      expect(s1).toBeGreaterThan(0);
      db.enqueue("e1", "bob"); // idempotent re-enqueue is not an event
      expect(db.lastEventSeq(["bob"])).toBe(s1);
      db.markDelivered("e1", "bob", "hook"); // still pending — not an event
      db.markSurfaced("e1", "bob"); // still pending — not an event
      expect(db.lastEventSeq(["bob"])).toBe(s1);
      db.markConsumed("e1", "bob"); // leaves the pending set — an event
      const s2 = db.lastEventSeq(["bob"]);
      expect(s2).toBeGreaterThan(s1);
      db.markConsumed("e1", "bob"); // consuming a settled row again is not an event
      expect(db.lastEventSeq(["bob"])).toBe(s2);
    });

    test("event seq: consent (accept/decline) bumps; per-address isolation holds", () => {
      db.append(m("e2", { ts: 1 }));
      db.enqueue("e2", "bob");
      db.enqueue("e2", "carol");
      const bob = db.lastEventSeq(["bob"]);
      db.setConsent("e2", "bob", true);
      expect(db.lastEventSeq(["bob"])).toBeGreaterThan(bob);
      const carol = db.lastEventSeq(["carol"]);
      db.pending("carol", { consume: true }); // bulk consume bumps carol only
      expect(db.lastEventSeq(["carol"])).toBeGreaterThan(carol);
      expect(db.lastEventSeq(["dave"])).toBe(0); // an untouched address stays 0
    });
  });
}

backendSuite("MemoryBackend", () => new MemoryBackend());
backendSuite("SqliteBackend", () => new SqliteBackend(":memory:"));

test("SqliteBackend migrates a pre-Codex-host database in place", () => {
  const path = join(tmpdir(), `cipc-legacy-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, kind TEXT, from_alias TEXT, to_alias TEXT, body TEXT,
      conversation_id TEXT, corr_id TEXT, status TEXT, error_code TEXT,
      terminal INTEGER, op TEXT, context_ptr TEXT, ttl_s INTEGER, ts REAL);
    CREATE TABLE deliveries (
      msg_id TEXT, to_alias TEXT, via TEXT, state TEXT, ts REAL,
      PRIMARY KEY (msg_id, to_alias));
    INSERT INTO messages VALUES
      ('legacy-row','inform','alice','bob','before migration',NULL,NULL,NULL,NULL,1,NULL,NULL,NULL,1);
    INSERT INTO deliveries VALUES ('legacy-row','bob',NULL,'queued',1);
  `);
  legacy.close();
  const migrated = new SqliteBackend(path);
  migrated.append(m("migrated", { operationId: "migration-op" }));
  migrated.enqueue("migrated", "bob");
  expect(migrated.getByOperationId("migration-op")?.id).toBe("migrated");
  expect(migrated.get("legacy-row")?.body).toBe("before migration");
  expect(migrated.leaseForDelivery("bob", "channel", "lease", 1, 30).map((message) => message.id)).toEqual([
    "legacy-row",
    "migrated",
  ]);
  migrated.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(path + suffix);
    } catch {
      // absent
    }
  }
});
