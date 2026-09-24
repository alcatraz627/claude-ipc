import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMessage } from "../src/models.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { monitorSnapshot } from "../src/monitor.ts";

const rnd = (): string => Math.random().toString(36).slice(2, 10);
const tmpSock = (): string => `/tmp/cipc-${process.pid}-${rnd()}.sock`;
const tmpDb = (): string => `/tmp/cipc-${process.pid}-${rnd()}.sqlite`;

function brokerOn(db: string, sock: string): { handle: BrokerHandle; backend: SqliteBackend; replayed: number } {
  const backend = new SqliteBackend(db);
  const replayed = backend.replayInflight().deliveries.length;
  const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
  let n = 0;
  const router = new Router(backend, registry, () => 1000, () => `msg-${++n}-${rnd()}`, 60);
  router.reconcilePendingOutbox();
  return { handle: startBroker({ router, socketPath: sock }), backend, replayed };
}

function cleanup(db: string): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      rmSync(db + ext);
    } catch {
      // not present
    }
  }
}

describe("resilience", () => {
  test("SC5: a degraded send persists and survives a broker restart with no loss", async () => {
    const db = tmpDb();
    const sock = tmpSock();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-resilience-"));

    let b = brokerOn(db, sock);
    const online = new Client(sock, undefined, tokens);
    await online.register("alice", { sessionId: "sA", cwd: "/a" });
    await online.register("bob", { sessionId: "sB", cwd: "/b" });
    await online.send({ from: "alice", to: "bob", kind: "inform", body: "before-crash" });
    b.handle.stop();
    b.backend.close();

    // broker down — the degraded client appends straight to the DB
    const degraded = new Client(sock, { dbPath: db }, tokens);
    const r = await degraded.send({ from: "alice", to: "bob", kind: "inform", body: "during-outage" });
    expect(r.daemonDown).toBe(true);

    // Restart on the same DB. Both deliveries are already readable; recovery
    // does not depend on alice returning to flush her own outbox.
    b = brokerOn(db, sock);
    expect(b.replayed).toBeGreaterThanOrEqual(1);
    const recovered = new Client(sock, undefined, tokens);
    const inbox = await new Client(sock, undefined, tokens).check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body).sort()).toEqual(["before-crash", "during-outage"]);
    b.handle.stop();
    b.backend.close();
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("a project host acknowledgement does not consume the shared mailbox", async () => {
    const db = tmpDb();
    const sock = tmpSock();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-project-host-"));
    const b = brokerOn(db, sock);
    const client = new Client(sock, undefined, tokens);
    await client.register("alice", { sessionId: "sA", cwd: "/sender" });
    await client.register("bob", { sessionId: "sB", cwd: "/repo" });
    await client.register("carol", { sessionId: "sC", cwd: "/repo" });
    const sent = await client.send({ from: "alice", to: "proj:/repo", kind: "request", body: "review" });
    const leased = await client.leaseProject("/repo", "bob", "lease-b");
    expect(leased.messages.map((m: { id: string }) => m.id)).toEqual([sent.msgId]);
    expect(await client.ackProject("/repo", "bob", "lease-b", [sent.msgId])).toEqual({ acknowledged: 1 });
    const stillShared = await client.checkProject("/repo", false, "carol");
    expect(stillShared.messages.map((m: { id: string }) => m.id)).toEqual([sent.msgId]);
    expect((await client.leaseProject("/repo", "bob", "lease-b2")).messages).toEqual([]);
    b.handle.stop();
    b.backend.close();
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("an offline broadcast retains fan-out and context until broker reconciliation", async () => {
    const db = tmpDb();
    const sock = tmpSock();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-broadcast-"));
    let b = brokerOn(db, sock);
    const online = new Client(sock, undefined, tokens);
    await online.register("alice", { sessionId: "sA", cwd: "/a" });
    await online.register("bob", { sessionId: "sB", cwd: "/b" });
    await online.register("carol", { sessionId: "sC", cwd: "/c" });
    b.handle.stop();
    b.backend.close();

    const degraded = new Client(sock, { dbPath: db }, tokens);
    const queued = await degraded.send({
      from: "alice",
      to: "*",
      kind: "query",
      body: "status?",
      replyByS: 90,
      ttlS: 300,
      contextPtr: { sessionId: "sA", transcriptPath: "/a/transcript", cwd: "/a" },
    });
    expect(queued).toMatchObject({ daemonDown: true, queued: true });

    const lateSeed = new SqliteBackend(db);
    new Registry(lateSeed, () => 1000, { idleS: 300, offlineS: 1800 }).register("late", { sessionId: "s-late", cwd: "/late" });
    lateSeed.close();

    b = brokerOn(db, sock);
    const recovered = new Client(sock, undefined, tokens);
    for (const recipient of ["bob", "carol"]) {
      const inbox = await recovered.check(recipient);
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]).toMatchObject({
        id: queued.msgId,
        body: "status?",
        ttlS: 300,
        contextPtr: { sessionId: "sA", transcriptPath: "/a/transcript", cwd: "/a" },
      });
    }
    expect(b.backend.pending("late")).toEqual([]);

    b.handle.stop();
    b.backend.close();
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("boot replay restores a pruned broadcast sender from its durable intent", async () => {
    const db = tmpDb();
    const backend = new SqliteBackend(db);
    backend.queueOutbound({
      operationId: "op-pruned-broadcast",
      fromAlias: "gone",
      args: {
        operationId: "op-pruned-broadcast",
        messageId: "msg-0123456789abcdef",
        from: "gone",
        to: "*",
        kind: "inform",
        body: "still fan out",
        contextPtr: { sessionId: "s-gone", transcriptPath: "/gone/log", cwd: "/gone" },
      },
      createdAt: 1,
    });
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    registry.register("bob", { sessionId: "s-bob", cwd: "/bob" });
    const router = new Router(backend, registry, () => 1000, () => "unused", 60);
    expect(router.reconcilePendingOutbox()).toEqual({ attempted: 1, remaining: 0 });
    expect(backend.pending("bob").map((item) => item.body)).toEqual(["still fan out"]);
    expect(registry.get("gone")).toBeNull();
    backend.close();
    cleanup(db);
  });

  test("degraded retry reuses an online send whose response was lost", () => {
    const dbPath = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-timeout-race-"));
    writeFileSync(join(tokens, "alice"), "test-token");
    const backend = new SqliteBackend(dbPath);
    const existing = makeMessage({
      id: "msg-fedcba9876543210",
      operationId: "op-timeout-race",
      kind: "inform",
      fromAlias: "alice",
      toAlias: "bob",
      body: "once",
      ts: 1,
    });
    backend.append(existing);
    backend.enqueue(existing.id, "bob");
    backend.close();
    const client = new Client("/tmp/unused", { dbPath }, tokens);
    const result = (client as unknown as { degraded(op: string, args: Record<string, unknown>): any }).degraded("send", {
      operationId: "op-timeout-race",
      from: "alice",
      to: "bob",
      kind: "inform",
      body: "once",
    });
    expect(result).toMatchObject({ msgId: existing.id, recipients: ["bob"], idempotentReplay: true });
    const check = new SqliteBackend(dbPath);
    expect(check.history({})).toHaveLength(1);
    expect(check.deliveriesFor(existing.id)).toHaveLength(1);
    check.close();
    cleanup(dbPath);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("outbox replay repairs a crash between message append and routing", () => {
    const backend = new SqliteBackend(":memory:");
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const token = registry.register("alice", { sessionId: "s-alice", cwd: "/a" }).token!;
    registry.register("bob", { sessionId: "s-bob", cwd: "/b" });
    const messageId = "msg-0123456789abcdef";
    backend.queueOutbound({
      operationId: "op-partial-send",
      fromAlias: "alice",
      args: { operationId: "op-partial-send", messageId, from: "alice", to: "bob", kind: "query", body: "survive" },
      createdAt: 1000,
    });
    backend.append(makeMessage({
      id: messageId,
      operationId: "op-partial-send",
      kind: "query",
      fromAlias: "alice",
      toAlias: "bob",
      body: "survive",
      conversationId: `conv-${messageId}`,
      ts: 1000,
    }));
    const router = new Router(backend, registry, () => 1000, () => "unused", 60);
    const replay = router.handle({ v: 1, op: "reconcile", args: { alias: "alice" }, token } as never) as any;
    expect(replay).toMatchObject({ ok: true, result: { remaining: 0 } });
    expect(backend.deliveriesFor(messageId).map((delivery) => delivery.toAlias)).toEqual(["bob"]);
    expect(backend.getAwaiting(messageId)).toMatchObject({ originId: messageId, closed: false });
    backend.close();
  });

  test("fallback-first and broker-late use one reserved message row and delivery", () => {
    const dbPath = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-fallback-first-"));
    let backend = new SqliteBackend(dbPath);
    let registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const aliceToken = registry.register("alice", { sessionId: "s-alice", cwd: "/a" }).token!;
    registry.register("bob", { sessionId: "s-bob", cwd: "/b" });
    writeFileSync(join(tokens, "alice"), aliceToken);
    backend.close();

    const operationId = "op-fallback-first";
    const messageId = `msg-${new Bun.CryptoHasher("sha256").update(operationId).digest("hex").slice(0, 16)}`;
    const client = new Client("/tmp/unused", { dbPath }, tokens);
    const degraded = (client as unknown as { degraded(op: string, args: Record<string, unknown>): any }).degraded("send", {
      operationId,
      messageId,
      from: "alice",
      to: "bob",
      kind: "query",
      body: "once under either ordering",
    });
    expect(degraded.msgId).toBe(messageId);

    backend = new SqliteBackend(dbPath);
    registry = new Registry(backend, () => 1001, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1001, () => "msg-should-not-be-used", 60);
    const late = router.handle({
      v: 1,
      op: "send",
      token: aliceToken,
      args: { operationId, messageId, from: "alice", to: "bob", kind: "query", body: "once under either ordering" },
    } as never) as { ok: boolean; result: { idempotentReplay: boolean; msgId: string } };
    expect(late).toMatchObject({ ok: true, result: { idempotentReplay: true, msgId: messageId } });
    expect(backend.history({})).toHaveLength(1);
    expect(backend.deliveriesFor(messageId)).toHaveLength(1);
    expect(backend.get(messageId)?.conversationId).toBe(`conv-${messageId}`);
    backend.close();
    cleanup(dbPath);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("degraded routing refuses unknown and same-session recipients", () => {
    const dbPath = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-degraded-policy-"));
    const backend = new SqliteBackend(dbPath);
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const token = registry.register("alice", { sessionId: "same", cwd: "/a" }).token!;
    registry.register("alice-sibling", { sessionId: "same", cwd: "/a" });
    writeFileSync(join(tokens, "alice"), token);
    backend.close();
    const client = new Client("/tmp/unused", { dbPath }, tokens) as unknown as {
      degraded(op: string, args: Record<string, unknown>): unknown;
    };
    expect(() => client.degraded("send", {
      operationId: "op-no-peer", from: "alice", to: "missing", kind: "inform", body: "x",
    })).toThrow("no_peer");
    expect(() => client.degraded("send", {
      operationId: "op-self", from: "alice", to: "alice-sibling", kind: "inform", body: "x",
    })).toThrow("self_send");
    const check = new SqliteBackend(dbPath);
    expect(check.history({})).toHaveLength(0);
    check.close();
    cleanup(dbPath);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("a host-persisted unanswered ask remains visible to orphan triage", () => {
    const backend = new SqliteBackend(":memory:");
    const registry = new Registry(backend, () => 2000, { idleS: 10, offlineS: 20 });
    const token = registry.register("dead", { sessionId: "s-dead", cwd: "/work" }).token!;
    registry.register("recipient", { sessionId: "s-recipient", cwd: "/work" });
    const router = new Router(backend, registry, () => 2000, () => "msg-1111111111111111", 60);
    const sent = router.handle({
      v: 1,
      op: "send",
      token,
      args: { operationId: "op-open", from: "dead", to: "recipient", kind: "query", body: "answer me" },
    } as never) as { ok: true; result: { msgId: string } };
    backend.leaseForDelivery("recipient", "channel", "lease-1", 2000, 2030);
    backend.ackDelivery("recipient", "lease-1", [sent.result.msgId]);
    registry.leave("recipient");
    expect(registry.pruneOffline(1)).toBe(0);
    expect(registry.get("recipient")?.cwd).toBe("/work");
    const rows = (router.handle({ v: 1, op: "orphans", args: { project: "/work" } } as never) as any).result.orphans;
    expect(rows.find((row: { alias: string }) => row.alias === "recipient")).toMatchObject({ pending: 1 });
    backend.close();
  });

  test("a degraded check reads pending straight from the DB while the broker is down", async () => {
    const db = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-degraded-check-"));
    writeFileSync(join(tokens, "bob"), "test-token");
    const seed = new SqliteBackend(db);
    seed.append(makeMessage({ id: "m1", kind: "inform", fromAlias: "a", toAlias: "bob", ts: 1, body: "queued-while-down" }));
    seed.enqueue("m1", "bob");
    seed.close();

    const degraded = new Client("/tmp/cipc-nonexistent.sock", { dbPath: db }, tokens);
    const inbox = await degraded.check("bob");
    expect(inbox.daemonDown).toBe(true);
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["queued-while-down"]);
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("a degraded project check reads the project mailbox", async () => {
    const db = tmpDb();
    const seed = new SqliteBackend(db);
    seed.append(makeMessage({ id: "project-msg", kind: "inform", fromAlias: "alice", toAlias: "proj:/work", ts: 1, body: "queued" }));
    seed.enqueue("project-msg", "proj:/work");
    seed.close();
    const degraded = new Client("/tmp/cipc-nonexistent.sock", { dbPath: db });
    const inbox = await degraded.checkProject("/work");
    expect(inbox).toMatchObject({ daemonDown: true });
    expect(inbox.messages.map((item: { id: string }) => item.id)).toEqual(["project-msg"]);
    cleanup(db);
  });

  test("a degraded project consume requires membership and cannot drain as an outsider", async () => {
    const db = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-degraded-project-auth-"));
    const seed = new SqliteBackend(db);
    const registry = new Registry(seed, () => 1, { idleS: 300, offlineS: 1800 });
    const outsiderToken = registry.register("outsider", { sessionId: "s-out", cwd: "/elsewhere" }).token!;
    writeFileSync(join(tokens, "outsider"), outsiderToken);
    seed.append(makeMessage({ id: "project-protected", kind: "inform", fromAlias: "alice", toAlias: "proj:/work", ts: 1, body: "queued" }));
    seed.enqueue("project-protected", "proj:/work");
    seed.close();

    const degraded = new Client("/tmp/cipc-nonexistent.sock", { dbPath: db }, tokens);
    await expect(degraded.checkProject("/work", true, "outsider")).rejects.toThrow("requires a member session");
    expect((await degraded.checkProject("/work")).messages.map((item: { id: string }) => item.id)).toEqual(["project-protected"]);
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("degraded project reads preserve lineage, claims, self-exclusion, and persisted asks", async () => {
    const db = tmpDb();
    const tokens = mkdtempSync(join(tmpdir(), "cipc-degraded-project-parity-"));
    const seed = new SqliteBackend(db);
    const registry = new Registry(seed, () => 1, { idleS: 300, offlineS: 1800 });
    const bobToken = registry.register("bob", { sessionId: "s-bob", cwd: "/work/sub" }).token!;
    registry.register("carol", { sessionId: "s-carol", cwd: "/work" });
    registry.register("alice", { sessionId: "s-alice", cwd: "/sender" });
    writeFileSync(join(tokens, "bob"), bobToken);
    const add = (id: string, from: string, to: string, kind: "inform" | "query" = "inform") => {
      seed.append(makeMessage({ id, kind, fromAlias: from, toAlias: to, ts: 1, body: id }));
      seed.enqueue(id, to);
    };
    add("ancestor", "alice", "proj:/work");
    add("descendant", "alice", "proj:/work/sub/deeper");
    add("claimed", "alice", "proj:/work", "query");
    seed.claimProject("claimed", "carol");
    add("self", "bob", "proj:/work");
    add("persisted", "alice", "proj:/work", "query");
    seed.openAwaiting("persisted", null);
    seed.leaseForDelivery("proj:/work", "channel", "lease", 1, 30);
    seed.ackDelivery("proj:/work", "lease", ["persisted"]);
    seed.close();

    const degraded = new Client("/tmp/cipc-nonexistent.sock", { dbPath: db }, tokens);
    const consumed = await degraded.checkProject("/work/sub", true, "bob");
    expect(consumed.messages.map((item: { id: string }) => item.id)).toEqual(["ancestor"]);
    const remaining = await degraded.checkProject("/work/sub", false, "bob");
    expect(remaining.messages.map((item: { id: string }) => item.id).sort()).toEqual(["descendant", "persisted"]);
    cleanup(db);
    rmSync(tokens, { recursive: true, force: true });
  });

  test("monitorSnapshot reports a down broker, then live peers when up", async () => {
    const db = tmpDb();
    const sock = tmpSock();
    expect(await monitorSnapshot(new Client(sock))).toContain("DOWN");
    const b = brokerOn(db, sock);
    await new Client(sock).register("frontend", { sessionId: "sF", cwd: "/f" });
    expect(await monitorSnapshot(new Client(sock))).toContain("frontend");
    b.handle.stop();
    b.backend.close();
    cleanup(db);
  });
});
