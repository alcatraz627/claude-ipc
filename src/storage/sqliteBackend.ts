/**
 * SQLite storage backend — the default durable substrate.
 *
 * `messages` is strictly append-only (the full history, never mutated); all
 * mutable state lives in `deliveries` (per-recipient read/consent) and `awaiting`
 * (the sender's open/closed request view). That separation is what makes
 * broadcast fan-out, per-recipient idempotency, and reply-after-timeout
 * well-defined. Uses Bun's built-in SQLite — no external dependency.
 */

import { Database } from "bun:sqlite";
import type {
  Awaiting,
  ContextPtr,
  Delivery,
  DeliveryState,
  ErrorCode,
  Kind,
  Message,
  RegistryEntry,
  Status,
} from "../models.ts";
import type { StorageBackend } from "./base.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, kind TEXT, from_alias TEXT, to_alias TEXT, body TEXT,
  conversation_id TEXT, corr_id TEXT, status TEXT, error_code TEXT,
  terminal INTEGER, op TEXT, context_ptr TEXT, ttl_s INTEGER, ts REAL);
CREATE INDEX IF NOT EXISTS ix_msg_corr ON messages(corr_id);
CREATE INDEX IF NOT EXISTS ix_msg_ts   ON messages(ts);

CREATE TABLE IF NOT EXISTS deliveries (
  msg_id TEXT, to_alias TEXT, via TEXT, state TEXT, ts REAL,
  PRIMARY KEY (msg_id, to_alias));
CREATE INDEX IF NOT EXISTS ix_del_inbox ON deliveries(to_alias, state);

CREATE TABLE IF NOT EXISTS awaiting (
  origin_id TEXT PRIMARY KEY, expires_at REAL, closed INTEGER, closed_reason TEXT);
CREATE INDEX IF NOT EXISTS ix_await_open ON awaiting(closed, expires_at);

CREATE TABLE IF NOT EXISTS registry_snapshot (
  alias TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, caps TEXT,
  pid INTEGER, tty TEXT, last_seen REAL, status TEXT, token TEXT);
`;

interface MsgRow {
  id: string;
  kind: string;
  from_alias: string;
  to_alias: string;
  body: string;
  conversation_id: string | null;
  corr_id: string | null;
  status: string | null;
  error_code: string | null;
  terminal: number;
  op: string | null;
  context_ptr: string | null;
  ttl_s: number | null;
  ts: number;
}

interface DelRow {
  msg_id: string;
  to_alias: string;
  via: string | null;
  state: string;
  ts: number;
}

interface AwaitRow {
  origin_id: string;
  expires_at: number | null;
  closed: number;
  closed_reason: string | null;
}

interface RegRow {
  alias: string;
  session_id: string;
  cwd: string;
  caps: string;
  pid: number | null;
  tty: string | null;
  last_seen: number;
  status: string;
  token: string | null;
}

function toMessage(r: MsgRow): Message {
  return {
    id: r.id,
    kind: r.kind as Kind,
    fromAlias: r.from_alias,
    toAlias: r.to_alias,
    body: r.body,
    conversationId: r.conversation_id,
    corrId: r.corr_id,
    status: r.status as Status | null,
    errorCode: r.error_code as ErrorCode | null,
    terminal: r.terminal !== 0,
    op: r.op as Message["op"],
    contextPtr: r.context_ptr ? (JSON.parse(r.context_ptr) as ContextPtr) : null,
    ttlS: r.ttl_s,
    ts: r.ts,
  };
}

function toDelivery(r: DelRow): Delivery {
  return {
    msgId: r.msg_id,
    toAlias: r.to_alias,
    via: r.via as Delivery["via"],
    state: r.state as DeliveryState,
    ts: r.ts,
  };
}

function toAwaiting(r: AwaitRow): Awaiting {
  return {
    originId: r.origin_id,
    expiresAt: r.expires_at,
    closed: r.closed !== 0,
    closedReason: r.closed_reason as Awaiting["closedReason"],
  };
}

export class SqliteBackend implements StorageBackend {
  private db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 2000");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    try {
      this.db.run("ALTER TABLE registry_snapshot ADD COLUMN tty TEXT");
    } catch {
      // column already present on an existing DB — fine
    }
    try {
      this.db.run("ALTER TABLE registry_snapshot ADD COLUMN token TEXT");
    } catch {
      // column already present on an existing DB — fine
    }
  }

  append(m: Message): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO messages
         (id, kind, from_alias, to_alias, body, conversation_id, corr_id, status,
          error_code, terminal, op, context_ptr, ttl_s, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id,
        m.kind,
        m.fromAlias,
        m.toAlias,
        m.body,
        m.conversationId,
        m.corrId,
        m.status,
        m.errorCode,
        m.terminal ? 1 : 0,
        m.op,
        m.contextPtr ? JSON.stringify(m.contextPtr) : null,
        m.ttlS,
        m.ts,
      );
  }

  get(id: string): Message | null {
    const r = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MsgRow | null;
    return r ? toMessage(r) : null;
  }

  enqueue(msgId: string, alias: string): void {
    const ts = (this.db.query("SELECT ts FROM messages WHERE id = ?").get(msgId) as { ts: number } | null)?.ts ?? 0;
    this.db
      .query(`INSERT OR IGNORE INTO deliveries (msg_id, to_alias, via, state, ts) VALUES (?,?,NULL,'queued',?)`)
      .run(msgId, alias, ts);
  }

  pending(alias: string, opts?: { consume?: boolean }): Message[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.msg_id
         WHERE d.to_alias = ? AND d.state IN ('queued','delivered','surfaced')
         ORDER BY m.ts`,
      )
      .all(alias) as MsgRow[];
    if (opts?.consume) {
      this.db
        .query(`UPDATE deliveries SET state='consumed' WHERE to_alias = ? AND state IN ('queued','delivered','surfaced')`)
        .run(alias);
    }
    return rows.map(toMessage);
  }

  markDelivered(msgId: string, alias: string, via: Delivery["via"]): void {
    this.db
      .query(`UPDATE deliveries SET state='delivered', via=? WHERE msg_id=? AND to_alias=? AND state='queued'`)
      .run(via, msgId, alias);
  }

  markConsumed(msgId: string, alias: string): void {
    this.db.query(`UPDATE deliveries SET state='consumed' WHERE msg_id=? AND to_alias=?`).run(msgId, alias);
  }

  claimForDelivery(alias: string, via: Delivery["via"]): Message[] {
    // Claim and read in one atomic statement. SQLite serializes writers, so the
    // WHERE re-evaluates against committed state — if a second deliverer (the
    // broker and a degraded client racing during a restart window) runs the same
    // UPDATE, it sees the rows already flipped and returns none. A prior SELECT-
    // then-UPDATE could let both read the queued rows first and double-deliver.
    const claimed = this.db
      .query(`UPDATE deliveries SET state='delivered', via=? WHERE to_alias=? AND state='queued' RETURNING msg_id`)
      .all(via, alias) as { msg_id: string }[];
    if (claimed.length === 0) return [];
    // messages is append-only, so reading the bodies after the claim is race-free.
    const placeholders = claimed.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY ts`)
      .all(...claimed.map((r) => r.msg_id)) as MsgRow[];
    return rows.map(toMessage);
  }

  setConsent(msgId: string, alias: string, accepted: boolean): void {
    this.db
      .query(`UPDATE deliveries SET state=? WHERE msg_id=? AND to_alias=?`)
      .run(accepted ? "accepted" : "declined", msgId, alias);
  }

  deliveriesFor(msgId: string): Delivery[] {
    const rows = this.db.query("SELECT * FROM deliveries WHERE msg_id = ?").all(msgId) as DelRow[];
    return rows.map(toDelivery);
  }

  openAwaiting(originId: string, expiresAt: number | null): void {
    this.db
      .query(`INSERT OR REPLACE INTO awaiting (origin_id, expires_at, closed, closed_reason) VALUES (?,?,0,NULL)`)
      .run(originId, expiresAt);
  }

  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void {
    this.db.query(`UPDATE awaiting SET closed=1, closed_reason=? WHERE origin_id=? AND closed=0`).run(reason, originId);
  }

  isAwaitingOpen(originId: string): boolean {
    const r = this.db.query("SELECT closed FROM awaiting WHERE origin_id = ?").get(originId) as
      | { closed: number }
      | null;
    return r ? r.closed === 0 : false;
  }

  getAwaiting(originId: string): Awaiting | null {
    const r = this.db.query("SELECT * FROM awaiting WHERE origin_id = ?").get(originId) as AwaitRow | null;
    return r ? toAwaiting(r) : null;
  }

  awaitingPastTtl(now: number): Awaiting[] {
    const rows = this.db
      .query("SELECT * FROM awaiting WHERE closed=0 AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as AwaitRow[];
    return rows.map(toAwaiting);
  }

  originOf(corrId: string): Message | null {
    return this.get(corrId);
  }

  saveRegistry(entries: RegistryEntry[]): void {
    const tx = this.db.transaction((rows: RegistryEntry[]) => {
      this.db.run("DELETE FROM registry_snapshot");
      const stmt = this.db.query(
        `INSERT INTO registry_snapshot (alias, session_id, cwd, caps, pid, tty, last_seen, status, token)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const e of rows) {
        stmt.run(e.alias, e.sessionId, e.cwd, JSON.stringify(e.caps), e.pid, e.tty, e.lastSeen, e.status, e.token);
      }
    });
    tx(entries);
  }

  loadRegistry(): RegistryEntry[] {
    const rows = this.db.query("SELECT * FROM registry_snapshot").all() as RegRow[];
    return rows.map((r) => ({
      alias: r.alias,
      sessionId: r.session_id,
      cwd: r.cwd,
      caps: JSON.parse(r.caps) as string[],
      pid: r.pid,
      tty: r.tty,
      lastSeen: r.last_seen,
      status: r.status as RegistryEntry["status"],
      token: r.token ?? null,
    }));
  }

  history(q: { peer?: string; since?: number; conversationId?: string }): Message[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (q.peer !== undefined) {
      clauses.push("(from_alias = ? OR to_alias = ?)");
      params.push(q.peer, q.peer);
    }
    if (q.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(q.since);
    }
    if (q.conversationId !== undefined) {
      clauses.push("conversation_id = ?");
      params.push(q.conversationId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM messages ${where} ORDER BY ts`).all(...params) as MsgRow[];
    return rows.map(toMessage);
  }

  replayInflight(): { deliveries: Delivery[]; awaiting: Awaiting[] } {
    const deliveries = (
      this.db.query(`SELECT * FROM deliveries WHERE state IN ('queued','delivered','surfaced')`).all() as DelRow[]
    ).map(toDelivery);
    const awaiting = (this.db.query("SELECT * FROM awaiting WHERE closed=0").all() as AwaitRow[]).map(toAwaiting);
    return { deliveries, awaiting };
  }

  close(): void {
    this.db.close();
  }
}
