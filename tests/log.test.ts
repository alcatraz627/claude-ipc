import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerLog } from "../src/broker/log.ts";

describe("brokerLog rotation", () => {
  test("appends timestamped lines and rotates once past the size cap", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cipc-log-")), "broker.log");
    brokerLog(path, "hello");
    expect(readFileSync(path, "utf8")).toContain("hello");

    writeFileSync(path, "x".repeat(6 * 1024 * 1024)); // push it past the 5 MB cap
    brokerLog(path, "after-rotate");
    expect(existsSync(`${path}.1`)).toBe(true); // prior file kept
    expect(statSync(`${path}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(readFileSync(path, "utf8")).toContain("after-rotate"); // fresh file, only new line
  });
});
