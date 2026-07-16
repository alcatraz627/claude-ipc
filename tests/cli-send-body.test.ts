/**
 * A send with no usable body must refuse loudly BEFORE the broker sees it —
 * `--body "text"` (a natural but wrong guess; the body is positional) silently
 * delivered zero-byte messages until a whole agent lane was talking in them.
 */

import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";

// The guard fires before any broker call, so a dead socket path proves it.
const DEAD_SOCKET = "/tmp/ipc-test-no-broker.sock";

async function runCapturing(argv: string[]): Promise<{ code: number; err: string }> {
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  try {
    const code = await run(argv, { socketPath: DEAD_SOCKET });
    return { code, err: errs.join("\n") };
  } finally {
    console.error = orig;
  }
}

describe("send body guard", () => {
  test("--body flag is caught with the positional fix spelled out", async () => {
    const r = await runCapturing(["send", "--to", "peer", "--from", "me", "--body", "hello there"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("positional");
    expect(r.err).toContain('"hello there"');
  });

  test("no body at all is refused, nothing sent", async () => {
    const r = await runCapturing(["send", "--to", "peer", "--from", "me"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("NOTHING WAS SENT");
  });

  test("whitespace-only body counts as empty", async () => {
    const r = await runCapturing(["send", "--to", "peer", "--from", "me", "   "]);
    expect(r.code).toBe(2);
  });
});
