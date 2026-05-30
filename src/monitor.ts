/**
 * A glanceable view of the IPC fabric: who's alive and what's flowing.
 *
 * `monitorSnapshot` renders one frame (peers + recent messages); the CLI `tail`
 * command loops it so a human can watch handoffs happen without reading each
 * session. This is the human-facing observability surface — a dead broker shows
 * up here rather than as a silent empty inbox.
 */

import type { Client } from "./client.ts";

interface Peer {
  alias: string;
  cwd: string;
  status: string;
}
interface Msg {
  fromAlias: string;
  toAlias: string;
  kind: string;
  corrId: string | null;
  body: string;
}

const dot = (status: string): string => (status === "live" ? "●" : status === "idle" ? "◐" : "○");

export async function monitorSnapshot(client: Client): Promise<string> {
  let peers: Peer[];
  try {
    peers = (await client.list()).peers as Peer[];
  } catch {
    return "broker: DOWN (run `claude-ipc daemon start`)";
  }
  const all = (await client.history({})).messages as Msg[];
  const recent = all.slice(-8);
  const plines = peers.map((p) => `  ${dot(p.status)} ${p.alias}  ${p.cwd}`);
  const mlines = recent.map(
    (m) => `  ${m.fromAlias} → ${m.toAlias}  ${m.kind}${m.corrId ? ` (re ${m.corrId})` : ""}  ${m.body.slice(0, 48)}`,
  );
  return [
    `peers (${peers.length}):`,
    ...(plines.length ? plines : ["  (none)"]),
    `recent messages (${recent.length}/${all.length}):`,
    ...(mlines.length ? mlines : ["  (none)"]),
  ].join("\n");
}
