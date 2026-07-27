/**
 * The session-scope invariant: a personal mailbox belongs to a SESSION, not an
 * alias. A session can hold several aliases, so an op that reads only the one named
 * box leaves a sibling box invisible (the recurring bug this whole file guards).
 *
 * Every personal-mailbox op routes through one broker chokepoint (sessionBoxes).
 * The rule for the next surface: a new op that reads or delivers an alias's mailbox
 * gets a case below and must pass for a two-alias session, so a single-box read goes
 * red here rather than in a peer's bug report a week later.
 * Lineage and design in docs/notes/20260717-session-scope-consolidation.md.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

describe("session-scope invariant — personal mailbox ops span all of a session's aliases", () => {
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
  const reg = (alias: string, sid: string, cwd = "/w") => {
    const r = okOf(call("register", { alias, sessionId: sid, cwd }));
    tokens.set(alias, r.token as string);
  };

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend();
    registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null);
    // One session, two aliases (the vb-fable shape: a first name + a rebind).
    reg("lane-primary", "sid-lane");
    reg("lane-sibling", "sid-lane");
    reg("sender", "sid-sender");
    // Distinct mail to each of the session's two boxes.
    okOf(call("send", { from: "sender", to: "lane-primary", kind: "inform", body: "for-primary" }, "sender"));
    okOf(call("send", { from: "sender", to: "lane-sibling", kind: "query", body: "for-sibling" }, "sender"));
  });

  // The enumeration. Each op is called anchored on ONE alias (lane-primary) and must
  // surface BOTH boxes' mail. Add a row when a new personal-mailbox op lands.
  const bodiesOf = (r: Record<string, unknown>): string[] =>
    ((r.messages ?? []) as { body: string }[]).map((m) => m.body);

  test("check (inbox read) spans both boxes when anchored on one alias", () => {
    const bodies = bodiesOf(okOf(call("check", { alias: "lane-primary" }, "lane-primary")));
    expect(bodies).toContain("for-primary");
    expect(bodies).toContain("for-sibling"); // the sibling box's mail is not invisible
  });

  test("deliver (the WAKE path) claims both boxes — the vb-fable bug", () => {
    const bodies = bodiesOf(okOf(call("deliver", { alias: "lane-primary", via: "hook" }, "lane-primary")));
    expect(bodies).toContain("for-primary");
    expect(bodies).toContain("for-sibling"); // sibling mail now wakes the session
  });

  test("count sums both boxes (deduped)", () => {
    const n = okOf(call("count", { alias: "lane-primary" }, "lane-primary")).count as number;
    expect(n).toBe(2);
  });

  // A broadcast lands in EVERY box of the session; the union must show it ONCE.
  test("a broadcast to the session is not double-counted across sibling boxes", () => {
    okOf(call("send", { from: "sender", to: "*", kind: "inform", body: "to-everyone" }, "sender"));
    const check = bodiesOf(okOf(call("check", { alias: "lane-primary" }, "lane-primary")));
    expect(check.filter((b) => b === "to-everyone").length).toBe(1);
    const n = okOf(call("count", { alias: "lane-primary" }, "lane-primary")).count as number;
    expect(n).toBe(3); // for-primary + for-sibling + one broadcast, not two
  });

  // The cursor is session-scoped like the count it rides on: sibling-box events move it.
  test("count seq: an event on the SIBLING box moves the anchored alias's cursor", () => {
    const s0 = okOf(call("count", { alias: "lane-primary" }, "lane-primary")).seq as number;
    okOf(call("send", { from: "sender", to: "lane-sibling", kind: "inform", body: "sibling-event" }, "sender"));
    const s1 = okOf(call("count", { alias: "lane-primary" }, "lane-primary")).seq as number;
    expect(s1).toBeGreaterThan(s0);
  });

  // Anchoring on the OTHER sibling must give the identical session view.
  test("the view is identical regardless of which sibling alias anchors it", () => {
    const viaPrimary = bodiesOf(okOf(call("check", { alias: "lane-primary" }, "lane-primary"))).sort();
    const viaSibling = bodiesOf(okOf(call("check", { alias: "lane-sibling" }, "lane-sibling"))).sort();
    expect(viaSibling).toEqual(viaPrimary);
  });

  // Isolation still holds: a different session sees none of this session's mail.
  test("a different session's boxes are NOT swept in", () => {
    reg("outsider", "sid-outsider");
    okOf(call("send", { from: "sender", to: "outsider", kind: "inform", body: "for-outsider" }, "sender"));
    const bodies = bodiesOf(okOf(call("check", { alias: "lane-primary" }, "lane-primary")));
    expect(bodies).not.toContain("for-outsider");
  });
});
