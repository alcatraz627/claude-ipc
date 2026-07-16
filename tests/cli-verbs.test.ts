/**
 * The three verbs the field agents asked for: show (one readable message),
 * owed (every unanswered ask across ALL of a session's aliases + its project),
 * and feedback (the maintainer intake that outlives maintainer sessions).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { run } from "../src/cli.ts";
import { config } from "../src/config.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-cv-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const uniq = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 8)}`;

describe("CLI verbs: show / owed / feedback", () => {
  let broker: BrokerHandle;
  let sock: string;
  let backend: MemoryBackend;
  let lines: string[] = [];
  let errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    errs = [];
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    broker.stop();
  });

  test("show renders one message readably, party-scoping the body", async () => {
    const c = new Client(sock);
    const asker = uniq("cv-asker");
    const worker = uniq("cv-worker");
    await c.register(asker, { sessionId: uniq("sid"), cwd: "/a" });
    await c.register(worker, { sessionId: uniq("sid"), cwd: "/b" });
    const sent = await c.send({ from: asker, to: worker, kind: "query", body: "what broke?" });
    await c.reply({ from: worker, corrId: sent.msgId, body: "the flag parser" });

    expect(await run(["show", sent.msgId, "--operator"], { socketPath: sock })).toBe(0);
    const outAll = lines.join("\n");
    expect(outAll).toContain(`query · ${asker} → ${worker}`);
    expect(outAll).toContain("what broke?");
    expect(outAll).toContain("1 reply:");

    lines = [];
    // a non-party caller (this shell has no session identity) sees the body scoped
    expect(await run(["show", sent.msgId], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("hidden");
  });

  test("owed sweeps every sibling alias and the project mailbox, with reply commands", async () => {
    const c = new Client(sock);
    const sid = uniq("sid-owed");
    const a1 = uniq("cv-main");
    const a2 = uniq("cv-sibling");
    const peer = uniq("cv-peer");
    await c.register(a1, { sessionId: sid, cwd: process.cwd() });
    await c.register(a2, { sessionId: sid, cwd: process.cwd() });
    await c.register(peer, { sessionId: uniq("sid"), cwd: "/p" });
    await c.send({ from: peer, to: a2, kind: "request", body: "please run the batch" }); // owed by the SIBLING
    await c.send({ from: peer, to: `proj:${process.cwd()}`, kind: "query", body: "whose lane is this?" });

    expect(await run(["owed", "--as", a1], { socketPath: sock })).toBe(0);
    const outAll = lines.join("\n");
    expect(outAll).toContain(`${a2} owes ${peer}`);
    expect(outAll).toContain(`--from ${a2}`); // the ready-to-run reply names the addressed alias
    expect(outAll).toContain("this project owes");

    lines = [];
    // settle both asks — owed sweeps the INVOKING shell's cwd, so the project
    // ask above is visible to any alias run from here until someone answers it
    const req = backend.history({}).find((m) => m.kind === "request")!;
    const projQ = backend.history({}).find((m) => m.kind === "query")!;
    await c.reply({ from: a2, corrId: req.id, body: "done" });
    await c.reply({ from: a1, corrId: projQ.id, body: "mine" });
    const lone = uniq("cv-lone");
    await c.register(lone, { sessionId: uniq("sid"), cwd: "/elsewhere" });
    expect(await run(["owed", "--as", lone], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("nothing owed");
  });

  test("feedback files a [feedback] inform to the maintainer address; empties refused", async () => {
    const c = new Client(sock);
    const sender = uniq("cv-fb");
    await c.register(sender, { sessionId: uniq("sid"), cwd: "/x" });

    expect(await run(["feedback", "--from", sender, "the", "nudge", "is", "too shy"], { socketPath: sock })).toBe(0);
    const msg = backend.history({}).find((m) => m.body.startsWith("[feedback]"));
    expect(msg).toBeDefined();
    expect(msg!.toAlias).toBe(config.feedbackAddr);
    expect(msg!.body).toBe("[feedback] the nudge is too shy");
    expect(errs.join("\n")).toContain("next maintainer session");

    expect(await run(["feedback", "--from", sender], { socketPath: sock })).toBe(2);
    expect(errs.join("\n")).toContain("feedback needs a body");
  });
});
