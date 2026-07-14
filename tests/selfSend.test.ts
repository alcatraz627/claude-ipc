import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

// A2 — the self-send guard. A session that holds two aliases (a launch --name plus
// the session-id registration is the common way) could message itself: the broker
// accepted it, delivered it, then NUDGEd and LAST CALLed the session to answer its
// own question (live incident: msg-5c3df5b75a114e78, 2026-07-14). A send whose
// recipient resolves to the sender's own session must be refused up front.
describe("A2 · a send to your own session is refused", () => {
  let backend: MemoryBackend;
  let registry: Registry;
  let router: Router;
  let idn = 0;
  const tokens = new Map<string, string>();

  const reg = (alias: string, sessionId: string): void => {
    const res = router.handle({
      v: 1,
      op: "register",
      args: { alias, sessionId, cwd: "/w" },
    } as Request);
    if (!res.ok) throw new Error(`register ${alias} failed`);
    tokens.set(alias, (res.result as { token: string }).token);
  };

  const send = (from: string, to: string, kind = "query"): ReturnType<Router["handle"]> =>
    router.handle({ v: 1, op: "send", args: { from, to, kind, body: "hi" }, token: tokens.get(from) } as Request);

  beforeEach(() => {
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend();
    registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    reg("me-a", "sid-one");
    reg("me-b", "sid-one"); // same session, second alias — the vb-opus/catch-fbl-7c shape
    reg("peer", "sid-two");
  });

  test("direct send to a sibling alias of the same session fails self_send, delivers nothing", () => {
    const res = send("me-a", "me-b", "request");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("self_send");
    // nothing queued, nothing awaited — no nudge can ever chase this
    expect(backend.pending("me-b").length).toBe(0);
    expect(backend.openAwaitings().length).toBe(0);
  });

  test("send to your own exact alias is the same refusal", () => {
    const res = send("me-a", "me-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("self_send");
  });

  test("a genuine peer send still flows", () => {
    const res = send("me-a", "peer");
    expect(res.ok).toBe(true);
    expect(backend.pending("peer").length).toBe(1);
  });

  test("broadcast skips ALL of the sender's aliases, not just the from-alias", () => {
    const res = send("me-a", "*", "inform");
    expect(res.ok).toBe(true);
    const recipients = (res as { ok: true; result: { recipients: string[] } }).result.recipients;
    expect(recipients).toContain("peer");
    expect(recipients).not.toContain("me-b"); // sibling alias = still yourself
    expect(backend.pending("me-b").length).toBe(0);
    expect(backend.pending("peer").length).toBe(1);
  });

  test("the refusal names the sibling alias so the sender learns the topology", () => {
    const res = send("me-a", "me-b");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("me-b");
      expect(res.error.message).toContain("me-a");
    }
  });
});
