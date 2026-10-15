/**
 * Inbox rows say which delivery state they are in (queued | delivered | surfaced),
 * and `count --unseen` counts only the ones the recipient has not yet been shown
 * (queued + delivered). A surfaced message was handed to the agent already, so a
 * watcher that wakes on it re-announces mail the agent has read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { run } from "../src/cli.ts";
import type { Request, Response } from "../src/protocol.ts";
import type { StorageBackend } from "../src/storage/base.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";

type Row = { id: string; deliveryState?: string };

function suite(name: string, make: () => StorageBackend): void {
  describe(`${name}: delivery state on inbox rows + count --unseen`, () => {
    let backend: StorageBackend;
    let router: Router;
    let idn = 0;
    const tokens = new Map<string, string>();
    const call = (op: string, args: Record<string, unknown>, as?: string) =>
      router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as unknown as Request);
    const okOf = (r: Response) => {
      expect(r.ok).toBe(true);
      return (r as { result: unknown }).result as Record<string, unknown>;
    };
    const send = (body: string): string => {
      const r = okOf(call("send", { from: "sender", to: "me", kind: "inform", body }, "sender"));
      return (r.id ?? r.msgId) as string;
    };

    beforeEach(() => {
      idn = 0;
      tokens.clear();
      backend = make();
      const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
      router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
      for (const [alias, sid] of [
        ["me", "sid-me"],
        ["sender", "sid-sender"],
      ] as const) {
        tokens.set(alias, okOf(call("register", { alias, sessionId: sid, cwd: "/w" })).token as string);
      }
    });

    test("each row carries its state: queued, delivered, surfaced", () => {
      const a = send("a"); // stays queued
      const b = send("b");
      const c = send("c");
      backend.markDelivered(b, "me", "hook");
      backend.markDelivered(c, "me", "hook");
      backend.markSurfaced(c, "me");
      const rows = (okOf(call("check", { alias: "me" }, "me")).messages ?? []) as Row[];
      const by = Object.fromEntries(rows.map((m) => [m.id, m.deliveryState]));
      expect(by[a]).toBe("queued");
      expect(by[b]).toBe("delivered");
      expect(by[c]).toBe("surfaced");
    });

    test("a peek does not change any state (peek, don't consume)", () => {
      const a = send("a");
      okOf(call("check", { alias: "me" }, "me"));
      const rows = (okOf(call("check", { alias: "me" }, "me")).messages ?? []) as Row[];
      expect(rows.find((m) => m.id === a)?.deliveryState).toBe("queued");
    });

    test("count --unseen counts queued + delivered only; plain count is unchanged", () => {
      send("a");
      const b = send("b");
      const c = send("c");
      backend.markDelivered(b, "me", "hook");
      backend.markDelivered(c, "me", "hook");
      backend.markSurfaced(c, "me");
      const plain = okOf(call("count", { alias: "me" }, "me")) as { count: number; unseen?: boolean };
      expect(plain.count).toBe(3);
      expect(plain.unseen).toBeUndefined();
      const unseen = okOf(call("count", { alias: "me", unseen: true }, "me")) as { count: number; unseen?: boolean };
      expect(unseen.count).toBe(2);
      expect(unseen.unseen).toBe(true); // echo lets the CLI refuse a broker that ignored the arg
    });

    test("project peek rows carry state too", () => {
      okOf(call("send", { from: "sender", to: "proj:/w", kind: "inform", body: "lane" }, "sender"));
      const rows = (okOf(call("check", { project: "/w" })).messages ?? []) as Row[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.deliveryState).toBe("queued");
      const n = okOf(call("count", { project: "/w", unseen: true })) as { count: number };
      expect(n.count).toBe(1);
    });
  });
}

suite("MemoryBackend", () => new MemoryBackend(1000));
suite("SqliteBackend", () => new SqliteBackend(":memory:", 1000));

describe("CLI: count --unseen", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  let errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let backend: MemoryBackend;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    backend = new MemoryBackend(1000);
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = `/tmp/cipc-unseen-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    errs = [];
    console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_CODE_SESSION_ID = "sid-unseen-cli";
    await run(["register", "me"], { socketPath: sock });
    const { Client } = await import("../src/client.ts");
    const peer = new Client(sock);
    await peer.register("peer", { sessionId: "sid-peer", cwd: "/p" });
    const one = (await peer.send({ from: "peer", to: "me", kind: "inform", body: "one" })) as { id?: string; msgId?: string };
    await peer.send({ from: "peer", to: "me", kind: "inform", body: "two" });
    const oid = (one.msgId ?? one.id)!;
    backend.markDelivered(oid, "me", "hook");
    backend.markSurfaced(oid, "me");
    lines = [];
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    broker.stop();
  });

  test("bare count 2, --unseen 1, inbox rows are tagged", async () => {
    expect(await run(["count", "me"], { socketPath: sock })).toBe(0);
    expect(lines.at(-1)).toBe("2");
    expect(await run(["count", "me", "--unseen"], { socketPath: sock })).toBe(0);
    expect(lines.at(-1)).toBe("1");
    expect(await run(["inbox", "me"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.at(-1)!) as { messages: Row[] };
    expect(parsed.messages.map((m) => m.deliveryState).sort()).toEqual(["queued", "surfaced"]);
  });

  test("--unseen against a broker that ignores it FAILS rather than printing the total", async () => {
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const real = new Router(backend, registry, () => 1000, () => `old-${++idn}`, null);
    const spy = {
      handle: (req: Request): Response => {
        if (req.op === "count") delete (req.args as { unseen?: boolean }).unseen;
        return real.handle(req);
      },
    } as unknown as Router;
    const oldSock = `${sock}.old`;
    const oldBroker = startBroker({ router: spy, socketPath: oldSock });
    try {
      await run(["register", "me"], { socketPath: oldSock });
      expect(await run(["count", "me", "--unseen"], { socketPath: oldSock })).toBe(1);
      expect(errs.join("\n")).toContain("predates --unseen");
    } finally {
      oldBroker.stop();
    }
  });
});
