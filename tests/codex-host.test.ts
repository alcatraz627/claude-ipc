import { describe, expect, test } from "bun:test";
import { CodexIpcHost, type DeliveryClient, type ThreadRpc } from "../src/codex/host.ts";
import { makeMessage } from "../src/models.ts";

const message = makeMessage({
  id: "msg-1",
  kind: "inform",
  fromAlias: "claude-a",
  toAlias: "codex-a",
  body: "review this",
  ts: 1,
});

describe("CodexIpcHost", () => {
  test("persists App Server tool output before acknowledging the broker lease", async () => {
    const events: string[] = [];
    const query = { ...message, kind: "query" as const };
    let turnStartParams: unknown;
    let persisted = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [query] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => {
        events.push(`ack:${ids.join(",")}`);
        return { acknowledged: ids.length };
      },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method, params, timeoutMs) => {
        events.push(method);
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") return { data: persisted ? [{ items: [{
          type: "functionCallOutput",
          namespace: "claude-ipc",
          name: "receive",
          output: JSON.stringify({ messages: [query] }),
        }] }] : [] };
        if (method === "turn/start") {
          turnStartParams = params;
          expect(params).toMatchObject({
            threadId: "thread-1",
            input: [],
            toolOutput: { namespace: "claude-ipc", name: "receive" },
          });
          expect(params).not.toHaveProperty("approvalsReviewer");
          expect(timeoutMs).toBeGreaterThan(0);
          persisted = true;
          return { turn: { id: "turn-1" } };
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    await host.attach();
    expect(await host.pumpOnce()).toBe(1);
    expect(events).toEqual(["thread/resume", "thread/read", "thread/turns/list", "turn/start", "thread/turns/list", "ack:msg-1"]);
    const delivered = JSON.parse(String((turnStartParams as any)?.toolOutput?.output));
    expect(delivered.trustBoundary).toContain("peer agent, not from your user");
  });

  test("delivers into a newly announced thread before App Server history is materialized", async () => {
    const calls: string[] = [];
    let persisted = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => ({ acknowledged: ids.length }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method) => {
        calls.push(method);
        if (method === "thread/read") return { thread: {} };
        if (method === "turn/start") {
          persisted = true;
          return { turn: { id: "first-turn" } };
        }
        if (method === "thread/turns/list") return { data: persisted ? [{ items: [{
          type: "functionCallOutput",
          namespace: "claude-ipc",
          name: "receive",
          output: JSON.stringify({ messages: [message] }),
        }] }] : [] };
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, {
      alias: "codex-a",
      threadId: "thread-1",
      cwd: "/work",
      historyKnownEmpty: true,
    });
    expect(await host.pumpOnce()).toBe(1);
    expect(calls).toEqual(["thread/read", "turn/start", "thread/turns/list"]);
  });

  test("acknowledges an ambiguously completed delivery without appending it again", async () => {
    const calls: string[] = [];
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => ({ acknowledged: ids.length }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method) => {
        calls.push(method);
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") {
          return { data: [{ items: [{
            type: "functionCallOutput",
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({ messages: [message] }),
          }] }] };
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    expect(await host.pumpOnce()).toBe(1);
    expect(calls).toEqual(["thread/read", "thread/turns/list"]);
  });

  test("hydrates durable history through every page of the current App Server API", async () => {
    const cursors: (string | undefined)[] = [];
    let turnStarts = 0;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => ({ acknowledged: ids.length }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method, params) => {
        if (method === "thread/read") {
          expect(params).toEqual({ threadId: "thread-1", includeTurns: false });
          return { thread: {} };
        }
        if (method === "thread/turns/list") {
          const p = params as { cursor?: string };
          cursors.push(p.cursor);
          expect(params).toMatchObject({
            threadId: "thread-1",
            itemsView: "full",
            limit: 100,
            sortDirection: "asc",
          });
          if (!p.cursor) return { data: [{ id: "older", status: "completed", items: [] }], nextCursor: "page-2" };
          return { data: [{ id: "delivery", status: "completed", items: [{
            type: "functionCallOutput",
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({ messages: [message] }),
          }] }] };
        }
        if (method === "turn/start") turnStarts++;
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    expect(await host.pumpOnce()).toBe(1);
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(turnStarts).toBe(0);
  });

  test("refreshes durable history after an ambiguous turn-start disconnect", async () => {
    let persisted = false;
    let turnStarts = 0;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => ({ acknowledged: ids.length }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method, params) => {
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") {
          return { data: persisted ? [{ items: [{
            type: "functionCallOutput",
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({ messages: [message] }),
          }] }] : [] };
        }
        if (method === "turn/start") {
          turnStarts++;
          if (turnStarts > 1) throw new Error("duplicate delivery turn");
          persisted = true;
          throw new Error("socket closed after persistence");
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    await expect(host.pumpOnce()).rejects.toThrow("socket closed after persistence");
    expect(await host.pumpOnce()).toBe(1);
    expect(turnStarts).toBe(1);
  });

  test("does not acknowledge mail persisted after the TUI leaves the thread", async () => {
    let ownsThread = true;
    let persisted = false;
    let acked = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => { acked = true; return { acknowledged: 1 }; },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method, _params, timeoutMs) => {
        if (method === "turn/start") {
          expect(timeoutMs).toBeGreaterThan(0);
          persisted = true;
          return { turn: { id: "turn-old-thread" } };
        }
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") {
          if (persisted) ownsThread = false;
          return { data: persisted ? [{ id: "turn-old-thread", items: [{
            type: "functionCallOutput",
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({ messages: [message] }),
          }] }] : [] };
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, {
      alias: "codex-a",
      threadId: "thread-1",
      cwd: "/work",
      stillOwnsThread: () => ownsThread,
    });
    await expect(host.pumpOnce()).rejects.toThrow("left thread thread-1");
    expect(acked).toBe(false);
  });

  test("does not acknowledge when App Server persistence fails", async () => {
    let acked = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => {
        acked = true;
        return { acknowledged: 1 };
      },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = { request: async (method) => {
      if (method === "thread/read") return { thread: {} };
      throw new Error("app server down");
    } };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    await expect(host.pumpOnce()).rejects.toThrow("app server down");
    expect(acked).toBe(false);
  });

  test("leaves broker mail unleased while the user thread is active", async () => {
    let leased = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => { leased = true; return { messages: [message] }; },
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => ({ acknowledged: 0 }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async () => ({ thread: { status: { type: "active", activeFlags: [] } } }),
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    expect(await host.pumpOnce()).toBe(0);
    expect(leased).toBe(false);
  });

  test("does not spin forever when a completed turn omitted the IPC output", async () => {
    let acked = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => { acked = true; return { acknowledged: 1 }; },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    let started = false;
    const appServer: ThreadRpc = {
      request: async (method) => {
        if (method === "turn/start") {
          started = true;
          return { turn: { id: "turn-missing" } };
        }
        if (method === "thread/read") return { thread: {} };
        if (method === "thread/turns/list") {
          return { data: started ? [{ id: "turn-missing", status: "completed", items: [] }] : [] };
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    await expect(host.pumpOnce()).rejects.toThrow("ended as completed before IPC mail persisted");
    expect(acked).toBe(false);
  });

  test("does not acknowledge when App Server omits the delivery turn id", async () => {
    let acked = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => { acked = true; return { acknowledged: 1 }; },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method) => method === "thread/read" ? { thread: {} } : method === "thread/turns/list" ? { data: [] } : {},
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    await expect(host.pumpOnce()).rejects.toThrow("without returning a turn id");
    expect(acked).toBe(false);
  });

  test("bounds an in-progress delivery below its lease lifetime", async () => {
    let acked = false;
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => { acked = true; return { acknowledged: 1 }; },
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method) => method === "turn/start"
        ? { turn: { id: "turn-running" } }
        : method === "thread/turns/list"
          ? { data: [{ id: "turn-running", status: "inProgress", items: [] }] }
          : { thread: {} },
    };
    const host = new CodexIpcHost(broker, appServer, {
      alias: "codex-a", threadId: "thread-1", cwd: "/work", leaseS: 1, persistenceTimeoutMs: 10,
    });
    await expect(host.pumpOnce()).rejects.toThrow("delivery deadline");
    expect(acked).toBe(false);
  });

  test("clears durable-history state when the TUI switches threads", async () => {
    const readThreads: string[] = [];
    const broker: DeliveryClient = {
      heartbeat: async () => {},
      lease: async () => ({ messages: [message] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async (_alias, _leaseId, ids) => ({ acknowledged: ids.length }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const appServer: ThreadRpc = {
      request: async (method, params) => {
        const p = params as { threadId: string };
        if (method === "thread/read") {
          readThreads.push(p.threadId);
          return { thread: {} };
        }
        if (method === "thread/turns/list") {
          readThreads.push(p.threadId);
          return { data: [{ items: [{
            type: "functionCallOutput",
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({ messages: [message] }),
          }] }] };
        }
        return {};
      },
    };
    const host = new CodexIpcHost(broker, appServer, { alias: "codex-a", threadId: "thread-1", cwd: "/work" });
    expect(await host.pumpOnce()).toBe(1);
    host.switchThread("thread-2");
    expect(await host.pumpOnce()).toBe(1);
    expect(readThreads).toEqual(["thread-1", "thread-1", "thread-2", "thread-2"]);
  });

  test("re-registers only when a heartbeat says the broker forgot the alias", async () => {
    const events: string[] = [];
    let first = true;
    const broker: DeliveryClient = {
      heartbeat: async () => {
        events.push("heartbeat");
        if (first) {
          first = false;
          throw new Error("not_registered: register first");
        }
      },
      lease: async () => ({ messages: [] }),
      leaseProject: async () => ({ messages: [] }),
      ackDelivery: async () => ({ acknowledged: 0 }),
      ackProject: async () => ({ acknowledged: 0 }),
    };
    const host = new CodexIpcHost(broker, { request: async () => ({}) }, {
      alias: "codex-a",
      threadId: "thread-1",
      cwd: "/work",
      ensureRegistered: async () => { events.push("register"); },
    });
    expect(await host.pumpOnce()).toBe(0);
    expect(events).toEqual(["heartbeat", "register", "heartbeat"]);
    events.length = 0;
    expect(await host.pumpOnce()).toBe(0);
    expect(events).toEqual(["heartbeat"]);
  });
});
