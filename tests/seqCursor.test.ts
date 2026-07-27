/**
 * P3b — the inbox-event cursor. `count` carries a monotonic `seq` that moves on
 * any pending-set change, so a watcher can see a net-zero window (one message
 * in, one consumed) that a bare count hides — and the cursor never rewinds
 * across broker restarts (persisted counter + boot-clock floor).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { run } from "../src/cli.ts";
import { makeMessage } from "../src/models.ts";
import type { Request, Response } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";

describe("router: count carries the event cursor", () => {
  let backend: MemoryBackend;
  let router: Router;
  let clock = 1000;
  let idn = 0;
  const tokens = new Map<string, string>();

  const call = (op: string, args: Record<string, unknown>, as?: string) =>
    router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as unknown as Request);
  const okOf = (r: { ok: boolean; result?: unknown }) => {
    expect(r.ok).toBe(true);
    return r.result as Record<string, unknown>;
  };
  const countOf = (alias: string) => okOf(call("count", { alias }, alias)) as { count: number; seq: number };

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend(1000);
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null);
    for (const [alias, sid] of [
      ["me", "sid-me"],
      ["sender", "sid-sender"],
    ] as const) {
      const r = okOf(call("register", { alias, sessionId: sid, cwd: "/w" }));
      tokens.set(alias, r.token as string);
    }
  });

  test("a fresh inbox reads seq 0 — nothing has ever happened, honestly", () => {
    expect(countOf("me")).toEqual({ count: 0, seq: 0 });
  });

  test("a send bumps the recipient's seq with the count", () => {
    okOf(call("send", { from: "sender", to: "me", kind: "inform", body: "hi" }, "sender"));
    const { count, seq } = countOf("me");
    expect(count).toBe(1);
    expect(seq).toBeGreaterThan(1000); // minted above the floor
  });

  test("net-zero window: send then consume — count unchanged, seq advanced", () => {
    const before = countOf("me");
    okOf(call("send", { from: "sender", to: "me", kind: "inform", body: "in" }, "sender"));
    okOf(call("check", { alias: "me", consume: true }, "me")); // ...and out
    const after = countOf("me");
    expect(after.count).toBe(before.count); // the window a bare count hides
    expect(after.seq).toBeGreaterThan(before.seq); // the cursor shows it
  });

  test("polling count does NOT move the cursor — reads are not events", () => {
    okOf(call("send", { from: "sender", to: "me", kind: "inform", body: "hi" }, "sender"));
    const first = countOf("me").seq;
    expect(countOf("me").seq).toBe(first);
    expect(countOf("me").seq).toBe(first);
  });

  test("an unregistered alias still FAILS — the cursor inherits P3a, no plausible zero", () => {
    const r = call("count", { alias: "ghost" }) as Response;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("not_registered");
  });

  test("project count carries a seq for the project's boxes", () => {
    okOf(call("send", { from: "sender", to: "proj:/w", kind: "inform", body: "lane mail" }, "sender"));
    const r = okOf(call("count", { project: "/w" })) as { count: number; seq: number };
    expect(r.count).toBe(1);
    expect(r.seq).toBeGreaterThan(1000);
  });
});

describe("restart monotonicity — the cursor never rewinds", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "cipc-seq-"));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const mint = (b: SqliteBackend | MemoryBackend, id: string): number => {
    b.append(makeMessage({ id, kind: "inform", fromAlias: "a", toAlias: "bob", ts: 1 }));
    b.enqueue(id, "bob");
    return b.lastEventSeq(["bob"]);
  };

  test("sqlite: a reopened store resumes ABOVE the persisted counter", () => {
    const file = join(scratch, "seq.sqlite");
    const b1 = new SqliteBackend(file, 0);
    mint(b1, "m1");
    const last = mint(b1, "m2");
    b1.close();
    const b2 = new SqliteBackend(file, 0); // floor 0: persistence alone must carry it
    expect(mint(b2, "m3")).toBeGreaterThan(last);
    b2.close();
  });

  test("sqlite: a LOST store still cannot rewind — the boot-clock floor jumps it forward", () => {
    const b1 = new SqliteBackend(join(scratch, "lost.sqlite"), 1000);
    const last = mint(b1, "m1");
    b1.close();
    const b2 = new SqliteBackend(join(scratch, "fresh.sqlite"), last + 4000); // a later boot clock
    expect(mint(b2, "m1")).toBeGreaterThan(last);
    b2.close();
  });

  test("memory: a rebuilt backend mints above the old life via the floor", () => {
    const b1 = new MemoryBackend(1000);
    mint(b1, "m1");
    const last = mint(b1, "m2");
    const b2 = new MemoryBackend(5000);
    expect(mint(b2, "m1")).toBeGreaterThan(last);
  });

  test("default floors are the boot clock — two real backends never overlap downward", () => {
    // No injected floor: the counter starts at wall-clock seconds, so seqs are
    // strictly above any counter a plausibly-paced earlier life handed out.
    const b = new MemoryBackend();
    expect(mint(b, "m1")).toBeGreaterThan(1_700_000_000);
  });
});

const tmpSock = (): string => `/tmp/cipc-seq-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("CLI: count --cursor", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  let errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend(1000);
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    errs = [];
    console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_CODE_SESSION_ID = "sid-cursor-cli";
    await run(["register", "me"], { socketPath: sock });
    const peer = new Client(sock);
    await peer.register("peer", { sessionId: "sid-peer", cwd: "/p" });
    await peer.send({ from: "peer", to: "me", kind: "inform", body: "one for the box" });
    lines = [];
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    broker.stop();
  });

  test("--cursor prints 'N seq=M'; without it the bare count is unchanged", async () => {
    expect(await run(["count", "me", "--cursor"], { socketPath: sock })).toBe(0);
    expect(lines.at(-1)).toMatch(/^1 seq=\d+$/);
    expect(await run(["count", "me"], { socketPath: sock })).toBe(0);
    expect(lines.at(-1)).toBe("1"); // the tab-title consumer's contract holds
  });

  test("a broker that predates the cursor FAILS the flag rather than fabricating seq=0", async () => {
    // Same spy trick as flag-wiring: strip seq the way an old broker would.
    const backend = new MemoryBackend(1000);
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const real = new Router(backend, registry, () => 1000, () => `old-${++idn}`, null);
    const spy = {
      handle: (req: Request): Response => {
        const r = real.handle(req);
        if (req.op === "count" && r.ok) delete (r.result as { seq?: number }).seq;
        return r;
      },
    } as unknown as Router;
    const oldSock = tmpSock();
    const oldBroker = startBroker({ router: spy, socketPath: oldSock });
    try {
      await run(["register", "me"], { socketPath: oldSock });
      expect(await run(["count", "me", "--cursor"], { socketPath: oldSock })).toBe(1);
      expect(errs.join("\n")).toContain("predates");
      expect(await run(["count", "me"], { socketPath: oldSock })).toBe(0); // bare count still fine
    } finally {
      oldBroker.stop();
    }
  });
});
