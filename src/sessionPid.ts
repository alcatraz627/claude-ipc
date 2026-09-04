import { execFileSync } from "node:child_process";

/**
 * The pid of the Claude session behind this CLI invocation.
 *
 * `process.ppid` is the immediate parent, which for `claude-ipc register` run
 * from an agent's Bash tool is a throwaway shell that exits at once. Liveness
 * then reads a dead pid for a session that is very much alive. Walk up instead
 * until a `claude` process appears.
 */
const MAX_HOPS = 8;

function procName(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function parentOf(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

const isClaude = (name: string): boolean => {
  const base = name.split("/").pop() ?? name;
  return base === "claude" || base.startsWith("claude");
};

/**
 * Returns the nearest ancestor that looks like a Claude session, or the starting
 * pid when none is found within MAX_HOPS. Falling back rather than returning null
 * keeps the old behaviour for callers this cannot improve, such as a service.
 */
export function resolveSessionPid(start: number = process.ppid): number {
  let pid = start;
  for (let hop = 0; hop < MAX_HOPS && pid > 1; hop += 1) {
    if (isClaude(procName(pid))) return pid;
    pid = parentOf(pid);
  }
  return start;
}
