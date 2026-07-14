/**
 * Refusing an ask settles it, exactly as answering it does.
 *
 * decline() closed the awaiting but never consumed the delivery, so the decliner
 * kept getting turn-end reminders about a request they had already refused — and a
 * declined PROJECT ask stayed pending for every other member of that directory,
 * with no way for anyone to clear what someone else had declined.
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { projectAddress } from "../src/projectAddress.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const LIVENESS = { idleS: 300, offlineS: 1800 };
const PROJ = "/proj";

function harness() {
  const backend = new MemoryBackend();
  const registry = new Registry(backend, () => 1000, LIVENESS);
  let n = 0;
  const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`, 60);
  const tokens = new Map<string, string>();
  const call = (op: string, args: Record<string, unknown>, as?: string) =>
    router.handle({ v: 1, id: "r", op, args, token: as ? tokens.get(as) : undefined } as never) as {
      ok: boolean;
      result?: Record<string, unknown>;
    };
  const reg = (alias: string, sessionId: string): void => {
    const res = call("register", { alias, sessionId, cwd: PROJ, pid: 1 });
    tokens.set(alias, res.result?.token as string);
  };
  return { backend, router, reg, call };
}

describe("decline settles the ask", () => {
  test("a declined direct request stops counting as pending for the decliner", () => {
    const { reg, call, backend } = harness();
    reg("asker", "s1");
    reg("doer", "s2");

    const sent = call("send", { from: "asker", to: "doer", kind: "request", body: "do it" }, "asker");
    const msgId = sent.result?.msgId as string;
    expect(backend.pending("doer").length).toBe(1);

    call("decline", { from: "doer", msgId, reason: "not mine" }, "doer");

    // Settled by setConsent, which records the stronger fact — refused, not just read.
    expect(backend.pending("doer").map((m) => m.id)).not.toContain(msgId);
  });

  test("declining PROJECT mail is 'not me', so it stays open for the other members", () => {
    const { reg, call, backend } = harness();
    reg("asker", "s1");
    reg("member-a", "s2");
    reg("member-b", "s3");

    const proj = projectAddress(PROJ);
    const sent = call(
      "send",
      { from: "asker", to: proj, kind: "request", body: "someone take this" },
      "asker",
    );
    const msgId = sent.result?.msgId as string;
    expect(backend.pending(proj).map((m) => m.id)).toContain(msgId);

    call("decline", { from: "member-a", msgId, reason: "busy" }, "member-a");

    // An earlier version of this test asserted the opposite, and it was wrong: one
    // member stepping back cannot speak for a directory. The ask is still open, still
    // answerable, and member-b can still take it. Who no longer owes it is per-member
    // state now (see projectClaim.test.ts), not a consumed row.
    expect(backend.pending(proj).map((m) => m.id)).toContain(msgId);
    expect(backend.isAwaitingOpen(msgId)).toBe(true);
    expect(backend.projectStanding(msgId, "member-a")).toBe("passed");
    expect(backend.projectStanding(msgId, "member-b")).toBeNull();
  });

  test("the sender still gets the declined response", () => {
    const { reg, call, backend } = harness();
    reg("asker", "s1");
    reg("doer", "s2");

    const sent = call("send", { from: "asker", to: "doer", kind: "request", body: "do it" }, "asker");
    const msgId = sent.result?.msgId as string;
    call("decline", { from: "doer", msgId, reason: "not mine" }, "doer");

    const back = backend.pending("asker");
    expect(back.some((m) => m.corrId === msgId && m.errorCode === "declined")).toBe(true);
  });
});
