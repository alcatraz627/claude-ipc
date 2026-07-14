import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { run } from "../src/cli.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("CLI", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  const origLog = console.log;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    console.log = (...a: unknown[]): void => {
      lines.push(a.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = origLog;
    broker.stop();
  });

  test("daemon status reports the broker up", async () => {
    expect(await run(["daemon", "status"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("up");
  });

  test("send without --to fails with exit code 2", async () => {
    expect(await run(["send", "hello"], { socketPath: sock })).toBe(2);
  });

  test("peers lists a registered alias", async () => {
    await new Client(sock).register("alice", { sessionId: "sA", cwd: "/a" });
    expect(await run(["peers"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("alice");
  });

  // A3 — successor discoverability at the exact moment it matters. Owner directives
  // stranded in a dead lane's mailbox were only found when a peer said "go peek" by
  // hand (19 unread all day, 2026-07-14). Taking a name in a project now names the
  // dead boxes still holding mail, with the peek/claim commands ready to run.
  test("register surfaces a dead predecessor's unread mail in this project", async () => {
    const c = new Client(sock);
    await c.register("pred-lane-x", { sessionId: "s-pred", cwd: process.cwd() });
    await c.register("mailer-x", { sessionId: "s-mailer", cwd: "/m" });
    await c.send({ from: "mailer-x", to: "pred-lane-x", kind: "request", body: "owner directive needing ack" });
    await c.leave("pred-lane-x"); // the lane died with mail waiting
    process.env.CLAUDE_CODE_SESSION_ID = `sid-succ-${Math.random().toString(36).slice(2, 8)}`;
    try {
      expect(await run(["register", "succ-lane-x"], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    const outText = lines.join("\n");
    expect(outText).toContain("pred-lane-x holds 1");
    expect(outText).toContain("claude-ipc inbox pred-lane-x"); // the peek command, ready to run
  });

  test("send then inbox round-trips a message", async () => {
    await new Client(sock).register("bob", { sessionId: "sB", cwd: "/b" });
    await run(["send", "--from", "alice", "--to", "bob", "--kind", "inform", "hi", "there"], { socketPath: sock });
    lines = [];
    expect(await run(["inbox", "bob"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("hi there");
  });

  // b2b — a send to a name nobody registered is a discovery miss, not a silent
  // queue: exit 2, and the error names who IS reachable so a typo is easy to fix.
  test("send to an unregistered alias reports who's reachable (exit 2)", async () => {
    const c = new Client(sock);
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    await c.register("carol", { sessionId: "sC", cwd: "/c" });
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    try {
      expect(await run(["send", "--from", "alice", "--to", "ghost", "hello"], { socketPath: sock })).toBe(2);
    } finally {
      console.error = origErr;
    }
    const out = errs.join("\n");
    expect(out).toContain('no peer named "ghost"');
    expect(out).toContain("bob");
    expect(out).toContain("carol");
  });

  // Regression: --partial is a boolean flag and must NOT swallow the body that
  // follows it (it once consumed the first body word, leaving interim replies empty).
  test("reply --partial keeps the full body and is non-terminal", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await c.send({ from: "alice", to: "bob", kind: "query", body: "?" });
    await run(["reply", q.msgId, "--from", "bob", "--partial", "still", "working", "on", "it"], { socketPath: sock });
    const r = (await c.check("alice")).messages.find((m: { corrId: string }) => m.corrId === q.msgId);
    expect(r.terminal).toBe(false);
    expect(r.body).toBe("still working on it");
  });
});
