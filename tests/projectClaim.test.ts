/**
 * Project mail is addressed to a directory, not a person.
 *
 * That one fact broke three things at once: accepting it changed nothing and said it
 * had, declining it settled the ask for every other member, and two sessions could
 * both take the same job. All of them come from a delivery row that has no room for
 * per-member state.
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { projectAddress } from "../src/projectAddress.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const PROJ = "/proj";

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
    };
  const reg = (alias: string, cwd = PROJ): void => {
    const r = call("register", { alias, sessionId: `s-${alias}`, cwd, pid: 1 });
    tokens.set(alias, r.result?.token as string);
  };
  const leave = (alias: string): void => void call("leave", { alias }, alias);
  const sendProject = (from: string, body: string): string => {
    const r = call("send", { from, to: projectAddress(PROJ), kind: "request", body }, from);
    return r.result?.msgId as string;
  };
  return { backend, call, reg, sendProject, leave };
}

describe("project work can be claimed, exactly once", () => {
  test("accepting project mail actually takes it — and says who has it", () => {
    const { call, reg, sendProject } = harness();
    reg("asker");
    reg("ann");
    const id = sendProject("asker", "someone run the migration");

    const r = call("accept", { alias: "ann", msgId: id }, "ann");
    expect(r.result?.accepted).toBe(true);
    expect(r.result?.claimedBy).toBe("ann"); // it changed something, and it says what
  });

  test("two sessions racing for the same job: exactly one wins", () => {
    const { call, reg, sendProject } = harness();
    reg("asker");
    reg("ann");
    reg("bob");
    const id = sendProject("asker", "someone run the migration");

    const first = call("accept", { alias: "ann", msgId: id }, "ann");
    const second = call("accept", { alias: "bob", msgId: id }, "bob");

    expect(first.result?.accepted).toBe(true);
    expect(second.result?.accepted).toBe(false); // NOT a cheerful {accepted:true} that changed nothing
    expect(second.result?.claimedBy).toBe("ann"); // and the loser is told who to leave it to
  });

  test("work somebody else claimed stops being owed by everyone else", () => {
    const { call, reg, sendProject } = harness();
    reg("asker");
    reg("ann");
    reg("bob");
    const id = sendProject("asker", "someone run the migration");
    call("accept", { alias: "ann", msgId: id }, "ann");

    const annSees = call("check", { project: PROJ }, "ann").result?.messages as { id: string }[];
    const bobSees = call("check", { project: PROJ }, "bob").result?.messages as { id: string }[];
    expect(annSees.map((m) => m.id)).toContain(id); // she took it; she owes the reply
    expect(bobSees.map((m) => m.id)).not.toContain(id); // he shouldn't be nagged about her job
  });
});

describe("a claim does not take the work to the grave", () => {
  test("if the claimer leaves without replying, the job comes back to the others", () => {
    const { call, reg, sendProject, leave } = harness();
    reg("asker");
    reg("ann");
    reg("bob");
    const id = sendProject("asker", "someone run the migration");

    call("accept", { alias: "ann", msgId: id }, "ann");
    // ann claimed it, then her session ends without ever replying.
    leave("ann");

    // The work must be visible and claimable again — a claim held by a session that is
    // gone is stale, not permanent. Otherwise it is a silent way to lose the job.
    const bobSees = call("check", { project: PROJ }, "bob").result?.messages as { id: string }[];
    expect(bobSees.map((m) => m.id)).toContain(id);

    const reclaim = call("accept", { alias: "bob", msgId: id }, "bob");
    expect(reclaim.result?.accepted).toBe(true);
    expect(reclaim.result?.claimedBy).toBe("bob");
  });
});

describe("declining project mail means 'not me', never 'nobody'", () => {
  test("a bystander stepping back leaves the ask open for the others", () => {
    const { call, reg, sendProject } = harness();
    reg("asker");
    reg("ann");
    reg("bob");
    const id = sendProject("asker", "someone run the migration");

    call("decline", { from: "ann", msgId: id, reason: "busy" }, "ann");

    const bobSees = call("check", { project: PROJ }, "bob").result?.messages as { id: string }[];
    expect(bobSees.map((m) => m.id)).toContain(id); // still his to take
    const annSees = call("check", { project: PROJ }, "ann").result?.messages as { id: string }[];
    expect(annSees.map((m) => m.id)).not.toContain(id); // but she is done with it
  });

  test("the sender is told someone PASSED, not that they were refused", () => {
    const { backend, call, reg, sendProject } = harness();
    reg("asker");
    reg("ann");
    const id = sendProject("asker", "someone run the migration");

    call("decline", { from: "ann", msgId: id, reason: "busy" }, "ann");

    const back = backend.pending("asker");
    const note = back.find((m) => (m.body ?? "").includes("PASSED"));
    expect(note).toBeDefined();
    expect(note?.errorCode).not.toBe("declined"); // nobody refused this — it is still open
    expect(backend.isAwaitingOpen(id)).toBe(true); // and it is still answerable
  });

  test("a DIRECT decline is still a real, terminal refusal", () => {
    const { backend, call, reg } = harness();
    reg("asker");
    reg("doer");
    const sent = call("send", { from: "asker", to: "doer", kind: "request", body: "do it" }, "asker");
    const id = sent.result?.msgId as string;

    call("decline", { from: "doer", msgId: id, reason: "not mine" }, "doer");

    expect(backend.pending("asker").some((m) => m.errorCode === "declined")).toBe(true);
    expect(backend.isAwaitingOpen(id)).toBe(false); // a direct ask really was refused
  });
});
