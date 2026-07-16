/**
 * The dashboard's write verbs — each returns a toast-ready outcome and never
 * throws. A broker refusal surfaces its stable code (error-classification:
 * callers read codes, not message prose); success repeats what actually
 * happened, so a no-op can't masquerade as done.
 */

import { BrokerError, type Client } from "../client.ts";

export interface Outcome {
  ok: boolean;
  text: string;
}

function refused(e: unknown): Outcome {
  if (e instanceof BrokerError) return { ok: false, text: `refused (${e.code}): ${e.message.slice(0, 80)}` };
  return { ok: false, text: e instanceof Error ? e.message.slice(0, 80) : String(e) };
}

export async function replyTo(client: Client, from: string, corrId: string, body: string): Promise<Outcome> {
  try {
    const r = (await client.reply({ from, corrId, body, terminal: true })) as { msgId: string; late: boolean };
    return { ok: true, text: `replied ${r.msgId}${r.late ? " (late — still delivered)" : ""}` };
  } catch (e) {
    return refused(e);
  }
}

export async function acceptMsg(client: Client, alias: string, msgId: string): Promise<Outcome> {
  try {
    const r = (await client.accept(alias, msgId)) as { accepted: boolean; claimedBy?: string };
    if (!r.accepted) return { ok: false, text: `already claimed by ${r.claimedBy ?? "someone else"}` };
    // accepted mail leaves the pending list — say so, or it reads as data loss
    return { ok: true, text: "accepted — it's yours (leaves pending; reply when done)" };
  } catch (e) {
    return refused(e);
  }
}

export async function declineMsg(client: Client, from: string, msgId: string, reason: string): Promise<Outcome> {
  try {
    const r = (await client.decline(from, msgId, reason || undefined)) as { declined?: boolean; passed?: boolean };
    return { ok: true, text: r.passed ? "passed — stays open for others" : "declined" };
  } catch (e) {
    return refused(e);
  }
}

export async function snoozeMsg(client: Client, alias: string, msgId: string): Promise<Outcome> {
  try {
    await client.snooze(alias, msgId);
    return { ok: true, text: "snoozed — still owed, nudge deferred" };
  } catch (e) {
    return refused(e);
  }
}
