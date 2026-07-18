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
  let backend: MemoryBackend;

  beforeEach(() => {
    idn = 0;
    backend = new MemoryBackend();
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

  // Boot-survey U5 — per-alias inbox reads hid sibling-alias mail (13 msgs sat
  // unread while the holder polled another alias). Bare `inbox` now sweeps every
  // alias this session holds, each row stamped with its own reply identity.
  test("bare inbox sweeps all of this session's aliases", async () => {
    const c = new Client(sock);
    await c.register("lane-a", { sessionId: "s-sweep", cwd: "/w" });
    await c.register("lane-b", { sessionId: "s-sweep", cwd: "/w" });
    await c.register("asker2", { sessionId: "s-ask2", cwd: "/q" });
    await c.send({ from: "asker2", to: "lane-a", kind: "query", body: "for a" });
    await c.send({ from: "asker2", to: "lane-b", kind: "inform", body: "for b" });
    lines = [];
    process.env.CLAUDE_IPC_ALIAS = "lane-a";
    try {
      expect(await run(["inbox"], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_IPC_ALIAS;
    }
    const parsed = JSON.parse(lines.join("\n")) as {
      messages: { toAlias: string; body: string; replyWith?: string }[];
    };
    const bodies = parsed.messages.map((m) => m.body);
    expect(bodies).toContain("for a");
    expect(bodies).toContain("for b"); // the sibling alias's mail is not invisible
    const qRow = parsed.messages.find((m) => m.body === "for a");
    expect(qRow?.replyWith).toContain("--from lane-a"); // reply identity matches the box
  });

  // The 2026-07-15 gate's bug-class, re-checked here: a broadcast lands in BOTH
  // sibling boxes of one session — the merged sweep must show it once, not twice.
  test("bare inbox shows a broadcast once even when both sibling boxes hold it", async () => {
    const c = new Client(sock);
    await c.register("dup-a", { sessionId: "s-dup", cwd: "/w" });
    await c.register("dup-b", { sessionId: "s-dup", cwd: "/w" });
    await c.register("caster", { sessionId: "s-cast", cwd: "/q" });
    await c.send({ from: "caster", to: "*", kind: "inform", body: "hear ye" });
    lines = [];
    process.env.CLAUDE_IPC_ALIAS = "dup-a";
    try {
      expect(await run(["inbox"], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_IPC_ALIAS;
    }
    const parsed = JSON.parse(lines.join("\n")) as { messages: { body: string }[] };
    expect(parsed.messages.filter((m) => m.body === "hear ye").length).toBe(1);
  });

  // Boot-survey U2 — a successor's first look at a dead box must say how much is
  // real mail vs broker chase noise (an inherited box read 2:1 noise, live).
  test("register names a predecessor's real mail separately from stale chase notices", async () => {
    const { makeMessage } = await import("../src/models.ts");
    const { sweepReplyDeadlines } = await import("../src/broker/sweeper.ts");
    const c = new Client(sock);
    await c.register("pred-chase-x", { sessionId: "s-pc", cwd: process.cwd() });
    const m = makeMessage({ id: "ask-c1", kind: "query", fromAlias: "someone", toAlias: "pred-chase-x", ts: 900, body: "?" });
    backend.append(m);
    backend.enqueue(m.id, "pred-chase-x");
    backend.openAwaiting(m.id, null, 50, 900);
    sweepReplyDeadlines(backend, () => 960, () => "msg-cc1", 200); // NUDGE joins the box
    await c.leave("pred-chase-x");
    process.env.CLAUDE_CODE_SESSION_ID = "sid-succ-chase";
    try {
      expect(await run(["register", "succ-chase-x"], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    expect(lines.join("\n")).toContain("pred-chase-x holds 1 (+1 chase notice");
  });

  // Design D2 — the CLI must forward --triage so the fold reaches the caller (the
  // router computes it; this pins the wiring the live smoke couldn't reach on the
  // old deployed broker).
  test("orphans --triage surfaces the folded/open split from the CLI", async () => {
    const c = new Client(sock);
    await c.register("d2boss", { sessionId: "s-d2boss", cwd: process.cwd() });
    await c.register("d2dead", { sessionId: "s-d2dead", cwd: process.cwd() });
    const old = await c.send({ from: "d2boss", to: "d2dead", kind: "request", body: "ship it" });
    const fresh = await c.send({ from: "d2boss", to: "d2dead", kind: "request", body: "hold" });
    await c.supersede(old.msgId, fresh.msgId, "d2boss");
    await c.leave("d2dead");
    lines = [];
    expect(await run(["orphans", "--project", process.cwd(), "--triage"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { orphans: { alias: string; pending: number; folded: number; open: number }[] };
    const row = parsed.orphans.find((o) => o.alias === "d2dead");
    expect(row?.pending).toBe(2);
    expect(row?.folded).toBe(1); // the superseded "ship it"
    expect(row?.open).toBe(1); // the live "hold"
  });

  // Design D1 (vb-opus, "the category I most want") — send-success proves the broker
  // took it, not that the peer got/woke on it, so senders hand-annotate every message
  // "sent not received." `sent <id>` surfaces the delivery-state ladder the broker
  // already tracks, per recipient, with honest labels (surfaced ≠ read).
  test("sent <id> reports per-recipient delivery state with honest labels", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await c.send({ from: "alice", to: "bob", kind: "query", body: "did you get this?" });
    // bob's wake claims it → delivered (not yet surfaced/read)
    await c.deliver("bob", "hook");
    lines = [];
    process.env.CLAUDE_IPC_ALIAS = "alice"; // sent is for messages YOU sent — run as the sender
    try {
      expect(await run(["sent", q.msgId], { socketPath: sock })).toBe(0);
    } finally {
      delete process.env.CLAUDE_IPC_ALIAS;
    }
    const outText = lines.join("\n");
    expect(outText).toContain("bob"); // the recipient
    expect(outText).toMatch(/delivered/i); // the state the broker tracked
    expect(outText.toLowerCase()).not.toMatch(/\bread\b/); // delivered is NOT read — honest
  });

  // Fix #9 (skeptical review) — `sent` is for messages YOU sent; a non-sender is refused
  // (and can't read a stranger's recipient list / delivery ladder through it).
  test("sent refuses a message you didn't send, pointing at status", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const q = await c.send({ from: "alice", to: "bob", kind: "query", body: "secret" });
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    process.env.CLAUDE_IPC_ALIAS = "bob"; // bob is the RECIPIENT, not the sender
    try {
      expect(await run(["sent", q.msgId], { socketPath: sock })).toBe(2);
    } finally {
      console.error = origErr;
      delete process.env.CLAUDE_IPC_ALIAS;
    }
    expect(errs.join("\n")).toContain("YOU sent");
    expect(errs.join("\n")).toContain("status"); // pointed at the right verb
  });

  test("sent <id> distinguishes an unclaimed (queued) recipient from a delivered one", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    await c.register("carol", { sessionId: "sC", cwd: "/c" });
    const m = await c.send({ from: "alice", to: "bob", kind: "inform", body: "for bob only" });
    await c.deliver("bob", "hook"); // bob claims; carol was never a recipient here
    // a separate message to carol that she never claims → stays queued
    const m2 = await c.send({ from: "alice", to: "carol", kind: "inform", body: "for carol" });
    lines = [];
    process.env.CLAUDE_IPC_ALIAS = "alice"; // run as the sender
    try {
      await run(["sent", m2.msgId], { socketPath: sock });
    } finally {
      delete process.env.CLAUDE_IPC_ALIAS;
    }
    expect(lines.join("\n")).toMatch(/queued|waits/i); // carol hasn't woken; honest, not "delivered"
    void m;
  });

  // Friction F1 (vb-fable) — `show` prints human text while `inbox` prints JSON, so
  // `show <id> | jq` silently emits nothing. A --json flag gives show a parseable shape.
  test("show --json emits parseable JSON with the full body", async () => {
    const c = new Client(sock);
    await c.register("alice", { sessionId: "sA", cwd: "/a" });
    await c.register("bob", { sessionId: "sB", cwd: "/b" });
    const long = "BODY-START " + "x".repeat(300) + " BODY-END";
    const q = await c.send({ from: "alice", to: "bob", kind: "query", body: long });
    lines = [];
    // --operator sees the body (party-scoping blanks it for a non-party caller,
    // same as the human `show`); --json is the shape under test.
    expect(await run(["show", q.msgId, "--json", "--operator"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { message: { id: string; body: string; kind: string } };
    expect(parsed.message.id).toBe(q.msgId);
    expect(parsed.message.body).toBe(long); // full body, not truncated
  });

  // Friction F2 (vb-fable) — `peers` emits one row PER ALIAS, so a 3-alias session is
  // three rows; you had to jq-dedupe by sessionId. --by-session collapses to one row
  // per session with the aliases inline (the per-alias/per-session theme, on the roster).
  test("peers --by-session gives one row per session with aliases inline", async () => {
    const c = new Client(sock);
    await c.register("multi-a", { sessionId: "s-multi", cwd: "/m" });
    await c.register("multi-b", { sessionId: "s-multi", cwd: "/m" });
    await c.register("multi-c", { sessionId: "s-multi", cwd: "/m" });
    await c.register("solo", { sessionId: "s-solo", cwd: "/s" });
    lines = [];
    expect(await run(["peers", "--by-session"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { peers: { sessionId: string; aliases: string[] }[] };
    expect(parsed.peers.length).toBe(2); // two sessions, not four aliases
    const multi = parsed.peers.find((p) => p.sessionId === "s-multi");
    expect(multi?.aliases.sort()).toEqual(["multi-a", "multi-b", "multi-c"]);
  });

  // Friction F3 (vb-fable) — register printed the full dead-predecessor digest on EVERY
  // call; three registers in a minute repeated the same 13 lines. Show it once per session.
  test("register prints the predecessor digest only once per session", async () => {
    const c = new Client(sock);
    await c.register("pred-once", { sessionId: "s-pred-once", cwd: process.cwd() });
    await c.register("mailer-once", { sessionId: "s-mailer-once", cwd: "/m" });
    await c.send({ from: "mailer-once", to: "pred-once", kind: "request", body: "owner directive" });
    await c.leave("pred-once");
    process.env.CLAUDE_CODE_SESSION_ID = "sid-succ-repeat";
    try {
      lines = [];
      await run(["register", "succ-once-a"], { socketPath: sock });
      const first = lines.join("\n");
      lines = [];
      await run(["register", "succ-once-b"], { socketPath: sock }); // same session, second register
      const second = lines.join("\n");
      expect(first).toContain("pred-once holds 1"); // first shows the digest
      expect(second).not.toContain("pred-once holds"); // second stays quiet
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  // Friction F4 (vb-opus, 2nd to hit shell-quoting truncation) — the positional-body
  // error must name --body-file, the byte-exact escape hatch that already exists.
  test("the positional-body error points at --body-file", async () => {
    const origErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
    try {
      expect(await run(["send", "--from", "alice", "--to", "bob", "--body", "x"], { socketPath: sock })).toBe(2);
    } finally {
      console.error = origErr;
    }
    expect(errs.join("\n")).toContain("--body-file");
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
