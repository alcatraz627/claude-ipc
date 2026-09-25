/**
 * The message taxonomy and the records the broker persists.
 *
 * A Message is an immutable fact. Mutable per-recipient lifecycle lives in
 * Delivery; the sender's open/closed view of a query/request lives in Awaiting.
 * That split is what lets one broadcast carry an independent state per recipient.
 */

export type Kind = "inform" | "query" | "request" | "response";
export type Status = "ok" | "error";
export type ErrorCode = "timeout" | "no_peer" | "declined" | "ghosted" | "internal";
export type ControlOp = "register" | "heartbeat" | "leave" | "cancel";
export type DeliveredVia = "channel" | "hook" | "resume" | "pull" | null;

/** Per-recipient delivery lifecycle. Lives on Delivery, never on Message. */
export type DeliveryState =
  | "queued"
  | "delivered"
  | "surfaced"
  | "persisted"
  | "consumed"
  | "accepted"
  | "declined";

export interface ContextPtr {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
}

export interface Message {
  id: string;
  /** Caller-stable idempotency key. Retries return this message instead of appending again. */
  operationId: string | null;
  kind: Kind;
  fromAlias: string;
  toAlias: string; // a concrete alias, or "*" for broadcast
  body: string;
  conversationId: string | null;
  corrId: string | null; // origin id, set on response/cancel
  status: Status | null; // response only
  errorCode: ErrorCode | null; // response only
  terminal: boolean; // response only — false = ack/progress
  op: ControlOp | null;
  contextPtr: ContextPtr | null;
  ttlS: number | null;
  /** Effective reply deadline captured with the immutable send for idempotent replay. */
  replyByS?: number | null;
  ts: number; // epoch seconds, set at append
  // Set by the broker when it blanked the body for a non-party reader — a
  // display hint a peer cannot forge by writing marker-lookalike text.
  bodyHidden?: boolean;
}

/** Delivery + consent of one message to one recipient. */
export interface Delivery {
  msgId: string;
  toAlias: string;
  via: DeliveredVia;
  state: DeliveryState;
  ts: number;
}

/** A sender's outstanding query/request — open until answered or timed out. */
export interface Awaiting {
  originId: string; // the query/request id (== corrId of its responses)
  expiresAt: number | null; // null = no deadline (the default — never auto-times-out)
  closed: boolean;
  // How long the sender is willing to wait before being told nobody has answered.
  // null = they opted out (`--reply-by none`), so nothing is ever emitted for it.
  replyByS: number | null;
  // Which reply nudges have fired: 0 none, 1 the reminder, 2 the last call. Kept
  // here rather than in memory so a broker restart can neither repeat a nudge nor
  // silently skip one.
  nudgedStage: 0 | 1 | 2;
  // When the RECIPIENT's nudge clock starts — normally the send, but a snooze or a
  // partial ("on it, 20 min") pushes it out: they answered, so nagging them would be
  // a lie about the state. The sender's own deadline never moves; it is their call
  // to make, not the recipient's.
  nudgeFrom: number;
  // "parked" = the recipient hasn't attended to the ask yet (TTL passed, or they
  // went offline holding it). The sender was told it's PARKED — not failed: the
  // message stays deliverable on the recipient's next turn/open, and a genuine
  // late reply still reaches the sender (reply drops only on "cancelled"). Parking
  // replaces the old terminal "timeout"/"ghosted" ERROR — the silent-failure the
  // data showed (64% of asks). Those reasons are retained for back-compat reads.
  closedReason: "responded" | "timeout" | "cancelled" | "ghosted" | "parked" | null;
}

/** Complete send intent durably queued while the broker is unreachable. */
export interface OutboundIntent {
  operationId: string;
  fromAlias: string;
  args: Record<string, unknown>;
  createdAt: number;
}

export interface RegistryEntry {
  alias: string;
  sessionId: string;
  cwd: string;
  caps: string[];
  pid: number | null;
  tty: string | null; // the session's pty (e.g. /dev/ttys005) for out-of-band tab badging
  lastSeen: number;
  status: "live" | "idle" | "offline";
  // Every alias bound to the same sessionId, this one included — computed on
  // list(), so readers can tell "two names, one session" from two sessions.
  // Absent on stored snapshots; purely a read-time annotation.
  sessionAliases?: string[];
  // Seconds since this session last showed a sign of life (D3). Read-time annotation
  // that makes "live" legibly a heartbeat inference, not a process check — a reader
  // can weigh freshness ("live, but seen 280s ago") instead of trusting a binary chip.
  sinceSeenS?: number;
  // The sessionId this alias was taken over FROM, when a different session rebound a
  // name a now-dead one held (D3 succession). Absent on a fresh claim or a same-session
  // reconnect; present marks a takeover so "two names, one lane" is legible.
  succeededSid?: string;
  // A service identity (E2): a non-session sender — a web server, a cron, a bot.
  // Never heartbeats by design, so pruneOffline exempts it; removal is a
  // deliberate human act, not liveness decay.
  service?: boolean;
  // The capability secret that proves ownership of this alias. Issued at register
  // time, held by the owner in a 0600 file; required to act as the alias. Never
  // sent over the wire except in the register response to the owner — strip it
  // from list/get/status responses. Null on legacy entries from before tokens.
  token: string | null;
}

/** A compact human duration for a span of seconds: "45s", "12m", "3h", "2d". */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A compact human age for a past epoch-seconds timestamp: "45s", "12m", "3h", "2d". */
export function humanAge(ts: number, nowS: number): string {
  return humanDuration(nowS - ts);
}

/** Build a Message from the few fields a caller supplies, defaulting the rest. */
export function makeMessage(
  fields: Pick<Message, "id" | "kind" | "fromAlias" | "toAlias" | "ts"> & Partial<Message>,
): Message {
  return {
    body: "",
    operationId: null,
    conversationId: null,
    corrId: null,
    status: null,
    errorCode: null,
    terminal: true,
    op: null,
    contextPtr: null,
    ttlS: null,
    replyByS: null,
    ...fields,
  };
}
