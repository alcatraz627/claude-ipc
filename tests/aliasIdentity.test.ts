import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAlias, readAliasForSession, writeAliasForSession } from "../src/aliasStore.ts";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { run } from "../src/cli.ts";
import { Client } from "../src/client.ts";
import { aliasFor, deliverContext } from "../src/hooks/shared.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const tmpSock = (): string => `/tmp/cipc-${process.pid}-${Math.random().toString(36).slice(2, 10)}.sock`;
const uid = (): string => `sid-${Math.random().toString(36).slice(2, 12)}`;

// P1 — the identity keystone. aliasFor() must resolve the friendly alias on EVERY
// hook (not just SessionStart), or mail addressed to the friendly name sits in a
// queue the per-turn hooks never poll. These exercise the real resolution path.
describe("P1 · alias resolution precedence (V1, V2, V6)", () => {
  afterEach(() => {
    delete process.env.CLAUDE_IPC_ALIAS;
  });

  test("V1 · session title becomes the alias (SessionStart sees session_title)", () => {
    const sid = uid();
    expect(aliasFor({ session_id: sid, session_title: "test-alias-x" })).toBe("test-alias-x");
  });

  test("V2 · a per-turn hook (no title in payload) resolves the title alias via the side-file", () => {
    const sid = uid();
    // SessionStart recorded the mapping; UserPromptSubmit/Stop never see the title.
    writeAliasForSession(sid, "test-alias-x");
    expect(readAliasForSession(sid)).toBe("test-alias-x");
    expect(aliasFor({ session_id: sid })).toBe("test-alias-x"); // reaches the same mailbox
  });

  test("V6 · no title and no side-file → a readable name derived from cwd + id, NOT the raw UUID", () => {
    // b2a: the last resort is no longer the unmemorable UUID; it's cwd-basename + id fragment.
    expect(aliasFor({ session_id: "4fd4ca0e-d3a8-4ee8", cwd: "/Users/x/.claude" })).toBe("claude-4fd4ca0e");
  });

  test("an explicit CLAUDE_IPC_ALIAS override wins over title and side-file", () => {
    const sid = uid();
    writeAliasForSession(sid, "from-file");
    process.env.CLAUDE_IPC_ALIAS = "override";
    expect(aliasFor({ session_id: sid, session_title: "from-title" })).toBe("override");
  });

  test("a whitespace-only title falls through to the derived name (not an empty alias)", () => {
    expect(aliasFor({ session_id: "9zzz-abcd", cwd: "/work/backend", session_title: "   " })).toBe("backend-9zzzabcd");
  });
});

// b2a — desk-name discovery. The derived default replaces the raw-UUID last resort
// so an unnamed session is addressable by something a human would type.
describe("b2a · deriveAlias (friendly default for an unnamed session)", () => {
  test("cwd basename + 8-char id fragment; a dotfile dir loses its leading dot", () => {
    expect(deriveAlias("/Users/x/.claude", "4fd4ca0e-d3a8")).toBe("claude-4fd4ca0e");
  });
  test("a multi-word directory keeps its kebab shape", () => {
    expect(deriveAlias("/srv/staging-enhancement-product", "ab12cd34")).toBe("staging-enhancement-product-ab12cd34");
  });
  test("deterministic — same inputs always derive the same name (so every hook agrees)", () => {
    expect(deriveAlias("/work/backend", "sid-xyz-99")).toBe(deriveAlias("/work/backend", "sid-xyz-99"));
  });
  test("two sessions in one directory stay distinct via their id fragment", () => {
    expect(deriveAlias("/work/backend", "aaaa-1")).not.toBe(deriveAlias("/work/backend", "bbbb-2"));
  });
  // C1 regression: 6 chars, not 4 — two UUIDs sharing a 4-char prefix but differing
  // by char 5-6 must NOT collide onto one derived name (that mis-routed mail).
  test("two ids sharing a 4-char prefix but differing at char 5-6 derive distinct names", () => {
    expect(deriveAlias("/work/backend", "4fd4ca0e-1111")).not.toBe(deriveAlias("/work/backend", "4fd4cb00-2222"));
  });
  test("no usable cwd → the id fragment alone; nothing usable → 'session'", () => {
    expect(deriveAlias(undefined, "7f7f-zzzz")).toBe("7f7fzzzz");
    expect(deriveAlias("/", "")).toBe("session");
  });
});

// C1 drain-guard: sessionStart must distinguish "alias owned by another session"
// (don't drain its mailbox) from "broker down" (degraded local drain is fine).
// This pins the error-message contract that gate reads.
describe("C1 · alias_taken is a distinguishable error (the drain-guard's signal)", () => {
  let broker: BrokerHandle;
  let sock: string;
  beforeEach(() => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => "m", 60);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
  });
  afterEach(() => broker.stop());

  test("a second session with no valid token for a live alias throws alias_taken", async () => {
    await new Client(sock).register("clash", { sessionId: "sA", cwd: "/a" }); // A mints + holds the token
    // B uses a separate tokensDir, so it cannot read A's token → presents none.
    const bTokens = mkdtempSync(join(tmpdir(), "cipc-btok-"));
    let msg = "";
    try {
      await new Client(sock, undefined, bTokens).register("clash", { sessionId: "sB", cwd: "/b" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg.startsWith("alias_taken")).toBe(true); // the exact prefix sessionStart's guard checks
  });
});

describe("P1 · delivery reaches the per-turn hook (V3 — the core defect)", () => {
  let broker: BrokerHandle;
  let client: Client;
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    broker = startBroker({ router, socketPath: tmpSock() });
    client = new Client(broker.socketPath);
  });
  afterEach(() => broker.stop());

  test("V3 · peer sends to the friendly alias; the UUID-only hook still drains it", async () => {
    const sid = uid();
    // SessionStart's effect: register under the friendly alias + record the side-file.
    await client.register("backend", { sessionId: sid, cwd: "/work/backend" });
    writeAliasForSession(sid, "backend");
    await client.register("cli", { sessionId: "s-cli", cwd: "/x" });

    // A peer addresses the friendly name — the exact flow that silently parked mail before.
    await client.send({ from: "cli", to: "backend", kind: "query", body: "base url?" });

    // The per-turn hook only knows the raw session id; aliasFor bridges to "backend".
    const ctx = await deliverContext(client, aliasFor({ session_id: sid }), "hook");
    expect(ctx).toContain("base url?");
    expect(ctx).toContain("claude-ipc reply");
    // idempotent: a second turn does not re-inject the consumed delivery
    expect(await deliverContext(client, aliasFor({ session_id: sid }), "hook")).toBeNull();
  });
});

describe("P1 · CLI register rebinds the current session (V4)", () => {
  let broker: BrokerHandle;
  let sock: string;
  let lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  let errs: string[] = [];
  let idn = 0;

  beforeEach(() => {
    idn = 0;
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => 1000, { idleS: 300, offlineS: 1800 });
    const router = new Router(backend, registry, () => 1000, () => `msg-${++idn}`, 60);
    sock = tmpSock();
    broker = startBroker({ router, socketPath: sock });
    lines = [];
    errs = [];
    console.log = (...a: unknown[]): void => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]): void => void errs.push(a.map(String).join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    broker.stop();
  });

  test("V4 · with CLAUDE_CODE_SESSION_ID set, rebinds THAT session — no phantom cli- row", async () => {
    const sid = uid();
    process.env.CLAUDE_CODE_SESSION_ID = sid;
    expect(await run(["register", "renamed"], { socketPath: sock })).toBe(0);

    const peers = (await new Client(sock).list()).peers as { alias: string; sessionId: string }[];
    const renamed = peers.find((p) => p.alias === "renamed");
    expect(renamed?.sessionId).toBe(sid); // bound to the REAL session, not cli-renamed
    expect(peers.some((p) => p.alias === "cli-renamed")).toBe(false); // no synthetic orphan row
    expect(readAliasForSession(sid)).toBe("renamed"); // side-file rewritten → per-turn hooks follow
  });

  test("V4 · without CLAUDE_CODE_SESSION_ID it refuses with a clear error (exit 2)", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    expect(await run(["register", "renamed"], { socketPath: sock })).toBe(2);
    expect(errs.join("\n")).toContain("CLAUDE_CODE_SESSION_ID");
  });
});
