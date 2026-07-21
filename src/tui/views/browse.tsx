/**
 * The read-only fabric views: PROJECTS (directory mailboxes), ORPHANS (dead
 * sessions still holding mail), and LOG (the recent flow). Each is a list with
 * a detail pane that peeks the selection without consuming anything. Pure
 * render; state and keys live in the app.
 */

import { Box, ScrollBox, Text } from "ink-terminal";
import type { Message } from "../../models.ts";
import type { OrphanBox, ProjectBox } from "../data.ts";
import { ageLabel, inlineHead, logLine, sanitizeBlock, sanitizeInline } from "../model.ts";
import { kindColor, theme } from "../theme.ts";
import { TextField } from "../widgets/TextField.tsx";

function Split({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) {
  return (
    <Box flexGrow={1} gap={1}>
      <Box flexDirection="column" width="55%" flexShrink={0} borderStyle="single" borderColor={theme.accent} paddingX={1}>
        {list}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
        {detail}
      </Box>
    </Box>
  );
}

/** A peeked mailbox rendered read-only — what's waiting, for whoever looks. */
function MailPeek({ messages, nowS }: { messages: Message[] | null; nowS: number }) {
  if (messages === null) return <Text dim>couldn't read this mailbox</Text>;
  if (messages.length === 0) return <Text dim>empty</Text>;
  return (
    <ScrollBox flexGrow={1}>
      {messages.map((m) => (
        <Box key={m.id} flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={kindColor(m.kind, m.status)}>{m.kind}</Text>
            <Text dim>{` from ${sanitizeInline(m.fromAlias)} · ${ageLabel(m.ts, nowS)} ago · ${m.id}`}</Text>
          </Text>
          <Text wrap="wrap">{inlineHead(sanitizeBlock(m.body), 300)}</Text>
        </Box>
      ))}
    </ScrollBox>
  );
}

export function ProjectsView({
  projects,
  sel,
  nowS,
  peeked,
  onSelect,
}: {
  projects: ProjectBox[];
  sel: number;
  nowS: number;
  peeked: Message[] | null;
  onSelect: (i: number) => void;
}) {
  return (
    <Split
      list={
        <ScrollBox flexGrow={1}>
          {projects.length === 0 && <Text dim>no project mailboxes with pending mail</Text>}
          {projects.map((p, i) => (
            <Box key={p.address} onClick={() => onSelect(i)}>
              {/* basename first — a deep path truncates at the end, and the leaf is the part a human recognizes */}
              <Text wrap="truncate-end">
                <Text bold color={theme.accent}>{i === sel ? "› " : "  "}</Text>
                <Text>{p.path.split("/").pop() || p.path}</Text>
                <Text dim>{`  ${p.pending} pending · ${p.path}`}</Text>
              </Text>
            </Box>
          ))}
        </ScrollBox>
      }
      detail={
        projects[sel] ? (
          <>
            <Text bold color={theme.accent}>
              {projects[sel]!.path}
            </Text>
            <MailPeek messages={peeked} nowS={nowS} />
          </>
        ) : (
          <Text dim>select a project</Text>
        )
      }
    />
  );
}

export function OrphansView({
  orphans,
  sel,
  nowS,
  peeked,
  onSelect,
}: {
  orphans: OrphanBox[];
  sel: number;
  nowS: number;
  peeked: Message[] | null;
  onSelect: (i: number) => void;
}) {
  return (
    <Split
      list={
        <ScrollBox flexGrow={1}>
          {orphans.length === 0 && <Text dim>no dead sessions are holding mail — clean fabric</Text>}
          {orphans.map((o, i) => {
            // an auto-registered session leaves its full sid as the alias; 36 chars
            // of hex at body contrast bury the NAMED rows that carry the ranking
            const sid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(o.alias);
            const name = sid ? `${o.alias.slice(0, 8)}…` : sanitizeInline(o.alias);
            return (
              <Box key={o.alias} onClick={() => onSelect(i)}>
                <Text wrap="truncate-end">
                  <Text bold color={theme.accent}>{i === sel ? "› " : "  "}</Text>
                  <Text dim={sid}>{name.padEnd(26)}</Text>
                  {/* triage split: open = live word, folded = superseded (advisory — still peekable) */}
                  {typeof o.open === "number" && typeof o.folded === "number" && o.folded > 0 ? (
                    <>
                      <Text>{`${o.open} open`}</Text>
                      <Text dim>{` · ${o.folded} folded`}</Text>
                    </>
                  ) : (
                    <Text>{`${o.pending} waiting`}</Text>
                  )}
                  <Text dim>
                    {`${o.oldestTs ? ` · oldest ${ageLabel(o.oldestTs, nowS)}` : ""}${o.cwd ? ` · ${o.cwd.split("/").pop()}` : ""}`}
                  </Text>
                </Text>
              </Box>
            );
          })}
        </ScrollBox>
      }
      detail={
        orphans[sel] ? (
          <>
            <Text bold color={theme.accent}>
              {sanitizeInline(orphans[sel]!.alias)}
            </Text>
            <Text dim wrap="truncate-end">{`${orphans[sel]!.cwd ?? "cwd unknown"} · y copies the peek/claim commands`}</Text>
            <MailPeek messages={peeked} nowS={nowS} />
          </>
        ) : (
          <Text dim>select an orphan</Text>
        )
      }
    />
  );
}

export function LogView({
  history,
  sel,
  nowS,
  operator,
  deliveries,
  query,
  queryEditing,
  onQueryChange,
  onQuerySubmit,
  onQueryCancel,
  onSelect,
}: {
  history: Message[]; // newest first
  sel: number;
  nowS: number;
  operator: boolean;
  deliveries: string[] | null; // per-recipient lifecycle, only for a message the viewer sent
  query: string;
  queryEditing: boolean;
  onQueryChange: (v: string) => void;
  onQuerySubmit: () => void;
  onQueryCancel: () => void;
  onSelect: (i: number) => void;
}) {
  const m = history[sel];
  return (
    <Split
      list={
        <>
          {(queryEditing || query) && (
            <TextField
              value={query}
              onChange={onQueryChange}
              onSubmit={onQuerySubmit}
              onCancel={onQueryCancel}
              active={queryEditing}
              prefix="/"
              placeholder="search bodies + routes (! = regex)"
            />
          )}
          <Text dim>{`last 24h · ${history.length} messages · bodies: ${operator ? "OPERATOR (all)" : "party-scoped"} (o toggles)`}</Text>
          <ScrollBox flexGrow={1}>
            {history.length === 0 && <Text dim>no traffic in the last 24h</Text>}
            {history.map((msg, i) => {
              const l = logLine(msg, nowS);
              return (
                <Box key={msg.id} onClick={() => onSelect(i)}>
                  <Text wrap="truncate-end">
                    <Text bold color={theme.accent}>{i === sel ? "› " : "  "}</Text>
                    <Text dim>{l.age.padStart(4)} </Text>
                    <Text>{l.route}</Text>
                    <Text color={kindColor(msg.kind, msg.status)}>{` ${l.kind} `}</Text>
                    <Text dim>{l.head}</Text>
                  </Text>
                </Box>
              );
            })}
          </ScrollBox>
        </>
      }
      detail={
        m ? (
          <>
            <Text bold color={theme.accent}>
              {m.id}
            </Text>
            <Text dim>{`${sanitizeInline(m.fromAlias)} → ${sanitizeInline(m.toAlias)} · ${m.kind} · ${ageLabel(m.ts, nowS)} ago`}</Text>
            {m.corrId && <Text dim>{`answers ${m.corrId}`}</Text>}
            {deliveries?.map((line) => (
              <Text key={line} dim wrap="truncate-end">{`  ${line}`}</Text>
            ))}
            <Box marginTop={1}>
              <Text wrap="wrap">{sanitizeBlock(m.body) || " "}</Text>
            </Box>
          </>
        ) : (
          <Text dim>select a message</Text>
        )
      }
    />
  );
}
