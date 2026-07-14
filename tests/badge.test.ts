import { describe, test, expect } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { readFileSync, rmSync } from "node:fs";
import { badgeTitle, BadgeNotifier, ttyBadgeSink, isTtyPath, oscTitle, type BadgeSink } from "../src/badge.ts";
import { makeMessage } from "../src/models.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("badge formatting", () => {
  test("shows a count when there's mail, plain alias when empty", () => {
    expect(badgeTitle("backend", 0)).toBe("backend");
    expect(badgeTitle("backend", 3)).toBe("📨 3 · backend");
  });
});

describe("ttyBadgeSink — target validation + escape safety (Tier-2 #11)", () => {
  test("only real terminal device paths are accepted as a write target", () => {
    expect(isTtyPath("/dev/ttys009")).toBe(true);
    expect(isTtyPath("/dev/tty")).toBe(true);
    expect(isTtyPath("/dev/pts/3")).toBe(true);
    // a crafted --tty must not turn the broker into a file-writer / injector
    expect(isTtyPath("/tmp/cipc-badge-x")).toBe(false);
    expect(isTtyPath("/etc/passwd")).toBe(false);
    expect(isTtyPath("/dev/../etc/passwd")).toBe(false);
    expect(isTtyPath("/dev/ttys009; rm -rf")).toBe(false);
  });

  test("the OSC title strips bytes that would break out of the sequence", () => {
    // an embedded BEL would end the title early; ESC + newline would run as commands
    expect(oscTitle("hi\x07\x1b]2;evil\x07there")).toBe("\x1b]0;hi]2;evilthere\x07");
    expect(oscTitle("📨 2 · backend")).toBe("\x1b]0;📨 2 · backend\x07"); // ordinary title untouched
  });

  test("a non-tty path is refused — nothing is opened or written", () => {
    const path = `/tmp/cipc-badge-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    ttyBadgeSink.write(path, "should not land here");
    expect(() => readFileSync(path, "utf8")).toThrow(); // the file was never created
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
