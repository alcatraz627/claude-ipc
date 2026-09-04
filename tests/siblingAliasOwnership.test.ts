import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { BrokerError, Client } from "../src/client.ts";

/**
 * A session owns its mail under every alias it registered.
 *
 * Mail is delivered to one name, but a session registers several. Matching on
 * that single name refused a session acting on its own mail under a sibling
 * name: on 2026-09-04 two agents were written to at one alias, answered as
 * themselves under another, and both got not_yours.
 */
const tmpSock = (): string => `/tmp/cipc-sib-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;

describe("sibling alias ownership", () => {
  let broker: BrokerHandle;
  let client: Client;
  let clock = 1000;
  let idn = 0;

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => clock, () => `msg-${++idn}`);
    const sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    client = new Client(sock);
  });
  afterEach(() => broker.stop());

  test("a session replies under a sibling alias to mail sent to its other one", async () => {
    await client.register("asker", { sessionId: "sA", cwd: "/a" });
    // One session, two names, exactly as a resumed agent registers.
    await client.register("primary", { sessionId: "sW", cwd: "/w" });
    await client.register("nickname", { sessionId: "sW", cwd: "/w" });

    // An inform, because that is the path replyToInform guards and the one the
    // agents were answering when they were refused.
    const sent = await client.send({ from: "asker", to: "nickname", kind: "inform", body: "notice" });
    // Answering as "primary" is the same session answering its own mail.
    const res = await client.reply({ from: "primary", corrId: sent.msgId, body: "answer" });
    expect(res).toBeTruthy();
  });

  test("an unrelated session is still refused", async () => {
    await client.register("asker2", { sessionId: "sA2", cwd: "/a" });
    await client.register("worker2", { sessionId: "sW2", cwd: "/w" });
    await client.register("stranger", { sessionId: "sOther", cwd: "/x" });

    const sent = await client.send({ from: "asker2", to: "worker2", kind: "inform", body: "notice" });
    let err: unknown;
    try {
      await client.reply({ from: "stranger", corrId: sent.msgId, body: "not mine" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    if (err instanceof BrokerError) expect(err.code).toBe("not_yours");
  });
});
