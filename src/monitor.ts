/**
 * A glanceable view of the IPC fabric: who's alive and what's flowing.
 *
 * `monitorSnapshot` renders one frame (peers + recent messages, each one terse
 * line with a timestamp and colour-coded segments); the CLI `tail` command loops
 * it. This is the human-facing observability surface — a dead broker shows up
 * here rather than as a silent empty inbox. Colour is emitted only to a TTY.
 */

import type { Client } from "./client.ts";

interface Peer {
  alias: string;
  cwd: string;
  status: string;
  lastSeen: number;
}
interface Msg {
  fromAlias: string;
  toAlias: string;
  kind: string;
  corrId: string | null;
  status: string | null;
  errorCode: string | null;
  body: string;
  ts: number;
}

const tty = Boolean(process.stdout.isTTY);
const c = (code: string, s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);

function clock(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_COLOR: Record<string, string> = { live: "32", idle: "33", offline: "90" };
const statusDot = (s: string): string => c(STATUS_COLOR[s] ?? "90", s === "live" ? "●" : s === "idle" ? "◐" : "○");

function kindTag(m: Msg): string {
  const color =
    m.kind === "query"
      ? "36"
      : m.kind === "request"
        ? "33"
        : m.kind === "response"
          ? m.status === "error"
            ? "31"
            : "32"
          : m.kind === "control"
            ? "35"
            : "37";
  return c(color, m.errorCode ? `${m.kind}:${m.errorCode}` : m.kind);
}

export async function monitorSnapshot(client: Client): Promise<string> {
  let peers: Peer[];
  try {
    peers = (await client.list()).peers as Peer[];
  } catch {
    return c("31", "broker: DOWN") + " (run `claude-ipc daemon start`)";
  }
  const all = (await client.history({})).messages as Msg[];
  const recent = all.slice(-10);

  const header = dim(`claude-ipc · ${clock(Math.floor(Date.now() / 1000))}`);
  const plines = peers.length
    ? peers.map((p) => `  ${statusDot(p.status)} ${bold(p.alias)}  ${dim(p.cwd)}`)
    : [dim("  (none)")];
  const mlines = recent.length
    ? recent.map((m) => {
        const route = `${bold(m.fromAlias)}${dim("→")}${bold(m.toAlias)}`;
        const corr = m.corrId ? " " + dim(`(re ${m.corrId})`) : "";
        return `  ${dim(clock(m.ts))}  ${route}  ${kindTag(m)}${corr}  ${dim(m.body.slice(0, 56))}`;
      })
    : [dim("  (none)")];

  return [
    header,
    bold(`peers (${peers.length})`),
    ...plines,
    bold(`recent (${recent.length}/${all.length})`),
    ...mlines,
  ].join("\n");
}
