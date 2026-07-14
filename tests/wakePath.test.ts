/**
 * The wake path, driven as a real process against a real broker.
 *
 * This is the only rung that can reach a session with no human at the keyboard, and
 * until now it had no tests at all — which is how it spent weeks polling a mailbox
 * nobody wrote to. Everything here spawns the actual watch-inbox.sh and reads what it
 * really prints, because every line it prints costs an LLM turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { SqliteBackend } from "../src/storage/sqliteBackend.ts";

const REPO = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO, "plugin/scripts/watch-inbox.sh");
const TICK = 1; // seconds — the watcher's poll interval under test

interface Rig {
  home: string;
  sock: string;
  broker: BrokerHandle;
  client: Client;
  env: Record<string, string>;
}

let rig: Rig;
const running: { proc: ReturnType<typeof Bun.spawn>; out: string[] }[] = [];

/** A broker + a CLI shim + an IPC home, all disposable. */
function makeRig(): Rig {
  const home = mkdtempSync(join(tmpdir(), "wake-"));
  mkdirSync(join(home, "run"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  const sock = join(home, "run", "t.sock");
  const db = join(home, "data", "t.sqlite");

  const backend = new SqliteBackend(db);
  const now = (): number => Math.floor(Date.now() / 1000);
  const registry = new Registry(backend, now, { idleS: 300, offlineS: 1800 });
  let n = 0;
  const router = new Router(backend, registry, now, () => `msg-w${++n}`, null, () => {}, {}, false, null);
  const broker = startBroker({ router, socketPath: sock });

  // The watcher shells out to `claude-ipc`; point it at the source CLI.
  const bin = join(home, "cipc");
  writeFileSync(bin, `#!/bin/sh\nexec bun run ${join(REPO, "src/cli.ts")} "$@"\n`);
  chmodSync(bin, 0o755);

  const env = {
    ...process.env,
    CLAUDE_IPC_HOME: home,
    CLAUDE_IPC_SOCKET: sock,
    CLAUDE_IPC_DB: db,
    CLAUDE_IPC_STRICT: "0",
    CLAUDE_IPC_BIN: bin,
    IPC_WATCH_INTERVAL: String(TICK),
  } as Record<string, string>;

  // Point the client's token store at the sandbox. Left at its default it writes
  // capability tokens into the REAL ~/.claude-ipc, where live agents are working —
  // a test must never be able to touch the running bus.
  return { home, sock, broker, client: new Client(sock, undefined, join(home, "tokens")), env };
}

/** Start the real watcher for a session id; collect every line it prints (each = one wake). */
function startWatcher(sid: string, extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: { ...rig.env, CLAUDE_CODE_SESSION_ID: sid, ...extraEnv },
    stdout: "pipe",
    stderr: "ignore",
  });
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      for (const line of dec.decode(chunk).split("\n")) if (line.trim()) out.push(line);
    }
  })();
  const rec = { proc, out };
  running.push(rec);
  return rec;
}

/** Bind a session id to an alias the way SessionStart does. */
function bindAlias(sid: string, alias: string): void {
  const dir = join(rig.home, "alias-by-sid");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sid), alias);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Wait for the watcher to emit a line matching `want`, or give up. */
async function waitForWake(rec: { out: string[] }, want: RegExp, ticks = 6): Promise<string | null> {
  for (let i = 0; i < ticks * 4; i++) {
    const hit = rec.out.find((l) => want.test(l));
    if (hit) return hit;
    await sleep((TICK * 1000) / 4);
  }
  return null;
}

beforeEach(() => {
  rig = makeRig();
});
afterEach(async () => {
  for (const r of running.splice(0)) r.proc.kill();
  rig.broker.stop();
});

describe("the wake path wakes an idle session", () => {
  test("a query wakes it, naming the sender and the message", async () => {
    await rig.client.register("bob", { sessionId: "s-bob", cwd: "/w" });
    bindAlias("s-bob", "bob");
    const w = startWatcher("s-bob");
    await sleep(TICK * 1500); // let it baseline

    await rig.client.send({ from: "alice", to: "bob", kind: "query", body: "is the migration safe?" });
    const wake = await waitForWake(w, /migration safe/);
    expect(wake).toBeTruthy();
    expect(wake).toContain("alice");
  }, 30_000);

  test("an inform does NOT wake it — a wake costs a turn, and nothing is owed", async () => {
    await rig.client.register("bob", { sessionId: "s-bob", cwd: "/w" });
    bindAlias("s-bob", "bob");
    const w = startWatcher("s-bob");
    await sleep(TICK * 1500);

    await rig.client.send({ from: "alice", to: "bob", kind: "inform", body: "fyi the build is green" });
    await sleep(TICK * 3000);
    expect(w.out.join("\n")).not.toContain("build is green");
  }, 30_000);

  test("a burst of mail costs ONE wake, not one per message", async () => {
    await rig.client.register("bob", { sessionId: "s-bob", cwd: "/w" });
    bindAlias("s-bob", "bob");
    const w = startWatcher("s-bob");
    await sleep(TICK * 1500);

    for (let i = 0; i < 5; i++) {
      await rig.client.send({ from: "alice", to: "bob", kind: "query", body: `burst ${i}` });
    }
    await waitForWake(w, /burst/);
    await sleep(TICK * 2000);
    expect(w.out.length).toBe(1); // the coalescing IS the rate limiter
  }, 30_000);

  test("mail already waiting at startup does not wake — SessionStart already handed it over", async () => {
    await rig.client.register("bob", { sessionId: "s-bob", cwd: "/w" });
    bindAlias("s-bob", "bob");
    await rig.client.send({ from: "alice", to: "bob", kind: "query", body: "pre-existing backlog" });

    const w = startWatcher("s-bob");
    await sleep(TICK * 4000);
    expect(w.out.join("\n")).not.toContain("pre-existing backlog");
  }, 30_000);

  test("it follows a rename, and inherits the adopted mailbox's unread mail", async () => {
    await rig.client.register("derived-1234", { sessionId: "s-bob", cwd: "/w" });
    await rig.client.register("ipc-doctor", { sessionId: "s-bob", cwd: "/w" });
    bindAlias("s-bob", "derived-1234");
    const w = startWatcher("s-bob");
    await sleep(TICK * 1500);

    // Mail lands in the mailbox the session is ABOUT to adopt (the orphan-inheritance case).
    await rig.client.send({ from: "alice", to: "ipc-doctor", kind: "query", body: "inherited work" });
    bindAlias("s-bob", "ipc-doctor"); // the rename

    const wake = await waitForWake(w, /inherited work/);
    expect(wake).toBeTruthy();
  }, 30_000);
});

describe("the wake path survives hostile identities", () => {
  test("a session renamed WITH A SPACE still wakes", async () => {
    // `/rename fix auth bug` is the most natural thing a human does. The alias the
    // registry stores and the alias the watcher polls must be the same string.
    const { sanitizeAlias } = await import("../src/aliasStore.ts");
    const alias = sanitizeAlias("fix auth bug") as string;

    await rig.client.register(alias, { sessionId: "s-sp", cwd: "/w" });
    bindAlias("s-sp", alias);
    const w = startWatcher("s-sp");
    await sleep(TICK * 1500);

    await rig.client.send({ from: "alice", to: alias, kind: "query", body: "spaced alias must wake" });
    const wake = await waitForWake(w, /spaced alias must wake/);
    expect(wake).toBeTruthy();
  }, 30_000);
});

describe("the alias a session registers is the alias the watcher polls", () => {
  test("for any hostile title, producer and consumer agree", async () => {
    // The two used to disagree by construction: the writer stored the title verbatim,
    // the watcher read it back with all whitespace deleted. Whatever we store must
    // survive the round trip byte-for-byte, or a session goes deaf and never says so.
    const { sanitizeAlias } = await import("../src/aliasStore.ts");
    const titles = [
      "fix auth bug",
      "ipc doctor",
      "  padded  ",
      "tabs\there",
      'quote"inside',
      "UPPER Case",
      "emoji 🚀 name",
      "trailing---",
      "a".repeat(120),
    ];
    for (const t of titles) {
      const alias = sanitizeAlias(t);
      if (!alias) continue; // rejected outright is fine — it falls back to the session id
      const asWatcherReads = alias.replace(/[\r\n]/g, ""); // what current_alias() does now
      expect(asWatcherReads).toBe(alias);
      expect(alias).not.toMatch(/\s/); // must survive being pasted into a shell command
      expect(alias.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("the watcher does not lie about itself", () => {
  test("it logs which mailbox it settled on — the question nobody could answer before", async () => {
    await rig.client.register("bob", { sessionId: "s-log", cwd: "/w" });
    bindAlias("s-log", "bob");
    startWatcher("s-log");
    await sleep(TICK * 2500);

    const log = join(rig.home, "logs", "watch-inbox-s-log.log");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("bob");
  }, 30_000);
});
