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
import { brokerLog } from "./log.ts";
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
  // Bytes a response wanted to send but the socket's send buffer couldn't take
  // yet. A socket write only accepts up to the kernel high-water mark (~8 KB);
  // anything past that must wait for the `drain` event, or it's silently lost.
  outbox: Uint8Array[];
}

/** A minimal view of the bits of a Bun socket the write pump touches. */
type Writable = { write(data: Uint8Array): number; data: ConnData };

/**
 * Send everything queued for this connection, stopping the instant the socket
 * pushes back. A socket `write` returns how many bytes it actually accepted; a
 * large frame (e.g. a full `history` response) overflows the send buffer and is
 * only partially written. We keep the unsent tail at the head of the outbox and
 * resume from the `drain` event — without this, the response arrives truncated
 * and the peer's length-prefix decoder waits forever for bytes that never come.
 */
function pump(socket: Writable): void {
  const q = socket.data.outbox;
  for (let head = q[0]; head !== undefined; head = q[0]) {
    const n = socket.write(head);
    if (n < 0) {
      // Socket is closing; drop anything still queued.
      q.length = 0;
      return;
    }
    if (n >= head.byteLength) {
      q.shift();
    } else {
      q[0] = head.subarray(n); // partial write — keep the remainder, await drain
      return;
    }
  }
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
        socket.data = { dec: new FrameDecoder(), outbox: [] };
      },
      data(socket, data) {
        try {
          for (const frame of socket.data.dec.push(new Uint8Array(data))) {
            socket.data.outbox.push(encodeFrame(opts.router.handle(frame as Request)));
          }
        } catch {
          // A malformed or oversized frame throws out of the decoder and desyncs
          // this length-prefixed stream — it can't be resynced. Reply with one
          // error frame (best-effort) and drop the connection. The throw must
          // never escape this callback: that would crash the whole broker.
          socket.data.outbox.push(encodeFrame({ ok: false, error: { code: "bad_frame", message: "unparseable frame" } }));
          pump(socket);
          socket.end();
          return;
        }
        pump(socket);
      },
      drain(socket) {
        pump(socket);
      },
      error(socket) {
        // A connection-level error must never crash the broker; drop its buffer.
        if (socket.data) socket.data.outbox.length = 0;
      },
      close(socket) {
        if (socket.data) socket.data.outbox.length = 0; // release any unsent frames
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
  const router = new Router(
    backend,
    registry,
    nowS,
    mkId,
    config.defaultTtlS,
    (alias) => notifier.update(alias),
    config.allowlist,
    config.strict,
  );
  const inflight = backend.replayInflight();
  const sweeper = setInterval(() => {
    tickSweeper(backend, nowS, mkId, config.retentionS); // purge settled messages
    registry.pruneOffline(nowS() - config.registryRetentionS); // drop long-dead peers
  }, config.sweepIntervalS * 1000);
  const broker = startBroker({ router, socketPath: config.socketPath });
  writeFileSync(config.pidPath, String(process.pid));
  // Shut down cleanly: stop the sweeper, release the socket, and close SQLite so
  // its WAL is checkpointed — otherwise a restart inherits a dirty WAL and a
  // stale listening socket.
  const cleanup = (): void => {
    clearInterval(sweeper);
    broker.stop();
    try {
      backend.close();
    } catch {
      // already closed
    }
    try {
      unlinkSync(config.pidPath);
    } catch {
      // already gone
    }
    brokerLog(config.logPath, "broker shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  const bootLine = `broker up on ${config.socketPath} (replayed ${inflight.deliveries.length} deliveries, ${inflight.awaiting.length} awaiting)`;
  brokerLog(config.logPath, bootLine); // rotated operational record
  console.log(`[claude-ipc] ${bootLine}`); // launchd-visible liveness trace
}

if (import.meta.main) main();
