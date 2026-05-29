import { test, expect } from "bun:test";
import { VERSION } from "../src/index.ts";

test("package version is exposed", () => {
  expect(VERSION).toBe("0.0.1");
});
