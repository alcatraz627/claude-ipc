/**
 * SQLite storage backend, the default durable substrate (Bun's built-in SQLite).
 * `messages` is append-only; `deliveries` and `awaiting` hold the mutable state,
 * which is what makes fan-out, idempotency, and reply-after-timeout well-defined.
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
  origin_id TEXT PRIMARY KEY, expires_at REAL, closed INTEGER, closed_reason TEXT,
  reply_by_s REAL, nudged_stage INTEGER DEFAULT 0, nudge_from REAL);
CREATE INDEX IF NOT EXISTS ix_await_open ON awaiting(closed, expires_at);

-- Project mail is addressed to a directory. The claim is exclusive (one PRIMARY KEY per
-- message, so the first INSERT wins and the rest bounce off); a pass is per member, so
-- one session stepping back never speaks for the others.
CREATE TABLE IF NOT EXISTS project_claims (
  msg_id TEXT PRIMARY KEY, alias TEXT NOT NULL, ts REAL);
CREATE TABLE IF NOT EXISTS project_passes (
  msg_id TEXT, alias TEXT, PRIMARY KEY (msg_id, alias));

CREATE TABLE IF NOT EXISTS registry_snapshot (
  alias TEXT PRIMARY KEY, session_id TEXT, cwd TEXT, caps TEXT,
  pid INTEGER, tty TEXT, last_seen REAL, status TEXT, token TEXT, succeeded_sid TEXT,
  service INTEGER);

-- P3b inbox-event cursor: one global monotonic counter + last seq per address.
CREATE TABLE IF NOT EXISTS seq_state (key TEXT PRIMARY KEY, value INTEGER);
CREATE TABLE IF NOT EXISTS address_seq (address TEXT PRIMARY KEY, seq INTEGER);

-- A later message can supersede an earlier one (D2): the successor triaging
-- inherited mail folds the countermanded arc. Advisory — display, not delivery.
CREATE TABLE IF NOT EXISTS supersessions (
  msg_id TEXT PRIMARY KEY, by_msg_id TEXT NOT NULL, ts REAL);
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
  reply_by_s: number | null;
  nudged_stage: number | null;
  nudge_from: number | null;
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
  succeeded_sid: string | null;
  service: number | null;
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
    replyByS: r.reply_by_s,
    nudgedStage: ((r.nudged_stage ?? 0) as Awaiting["nudgedStage"]) ?? 0,
    // Rows written before reply-nudges existed have no clock; fall back to their
    // deadline, or to zero, so an old row can never look like it is owed a nudge
    // "in the future".
    nudgeFrom: r.nudge_from ?? 0,
  };
}

export class SqliteBackend implements StorageBackend {
  private db: Database;
  private seqCounter: number;

  constructor(path = ":memory:", seqFloor = Math.floor(Date.now() / 1000)) {
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
    try {
      this.db.run("ALTER TABLE registry_snapshot ADD COLUMN succeeded_sid TEXT");
    } catch {
      // column already present on an existing DB — fine
    }
    try {
      // service tier must survive a restart — a reload that drops it would demote
      // every service to prunable, the exact bug the tier exists to kill
      this.db.run("ALTER TABLE registry_snapshot ADD COLUMN service INTEGER");
    } catch {
      // column already present on an existing DB — fine
    }
    for (const col of ["reply_by_s REAL", "nudged_stage INTEGER DEFAULT 0", "nudge_from REAL"]) {
      try {
        this.db.run(`ALTER TABLE awaiting ADD COLUMN ${col}`);
      } catch {
        // column already present on an existing DB — fine
      }
    }
    // Cursor never rewinds: resume from the persisted counter, floored to the
    // boot clock so a lost/older store still mints above every seq handed out.
    const persisted = (this.db.query(`SELECT value FROM seq_state WHERE key='counter'`).get() as { value: number } | null)
      ?.value;
    this.seqCounter = Math.max(persisted ?? 0, seqFloor);
  }

  private bumpSeq(addr: string): void {
    this.seqCounter++;
    this.db.query(`INSERT OR REPLACE INTO seq_state (key, value) VALUES ('counter', ?)`).run(this.seqCounter);
    this.db.query(`INSERT OR REPLACE INTO address_seq (address, seq) VALUES (?, ?)`).run(addr, this.seqCounter);
  }

  lastEventSeq(addresses: string[]): number {
    if (addresses.length === 0) return 0;
    const placeholders = addresses.map(() => "?").join(",");
    const r = this.db
      .query(`SELECT MAX(seq) AS s FROM address_seq WHERE address IN (${placeholders})`)
      .get(...addresses) as { s: number | null } | null;
    return r?.s ?? 0;
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
    const r = this.db
      .query(`INSERT OR IGNORE INTO deliveries (msg_id, to_alias, via, state, ts) VALUES (?,?,NULL,'queued',?)`)
      .run(msgId, alias, ts);
    if (r.changes > 0) this.bumpSeq(alias); // an idempotent re-enqueue is not an event
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
      const r = this.db
        .query(`UPDATE deliveries SET state='consumed' WHERE to_alias = ? AND state IN ('queued','delivered','surfaced')`)
        .run(alias);
      if (r.changes > 0) this.bumpSeq(alias);
    }
    return rows.map(toMessage);
  }

  markDelivered(msgId: string, alias: string, via: Delivery["via"]): void {
    this.db
      .query(`UPDATE deliveries SET state='delivered', via=? WHERE msg_id=? AND to_alias=? AND state='queued'`)
      .run(via, msgId, alias);
  }

  markConsumed(msgId: string, alias: string): void {
    // Only leaving the pending set is an event; consuming an already-settled row isn't.
    const r = this.db
      .query(
        `UPDATE deliveries SET state='consumed' WHERE msg_id=? AND to_alias=? AND state IN ('queued','delivered','surfaced')`,
      )
      .run(msgId, alias);
    if (r.changes > 0) this.bumpSeq(alias);
    else this.db.query(`UPDATE deliveries SET state='consumed' WHERE msg_id=? AND to_alias=?`).run(msgId, alias);
  }

  markSurfaced(msgId: string, alias: string): void {
    // Only a still-live delivery can be deferred — never resurrect a consumed,
    // accepted, or declined one back into the pending set.
    this.db
      .query(`UPDATE deliveries SET state='surfaced' WHERE msg_id=? AND to_alias=? AND state IN ('queued','delivered')`)
      .run(msgId, alias);
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
    // Fetch in batches so a large backlog can't exceed SQLite's bound-variable
    // limit; re-sort by ts since the batches arrive independently.
    const ids = claimed.map((r) => r.msg_id);
    const rows: MsgRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const batch = ids.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      rows.push(...(this.db.query(`SELECT * FROM messages WHERE id IN (${placeholders})`).all(...batch) as MsgRow[]));
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows.map(toMessage);
  }

  setConsent(msgId: string, alias: string, accepted: boolean): void {
    const state = accepted ? "accepted" : "declined";
    const r = this.db
      .query(`UPDATE deliveries SET state=? WHERE msg_id=? AND to_alias=? AND state IN ('queued','delivered','surfaced')`)
      .run(state, msgId, alias);
    if (r.changes > 0) this.bumpSeq(alias);
    else this.db.query(`UPDATE deliveries SET state=? WHERE msg_id=? AND to_alias=?`).run(state, msgId, alias);
  }

  deliveriesFor(msgId: string): Delivery[] {
    const rows = this.db.query("SELECT * FROM deliveries WHERE msg_id = ?").all(msgId) as DelRow[];
    return rows.map(toDelivery);
  }

  projectAddresses(): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT to_alias FROM deliveries
         WHERE to_alias LIKE 'proj:%' AND state IN ('queued','delivered','surfaced')`,
      )
      .all() as { to_alias: string }[];
    return rows.map((r) => r.to_alias);
  }

  pendingAddresses(): string[] {
    const rows = this.db
      .query(`SELECT DISTINCT to_alias FROM deliveries WHERE state IN ('queued','delivered','surfaced')`)
      .all() as { to_alias: string }[];
    return rows.map((r) => r.to_alias);
  }

  openAwaiting(originId: string, expiresAt: number | null, replyByS: number | null = null, nudgeFrom = 0): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO awaiting
         (origin_id, expires_at, closed, closed_reason, reply_by_s, nudged_stage, nudge_from)
         VALUES (?,?,0,NULL,?,0,?)`,
      )
      .run(originId, expiresAt, replyByS, nudgeFrom);
  }

  closeAwaiting(originId: string, reason: Awaiting["closedReason"]): void {
    this.db.query(`UPDATE awaiting SET closed=1, closed_reason=? WHERE origin_id=? AND closed=0`).run(reason, originId);
  }

  markNudged(originId: string, stage: 1 | 2): void {
    // Only ever move forward. A stage that already fired must not fire again, even
    // if the broker restarted between the emit and the write.
    this.db
      .query(`UPDATE awaiting SET nudged_stage=? WHERE origin_id=? AND nudged_stage < ?`)
      .run(stage, originId, stage);
  }

  deferNudge(originId: string, from: number): void {
    this.db.query(`UPDATE awaiting SET nudge_from=?, nudged_stage=0 WHERE origin_id=?`).run(from, originId);
  }

  claimProject(msgId: string, alias: string): boolean {
    // The PRIMARY KEY is the whole mechanism: two sessions racing to take the same piece
    // of project work both run this, and exactly one row lands. SQLite is synchronous
    // here, so there is no window between the check and the write.
    const r = this.db
      .query(`INSERT OR IGNORE INTO project_claims (msg_id, alias, ts) VALUES (?,?,?)`)
      .run(msgId, alias, Date.now() / 1000);
    return r.changes > 0;
  }

  releaseClaim(msgId: string): void {
    this.db.query(`DELETE FROM project_claims WHERE msg_id = ?`).run(msgId);
  }

  projectClaim(msgId: string): string | null {
    const r = this.db.query(`SELECT alias FROM project_claims WHERE msg_id = ?`).get(msgId) as
      | { alias: string }
      | undefined;
    return r?.alias ?? null;
  }

  passProject(msgId: string, alias: string): void {
    this.db.query(`INSERT OR IGNORE INTO project_passes (msg_id, alias) VALUES (?,?)`).run(msgId, alias);
  }

  projectStanding(msgId: string, alias: string): "claimed" | "passed" | null {
    if (this.projectClaim(msgId) === alias) return "claimed";
    const p = this.db.query(`SELECT 1 FROM project_passes WHERE msg_id=? AND alias=?`).get(msgId, alias);
    return p ? "passed" : null;
  }

  markSuperseded(supersededId: string, bySupersedingId: string): void {
    this.db
      .query(`INSERT OR REPLACE INTO supersessions (msg_id, by_msg_id, ts) VALUES (?,?,?)`)
      .run(supersededId, bySupersedingId, Date.now() / 1000);
  }

  supersededBy(msgId: string): string | null {
    const r = this.db.query(`SELECT by_msg_id FROM supersessions WHERE msg_id = ?`).get(msgId) as
      | { by_msg_id: string }
      | undefined;
    return r?.by_msg_id ?? null;
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

  openAwaitings(): Awaiting[] {
    const rows = this.db.query("SELECT * FROM awaiting WHERE closed=0").all() as AwaitRow[];
    return rows.map(toAwaiting);
  }

  originOf(corrId: string): Message | null {
    const m = this.get(corrId);
    // Only a query/request opens a correlation — you can't reply-correlate to a
    // response or an inform.
    return m && (m.kind === "query" || m.kind === "request") ? m : null;
  }

  saveRegistry(entries: RegistryEntry[]): void {
    const tx = this.db.transaction((rows: RegistryEntry[]) => {
      this.db.run("DELETE FROM registry_snapshot");
      const stmt = this.db.query(
        `INSERT INTO registry_snapshot (alias, session_id, cwd, caps, pid, tty, last_seen, status, token, succeeded_sid, service)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const e of rows) {
        stmt.run(
          e.alias,
          e.sessionId,
          e.cwd,
          JSON.stringify(e.caps),
          e.pid,
          e.tty,
          e.lastSeen,
          e.status,
          e.token,
          e.succeededSid ?? null,
          e.service ? 1 : null,
        );
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
      ...(r.succeeded_sid ? { succeededSid: r.succeeded_sid } : {}),
      ...(r.service ? { service: true } : {}),
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

  purge(olderThanTs: number): number {
    // A message is settled when nothing actionable remains: no delivery still in
    // an inbox (queued/delivered/surfaced) and no open awaiting on it.
    const ids = this.db
      .query(
        `SELECT id FROM messages m
         WHERE m.ts < ?
           AND NOT EXISTS (SELECT 1 FROM deliveries d
                           WHERE d.msg_id = m.id AND d.state IN ('queued','delivered','surfaced'))
           AND NOT EXISTS (SELECT 1 FROM awaiting a WHERE a.origin_id = m.id AND a.closed = 0)`,
      )
      .all(olderThanTs) as { id: string }[];
    if (ids.length === 0) return 0;
    const tx = this.db.transaction((rows: { id: string }[]) => {
      const delDel = this.db.query(`DELETE FROM deliveries WHERE msg_id = ?`);
      const delAwait = this.db.query(`DELETE FROM awaiting WHERE origin_id = ?`);
      const delMsg = this.db.query(`DELETE FROM messages WHERE id = ?`);
      for (const r of rows) {
        delDel.run(r.id);
        delAwait.run(r.id);
        delMsg.run(r.id);
      }
    });
    tx(ids);
    return ids.length;
  }

  close(): void {
    this.db.close();
  }
}
