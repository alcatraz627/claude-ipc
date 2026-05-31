/**
 * Wire framing for the broker socket: length-prefixed JSON.
 *
 * Each frame is a 4-byte big-endian length followed by that many UTF-8 bytes of
 * JSON. The FrameDecoder reassembles frames from a byte stream that may split a
 * frame across chunks or pack several into one.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // guard against a runaway frame

export type Op =
  | "register"
  | "heartbeat"
  | "leave"
  | "send"
  | "check"
  | "deliver"
  | "reply"
  | "accept"
  | "decline"
  | "cancel"
  | "await"
  | "list"
  | "history"
  | "status"
  | "count";

export interface Request {
  v: number;
  op: Op;
  args: Record<string, unknown>;
  sessionId?: string;
  // The caller's capability token for the alias it claims to act as. The broker
  // checks it against the alias's registered token for ownership-bearing ops.
  token?: string;
}

export type Response =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/** Encode a value as one length-prefixed UTF-8 JSON frame. */
export function encodeFrame(value: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  if (json.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${json.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, false);
  out.set(json, 4);
  return out;
}

/**
 * Reassembles frames from a byte stream. Feed bytes with push(); it returns the
 * complete frames now available, buffering any trailing partial frame.
 */
export class FrameDecoder {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array<ArrayBufferLike>): unknown[] {
    this.buf = concat(this.buf, chunk);
    const frames: unknown[] = [];
    for (;;) {
      if (this.buf.byteLength < 4) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) throw new Error(`frame too large: ${len} > ${MAX_FRAME_BYTES}`);
      if (this.buf.byteLength < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      frames.push(JSON.parse(new TextDecoder().decode(body)));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
