import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { createTools } from "../src/tools.ts";
import { buildMcpServer } from "../src/mcpServer.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("ipc_* tools", () => {
  let broker: BrokerHandle;
  let alice: ReturnType<typeof createTools>;
  let bob: ReturnType<typeof createTools>;
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    broker = startBroker({ router, socketPath: tmpSock() });
    const client = new Client(broker.socketPath);
    alice = createTools(client, { alias: "alice", sessionId: "sA", cwd: "/a" });
    bob = createTools(client, { alias: "bob", sessionId: "sB", cwd: "/b" });
    await alice.ipc_register({});
    await bob.ipc_register({});
  });
  afterEach(() => broker.stop());

  test("query → reply through the tool layer", async () => {
    const sent = (await alice.ipc_send({ to: "bob", kind: "query", body: "base url?" })) as { msgId: string };
    const inbox = (await bob.ipc_check({ consume: false })) as { messages: { body: string }[] };
    expect(inbox.messages.map((m) => m.body)).toEqual(["base url?"]);
    await bob.ipc_reply({ corrId: sent.msgId, body: "localhost:3000" });
    const aInbox = (await alice.ipc_check({ consume: false })) as { messages: { body: string; corrId: string }[] };
    expect(aInbox.messages[0]?.body).toBe("localhost:3000");
    expect(aInbox.messages[0]?.corrId).toBe(sent.msgId);
  });

  test("ipc_send refuses a missing target (never inferred)", () => {
    expect(() => alice.ipc_send({ to: "", kind: "inform", body: "x" })).toThrow(/explicit/);
  });

  test("send retries with one operation id create one message", async () => {
    const first = (await alice.ipc_send({
      to: "bob",
      kind: "query",
      body: "only once",
      operationId: "tool-send-1",
      replyByS: 45,
    })) as { msgId: string; replyByS: number };
    const retry = (await alice.ipc_send({
      to: "bob",
      kind: "query",
      body: "only once",
      operationId: "tool-send-1",
      replyByS: 45,
    })) as { msgId: string; idempotentReplay: boolean };
    expect(retry.msgId).toBe(first.msgId);
    expect(retry.idempotentReplay).toBe(true);
    expect(first.replyByS).toBe(45);
    const inbox = (await bob.ipc_check()) as { messages: { id: string }[] };
    expect(inbox.messages.map((m) => m.id)).toEqual([first.msgId]);
    expect((await bob.ipc_check()) as { messages: unknown[] }).toEqual({ messages: expect.any(Array) });
  });

  test("reusing an operation id for different content is refused", async () => {
    await alice.ipc_send({ to: "bob", kind: "inform", body: "first", operationId: "tool-send-conflict" });
    await expect(
      alice.ipc_send({ to: "bob", kind: "inform", body: "different", operationId: "tool-send-conflict" }),
    ).rejects.toThrow(/operation_conflict/);
  });

  test("reusing an operation id with a different reply deadline is refused", async () => {
    await alice.ipc_send({
      to: "bob", kind: "query", body: "same body", operationId: "tool-deadline-conflict", replyByS: 30,
    });
    await expect(alice.ipc_send({
      to: "bob", kind: "query", body: "same body", operationId: "tool-deadline-conflict", replyByS: 90,
    })).rejects.toThrow(/operation_conflict/);
  });

  test("an omitted replay deadline reuses the stored effective deadline", async () => {
    const first = await alice.ipc_send({
      to: "bob", kind: "query", body: "same default", operationId: "tool-deadline-default",
    }) as { msgId: string; replyByS: number };
    const replay = await alice.ipc_send({
      to: "bob", kind: "query", body: "same default", operationId: "tool-deadline-default",
    }) as { msgId: string; replyByS: number; idempotentReplay: boolean };
    expect(replay).toMatchObject({ msgId: first.msgId, replyByS: first.replyByS, idempotentReplay: true });
  });

  test("project path normalization does not turn an idempotent retry into a conflict", async () => {
    const first = (await alice.ipc_send({
      to: "proj:/b/",
      kind: "inform",
      body: "normalized",
      operationId: "project-normalized",
    })) as { msgId: string };
    const retry = (await alice.ipc_send({
      to: "proj:/b/",
      kind: "inform",
      body: "normalized",
      operationId: "project-normalized",
    })) as { msgId: string; idempotentReplay: boolean };
    expect(retry).toMatchObject({ msgId: first.msgId, idempotentReplay: true });
  });

  test("managed hosts peek by default while existing hosts keep consuming", async () => {
    await alice.ipc_send({ to: "bob", kind: "inform", body: "legacy default" });
    expect(((await bob.ipc_check()) as { messages: unknown[] }).messages).toHaveLength(1);
    expect(((await bob.ipc_check()) as { messages: unknown[] }).messages).toHaveLength(0);

    const client = new Client(broker.socketPath);
    const codex = createTools(client, { alias: "codex", sessionId: "sC", cwd: "/c", managedHost: true });
    await codex.ipc_register({});
    await alice.ipc_send({ to: "codex", kind: "inform", body: "managed default" });
    expect(((await codex.ipc_check()) as { messages: unknown[] }).messages).toHaveLength(1);
    expect(((await codex.ipc_check()) as { messages: unknown[] }).messages).toHaveLength(1);
    await expect(codex.ipc_check({ consume: true })).rejects.toThrow(/lease \+ ack/);
    await expect(codex.ipc_check({ consume: 1 } as never)).rejects.toThrow(/lease \+ ack/);
    await expect(codex.ipc_check({ consume: "true" } as never)).rejects.toThrow(/lease \+ ack/);
    expect(((await codex.ipc_check()) as { messages: unknown[] }).messages).toHaveLength(1);

    await alice.ipc_send({ to: "proj:/c", kind: "request", body: "managed project" });
    await expect(codex.ipc_check_project({ project: "/c", consume: true })).rejects.toThrow(/lease \+ ack/);
    await expect(codex.ipc_check_project({ project: "/c", consume: 1 } as never)).rejects.toThrow(/lease \+ ack/);
    expect(((await codex.ipc_check_project({ project: "/c" })) as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("project, snooze, supersede, and orphan tools are wired", async () => {
    const first = (await alice.ipc_send({ to: "bob", kind: "query", body: "old" })) as { msgId: string };
    const second = (await alice.ipc_send({ to: "bob", kind: "inform", body: "new" })) as { msgId: string };
    await alice.ipc_supersede({ old: first.msgId, by: second.msgId });
    await bob.ipc_snooze({ msgId: first.msgId });
    const project = (await bob.ipc_check_project({ project: "/b" })) as { messages: unknown[] };
    expect(project.messages).toEqual([]);
    expect(await bob.ipc_orphans({ project: "/b", triage: true })).toBeDefined();
  });

  test("request accept and decline via tools", async () => {
    const r2 = (await alice.ipc_send({ to: "bob", kind: "request", body: "deploy" })) as { msgId: string };
    await bob.ipc_decline({ msgId: r2.msgId, reason: "no" });
    const aInbox = (await alice.ipc_check({ consume: false })) as {
      messages: { corrId: string; errorCode: string }[];
    };
    const declined = aInbox.messages.find((m) => m.corrId === r2.msgId);
    expect(declined?.errorCode).toBe("declined");
  });

  test("ipc_compose returns live peers excluding self", async () => {
    const res = (await alice.ipc_compose()) as { peers: { alias: string }[] };
    expect(res.peers.map((p) => p.alias)).toEqual(["bob"]); // alice (self) excluded
  });

  test("ipc_list and ipc_history", async () => {
    const peers = (await alice.ipc_list()) as { peers: { alias: string }[] };
    expect(peers.peers.map((p) => p.alias).sort()).toEqual(["alice", "bob"]);
    await alice.ipc_send({ to: "bob", kind: "inform", body: "note" });
    const hist = (await alice.ipc_history({ peer: "bob" })) as { messages: unknown[] };
    expect(hist.messages.length).toBeGreaterThan(0);
  });

  test("project inventory, counts, digest, and open asks are exposed", async () => {
    await alice.ipc_send({ to: "proj:/b", kind: "query", body: "who owns this?" });
    expect((await bob.ipc_projects()) as { projects: unknown[] }).toMatchObject({ projects: expect.any(Array) });
    expect((await bob.ipc_count({ project: "/b" })) as { count: number }).toMatchObject({ count: 1 });
    expect((await bob.ipc_digest({ project: "/b" })) as { sessions: unknown }).toHaveProperty("sessions");
    expect((await bob.ipc_asks()) as { asks: unknown[] }).toMatchObject({ asks: expect.any(Array) });
  });
});

describe("MCP server wiring", () => {
  test("buildMcpServer registers all tools without throwing", () => {
    const tools = createTools(new Client("/tmp/none.sock"), { alias: "x", sessionId: "s", cwd: "/x" });
    expect(() => buildMcpServer(tools)).not.toThrow();
  });
});
