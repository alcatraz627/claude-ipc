/**
 * The wake-path guards that shipped without a net.
 *
 * Each of these works and was verified live, but had no automated test — so a regression
 * would pass silently. They are the session's own safety properties, so they get a guard.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { railIfPeerMail } from "../src/cli.ts";
import { isRegisterRejection } from "../src/hooks/sessionStart.ts";

const SCRIPT = join(new URL("..", import.meta.url).pathname, "plugin/scripts/watch-inbox.sh");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the inbox stderr trust rail (an agent reading its mail from the shell)", () => {
  function captureStderr(fn: () => void): string {
    const orig = console.error;
    let out = "";
    console.error = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return out;
  }

  test("mail that ASKS something carries the peer-not-your-user boundary", () => {
    const out = captureStderr(() => railIfPeerMail({ messages: [{ kind: "query" }] }));
    expect(out.toLowerCase()).toContain("peer");
    const req = captureStderr(() => railIfPeerMail({ messages: [{ kind: "request" }] }));
    expect(req.toLowerCase()).toContain("peer");
  });

  test("mail that owes nothing (inform / response) gets no rail — a rail on every fyi is noise", () => {
    expect(captureStderr(() => railIfPeerMail({ messages: [{ kind: "inform" }] }))).toBe("");
    expect(captureStderr(() => railIfPeerMail({ messages: [{ kind: "response" }] }))).toBe("");
    expect(captureStderr(() => railIfPeerMail({ messages: [] }))).toBe("");
    expect(captureStderr(() => railIfPeerMail(null))).toBe("");
  });
});

describe("an orphaned watcher exits instead of polling forever", () => {
  test("when its session process dies, the watcher stops within a couple of ticks", async () => {
    const home = mkdtempSync(join(tmpdir(), "orph-"));
    mkdirSync(join(home, "alias-by-sid"), { recursive: true });
    writeFileSync(join(home, "alias-by-sid", "sO"), "bob");

    // A stand-in "session" the watcher will watch and we can kill on cue.
    const fakeSession = Bun.spawn(["sleep", "30"]);
    const watcher = Bun.spawn(["bash", SCRIPT], {
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: "sO",
        CLAUDE_IPC_HOME: home,
        IPC_WATCH_INTERVAL: "1",
        IPC_WATCH_SESSION_PID: String(fakeSession.pid),
        CLAUDE_IPC_BIN: "true", // no real broker needed; we only test the orphan exit
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    await sleep(1500); // let it start and settle on the session pid
    expect(watcher.killed).toBe(false);

    fakeSession.kill(); // the session is gone
    await sleep(4000); // a few poll intervals

    expect(watcher.exitCode !== null || watcher.killed).toBe(true); // it noticed and stopped
    watcher.kill(); // belt-and-suspenders cleanup
  }, 20_000);
});

describe("a refused registration means the alias isn't ours (fall back, don't go deaf)", () => {
  test("taken / reserved / unauthorized are refusals", () => {
    expect(isRegisterRejection(new Error("alias_taken: owned by another session"))).toBe(true);
    expect(isRegisterRejection(new Error('bad_args: "ipc" is reserved'))).toBe(true);
    expect(isRegisterRejection(new Error("unauthorized: not authorized"))).toBe(true);
  });

  test("a broker that is DOWN is NOT a refusal — ownership holds, the durable drain still runs", () => {
    // This is the load-bearing distinction: treating a connection error as a refusal would
    // make a session give up its own alias every time the broker blinked.
    expect(isRegisterRejection(new Error("broker did not reply within 5000ms"))).toBe(false);
    expect(isRegisterRejection(new Error("connection closed before a response"))).toBe(false);
    expect(isRegisterRejection("not even an error")).toBe(false);
    expect(isRegisterRejection(undefined)).toBe(false);
  });
});
