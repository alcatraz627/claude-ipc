/**
 * The RCA fix batch's broker-side behaviors: empty sends refused everywhere,
 * liveness refreshed by acting ops only (never by polls), reply-to-inform for
 * recipients without any ask machinery, and honest recipient/asker status on
 * send/reply results. Each guards a defect that did live damage on 2026-07-16.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/broker/registry.ts";
import { Router } from "../src/broker/router.ts";
import type { Request } from "../src/protocol.ts";
import { MemoryBackend } from "../src/storage/memoryBackend.ts";
import { Client } from "../src/client.ts";

describe("rca fixes — router level", () => {
  let backend: MemoryBackend;
  let registry: Registry;
  let router: Router;
  let clock = 1000;
  let idn = 0;
  const tokens = new Map<string, string>();

  const call = (op: string, args: Record<string, unknown>, as?: string) =>
    router.handle({ v: 1, op, args, token: as ? tokens.get(as) : undefined } as unknown as Request);
  const okOf = (r: { ok: boolean; result?: unknown; error?: { code: string } }) => {
    expect(r.ok).toBe(true);
    return r.result as Record<string, unknown>;
  };
  const codeOf = (r: { ok: boolean; error?: { code: string } }) => {
    expect(r.ok).toBe(false);
    return r.error!.code;
  };
  const reg = (alias: string, sid: string, cwd = "/w") => {
    const r = okOf(call("register", { alias, sessionId: sid, cwd }));
    tokens.set(alias, r.token as string);
  };

  beforeEach(() => {
    clock = 1000;
    idn = 0;
    tokens.clear();
    backend = new MemoryBackend();
    registry = new Registry(backend, () => clock, { idleS: 300, offlineS: 1800 });
    router = new Router(backend, registry, () => clock, () => `msg-${++idn}`, null);
    reg("alice", "sA");
    reg("bob", "sB");
  });

  describe("empty_send (F1)", () => {
    test("empty and whitespace-only bodies are refused for every kind", () => {
      for (const kind of ["inform", "query", "request"]) {
        expect(codeOf(call("send", { from: "alice", to: "bob", kind, body: "" }, "alice"))).toBe("empty_send");
        expect(codeOf(call("send", { from: "alice", to: "bob", kind, body: "   " }, "alice"))).toBe("empty_send");
      }
      expect(backend.history({}).length).toBe(0); // nothing persisted
    });

    test("degraded mode refuses the same class (the MCP-with-broker-down door)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ipc-rca-"));
      // strict mode checks identity before content — hold a token so the empty
      // guard (not the auth guard) is what fires, same precedence as the broker
      mkdirSync(join(dir, "t"), { recursive: true });
      writeFileSync(join(dir, "t", "x"), "tok-test");
      const c = new Client("/tmp/definitely-not-a-socket.sock", { dbPath: join(dir, "d.sqlite") }, join(dir, "t"));
      await expect(c.send({ from: "x", to: "y", kind: "inform", body: "  " })).rejects.toThrow(/empty_send/);
    });
  });

  describe("acting-op liveness (F2)", () => {
    test("an authorized send refreshes the whole session; a poll never does", () => {
      clock += 600; // alice + bob both idle now
      expect((okOf(call("list", {})).peers as { alias: string; status: string }[]).every((p) => p.status === "idle")).toBe(true);
      okOf(call("send", { from: "alice", to: "bob", kind: "inform", body: "hi" }, "alice"));
      let peers = okOf(call("list", {})).peers as { alias: string; status: string }[];
      expect(peers.find((p) => p.alias === "alice")!.status).toBe("live"); // the actor
      expect(peers.find((p) => p.alias === "bob")!.status).toBe("idle"); // receiving is not acting
      clock += 600; // decay again, then storm bob's mailbox with polls
      for (let i = 0; i < 20; i++) okOf(call("check", { alias: "bob", consume: false }, "bob"));
      okOf(call("count", { alias: "bob" }, "bob"));
      okOf(call("list", {}));
      peers = okOf(call("list", {})).peers as { alias: string; status: string }[];
      expect(peers.find((p) => p.alias === "bob")!.status).toBe("idle"); // a watcher can't fake life
    });

    test("acting refreshes sibling aliases of the same session", () => {
      reg("alice-2", "sA");
      clock += 600;
      okOf(call("reply", { from: "alice", corrId: seedAsk("bob", "alice"), body: "ans" }, "alice"));
      const peers = okOf(call("list", {})).peers as { alias: string; status: string }[];
      expect(peers.find((p) => p.alias === "alice-2")!.status).toBe("live");
    });

    test("an explicitly-left alias is NOT resurrected by an acting op (sticky leave)", () => {
      okOf(call("leave", { alias: "alice" }, "alice"));
      okOf(call("send", { from: "alice", to: "bob", kind: "inform", body: "still allowed" }, "alice"));
      const peers = okOf(call("list", {})).peers as { alias: string; status: string }[];
      expect(peers.find((p) => p.alias === "alice")!.status).toBe("offline");
    });
  });

  const seedAsk = (from: string, to: string): string => {
    const r = okOf(call("send", { from, to, kind: "query", body: "q?" }, from));
    return r.msgId as string;
  };

  describe("reply-to-inform (F5, owner-ruled)", () => {
    const seedInform = (): string =>
      okOf(call("send", { from: "alice", to: "bob", kind: "inform", body: "fyi: thing happened" }, "alice"))
        .msgId as string;

    test("the recipient's reply threads a correlated response, with zero ask machinery", () => {
      const id = seedInform();
      const r = okOf(call("reply", { from: "bob", corrId: id, body: "thanks, noted" }, "bob"));
      expect(r.msgId).toBeDefined();
      const resp = backend.history({}).find((m) => m.id === r.msgId)!;
      expect(resp).toMatchObject({ kind: "response", toAlias: "alice", corrId: id });
      expect(resp.conversationId).toBe(backend.get(id)!.conversationId);
      expect(backend.getAwaiting(id)).toBeNull(); // nothing owed, nothing to nudge
      expect(backend.pending("alice").map((m) => m.id)).toContain(r.msgId as string); // delivered
      expect(backend.pending("bob").map((m) => m.id)).not.toContain(id); // replier's copy consumed
    });

    test("the inform's author is steered to send, a third party has no standing, empties refused", () => {
      const id = seedInform();
      expect(codeOf(call("reply", { from: "alice", corrId: id, body: "also..." }, "alice"))).toBe("not_an_ask");
      reg("carol", "sC");
      expect(codeOf(call("reply", { from: "carol", corrId: id, body: "me too" }, "carol"))).toBe("not_yours");
      expect(codeOf(call("reply", { from: "bob", corrId: id, body: "  " }, "bob"))).toBe("empty_reply");
    });

    test("an error-status reply may be body-less — same exemption as the ask path", () => {
      const id = seedInform();
      const r = okOf(call("reply", { from: "bob", corrId: id, body: "", status: "error", errorCode: "internal" }, "bob"));
      expect(r.msgId).toBeDefined();
    });

    test("reply to a RESPONSE still steers to send (scope is informs only)", () => {
      const q = seedAsk("alice", "bob");
      const ans = okOf(call("reply", { from: "bob", corrId: q, body: "here" }, "bob"));
      expect(codeOf(call("reply", { from: "alice", corrId: ans.msgId as string, body: "ty" }, "alice"))).toBe(
        "not_an_ask",
      );
    });
  });

  describe("party-scoping is sibling-aware (B12 — found in the post-deploy round-trip)", () => {
    test("show/status renders the body for a message addressed to a SIBLING alias of the caller", () => {
      reg("dream-main", "sid-dream");
      reg("dream-alt", "sid-dream"); // same session, two names
      // addressed to the SIBLING; caller presents dream-main's token
      const sent = okOf(call("send", { from: "alice", to: "dream-alt", kind: "inform", body: "secret for the dream lane" }, "alice"));
      const res = okOf(call("status", { msgId: sent.msgId as string }, "dream-main"));
      expect((res.message as { body: string }).body).toBe("secret for the dream lane"); // not [hidden]
    });

    test("a true non-party (different session) still gets the body blanked", () => {
      reg("stranger", "sid-stranger");
      const sent = okOf(call("send", { from: "alice", to: "bob", kind: "inform", body: "not for strangers" }, "alice"));
      const res = okOf(call("status", { msgId: sent.msgId as string }, "stranger"));
      expect((res.message as { body: string }).body).toContain("hidden");
    });
  });

  describe("recipient/asker status on results (F3/F4)", () => {
    test("send reports the recipient's roster status; reply reports the asker's", () => {
      clock += 3600; // bob decays to offline
      registry.heartbeat("alice"); // keep the sender fresh
      const s = okOf(call("send", { from: "alice", to: "bob", kind: "query", body: "there?" }, "alice"));
      expect((s.recipient as { status: string }).status).toBe("offline");
      const r = okOf(call("reply", { from: "bob", corrId: s.msgId as string, body: "back now" }, "bob"));
      expect((r.asker as { status: string }).status).toBe("live");
    });

    test("broadcast and project sends carry no recipient status", () => {
      const s = okOf(call("send", { from: "alice", to: "*", kind: "inform", body: "all hands" }, "alice"));
      expect(s.recipient).toBeUndefined();
    });
  });
});
