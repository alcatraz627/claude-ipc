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
  deliveryLines,
  dedupeMessages,
  fabricOverview,
  filterMessages,
  filterRoster,
  sortRoster,
  trafficSparkline,
  groupRoster,
  inboxLine,
  logLine,
  rosterFilterInvalid,
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
  test("unknown counts say WHY they're unknown — never a crash, never a fake zero", () => {
    const data = peerPreview(row, 2000, null, undefined);
    expect(data.rows.find((r) => r.label === "inbox")!.value).toBe("unknown — no token to peek with");
    const offline = groupRoster([peer({ alias: "vb", sessionId: "sid-vb", status: "offline" })])[0]!;
    const dataOff = peerPreview(offline, 2000, null, undefined);
    expect(dataOff.rows.find((r) => r.label === "inbox")!.value).toBe("unknown — offline sessions aren't peeked");
  });
  test("owed > 0 flags the inbox line", () => {
    const data = peerPreview(row, 2000, { unread: 3, owed: 2 }, undefined);
    const inbox = data.rows.find((r) => r.label === "inbox")!;
    expect(inbox.value).toBe("3 unread · 2 owed");
    expect(inbox.accent).toBe(true);
  });
});

describe("filterRoster regex mode", () => {
  const rows = groupRoster([
    peer({ alias: "vb-fable", sessionId: "s1" }),
    peer({ alias: "catch-b7", sessionId: "s2", cwd: "/x/claude-ipc" }),
  ]);
  test("a leading ! switches to regex", () => {
    expect(filterRoster(rows, "!^vb-").map((r) => r.alias)).toEqual(["vb-fable"]);
  });
  test("regex is case-insensitive and matches cwd", () => {
    expect(filterRoster(rows, "!CLAUDE-IPC$").map((r) => r.alias)).toEqual(["catch-b7"]);
  });
  test("an invalid regex matches nothing (honest mid-typing state)", () => {
    expect(filterRoster(rows, "!(")).toEqual([]);
  });
  test("a bare ! matches everything", () => {
    expect(filterRoster(rows, "!").length).toBe(2);
  });
});

describe("fabricOverview", () => {
  test("counts sessions, peeked pending, projects, orphans, traffic", () => {
    const snap = {
      brokerUp: true,
      peers: [peer({ alias: "a", sessionId: "s1" }), peer({ alias: "b", sessionId: "s2", status: "offline" as const })],
      peerInboxes: new Map([
        [
          "a",
          [
            msg({ id: "m1", kind: "query", fromAlias: "x", toAlias: "a", ts: 1 }),
            msg({ id: "m2", kind: "inform", fromAlias: "x", toAlias: "a", ts: 2 }),
          ],
        ],
      ]),
      projects: [{ pending: 3 }],
      orphans: [{ pending: 2 }, { pending: 5 }],
      history: [msg({ id: "m3", kind: "inform", fromAlias: "x", toAlias: "y", ts: 3 })],
    };
    const o = fabricOverview(snap, undefined);
    const val = (label: string) => o.rows.find((r) => r.label === label)!.value;
    expect(val("broker")).toBe("up");
    expect(val("sessions")).toContain("2 (1 live · 0 idle · 1 offline)");
    expect(val("pending")).toContain("2 unread · 1 owed");
    expect(val("pending")).toContain("1 peeked session");
    expect(val("projects")).toContain("3 pending");
    expect(val("orphans")).toContain("2 dead sessions · 7 held");
    expect(val("traffic")).toContain("1 message in the last 24h");
  });
  test("a down broker is accented, never hidden", () => {
    const o = fabricOverview(
      { brokerUp: false, peers: [], peerInboxes: new Map(), projects: [], orphans: [], history: [] },
      undefined,
    );
    const broker = o.rows.find((r) => r.label === "broker")!;
    expect(broker.value).toBe("DOWN");
    expect(broker.accent).toBe(true);
  });
});

describe("filterMessages (log search)", () => {
  const flow = [
    msg({ id: "a", kind: "inform", fromAlias: "vb-fable", toAlias: "me", ts: 1, body: "deploy done" }),
    msg({ id: "b", kind: "query", fromAlias: "cl-inst", toAlias: "me", ts: 2, body: "meld phase?" }),
  ];
  test("matches body and either alias, case-insensitively", () => {
    expect(filterMessages(flow, "DEPLOY").map((m) => m.id)).toEqual(["a"]);
    expect(filterMessages(flow, "cl-inst").map((m) => m.id)).toEqual(["b"]);
    expect(filterMessages(flow, "")).toEqual(flow);
  });
  test("! prefix is regex; invalid regex matches nothing", () => {
    expect(filterMessages(flow, "!^meld").map((m) => m.id)).toEqual(["b"]);
    expect(filterMessages(flow, "!(")).toEqual([]);
  });
});

describe("sortRoster", () => {
  const rows = groupRoster(
    [
      peer({ alias: "me", sessionId: "s0", lastSeen: 100 }),
      peer({ alias: "zed", sessionId: "s1", lastSeen: 900 }),
      peer({ alias: "amy", sessionId: "s2", lastSeen: 500 }),
    ],
    "me",
  );
  test("status keeps groupRoster order untouched", () => {
    expect(sortRoster(rows, "status")).toEqual(rows);
  });
  test("you stay pinned first in every sort", () => {
    for (const key of ["seen", "alias", "owed"] as const) {
      expect(sortRoster(rows, key)[0]!.alias).toBe("me");
    }
  });
  test("seen ranks by freshest lastSeen, alias alphabetically", () => {
    expect(sortRoster(rows, "seen").map((r) => r.alias)).toEqual(["me", "zed", "amy"]);
    expect(sortRoster(rows, "alias").map((r) => r.alias)).toEqual(["me", "amy", "zed"]);
  });
  test("owed ranks by the provided counter", () => {
    const owed = (r: { alias: string }) => (r.alias === "amy" ? 3 : 0);
    expect(sortRoster(rows, "owed", owed).map((r) => r.alias)).toEqual(["me", "amy", "zed"]);
  });
});

describe("deliveryLines (D1)", () => {
  test("maps the lifecycle to the CLI's honest labels", () => {
    const lines = deliveryLines([
      { toAlias: "a", state: "queued" },
      { toAlias: "b", state: "delivered" },
      { toAlias: "c", state: "consumed" },
    ]);
    expect(lines[0]).toBe("a: queued — not yet claimed by their session · waits for their next wake");
    expect(lines[1]).toBe("b: delivered — claimed by their wake, not yet shown");
    expect(lines[2]).toBe("c: settled — read, accepted, declined, or cancelled");
  });
  test("surfaced carries its NOT-confirmed-read gloss — the D1 false-confidence guard", () => {
    expect(deliveryLines([{ toAlias: "a", state: "surfaced" }])[0]).toBe(
      "a: surfaced — placed in their context (NOT confirmed read)",
    );
  });
  test("accepted and declined are their own rendered states", () => {
    expect(deliveryLines([{ toAlias: "a", state: "accepted" }])[0]).toBe("a: accepted");
    expect(deliveryLines([{ toAlias: "b", state: "declined" }])[0]).toBe("b: declined");
  });
  test("an unknown state renders raw — never remapped to something friendlier", () => {
    expect(deliveryLines([{ toAlias: "x", state: "weird" }])).toEqual(["x: weird"]);
  });
  test("peer-controlled alias text is neutralized", () => {
    expect(deliveryLines([{ toAlias: "e\x1b[31mvil", state: "queued" }])[0]).toStartWith("evil:");
  });
});

describe("groupRoster D3 fields", () => {
  test("carries the freshest sinceSeenS and any succeededSid across the session's aliases", () => {
    const rows = groupRoster([
      peer({ alias: "a1", sessionId: "s1", sessionAliases: ["a1", "a2"], sinceSeenS: 300 }),
      peer({ alias: "a2", sessionId: "s1", sessionAliases: ["a1", "a2"], sinceSeenS: 40, succeededSid: "dead-sid-123" }),
    ]);
    expect(rows[0]!.sinceSeenS).toBe(40);
    expect(rows[0]!.succeededSid).toBe("dead-sid-123");
  });
});

describe("peerPreview D3 honesty", () => {
  test("status names its basis and prefers broker-computed freshness", () => {
    const row = groupRoster([peer({ alias: "vb", sessionId: "s", sinceSeenS: 45 })])[0]!;
    const data = peerPreview(row, 2000, null, undefined, 2000);
    const status = data.rows.find((r) => r.label === "status")!.value;
    expect(status).toContain("(heartbeat)");
    expect(status).toContain("45s ago");
    // freshness AGES from the snapshot, not from the render clock: a paused
    // dashboard must not keep claiming "45s ago" forever
    const later = peerPreview(row, 2120, null, undefined, 2000);
    expect(later.rows.find((r) => r.label === "status")!.value).toContain("3m ago"); // 45+120s, rounded to nearest
  });
  test("a takeover gets its own accented row", () => {
    const row = groupRoster([peer({ alias: "vb", sessionId: "s", succeededSid: "0123456789abcdef" })])[0]!;
    const data = peerPreview(row, 2000, null, undefined);
    const t = data.rows.find((r) => r.label === "takeover")!;
    expect(t.value).toBe("succeeded dead session 01234567…");
    expect(t.accent).toBe(true);
  });
});

describe("review-slate fixes: dedupe, honest denominators, sanitized identity fields", () => {
  const msg = (id: string, over: Partial<Message> = {}): Message =>
    makeMessage({ id, kind: "inform", fromAlias: "x", toAlias: "y", ts: 1, ...over });

  test("dedupeMessages counts a sibling-box duplicate once", () => {
    const m1 = msg("m1");
    const m2 = msg("m2", { kind: "query" });
    expect(dedupeMessages([m1, m2, m1, m2, m1]).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("fabricOverview: a two-alias session's box counts once, denominator is sessions", () => {
    const box = [msg("m1"), msg("m2", { kind: "query" })];
    const snap = {
      brokerUp: true,
      peers: [
        peer({ alias: "lane-a", sessionId: "sid-1", sessionAliases: ["lane-a", "lane-b"] }),
        peer({ alias: "lane-b", sessionId: "sid-1", sessionAliases: ["lane-a", "lane-b"] }),
      ],
      peerInboxes: new Map([
        ["lane-a", box],
        ["lane-b", box], // the SAME session box, once per alias — the inflation shape
      ]),
      projects: [],
      orphans: [],
      history: [],
    };
    const pending = fabricOverview(snap, undefined).rows.find((r) => r.label === "pending")!;
    expect(pending.value).toContain("2 unread · 1 owed"); // not 4 and 2
    expect(pending.value).toContain("1 peeked session"); // not 2 inboxes
  });

  test("fabricOverview: a failed read renders unknown, never a clean zero", () => {
    const snap = {
      brokerUp: true,
      peers: [],
      peerInboxes: new Map(),
      projects: [],
      orphans: [],
      history: [],
      unreadable: { history: true, projects: true, orphans: false },
    };
    const rows = fabricOverview(snap, undefined).rows;
    expect(rows.find((r) => r.label === "traffic")!.value).toContain("unknown");
    expect(rows.find((r) => r.label === "projects")!.value).toContain("unknown");
    expect(rows.find((r) => r.label === "orphans")!.value).not.toContain("unknown"); // read fine, honestly zero
  });

  test("groupRoster neutralizes ANSI in registrant-supplied cwd and sessionId", () => {
    const rows = groupRoster([peer({ alias: "evil", sessionId: "sid-\x1b[31mred", cwd: "/tmp/\x1b[2Jwipe" })]);
    expect(rows[0]!.cwd).not.toContain("\x1b");
    expect(rows[0]!.sessionId).not.toContain("\x1b");
  });
});

describe("polish pass: unforgeable hidden marker, labeled invalid filter", () => {
  const marker = "[hidden — you are not a party to this message; run with --operator to see all bodies]";

  test("logLine trusts the broker's bodyHidden flag, never marker-lookalike body text", () => {
    const forged = makeMessage({ id: "f1", kind: "inform", fromAlias: "x", toAlias: "y", ts: 1, body: marker });
    const real = makeMessage({ id: "f2", kind: "inform", fromAlias: "x", toAlias: "y", ts: 1, body: marker, bodyHidden: true });
    expect(logLine(forged, 10).head).not.toBe("· hidden"); // forgery renders as ordinary text
    expect(logLine(real, 10).head).toBe("· hidden");
  });

  test("rosterFilterInvalid flags a bad !regex and nothing else", () => {
    expect(rosterFilterInvalid("!foo(")).toBe(true);
    expect(rosterFilterInvalid("!foo")).toBe(false);
    expect(rosterFilterInvalid("plain")).toBe(false);
    expect(rosterFilterInvalid("!")).toBe(false);
  });
});

describe("trafficSparkline", () => {
  test("buckets by age, newest rightmost, scaled to the max", () => {
    const now = 24 * 3600;
    const hist = [
      msg({ id: "a", kind: "inform", fromAlias: "x", toAlias: "y", ts: now - 30 }), // newest bucket
      msg({ id: "b", kind: "inform", fromAlias: "x", toAlias: "y", ts: now - 40 }),
      msg({ id: "c", kind: "inform", fromAlias: "x", toAlias: "y", ts: 10 }), // oldest bucket
      msg({ id: "d", kind: "inform", fromAlias: "x", toAlias: "y", ts: -5 }), // outside the window: dropped
    ];
    const s = trafficSparkline(hist, now, 12);
    expect(s.length).toBe(12);
    expect(s[11]).toBe("█"); // 2 messages = the max
    expect(s[0]).not.toBe("▁"); // 1 message still visibly non-zero
    expect(s[5]).toBe("▁"); // an empty bucket is the baseline
  });
  test("no traffic reads as a flat baseline, honestly zero", () => {
    expect(trafficSparkline([], 1000, 8)).toBe("▁".repeat(8));
  });
});
