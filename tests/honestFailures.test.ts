import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { BrokerError, Client } from "../src/client.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

// B3 — a command that returns output is not a command that had an effect. Every
// refusal must LOOK like a refusal: ok:false on the wire, a thrown BrokerError in
// the client, and a broker-side record that the drop happened. Field provenance:
// a "no peer named X" answer that read as information (the payload was silently
// discarded), and a composed reply binned by `ok({dropped:true})` — both 2026-07-14.
describe("B3 · refusals are failures, not information", () => {
  let backend: MemoryBackend;
  let router: Router;
  let broker: BrokerHandle;
  let client: Client;
  let refusals: { op: string; code: string }[];
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    refusals = [];
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    broker = startBroker({
      router,
      socketPath: tmpSock(),
      onRefusal: (req, code) => refusals.push({ op: req.op, code }),
    });
    client = new Client(broker.socketPath);
  });
  afterEach(() => broker.stop());

  test("send to an unknown alias throws no_peer, and the broker records the refusal", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    let err: unknown;
    try {
      await client.send({ from: "alice", to: "ghost", kind: "query", body: "?" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    if (err instanceof BrokerError) {
      expect(err.code).toBe("no_peer");
      expect((err.data as { livePeers: string[] }).livePeers).toContain("alice");
    }
    expect(refusals).toContainEqual({ op: "send", code: "no_peer" });
    // and truly nothing was sent
    expect(backend.pending("ghost").length).toBe(0);
  });

  test("reply into a cancelled ask is refused with the direct-send way out, and stops nagging the replier", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "query", body: "still there?" });
    await client.deliver("bob", "hook"); // bob has SEEN it — the mid-compose shape
    await client.cancel(sent.msgId, "alice");

    let err: unknown;
    try {
      await client.reply({ from: "bob", corrId: sent.msgId, body: "long composed answer" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    if (err instanceof BrokerError) {
      expect(err.code).toBe("ask_cancelled");
      expect(err.message).toContain(`claude-ipc send --to alice --from bob`);
    }
    // the dead ask no longer counts as pending mail for bob
    const stillPending = backend.pending("bob").map((m) => m.id);
    expect(stillPending).not.toContain(sent.msgId);
  });

  test("cancelling a SEEN ask leaves the recipient a CANCELLED notice and consumes the ask", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "request", body: "do the thing" });
    await client.deliver("bob", "hook"); // delivered → bob may be composing
    await client.cancel(sent.msgId, "alice");

    const pending = backend.pending("bob");
    expect(pending.map((m) => m.id)).not.toContain(sent.msgId); // dead ask consumed
    const notice = pending.find((m) => m.corrId === sent.msgId && m.fromAlias === "ipc");
    expect(notice?.body).toContain("CANCELLED");
    expect(notice?.body).toContain("alice");

    // idempotent: a second cancel adds no second notice
    await client.cancel(sent.msgId, "alice");
    expect(backend.pending("bob").filter((m) => m.corrId === sent.msgId && m.fromAlias === "ipc").length).toBe(1);
  });

  test("cancelling a NEVER-SEEN ask consumes it silently — no notice about mail they never met", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "query", body: "nvm" });
    await client.cancel(sent.msgId, "alice"); // still queued — bob never saw it

    const pending = backend.pending("bob");
    expect(pending.length).toBe(0); // no dead ask, no notice
  });

  test("cancel of a nonexistent id is a refusal, not a success about nothing", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    let err: unknown;
    try {
      await client.cancel("msg-does-not-exist", "alice");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    if (err instanceof BrokerError) expect(err.code).toBe("no_message");
  });

  test("cancel of an inform (not an ask) names the real problem", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "inform", body: "fyi" });
    let err: unknown;
    try {
      await client.cancel(sent.msgId, "alice");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    if (err instanceof BrokerError) expect(err.code).toBe("not_an_ask");
  });

  test("cancelling twice stays truthful — the second cancel is an idempotent success", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await client.cancel(sent.msgId, "alice");
    const again = await client.cancel(sent.msgId, "alice");
    expect(again.cancelled).toBe(true); // it IS cancelled — the claim matches the state
  });

  test("an allowlisted target refuses outsiders with ok:false (not an ok-wrapped error)", () => {
    const backend2 = new MemoryBackend();
    const registry2 = new Registry(backend2, () => 1000, { idleS: 300, offlineS: 1800 });
    const router2 = new Router(
      backend2,
      registry2,
      () => 1000,
      () => `m-${++idn}`,
      60,
      () => {},
      { privileged: ["boss"] },
    );
    const reg = (alias: string, sid: string): string => {
      const r = router2.handle({ v: 1, op: "register", args: { alias, sessionId: sid, cwd: "/w" } } as Request);
      return (r as { ok: true; result: { token: string } }).result.token;
    };
    const tok = reg("rando", "s1");
    reg("privileged", "s2");
    const res = router2.handle({
      v: 1,
      op: "send",
      args: { from: "rando", to: "privileged", kind: "inform", body: "hi" },
      token: tok,
    } as Request);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_allowed");
  });
});
