import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { deliverContext, formatMessages } from "../src/hooks/shared.ts";
import { ipcHookCommands, mergeHooks } from "../scripts/install.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("hooks — proactive delivery", () => {
  let broker: BrokerHandle;
  let client: Client;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
  });
  afterEach(() => broker.stop());

  test("UserPromptSubmit delivery injects queued messages once (idempotent)", async () => {
    await client.send({ from: "alice", to: "bob", kind: "query", body: "base url?" });
    const ctx1 = await deliverContext(client, "bob", "hook");
    expect(ctx1).toContain("base url?");
    expect(ctx1).toContain("ipc_reply");
    const ctx2 = await deliverContext(client, "bob", "hook");
    expect(ctx2).toBeNull(); // already delivered → not re-injected
  });

  test("a request is framed as a consent-gated proposal", async () => {
    const r = await client.send({ from: "alice", to: "bob", kind: "request", body: "run deploy" });
    const ctx = await deliverContext(client, "bob", "hook");
    expect(ctx).toContain("ACTION REQUEST");
    expect(ctx).toContain(`ipc_accept("${r.msgId}")`);
  });

  test("a delivered message is still actionable via ipc_check", async () => {
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "hi" });
    await deliverContext(client, "bob", "hook"); // marks delivered, not consumed
    const inbox = await client.check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["hi"]);
  });

  test("resume drains the offline backlog in order", async () => {
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "first" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "second" });
    const ctx = (await deliverContext(client, "bob", "resume")) ?? "";
    expect(ctx).toContain("first");
    expect(ctx).toContain("second");
    expect(ctx.indexOf("first")).toBeLessThan(ctx.indexOf("second"));
  });
});

describe("hooks — formatting + install", () => {
  test("an error response shows its code", () => {
    const s = formatMessages([
      {
        id: "r1",
        kind: "response",
        fromAlias: "ipc",
        corrId: "q1",
        status: "error",
        errorCode: "timeout",
        body: "no response within TTL",
      },
    ]);
    expect(s).toContain("[timeout]");
  });

  test("mergeHooks is additive and idempotent across the 3 events", () => {
    const once = mergeHooks({}, "/repo");
    const twice = mergeHooks(once, "/repo");
    const events = Object.keys(ipcHookCommands("/repo"));
    expect(Object.keys(twice.hooks ?? {}).sort()).toEqual(events.sort());
    for (const e of events) {
      expect((twice.hooks?.[e] ?? []).length).toBe(1); // not duplicated on re-run
    }
  });
});
