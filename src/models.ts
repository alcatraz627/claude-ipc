/**
 * The message taxonomy and the records the broker persists.
 *
 * A Message is an immutable fact. Mutable per-recipient lifecycle lives in
 * Delivery; the sender's open/closed view of a query/request lives in Awaiting.
 * That split is what lets one broadcast carry an independent state per recipient.
 */

export type Kind = "inform" | "query" | "request" | "response" | "control";
export type Status = "ok" | "error";
export type ErrorCode = "timeout" | "no_peer" | "declined" | "internal";
export type ControlOp = "register" | "heartbeat" | "leave" | "cancel" | "claim" | "release";
export type DeliveredVia = "channel" | "hook" | "resume" | "pull" | null;

/** Per-recipient delivery lifecycle. Lives on Delivery, never on Message. */
export type DeliveryState =
  | "queued"
  | "delivered"
  | "surfaced"
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
  ts: number; // epoch seconds, set at append
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
  closedReason: "responded" | "timeout" | "cancelled" | null;
}

export interface RegistryEntry {
  alias: string;
  sessionId: string;
  cwd: string;
  caps: string[];
  pid: number | null;
  lastSeen: number;
  status: "live" | "idle" | "offline";
}

/** Build a Message from the few fields a caller supplies, defaulting the rest. */
export function makeMessage(
  fields: Pick<Message, "id" | "kind" | "fromAlias" | "toAlias" | "ts"> & Partial<Message>,
): Message {
  return {
    body: "",
    conversationId: null,
    corrId: null,
    status: null,
    errorCode: null,
    terminal: true,
    op: null,
    contextPtr: null,
    ttlS: null,
    ...fields,
  };
}
