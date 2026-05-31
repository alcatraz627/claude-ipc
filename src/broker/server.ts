/**
 * The broker process: a Unix-socket server that frames requests to the router.
 *
 * One long-lived process all sessions connect to (a Unix socket binds no TCP
 * port, dodging the multi-instance port-conflict class). Each connection is
 * short-lived and stateless beyond its frame decoder; all shared state lives in
 * the router's storage + registry. `main()` wires the real config; `startBroker`
 * is the testable core that takes a router and a socket path.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { encodeFrame, FrameDecoder, type Request } from "../protocol.ts";
import { Registry } from "./registry.ts";
import { Router } from "./router.ts";
import { tickSweeper } from "./sweeper.ts";
import { BadgeNotifier, ttyBadgeSink } from "../badge.ts";
import { SqliteBackend } from "../storage/sqliteBackend.ts";

export interface BrokerHandle {
  stop(): void;
  socketPath: string;
}

interface ConnData {
  dec: FrameDecoder;
}

export function startBroker(opts: { router: Router; socketPath: string }): BrokerHandle {
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // no stale socket to remove
  }
  const listener = Bun.listen<ConnData>({
    unix: opts.socketPath,
    socket: {
      open(socket) {
        socket.data = { dec: new FrameDecoder() };
      },
      data(socket, data) {
        for (const frame of socket.data.dec.push(new Uint8Array(data))) {
          socket.write(encodeFrame(opts.router.handle(frame as Request)));
        }
      },
    },
  });
  return {
    stop: () => listener.stop(true),
    socketPath: opts.socketPath,
  };
}

const nowS = (): number => Math.floor(Date.now() / 1000);

export function main(): void {
  mkdirSync(dirname(config.socketPath), { recursive: true });
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const backend = new SqliteBackend(config.dbPath);
  const registry = new Registry(backend, nowS, config.liveness);
  const mkId = (): string => `msg-${crypto.randomUUID().slice(0, 8)}`;
  const notifier = new BadgeNotifier(backend, registry, ttyBadgeSink, config.badge);
  const router = new Router(backend, registry, nowS, mkId, null, (alias) => notifier.update(alias), config.allowlist);
  const inflight = backend.replayInflight();
  setInterval(() => tickSweeper(backend, nowS, mkId), config.sweepIntervalS * 1000);
  startBroker({ router, socketPath: config.socketPath });
  writeFileSync(config.pidPath, String(process.pid));
  const cleanup = (): void => {
    try {
      unlinkSync(config.pidPath);
    } catch {
      // already gone
    }
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  console.log(
    `[claude-ipc] broker up on ${config.socketPath} ` +
      `(replayed ${inflight.deliveries.length} deliveries, ${inflight.awaiting.length} awaiting)`,
  );
}

if (import.meta.main) main();
