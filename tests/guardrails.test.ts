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

describe("local visibility, but no cross-session transcript pointers", () => {
  test("the operator's log shows bodies — the whole point of a monitoring tool", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    call("send", { from: "alice", to: "bob", kind: "inform", body: "the build is green" }, "alice");

    // A human running `log`/`tail` from the shell holds no session token. Blanking bodies
    // for them (an earlier over-correction) made the monitor content-blind for its owner.
    const msgs = call("history", {}).result?.messages as { body: string }[];
    expect(msgs.some((m) => m.body === "the build is green")).toBe(true);
  });

  test("a message's transcript pointer is stripped for anyone not a party to it", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    reg("nosy");
    call(
      "send",
      { from: "alice", to: "bob", kind: "inform", body: "hi", contextPtr: { sessionId: "sA", transcriptPath: "/a.jsonl", cwd: "/a" } },
      "alice",
    );

    // A pointer to another session's whole transcript is the real cross-session leak.
    const mine = call("history", {}, "alice").result?.messages as { contextPtr: unknown }[];
    expect(mine[0]?.contextPtr).not.toBeNull(); // her own message keeps its pointer
    const theirs = call("history", {}, "nosy").result?.messages as { contextPtr: unknown }[];
    expect(theirs[0]?.contextPtr).toBeNull(); // a non-party never gets the transcript pointer
  });

  test("status is not a hard deny — it returns the lifecycle, pointer stripped for non-parties", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    reg("nosy");
    const sent = call("send", { from: "alice", to: "bob", kind: "query", body: "?" }, "alice");
    const id = sent.result?.msgId as string;

    expect(call("status", { msgId: id }, "nosy").ok).toBe(true); // visible, not refused
    expect(call("status", { msgId: id }, "alice").ok).toBe(true);
    expect(call("status", { msgId: id }).ok).toBe(true); // even the tokenless operator
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

describe("consent verbs refuse a message that isn't yours to act on", () => {
  test("accept / decline / snooze on a non-existent id are refused, not acked", () => {
    const { call, reg } = harness();
    reg("bob");
    // No message with this id exists. The verbs used to UPDATE zero rows and cheerfully
    // return {accepted:true}/{surfaced:true} — telling bob he consented to nothing.
    expect(call("accept", { alias: "bob", msgId: "msg-nope" }, "bob").ok).toBe(false);
    expect(call("decline", { from: "bob", msgId: "msg-nope" }, "bob").ok).toBe(false);
    expect(call("snooze", { alias: "bob", msgId: "msg-nope" }, "bob").ok).toBe(false);
  });

  test("you cannot accept a message delivered to someone else", () => {
    const { call, reg } = harness();
    reg("alice");
    reg("bob");
    reg("carol");
    const sent = call("send", { from: "alice", to: "bob", kind: "request", body: "do it" }, "alice");
    const id = sent.result?.msgId as string;

    expect(call("accept", { alias: "carol", msgId: id }, "carol").ok).toBe(false); // not carol's
    expect(call("accept", { alias: "bob", msgId: id }, "bob").ok).toBe(true); // bob's own
  });
});

describe("message ids have room to be unique", () => {
  test("the REAL generator emits 64 bits, not 32", async () => {
    // Test the actual mkId the broker uses, not a hand-copied duplicate — a duplicate
    // stays green while the real generator regresses. A collision dropped the new
    // message but still wrote its delivery row, handing the recipient the OLDER
    // message's content under the new id. Silent, and the worst failure a bus can have.
    const { newMessageId } = await import("../src/broker/server.ts");
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(newMessageId());
    expect(ids.size).toBe(5000);
    expect((newMessageId().replace("msg-", "")).length).toBe(16); // 16 hex = 64 bits
  });
});

describe("the watcher's poll does not repaint the user's tab", () => {
  test("a non-consuming peek does not notify; a consuming read does", () => {
    // check() fired the notifier on every peek, so the 10s watcher made the broker
    // repaint the session's badge forever, fighting whatever the user put there.
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const notified: string[] = [];
    let n = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`, null, (a) => notified.push(a));
    const reg = (alias: string) => {
      const r = router.handle({ v: 1, op: "register", args: { alias, sessionId: `s-${alias}`, cwd: "/w" } } as never) as {
        result?: { token: string };
      };
      return r.result?.token as string;
    };
    const tok = reg("bob");
    reg("alice");
    router.handle({ v: 1, op: "send", args: { from: "alice", to: "bob", kind: "inform", body: "hi" } } as never);
    notified.length = 0;

    router.handle({ v: 1, op: "check", args: { alias: "bob", consume: false }, token: tok } as never);
    expect(notified).toEqual([]); // a peek changes nothing → no repaint

    router.handle({ v: 1, op: "check", args: { alias: "bob", consume: true }, token: tok } as never);
    expect(notified).toContain("bob"); // a consuming read did change the mailbox
  });
});
