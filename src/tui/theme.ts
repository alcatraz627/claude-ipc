/**
 * The dashboard's visual vocabulary: what "live" looks like, what an error
 * looks like, which glyphs mark message kinds.
 *
 * Semantic ANSI names only (`ansi:*`), never hex — the terminal's own palette
 * resolves them, so both dark and light themes look native. Glyphs mirror the
 * `tail` monitor's so the two surfaces read as one tool.
 */

import type { Color } from "ink-terminal/core";

export type PeerStatus = "live" | "idle" | "offline";

export const STATUS_GLYPH: Record<PeerStatus, string> = {
  live: "●",
  idle: "◐",
  offline: "○",
};

export const STATUS_COLOR: Record<PeerStatus, Color | undefined> = {
  live: "ansi:green",
  idle: "ansi:yellow",
  offline: undefined, // rendered dim, not colored — the graveyard shouldn't compete
};

/** Message-kind accent, matching the `tail` monitor's coloring. */
export function kindColor(kind: string, status?: string | null): Color {
  if (kind === "query") return "ansi:cyan";
  if (kind === "request") return "ansi:yellow";
  if (kind === "response") return status === "error" ? "ansi:red" : "ansi:green";
  return "ansi:white";
}

export const theme = {
  accent: "ansi:cyan", // focused borders, selected tab, the active affordance
  ok: "ansi:green",
  warn: "ansi:yellow",
  err: "ansi:red",
  selBg: "ansi:blue", // selected row background; white text on top stays legible on light & dark
} as const;
