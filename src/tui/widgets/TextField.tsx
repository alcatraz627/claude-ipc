/**
 * A one-line editable text field — ink-terminal ships no input widget, so the
 * dashboard carries its own. The parent owns the value; the field owns the
 * cursor and, while `active`, consumes ALL keys (the app's dispatcher goes
 * quiet so a typed "q" is a character, never the quit key).
 */

import { Text, useInput } from "ink-terminal";
import { useEffect, useState } from "react";

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

  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.return) return onSubmit();
      // functional updates: key-repeat delivers several moves in one React batch
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));
      if (key.home || (key.ctrl && input === "a")) return setCursor(0);
      if (key.end || (key.ctrl && input === "e")) return setCursor(value.length);
      if (key.backspace) {
        if (cursor === 0) return;
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        return setCursor(cursor - 1);
      }
      if (key.delete) {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1));
        return;
      }
      if (key.ctrl && input === "u") {
        onChange("");
        return setCursor(0);
      }
      // Anything left with visible characters is typed text (covers paste too —
      // bracketed paste arrives here as a multi-char `input`).
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
        const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
        if (!clean) return;
        onChange(value.slice(0, cursor) + clean + value.slice(cursor));
        setCursor(cursor + clean.length);
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
      {active ? <Text inverse>{at}</Text> : null}
      {active ? value.slice(cursor + 1) : value.slice(cursor)}
    </Text>
  );
}
