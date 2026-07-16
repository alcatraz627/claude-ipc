/**
 * The PEERS view: the live roster on the left, a detail preview of the selected
 * session on the right. Pure render — selection, filter, and scrolling state
 * live in the app; this file only draws a snapshot of them.
 */

import { Box, ScrollBox, Spacer, Text } from "ink-terminal";
import { basename } from "node:path";
import type { PreviewData, RosterRow } from "../model.ts";
import { ageLabel, inlineHead } from "../model.ts";
import { STATUS_COLOR, STATUS_GLYPH, theme } from "../theme.ts";
import { TextField } from "../widgets/TextField.tsx";

export interface PeersViewProps {
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
}

export function PeersView(p: PeersViewProps) {
  return (
    <Box flexGrow={1} gap={1}>
      <Box flexDirection="column" width="55%" borderStyle="single" borderColor={theme.accent} paddingX={1}>
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
              <RosterLine row={r} selected={i === p.sel} nowS={p.nowS} />
            </Box>
          ))}
          {p.offlineHidden > 0 && (
            <Box onClick={p.onExpandOffline}>
              <Text dim>{`  +${p.offlineHidden} offline  (o to expand)`}</Text>
            </Box>
          )}
        </ScrollBox>
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
        {p.preview ? <Preview data={p.preview} /> : <Text dim>select a peer</Text>}
      </Box>
    </Box>
  );
}

function RosterLine({ row, selected, nowS }: { row: RosterRow; selected: boolean; nowS: number }) {
  const glyph = STATUS_GLYPH[row.status];
  const color = STATUS_COLOR[row.status];
  const name = row.also.length ? `${row.alias} (+${row.also.length})` : row.alias;
  return (
    <Text inverse={selected} wrap="truncate-end">
      <Text color={color} dim={row.status === "offline"}>
        {glyph}
      </Text>
      <Text bold={row.you || selected}>{` ${inlineHead(name, 28).padEnd(29)}`}</Text>
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
