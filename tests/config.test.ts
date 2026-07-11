import { afterEach, describe, expect, test } from "bun:test";
import { envNum } from "../src/config.ts";

// Regression: a deliberate 0 (e.g. CLAUDE_IPC_GHOST_AFTER_S=0 = escalate as soon
// as a recipient is offline) must survive. `Number(x) || default` silently drops
// it because 0 is falsy — the bug the ghost sweep's env knob shipped with until
// an end-to-end run exposed it. envNum keeps 0 and only falls back on absent/junk.
describe("envNum — numeric env knobs preserve a deliberate 0", () => {
  const KEY = "CLAUDE_IPC_TEST_ENVNUM";
  afterEach(() => {
    delete process.env[KEY];
  });

  test("a zero value is kept, not replaced by the fallback", () => {
    process.env[KEY] = "0";
    expect(envNum(KEY, 300)).toBe(0);
  });

  test("a normal value is parsed", () => {
    process.env[KEY] = "42";
    expect(envNum(KEY, 300)).toBe(42);
  });

  test("an unset var falls back", () => {
    delete process.env[KEY];
    expect(envNum(KEY, 300)).toBe(300);
  });

  test("an empty or non-numeric value falls back", () => {
    process.env[KEY] = "";
    expect(envNum(KEY, 300)).toBe(300);
    process.env[KEY] = "not-a-number";
    expect(envNum(KEY, 300)).toBe(300);
  });
});
