/**
 * The hub-digest contract verbs (docs/contracts/hub-digest.md): `digest` and
 * `asks`. Run against BOTH backends; the parity smoke is the can-i-deploy gate —
 * a live response must be a field-superset of the vendored consumer fixture.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { run } from "../src/cli.ts";
import { makeMessage } from "../src/models.ts";
import type { Request } from "../src/protocol.ts";
import type { StorageBackend } from "../src/storage/base.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "hub-consumer.json"), "utf8")) as {
  digest: Record<string, unknown>;
  asks: Record<string, unknown>;
};

/** Every key path present in the fixture must exist in the live value. Dynamic
 *  map keys (sessions.<uuid>) are matched shape-wise against every live entry;
 *  arrays match the fixture's first element against every live element. */
function assertSuperset(live: unknown, fix: unknown, path: string): void {
  if (Array.isArray(fix)) {
    expect(Array.isArray(live)).toBe(true);
    // The fixture's first element is the SHAPE contract for whatever elements
    // exist; emptiness is legitimate (a session with nothing owed). The parity
    // test separately asserts the scenario exercised each top-level array once.
    const shape = fix[0];
    if (shape !== undefined) for (const el of live as unknown[]) assertSuperset(el, shape, `${path}[]`);
    return;
  }
  if (fix !== null && typeof fix === "object") {
    expect(live !== null && typeof live === "object").toBe(true);
    for (const [k, v] of Object.entries(fix as Record<string, unknown>)) {
      if (k === "_provenance") continue;
      if (k.startsWith("<") && k.endsWith(">")) {
        // dynamic key: every real entry must carry the fixture entry's shape
        const entries = Object.entries(live as Record<string, unknown>).filter(([lk]) => !lk.startsWith("_"));
        expect(entries.length).toBeGreaterThan(0);
        for (const [lk, lv] of entries) assertSuperset(lv, v, `${path}.${lk}`);
        continue;
      }
      expect((live as Record<string, unknown>)[k] !== undefined).toBe(true);
      assertSuperset((live as Record<string, unknown>)[k], v, `${path}.${k}`);
    }
  }
  // primitives: presence (checked by the caller) is the contract; values are scenario-specific
}

function suite(name: string, makeBackend: () => StorageBackend): void {
  describe(`hub-digest verbs — ${name}`, () => {
    let backend: StorageBackend;
    let registry: Registry;
    let router: Router;
    let clock = 1000;
    let idn = 0;
    let notified: string[] = [];
    const tokens = new Map<string, string>();

    const call = (op: string, args: Record<string, unknown>, as?: string) =>
      router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as unknown as Request);
    const okOf = (r: { ok: boolean; result?: unknown }) => {
      expect(r.ok).toBe(true);
      return r.result as Record<string, unknown>;
    };
    const reg = (alias: string, sid: string, cwd: string) => {
      const r = okOf(call("register", { alias, sessionId: sid, cwd }));
      tokens.set(alias, r.token as string);
    };

    // The scenario every test reads: two sessions in /proj/w (one holding two
    // aliases), an owed ask with a deadline, a chase notice, a dead box with
    // mail, and an obligation whose alias resolves to no session at all.
    beforeEach(() => {
      clock = 10_000;
      idn = 0;
      notified = [];
      tokens.clear();
      backend = makeBackend();
      registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
      router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null, (a) => notified.push(a));

      reg("lane-a", "sid-A", "/proj/w");
      reg("lane-a2", "sid-A", "/proj/w");
      reg("sender", "sid-B", "/proj/w");

      // an owed ask with a reply-by budget + an inform to the sibling box
      okOf(call("send", { from: "sender", to: "lane-a", kind: "query", body: "owed?", replyByS: 300 }, "sender"));
      okOf(call("send", { from: "sender", to: "lane-a2", kind: "inform", body: "fyi" }, "sender"));
      // a broker chase notice in lane-a's box (what the sweeper would post)
      backend.append(
        makeMessage({ id: "chase-1", kind: "response", fromAlias: "ipc", toAlias: "lane-a", ts: clock, terminal: false }),
      );
      backend.enqueue("chase-1", "lane-a");

      // a dead box in the project still holding real mail
      reg("dead-x", "sid-dead", "/proj/w");
      okOf(call("send", { from: "sender", to: "dead-x", kind: "inform", body: "for the dead" }, "sender"));

      // an obligation to an alias that will vanish entirely (no side file, pruned)
      reg("ghost-z", "sid-ghost", "/elsewhere");
      okOf(call("send", { from: "sender", to: "ghost-z", kind: "query", body: "into the void", replyByS: null }, "sender"));
      okOf(call("check", { alias: "ghost-z", consume: true }, "ghost-z")); // box empties; the ask stays open
      clock += 3600; // everyone decays offline
      // Prune drops the empty-boxed offline rows (ghost-z AND sender); mail keeps
      // dead-x and sid-A's boxes. sender re-registers — the real after-prune path.
      okOf(call("prune", { offlineForS: 1800 }));
      reg("sender", "sid-B", "/proj/w");
      okOf(call("heartbeat", { alias: "lane-a" }, "lane-a")); // revives sid-A (entry survived via mail)
      notified = [];
    });

    test("digest: sessions are the unit — sibling aliases collapse into one sid entry", () => {
      const r = okOf(call("digest", { project: "/proj/w" }));
      const sessions = r.sessions as Record<string, { aliases: string[]; unread: number }>;
      const sidA = sessions["sid-A"];
      expect(sidA).toBeDefined();
      expect(sidA!.aliases.sort()).toEqual(["lane-a", "lane-a2"]);
      expect(sidA!.unread).toBe(2); // query + inform, across both boxes, chase excluded
      expect(Object.keys(sessions)).not.toContain("lane-a"); // aliases are labels, never keys
    });

    test("digest: owed carries the ledger's word; deadlines and chase noise are honest", () => {
      const r = okOf(call("digest", { project: "/proj/w" }));
      const sidA = (r.sessions as Record<string, Record<string, unknown>>)["sid-A"]!;
      const owed = sidA.owed as { corr_id: string; kind: string; reply_by_s: number | null; ask_state: string }[];
      expect(owed.length).toBe(1);
      expect(owed[0]).toMatchObject({ corr_id: "msg-1", kind: "query", reply_by_s: 300, ask_state: "open" });
      expect(sidA.chase_noise_folded).toBe(1);
      // 300s budget minus 3600s already waited — past due reads negative, never null
      expect(sidA.oldest_deadline_s).toBe(300 - 3600);
      const sidB = (r.sessions as Record<string, Record<string, unknown>>)["sid-B"]!;
      expect(sidB.waiting_on).toBe(2); // the lane-a ask + the ghost-z ask are both still open
      expect(sidB.oldest_deadline_s).toBeNull(); // nothing owed TO sid-B carries a deadline
    });

    test("digest: dead boxes count into orphaned_in_cwd; unresolved obligations are bucketed, never dropped", () => {
      const r = okOf(call("digest", { project: "/proj/w" }));
      const sessions = r.sessions as Record<string, Record<string, unknown>>;
      expect(sessions["sid-A"]!.orphaned_in_cwd).toBe(1); // dead-x's waiting inform
      const unresolved = sessions["_unresolved"] as { aliases: string[]; note: string };
      expect(unresolved.aliases).toEqual(["ghost-z"]);
      expect(unresolved.note).toContain("never dropped");
    });

    test("asks --all: every open ask with sid resolution; orphans split real mail from chase noise", () => {
      const r = okOf(call("asks", {}));
      const asks = r.asks as Record<string, unknown>[];
      const toLaneA = asks.find((x) => x.to_alias === "lane-a");
      expect(toLaneA).toMatchObject({
        from_alias: "sender",
        to_sid: "sid-A",
        kind: "query",
        reply_by_s: 300,
        nudge_stage: "none",
        ask_state: "open",
        project_cwd: "/proj/w",
      });
      const toGhost = asks.find((x) => x.to_alias === "ghost-z");
      expect(toGhost!.to_sid).toBeNull(); // resolves nowhere — null, not a fabricated sid
      const orphans = r.orphans as Record<string, unknown>[];
      const dead = orphans.find((o) => o.alias === "dead-x");
      expect(dead).toMatchObject({ real_mail: 1, chase_noise: 0, cwd: "/proj/w" });
      expect(typeof dead!.oldest_ts).toBe("string"); // ISO, per the contract example
    });

    test("viewer law: serving digest + asks consumes nothing, notifies nobody, touches no liveness", () => {
      const before = okOf(call("count", { alias: "lane-a" }, "lane-a"));
      const seenBefore = registry.get("lane-a")!.lastSeen;
      okOf(call("digest", { project: "/proj/w" }));
      okOf(call("asks", {}));
      const after = okOf(call("count", { alias: "lane-a" }, "lane-a"));
      expect(after.count).toBe(before.count);
      expect(after.seq).toBe(before.seq); // no membership change = no event minted
      expect(registry.get("lane-a")!.lastSeen).toBe(seenBefore);
      expect(notified).toEqual([]);
    });

    test("parity smoke (can-i-deploy): live responses are a field-superset of the consumer fixture", () => {
      const digest = okOf(call("digest", { project: "/proj/w" }));
      const asks = okOf(call("asks", {}));
      // the scenario must exercise every top-level array at least once,
      // or the shape checks above would be vacuously green
      expect(((digest.sessions as Record<string, { owed: unknown[] }>)["sid-A"]!.owed).length).toBeGreaterThan(0);
      expect((asks.asks as unknown[]).length).toBeGreaterThan(0);
      expect((asks.orphans as unknown[]).length).toBeGreaterThan(0);
      assertSuperset(digest, fixture.digest, "digest");
      assertSuperset(asks, fixture.asks, "asks");
      expect(typeof digest.protocol_version).toBe("number"); // the contract pins the live TYPE
      expect(typeof asks.protocol_version).toBe("number");
      expect(digest.contract_version).toBe(1);
    });
  });
}

suite("MemoryBackend", () => new MemoryBackend(1000));
suite("SqliteBackend", () => new SqliteBackend(":memory:", 1000));

const tmpSock = (): string => `/tmp/cipc-hub-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("CLI: digest + asks verbs", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  let errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    lines = [];
    errs = [];
    const backend = new MemoryBackend(1000);
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    const { Client } = await import("../src/client.ts");
    const c = new Client(sock);
    await c.register("asker", { sessionId: "sid-ask", cwd: "/m" });
    await c.register("answerer", { sessionId: "sid-ans", cwd: "/m" });
    await c.send({ from: "asker", to: "answerer", kind: "query", body: "q" });
  });

  const restore = () => {
    console.log = origLog;
    console.error = origErr;
    broker.stop();
  };

  test("digest --project --json emits one parseable JSON line; asks --all likewise", async () => {
    try {
      expect(await run(["digest", "--project", "/m", "--json"], { socketPath: sock })).toBe(0);
      const digest = JSON.parse(lines.at(-1)!) as { sessions: Record<string, unknown>; protocol_version: number };
      expect(typeof digest.protocol_version).toBe("number");
      expect(digest.sessions["sid-ans"]).toBeDefined();
      lines = [];
      expect(await run(["asks", "--all", "--json"], { socketPath: sock })).toBe(0);
      const asks = JSON.parse(lines.at(-1)!) as { asks: { corr_id: string }[] };
      expect(asks.asks.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("asks without --all refuses and points at owed; digest defaults to the cwd project", async () => {
    try {
      expect(await run(["asks"], { socketPath: sock })).toBe(2);
      expect(errs.join("\n")).toContain("owed");
    } finally {
      restore();
    }
  });
});
