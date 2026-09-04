import { describe, test, expect } from "bun:test";
import { resolveSessionPid } from "../src/sessionPid.ts";
import { execFileSync } from "node:child_process";

/**
 * Registration recorded `process.ppid`, which for a CLI run from an agent's Bash
 * tool is a throwaway shell. The stored pid was dead within seconds, so 18 of 22
 * roster rows looked dead on 2026-09-04 while their sessions were working.
 */
const nameOf = (pid: number): string => {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

describe("session pid resolution", () => {
  test("resolves to a process that actually exists", () => {
    const pid = resolveSessionPid();
    expect(pid).toBeGreaterThan(0);
    expect(nameOf(pid)).not.toBe("");
  });

  test("an unknown start pid is returned unchanged rather than throwing", () => {
    // Falling back keeps the old behaviour for callers this cannot improve,
    // instead of failing a registration over a liveness nicety.
    const bogus = 0x7ffffffe;
    expect(resolveSessionPid(bogus)).toBe(bogus);
  });

  test("a start pid that is already the target is returned as-is", () => {
    // process.pid is this bun test runner; it is not named claude, so the walk
    // climbs. Whatever it lands on must still be a real process.
    const pid = resolveSessionPid(process.pid);
    expect(nameOf(pid)).not.toBe("");
  });

  test("pid 1 terminates the walk instead of looping", () => {
    expect(resolveSessionPid(1)).toBe(1);
  });
});
