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

  // Owed-review MINOR 1 — flag validation is PER COMMAND, not one global set: a flag
  // real for a different verb must not be a silent no-op here.
  test("a flag valid for another command is rejected on this one (register --ttl)", async () => {
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    try {
      process.env.CLAUDE_CODE_SESSION_ID = "sid-flagcheck";
      expect(await run(["register", "carol", "--ttl", "5m"], { socketPath: sock })).toBe(2);
    } finally {
      console.error = origErr;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(errs.join("\n")).toContain("unknown flag for register: --ttl");
  });

  test("a genuinely valid flag still passes (register --tty)", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sid-tty-ok";
    try {
      expect(await run(["register", "dave", "--tty", "/dev/ttys001"], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  // vb-feedback: --body-file carries a code-bearing body (backticks, $()) that the
  // shell would eat from a positional arg — the delivered message must be byte-exact.
  test("send --body-file delivers the raw body, backticks intact", async () => {
    const { writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const c = new Client(sock);
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const path = join(tmpdir(), `cipc-body-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const raw = "run `git status` and $(echo hi) — both must survive";
    writeFileSync(path, raw);
    try {
      expect(await run(["send", "--from", "alice", "--to", "bob", "--body-file", path], { socketPath: sock })).toBe(0);
    } finally {
      rmSync(path, { force: true });
    }
    const got = (await c.check("bob")).messages.at(-1) as { body: string };
    expect(got.body).toBe(raw); // backticks and $() delivered verbatim
  });

  // Boot-survey U4a — the unknown-flag error used to enumerate COMMAND_FLAGS
  // verbatim, advertising --body as a real flag while the parser rejects it as
  // positional. The error must describe the documented interface.
  test("unknown-flag error does not advertise --body and names the positional body", async () => {
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    try {
      expect(await run(["send", "--nonsense", "hi"], { socketPath: sock })).toBe(2);
    } finally {
      console.error = origErr;
    }
    const out = errs.join("\n");
    expect(out).toContain("unknown flag for send: --nonsense");
    expect(out).not.toMatch(/--body[^-]/); // --body-file is real and may appear; bare --body must not
    expect(out).toContain("positional");
  });

  // Boot-survey U4b / Concern-6 belt — a register within edit-distance 1 of the CLI
  // name or another session's alias is the clade-ipc incident at birth. Warn (never
  // block): the register still succeeds, the warning names the near-match.
  test("register warns when the alias is one edit from the CLI name", async () => {
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_CODE_SESSION_ID = "sid-neartypo";
    try {
      expect(await run(["register", "clade-ipc"], { socketPath: sock })).toBe(0);
    } finally {
      console.error = origErr;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(lines.join("\n")).toContain('registered as "clade-ipc"');
    const warn = errs.join("\n");
    expect(warn).toContain("clade-ipc");
    expect(warn).toContain("claude-ipc");
    expect(warn).toContain("one edit");
  });

  test("register warns when the alias is one edit from a DIFFERENT session's alias", async () => {
    await new Client(sock).register("vb-opus", { sessionId: "s-other", cwd: "/o" });
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_CODE_SESSION_ID = "sid-nearpeer";
    try {
      expect(await run(["register", "vb-opsu"], { socketPath: sock })).toBe(0);
    } finally {
      console.error = origErr;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(errs.join("\n")).toContain("vb-opus");
  });

  test("register does NOT warn on its own session's sibling alias or a distant name", async () => {
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_CODE_SESSION_ID = "sid-selfsib";
    try {
      expect(await run(["register", "lane-alpha"], { socketPath: sock })).toBe(0);
      // rebind of the SAME session to a near name of its own alias: no warning
      expect(await run(["register", "lane-alphb"], { socketPath: sock })).toBe(0);
    } finally {
      console.error = origErr;
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(errs.join("\n")).toBe("");
  });

  // Boot-survey U1 — the corrId=null trap, live-proven: a query row in the inbox
  // JSON gives no signal that `reply` keys on the MESSAGE id, so agents answer
  // with a fresh send and the contract dangles. Every query/request row now
  // carries the exact reply command; informs and responses stay bare.
  test("inbox decorates queries with the exact reply command", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await c.send({ from: "alice", to: "bob", kind: "query", body: "need this?" });
    await c.send({ from: "alice", to: "bob", kind: "inform", body: "fyi only" });
    lines = [];
    expect(await run(["inbox", "bob"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as {
      messages: { id: string; kind: string; replyWith?: string }[];
    };
    const qRow = parsed.messages.find((m) => m.id === q.msgId);
    expect(qRow?.replyWith).toBe(`claude-ipc reply ${q.msgId} --from bob`);
    const iRow = parsed.messages.find((m) => m.kind === "inform");
    expect(iRow?.replyWith).toBeUndefined();
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
