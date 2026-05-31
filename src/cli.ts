#!/usr/bin/env bun
/**
 * The human's command-line client for claude-ipc.
 *
 * Lets you send, inspect, and approve messages and check the broker — all
 * independent of any Claude session. `run()` is the testable core (it takes the
 * args + an optional socket path); the file's tail wires it to the real process.
 */

import { readFileSync } from "node:fs";
import { Client } from "./client.ts";
import { config } from "./config.ts";
import { monitorSnapshot } from "./monitor.ts";

type FlagValue = string | boolean;

function parse(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, FlagValue> } {
  const cmd = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { cmd, positional, flags };
}

const USAGE = `claude-ipc — cross-session messaging

  register <alias>           (claim a mailbox from the shell)
  send   --from <a> --to <b> --kind <inform|query|request> [--ttl N] <body...>
  reply  <corr-id> --from <alias> [--status error] <body...>
  inbox  <alias> [--consume]
  peers
  log    [--peer <a>] [--since <epoch>]
  accept <msg-id> --as <alias>
  decline <msg-id> --as <alias> [--reason <r>]
  tail                       (live monitor — Phase 6)
  daemon status|start|stop`;

export async function run(argv: string[], opts: { socketPath?: string } = {}): Promise<number> {
  const { cmd, positional, flags } = parse(argv);
  const client = new Client(opts.socketPath ?? config.socketPath);
  const out = (v: unknown): void => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

  try {
    switch (cmd) {
      case "register": {
        const alias = positional[0] ?? String(flags.as ?? "");
        if (!alias) {
          console.error("register <alias> [--tty /dev/ttysNNN]");
          return 2;
        }
        out(
          await client.register(alias, {
            sessionId: `cli-${alias}`,
            cwd: process.cwd(),
            tty: flags.tty ? String(flags.tty) : undefined,
          }),
        );
        return 0;
      }
      case "send": {
        const to = String(flags.to ?? "");
        if (!to) {
          console.error("send needs --to <alias>");
          return 2;
        }
        const kind = String(flags.kind ?? "inform") as "inform" | "query" | "request";
        out(
          await client.send({
            from: String(flags.from ?? "cli"),
            to,
            kind,
            body: positional.join(" "),
            ttlS: flags.ttl ? Number(flags.ttl) : undefined,
          }),
        );
        return 0;
      }
      case "reply": {
        const corrId = positional[0] ?? String(flags.corr ?? "");
        const from = String(flags.from ?? "");
        if (!corrId || !from) {
          console.error("reply <corr-id> --from <alias> [--status error] <body...>");
          return 2;
        }
        out(
          await client.reply({
            from,
            corrId,
            body: positional.slice(1).join(" "),
            status: flags.status === "error" ? "error" : "ok",
          }),
        );
        return 0;
      }
      case "inbox": {
        const alias = positional[0] ?? String(flags.alias ?? "");
        if (!alias) {
          console.error("inbox needs an alias");
          return 2;
        }
        out(await client.check(alias, flags.consume === true || flags.consume === "true"));
        return 0;
      }
      case "peers":
        out(await client.list());
        return 0;
      case "log": {
        const q: { peer?: string; since?: number } = {};
        if (flags.peer) q.peer = String(flags.peer);
        if (flags.since) q.since = Number(flags.since);
        out(await client.history(q));
        return 0;
      }
      case "accept": {
        const msgId = positional[0] ?? "";
        const as = String(flags.as ?? "");
        if (!msgId || !as) {
          console.error("accept <msg-id> --as <alias>");
          return 2;
        }
        out(await client.accept(as, msgId));
        return 0;
      }
      case "decline": {
        const msgId = positional[0] ?? "";
        const as = String(flags.as ?? "");
        if (!msgId || !as) {
          console.error("decline <msg-id> --as <alias> [--reason r]");
          return 2;
        }
        out(await client.decline(as, msgId, flags.reason ? String(flags.reason) : undefined));
        return 0;
      }
      case "daemon": {
        const sub = positional[0] ?? "status";
        if (sub === "status") {
          try {
            await client.list();
            out("broker: up");
            return 0;
          } catch {
            out("broker: DOWN");
            return 1;
          }
        }
        if (sub === "start") {
          try {
            await client.list();
            out("broker already up");
            return 0;
          } catch {
            // down → start it
          }
          const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/broker/server.ts`], {
            stdio: ["ignore", "ignore", "ignore"],
          });
          proc.unref();
          out(`broker starting (pid ${proc.pid})`);
          return 0;
        }
        if (sub === "stop") {
          try {
            const pid = Number(readFileSync(config.pidPath, "utf8").trim());
            process.kill(pid, "SIGTERM");
            out(`stopped broker (pid ${pid})`);
            return 0;
          } catch {
            out("broker not running (no pidfile)");
            return 1;
          }
        }
        console.error(`daemon: unknown subcommand "${sub}" (status|start|stop)`);
        return 2;
      }
      case "tail": {
        if (flags.once === true || flags.once === "true") {
          out(await monitorSnapshot(client));
          return 0;
        }
        for (;;) {
          process.stdout.write("\x1b[2J\x1b[H");
          out(await monitorSnapshot(client));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      default:
        out(USAGE);
        return cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  run(Bun.argv.slice(2)).then((code) => process.exit(code));
}
