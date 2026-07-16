/**
 * The editing brain of the multi-line textarea, as pure functions over
 * (text, cursor-index) — ink-terminal ships no editor widget, so the dashboard
 * carries its own, and keeping the logic out of the component is what makes it
 * testable without a terminal.
 */

export interface EditState {
  text: string;
  cursor: number; // index into text, 0..text.length
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Insert printable text (newlines allowed — this is the multi-line widget). */
export function insert(s: EditState, raw: string): EditState {
  const clean = raw.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  if (!clean) return s;
  return { text: s.text.slice(0, s.cursor) + clean + s.text.slice(s.cursor), cursor: s.cursor + clean.length };
}

export function backspace(s: EditState): EditState {
  if (s.cursor === 0) return s;
  return { text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 };
}

export function forwardDelete(s: EditState): EditState {
  return { text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), cursor: s.cursor };
}

/** Where the cursor sits in line/column terms — the rendering view of it. */
export function cursorPos(s: EditState): { row: number; col: number } {
  const before = s.text.slice(0, s.cursor);
  const row = (before.match(/\n/g) ?? []).length;
  const col = s.cursor - (before.lastIndexOf("\n") + 1);
  return { row, col };
}

export function textLines(s: EditState): string[] {
  return s.text.split("\n");
}

export function moveHorizontal(s: EditState, delta: -1 | 1): EditState {
  return { ...s, cursor: clamp(s.cursor + delta, 0, s.text.length) };
}

/** Up/down keeps the column where the target line allows it (editor convention). */
export function moveVertical(s: EditState, delta: -1 | 1): EditState {
  const ls = textLines(s);
  const { row, col } = cursorPos(s);
  const target = row + delta;
  if (target < 0 || target >= ls.length) return s;
  const start = ls.slice(0, target).reduce((n, l) => n + l.length + 1, 0);
  return { ...s, cursor: start + Math.min(col, ls[target]!.length) };
}

export function lineHome(s: EditState): EditState {
  const before = s.text.slice(0, s.cursor);
  return { ...s, cursor: before.lastIndexOf("\n") + 1 };
}

export function lineEnd(s: EditState): EditState {
  const next = s.text.indexOf("\n", s.cursor);
  return { ...s, cursor: next === -1 ? s.text.length : next };
}
