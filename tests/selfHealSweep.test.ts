/**
 * The self-healing sweep wrapper: a request past the staleness window runs one
 * sweep inline before routing, so a dead timer cannot silently kill
 * housekeeping while the socket keeps serving (the 2026-07-28 incident).
 */

import { describe, expect, test } from "bun:test";
import { selfHealingSweeps } from "../src/broker/server.ts";
import type { Router } from "../src/broker/router.ts";
import type { Request, Response } from "../src/protocol.ts";

const REQ = { v: 1, op: "list", args: {} } as unknown as Request;

function harness(startAt: number) {
  let clock = startAt;
  let lastSweep = 0; // the timer "ran" at t=0 and then died
  const sweeps: number[] = [];
  const heals: number[] = [];
  const routed: Request[] = [];
  const inner = {
    handle: (req: Request): Response => {
      routed.push(req);
      return { ok: true, result: "routed" };
    },
  } as unknown as Pick<Router, "handle">;
  const wrapped = selfHealingSweeps(inner, {
    now: () => clock,
    staleAfterS: 30,
    lastSweepAt: () => lastSweep,
    sweep: () => {
      lastSweep = clock; // the real runSweep stamps its own time — mirror it
      sweeps.push(clock);
    },
    onHeal: (deadS) => heals.push(deadS),
  });
  return {
    wrapped,
    sweeps,
    heals,
    routed,
    tick: (s: number) => {
      clock += s;
    },
  };
}

describe("selfHealingSweeps", () => {
  test("a fresh sweeper is left alone — requests route without sweeping", () => {
    const h = harness(10); // 10s since the last sweep, threshold 30
    const r = h.wrapped.handle(REQ);
    expect(r.ok).toBe(true);
    expect(h.sweeps).toEqual([]);
    expect(h.routed.length).toBe(1);
  });

  test("a stale sweeper heals exactly once per silence, then goes quiet", () => {
    const h = harness(100); // 100s silent, threshold 30 — visibly dead
    h.wrapped.handle(REQ);
    expect(h.sweeps).toEqual([100]); // healed inline
    expect(h.heals).toEqual([100]); // and said how long the timer was silent
    h.tick(5);
    h.wrapped.handle(REQ); // 5s after the heal — fresh again
    expect(h.sweeps).toEqual([100]); // no re-heal storm
    expect(h.routed.length).toBe(2); // every request still routed
  });

  test("silence past the window after a heal triggers the next heal", () => {
    const h = harness(100);
    h.wrapped.handle(REQ);
    h.tick(31); // the timer is still dead; silence crosses the window again
    h.wrapped.handle(REQ);
    expect(h.sweeps).toEqual([100, 131]);
  });

  test("the request outcome is untouched by healing", () => {
    const h = harness(100);
    const r = h.wrapped.handle(REQ);
    expect(r).toEqual({ ok: true, result: "routed" });
  });
});
