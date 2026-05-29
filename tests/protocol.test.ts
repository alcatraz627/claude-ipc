import { describe, test, expect } from "bun:test";
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/protocol.ts";

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

describe("protocol framing", () => {
  test("round-trips a value through one frame", () => {
    const v = { v: 1, op: "send", args: { to: "bob", body: "hi" } };
    expect(new FrameDecoder().push(encodeFrame(v))).toEqual([v]);
  });

  test("yields multiple frames packed into one chunk", () => {
    const a = { n: 1 };
    const b = { n: 2 };
    const buf = concatBytes(encodeFrame(a), encodeFrame(b));
    expect(new FrameDecoder().push(buf)).toEqual([a, b]);
  });

  test("reassembles a frame split across chunks", () => {
    const v = { hello: "world", list: [1, 2, 3] };
    const full = encodeFrame(v);
    const dec = new FrameDecoder();
    expect(dec.push(full.subarray(0, 3))).toEqual([]); // partial length prefix
    expect(dec.push(full.subarray(3, 7))).toEqual([]); // rest of prefix + partial body
    expect(dec.push(full.subarray(7))).toEqual([v]); // remainder completes it
  });

  test("buffers a partial body until complete", () => {
    const v = { x: "abcdefghij" };
    const full = encodeFrame(v);
    const dec = new FrameDecoder();
    expect(dec.push(full.subarray(0, full.byteLength - 2))).toEqual([]);
    expect(dec.push(full.subarray(full.byteLength - 2))).toEqual([v]);
  });

  test("rejects an oversize frame on encode", () => {
    expect(() => encodeFrame({ huge: "x".repeat(MAX_FRAME_BYTES + 1) })).toThrow();
  });

  test("rejects an oversize declared length on decode", () => {
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => new FrameDecoder().push(bad)).toThrow();
  });
});
