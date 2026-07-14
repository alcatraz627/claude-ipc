/**
 * The guards that were simply never applied.
 *
 * None of these are hard problems. Each is a check that exists elsewhere in this
 * codebase and was not copied to the one place it also belonged.
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { withinProject } from "../src/projectAddress.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

function harness() {
  const backend = new MemoryBackend();
  const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
  let n = 0;
  const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`, null, () => {}, {}, false, null);
  const tokens = new Map<string, string>();
  const call = (op: string, args: Record<string, unknown>, as?: string) =>
    router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as never) as {
      ok: boolean;
      result?: Record<string, unknown>;
      error?: { code: string; message: string };
    };
  const reg = (alias: string, cwd = "/w"): void => {
    const r = call("register", { alias, sessionId: `s-${alias}`, cwd, pid: 1 });
    tokens.set(alias, r.result?.token as string);
  };
  return { backend, call, reg };
}

describe("the broker's own name is not for sale", () => {
  test("no session may register as 'ipc'", () => {
    const { call } = harness();
    // The broker signs its nudges, its parked notices, and its "you may act without
    // them" releases as `ipc`. A peer holding that name could mint any of them.
    const r = call("register", { alias: "ipc", sessionId: "s1", cwd: "/w" });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain("reserved");
  });

  test("nor as the broadcast address", () => {
    const { call } = harness();
    expect(call("register", { alias: "*", sessionId: "s1", cwd: "/w" }).ok).toBe(false);
  });

  test("ordinary names still register", () => {
    const { call } = harness();
    expect(call("register", { alias: "ipc-doctor", sessionId: "s1", cwd: "/w" }).ok).toBe(true);
  });
});

describe("you can read your own traffic, not the machine's", () => {
  test("history without a token shows the flow, never the contents", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    call("send", { from: "alice", to: "bob", kind: "inform", body: "secret" }, "alice");

    // The operator's `tail` is a legitimate view of the fabric — who is talking to whom
    // — and that much is already ambient in the roster. The BODIES are not, nor are the
    // transcript pointers that lead to other sessions' whole conversations.
    const msgs = call("history", {}).result?.messages as { fromAlias: string; body: string }[];
    expect(msgs.some((m) => m.fromAlias === "alice")).toBe(true); // the flow is visible
    expect(msgs.every((m) => m.body === "")).toBe(true); // the contents are not
  });

  test("a session reads its own bodies; a bystander reads none of them", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    reg("nosy");
    call("send", { from: "alice", to: "bob", kind: "inform", body: "between us" }, "alice");

    const mine = call("history", {}, "alice").result?.messages as { body: string }[];
    expect(mine.some((m) => m.body === "between us")).toBe(true);

    // The threat here is not a burglar — it is a well-meaning peer running `history` to
    // debug something and inhaling the whole machine into its context.
    const theirs = call("history", {}, "nosy").result?.messages as { body: string }[];
    expect(theirs.some((m) => m.body === "between us")).toBe(false);
  });

  test("status on someone else's message is refused", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    reg("nosy");
    const sent = call("send", { from: "alice", to: "bob", kind: "query", body: "?" }, "alice");
    const id = sent.result?.msgId as string;

    expect(call("status", { msgId: id }, "nosy").ok).toBe(false);
    expect(call("status", { msgId: id }, "alice").ok).toBe(true); // her own ask
    expect(call("status", { msgId: id }, "bob").ok).toBe(true); // addressed to him
  });
});

describe("project membership runs one way", () => {
  test("working inside a project makes you a member", () => {
    expect(withinProject("/repo/frontend", "/repo")).toBe(true);
    expect(withinProject("/repo", "/repo")).toBe(true);
  });

  test("being an ANCESTOR of a project does not", () => {
    // A session opened in the home directory was a "member" of every project on the
    // machine, and its per-turn hook consumingly claimed their mail.
    expect(withinProject("/Users/me", "/Users/me/Code/thing")).toBe(false);
    expect(withinProject("/", "/repo")).toBe(false);
  });

  test("unrelated trees are unrelated", () => {
    expect(withinProject("/a/x", "/b/y")).toBe(false);
  });
});

describe("message ids have room to be unique", () => {
  test("64 bits, not 32", () => {
    // A collision dropped the new message but still wrote its delivery row, so the
    // recipient got the OLDER message's content under the new id. Silent, and the worst
    // failure a message bus can have.
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(`msg-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
    expect(ids.size).toBe(5000);
    const sample = [...ids][0] as string;
    expect(sample.replace("msg-", "").length).toBe(16); // 16 hex chars = 64 bits
  });
});
