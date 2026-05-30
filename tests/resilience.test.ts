import { describe, test, expect } from "bun:test";
import { rmSync } from "node:fs";
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

    let b = brokerOn(db, sock);
    const online = new Client(sock);
    await online.register("bob", { sessionId: "sB", cwd: "/b" });
    await online.send({ from: "alice", to: "bob", kind: "inform", body: "before-crash" });
    b.handle.stop();
    b.backend.close();

    // broker down — the degraded client appends straight to the DB
    const degraded = new Client(sock, { dbPath: db });
    const r = await degraded.send({ from: "alice", to: "bob", kind: "inform", body: "during-outage" });
    expect(r.daemonDown).toBe(true);

    // restart on the same DB; replay must see both queued deliveries
    b = brokerOn(db, sock);
    expect(b.replayed).toBeGreaterThanOrEqual(2);

    const inbox = await new Client(sock).check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body).sort()).toEqual(["before-crash", "during-outage"]);
    b.handle.stop();
    b.backend.close();
    cleanup(db);
  });

  test("a degraded check reads pending straight from the DB while the broker is down", async () => {
    const db = tmpDb();
    const seed = new SqliteBackend(db);
    seed.append(makeMessage({ id: "m1", kind: "inform", fromAlias: "a", toAlias: "bob", ts: 1, body: "queued-while-down" }));
    seed.enqueue("m1", "bob");
    seed.close();

    const degraded = new Client("/tmp/cipc-nonexistent.sock", { dbPath: db });
    const inbox = await degraded.check("bob");
    expect(inbox.daemonDown).toBe(true);
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["queued-while-down"]);
    cleanup(db);
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
