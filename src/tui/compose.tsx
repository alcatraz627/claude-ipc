/**
 * The compose flow: recipient → kind → body → reply-by → confirm, each step its
 * own panel, esc always one step back — never out. Pure render; the app owns
 * the state machine and every key except the body editor's.
 */

import { Box, Text } from "ink-terminal";
import type { EditState } from "./widgets/textarea-ops.ts";
import { TextArea } from "./widgets/TextArea.tsx";
import { inlineHead } from "./model.ts";
import { theme } from "./theme.ts";

export type ComposeStep = "to" | "kind" | "body" | "replyBy" | "confirm";

export interface RecipientOption {
  label: string; // what the picker shows
  value: string; // alias, proj:<dir>, or "*"
}

export interface ComposeState {
  t: "compose";
  step: ComposeStep;
  recipients: RecipientOption[];
  toSel: number;
  to: string | null;
  kindSel: number;
  kind: "inform" | "query" | "request";
  body: EditState;
  replyBySel: number;
}

export const KINDS = ["inform", "query", "request"] as const;

/** Reply-by presets; seconds, or null = "no reply expected". */
export const REPLY_BY_OPTIONS: { label: string; value: number | null }[] = [
  { label: "5m — nudge them at five minutes", value: 300 },
  { label: "15m", value: 900 },
  { label: "1h", value: 3600 },
  { label: "none — no reply expected, nobody chased", value: null },
];

const STEP_TITLE: Record<ComposeStep, string> = {
  to: "compose 1/5 — to whom?",
  kind: "compose 2/5 — what kind?",
  body: "compose 3/5 — the message",
  replyBy: "compose 4/5 — how long will you wait?",
  confirm: "compose 5/5 — send it?",
};

const PICKER_WINDOW = 9;

export function ComposePanel({
  c,
  onBodyChange,
  onBodyDone,
  onBodyCancel,
  onBodyEditor,
  onPickRecipient,
}: {
  c: ComposeState;
  onBodyChange: (e: EditState) => void;
  onBodyDone: () => void;
  onBodyCancel: () => void;
  onBodyEditor: () => void;
  onPickRecipient: (i: number) => void;
}) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1} minWidth={64}>
        <Text bold color={theme.accent}>
          {STEP_TITLE[c.step]}
        </Text>
        {c.step === "to" && <RecipientStep c={c} onPick={onPickRecipient} />}
        {c.step === "kind" && (
          <Box flexDirection="column" marginTop={1}>
            {KINDS.map((k, i) => (
              <Text key={k} inverse={i === c.kindSel}>
                {` ${k}${k === "inform" ? "  (no reply expected)" : k === "query" ? "  (a question)" : "  (asks them to act)"} `}
              </Text>
            ))}
          </Box>
        )}
        {c.step === "body" && (
          <Box flexDirection="column" marginTop={1}>
            <TextArea
              state={c.body}
              onChange={onBodyChange}
              onDone={onBodyDone}
              onCancel={onBodyCancel}
              onEditor={onBodyEditor}
              active
            />
            <Text dim>enter newline · ctrl+d done · ctrl+e $EDITOR · esc back (empty body never sends)</Text>
          </Box>
        )}
        {c.step === "replyBy" && (
          <Box flexDirection="column" marginTop={1}>
            {REPLY_BY_OPTIONS.map((o, i) => (
              <Text key={o.label} inverse={i === c.replyBySel}>
                {` ${o.label} `}
              </Text>
            ))}
          </Box>
        )}
        {c.step === "confirm" && <ConfirmStep c={c} />}
        {c.step !== "body" && (
          <Box marginTop={1}>
            <Text dim>↑↓ move · enter next · esc back one step</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function RecipientStep({ c, onPick }: { c: ComposeState; onPick: (i: number) => void }) {
  const start = Math.max(0, Math.min(c.toSel - Math.floor(PICKER_WINDOW / 2), c.recipients.length - PICKER_WINDOW));
  const shown = c.recipients.slice(start, start + PICKER_WINDOW);
  return (
    <Box flexDirection="column" marginTop={1}>
      {start > 0 && <Text dim>{`  ▲ ${start} more`}</Text>}
      {shown.map((r, i) => (
        <Box key={r.value} onClick={() => onPick(start + i)}>
          <Text inverse={start + i === c.toSel}>{` ${r.label} `}</Text>
        </Box>
      ))}
      {start + shown.length < c.recipients.length && (
        <Text dim>{`  ▼ ${c.recipients.length - start - shown.length} more`}</Text>
      )}
    </Box>
  );
}

function ConfirmStep({ c }: { c: ComposeState }) {
  const rb = c.kind === "inform" ? null : REPLY_BY_OPTIONS[c.replyBySel]!.value;
  const contract =
    c.kind === "inform"
      ? "an inform expects no reply"
      : rb === null
        ? "no reply expected — nobody will be chased"
        : `they get nudged at ${rb / 60}m; later you're released to act without an answer`;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Row k="to" v={c.to ?? "?"} />
      <Row k="kind" v={c.kind} />
      <Row k="body" v={inlineHead(c.body.text, 100)} />
      <Row k="contract" v={contract} />
      <Box marginTop={1}>
        <Text>
          <Text bold color={theme.ok}>
            enter
          </Text>
          <Text> send · </Text>
          <Text bold>esc</Text>
          <Text> back</Text>
        </Text>
      </Box>
    </Box>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <Text wrap="truncate-end">
      <Text dim>{k.padEnd(9)}</Text>
      <Text>{v}</Text>
    </Text>
  );
}
