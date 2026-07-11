import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { formatRoster } from "../src/hooks/shared.ts";
import { decidePush } from "../src/hooks/stop.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const ask = (id: string, kind: string, from = "backend", body = "run deploy") => ({ id, kind, fromAlias: from, body });

// P2 — turn-end push. decidePush is the pure core of the Stop hook: a waiting
// request/query blocks the turn exactly once, then degrades to a quiet reminder;
// an inform never blocks.
describe("P2 · Stop-hook turn-end push (V7)", () => {
  const never = (): boolean => false;

  test("V7 · a fresh request blocks once, naming sender + message + how to reply", () => {
    const d = decidePush([ask("m1", "request")], "frontend", never);
    expect(d.kind).toBe("block");
    if (d.kind === "block") {
      expect(d.mark).toEqual(["m1"]);
      expect(d.reason).toContain("backend sent you a request");
      expect(d.reason).toContain("m1");
      expect(d.reason).toContain("claude-ipc reply m1 --from frontend");
      expect(d.reason).toContain("fires once");
    }
  });

  test("V7 · the same message on a later Stop degrades to additionalContext, never a second block", () => {
    const wasBlocked = (id: string): boolean => id === "m1";
    const d = decidePush([ask("m1", "request")], "frontend", wasBlocked);
    expect(d.kind).toBe("remind");
    if (d.kind === "remind") expect(d.context).toContain("m1");
  });

  test("V7 · a query blocks too (it also awaits a reply)", () => {
    expect(decidePush([ask("q1", "query")], "me", never).kind).toBe("block");
  });

  test("V7 · an inform NEVER blocks", () => {
    expect(decidePush([ask("i1", "inform")], "me", never).kind).toBe("none");
  });

  test("V7 · with an inform and a request pending, only the request is blocked on", () => {
    const d = decidePush([ask("i1", "inform"), ask("r1", "request")], "me", never);
    expect(d.kind).toBe("block");
    if (d.kind === "block") expect(d.mark).toEqual(["r1"]); // inform excluded from the block
  });

  test("V7 · nothing pending → no push", () => {
    expect(decidePush([], "me", never).kind).toBe("none");
  });
});

// P2 — ambient awareness. The roster shows who else is registered so a session can
// decide on its own to message a peer; it is completely silent when alone.
describe("P2 · peers roster (V8)", () => {
  const peer = (alias: string, cwd: string, status: string) => ({ alias, cwd, status });

  test("V8 · silent when this session is the only peer", () => {
    expect(formatRoster([peer("me", "/x/me", "live")], "me")).toBeNull();
  });

  test("V8 · lists other peers as alias · project · status, excluding self", () => {
    const r = formatRoster(
      [peer("me", "/x/me", "live"), peer("backend", "/Users/x/Code/versable-builder", "live")],
      "me",
    );
    expect(r).not.toBeNull();
    expect(r).toContain("backend · versable-builder · live");
    expect(r).not.toContain("me ·"); // self is filtered out
  });

  test("V8 · orders live before idle before offline", () => {
    const r = formatRoster(
      [peer("z", "/p/z", "offline"), peer("a", "/p/a", "idle"), peer("m", "/p/m", "live")],
      "self",
    ) as string;
    expect(r.indexOf("m ·")).toBeLessThan(r.indexOf("a ·"));
    expect(r.indexOf("a ·")).toBeLessThan(r.indexOf("z ·"));
  });

  test("V8 · caps a long roster with a +N more tail", () => {
    const many = Array.from({ length: 15 }, (_, i) => peer(`p${i}`, `/p/${i}`, "live"));
    const r = formatRoster(many, "self") as string;
    expect(r).toContain("+3 more"); // 15 shown-capped-at-12
  });
});

describe("P2 · roster reflects the live broker registry (V8)", () => {
  let broker: BrokerHandle;
  let client: Client;

  beforeEach(() => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
  });
  afterEach(() => broker.stop());

  test("V8 · list() feeds a roster that names the other registered session", async () => {
    await client.register("me", { sessionId: "sMe", cwd: "/work/me" });
    await client.register("backend", { sessionId: "sBe", cwd: "/work/api-backend" });
    const peers = (await client.list()).peers as { alias: string; cwd: string; status: string }[];
    const roster = formatRoster(peers, "me") as string;
    expect(roster).toContain("backend · api-backend · live");
    expect(roster).not.toContain("me · me"); // self excluded
  });
});
