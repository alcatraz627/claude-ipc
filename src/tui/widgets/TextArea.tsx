/**
 * A multi-line text editor for the compose body — enter inserts a newline;
 * ctrl+d finishes, ctrl+e hands off to $EDITOR, esc steps back. While `active`
 * it owns every key (the app's dispatcher goes quiet). All editing logic lives
 * in textarea-ops; this component only routes keys and paints the cursor.
 */

import { Box, ScrollBox, Text, useInput } from "ink-terminal";
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
  useInput(
    (input, key) => {
      if (key.escape) return onCancel();
      if (key.ctrl && input === "d") return onDone();
      if (key.ctrl && input === "e") return onEditor?.();
      if (key.return) return onChange(insert(state, "\n"));
      if (key.leftArrow) return onChange(moveHorizontal(state, -1));
      if (key.rightArrow) return onChange(moveHorizontal(state, 1));
      if (key.upArrow) return onChange(moveVertical(state, -1));
      if (key.downArrow) return onChange(moveVertical(state, 1));
      if (key.home || (key.ctrl && input === "a")) return onChange(lineHome(state));
      if (key.end) return onChange(lineEnd(state));
      if (key.backspace) return onChange(backspace(state));
      if (key.delete) return onChange(forwardDelete(state));
      if (input && !key.ctrl && !key.meta && !key.tab) return onChange(insert(state, input));
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
