/**
 * A multi-line text editor for the compose body — enter inserts a newline;
 * ctrl+d finishes, ctrl+e hands off to $EDITOR, esc steps back. While `active`
 * it owns every key (the app's dispatcher goes quiet). All editing logic lives
 * in textarea-ops; this component only routes keys and paints the cursor.
 */

import { Box, ScrollBox, Text, useInput } from "ink-terminal";
import { useRef } from "react";
import { theme } from "../theme.ts";
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
} from "./textarea-ops.ts";

export interface TextAreaProps {
  state: EditState;
  onChange: (next: EditState) => void;
  onDone: () => void;
  onCancel: () => void;
  onEditor?: () => void;
  active: boolean;
  height?: number;
}

export function TextArea({ state, onChange, onDone, onCancel, onEditor, active, height = 8 }: TextAreaProps) {
  // ink dispatches a whole stdin chunk in ONE React batch; reading the `state`
  // prop sees the pre-batch closure and drops keys (review #7). The ref updates
  // synchronously per key, so each item builds on the previous item's result.
  const live = useRef(state);
  live.current = state;
  const apply = (next: EditState): void => {
    live.current = next;
    onChange(next);
  };
  useInput(
    (input, key) => {
      const s = live.current;
      if (key.escape) return onCancel();
      if (key.ctrl && input === "d") return onDone();
      if (key.ctrl && input === "e") return onEditor?.();
      if (key.return) return apply(insert(s, "\n"));
      if (key.leftArrow) return apply(moveHorizontal(s, -1));
      if (key.rightArrow) return apply(moveHorizontal(s, 1));
      if (key.upArrow) return apply(moveVertical(s, -1));
      if (key.downArrow) return apply(moveVertical(s, 1));
      if (key.home || (key.ctrl && input === "a")) return apply(lineHome(s));
      if (key.end) return apply(lineEnd(s));
      if (key.backspace) return apply(backspace(s));
      if (key.delete) return apply(forwardDelete(s));
      if (input && !key.ctrl && !key.meta && !key.tab) return apply(insert(s, input));
    },
    { isActive: active },
  );

  const ls = textLines(state);
  const { row, col } = cursorPos(state);
  return (
    <Box height={height} flexDirection="column">
      <ScrollBox flexGrow={1}>
        {ls.map((line, i) => (
          <Text key={`l${i}`}>
            {active && i === row ? (
              <>
                {line.slice(0, col)}
                {/* caret is an explicit accent block — `inverse` renders as nothing in this renderer */}
                <Text backgroundColor={theme.accent} color="ansi:black">{line[col] ?? " "}</Text>
                {line.slice(col + 1)}
              </>
            ) : (
              line || " "
            )}
          </Text>
        ))}
      </ScrollBox>
    </Box>
  );
}
