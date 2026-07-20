/**
 * The home view: roster and inbox stacked on the left, both independently
 * scrolling, with a preview of the focused pane's selection on the right.
 * Pure render — selection, focus, and filter state live in the app.
 */

import { Box, ScrollBox, Spacer, Text } from "ink-terminal";
import { basename } from "node:path";
import type { Message } from "../../models.ts";
import type { PreviewData, RosterRow } from "../model.ts";
import { ageLabel, inlineHead } from "../model.ts";
import { STATUS_COLOR, STATUS_GLYPH, theme } from "../theme.ts";
import { TextField } from "../widgets/TextField.tsx";
import { InboxList, MessagePane } from "./inbox.tsx";

export type Pane = "roster" | "inbox";

export interface HomeViewProps {
  rows: RosterRow[]; // visible rows (already filtered, offline handled)
  offlineHidden: number; // count collapsed behind the "+N offline" row
  sel: number;
  nowS: number;
  preview: PreviewData | null;
  filter: string;
  filterEditing: boolean;
  onFilterChange: (v: string) => void;
  onFilterSubmit: () => void;
  onFilterCancel: () => void;
  onSelect: (i: number) => void;
  onExpandOffline: () => void;
  scrollRef: React.Ref<unknown>;
  // the inbox half
  inbox: Message[];
  inboxSel: number;
  focusedPane: Pane;
  identityKnown: boolean;
  thread: { question: string | null; replies: number } | null;
  onInboxSelect: (i: number) => void;
  onFocusPane: (p: Pane) => void;
  inboxScrollRef: React.Ref<unknown>;
}

export function HomeView(p: HomeViewProps) {
  const rosterFocused = p.focusedPane === "roster";
  return (
    <Box flexGrow={1} gap={1}>
      <Box flexDirection="column" width="60%" flexShrink={0}>
        <Box
          flexDirection="column"
          flexGrow={3}
          borderStyle="single"
          borderColor={rosterFocused ? theme.accent : undefined}
          paddingX={1}
          onClick={() => p.onFocusPane("roster")}
        >
          {(p.filterEditing || p.filter) && (
            <TextField
              value={p.filter}
              onChange={p.onFilterChange}
              onSubmit={p.onFilterSubmit}
              onCancel={p.onFilterCancel}
              active={p.filterEditing}
              prefix="/"
              placeholder="filter"
            />
          )}
          <ScrollBox ref={p.scrollRef as never} flexGrow={1}>
            {p.rows.length === 0 && (
              <Text dim>{p.filter ? "nothing matches the filter" : "no peers registered yet"}</Text>
            )}
            {p.rows.map((r, i) => (
              <Box key={r.key} onClick={() => p.onSelect(i)}>
                <RosterLine row={r} selected={rosterFocused && i === p.sel} nowS={p.nowS} />
              </Box>
            ))}
            {p.offlineHidden > 0 && (
              <Box onClick={p.onExpandOffline}>
                <Text dim>{`  +${p.offlineHidden} offline  (o to expand)`}</Text>
              </Box>
            )}
          </ScrollBox>
        </Box>
        {/* an empty inbox earns 3 rows, not half the column (the roster absorbs the rest) */}
        <Box flexGrow={p.inbox.length === 0 ? 0 : 2} height={p.inbox.length === 0 ? 4 : undefined} flexDirection="column">
          <InboxList
            messages={p.inbox}
            sel={p.inboxSel}
            nowS={p.nowS}
            focused={p.focusedPane === "inbox"}
            identityKnown={p.identityKnown}
            onSelect={p.onInboxSelect}
            onFocus={() => p.onFocusPane("inbox")}
            scrollRef={p.inboxScrollRef}
          />
        </Box>
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
        {rosterFocused ? (
          p.preview ? (
            <Preview data={p.preview} />
          ) : (
            <Text dim>select a peer</Text>
          )
        ) : (
          <MessagePane msg={p.inbox[p.inboxSel]} nowS={p.nowS} thread={p.thread} />
        )}
      </Box>
    </Box>
  );
}

function RosterLine({ row, selected, nowS }: { row: RosterRow; selected: boolean; nowS: number }) {
  const glyph = STATUS_GLYPH[row.status];
  const color = STATUS_COLOR[row.status];
  const name = row.also.length ? `${row.alias} (+${row.also.length})` : row.alias;
  return (
    <Text wrap="truncate-end">
      {/* cursor is a printed character, not an attribute — the renderer's damage
          diff misses attribute-only changes on the first-painted row */}
      <Text bold color={theme.accent}>{selected ? "› " : "  "}</Text>
      <Text color={color} dim={row.status === "offline"}>
        {glyph}
      </Text>
      {/* selection lives in the prefix ONLY: a bold toggle here is an attr-only
          cell change, which the renderer's damage diff repaints with stale colors */}
      <Text bold={row.you}>{` ${inlineHead(name, 28).padEnd(29)}`}</Text>
      <Text dim>{`${inlineHead(basename(row.cwd) || "?", 16).padEnd(17)}${ageLabel(row.lastSeen, nowS)}`}</Text>
      {row.you ? <Text color={theme.accent}> you</Text> : null}
    </Text>
  );
}

function Preview({ data }: { data: PreviewData }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.accent}>
          {data.title}
        </Text>
        <Spacer />
      </Box>
      {data.rows.map((r, i) => (
        <Text key={`${r.label}-${i}`} wrap="wrap">
          <Text dim>{r.label ? `${r.label.padEnd(9)} ` : "          "}</Text>
          <Text color={r.accent ? theme.warn : undefined}>{r.value}</Text>
        </Text>
      ))}
    </Box>
  );
}
