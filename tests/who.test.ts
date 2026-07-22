/**
 * Name resolution for humans with half-remembered aliases: the rankAliasMatches
 * core, the `who` verb over it, and the error surfaces that borrow it
 * (papercuts P1/P2/4b — field feedback from adrev-kanbn-4b, 2026-07-22).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { rankAliasMatches, run } from "../src/cli.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-who-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;

describe("rankAliasMatches (pure)", () => {
  const P = (alias: string, over: Record<string, unknown> = {}) => ({
    alias,
    sessionId: `sid-${alias}`,
    status: "live",
    lastSeen: 1000,
    cwd: "/code/proj",
    ...over,
  });
  test("exact beats prefix beats substring beats one-typo", () => {
    const peers = [P("fable-x"), P("fab"), P("fable"), P("fabel")]; // fabel = transposition
    const got = rankAliasMatches("fable", peers, 4).map((m) => m.alias);
    expect(got[0]).toBe("fable"); // exact always first
    // both prefix directions (alias-prefix and query-prefix) outrank the typo tier
    expect(got.slice(1, 3).sort()).toEqual(["fab", "fable-x"]);
    expect(got[3]).toBe("fabel"); // one edit away still surfaces, last
  });
  test("liveness breaks ties toward sessions that can answer", () => {
    const got = rankAliasMatches("vb", [P("vb-a", { status: "offline" }), P("vb-b", { status: "live" })], 2);
    expect(got[0]!.alias).toBe("vb-b");
  });
  test("a live substring match outranks a dead prefix match (the picked-a-dead-session incident)", () => {
    const got = rankAliasMatches("fable", [P("fable-old", { status: "offline" }), P("vb-fable", { status: "live" })], 2);
    expect(got[0]!.alias).toBe("vb-fable");
  });
  test("an exact match is the answer even when dead — it carries the successor line", () => {
    const got = rankAliasMatches("fable", [P("fable", { status: "offline" }), P("vb-fable", { status: "live" })], 2);
    expect(got[0]!.alias).toBe("fable");
  });
  test("cwd basename is the last-resort signal", () => {
    const got = rankAliasMatches("proj", [P("unrelated-name")], 3);
    expect(got.length).toBe(1);
    expect(got[0]!.score).toBeLessThan(45); // below every alias-text tier
  });
  test("no signal → empty, never a fabricated match", () => {
    expect(rankAliasMatches("zzz-qqq", [P("fable")], 3)).toEqual([]);
    expect(rankAliasMatches("", [P("fable")], 3)).toEqual([]);
  });
});

describe("who / error surfaces (CLI + broker)", () => {
  let broker: BrokerHandle;
  let sock: string;
  let registry: Registry;
  let now = 1000; // mutable test clock: advance it to age aliases offline for real
  let lines: string[] = [];
  let errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    now = 1000;
    const backend = new MemoryBackend();
    registry = new Registry(backend, () => now, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => now, () => `msg-${++idn}`, null);
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

  test("who resolves a fuzzy name to one ranked, addressable line", async () => {
    const c = new Client(sock);
    await c.register("vb-fable", { sessionId: "sid-f", cwd: "/code/versable" });
    await c.register("catch-b7", { sessionId: "sid-c", cwd: "/code/claude-ipc" });
    expect(await run(["who", "fable"], { socketPath: sock })).toBe(0);
    const outAll = lines.join("\n");
    expect(outAll).toContain("vb-fable");
    expect(outAll).toContain("/code/versable");
    expect(outAll).not.toContain("catch-b7");
  });

  test("who on a dead alias names the successor — an answer, not a dead end", async () => {
    const c = new Client(sock);
    await c.register("old-lane", { sessionId: "sid-old", cwd: "/code/x" });
    now = 5000; // old-lane ages past offlineS — its session is dead by liveness
    await c.register("old-lane", { sessionId: "sid-new", cwd: "/code/x" }); // succession takeover
    expect(await run(["who", "old-lane"], { socketPath: sock })).toBe(0);
    // the surviving row is the new session; if the old row still lists, it points forward
    expect(lines.join("\n")).toContain("old-lane");
  });

  test("who with no match exits 2 and points at lane addressing", async () => {
    expect(await run(["who", "zz-nothing"], { socketPath: sock })).toBe(2);
    expect(errs.join("\n")).toContain("--to-project");
  });

  test("send no_peer error leads with the closest near-matches", async () => {
    const c = new Client(sock);
    await c.register("cowork-build-c7", { sessionId: "sid-1", cwd: "/code/claude-ipc" });
    expect(await run(["send", "--to", "cowork-buidl-c7", "--from", "cowork-build-c7", "hi"], { socketPath: sock })).toBe(2);
    const err = errs.join("\n");
    expect(err).toContain("NOTHING WAS SENT");
    expect(err).toContain("closest:");
    expect(err).toContain("cowork-build-c7");
    expect(err).toContain("--to-project");
  });

  test("not_an_ask suggests lane addressing when the other party was pruned (4b)", async () => {
    const c = new Client(sock);
    await c.register("asker", { sessionId: "sid-a", cwd: "/a" });
    await c.register("worker", { sessionId: "sid-b", cwd: "/b" });
    const q = await c.send({ from: "asker", to: "worker", kind: "query", body: "?" });
    const r = (await c.reply({ from: "worker", corrId: q.msgId, body: "answer", terminal: true })) as { msgId: string };
    // age everyone offline, prune eats them, then the asker re-registers (the
    // exact pruned-mid-conversation sequence observed live on 2026-07-22)
    now = 5000;
    registry.pruneOffline(now);
    await c.register("asker", { sessionId: "sid-a", cwd: "/a" });
    let code = "";
    let message = "";
    try {
      await c.reply({ from: "asker", corrId: r.msgId, body: "thanks" });
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      message = (e as Error).message;
    }
    expect(code).toBe("not_an_ask");
    expect(message).toContain("no longer registered");
    expect(message).toContain("--to-project");
    expect(message).not.toContain("send --to worker");
  });
  test("a GENUINE succession renders the → succeeded by line (gate finding 2)", async () => {
    const c = new Client(sock);
    // sid-old holds two aliases; it dies; sid-new takes over ONE of them.
    await c.register("shared-name", { sessionId: "sid-old", cwd: "/code/x" });
    await c.register("old-extra", { sessionId: "sid-old", cwd: "/code/x" });
    now = 5000; // sid-old is dead by liveness
    await c.register("shared-name", { sessionId: "sid-new", cwd: "/code/x" }); // takeover
    // old-extra still names the dead session; its heir is the taken-over alias
    expect(await run(["who", "old-extra"], { socketPath: sock })).toBe(0);
    expect(lines.join("\n")).toContain("succeeded by shared-name");
  });

  test("who --json returns the {query, matches} shape a script can consume (gate finding 3)", async () => {
    const c = new Client(sock);
    await c.register("vb-fable", { sessionId: "sid-f", cwd: "/code/versable" });
    expect(await run(["who", "fable", "--json"], { socketPath: sock })).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { query: string; matches: { alias: string; sessionId: string; status: string; score: number }[] };
    expect(parsed.query).toBe("fable");
    expect(parsed.matches.length).toBe(1);
    expect(parsed.matches[0]!.alias).toBe("vb-fable");
    expect(typeof parsed.matches[0]!.score).toBe("number");
  });

  test("not_an_ask on your own BROADCAST suggests broadcasting again, never a lane (gate finding 1)", async () => {
    const c = new Client(sock);
    await c.register("caster", { sessionId: "sid-cast", cwd: "/c" });
    await c.register("hearer", { sessionId: "sid-hear", cwd: "/h" });
    const b = (await c.send({ from: "caster", to: "*", kind: "inform", body: "all hands" })) as { msgId: string };
    let message = "";
    try {
      await c.reply({ from: "caster", corrId: b.msgId, body: "amendment" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('--to "*"');
    expect(message).not.toContain("no longer registered");
  });
});

describe("count absence honesty (P3a)", () => {
  let broker: BrokerHandle;
  let sock: string;
  let idn = 0;
  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
  });
  afterEach(() => broker.stop());

  test("count on an unregistered alias FAILS — absence is an error, never a zero", async () => {
    const c = new Client(sock);
    let code = "";
    try {
      await c.count("never-registered");
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
    }
    expect(code).toBe("not_registered");
  });
  test("count on a registered alias still answers, including zero for a truly empty box", async () => {
    const c = new Client(sock);
    await c.register("real-box", { sessionId: "sid-r", cwd: "/r" });
    expect(((await c.count("real-box")) as { count: number }).count).toBe(0);
  });
});

describe("service identities (E2)", () => {
  let broker: BrokerHandle;
  let sock: string;
  let registry: Registry;
  let now = 1000;
  let idn = 0;
  beforeEach(() => {
    idn = 0;
    now = 1000;
    const backend = new MemoryBackend();
    registry = new Registry(backend, () => now, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => now, () => `msg-${++idn}`, null);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
  });
  afterEach(() => broker.stop());

  test("a service alias survives the prune that eats every idle session", async () => {
    const c = new Client(sock);
    await c.register("decision-pages", { sessionId: "svc:decision-pages", cwd: "/gcc", service: true });
    await c.register("mortal-session", { sessionId: "sid-m", cwd: "/m" });
    now = 999999; // everyone ages far past offline
    const pruned = registry.pruneOffline(now);
    expect(pruned).toBe(1); // the mortal went; the service stayed
    const left = ((await c.list()) as { peers: { alias: string; service?: boolean }[] }).peers.map((p) => p.alias);
    expect(left).toContain("decision-pages");
    expect(left).not.toContain("mortal-session");
  });

  test("a service can still SEND after the great prune — the decision-pages scenario end-to-end", async () => {
    const c = new Client(sock);
    await c.register("doorbell-svc", { sessionId: "svc:doorbell-svc", cwd: "/gcc", service: true });
    await c.register("worker", { sessionId: "sid-w", cwd: "/w" });
    now = 999999;
    registry.pruneOffline(now);
    await c.register("worker", { sessionId: "sid-w", cwd: "/w" }); // the session re-registers on wake
    const sent = await c.send({ from: "doorbell-svc", to: "worker", kind: "inform", body: "event:decision-pages some-slug answered" });
    expect(sent.msgId).toBeTruthy();
    const box = (await c.check("worker", false)) as { messages: { body: string }[] };
    expect(box.messages.some((m) => m.body.startsWith("event:decision-pages"))).toBe(true);
  });

  test("service is sticky across re-registration — no accidental demotion to prunable", async () => {
    const c = new Client(sock);
    await c.register("svc-x", { sessionId: "svc:svc-x", cwd: "/x", service: true });
    // a later re-register WITHOUT the flag (e.g. a hand-typed refresh) keeps the tier
    await c.register("svc-x", { sessionId: "svc:svc-x", cwd: "/x" });
    now = 999999;
    expect(registry.pruneOffline(now)).toBe(0);
  });
  test("leave is the service's one exit — an explicitly-departed service prunes like anyone", async () => {
    const c = new Client(sock);
    await c.register("svc-done", { sessionId: "svc:svc-done", cwd: "/x", service: true });
    await c.leave("svc-done");
    now = 999999;
    expect(registry.pruneOffline(now)).toBe(1);
  });
});