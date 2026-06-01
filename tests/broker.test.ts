import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { statSync } from "node:fs";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client, request } from "../src/client.ts";
import { FrameDecoder } from "../src/protocol.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("broker end-to-end", () => {
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

  test("register, send a query, check receives it, list shows both peers", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const sent = await client.send({ from: "alice", to: "bob", kind: "query", body: "base url?" });
    expect(sent.msgId).toBe("msg-1");
    const inbox = await client.check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["base url?"]);
    const peers = await client.list();
    expect(peers.peers.map((p: { alias: string }) => p.alias).sort()).toEqual(["alice", "bob"]);
  });

  test("send to an unknown alias returns no_peer with the live-peer list", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    const res = await client.send({ from: "alice", to: "ghost", kind: "query", body: "?" });
    expect(res.error.code).toBe("no_peer");
    expect(res.error.livePeers).toContain("alice");
  });

  test("alias rebind keeps the alias-keyed queue intact", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB1", cwd: "/b" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "hi" });
    const r = await client.register("bob", { sessionId: "sB2", cwd: "/b" }); // bob reconnects
    expect(r.replaced).toBe(true);
    const inbox = await client.check("bob");
    expect(inbox.messages.map((m: { body: string }) => m.body)).toEqual(["hi"]);
  });

  test("broadcast fans out to live peers except the sender", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    await client.register("carol", { sessionId: "sC", cwd: "/c" });
    await client.send({ from: "alice", to: "*", kind: "inform", body: "standup" });
    expect((await client.check("bob")).messages.length).toBe(1);
    expect((await client.check("carol")).messages.length).toBe(1);
    expect((await client.check("alice")).messages.length).toBe(0);
  });

  // Regression: a response bigger than the socket send-buffer watermark (~8 KB)
  // is written in pieces. The broker must drain the unsent tail on `drain`, or
  // the client's length-prefix decoder hangs forever waiting for the lost bytes.
  // This is the bug that left `history`/`tail` empty for any non-trivial log.
  test("a >8 KB history response is delivered whole, not truncated", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const body = "x".repeat(600); // ~30 of these clears the 8 KB watermark comfortably
    for (let i = 0; i < 30; i++) {
      await client.send({ from: "alice", to: "bob", kind: "inform", body: `${i}:${body}` });
    }
    const log = await client.history({});
    expect(log.messages.length).toBe(30);
    expect(log.messages.at(-1).body).toBe(`29:${body}`);
  });

  // Sibling of the above on the send path: a single request frame larger than
  // the watermark is itself written in pieces. The client must drain its own
  // outbound tail, or the broker never sees a whole frame and the call hangs.
  test("a >8 KB request body is sent whole and round-trips", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const big = "y".repeat(20_000); // one frame, well over the 8 KB watermark
    const sent = await client.send({ from: "alice", to: "bob", kind: "inform", body: big });
    expect(sent.msgId).toBeDefined();
    const inbox = await client.check("bob");
    expect(inbox.messages[0].body).toBe(big);
  });

  // B3: a frame from an incompatible protocol version is rejected, not mis-parsed.
  test("a request with an incompatible protocol version is rejected", async () => {
    const res = await request(broker.socketPath, { v: 999, op: "list", args: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("bad_version");
  });

  // A2: a broker that accepts the connection but never replies must not hang the
  // caller forever — the request deadline turns it into a reject.
  test("request() rejects on its deadline when the broker never replies", async () => {
    const sock = tmpSock();
    const silent = Bun.listen({ unix: sock, socket: { open() {}, data() {} } }); // never writes back
    const t0 = Date.now();
    await expect(request(sock, { v: 1, op: "list", args: {} }, 200)).rejects.toThrow(/within 200ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
    silent.stop(true);
  });

  // A3: a malformed frame desyncs the stream but must not crash the broker — it
  // gets one error frame and the broker keeps serving other connections.
  test("a malformed frame yields bad_frame and the broker survives", async () => {
    const body = new TextEncoder().encode("{not json"); // valid length prefix, garbage body
    const frame = new Uint8Array(4 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength, false);
    frame.set(body, 4);
    const reply = await new Promise<{ ok: boolean; error?: { code: string } }>((resolve) => {
      const dec = new FrameDecoder();
      Bun.connect({
        unix: broker.socketPath,
        socket: {
          open(s) {
            s.write(frame);
          },
          data(s, d) {
            const f = dec.push(new Uint8Array(d))[0] as { ok: boolean; error?: { code: string } };
            if (f) {
              resolve(f);
              s.end();
            }
          },
        },
      });
    });
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("bad_frame");
    // broker still serves a normal request afterwards
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    expect((await client.list()).peers.map((p: { alias: string }) => p.alias)).toContain("alice");
  });

  // The socket is the cross-UID boundary the tokens assume — owner-only (0600).
  test("the broker socket is created owner-only (0600)", () => {
    expect(statSync(broker.socketPath).mode & 0o777).toBe(0o600);
  });

  // Registry GC: prune drops dead offline peers but keeps live ones and any
  // offline alias that still has pending mail (a mailbox awaiting its owner).
  test("prune drops offline peers, keeping live ones and pending mailboxes", async () => {
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    await client.register("ghost", { sessionId: "sG", cwd: "/private/tmp" });
    await client.send({ from: "alice", to: "bob", kind: "inform", body: "hi" }); // bob now has mail
    clock += 5000; // age everyone past offlineS=1800
    await client.register("alice", { sessionId: "sA", cwd: "/a" }); // alice is live again
    const r = await client.prune(1000); // window 1000s → cutoff at clock-1000
    expect(r.pruned).toBe(1); // only ghost: offline, no mail
    const aliases = (await client.list()).peers.map((p: { alias: string }) => p.alias).sort();
    expect(aliases).toEqual(["alice", "bob"]); // ghost gone; bob kept (pending), alice kept (live)
  });
});
