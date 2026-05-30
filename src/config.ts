/** Runtime configuration: where the broker lives and how it ages peers. */

import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.CLAUDE_IPC_HOME ?? join(homedir(), ".claude-ipc");

export const config = {
  home,
  socketPath: process.env.CLAUDE_IPC_SOCKET ?? join(home, "run", "ipc.sock"),
  dbPath: process.env.CLAUDE_IPC_DB ?? join(home, "data", "ipc.sqlite"),
  pidPath: join(home, "run", "broker.pid"),
  defaultTtlS: 3600,
  sweepIntervalS: 5,
  liveness: { idleS: 300, offlineS: 1800 },
} as const;
