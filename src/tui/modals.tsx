/**
 * The dashboard's modal panels — copy menu, quit guard, help, identity picker.
 * Pure render: all state and every keypress lives in the app's single
 * dispatcher, so a modal can never fight another handler for a key.
 */

import { Box, Text } from "ink-terminal";
import type { CopyField } from "./model.ts";
import { inlineHead } from "./model.ts";
import { theme } from "./theme.ts";

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1} minWidth={50}>
        <Text bold color={theme.accent}>
          {title}
        </Text>
        {children}
      </Box>
    </Box>
  );
}

export function CopyMenu({
  fields,
  sel,
  onPick,
}: {
  fields: CopyField[];
  sel: number;
  onPick: (i: number) => void;
}) {
  return (
    <Frame title="copy to clipboard">
      <Box flexDirection="column" marginTop={1}>
        {fields.map((f, i) => (
          <Box key={f.label} onClick={() => onPick(i)}>
            <Text inverse={i === sel}>
              {` ${i + 1} `}
              <Text bold={i === sel}>{f.label.padEnd(14)}</Text>
              <Text dim> {inlineHead(f.value, 48)} </Text>
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dim>↑↓ move · enter/1-9 copy · esc back</Text>
      </Box>
    </Frame>
  );
}

export function QuitGuard() {
  return (
    <Frame title="quit claude-ipc?">
      <Box marginTop={1}>
        <Text>
          <Text bold color={theme.warn}>
            y
          </Text>
          <Text> quit · </Text>
          <Text bold>n / esc</Text>
          <Text> stay (default)</Text>
        </Text>
      </Box>
    </Frame>
  );
}

/** How many picker rows are visible at once — a real machine has 100+ registered
 *  aliases, and an unwindowed list overflows the frame into an unreadable wall. */
const PICKER_WINDOW = 9;

export function IdentityPicker({ candidates, sel }: { candidates: string[]; sel: number }) {
  const start = Math.max(0, Math.min(sel - Math.floor(PICKER_WINDOW / 2), candidates.length - PICKER_WINDOW));
  const shown = candidates.slice(start, start + PICKER_WINDOW);
  return (
    <Frame title="act as which alias?">
      <Box flexDirection="column" marginTop={1}>
        <Text dim>This shell isn't a Claude session — pick a registered identity to act as.</Text>
        {start > 0 && <Text dim>{`  ▲ ${start} more`}</Text>}
        {shown.map((a, i) => (
          <Text key={a} inverse={start + i === sel}>
            {` ${a} `}
          </Text>
        ))}
        {start + shown.length < candidates.length && (
          <Text dim>{`  ▼ ${candidates.length - start - shown.length} more`}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dim>{`${sel + 1}/${candidates.length} · ↑↓/pgup/pgdn move · enter pick · esc = read-only`}</Text>
      </Box>
    </Frame>
  );
}

const HELP_LINES: [string, string][] = [
  ["tab / 1-5", "switch view"],
  ["↑↓ / jk", "move selection"],
  ["/", "filter the list (esc clears)"],
  ["y", "copy menu for the selection"],
  ["o", "expand / collapse offline peers"],
  ["R", "refresh now (auto every 5s)"],
  ["a", "act as a different identity"],
  ["d", "start the broker (when down)"],
  ["?", "this help"],
  ["q / esc", "quit (guarded)"],
];

export function Help() {
  return (
    <Frame title="keys">
      <Box flexDirection="column" marginTop={1}>
        {HELP_LINES.map(([k, desc]) => (
          <Text key={k}>
            <Text bold color={theme.accent}>
              {k.padEnd(12)}
            </Text>
            <Text>{desc}</Text>
          </Text>
        ))}
      </Box>
    </Frame>
  );
}
