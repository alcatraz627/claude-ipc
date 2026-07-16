/**
 * Piped CLI output must arrive complete however large. Two guards, because the
 * truncation is a nondeterministic exit-flush race no behavioral test can
 * reliably reproduce — so the behavioral test proves the fix works, and a
 * structural guard is the deterministic tripwire for a reintroduced
 * process.exit or unbuffered out(). See the regression test's own note.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const sock = `/tmp/cipc-pd-${process.pid}.sock`;

describe("piped output drains completely", () => {
  let broker: BrokerHandle;

  beforeAll(async () => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    let idn = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    broker = startBroker({ router, socketPath: sock });
    const c = new Client(sock);
    await c.register("pd-a", { sessionId: "sid-pd-a", cwd: "/a" });
    await c.register("pd-b", { sessionId: "sid-pd-b", cwd: "/b" });
    const chunk = "x".repeat(8000);
    for (let i = 0; i < 30; i++) await c.send({ from: "pd-a", to: "pd-b", kind: "inform", body: `${i}:${chunk}` });
  });
  afterAll(() => broker.stop());

  test("a >64KB payload arrives complete and byte-exact through a real pipe", async () => {
    const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/cli.ts`, "log", "--operator"], {
      env: { ...process.env, CLAUDE_IPC_SOCKET: sock },
      stdout: "pipe",
      stderr: "ignore",
    });
    const raw = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(raw.length).toBeGreaterThan(196_608); // >3 pipe buffers — genuinely past the cliff
    expect(raw.trimEnd().endsWith("}")).toBe(true); // the tail arrived, not just a parseable prefix
    expect((JSON.parse(raw) as { messages: unknown[] }).messages.length).toBe(30); // every message
  }, 30_000);

  // The deterministic regression tripwire the behavioral test structurally can't
  // be. The bug is exactly two shapes: a bare process.exit(code) at the entry
  // (drops the unflushed write queue), or an out() that sends a large payload
  // through console.log (no flush handle). Assert the source has neither.
  test("the entry point never hard-exits, and out() routes large payloads through a drainable write", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    const tail = src.slice(src.indexOf("if (import.meta.main)"));
    expect(tail).not.toMatch(/process\.exit\(code\)/); // the reintroduced-truncation shape
    expect(tail).toContain("stdoutDrain"); // the entry awaits the flush
    expect(src).toContain("process.stdout.write"); // out() has a real flush path for big payloads
  });
});
