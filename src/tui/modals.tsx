/**
 * The dashboard's modal panels — copy menu, quit guard, help, identity picker.
 * Pure render: all state and every keypress lives in the app's single
 * dispatcher, so a modal can never fight another handler for a key.
 */

import { Box, Text } from "ink-terminal";
import type { Message } from "../models.ts";
import type { CopyField, PreviewData } from "./model.ts";
import { inlineHead } from "./model.ts";
import { theme } from "./theme.ts";
import { TextField } from "./widgets/TextField.tsx";

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
            <Text>
              <Text bold color={theme.accent}>{i === sel ? "›" : " "}</Text>
              <Text color={theme.accent}>{` ${i + 1} `}</Text>
              <Text dim>{f.label.padEnd(14)}</Text>
              <Text> {inlineHead(f.value, 48)} </Text>
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

/** The `v` card: the whole fabric at a glance. Data comes from fabricOverview. */
export function Overview({ data }: { data: PreviewData }) {
  return (
    <Frame title={data.title}>
      <Box flexDirection="column" marginTop={1}>
        {data.rows.map((r, i) => (
          <Text key={`${r.label}-${i}`}>
            <Text dim>{r.label.padEnd(10)}</Text>
            <Text color={r.accent ? theme.warn : undefined}>{r.value}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dim>esc / v close</Text>
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
          <Text key={a}>
            <Text bold color={theme.accent}>{start + i === sel ? "› " : "  "}</Text>
            {a}
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

/**
 * Answer or decline an ask without leaving the dashboard. Single-line for now —
 * the multi-line textarea + $EDITOR escalation is the compose modal's job.
 */
export function AskInput({
  mode,
  msg,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: "reply" | "decline";
  msg: Message;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <Frame title={mode === "reply" ? `reply to ${msg.id}` : `decline ${msg.id}`}>
      <Box flexDirection="column" marginTop={1}>
        <Text dim wrap="truncate-end">{`${msg.kind} from ${inlineHead(msg.fromAlias, 24)}: ${inlineHead(msg.body, 60)}`}</Text>
        <Box marginTop={1}>
          <TextField
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            onCancel={onCancel}
            active
            prefix="> "
            placeholder={mode === "reply" ? "your answer" : "reason (optional)"}
          />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dim>{mode === "reply" ? "enter send · esc back (a reply needs a body)" : "enter decline · esc back"}</Text>
      </Box>
    </Frame>
  );
}

const HELP_LINES: [string, string][] = [
  ["tab / 1-5", "switch view"],
  ["↑↓ / jk", "move selection"],
  ["/", "filter roster / search log (! = regex · esc clears)"],
  ["y", "copy menu for the selection"],
  ["v", "fabric overview"],
  ["u", "pause / resume the auto-refresh"],
  ["+ / -", "slower / faster auto-refresh"],
  ["< / >", "roster sort: status · seen · alias · owed"],
  ["f", "inbox: show only what's owed"],
  ["m", "inbox: mark seen (local · never consumes)"],
  ["o", "expand / collapse offline peers"],
  ["c / enter", "compose (enter on a peer prefills them)"],
  ["i / →", "focus the inbox pane (esc returns)"],
  ["r a d s", "reply · accept · decline · snooze (inbox)"],
  ["R", "refresh now (auto every 5s)"],
  ["@", "act as a different identity"],
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
