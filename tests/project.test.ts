import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { sweepReplyDeadlines } from "../src/broker/sweeper.ts";
import { Client } from "../src/client.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const tmpTokens = (): string => mkdtempSync(join(tmpdir(), "cipc-tok-"));

// Project mailboxes: mail addressed to a directory tree, drained by whichever
// member session gets there first, inherited by successors, peekable by anyone.
describe("project mailboxes", () => {
  let broker: BrokerHandle;
  let backend: MemoryBackend;
  let owner: Client; // holds tokens for the member sessions
  let outsider: Client; // a session registered in an unrelated directory

  beforeEach(async () => {
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => 1000, () => `msg-${++n}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    owner = new Client(broker.socketPath, undefined, tmpTokens());
    outsider = new Client(broker.socketPath, undefined, tmpTokens());
    await owner.register("root-sess", { sessionId: "s1", cwd: "/work/repo" });
    await owner.register("fe-sess", { sessionId: "s2", cwd: "/work/repo/frontend" });
    await outsider.register("elsewhere", { sessionId: "s3", cwd: "/other/place" });
  });
  afterEach(() => broker.stop());

  test("project mail needs no registered peer and is drained by a member", async () => {
    const sent = await owner.send({ from: "root-sess", to: "proj:/work/repo", kind: "inform", body: "for the repo" });
    expect(sent.msgId).toBeDefined();
    expect(sent.recipients).toEqual(["proj:/work/repo"]);
    const got = await owner.deliverProject("/work/repo", "hook", "fe-sess");
    expect(got.messages.map((m: { body: string }) => m.body)).toEqual(["for the repo"]);
  });

  test("project mail excludes every alias of its sending session", async () => {
    await owner.register("root-sibling", { sessionId: "s1", cwd: "/work/repo" });
    const sent = await owner.send({ from: "root-sess", to: "proj:/work/repo", kind: "query", body: "who owns this?" });
    expect((await owner.checkProject("/work/repo", false, "root-sess")).messages).toEqual([]);
    expect((await owner.checkProject("/work/repo", false, "root-sibling")).messages).toEqual([]);
    expect((await owner.checkProject("/work/repo", false, "fe-sess")).messages.map((m: { id: string }) => m.id)).toEqual([sent.msgId]);

    await owner.register("root-late", { sessionId: "s1", cwd: "/work/repo" });
    expect((await owner.checkProject("/work/repo", false, "root-late")).messages).toEqual([]);
  });

  test("project chase and cancellation notices stay hidden from the sending session", async () => {
    const nudged = await owner.send({
      from: "root-sess", to: "proj:/work/repo", kind: "query", body: "status?", replyByS: 50,
    });
    sweepReplyDeadlines(backend, () => 1050, () => "msg-project-nudge", 200);
    expect((await owner.checkProject("/work/repo", false, "root-sess")).messages).toEqual([]);
    expect((await owner.checkProject("/work/repo", false, "fe-sess")).messages.map((m: { corrId: string }) => m.corrId))
      .toContain(nudged.msgId);

    const cancelled = await owner.send({
      from: "root-sess", to: "proj:/work/repo", kind: "request", body: "run it",
    });
    await owner.deliverProject("/work/repo", "hook", "fe-sess");
    await owner.cancel(cancelled.msgId, "root-sess");
    expect((await owner.checkProject("/work/repo", false, "root-sess")).messages).toEqual([]);
    expect((await owner.checkProject("/work/repo", false, "fe-sess")).messages.map((m: { corrId: string }) => m.corrId))
      .toContain(cancelled.msgId);
  });

  test("lineage both ways: a subdirectory session drains repo mail; repo root sees subdir mail", async () => {
    await owner.send({ from: "root-sess", to: "proj:/work/repo", kind: "inform", body: "root-addressed" });
    const feView = await owner.checkProject("/work/repo/frontend", false, "fe-sess");
    expect(feView.messages.map((m: { body: string }) => m.body)).toEqual(["root-addressed"]);

    await owner.send({ from: "fe-sess", to: "proj:/work/repo/frontend", kind: "inform", body: "fe-addressed" });
    const rootView = await owner.checkProject("/work/repo", false, "root-sess");
    expect(rootView.messages.map((m: { body: string }) => m.body)).toEqual(["fe-addressed"]);
  });

  test("anyone may peek; only members may consume", async () => {
    await owner.send({ from: "root-sess", to: "proj:/work/repo", kind: "inform", body: "open to read" });
    const peek = await outsider.checkProject("/work/repo", false, "elsewhere");
    expect(peek.messages.length).toBe(1); // visibility is open — no silo
    await expect(outsider.checkProject("/work/repo", true, "elsewhere")).rejects.toThrow(/unauthorized/);
    await expect(outsider.deliverProject("/work/repo", "hook", "elsewhere")).rejects.toThrow(/unauthorized/);
  });

  test("managed host capability disables consuming checks at the broker boundary", async () => {
    await owner.register("managed-member", {
      sessionId: "managed", cwd: "/work/repo", caps: ["codex", "ipc-host"],
    });
    await owner.send({ from: "fe-sess", to: "managed-member", kind: "inform", body: "direct" });
    await owner.send({ from: "fe-sess", to: "proj:/work/repo", kind: "inform", body: "project" });

    await expect(owner.register("managed-member", { sessionId: "ordinary", cwd: "/work/repo" }))
      .rejects.toThrow(/alias_taken/);
    await owner.register("managed-member", { sessionId: "managed", cwd: "/work/repo" });
    await owner.register("managed-sibling", { sessionId: "managed", cwd: "/work/repo" });
    await expect(owner.check("managed-member", true)).rejects.toThrow(/managed_consume/);
    await expect(owner.checkProject("/work/repo", true, "managed-member")).rejects.toThrow(/managed_consume/);
    await expect(owner.check("managed-sibling", true)).rejects.toThrow(/managed_consume/);
    await expect(owner.checkProject("/work/repo", true, "managed-sibling")).rejects.toThrow(/managed_consume/);
    expect((await owner.check("managed-member", false)).messages).toHaveLength(1);
    expect((await owner.checkProject("/work/repo", false, "managed-member")).messages).toHaveLength(1);
  });

  test("replying to a project ask consumes it for the whole project", async () => {
    const ask = await owner.send({ from: "root-sess", to: "proj:/work/repo", kind: "query", body: "who owns X?" });
    expect((await owner.countProject("/work/repo")).count).toBe(1);
    await owner.reply({ from: "fe-sess", corrId: ask.msgId, body: "fe does" });
    expect((await owner.countProject("/work/repo")).count).toBe(0); // no re-nag for other members
    const st = backend.deliveriesFor(ask.msgId).find((d) => d.toAlias === "proj:/work/repo");
    expect(st?.state).toBe("consumed");
  });

  test("successor inheritance: mail waits for a project with no live session", async () => {
    await owner.send({ from: "root-sess", to: "proj:/future/thing", kind: "inform", body: "waits for you" });
    const late = new Client(broker.socketPath, undefined, tmpTokens());
    await late.register("newcomer", { sessionId: "s9", cwd: "/future/thing" });
    const got = await late.deliverProject("/future/thing", "resume", "newcomer");
    expect(got.messages.map((m: { body: string }) => m.body)).toEqual(["waits for you"]);
  });

  test("trailing slashes collapse to one mailbox", async () => {
    await owner.send({ from: "root-sess", to: "proj:/work/repo/", kind: "inform", body: "canonical" });
    const boxes = (await owner.projects()).projects as { address: string; path: string; pending: number }[];
    expect(boxes).toEqual([{ address: "proj:/work/repo", path: "/work/repo", pending: 1 }]);
  });
});

// Orphan discoverability: a dead session's waiting mail must be findable by a
// successor, scoped to the project it belongs to.
describe("orphans", () => {
  let broker: BrokerHandle;
  let backend: MemoryBackend;
  let client: Client;
  let clock: number;

  beforeEach(async () => {
    clock = 1000;
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    let n = 0;
    const router = new Router(backend, registry, () => clock, () => `msg-${++n}`);
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath, undefined, tmpTokens());
  });
  afterEach(() => broker.stop());

  // Boot-survey U2 — an inherited dead box read 2:1 chase-noise over real mail, and
  // successors triage the nudges first. The orphan row now says how much is broker
  // bookkeeping (chases) so renderers can show "holds N real (+K chase notices)".
  test("orphan rows split broker chase notices from real mail", async () => {
    const { makeMessage } = await import("../src/models.ts");
    const { sweepReplyDeadlines } = await import("../src/broker/sweeper.ts");
    await client.register("dying", { sessionId: "d1", cwd: "/work/repo" });
    await client.register("asker", { sessionId: "d2", cwd: "/work/repo" });
    const m = makeMessage({ id: "ask-o1", kind: "query", fromAlias: "asker", toAlias: "dying", ts: clock, body: "still there?" });
    backend.append(m);
    backend.enqueue(m.id, "dying");
    backend.openAwaiting(m.id, null, 100, clock);
    sweepReplyDeadlines(backend, () => clock + 100, () => "msg-chase1", 200); // NUDGE lands in dying's box
    clock += 2000;
    await client.heartbeat("asker");
    const rows = (await client.orphans("/work/repo")).orphans as { alias: string; pending: number; chases?: number }[];
    expect(rows[0]!.alias).toBe("dying");
    expect(rows[0]!.pending).toBe(2);
    expect(rows[0]!.chases).toBe(1);
  });

  test("mail for an offline session surfaces as a project-scoped orphan; live sessions don't", async () => {
    await client.register("dying", { sessionId: "d1", cwd: "/work/repo" });
    await client.register("sender", { sessionId: "d2", cwd: "/work/repo" });
    await client.send({ from: "sender", to: "dying", kind: "inform", body: "left behind" });
    // sender stays fresh; "dying" ages past the offline window
    clock += 2000;
    await client.heartbeat("sender");
    const inRepo = (await client.orphans("/work/repo")).orphans as { alias: string; pending: number }[];
    expect(inRepo.map((o) => o.alias)).toEqual(["dying"]);
    expect(inRepo[0]!.pending).toBe(1);
    const elsewhere = (await client.orphans("/other")).orphans as unknown[];
    expect(elsewhere).toEqual([]);
  });
});
