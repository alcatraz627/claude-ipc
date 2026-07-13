/**
 * Chasing an unanswered ask — without ever claiming to know why it went unanswered.
 *
 * Replaces the ghost sweep, which told senders their peer "went offline". It could
 * not know that, and agents acted on it. Background: docs/notes/no-liveness-claims.md
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { sweepReplyDeadlines } from "../src/broker/sweeper.ts";
import { Client } from "../src/client.ts";
import { makeMessage } from "../src/models.ts";
import { projectAddress } from "../src/projectAddress.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const mkId = (() => {
  let n = 0;
  return () => `msg-d${++n}`;
})();

const REPLY_BY = 100;
const GRACE = 200;
const SENT_AT = 1000;

/** alice asks bob at t=1000, with a reply-by deadline. */
function seedAsk(backend: MemoryBackend, replyByS: number | null = REPLY_BY, to = "bob"): void {
  const m = makeMessage({ id: "ask-1", kind: "request", fromAlias: "alice", toAlias: to, ts: SENT_AT, body: "run it" });
  backend.append(m);
  backend.enqueue(m.id, to);
  backend.openAwaiting(m.id, null, replyByS, SENT_AT); // no ttl — the deadline sweep is the only closer
}

const noticeTo = (backend: MemoryBackend, alias: string, marker: string) =>
  backend.pending(alias).find((m) => m.kind === "response" && (m.body ?? "").includes(marker));

const sweep = (backend: MemoryBackend, at: number) => sweepReplyDeadlines(backend, () => at, mkId, GRACE);

describe("reply deadlines chase the ask, not the peer", () => {
  test("before the deadline, nobody is bothered", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    expect(sweep(backend, SENT_AT + REPLY_BY - 1)).toBe(0);
    expect(backend.getAwaiting("ask-1")?.closed).toBe(false);
  });

  test("at reply-by the RECIPIENT is nudged and the sender is left alone", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    sweep(backend, SENT_AT + REPLY_BY);

    expect(noticeTo(backend, "bob", "NUDGE")).toBeDefined();
    expect(noticeTo(backend, "alice", "NO REPLY YET")).toBeUndefined(); // their deadline hasn't passed
    expect(backend.getAwaiting("ask-1")?.closed).toBe(false); // still answerable
  });

  test("at reply-by + grace the sender is released and the ask is closed", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    sweep(backend, SENT_AT + REPLY_BY + GRACE);

    expect(noticeTo(backend, "bob", "LAST CALL")).toBeDefined();
    const release = noticeTo(backend, "alice", "NO REPLY YET");
    expect(release?.corrId).toBe("ask-1");
    expect(release?.status).toBe("ok"); // not a failure — nobody failed
    expect(release?.terminal).toBe(true); // resolves the sender's await
    expect(backend.getAwaiting("ask-1")?.closedReason).toBe("parked"); // the only closer of a no-TTL ask
  });

  test("no notice ever claims the peer is offline, dead, or gone", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    sweep(backend, SENT_AT + REPLY_BY + GRACE);

    const said = [...backend.pending("alice"), ...backend.pending("bob")].map((m) => (m.body ?? "").toLowerCase());
    for (const body of said) {
      expect(body).not.toContain("offline");
      expect(body).not.toContain("went dark");
      expect(body).not.toContain("won't reply");
    }
  });

  test("each stage fires exactly once, however often the sweeper runs", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    expect(sweep(backend, SENT_AT + REPLY_BY)).toBe(1); // the nudge
    expect(sweep(backend, SENT_AT + REPLY_BY + 1)).toBe(0); // not again
    expect(sweep(backend, SENT_AT + REPLY_BY + GRACE)).toBe(2); // last call + release
    expect(sweep(backend, SENT_AT + REPLY_BY + GRACE + 999)).toBe(0); // and never again
  });

  test("a sender who opted out is never chased, no matter how long it sits", () => {
    const backend = new MemoryBackend();
    seedAsk(backend, null); // --no-reply-expected
    expect(sweep(backend, SENT_AT + 100_000)).toBe(0);
    expect(backend.pending("bob").some((m) => (m.body ?? "").includes("NUDGE"))).toBe(false);
  });

  test("an answered ask is not chased", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    backend.closeAwaiting("ask-1", "responded");
    expect(sweep(backend, SENT_AT + REPLY_BY + GRACE)).toBe(0);
  });

  test("a snooze stops the nudging but does not move the SENDER's deadline", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    backend.deferNudge("ask-1", SENT_AT + REPLY_BY); // bob deferred it deliberately

    sweep(backend, SENT_AT + REPLY_BY + 1);
    expect(noticeTo(backend, "bob", "NUDGE")).toBeUndefined(); // they told us; stop nagging

    sweep(backend, SENT_AT + REPLY_BY + GRACE); // alice's own clock never moved
    expect(noticeTo(backend, "alice", "NO REPLY YET")).toBeDefined();
  });

  test("an ack buys the recipient another window, not silence forever", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    backend.deferNudge("ask-1", SENT_AT + 10); // acked early, before any nudge

    sweep(backend, SENT_AT + 10 + REPLY_BY - 1);
    expect(noticeTo(backend, "bob", "NUDGE")).toBeUndefined(); // inside the new window

    sweep(backend, SENT_AT + 10 + REPLY_BY);
    expect(noticeTo(backend, "bob", "NUDGE")).toBeDefined(); // window elapsed, ask again
  });

  test("the sender is told their peer acked, rather than being left to read silence", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    backend.deferNudge("ask-1", SENT_AT + 10); // "on it, 20 min"

    sweep(backend, SENT_AT + REPLY_BY + GRACE);
    const release = noticeTo(backend, "alice", "NO REPLY YET");
    expect(release?.body).toContain("DID acknowledge");
  });

  test("with no ack, the release does not invent one", () => {
    const backend = new MemoryBackend();
    seedAsk(backend);
    sweep(backend, SENT_AT + REPLY_BY + GRACE);
    expect(noticeTo(backend, "alice", "NO REPLY YET")?.body).not.toContain("DID acknowledge");
  });

  test("project mail is nudged in the project mailbox — nobody personally owes it", () => {
    const backend = new MemoryBackend();
    const proj = projectAddress("/repo");
    seedAsk(backend, REPLY_BY, proj);
    sweep(backend, SENT_AT + REPLY_BY);

    expect(noticeTo(backend, proj, "NUDGE")).toBeDefined(); // every member sees it; no one is named
  });
});

describe("a late reply still reaches the sender after the release", () => {
  let broker: BrokerHandle;
  let backend: MemoryBackend;
  let clock = 1000;
  let idn = 0;

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null, () => {}, {}, false, 100);
    broker = startBroker({ router, socketPath: tmpSock() });
  });
  afterEach(() => broker.stop());

  test("alice is released, bob answers anyway, and alice still gets the answer", async () => {
    const client = new Client(broker.socketPath);
    await client.register("alice", { sessionId: "sA", cwd: "/a" });
    await client.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await client.send({ from: "alice", to: "bob", kind: "request", body: "reset the test db" });

    clock += 5000;
    expect(sweepReplyDeadlines(backend, () => clock, () => `msg-${++idn}`, 200)).toBe(2);

    type Msg = { corrId?: string; body?: string };
    let inbox = (await client.check("alice")).messages as Msg[];
    expect(inbox.some((m) => (m.body ?? "").includes("NO REPLY YET") && m.corrId === q.msgId)).toBe(true);

    // Released is not closed. bob was always free to answer, and does.
    const r = await client.reply({ from: "bob", corrId: q.msgId, body: "done, db reset" });
    expect(r.late).toBe(true); // flagged late, NOT dropped
    inbox = (await client.check("alice")).messages as Msg[];
    expect(inbox.some((m) => m.body === "done, db reset")).toBe(true);
  });
});
