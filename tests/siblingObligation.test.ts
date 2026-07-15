import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

// Residual bug from vb-opus (2026-07-15): reply-obligations were tracked per-alias.
// A query delivered to one alias, answered from a SIBLING alias of the same session,
// left the addressed alias's delivery pending forever — so the turn-end nudge kept
// firing about an already-answered ask. Wave-2 collapsed liveness by session but not
// obligations; this closes that gap.
describe("a reply from a sibling alias clears the obligation on the addressed alias", () => {
  let backend: MemoryBackend;
  let registry: Registry;
  let router: Router;
  let idn = 0;
  const tokens = new Map<string, string>();

  const reg = (alias: string, sessionId: string): void => {
    const r = router.handle({ v: 1, op: "register", args: { alias, sessionId, cwd: "/w" } } as Request);
    tokens.set(alias, (r as { result: { token: string } }).result.token);
  };
  const send = (from: string, to: string, kind = "query"): string => {
    const r = router.handle({ v: 1, op: "send", args: { from, to, kind, body: "?" }, token: tokens.get(from) } as Request);
    return (r as { result: { msgId: string } }).result.msgId;
  };
  const reply = (from: string, corrId: string): ReturnType<Router["handle"]> =>
    router.handle({ v: 1, op: "reply", args: { from, corrId, body: "answered" }, token: tokens.get(from) } as Request);
  const pendingIds = (alias: string): string[] => backend.pending(alias).map((m) => m.id);

  beforeEach(() => {
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend();
    registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    reg("vb-opus", "sid-1");
    reg("catch-fbl", "sid-1"); // sibling alias, same session
    reg("peer", "sid-2");
  });

  test("query to catch-fbl, answered from vb-opus, no longer shows on catch-fbl", () => {
    const q = send("peer", "catch-fbl", "query");
    expect(pendingIds("catch-fbl")).toContain(q); // delivered, owed
    const res = reply("vb-opus", q); // answered from the sibling
    expect(res.ok).toBe(true);
    expect(pendingIds("catch-fbl")).not.toContain(q); // obligation cleared for the whole session
  });

  test("a reply from a DIFFERENT session does NOT clear a stranger's obligation", () => {
    reg("stranger", "sid-3");
    const q = send("peer", "catch-fbl", "query");
    // stranger cannot even reply as catch-fbl (not its owner); a reply from stranger's
    // own alias to this corrId is not answering catch-fbl's delivered copy.
    reply("stranger", q);
    // catch-fbl's obligation stays until answered by its own session
    expect(pendingIds("catch-fbl")).toContain(q);
  });

  test("the ordinary case still works — reply from the SAME alias it was addressed to", () => {
    const q = send("peer", "vb-opus", "query");
    expect(pendingIds("vb-opus")).toContain(q);
    reply("vb-opus", q);
    expect(pendingIds("vb-opus")).not.toContain(q);
  });
});

describe("vb-feedback batch: body-file, kind=response hint, orphan age", () => {
  test("C — send --kind response is refused with a pointer to `reply`, not just the legal list", () => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => 1000, () => `m-${++n}`, 60);
    const r = router.handle({ v: 1, op: "register", args: { alias: "a", sessionId: "s", cwd: "/w" } } as never) as {
      result: { token: string };
    };
    router.handle({ v: 1, op: "register", args: { alias: "b", sessionId: "s2", cwd: "/w" } } as never);
    const res = router.handle({
      v: 1,
      op: "send",
      args: { from: "a", to: "b", kind: "response", body: "x" },
      token: r.result.token,
    } as never) as { ok: boolean; error?: { message: string } };
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("claude-ipc reply");
  });

  test("D — orphans carries oldestTs so a successor can weigh staleness", () => {
    const backend = new MemoryBackend();
    let now = 10_000;
    const registry = new Registry(backend, () => now, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => now, () => `m-${++n}`, 60);
    registry.register("dead", { sessionId: "sd", cwd: "/w" });
    // two messages to the (soon-dead) alias, one older than the other
    const older = { v: 1, op: "send", args: { from: "x", to: "dead", kind: "inform", body: "old" } } as never;
    router.handle(older);
    now = 20_000;
    router.handle({ v: 1, op: "send", args: { from: "x", to: "dead", kind: "inform", body: "new" } } as never);
    registry.leave("dead");
    now = 30_000;
    const res = router.handle({ v: 1, op: "orphans", args: {} } as never) as {
      result: { orphans: { alias: string; pending: number; oldestTs: number | null }[] };
    };
    const dead = res.result.orphans.find((o) => o.alias === "dead");
    expect(dead?.pending).toBe(2);
    expect(dead?.oldestTs).toBe(10_000); // the OLDER message's ts, the staleness anchor
  });
});
