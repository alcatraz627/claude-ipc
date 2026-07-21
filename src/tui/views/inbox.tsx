/**
 * The inbox surface: a list of this identity's pending mail and a full-body
 * reading pane. Rendered two ways — compact as the home view's lower-left pane,
 * and full-width as the INBOX tab. Pure render; state lives in the app.
 */

import { Box, ScrollBox, Text } from "ink-terminal";
import type { Message } from "../../models.ts";
import { actionsFor, inboxLine, messagePreview } from "../model.ts";
import { kindColor, theme } from "../theme.ts";

export interface InboxListProps {
  messages: Message[];
  sel: number;
  nowS: number;
  focused: boolean;
  identityKnown: boolean;
  seen: ReadonlySet<string>; // session-local reading aid — display only, never consumes
  owedOnly: boolean;
  onSelect: (i: number) => void;
  onFocus: () => void;
  scrollRef: React.Ref<unknown>;
}

export function InboxList(p: InboxListProps) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={p.focused ? theme.accent : undefined}
      paddingX={1}
      onClick={p.onFocus}
    >
      <Text dim>{`inbox — ${p.messages.length} ${p.owedOnly ? "owed (f = everything)" : "pending"}`}</Text>
      <ScrollBox ref={p.scrollRef as never} flexGrow={1}>
        {p.messages.length === 0 && (
          <Text dim>
            {p.owedOnly
              ? "nothing owed — f shows everything"
              : p.identityKnown
                ? "nothing pending — all caught up"
                : "read-only: @ to pick an identity"}
          </Text>
        )}
        {p.messages.map((m, i) => {
          const line = inboxLine(m, p.nowS);
          return (
            <Box key={m.id} onClick={() => p.onSelect(i)}>
              <Text wrap="truncate-end">
                <Text bold color={theme.accent}>{p.focused && i === p.sel ? "› " : "  "}</Text>
                <Text color={kindColor(m.kind, m.status)} dim={p.seen.has(m.id)}>{line.tag}</Text>
                <Text dim>{`  ${line.age}  `}</Text>
                <Text dim={p.seen.has(m.id)}>{line.head}</Text>
              </Text>
            </Box>
          );
        })}
      </ScrollBox>
    </Box>
  );
}

export function MessagePane({
  msg,
  nowS,
  thread,
}: {
  msg: Message | undefined;
  nowS: number;
  thread: { question: string | null; replies: number } | null;
}) {
  if (!msg) return <Text dim>select a message</Text>;
  const data = messagePreview(msg, nowS, thread);
  const acts = actionsFor(msg);
  const keys = [
    acts.reply ? "r reply" : null,
    acts.accept ? "a accept" : null,
    acts.decline ? "d decline" : null,
    acts.snooze ? "s snooze" : null,
    "y copy",
  ].filter(Boolean);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {data.title}
      </Text>
      {data.rows.map((r, i) => (
        <Text key={`${r.label}-${i}`} wrap="wrap">
          <Text dim>{`${r.label.padEnd(9)} `}</Text>
          <Text color={r.accent ? theme.warn : undefined}>{r.value}</Text>
        </Text>
      ))}
      <Box marginTop={1} flexGrow={1}>
        <Text wrap="wrap">{data.body || " "}</Text>
      </Box>
      <Text dim>{keys.join(" · ")}</Text>
    </Box>
  );
}
