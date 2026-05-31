import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const tmpTokens = (): string => mkdtempSync(join(tmpdir(), "cipc-tok-"));

// The capability-token model: holding an alias's token file is what authorizes
// acting as it. `owner` holds the tokens; `attacker` is a second client on the
// same broker with its own (empty) token dir — i.e. a process that never
// registered the alias and so cannot prove ownership.
describe("identity / token capability", () => {
  let broker: BrokerHandle;
  let owner: Client;
  let attacker: Client;
  let clock = 1000;

  beforeEach(() => {
    clock = 1000;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => clock, () => `msg-${++n}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    owner = new Client(broker.socketPath, undefined, tmpTokens());
    attacker = new Client(broker.socketPath, undefined, tmpTokens());
  });
  afterEach(() => broker.stop());

  test("a registered alias cannot be spoofed by a client without its token", async () => {
    await owner.register("backend", { sessionId: "s1", cwd: "/x" });
    await owner.register("frontend", { sessionId: "s2", cwd: "/y" }); // a real target
    const ok = await owner.send({ from: "backend", to: "frontend", kind: "inform", body: "hi" });
    expect(ok.msgId).toBeDefined(); // owner holds backend's token → allowed
    await expect(
      attacker.send({ from: "backend", to: "frontend", kind: "inform", body: "spoof" }),
    ).rejects.toThrow(/unauthorized/); // attacker has no token for backend → refused
  });

  test("an attacker cannot drain a registered alias's inbox", async () => {
    await owner.register("backend", { sessionId: "s1", cwd: "/x" });
    await expect(attacker.check("backend", true)).rejects.toThrow(/unauthorized/);
  });

  test("a live alias cannot be hijacked by re-register without the token", async () => {
    await owner.register("backend", { sessionId: "s1", cwd: "/x" });
    await expect(attacker.register("backend", { sessionId: "evil", cwd: "/z" })).rejects.toThrow(/alias_taken/);
    const re = await owner.register("backend", { sessionId: "s1b", cwd: "/x" }); // holder may re-bind
    expect(re.registered).toBe(true);
  });

  test("an owned alias stays protected after going offline; only the token-holder reconnects", async () => {
    await owner.register("backend", { sessionId: "s1", cwd: "/x" });
    clock += 2000; // past offlineS=1800 → backend shows offline (also models a warm-start after restart)
    // a tokenless attacker still cannot reclaim it — this is the post-restart hijack window, closed
    await expect(attacker.register("backend", { sessionId: "evil", cwd: "/z" })).rejects.toThrow(/alias_taken/);
    // the real owner reconnects because its token file persisted
    const re = await owner.register("backend", { sessionId: "s1b", cwd: "/x" });
    expect(re.registered).toBe(true);
  });

  test("tokens never appear in the public peer list", async () => {
    await owner.register("backend", { sessionId: "s1", cwd: "/x" });
    const { peers } = (await owner.list()) as { peers: { token?: unknown }[] };
    expect(peers.length).toBe(1);
    expect(peers[0]?.token ?? null).toBeNull();
  });
});
