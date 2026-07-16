/**
 * Piped CLI output must arrive complete however large — the truncation this
 * guards was NONDETERMINISTIC (a "verified" one-run fix was falsified on the
 * next run), so this drives the real layer: a subprocess writing JSON through
 * a real pipe, several times, and every byte must parse.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
    // enough body to push the JSON well past one 64KB pipe buffer
    const chunk = "x".repeat(8000);
    for (let i = 0; i < 12; i++) await c.send({ from: "pd-a", to: "pd-b", kind: "inform", body: `${i}:${chunk}` });
  });
  afterAll(() => broker.stop());

  test("log --operator through a real pipe parses on five consecutive runs", async () => {
    for (let i = 0; i < 5; i++) {
      const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/cli.ts`, "log", "--operator"], {
        env: { ...process.env, CLAUDE_IPC_SOCKET: sock },
        stdout: "pipe",
        stderr: "ignore",
      });
      const raw = await new Response(proc.stdout).text();
      expect(proc.exited).resolves.toBe(0);
      expect(raw.length).toBeGreaterThan(65_536); // the payload genuinely crosses the cliff
      const parsed = JSON.parse(raw) as { messages: unknown[] };
      expect(parsed.messages.length).toBe(12);
    }
  }, 60_000);
});
