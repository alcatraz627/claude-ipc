/**
 * D2 — supersession + orphan triage. Mail order is not truth order: an inherited
 * instruction can be countermanded by a later one, and a successor peeking a dead box
 * had no cheap way to know. `supersede` records the relation; `orphans --triage` folds
 * the superseded arc (folds, never drops) so the successor sees the live tip.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

describe("supersede + triage — router level", () => {
  let backend: MemoryBackend;
  let registry: Registry;
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
  const codeOf = (r: { ok: boolean; error?: { code: string } }) => {
    expect(r.ok).toBe(false);
    return r.error!.code;
  };
  const reg = (alias: string, sid: string, cwd = "/w") => {
    const r = okOf(call("register", { alias, sessionId: sid, cwd }));
    tokens.set(alias, r.token as string);
  };
  const send = (from: string, to: string, body: string, kind = "inform"): string =>
    okOf(call("send", { from, to, kind, body }, from)).msgId as string;

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend();
    registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null);
    reg("boss", "s-boss", "/work");
    reg("worker", "s-worker", "/work");
  });

  test("supersede records a later message replacing an earlier one", () => {
    const old = send("boss", "worker", "ship it");
    clock += 60;
    const fresh = send("boss", "worker", "actually hold");
    okOf(call("supersede", { old, by: fresh, from: "boss" }, "boss"));
    expect(backend.supersededBy(old)).toBe(fresh);
  });

  test("a message cannot supersede a NEWER one (ts order enforced)", () => {
    const first = send("boss", "worker", "first");
    clock += 60;
    const second = send("boss", "worker", "second");
    // trying to say the OLDER message supersedes the NEWER is backwards
    expect(codeOf(call("supersede", { old: second, by: first, from: "boss" }))).toBe("bad_args");
    expect(backend.supersededBy(second)).toBeNull();
  });

  test("only a party to the SUPERSEDING message may set it", () => {
    const old = send("boss", "worker", "old");
    clock += 60;
    const fresh = send("boss", "worker", "new");
    // a stranger who sent neither cannot assert the supersession
    reg("stranger", "s-str", "/elsewhere");
    expect(codeOf(call("supersede", { old, by: fresh, from: "stranger" }, "stranger"))).toBe("unauthorized");
    expect(backend.supersededBy(old)).toBeNull();
  });

  // Review fix #2 — the caller must have SENT BOTH, not merely be a party to the
  // superseding one. This is the auth hole the gate found: folding mail you didn't send.
  test("you cannot supersede a message you did not SEND (only received)", () => {
    // boss asks worker (worker is a party as recipient, but did NOT send it)
    const owed = send("boss", "worker", "please ship");
    clock += 60;
    const workerLater = send("worker", "boss", "unrelated later note"); // worker's own later message
    // worker tries to fold the ask it OWES using its own later message → refused
    expect(codeOf(call("supersede", { old: owed, by: workerLater, from: "worker" }, "worker"))).toBe("unauthorized");
    expect(backend.supersededBy(owed)).toBeNull(); // the owed ask stays visible to a successor
  });

  // Review fix #6 — a message cannot supersede itself (would fold out of its own triage).
  test("a message cannot supersede itself", () => {
    const m = send("boss", "worker", "solo");
    expect(codeOf(call("supersede", { old: m, by: m, from: "boss" }, "boss"))).toBe("bad_args");
    expect(backend.supersededBy(m)).toBeNull();
  });

  // Review fix #4 — the WEAK fold must never hide an obligation: a later benign message
  // in a thread does NOT fold an earlier UNANSWERED request out of `open`.
  test("weak fold does not hide an unanswered request behind a later inform", () => {
    // two turns in ONE conversation: a request, then a later inform
    const ask = okOf(call("send", { from: "boss", to: "worker", kind: "request", body: "do X", conversationId: "thread-1" }, "boss")).msgId as string;
    clock += 60;
    okOf(call("send", { from: "boss", to: "worker", kind: "inform", body: "fyi, context", conversationId: "thread-1" }, "boss"));
    okOf(call("leave", { alias: "worker" }, "worker"));
    clock += 3000;
    const rows = okOf(call("orphans", { project: "/work", triage: true })).orphans as { alias: string; open: number; folded: number }[];
    const w = rows.find((r) => r.alias === "worker");
    expect(w?.folded).toBe(0); // the unanswered request is NOT weak-folded
    expect(w?.open).toBe(2); // both stay in the open count
    void ask;
  });

  test("orphans --triage folds an explicitly-superseded message and counts it apart", () => {
    // worker dies holding two messages, the first superseded by the second
    const old = send("boss", "worker", "ship it");
    clock += 60;
    const fresh = send("boss", "worker", "hold, do not ship");
    okOf(call("supersede", { old, by: fresh, from: "boss" }, "boss"));
    okOf(call("leave", { alias: "worker" }, "worker"));
    clock += 3000; // worker ages to offline

    const rows = okOf(call("orphans", { project: "/work", triage: true })).orphans as {
      alias: string;
      pending: number;
      folded: number;
      open: number;
    }[];
    const w = rows.find((r) => r.alias === "worker");
    expect(w?.pending).toBe(2);
    expect(w?.folded).toBe(1); // the superseded "ship it" is folded
    expect(w?.open).toBe(1); // the live "hold" tip remains
  });

  test("triage FOLDS, never DROPS — the superseded message is still in the box", () => {
    const old = send("boss", "worker", "ship it");
    clock += 60;
    const fresh = send("boss", "worker", "hold");
    okOf(call("supersede", { old, by: fresh, from: "boss" }, "boss"));
    // the folded message is still deliverable/peekable — a late reader sees everything
    const pending = backend.pending("worker").map((msg) => msg.id);
    expect(pending).toContain(old); // NOT removed by the supersede marker
  });

  test("without --triage, orphans is unchanged (no folded/open fields forced)", () => {
    send("boss", "worker", "hi");
    okOf(call("leave", { alias: "worker" }, "worker"));
    clock += 3000;
    const rows = okOf(call("orphans", { project: "/work" })).orphans as { alias: string; pending: number }[];
    expect(rows.find((r) => r.alias === "worker")?.pending).toBe(1);
  });
});
