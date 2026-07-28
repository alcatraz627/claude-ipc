/**
 * The Viewer Contract (extensibility E1): a read-only window that structurally
 * cannot mutate the fabric — no mutating members exist on the type, and every
 * peek is invisible to the mailbox owner.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client, viewerOf } from "../src/client.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-vw-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("Viewer contract", () => {
  let broker: BrokerHandle;
  let sock: string;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
  });
  afterEach(() => broker.stop());

  test("the viewer surface has NO mutating members — politeness as type law", () => {
    const v = viewerOf(new Client(sock)) as unknown as Record<string, unknown>;
    for (const forbidden of ["send", "reply", "register", "accept", "decline", "snooze", "cancel", "check", "supersede"]) {
      expect(v[forbidden]).toBeUndefined();
    }
  });

  test("peeks are invisible: repeated viewer reads never consume or change counts", async () => {
    const c = new Client(sock);
    await c.register("owner-x", { sessionId: "sid-x", cwd: "/x" });
    await c.register("sender-y", { sessionId: "sid-y", cwd: "/y" });
    await c.send({ from: "sender-y", to: "owner-x", kind: "query", body: "still there?" });

    const v = viewerOf(c);
    const before = ((await v.count("owner-x")) as { count: number }).count;
    await v.peek("owner-x");
    await v.peek("owner-x");
    const after = ((await v.count("owner-x")) as { count: number }).count;
    expect(before).toBe(1);
    expect(after).toBe(1);

    // the owner's REAL consume still works and is the thing that changes state
    await c.check("owner-x", true);
    expect(((await v.count("owner-x")) as { count: number }).count).toBe(0);
  });

  test("viewer status is always party-scoped — operator bodies need the real client", async () => {
    const c = new Client(sock);
    await c.register("a", { sessionId: "sid-a", cwd: "/a" });
    await c.register("b", { sessionId: "sid-b", cwd: "/b" });
    const sent = await c.send({ from: "a", to: "b", kind: "inform", body: "secret detail" });
    const v = viewerOf(c);
    const st = (await v.status(sent.msgId)) as { message: { body: string; bodyHidden?: boolean } };
    expect(st.message.body).toContain("hidden"); // no identity, no operator → scoped
    expect(st.message.bodyHidden).toBe(true); // the unforgeable flag rides the strip (review #15)
  });
});
