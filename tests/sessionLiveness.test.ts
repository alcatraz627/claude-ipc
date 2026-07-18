import { beforeEach, describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

// A1 — liveness is a property of the SESSION, not of whichever alias last wrote.
// One live session used to read `idle` under its new alias and `offline` under its
// old one simultaneously (vb-opus/catch-fbl-7c, 2026-07-14), because heartbeats
// touched only the side-file alias. A heartbeat through any alias now refreshes
// every alias of that session; only an explicit leave keeps an alias retired.
describe("A1 · heartbeats and registration refresh the whole session, not one alias", () => {
  let registry: Registry;
  let now: number;

  beforeEach(() => {
    now = 1000;
    registry = new Registry(new MemoryBackend(), () => now, { idleS: 300, offlineS: 1800 });
    registry.register("boot-name", { sessionId: "sid-1", cwd: "/w" });
    registry.register("session-name", { sessionId: "sid-1", cwd: "/w" }); // the dual-alias shape
    registry.register("stranger", { sessionId: "sid-2", cwd: "/x" });
  });

  test("a heartbeat through one alias refreshes its sibling — statuses can never split", () => {
    now = 3000; // both aliases 2000s stale → would read offline
    registry.heartbeat("session-name");
    expect(registry.get("session-name")?.status).toBe("live");
    expect(registry.get("boot-name")?.status).toBe("live"); // the sibling came along
    expect(registry.get("boot-name")?.lastSeen).toBe(3000);
    expect(registry.get("stranger")?.status).toBe("offline"); // other sessions untouched
  });

  test("registering a new alias also refreshes the session's existing aliases", () => {
    now = 3000;
    registry.register("third-name", { sessionId: "sid-1", cwd: "/w" });
    expect(registry.get("boot-name")?.lastSeen).toBe(3000);
    expect(registry.get("session-name")?.lastSeen).toBe(3000);
  });

  test("an explicitly LEFT alias stays retired — a sibling heartbeat must not resurrect it", () => {
    registry.leave("boot-name"); // deliberate retirement
    now = 3000;
    registry.heartbeat("session-name");
    expect(registry.get("boot-name")?.status).toBe("offline"); // the leave sticks
    expect(registry.get("session-name")?.status).toBe("live");
  });

  test("list() names each entry's sibling aliases, so a reader can see one session behind two names", () => {
    const entries = registry.list();
    const boot = entries.find((e) => e.alias === "boot-name");
    expect(boot?.sessionAliases?.sort()).toEqual(["boot-name", "session-name"]);
    const stranger = entries.find((e) => e.alias === "stranger");
    expect(stranger?.sessionAliases).toEqual(["stranger"]);
  });
});

// D3 — the roster tells the truth about WHAT it knows: liveness is heartbeat
// recency, not a process check, and a takeover of a dead session's alias is marked.
describe("D3 · roster liveness honesty", () => {
  let registry: Registry;
  let now: number;

  beforeEach(() => {
    now = 1000;
    registry = new Registry(new MemoryBackend(), () => now, { idleS: 300, offlineS: 1800 });
  });

  test("list() carries heartbeat age (sinceSeenS), so 'live' is legibly an inference", () => {
    registry.register("alice", { sessionId: "sA", cwd: "/w" });
    now = 1200; // 200s since last heartbeat — still 'live', but not fresh
    const e = registry.list().find((r) => r.alias === "alice");
    expect(e?.status).toBe("live");
    expect(e?.sinceSeenS).toBe(200); // the reader can judge freshness, not just the binary chip
  });

  test("a takeover of a DIFFERENT session's alias is marked as succession", () => {
    registry.register("vb-fable-c4", { sessionId: "old-sid", cwd: "/w" }); // predecessor holds it
    const tok = registry.tokenOf("vb-fable-c4")!; // the token lives in the shared per-user dir
    // the successor rebinds the name, presenting the token it found there (the real rebind)
    registry.register("vb-fable-c4", { sessionId: "new-sid", cwd: "/w" }, tok);
    const e = registry.list().find((r) => r.alias === "vb-fable-c4");
    expect(e?.sessionId).toBe("new-sid"); // the live holder
    expect(e?.succeededSid).toBe("old-sid"); // and it's marked as a takeover, not a fresh claim
  });

  test("re-registering your OWN alias is NOT a succession (same session)", () => {
    registry.register("solo", { sessionId: "sS", cwd: "/w" });
    const tok = registry.tokenOf("solo")!;
    registry.register("solo", { sessionId: "sS", cwd: "/w" }, tok); // same session, reconnect
    expect(registry.list().find((r) => r.alias === "solo")?.succeededSid).toBeUndefined();
  });
});
