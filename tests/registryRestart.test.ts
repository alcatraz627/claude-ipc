/**
 * A broker restart must not kill the sessions that are still sitting there.
 *
 * Warm-starting every peer as "offline" could only be cleared by a turn, so a
 * session idling at its prompt stayed dead to us forever — senders were told it
 * "went offline" and broadcasts skipped it. Liveness is derived from lastSeen
 * now, never asserted from ignorance.
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const LIVENESS = { idleS: 300, offlineS: 1800 };
// pid 1 is launchd, which is always alive, so it read as a running session once
// liveness started consulting the process. These fixtures want a peer whose
// process is GONE, which is what an aged-out peer actually looks like.
const DEAD_PID = 0x7ffffffe;
const peer = (sessionId: string) => ({ sessionId, cwd: "/w", pid: DEAD_PID }) as never;

/** A registry that has been through a restart: same store, fresh instance. */
function restart(backend: MemoryBackend, now: () => number): Registry {
  return new Registry(backend, now, LIVENESS);
}

describe("registry survives a broker restart", () => {
  test("a session idling at its prompt is still reachable afterwards", () => {
    const backend = new MemoryBackend();
    let t = 10_000;
    const before = new Registry(backend, () => t, LIVENESS);
    before.register("idler", peer("s1"));

    t += 60; // broker restarts a minute later; the idle session took no turns
    const after = restart(backend, () => t);

    expect(after.list().find((e) => e.alias === "idler")?.status).toBe("live");
    expect(after.liveAliases()).toContain("idler");
  });

  test("a peer that has genuinely aged out still reads offline", () => {
    const backend = new MemoryBackend();
    let t = 10_000;
    const before = new Registry(backend, () => t, LIVENESS);
    before.register("ancient", peer("s1"));

    t += LIVENESS.offlineS + 1;
    const after = restart(backend, () => t);

    expect(after.list().find((e) => e.alias === "ancient")?.status).toBe("offline");
  });

  test("an explicit leave survives the restart", () => {
    const backend = new MemoryBackend();
    const t = 10_000;
    const before = new Registry(backend, () => t, LIVENESS);
    before.register("quitter", peer("s1"));
    before.leave("quitter");

    const after = restart(backend, () => t);

    expect(after.list().find((e) => e.alias === "quitter")?.status).toBe("offline");
    expect(after.liveAliases()).not.toContain("quitter");
  });

  test("a broadcast after a restart still reaches the live peers", () => {
    const backend = new MemoryBackend();
    let t = 10_000;
    const before = new Registry(backend, () => t, LIVENESS);
    before.register("a", peer("s1"));
    before.register("b", peer("s2"));
    before.leave("b");

    t += 30;
    const after = restart(backend, () => t);

    expect(after.liveAliases().sort()).toEqual(["a"]);
  });
});
