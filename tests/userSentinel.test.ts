/**
 * Walk-findings fixes: the `user` sentinel (the human owner's spoof-guarded
 * identity) and the acting-picker hygiene (dead aliases cut, session context
 * attached, the sentinel first).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { config } from "../src/config.ts";
import type { RegistryEntry } from "../src/models.ts";
import type { Request, Response } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { actingCandidates } from "../src/tui/identity.ts";

describe("the user sentinel — broker guard", () => {
  let router: Router;
  let registry: Registry;
  let clock = 1000;
  let idn = 0;
  const tokens = new Map<string, string>();

  const call = (op: string, args: Record<string, unknown>, as?: string) =>
    router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as unknown as Request);
  const okOf = (r: { ok: boolean; result?: unknown }) => {
    expect(r.ok).toBe(true);
    return r.result as Record<string, unknown>;
  };

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    tokens.clear();
    const backend = new MemoryBackend(1000);
    registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null);
  });

  test("a session cannot wear 'user' as its alias — the refusal names the real path", () => {
    const r = call("register", { alias: "user", sessionId: "sid-imposter" }) as Response;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("bad_args");
      expect(r.error.message).toContain("register user --service");
    }
  });

  test("the owner claims it as a service; it is then token-guarded and prune-exempt", () => {
    const r = okOf(call("register", { alias: "user", sessionId: "svc:user", service: true }));
    tokens.set("user", r.token as string);
    const row = registry.get("user")!;
    expect(row.service).toBe(true);
    // spoof-guard: a re-claim without the token bounces, even while "offline"
    const steal = call("register", { alias: "user", sessionId: "sid-thief", service: true }) as Response;
    expect(steal.ok).toBe(false);
    // prune-exempt: decades of silence never reap the sentinel
    clock += 10 * 24 * 3600;
    okOf(call("prune", { offlineForS: 1800 }));
    expect(registry.get("user")).not.toBeNull();
  });

  test("the sentinel can speak: a send from user delivers like any peer's", () => {
    const u = okOf(call("register", { alias: "user", sessionId: "svc:user", service: true }));
    tokens.set("user", u.token as string);
    const p = okOf(call("register", { alias: "agent-a", sessionId: "sid-a", cwd: "/w" }));
    tokens.set("agent-a", p.token as string);
    okOf(call("send", { from: "user", to: "agent-a", kind: "inform", body: "the human speaks" }, "user"));
    const box = okOf(call("check", { alias: "agent-a" }, "agent-a")) as { messages: { fromAlias: string }[] };
    expect(box.messages.map((m) => m.fromAlias)).toContain("user");
  });
});

describe("acting-picker hygiene", () => {
  const entry = (alias: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
    alias,
    sessionId: `sid-${alias}`,
    cwd: "/w",
    caps: [],
    pid: null,
    tty: null,
    lastSeen: 1000,
    status: "live",
    token: null,
    ...over,
  });
  const holdToken = (alias: string) => {
    writeFileSync(join(config.tokensDir, encodeURIComponent(alias)), "tok");
  };

  beforeEach(() => {
    mkdirSync(config.tokensDir, { recursive: true });
  });

  test("dead aliases are cut by default and count as hidden; toggle brings them back", () => {
    const peers = [
      entry("alive-1"),
      entry("dead-1", { status: "offline" }),
      entry("dead-2", { status: "offline" }),
    ];
    for (const p of peers) holdToken(p.alias);
    expect(actingCandidates(peers).map((c) => c.alias)).toEqual(["alive-1"]);
    expect(actingCandidates(peers, true).map((c) => c.alias)).toEqual(["alive-1", "dead-1", "dead-2"]);
  });

  test("an all-dead roster still offers the dead — an empty picker is a dead end", () => {
    const peers = [entry("dead-only", { status: "offline" })];
    holdToken("dead-only");
    expect(actingCandidates(peers).map((c) => c.alias)).toEqual(["dead-only"]);
  });

  test("the user sentinel outranks live sessions; rows carry session context", () => {
    const peers = [
      entry("busy-agent", { sinceSeenS: 5, sessionAliases: ["busy-agent", "busy-sibling"] }),
      entry("user", { service: true, status: "idle", sessionId: "svc:user" }),
    ];
    for (const p of peers) holdToken(p.alias);
    const [first, second] = actingCandidates(peers);
    expect(first!.alias).toBe("user");
    expect(first!.service).toBe(true);
    expect(second!.siblings).toEqual(["busy-sibling"]);
    expect(second!.cwd).toBe("/w");
  });

  test("an alias with no readable token is never offered — it could not act anyway", () => {
    const peers = [entry("tokenless-xyz")];
    expect(actingCandidates(peers, true)).toEqual([]);
  });
});
