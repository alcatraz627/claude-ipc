/**
 * A one-line editable text field — ink-terminal ships no input widget, so the
 * dashboard carries its own. The parent owns the value; the field owns the
 * cursor and, while `active`, consumes ALL keys (the app's dispatcher goes
 * quiet so a typed "q" is a character, never the quit key).
 */

import { Text, useInput } from "ink-terminal";
import { useEffect, useRef, useState } from "react";
import { theme } from "../theme.ts";

export interface TextFieldProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  active: boolean;
  prefix?: string;
  placeholder?: string;
}

export function TextField({ value, onChange, onSubmit, onCancel, active, prefix = "", placeholder }: TextFieldProps) {
  const [cursor, setCursor] = useState(value.length);
  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);
  // ink dispatches a whole stdin chunk in ONE React batch; a handler reading
  // props/state sees the pre-batch closure and drops keys (review #7). The ref
  // updates synchronously per key, so each item sees the previous item's result.
  const live = useRef({ value, cursor });
  live.current = { value, cursor: Math.min(cursor, value.length) };
  const apply = (nextValue: string, nextCursor: number): void => {
    live.current = { value: nextValue, cursor: Math.max(0, Math.min(nextCursor, nextValue.length)) };
    onChange(nextValue);
    setCursor(live.current.cursor);
  };
  const moveCursor = (to: number): void => {
    live.current.cursor = Math.max(0, Math.min(to, live.current.value.length));
    setCursor(live.current.cursor);
  };

  useInput(
    (input, key) => {
      const { value: v, cursor: c } = live.current;
      if (key.escape) return onCancel();
      if (key.return) return onSubmit();
      if (key.leftArrow) return moveCursor(c - 1);
      if (key.rightArrow) return moveCursor(c + 1);
      if (key.home || (key.ctrl && input === "a")) return moveCursor(0);
      if (key.end || (key.ctrl && input === "e")) return moveCursor(v.length);
      if (key.backspace) {
        if (c === 0) return;
        return apply(v.slice(0, c - 1) + v.slice(c), c - 1);
      }
      if (key.delete) return apply(v.slice(0, c) + v.slice(c + 1), c);
      if (key.ctrl && input === "u") return apply("", 0);
      // Anything left with visible characters is typed text (covers paste too —
      // bracketed paste arrives here as a multi-char `input`).
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
        const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
        if (!clean) return;
        return apply(v.slice(0, c) + clean + v.slice(c), c + clean.length);
      }
    },
    { isActive: active },
  );

  if (!value && !active) {
    return (
      <Text dim>
        {prefix}
        {placeholder ?? ""}
      </Text>
    );
  }
  const at = value[cursor] ?? " ";
  return (
    <Text>
      {prefix}
      {value.slice(0, cursor)}
      {active ? <Text backgroundColor={theme.accent} color="ansi:black">{at}</Text> : null}
      {active ? value.slice(cursor + 1) : value.slice(cursor)}
    </Text>
  );
}
