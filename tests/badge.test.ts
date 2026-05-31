import { describe, test, expect } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { readFileSync, rmSync } from "node:fs";
import { badgeTitle, BadgeNotifier, ttyBadgeSink, type BadgeSink } from "../src/badge.ts";
import { makeMessage } from "../src/models.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("badge formatting", () => {
  test("shows a count when there's mail, plain alias when empty", () => {
    expect(badgeTitle("backend", 0)).toBe("backend");
    expect(badgeTitle("backend", 3)).toBe("📨 3 · backend");
  });
});

describe("ttyBadgeSink", () => {
  test("writes the OSC-0 title escape (exercised against a real file)", () => {
    const path = `/tmp/cipc-badge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    ttyBadgeSink.write(path, "📨 2 · backend");
    expect(readFileSync(path, "utf8")).toBe("\x1b]0;📨 2 · backend\x07");
    rmSync(path, { force: true });
  });

  test("a bad path fails silently (best-effort, never throws)", () => {
    expect(() => ttyBadgeSink.write("/dev/does-not-exist/nope", "x")).not.toThrow();
  });
});

describe("BadgeNotifier", () => {
  function setup() {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const calls: { tty: string; title: string }[] = [];
    const sink: BadgeSink = { write: (tty, title) => calls.push({ tty, title }) };
    return { backend, registry, calls, sink };
  }

  test("writes the pending count to the peer's tty", () => {
    const { backend, registry, calls, sink } = setup();
    registry.register("bob", { sessionId: "sB", cwd: "/b", tty: "/dev/ttys009" });
    backend.append(makeMessage({ id: "m1", kind: "inform", fromAlias: "a", toAlias: "bob", ts: 1 }));
    backend.enqueue("m1", "bob");
    new BadgeNotifier(backend, registry, sink, true).update("bob");
    expect(calls).toEqual([{ tty: "/dev/ttys009", title: "📨 1 · bob" }]);
  });

  test("skips a peer that has no known tty", () => {
    const { backend, registry, calls, sink } = setup();
    registry.register("bob", { sessionId: "sB", cwd: "/b" });
    new BadgeNotifier(backend, registry, sink, true).update("bob");
    expect(calls).toEqual([]);
  });

  test("is a no-op when disabled", () => {
    const { backend, registry, calls, sink } = setup();
    registry.register("bob", { sessionId: "sB", cwd: "/b", tty: "/dev/ttys009" });
    new BadgeNotifier(backend, registry, sink, false).update("bob");
    expect(calls).toEqual([]);
  });
});

describe("router drives notify on inbox change", () => {
  test("a send to an alias notifies that alias (so its badge updates)", async () => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const notified: string[] = [];
    let idn = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null, (a) => notified.push(a));
    const broker = startBroker({ router, socketPath: tmpSock() });
    const client = new Client(broker.socketPath);
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "hi" });
    broker.stop();
    expect(notified).toContain("bob");
  });
});
