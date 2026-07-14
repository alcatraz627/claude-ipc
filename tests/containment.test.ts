/**
 * The two failures that make every other bug irrelevant.
 *
 * One kills the bus for every agent on the machine; the other locks a human out of
 * their own session. Both were unguarded, and both fail in the direction that looks
 * like normal operation until it doesn't.
 */

import { describe, expect, test } from "bun:test";
import { Registry } from "../src/broker/registry.ts";
import { sweepOnce } from "../src/broker/server.ts";
import { applyPush, decidePush, type PushDecision } from "../src/hooks/stop.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const LIVENESS = { idleS: 300, offlineS: 1800 };

describe("housekeeping cannot take the broker down", () => {
  function rig(breakIt: (b: MemoryBackend) => void) {
    const backend = new MemoryBackend();
    breakIt(backend);
    const registry = new Registry(backend, () => 1000, LIVENESS);
    const errors: string[] = [];
    return {
      run: () =>
        sweepOnce({
          backend,
          registry,
          now: () => 1000,
          mkId: () => "msg-x",
          onError: (what) => errors.push(what),
        }),
      errors,
    };
  }

  test("a corrupt row in the TTL sweep does not kill the process", () => {
    const { run, errors } = rig((b) => {
      b.awaitingPastTtl = () => {
        throw new Error("disk full");
      };
    });
    expect(() => run()).not.toThrow(); // used to propagate straight out of setInterval
    expect(errors).toContain("ttl-park/purge");
  });

  test("a failure in one job does not cancel the others", () => {
    const { run, errors } = rig((b) => {
      b.purge = () => {
        throw new Error("corrupt");
      };
      b.openAwaitings = () => {
        throw new Error("also corrupt");
      };
    });
    run();
    // Both failed and BOTH were reported — one bad job must not silently eat the rest.
    expect(errors).toContain("ttl-park/purge");
    expect(errors).toContain("reply-deadlines");
  });

  test("a healthy sweep reports no errors (the guard is not swallowing real work)", () => {
    const { run, errors } = rig(() => {});
    run();
    expect(errors).toEqual([]);
  });
});

describe("the turn-end push cannot wedge a session", () => {
  const block: PushDecision = { kind: "block", reason: "alice is waiting", mark: ["msg-1"] };

  test("it blocks when it can record that it blocked", () => {
    const out = applyPush(block, () => true);
    expect(out.kind).toBe("block");
  });

  test("it does NOT block when the marker cannot be written", () => {
    // A marker that never lands means the ask reads as fresh forever, so blocking here
    // would re-block every single turn — the human locked out of their own session.
    const out = applyPush(block, () => false);
    expect(out.kind).toBe("context"); // say it quietly instead
    expect(out.kind === "context" && out.text).toContain("alice is waiting");
  });

  test("a partially-written marker set is treated as not recorded", () => {
    const many: PushDecision = { kind: "block", reason: "two asks", mark: ["a", "b"] };
    let n = 0;
    const out = applyPush(many, () => ++n === 1); // first write lands, second fails
    expect(out.kind).toBe("context");
  });

  test("blocking still fires exactly once for an ask that WAS recorded", () => {
    const asks = [{ id: "m1", kind: "query", fromAlias: "alice", body: "?" }];
    const seen = new Set<string>();
    const first = applyPush(
      decidePush(asks, "bob", (id) => seen.has(id)),
      (id) => {
        seen.add(id);
        return true;
      },
    );
    expect(first.kind).toBe("block");

    const second = applyPush(
      decidePush(asks, "bob", (id) => seen.has(id)),
      () => true,
    );
    expect(second.kind).toBe("context"); // degrades to a reminder, never a second block
  });
});
