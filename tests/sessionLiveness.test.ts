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
