import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runHook(file: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", file], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      CLAUDE_IPC_MANAGED_HOST: "1",
      CLAUDE_IPC_MANAGED_HOST_PID: String(process.pid),
    },
    stdin: new Blob([
      JSON.stringify({
        session_id: "managed-thread",
        cwd: "/work/managed",
        hook_event_name: "managed-probe",
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("managed Codex host hook cutover", () => {
  for (const hook of ["src/hooks/sessionStart.ts", "src/hooks/userPromptSubmit.ts", "src/hooks/stop.ts"]) {
    test(`${hook} leaves delivery to the App Server host`, async () => {
      expect(await runHook(hook)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });
  }

  test("a nested process cannot inherit managed-host status", async () => {
    const proc = Bun.spawn(
      [process.execPath, "-e", 'import { config } from "./src/config.ts"; console.log(config.managedCodexHost)'],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, CLAUDE_IPC_MANAGED_HOST: "1", CLAUDE_IPC_MANAGED_HOST_PID: "1" },
        stdout: "pipe",
      },
    );
    expect((await new Response(proc.stdout).text()).trim()).toBe("false");
    expect(await proc.exited).toBe(0);
  });

  test("the dashboard rejects a managed alias outside the host ancestry", async () => {
    const proc = Bun.spawn(
      [process.execPath, "-e", 'import { sessionIdentity } from "./src/tui/identity.ts"; console.log(JSON.stringify(sessionIdentity()))'],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "",
          CLAUDE_IPC_ALIAS: "cx-host-victim",
          CLAUDE_IPC_MANAGED_HOST: "1",
          CLAUDE_IPC_MANAGED_HOST_PID: "1",
        },
        stdout: "pipe",
      },
    );
    expect((await new Response(proc.stdout).text()).trim()).toBe("null");
    expect(await proc.exited).toBe(0);
  });

  test("gcc uses the managed host alias from the same ancestry", async () => {
    const outbox = mkdtempSync(join(tmpdir(), "gcc-managed-alias-"));
    const proc = Bun.spawn(
      ["bash", "/Users/alcatraz627/.claude/adapters/codex/bin/gcc", "ipc", "register"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          ...process.env,
          CODEX_THREAD_ID: "managed-thread",
          CLAUDE_IPC_ALIAS: "cx-managed-host",
          CLAUDE_IPC_MANAGED_HOST: "1",
          CLAUDE_IPC_MANAGED_HOST_PID: String(process.pid),
          CODEX_GCC_OUTBOX: outbox,
          CODEX_SANDBOX: "forced",
          GCC_FORCE_QUEUE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    const queued = JSON.parse(readFileSync(join(outbox, "managed-thread.jsonl"), "utf8"));
    expect(queued.argv).toEqual(["claude-ipc", "register", "cx-managed-host"]);
  });
});
