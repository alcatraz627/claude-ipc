/**
 * Every flag a verb allowlists must observably DO something — reach the broker
 * in a captured request, or drive a local guard. Guards the certified-but-
 * unwired class (`send --body` silently dropped bodies for 44h; `count --alias`
 * was accepted-then-ignored). Golden argv→request capture, not source grep:
 * a grep is fooled by usage strings; a captured request cannot be.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { run } from "../src/cli.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-fw-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("flag wiring — every allowlisted flag observably does something", () => {
  let broker: BrokerHandle;
  let sock: string;
  let seen: Request[] = [];
  let scratch: string;
  const origLog = console.log;
  const origErr = console.error;
  let errs: string[] = [];
  let idn = 0;

  beforeEach(async () => {
    idn = 0;
    seen = [];
    errs = [];
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const real = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    // the spy IS the point: capture every request the CLI's argv layer produces
    const spy = {
      handle: (req: Request) => {
        seen.push(req);
        return real.handle(req);
      },
    } as unknown as Router;
    sock = tmpSock();
    broker = startBroker({ router: spy, socketPath: sock });
    scratch = mkdtempSync(join(tmpdir(), "ipc-fw-"));
    console.log = () => {};
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    };
    // a live peer to address, plus one owned message to act on
    const c = new Client(sock, undefined, join(scratch, "tokens"));
    await c.register("peer", { sessionId: "sid-peer", cwd: "/p" });
    await c.register("me", { sessionId: "sid-me", cwd: "/m" });
    await c.send({ from: "peer", to: "me", kind: "request", body: "act on this" }); // msg-1
    seen = [];
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    broker.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  const cli = (args: string[]) => run(args, { socketPath: sock });
  const captured = (op: string) => seen.filter((r) => r.op === op).map((r) => r.args as Record<string, unknown>);

  test("send: to/from/kind/ttl/reply-by reach the broker; no-reply-expected nulls the deadline", async () => {
    await cli(["send", "--to", "peer", "--from", "me", "--kind", "query", "--ttl", "90s", "--reply-by", "5m", "S1"]);
    const [a] = captured("send");
    expect(a).toMatchObject({ to: "peer", from: "me", kind: "query", ttlS: 90, replyByS: 300, body: "S1" });
    seen = [];
    await cli(["send", "--to", "peer", "--from", "me", "--kind", "query", "--no-reply-expected", "S2"]);
    expect(captured("send")[0]).toMatchObject({ replyByS: null });
  });

  test("send: body-file carries the file's bytes; --body is a loud guard, not a silent drop", async () => {
    const f = join(scratch, "b.txt");
    writeFileSync(f, "from the file");
    await cli(["send", "--to", "peer", "--from", "me", "--body-file", f]);
    expect(captured("send")[0]).toMatchObject({ body: "from the file" });
    seen = [];
    expect(await cli(["send", "--to", "peer", "--from", "me", "--body", "oops"])).toBe(2);
    expect(errs.join("\n")).toContain("positional");
    expect(captured("send").length).toBe(0); // refused before the broker
  });

  test("reply: from/corr/status/partial/body-file all observable; --body guarded", async () => {
    const f = join(scratch, "r.txt");
    writeFileSync(f, "the answer");
    await cli(["reply", "--corr", "msg-1", "--from", "me", "--partial", "--body-file", f]);
    expect(captured("reply")[0]).toMatchObject({ corrId: "msg-1", from: "me", terminal: false, body: "the answer" });
    seen = [];
    await cli(["reply", "msg-1", "--from", "me", "--status", "error"]);
    expect(captured("reply")[0]).toMatchObject({ status: "error" });
    seen = [];
    expect(await cli(["reply", "msg-1", "--from", "me", "--body", "oops"])).toBe(2);
    expect(errs.join("\n")).toContain("positional");
    expect(captured("reply").length).toBe(0);
  });

  test("inbox: alias/consume/project observable", async () => {
    await cli(["inbox", "--alias", "me", "--consume"]);
    expect(captured("check")[0]).toMatchObject({ alias: "me", consume: true });
    seen = [];
    await cli(["inbox", "--project", "/m"]);
    expect(captured("check")[0]).toMatchObject({ project: "/m" });
  });

  test("count: --alias reaches the broker (the live unwired-flag fixture) and --project too", async () => {
    await cli(["count", "--alias", "me"]);
    expect(captured("count")[0]).toMatchObject({ alias: "me" });
    seen = [];
    await cli(["count", "--project", "/m"]);
    expect(captured("count")[0]).toMatchObject({ project: "/m" });
  });

  test("orphans/prune/log/status flags reach the broker", async () => {
    await cli(["orphans", "--project", "/m"]);
    expect(captured("orphans")[0]).toMatchObject({ project: "/m" });
    await cli(["prune", "--offline-for", "2h"]);
    expect(captured("prune")[0]).toMatchObject({ offlineForS: 7200 });
    await cli(["log", "--peer", "peer", "--since", "5", "--operator"]);
    expect(captured("history")[0]).toMatchObject({ peer: "peer", since: 5, operator: true });
    seen = [];
    await cli(["log", "--all"]);
    expect(captured("history")[0]).toMatchObject({ operator: true });
    await cli(["status", "msg-1", "--operator"]);
    expect(captured("status")[0]).toMatchObject({ msgId: "msg-1", operator: true });
  });

  test("accept/decline/snooze --as and --reason; cancel --corr", async () => {
    await cli(["accept", "msg-1", "--as", "me"]);
    expect(captured("accept")[0]).toMatchObject({ alias: "me", msgId: "msg-1" });
    await cli(["snooze", "msg-1", "--as", "me"]);
    expect(captured("snooze")[0]).toMatchObject({ alias: "me", msgId: "msg-1" });
    await cli(["decline", "msg-1", "--as", "me", "--reason", "not mine"]);
    expect(captured("decline")[0]).toMatchObject({ from: "me", msgId: "msg-1", reason: "not mine" });
    await cli(["cancel", "--corr", "msg-1"]);
    expect(captured("cancel")[0]).toMatchObject({ corrId: "msg-1" });
  });

  test("register: --as and --tty reach the broker (needs a session id)", async () => {
    const prev = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "sid-fw-reg";
    try {
      await cli(["register", "--as", "fw-name", "--tty", "/dev/ttys009"]);
      expect(captured("register")[0]).toMatchObject({ alias: "fw-name", tty: "/dev/ttys009" });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prev;
    }
  });

  test("tail --once returns after one snapshot with --operator observable", async () => {
    expect(await cli(["tail", "--once", "--operator"])).toBe(0);
    expect(captured("history")[0]).toMatchObject({ operator: true });
  });

  // deliberately not covered: `compose --from` (interactive, needs a tty —
  // exercised by the compose flow itself), and verbs with empty allowlists.
});
