import { describe, test, expect } from "bun:test";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Registry } from "../src/broker/registry.ts";

/**
 * Liveness must not call a working session dead.
 *
 * Sessions heartbeat on tool calls, so one long turn stops the signal while the
 * process runs. With offlineS at 1800s, any agent thinking for over half an hour
 * decayed to "offline". On 2026-09-04 a fleet sweep read 2 of 6 sessions as live,
 * concluded the fleet had died, and told the owner so. Five were working.
 *
 * The entry already stored a pid that nothing consulted. It does now.
 */
describe("registry liveness", () => {
  const LIVENESS = { idleS: 300, offlineS: 1800 };
  const setup = (now: number) => {
    const backend = new MemoryBackend();
    return new Registry(backend, () => now, LIVENESS);
  };
  const statusOf = (reg: Registry, alias: string): string | undefined =>
    reg.list().find((p) => p.alias === alias)?.status;

  // process.pid is alive by construction. A pid this high is not in use.
  const ALIVE = process.pid;
  const DEAD = 0x7ffffffe;

  test("a working session with a stale heartbeat is idle, not offline", () => {
    const reg = setup(1000);
    reg.register("busy", { sessionId: "s1", cwd: "/tmp", pid: ALIVE });
    // Heartbeat ages past offlineS while the process keeps running.
    const later = setup(1000 + LIVENESS.offlineS + 60);
    later.register("busy", { sessionId: "s1", cwd: "/tmp", pid: ALIVE });
    (later as unknown as { entries: Map<string, { lastSeen: number }> }).entries.get("busy")!.lastSeen = 1000;
    expect(statusOf(later, "busy")).toBe("idle");
  });

  test("a genuinely dead session with the same stale heartbeat is offline", () => {
    const reg = setup(1000 + LIVENESS.offlineS + 60);
    reg.register("gone", { sessionId: "s2", cwd: "/tmp", pid: DEAD });
    (reg as unknown as { entries: Map<string, { lastSeen: number }> }).entries.get("gone")!.lastSeen = 1000;
    expect(statusOf(reg, "gone")).toBe("offline");
  });


  test("a fresh heartbeat from a running process is live", () => {
    const reg = setup(1000);
    reg.register("working", { sessionId: "s4", cwd: "/tmp", pid: ALIVE });
    expect(statusOf(reg, "working")).toBe("live");
  });

  test("no pid recorded keeps the old heartbeat-only behaviour", () => {
    const reg = setup(1000 + LIVENESS.offlineS + 60);
    reg.register("nopid", { sessionId: "s5", cwd: "/tmp", pid: null });
    (reg as unknown as { entries: Map<string, { lastSeen: number }> }).entries.get("nopid")!.lastSeen = 1000;
    expect(statusOf(reg, "nopid")).toBe("offline");
  });

  test("an explicit leave still sticks regardless of the process", () => {
    const reg = setup(1000);
    reg.register("polite", { sessionId: "s6", cwd: "/tmp", pid: ALIVE });
    reg.leave("polite");
    expect(statusOf(reg, "polite")).toBe("offline");
  });
});
