/** The textarea's editing brain is pure — this is where multi-line editing
 *  gets its coverage, since the widget itself needs a terminal. */

import { describe, expect, test } from "bun:test";
import {
  backspace,
  cursorPos,
  forwardDelete,
  insert,
  lineEnd,
  lineHome,
  moveHorizontal,
  moveVertical,
  textLines,
  type EditState,
} from "../src/tui/widgets/textarea-ops.ts";

const st = (text: string, cursor: number): EditState => ({ text, cursor });

describe("insert", () => {
  test("inserts at the cursor and advances it", () => {
    expect(insert(st("ab", 1), "X")).toEqual(st("aXb", 2));
  });
  test("keeps newlines, normalizes CRLF, drops control bytes", () => {
    expect(insert(st("", 0), "a\r\nb\x07c")).toEqual(st("a\nbc", 4));
  });
  test("multi-char paste lands whole", () => {
    expect(insert(st("", 0), "line1\nline2")).toEqual(st("line1\nline2", 11));
  });
});

describe("delete ops", () => {
  test("backspace at 0 is a no-op; elsewhere removes the char before", () => {
    expect(backspace(st("ab", 0))).toEqual(st("ab", 0));
    expect(backspace(st("ab", 1))).toEqual(st("b", 0));
  });
  test("forwardDelete removes the char under the cursor", () => {
    expect(forwardDelete(st("ab", 0))).toEqual(st("b", 0));
    expect(forwardDelete(st("ab", 2))).toEqual(st("ab", 2));
  });
});

describe("cursor geometry", () => {
  const s = st("one\ntwo\nthree", 6); // inside "two", after 'tw'
  test("cursorPos maps index to row/col", () => {
    expect(cursorPos(s)).toEqual({ row: 1, col: 2 });
    expect(cursorPos(st("one", 0))).toEqual({ row: 0, col: 0 });
  });
  test("textLines splits", () => {
    expect(textLines(s)).toEqual(["one", "two", "three"]);
  });
  test("vertical movement keeps the column, clamped to the target line", () => {
    expect(cursorPos(moveVertical(s, 1))).toEqual({ row: 2, col: 2 });
    expect(cursorPos(moveVertical(s, -1))).toEqual({ row: 0, col: 2 });
    const atEnd = st("longline\nab", 8); // col 8 on row 0
    expect(cursorPos(moveVertical(atEnd, 1))).toEqual({ row: 1, col: 2 }); // clamped to "ab"
  });
  test("vertical movement at the edges is a no-op", () => {
    expect(moveVertical(st("one", 1), -1)).toEqual(st("one", 1));
    expect(moveVertical(st("one", 1), 1)).toEqual(st("one", 1));
  });
  test("home/end work within the cursor's line", () => {
    expect(lineHome(s).cursor).toBe(4);
    expect(lineEnd(s).cursor).toBe(7);
    expect(lineEnd(st("abc", 1)).cursor).toBe(3);
  });
  test("horizontal movement clamps to the text bounds", () => {
    expect(moveHorizontal(st("ab", 0), -1).cursor).toBe(0);
    expect(moveHorizontal(st("ab", 2), 1).cursor).toBe(2);
  });
});
