/**
 * The dashboard's view-model is pure functions over broker JSON — this is the
 * automated half of the TUI test strategy (the rendered frame is walked by hand
 * in a real terminal; see the build plan's validation section).
 */

import { describe, expect, test } from "bun:test";
import { makeMessage, type Message, type RegistryEntry } from "../src/models.ts";
import {
  actionsFor,
  copyFieldsForMessage,
  copyFieldsForPeer,
  filterRoster,
  groupRoster,
  inboxLine,
  inlineHead,
  lastMessageFor,
  lastOpenAskFrom,
  messagePreview,
  peerPreview,
  pendingStats,
  sanitizeBlock,
  sanitizeInline,
} from "../src/tui/model.ts";

const peer = (over: Partial<RegistryEntry>): RegistryEntry => ({
  alias: "a",
  sessionId: "sid-a",
  cwd: "/tmp/proj",
  caps: [],
  pid: null,
  tty: null,
  lastSeen: 1000,
  status: "live",
  token: null,
  ...over,
});

const msg = (over: Partial<Message> & Pick<Message, "id" | "kind" | "fromAlias" | "toAlias" | "ts">): Message =>
  makeMessage(over);

describe("sanitizeInline", () => {
  test("strips CSI color/style sequences", () => {
    expect(sanitizeInline("\x1b[31mred\x1b[0m ok")).toBe("red ok");
  });
  test("strips OSC title/hyperlink sequences", () => {
    expect(sanitizeInline("\x1b]0;evil title\x07body")).toBe("body");
    expect(sanitizeInline("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
  test("newlines become visible, control bytes vanish", () => {
    expect(sanitizeInline("a\nb\r\nc")).toBe("a␤b␤c");
    expect(sanitizeInline("a\x00\x07b\tc")).toBe("ab  c");
  });
});

describe("inlineHead", () => {
  test("short strings pass through, long ones ellipsize inside the budget", () => {
    expect(inlineHead("short", 10)).toBe("short");
    const out = inlineHead("x".repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("groupRoster", () => {
  const roster = [
    peer({ alias: "vb-opus", sessionId: "sid-1", sessionAliases: ["vb-opus", "catch-fbl"], lastSeen: 500 }),
    peer({ alias: "catch-fbl", sessionId: "sid-1", sessionAliases: ["vb-opus", "catch-fbl"], status: "idle", lastSeen: 900 }),
    peer({ alias: "solo", sessionId: "sid-2", status: "idle", lastSeen: 800 }),
    peer({ alias: "me", sessionId: "sid-3", lastSeen: 950 }),
    peer({ alias: "dead", sessionId: "sid-4", status: "offline", lastSeen: 10 }),
  ];

  test("one session = one row, siblings folded into `also`", () => {
    const rows = groupRoster(roster, "me");
    expect(rows.length).toBe(4);
    const merged = rows.find((r) => r.sessionId === "sid-1")!;
    // live outranks idle for the head alias, and the row carries the freshest lastSeen
    expect(merged.alias).toBe("vb-opus");
    expect(merged.also).toEqual(["catch-fbl"]);
    expect(merged.lastSeen).toBe(900);
  });

  test("you first, then live before idle before offline", () => {
    const rows = groupRoster(roster, "me");
    expect(rows[0]!.you).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(["live", "live", "idle", "offline"]);
  });

  test("peer-chosen alias text is neutralized for display", () => {
    const rows = groupRoster([peer({ alias: "evil\x1b[31m", sessionId: "sid-9" })]);
    expect(rows[0]!.alias).toBe("evil");
  });
});

describe("filterRoster", () => {
  const rows = groupRoster([
    peer({ alias: "alpha", sessionId: "s1", cwd: "/code/widget" }),
    peer({ alias: "beta", sessionId: "s2", sessionAliases: ["beta", "sidekick"], cwd: "/code/other" }),
    peer({ alias: "sidekick", sessionId: "s2", sessionAliases: ["beta", "sidekick"], cwd: "/code/other" }),
  ]);
  test("matches alias, sibling alias, and cwd, case-insensitively", () => {
    expect(filterRoster(rows, "ALPHA").map((r) => r.alias)).toEqual(["alpha"]);
    expect(filterRoster(rows, "sidekick").map((r) => r.sessionId)).toEqual(["s2"]);
    expect(filterRoster(rows, "widget").map((r) => r.alias)).toEqual(["alpha"]);
    expect(filterRoster(rows, "")).toEqual(rows);
  });
});

describe("pendingStats", () => {
  test("owed counts only the kinds that expect an answer", () => {
    const box = [
      msg({ id: "1", kind: "inform", fromAlias: "a", toAlias: "b", ts: 1 }),
      msg({ id: "2", kind: "query", fromAlias: "a", toAlias: "b", ts: 2 }),
      msg({ id: "3", kind: "request", fromAlias: "a", toAlias: "b", ts: 3 }),
      msg({ id: "4", kind: "response", fromAlias: "b", toAlias: "a", ts: 4 }),
    ];
    expect(pendingStats(box)).toEqual({ unread: 4, owed: 2 });
  });
});

describe("last-message helpers", () => {
  const history = [
    msg({ id: "1", kind: "inform", fromAlias: "x", toAlias: "me", ts: 10 }),
    msg({ id: "2", kind: "query", fromAlias: "x", toAlias: "me", ts: 20 }),
    msg({ id: "3", kind: "inform", fromAlias: "other", toAlias: "someone", ts: 30 }),
  ];
  test("lastMessageFor picks the newest touching any session alias", () => {
    expect(lastMessageFor(history, ["x"])?.id).toBe("2");
    expect(lastMessageFor(history, ["nobody"])).toBeUndefined();
  });
  test("lastOpenAskFrom only sees asks from those aliases still in my inbox", () => {
    expect(lastOpenAskFrom(history, ["x"])?.id).toBe("2");
    expect(lastOpenAskFrom(history, ["other"])).toBeUndefined(); // theirs is an inform
  });
});

describe("copyFieldsForPeer", () => {
  const row = groupRoster([peer({ alias: "vb", sessionId: "sid-vb", cwd: "/code/vb" })])[0]!;
  test("with an open ask, the command answers it", () => {
    const ask = msg({ id: "msg-77", kind: "query", fromAlias: "vb", toAlias: "me", ts: 5 });
    const fields = copyFieldsForPeer(row, "me", ask, ask);
    const cmd = fields.find((f) => f.label === "reply command")!;
    expect(cmd.value).toBe('claude-ipc reply msg-77 --from me "<answer>"');
    expect(fields.map((f) => f.label)).toContain("session-id");
  });
  test("without one, it falls back to a send addressed to them", () => {
    const fields = copyFieldsForPeer(row, "me", undefined, undefined);
    const cmd = fields.find((f) => f.label === "send command")!;
    expect(cmd.value).toBe('claude-ipc send --to vb --from me "<message>"');
    expect(fields.some((f) => f.label === "reply command")).toBe(false);
  });
  test("no identity yet → a visible placeholder, not a broken command", () => {
    const fields = copyFieldsForPeer(row, undefined, undefined, undefined);
    expect(fields.at(-1)!.value).toContain("--from <you>");
  });
});

describe("sanitizeBlock", () => {
  test("keeps newlines but drops escapes and control bytes", () => {
    expect(sanitizeBlock("line1\n\x1b[31mline2\x07")).toBe("line1\nline2");
  });
});

describe("actionsFor", () => {
  test("verbs follow the kind", () => {
    const at = (kind: Message["kind"]) => actionsFor(msg({ id: "1", kind, fromAlias: "a", toAlias: "b", ts: 1 }));
    expect(at("inform")).toEqual({ reply: false, accept: false, decline: false, snooze: false });
    expect(at("query")).toEqual({ reply: true, accept: false, decline: false, snooze: true });
    expect(at("request")).toEqual({ reply: true, accept: true, decline: true, snooze: true });
  });
});

describe("inboxLine", () => {
  test("tags kind + sender, marks error responses, neutralizes alias text", () => {
    const q = inboxLine(msg({ id: "1", kind: "query", fromAlias: "vb\x1b[31m", toAlias: "me", ts: 10, body: "hi" }), 20);
    expect(q.tag).toBe("query from vb");
    const err = inboxLine(
      msg({ id: "2", kind: "response", fromAlias: "x", toAlias: "me", ts: 10, status: "error", errorCode: "declined" }),
      20,
    );
    expect(err.tag).toBe("response:declined from x");
  });
});

describe("copyFieldsForMessage", () => {
  test("asks carry a reply command; informs don't", () => {
    const ask = msg({ id: "msg-9", kind: "request", fromAlias: "vb", toAlias: "me", ts: 1, body: "do it" });
    const askFields = copyFieldsForMessage(ask, "me");
    expect(askFields.find((f) => f.label === "reply command")!.value).toContain("reply msg-9 --from me");
    const info = msg({ id: "msg-10", kind: "inform", fromAlias: "vb", toAlias: "me", ts: 1 });
    expect(copyFieldsForMessage(info, "me").some((f) => f.label === "reply command")).toBe(false);
  });
});

describe("messagePreview", () => {
  test("shows routing, thread context, and a sanitized multi-line body", () => {
    const m = msg({
      id: "msg-5",
      kind: "response",
      fromAlias: "vb",
      toAlias: "me",
      ts: 10,
      corrId: "msg-1",
      body: "a\n\x1b[2mb",
    });
    const p = messagePreview(m, 70, { question: "original ask", replies: 2 });
    expect(p.rows.find((r) => r.label === "answers")!.value).toBe("msg-1");
    expect(p.rows.find((r) => r.label === "asked")!.value).toBe("original ask");
    expect(p.rows.find((r) => r.label === "thread")!.value).toBe("2 replies so far");
    expect(p.body).toBe("a\nb");
  });
});

describe("peerPreview", () => {
  const row = groupRoster([peer({ alias: "vb", sessionId: "sid-vb" })])[0]!;
  test("unknown counts render as ? — never a crash, never a fake zero", () => {
    const data = peerPreview(row, 2000, null, undefined);
    expect(data.rows.find((r) => r.label === "inbox")!.value).toBe("?");
  });
  test("owed > 0 flags the inbox line", () => {
    const data = peerPreview(row, 2000, { unread: 3, owed: 2 }, undefined);
    const inbox = data.rows.find((r) => r.label === "inbox")!;
    expect(inbox.value).toBe("3 unread · 2 owed");
    expect(inbox.accent).toBe(true);
  });
});
