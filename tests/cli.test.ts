import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { run } from "../src/cli.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("CLI", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  const origLog = console.log;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    console.log = (...a: unknown[]): void => {
      lines.push(a.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = origLog;
    broker.stop();
  });

  test("daemon status reports the broker up", async () => {
    expect(await run(["daemon", "status"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("up");
  });

  test("send without --to fails with exit code 2", async () => {
    expect(await run(["send", "hello"], { socketPath: sock })).toBe(2);
  });

  test("peers lists a registered alias", async () => {
    await new Client(sock).register("alice", { sessionId: "sA", cwd: "/a" });
    expect(await run(["peers"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("alice");
  });

  test("send then inbox round-trips a message", async () => {
    await new Client(sock).register("bob", { sessionId: "sB", cwd: "/b" });
    await run(["send", "--from", "alice", "--to", "bob", "--kind", "inform", "hi", "there"], { socketPath: sock });
    lines = [];
    expect(await run(["inbox", "bob"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("hi there");
  });
});
