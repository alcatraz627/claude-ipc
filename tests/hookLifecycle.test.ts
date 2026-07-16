/**
 * The hooks driven END-TO-END as subprocesses — the layer nothing covered when
 * the register-time orphan surfacing shipped (the RPC had tests; the wiring had
 * none, and "does it fire on a resumed session" stayed an open question for two
 * days). Asserts the surfacing on fresh AND resume-shaped inputs, plus the
 * once-per-session UPS fallback with its marker semantics.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import { startBroker, type BrokerHandle } from "../src/broker/server.ts";
import { Client } from "../src/client.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";

const HOME = mkdtempSync(join(tmpdir(), "ipc-hooks-"));
const sock = join(HOME, "ipc.sock");
// The project dir must be NON-ephemeral: sessionStart's isEphemeral() rightly
// skips /tmp and /var/folders (transient sub-agent cwds), so a tmp project dir
// would make the hook a no-op and the test would pass vacuously. Under $HOME it
// is a real project as far as the hook is concerned; cleaned up in afterAll.
const projDir = mkdtempSync(join(homedir(), ".ipc-hooktest-"));

async function runHook(script: string, input: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/hooks/${script}`], {
    env: { ...process.env, CLAUDE_IPC_HOME: HOME, CLAUDE_IPC_SOCKET: sock, CLAUDE_IPC_BADGE: "0" },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describe("hook lifecycle — the wiring, not just the RPC", () => {
  let broker: BrokerHandle;

  beforeAll(async () => {
    const backend = new MemoryBackend();
    const registry = new Registry(backend, () => Math.floor(Date.now() / 1000), { idleS: 300, offlineS: 1800 });
    let idn = 0;
    const router = new Router(backend, registry, () => Math.floor(Date.now() / 1000), () => `msg-${++idn}`, null);
    broker = startBroker({ router, socketPath: sock });
    // a predecessor lane in this project dies holding an owner directive
    const c = new Client(sock, undefined, join(HOME, "tokens"));
    await c.register("hl-pred", { sessionId: "sid-hl-pred", cwd: projDir });
    await c.register("hl-mailer", { sessionId: "sid-hl-mailer", cwd: "/elsewhere" });
    await c.send({ from: "hl-mailer", to: "hl-pred", kind: "request", body: "owner directive needing ack" });
    await c.leave("hl-pred");
  });
  afterAll(() => {
    broker.stop();
    rmSync(projDir, { recursive: true, force: true });
  });

  test("sessionStart surfaces the dead predecessor on a FRESH start", async () => {
    const out = await runHook("sessionStart.ts", {
      session_id: "sid-hl-fresh",
      cwd: projDir,
      source: "startup",
      session_title: "hl-fresh-lane",
    });
    expect(out).toContain("hl-pred");
    expect(out).toContain("peek");
  });

  test("sessionStart surfaces it on a RESUME-shaped start too (source-agnostic)", async () => {
    const out = await runHook("sessionStart.ts", {
      session_id: "sid-hl-resumed",
      cwd: projDir,
      source: "resume",
      session_title: "hl-resumed-lane",
    });
    expect(out).toContain("hl-pred");
  });

  test("UPS fallback notes the orphans exactly once per session", async () => {
    const first = await runHook("userPromptSubmit.ts", { session_id: "sid-hl-ups", cwd: projDir });
    expect(first).toContain("dead mailbox");
    expect(first).toContain("hl-pred");
    const second = await runHook("userPromptSubmit.ts", { session_id: "sid-hl-ups", cwd: projDir });
    expect(second).not.toContain("dead mailbox"); // the marker holds
  });

  test("a FRESH session is not told twice — SessionStart's note suppresses the UPS one", async () => {
    // same session id through both hooks: SessionStart surfaces + claims the
    // marker, so the following UPS turn must stay silent about orphans
    const sid = "sid-hl-nodup";
    const start = await runHook("sessionStart.ts", { session_id: sid, cwd: projDir, source: "startup", session_title: "nodup-lane" });
    expect(start).toContain("hl-pred"); // SessionStart showed it
    const ups = await runHook("userPromptSubmit.ts", { session_id: sid, cwd: projDir });
    expect(ups).not.toContain("dead mailbox"); // ...so UPS doesn't repeat it
  });
});
