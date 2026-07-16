/**
 * Start the broker as a detached background process — shared by `daemon start`
 * and the dashboard's broker-down action, so the two never drift.
 *
 * A compiled binary re-execs itself with `serve`; from source it falls back to
 * bun on the broker entry. A double start is harmless (socket bind fails).
 */
export function spawnBroker(): number {
  const compiled = !/[\\/]bun$/.test(process.execPath);
  const args = compiled ? [process.execPath, "serve"] : ["bun", "run", `${import.meta.dir}/broker/server.ts`];
  const proc = Bun.spawn(args, { stdio: ["ignore", "ignore", "ignore"] });
  proc.unref();
  return proc.pid;
}
