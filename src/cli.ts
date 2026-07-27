#!/usr/bin/env bun
/**
 * The human's command-line client for claude-ipc.
 *
 * Lets you send, inspect, and approve messages and check the broker — all
 * independent of any Claude session. `run()` is the testable core (it takes the
 * args + an optional socket path); the file's tail wires it to the real process.
 */

import { readFileSync } from "node:fs";
import { readAliasForSession, writeAliasForSession } from "./aliasStore.ts";
import { BrokerError, Client } from "./client.ts";
import { config } from "./config.ts";
import { markOrphanShown, orphanAlreadyShown, TRUST_RAIL } from "./hooks/shared.ts";
import { humanAge } from "./models.ts";
import { monitorSnapshot } from "./monitor.ts";

/**
 * State the trust boundary when an agent reads its mail from the shell.
 *
 * An agent woken by the monitor lands HERE, not on the hooks' rendered block, so this is
 * the only place the boundary can hold for it. Written to stderr on purpose: stdout is a
 * JSON contract the watcher itself parses, and prose there would break the wake loop.
 */
export function railIfPeerMail(box: unknown): void {
  const msgs = (box as { messages?: { kind?: string }[] })?.messages ?? [];
  if (msgs.some((m) => m.kind === "query" || m.kind === "request")) console.error(`\n${TRUST_RAIL}`);
}

/** This session's own ipc alias. The explicit CLAUDE_IPC_ALIAS override wins
 *  (same precedence the hooks use), then the side-file the SessionStart hook
 *  writes (keyed by CLAUDE_CODE_SESSION_ID). Undefined if never registered.
 *  Lets `send`/`reply` infer --from so a session never has to name itself. */
function resolveSelfAlias(): string | undefined {
  return process.env.CLAUDE_IPC_ALIAS || readAliasForSession(process.env.CLAUDE_CODE_SESSION_ID);
}

type FlagValue = string | boolean;

/**
 * How long the sender is willing to wait: `5m`, `90s`, a bare number of seconds, or
 * `none` to opt out (the last message in a chain, where no answer is expected).
 *
 * `undefined` means they didn't say, and the broker applies its default — the flag is
 * resolved there, not here, so an ask sent over MCP or by a stale binary is chased too.
 */
function parseReplyBy(raw: FlagValue | undefined, optedOut: boolean): number | null | undefined | "bad" {
  if (optedOut) return null;
  if (raw === undefined || raw === true) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === "none" || s === "never" || s === "0") return null;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(s);
  if (!m) return "bad";
  const n = Number(m[1]);
  const mult = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  return n * mult;
}

/**
 * Say back what the sender just bought, so they know when they may stop waiting.
 *
 * The numbers come from the broker's own answer, never from a guess here — it is the
 * only party that knows what deadline it will actually honour.
 */
function replyByContract(msgId: string, to: string, replyByS: number | null, releaseAfterS: number | null): string {
  if (replyByS === null || releaseAfterS === null) {
    return `sent ${msgId} to ${to}. No reply expected — nobody will be chased for one.`;
  }
  const dur = (x: number): string => (x >= 60 && x % 60 === 0 ? `${x / 60}m` : `${x}s`);
  return (
    `sent ${msgId} to ${to}. They get nudged at ${dur(replyByS)}; at ${dur(releaseAfterS)} you'll be told nobody has ` +
    `answered and may proceed without one — the ask stays open, and a late reply still reaches you. ` +
    `Opt out on a final message: --no-reply-expected`
  );
}

/**
 * Turn a --project / --to-project value into an absolute directory.
 * `true` (bare flag) means "this directory". A name is matched against known
 * project mailboxes and registered peers' cwds by basename; ambiguity is an
 * error listing the candidates — never a guess.
 */
async function resolveProjectDir(raw: FlagValue, client: Client): Promise<string | null> {
  if (raw === true) return process.cwd();
  const s = String(raw).trim();
  if (s === "." || s === "") return process.cwd();
  if (s.startsWith("/")) return s.replace(/\/+$/, "") || "/";
  const candidates = new Set<string>();
  try {
    const boxes = (await client.projects()).projects as { path: string }[];
    for (const b of boxes) if (b.path.split("/").pop() === s) candidates.add(b.path);
  } catch {
    // broker down — registry lookup below will also fail; fall through to the error
  }
  try {
    const peers = (await client.list()).peers as { cwd: string }[];
    for (const p of peers) if (p.cwd && p.cwd.split("/").pop() === s) candidates.add(p.cwd.replace(/\/+$/, ""));
  } catch {
    // same — an unreachable broker ends in the "unknown project" error
  }
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size === 0) {
    console.error(`unknown project "${s}" — use an absolute path, or see: claude-ipc projects`);
    return null;
  }
  console.error(`"${s}" is ambiguous:\n  ${[...candidates].join("\n  ")}\nuse the full path.`);
  return null;
}

/**
 * Read a message body from a file (or stdin via `-`) instead of the command line.
 *
 * A body typed as a shell argument loses backticks and `$(…)` — the shell eats them
 * before the CLI sees them, and agent-to-agent messages carry code. Reading raw bytes
 * keeps them intact. undefined = no flag; "bad" = unreadable.
 */
function bodyFromFile(raw: FlagValue | undefined): string | undefined | "bad" {
  if (raw === undefined || raw === true) return undefined;
  const p = String(raw);
  try {
    return readFileSync(p === "-" ? 0 : p, "utf8");
  } catch {
    return "bad";
  }
}

/** ", oldest 3h ago" for a predecessor-mail age hint, or "" when unknown. */
function ageHint(oldestTs: number | null): string {
  return oldestTs ? `, oldest ${humanAge(oldestTs, Math.floor(Date.now() / 1000))} ago` : "";
}

/**
 * "last seen 3h ago" vs "left explicitly" for an offline roster row. An alias
 * that ran `leave` is backdated to lastSeen=0, so a raw age would read "56 years
 * ago" and undercut the honest-status note it appears in — distinguish a
 * deliberate departure from a decayed-quiet one.
 */
function offlineSince(lastSeen: number): string {
  return lastSeen === 0 ? "they left the roster explicitly" : `last seen ${humanAge(lastSeen, Math.floor(Date.now() / 1000))} ago`;
}

/** Parse a duration like "30m", "2h", "1d" (or bare seconds) to seconds; null if malformed. */
function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([smhd]?)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[m[2] ?? ""]!;
}

// Presence-only flags: never consume the following token as a value, so they can
// sit anywhere on the line (e.g. `reply <id> --from x --partial <body...>`).
const BOOLEAN_FLAGS = new Set(["partial", "consume", "no-reply-expected", "operator", "all", "service", "cursor"]);

function parse(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, FlagValue> } {
  const cmd = argv[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  return { cmd, positional, flags };
}

const USAGE = `claude-ipc — cross-session messaging

  register <alias> [--service]  (claim a mailbox; --service = a non-session identity —
                              a server/cron/bot that never heartbeats and is never auto-pruned)
  send   --to <b> | --to-project <dir|name> [--from <a>] [--kind inform|query|request] [--ttl N]
         [--reply-by 5m|90s|none] [--no-reply-expected] <body...> | --body-file <path>
                             (--body-file: read the body from a file, byte-exact — use it when the
                              body has backticks, quotes, or $() the shell would eat.)
                             (--reply-by: how long you'll wait before the ask is chased for you.
                              They get nudged at that mark; 10m later you're told nobody answered and
                              may act without one — the ask stays open and a late reply still reaches
                              you. Default 5m. Sending the LAST message in a chain? --no-reply-expected)
                             (--from auto-inferred from THIS session's alias; --kind defaults to inform;
                              project mail waits for ANY session working in that directory tree)
  reply  <corr-id> [--from <alias>] [--status error] [--partial] <body...>
                             (--from auto-inferred; --partial = interim ack/update, omit for the final reply)
  inbox  <alias> [--consume] | --project [dir]   (project peek is open; consume needs membership)
  peers  [--by-session]      (roster; --by-session = one row per session, aliases inline)
  projects                   (project mailboxes with pending mail)
  orphans [--project [dir]] [--triage]  (dead sessions' waiting mail; --triage folds superseded/stale arcs)
  supersede <old-id> --by <new-id> [--from <a>]  (your later message replaces an earlier one — successors fold it)
  who    <query> [--json]    (resolve a half-remembered name → ranked, successor-aware matches)
  count  <alias> [--cursor]  (pending count — cheap, for tab-title segments. Session-scoped;
                              can DECREASE (TTL sweep, sibling consume); FAILS on an
                              unregistered alias rather than reading as an empty box.
                              --cursor appends seq=<n>: a monotonic inbox-event cursor that
                              moves on ANY inbox change and survives broker restarts, so a
                              net-zero window — one message in, one consumed — is visible)
  log    [--peer <a>] [--since <epoch>]
  status <msg-id>            (a message's delivery + response lifecycle)
  sent   <msg-id> [--json]   (delivery state of a message YOU sent, per recipient — did they see it?)
  show   <msg-id> [--json]   (one message, readable — headers, body, replies; --json for pipelines)
  owed   [--as <alias>]      (every ask you still owe an answer, across ALL your aliases + this project)
  feedback <text...>         (file a report to the claude-ipc maintainers — works even when none are running)
  accept <msg-id> --as <alias>
  decline <msg-id> --as <alias> [--reason <r>]
  snooze <msg-id> --as <alias>  (defer without consuming — stays pending + owed)
  cancel <msg-id>               (abandon an outstanding query/request YOU sent)
  compose                    (interactive: pick a live peer + notes, then send)
  -i | interactive           (full-screen dashboard: live roster, inbox, copy menu)
  tail                       (live monitor, full-screen redraw — for a human)
  prune  [--offline-for <30m|2h|1d>]   (drop peers offline past the window; default 1d)
  daemon status|start|stop`;

// The flags each command actually reads. Validated PER COMMAND, not globally: a flag
// that is real for a different verb (`register --ttl`, `send --reason`) is still a
// silent no-op here, and the old flat allowlist waved it through. `body` appears on
// send/reply so the "body is positional" hint fires instead of a generic rejection.
// A command absent from this map (help, serve) skips the check.
export const COMMAND_FLAGS: Record<string, string[]> = {
  register: ["as", "tty", "service"],
  send: ["to", "to-project", "from", "kind", "ttl", "reply-by", "no-reply-expected", "body", "body-file"],
  reply: ["from", "corr", "status", "partial", "body", "body-file"],
  inbox: ["alias", "consume", "project"],
  count: ["alias", "project", "cursor"],
  orphans: ["project", "triage"],
  supersede: ["by", "from"],
  prune: ["offline-for"],
  log: ["peer", "since", "operator", "all"],
  status: ["operator", "all"],
  show: ["operator", "all", "json"],
  sent: ["json"],
  owed: ["as"],
  feedback: ["from", "body-file"],
  tail: ["once", "operator", "all"],
  accept: ["as"],
  decline: ["as", "reason"],
  snooze: ["as"],
  cancel: ["corr"],
  compose: ["from"],
  peers: ["by-session"],
  who: ["json"],
  projects: [],
  "-i": [],
  interactive: [],
};

/**
 * Rank registered aliases against a half-remembered name — the shared core of
 * `who <query>` and the no_peer near-match suggestions. Tiers: exact > prefix >
 * substring > one-typo (withinOneEdit) > cwd-basename; a live/idle bonus breaks
 * ties toward sessions that can actually answer. Pure; returns [] on no signal
 * rather than inventing a match.
 */
export function rankAliasMatches(
  query: string,
  peers: { alias: string; sessionId: string; status: string; lastSeen: number | null; cwd: string; succeededSid?: string }[],
  limit = 3,
): { alias: string; sessionId: string; status: string; lastSeen: number | null; cwd: string; succeededSid?: string; score: number }[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored = peers.flatMap((p) => {
    const a = p.alias.toLowerCase();
    let score = 0;
    if (a === q) score = 100;
    else if (a.startsWith(q) || q.startsWith(a)) score = 80;
    else if (a.includes(q) || q.includes(a)) score = 60;
    else if (withinOneEdit(a, q)) score = 45;
    else {
      const base = (p.cwd?.split("/").pop() ?? "").toLowerCase();
      if (base && (base.includes(q) || q.includes(base))) score = 30;
    }
    if (score === 0) return [];
    if (p.status === "live") score += 8;
    else if (p.status === "idle") score += 4;
    // a live near-miss beats a dead close-miss (picking a dead session was the
    // motivating incident) — but an EXACT match is the answer even when dead:
    // it surfaces first and carries its successor line
    else if (score < 100) score -= 15;
    return [{ ...p, score }];
  });
  scored.sort((x, y) => y.score - x.score || (y.lastSeen ?? 0) - (x.lastSeen ?? 0) || x.alias.localeCompare(y.alias));
  return scored.slice(0, limit);
}

// True when two names are a single typo apart: one substitution, insertion,
// deletion, or adjacent transposition ("opsu" for "opus"). Bounded on purpose —
// distance 2+ names don't get confused in practice.
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  if (s.length === l.length) {
    const diffs: number[] = [];
    for (let i = 0; i < s.length; i++) if (s[i] !== l[i]) diffs.push(i);
    if (diffs.length === 1) return true;
    if (diffs.length === 2) {
      const [i, j] = diffs as [number, number];
      return j === i + 1 && s[i] === l[j] && s[j] === l[i];
    }
    return false;
  }
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

export async function run(argv: string[], opts: { socketPath?: string } = {}): Promise<number> {
  const { cmd, positional, flags } = parse(argv);
  const client = new Client(opts.socketPath ?? config.socketPath);
  // Small output goes through console.log (test-capturable, human-normal). A
  // large payload must use the process.stdout stream instead: Bun's console
  // channel has no flush handle, and a piped payload past one 64KB buffer
  // loses its tail at exit — nondeterministically (log/peers, live 07-16,
  // three times). The entry tail awaits stdoutDrain before letting go.
  const out = (v: unknown): void => {
    const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    if (s.length > 32_768) {
      stdoutDrain = new Promise((resolve) => process.stdout.write(s + "\n", () => resolve()));
    } else console.log(s);
  };

  const allowedFlags = COMMAND_FLAGS[cmd];
  if (allowedFlags) {
    const unknown = Object.keys(flags).filter((f) => !allowedFlags.includes(f));
    if (unknown.length) {
      const plural = unknown.length > 1 ? "s" : "";
      // `body` sits in the allowlist only so the "positional" redirect can fire
      // (see COMMAND_FLAGS note) — advertising it here as a real flag taught
      // agents to type --body and get rejected. Describe the documented
      // interface instead.
      const shown = allowedFlags.filter((f) => f !== "body");
      const hint = shown.length < allowedFlags.length ? "; the message body itself is positional (after the flags)" : "";
      console.error(
        `unknown flag${plural} for ${cmd}: ${unknown.map((f) => `--${f}`).join(", ")} — ${cmd} takes ${shown.length ? shown.map((f) => `--${f}`).join(", ") : "no flags"}${hint}. See: claude-ipc help`,
      );
      return 2;
    }
  }

  try {
    switch (cmd) {
      case "register": {
        const alias = positional[0] ?? String(flags.as ?? "");
        if (!alias) {
          console.error("register <alias> [--tty /dev/ttysNNN]");
          return 2;
        }
        // register rebinds THE CURRENT session's alias — it is not a standalone
        // mailbox claim. The harness exports CLAUDE_CODE_SESSION_ID to Bash; that
        // is the session we rewrite. Without it we can't know which session to
        // rebind, and minting a synthetic cli-<alias> row (the old behavior) would
        // create a third mailbox the hooks never poll — the exact orphan-queue bug
        // this whole change removes. Refuse rather than orphan.
        // --service (E2): a non-session identity — a web server, cron, bot. It has
        // no CLAUDE_CODE_SESSION_ID by nature; a synthetic svc: sid marks the tier,
        // pruneOffline exempts it, and its mailbox is DELIBERATELY standalone (its
        // consumer is the service process itself, never the session hooks).
        const service = flags.service === true;
        const sid = service ? `svc:${alias}` : process.env.CLAUDE_CODE_SESSION_ID;
        if (!sid) {
          console.error(
            "register must run inside a Claude Code session (CLAUDE_CODE_SESSION_ID is unset).\n" +
              "It rebinds the current session's ipc alias; run it from that session's shell,\n" +
              "or set CLAUDE_IPC_ALIAS in that session's environment instead.\n" +
              "Registering a non-session sender (server/cron/bot)? Use: register <name> --service",
          );
          return 2;
        }
        // Bind the alias to the real session, then record the side-file so the
        // per-turn hooks resolve to it immediately. (Mail already queued to the
        // session's previous alias is not chased — see the register-rebind note in
        // docs; a boundary rename converges it.)
        const res = (await client.register(alias, {
          sessionId: sid,
          cwd: process.cwd(),
          pid: service ? undefined : process.ppid,
          tty: flags.tty ? String(flags.tty) : undefined,
          service,
        })) as { replaced?: boolean };
        if (!service) writeAliasForSession(sid, alias); // the side-file is session plumbing; services have none
        // Print a confirmation, NOT the raw capability token that register returns — it is
        // a secret (whoever holds it can act as this alias), and dumping it to stdout puts
        // it in scrollback and any log that captures the command. It is already saved,
        // owner-only, to the token file; the CLI never needs to echo it.
        out(`registered as "${alias}"${res.replaced ? " (rebound from a prior name)" : ""} — peers can now reach you as ${alias}.`);
        // Concern-6 belt: a name one edit from the CLI's own name or from another
        // session's alias is the clade-ipc incident at birth — mail typed for one
        // lands with the other. The register stands (warn, never block); the
        // warning names the near-miss so the typo is caught now, not an hour in.
        try {
          const CLI_NAME = "claude-ipc";
          const near: string[] = [];
          if (alias === CLI_NAME) near.push(`it IS the CLI's own name — peers type "${CLI_NAME}" meaning the tool, not you`);
          else if (withinOneEdit(alias, CLI_NAME)) near.push(`it is one edit away from "${CLI_NAME}" (the CLI's own name)`);
          const roster = ((await client.list()).peers ?? []) as { alias: string; sessionId: string }[];
          for (const p of roster) {
            if (p.sessionId === sid) continue;
            if (withinOneEdit(alias, p.alias)) near.push(`it is one edit away from "${p.alias}" (another session's alias)`);
          }
          if (near.length) {
            console.error(
              `warning about "${alias}": ${near.join("; also ")}. Mail addressed to either name may reach the wrong box. If unintended, rebind: claude-ipc register <other-name>`,
            );
          }
        } catch {
          // advisory; the registration above already succeeded
        }
        // The moment a lane takes a name is the moment its predecessor's mail
        // matters: owner directives stranded in a dead alias's box were only ever
        // found when a peer said "go peek" by hand. Name the dead boxes still
        // holding mail here, with the commands ready to run. Best-effort — a
        // down broker must not fail the register.
        try {
          const list = ((await client.orphans(process.cwd())).orphans ?? []) as {
            alias: string;
            pending: number;
            chases?: number;
            oldestTs: number | null;
          }[];
          const preds = list.filter((o) => o.alias !== alias && o.pending > 0);
          // Show the predecessor digest ONCE per session: re-registering (a second
          // name, a rebind) used to reprint the whole block every call. Share the
          // marker the boot digest uses, so a session is told once whichever surface
          // gets there first.
          if (preds.length && !orphanAlreadyShown(sid)) {
            markOrphanShown(sid);
            const shown = preds.slice(0, 5);
            const tail =
              preds.length > shown.length ? [`  … +${preds.length - shown.length} more (claude-ipc orphans --project)`] : [];
            out(
              [
                `predecessor mail in this project — dead sessions still hold unread messages (age is a staleness hint — old mail may have been superseded by a later correction):`,
                ...shown.map((o) => {
                  // Chase notices are broker bookkeeping — a successor triaging a dead
                  // box needs the real-mail count, not noise dressed as obligations.
                  const chases = o.chases ?? 0;
                  const real = o.pending - chases;
                  const held =
                    chases > 0
                      ? real > 0
                        ? `holds ${real} (+${chases} chase notice${chases > 1 ? "s" : ""})`
                        : `holds only ${chases} stale chase notice${chases > 1 ? "s" : ""}`
                      : `holds ${o.pending}`;
                  return `  ${o.alias} ${held}${ageHint(o.oldestTs)} — peek: claude-ipc inbox ${o.alias} · claim: claude-ipc inbox ${o.alias} --consume`;
                }),
                ...tail,
              ].join("\n"),
            );
          }
        } catch {
          // orphan discovery is advisory; the registration above already succeeded
        }
        return 0;
      }
      case "send": {
        let to = String(flags.to ?? "");
        if (flags["to-project"]) {
          const dir = await resolveProjectDir(flags["to-project"], client);
          if (typeof dir !== "string") return 2; // resolveProjectDir already explained
          to = `proj:${dir}`;
        }
        if (!to) {
          console.error(
            "send needs a recipient. Add --to <alias> or --to-project <dir>. See who's reachable: claude-ipc peers",
          );
          return 2;
        }
        // --from is the current session by default: a session shouldn't have to
        // name itself. Resolve it from this session's registered alias; only ask
        // for --from when we genuinely can't tell who this is.
        const from = flags.from ? String(flags.from) : resolveSelfAlias();
        if (!from) {
          console.error(
            `couldn't tell who's sending — this session has no registered ipc alias.\n` +
              `  Fix:  claude-ipc register <your-name>    (then re-run your send)\n` +
              `  Or:   claude-ipc send --from <your-name> --to ${to} "<message>"`,
          );
          return 2;
        }
        const kind = String(flags.kind ?? "inform") as "inform" | "query" | "request";
        // Parse the ttl with the same suffix-aware parser as --reply-by. Number("5m") is
        // NaN, which slipped through as a NaN deadline that never fired — a silent no-op
        // dressed as a working flag. "bad" is a real error, not a silent drop.
        const ttlSeconds = flags.ttl === undefined ? undefined : (parseDuration(String(flags.ttl)) ?? "bad");
        if (ttlSeconds === "bad") {
          console.error(`--ttl wants a duration like 60, 90s, 5m, or 1h. Got: ${String(flags.ttl)}`);
          return 2;
        }
        const replyBy = parseReplyBy(flags["reply-by"], flags["no-reply-expected"] === true);
        if (replyBy === "bad") {
          console.error(`--reply-by wants a duration like 5m / 90s, or "none". Got: ${String(flags["reply-by"])}`);
          return 2;
        }
        const fileBody = bodyFromFile(flags["body-file"]);
        if (fileBody === "bad") {
          console.error(`--body-file: can't read ${String(flags["body-file"])}`);
          return 2;
        }
        // The body is positional; a --body flag is a natural guess that silently
        // sent EMPTY messages (found live: a whole agent lane talking in zero
        // bytes). Same guard reply has had since the --partial incident.
        const sendBody = fileBody ?? positional.join(" ");
        if (!sendBody.trim()) {
          console.error(
            (flags.body
              ? `the message body is positional, not a flag — put it after the flags:\n` +
                  `  claude-ipc send --to ${to} --from ${from} "${String(flags.body)}"`
              : `send needs a body — NOTHING WAS SENT:\n  claude-ipc send --to ${to} --from ${from} "<message>"`) +
              `\n  (a body with backticks, quotes, or $() goes byte-exact via: --body-file <path>)`,
          );
          return 2;
        }
        let res: unknown;
        try {
          res = await client.send({
            from,
            to,
            kind,
            body: sendBody,
            ttlS: ttlSeconds, // already number | undefined; "bad" returned above
            replyByS: replyBy,
          });
        } catch (e) {
          // The broker accepts a send to any known alias (even offline — the mail
          // waits for it), and refuses only a name nobody ever registered. Turn that
          // bare no_peer into a discovery answer: name who's reachable now and who's
          // known-but-offline, so a typo'd or half-remembered recipient is easy to fix.
          if (e instanceof BrokerError && e.code === "no_peer") {
            const all = ((await client.list()).peers ?? []) as {
              alias: string;
              sessionId: string;
              status: string;
              cwd: string;
              lastSeen: number | null;
              succeededSid?: string;
            }[];
            const live = all.filter((p) => p.status !== "offline").map((p) => p.alias);
            const offline = all.filter((p) => p.status === "offline").map((p) => p.alias);
            const lines = [`no peer named "${to}" is registered — NOTHING WAS SENT.`];
            // the near-misses first: a typo'd or half-remembered name usually has one
            const near = rankAliasMatches(to ?? "", all, 3);
            if (near.length) {
              const nowS = Math.floor(Date.now() / 1000);
              lines.push(
                `  closest:  ${near
                  .map((m) => `${m.alias} (${m.status}${m.lastSeen ? `, ${humanAge(m.lastSeen, nowS)}` : ""})`)
                  .join(" · ")}`,
              );
            }
            if (live.length) lines.push(`  reachable now:  ${live.join(", ")}`);
            if (offline.length) {
              const shown = offline.slice(0, 8).join(", ");
              lines.push(`  known but offline (mail still reaches them):  ${shown}${offline.length > 8 ? ", …" : ""}`);
            }
            if (!live.length && !offline.length) lines.push(`  no peers are registered yet.`);
            lines.push(`  addressing a role or repo lane?  --to-project <dir> reaches whoever registers there.`);
            lines.push(`  resolve a name:  claude-ipc who ${to ?? "<query>"}   ·   full roster:  claude-ipc peers`);
            console.error(lines.join("\n"));
            return 2;
          }
          if (e instanceof BrokerError && e.code === "not_registered") {
            // the usual cause is prune eating the SENDER's alias while the session
            // idled — say so, with the one-command fix (papercuts P2/P4)
            console.error(
              `${e.message}\n  your alias may have been pruned while this session idled — re-register: claude-ipc register ${from}`,
            );
            return 2;
          }
          throw e; // any other refusal → the shared catch prints `error: code: …` and exits 1
        }
        out(res);
        // An ask now carries a deadline, so say what it bought. A sender that knows
        // when it will be released can plan around silence instead of guessing at it.
        const sent = res as {
          msgId?: string;
          replyByS?: number | null;
          releaseAfterS?: number | null;
          recipient?: { status: string; lastSeen: number };
        };
        if (sent.msgId && (kind === "query" || kind === "request")) {
          console.error(replyByContract(sent.msgId, to, sent.replyByS ?? null, sent.releaseAfterS ?? null));
        }
        // send-success means the broker took it, not that they saw it. Point at the
        // delivery view so the sender can check rather than hand-annotate "sent not
        // received" (D1). stderr so it doesn't pollute a JSON-parsed stdout.
        if (sent.msgId) console.error(`track delivery: claude-ipc sent ${sent.msgId}`);
        // Delivered ≠ heard: a send to a dark alias succeeds by design (mail
        // waits), so say what the roster shows rather than letting the sender
        // proceed blind — the two vb lanes lost hold-requests exactly this way.
        if (sent.recipient?.status === "offline") {
          console.error(
            `note: ${to}'s roster status is offline (${offlineSince(sent.recipient.lastSeen)}). ` +
              `Mail waits for them; successors in their cwd are told at register. This describes the roster, not whether their process is alive.`,
          );
        }
        return 0;
      }
      case "reply": {
        const corrId = positional[0] ?? String(flags.corr ?? "");
        const from = flags.from ? String(flags.from) : resolveSelfAlias();
        if (!corrId || !from) {
          console.error(
            `reply needs a message id and a sender.\n` +
              `  Usage: claude-ipc reply <corr-id> [--from <alias>] "<body>"\n` +
              (!corrId ? `  (missing the <corr-id> — it's the msg-… id you're answering)\n` : "") +
              (!from ? `  (couldn't infer --from: register this session, or pass --from <alias>)` : ""),
          );
          return 2;
        }
        const replyFileBody = bodyFromFile(flags["body-file"]);
        if (replyFileBody === "bad") {
          console.error(`--body-file: can't read ${String(flags["body-file"])}`);
          return 2;
        }
        const replyBody = replyFileBody ?? positional.slice(1).join(" ");
        // The body is positional; a --body flag is a natural guess that silently drops
        // the answer. Catch it here, before the send, with the fix spelled out.
        if (!replyBody.trim() && flags.status !== "error") {
          console.error(
            flags.body
              ? `the reply body is positional, not a flag — put it after --from:\n` +
                  `  claude-ipc reply ${corrId} --from ${from} "${String(flags.body)}"`
              : `reply needs a body:\n  claude-ipc reply ${corrId} --from ${from} "<your answer>"`,
          );
          return 2;
        }
        const replied = (await client.reply({
          from,
          corrId,
          body: replyBody,
          status: flags.status === "error" ? "error" : "ok",
          terminal: !flags.partial, // --partial → interim ack/update; default is the final reply
        })) as { asker?: { status: string; lastSeen: number } };
        out(replied);
        if (replied.asker?.status === "offline") {
          console.error(
            `note: the asker's roster status is offline (${offlineSince(replied.asker.lastSeen)}). ` +
              `Your answer waits in their mailbox; successors in their cwd are told at register.`,
          );
        }
        return 0;
      }
      case "inbox": {
        const consume = flags.consume === true || flags.consume === "true";
        // A query's corrId is null by design (corrId belongs to the response), so
        // nothing in the raw JSON says `reply` keys on the MESSAGE id — agents
        // answered with a fresh send and left the contract dangling (boot survey,
        // live-proven). Stamp the exact command on every row expecting an answer.
        const withReplyHints = <T extends { messages?: { id: string; kind: string; replyWith?: string }[] }>(
          box: T,
          readerAlias: string | null | undefined,
        ): T => {
          for (const m of box.messages ?? []) {
            if (m.kind === "query" || m.kind === "request") {
              m.replyWith = `claude-ipc reply ${m.id}${readerAlias ? ` --from ${readerAlias}` : ""}`;
            }
          }
          return box;
        };
        if (flags.project) {
          const dir = await resolveProjectDir(flags.project, client);
          if (typeof dir !== "string") return 2;
          const self = resolveSelfAlias();
          const box = await client.checkProject(dir, consume, self);
          out(withReplyHints(box, self));
          railIfPeerMail(box);
          return 0;
        }
        const alias = positional[0] ?? String(flags.alias ?? "");
        if (!alias) {
          // No alias named: sweep EVERY alias this session holds. Per-alias reads
          // hid sibling-alias mail (13 msgs sat unread while the holder polled
          // another name) — bare `inbox` makes "my inbox" mean the whole session.
          const self = resolveSelfAlias();
          if (!self) {
            console.error("inbox needs an alias or --project [dir] — or register this session so bare inbox can find its aliases");
            return 2;
          }
          const roster = ((await client.list()).peers ?? []) as { alias: string; sessionAliases?: string[] }[];
          const mine = roster.find((p) => p.alias === self)?.sessionAliases ?? [self];
          // Dedupe by id: a broadcast lands in EVERY sibling box, and double-counting
          // it was a live incident class (wake counted one message twice, 2026-07-15).
          const merged = new Map<string, { id: string; kind: string; replyWith?: string }>();
          for (const a of mine) {
            try {
              const box = (await client.check(a, consume)) as { messages?: { id: string; kind: string; replyWith?: string }[] };
              for (const m of withReplyHints({ messages: box.messages ?? [] }, a).messages ?? []) {
                if (!merged.has(m.id)) merged.set(m.id, m);
              }
            } catch {
              // an unreadable sibling box is skipped, not fatal — `owed` names it
            }
          }
          const all = { messages: [...merged.values()] };
          out(all);
          railIfPeerMail(all);
          return 0;
        }
        const box = await client.check(alias, consume);
        out(withReplyHints(box, alias));
        railIfPeerMail(box);
        return 0;
      }
      case "who": {
        // "Find the alias the user means" without the roster firehose: one round
        // trip from a fuzzy name to an addressable answer (papercuts P1).
        const query = positional[0] ?? "";
        if (!query) {
          console.error("who <query>   (fuzzy over alias + cwd; try: who fable)");
          return 2;
        }
        const roster = ((await client.list()).peers ?? []) as {
          alias: string;
          sessionId: string;
          status: string;
          cwd: string;
          lastSeen: number | null;
          sinceSeenS?: number;
          succeededSid?: string;
        }[];
        const ranked = rankAliasMatches(query, roster, 8);
        // one row per SESSION (best-scoring alias speaks for its siblings)
        const seenSids = new Set<string>();
        const rows = ranked.filter((m) => !seenSids.has(m.sessionId) && seenSids.add(m.sessionId) !== undefined);
        if (flags.json === true) {
          out({ query, matches: rows });
          return 0;
        }
        if (!rows.length) {
          console.error(`nothing matches "${query}" — full roster: claude-ipc peers · lane addressing: send --to-project <dir>`);
          return 2;
        }
        for (const m of rows) {
          const age = m.lastSeen ? humanAge(m.lastSeen, Math.floor(Date.now() / 1000)) : "?";
          // a dead match with a successor is an answer, not a dead end
          const heir = m.status === "offline" ? roster.find((p) => p.succeededSid === m.sessionId) : undefined;
          const succ = heir ? `  → succeeded by ${heir.alias} (${heir.status})` : "";
          out(`${m.alias}  ${m.status} · seen ${age} ago · ${m.cwd || "?"}${succ}`);
        }
        return 0;
      }
      case "peers": {
        const roster = ((await client.list()).peers ?? []) as {
          alias: string;
          sessionId: string;
          sessionAliases?: string[];
          status: string;
          cwd: string;
          lastSeen: number | null;
          sinceSeenS?: number;
          succeededSid?: string;
        }[];
        // --by-session: one row per session with aliases inline. The default is
        // one row per ALIAS, so a 3-alias session reads as three near-identical
        // rows — the per-alias/per-session split, on the roster display. Kept as
        // a flag, not the default, so JSON consumers of the flat list don't break.
        if (flags["by-session"] === true) {
          const bySid = new Map<string, (typeof roster)[number]>();
          for (const e of roster) if (!bySid.has(e.sessionId)) bySid.set(e.sessionId, e);
          out({
            peers: [...bySid.values()].map((e) => ({
              sessionId: e.sessionId,
              aliases: (e.sessionAliases ?? [e.alias]).slice().sort(),
              status: e.status,
              // Liveness is heartbeat recency, never a process check (D3): hand back
              // the age so "live" reads as an inference the caller can weigh.
              sinceSeenS: e.sinceSeenS,
              livenessBasis: "heartbeat",
              // Marked when this session took a name over from a now-dead one — "one
              // lane, a successor" instead of a same-name-two-liveness-states puzzle.
              ...(() => {
                const took = roster.find((r) => r.sessionId === e.sessionId && r.succeededSid)?.succeededSid;
                return took ? { succeededSid: took } : {};
              })(),
              cwd: e.cwd,
              lastSeen: e.lastSeen,
            })),
          });
          return 0;
        }
        out({ peers: roster });
        return 0;
      }
      case "count": {
        const withCursor = flags.cursor === true;
        // "N seq=M", or the bare count without --cursor. A broker that predates the
        // cursor returns no seq — fail rather than print a fabricated seq=0 a
        // watcher would trust forever (none-not-fabricate).
        const render = (r: { count: number; seq?: number }): number => {
          if (!withCursor) {
            out(String(r.count));
            return 0;
          }
          if (r.seq === undefined) {
            console.error("this broker predates --cursor (no seq in its count response) — redeploy the broker, or poll without --cursor");
            return 1;
          }
          out(`${r.count} seq=${r.seq}`);
          return 0;
        };
        if (flags.project) {
          const dir = await resolveProjectDir(flags.project, client);
          if (typeof dir !== "string") return 2;
          return render((await client.countProject(dir)) as { count: number; seq?: number });
        }
        const alias = positional[0] ?? String(flags.alias ?? "");
        if (!alias) {
          console.error("count <alias> [--cursor] (or count --project [dir])");
          return 2;
        }
        return render((await client.count(alias)) as { count: number; seq?: number });
      }
      case "projects": {
        out(await client.projects());
        return 0;
      }
      case "orphans": {
        let dir: string | null = null;
        if (flags.project) {
          dir = await resolveProjectDir(flags.project, client);
          if (dir === null) return 2;
        }
        out(await client.orphans(dir ?? undefined, flags.triage === true));
        return 0;
      }
      case "supersede": {
        // "This later message replaces that earlier one." Advisory — a successor
        // triaging inherited mail folds the countermanded arc, but the old message
        // stays in its box and a late reply still lands (D2, folds-never-drops).
        const old = positional[0] ?? "";
        const by = String(flags.by ?? "");
        const from = flags.from ? String(flags.from) : resolveSelfAlias();
        if (!old || !by) {
          console.error(
            "supersede <old-msg-id> --by <new-msg-id> [--from <alias>]\n" +
              "  records that your later message (--by) replaces an earlier one, so successors fold it.",
          );
          return 2;
        }
        if (!from) {
          console.error("supersede can't tell who you are — register this session, or pass --from <alias>");
          return 2;
        }
        try {
          await client.supersede(old, by, from);
          out(`recorded: ${by} supersedes ${old}. Successors triaging inherited mail will fold ${old}.`);
          return 0;
        } catch (e) {
          if (e instanceof BrokerError) {
            console.error(`supersede refused: ${e.message}`);
            return 2;
          }
          throw e;
        }
      }
      case "prune": {
        const window = parseDuration(String(flags["offline-for"] ?? "1d"));
        if (window === null) {
          console.error("prune: --offline-for must look like 30m, 2h, or 1d");
          return 2;
        }
        out(`pruned ${(await client.prune(window)).pruned} offline peer(s)`);
        return 0;
      }
      case "log": {
        const q: { peer?: string; since?: number } = {};
        if (flags.peer) q.peer = String(flags.peer);
        if (flags.since) q.since = Number(flags.since);
        // --operator (alias --all) is the human asking for the whole machine's bodies;
        // without it you see bodies only for your own project's traffic.
        out(await client.history(q, resolveSelfAlias(), flags.operator === true || flags.all === true));
        return 0;
      }
      case "status": {
        const msgId = positional[0] ?? "";
        if (!msgId) {
          console.error("status <msg-id>");
          return 2;
        }
        out(await client.status(msgId, resolveSelfAlias(), flags.operator === true || flags.all === true));
        return 0;
      }
      case "sent": {
        // What became of a message YOU sent, per recipient. send-success only means
        // the broker took it; this reads the delivery ladder the broker already
        // tracks so a sender can tell "never saw it" from "saw it, hasn't answered"
        // — the difference between waiting and escalating (D1, vb-opus).
        const msgId = positional[0] ?? "";
        if (!msgId) {
          console.error("sent <msg-id>  (delivery state of a message you sent, per recipient)");
          return 2;
        }
        const self = resolveSelfAlias();
        // operator=false: this reads YOUR OWN sent message, and the sender is already
        // a party — so the strip layer shows your body while still hiding non-parties'.
        // operator=true here dumped ANY message's body, defeating stripForCaller.
        const st = (await client.status(msgId, self, false)) as {
          message?: { id: string; fromAlias: string; toAlias: string };
          deliveries?: { toAlias: string; state: string; ts: number }[];
          responses?: { fromAlias: string; terminal: boolean }[];
        };
        if (!st.message) {
          console.error(`no message ${msgId}`);
          return 2;
        }
        const roster = ((await client.list()).peers ?? []) as {
          alias: string;
          status: string;
          lastSeen: number | null;
          sessionAliases?: string[];
        }[];
        // `sent` is for messages YOU sent — enforce it (the verb's name promises it, and
        // it stops a non-party from reading a stranger's recipient list + delivery ladder).
        const myAliases = new Set(roster.find((r) => r.alias === self)?.sessionAliases ?? (self ? [self] : []));
        if (!myAliases.has(st.message.fromAlias)) {
          console.error(
            `sent shows delivery of messages YOU sent; ${msgId} was sent by ${st.message.fromAlias}. For any message's lifecycle: claude-ipc status ${msgId}`,
          );
          return 2;
        }
        const liveness = (alias: string): string => {
          const p = roster.find((r) => r.alias === alias);
          if (!p) return "not on the roster";
          return p.status === "offline" ? `offline${p.lastSeen ? ", " + offlineSince(p.lastSeen) : ""}` : p.status;
        };
        // Honest labels: the broker knows delivery, never cognition. "surfaced" is the
        // strongest it can assert; "consumed" covers system settles (cancel too), so it
        // never claims "read" for a message the recipient may never have seen.
        const label: Record<string, string> = {
          queued: "queued — not yet claimed by their session",
          delivered: "delivered — claimed by their wake, not yet shown",
          surfaced: "surfaced — placed in their context (NOT confirmed read)",
          consumed: "settled — read, accepted, declined, or cancelled",
          accepted: "accepted",
          declined: "declined",
        };
        if (flags.json === true) {
          out(st);
          return 0;
        }
        // REPLIED is session-aware: a reply from a SIBLING alias of the recipient still
        // counts (the session answered under another of its names).
        const sessionOf = (alias: string): Set<string> =>
          new Set(roster.find((r) => r.alias === alias)?.sessionAliases ?? [alias]);
        const responders = (st.responses ?? []).map((r) => r.fromAlias);
        const deliveries = st.deliveries ?? [];
        out(`sent ${st.message.id} → ${deliveries.length} recipient${deliveries.length === 1 ? "" : "s"}:`);
        for (const d of deliveries) {
          const note = d.state === "queued" ? " · waits for their next wake" : "";
          const theirNames = sessionOf(d.toAlias);
          const replied = responders.some((fromAlias) => theirNames.has(fromAlias)) ? " · REPLIED" : "";
          out(`  ${d.toAlias} (${liveness(d.toAlias)}) — ${label[d.state] ?? d.state}${note}${replied}`);
        }
        if (!deliveries.length) out("  (no delivery records — was it sent to a project mailbox or a broadcast?)");
        return 0;
      }
      case "show": {
        // One message, readable — both field agents asked for this instead of
        // peeking the whole inbox and jq-filtering by id.
        const msgId = positional[0] ?? "";
        if (!msgId) {
          console.error("show <msg-id>");
          return 2;
        }
        const st = (await client.status(msgId, resolveSelfAlias(), flags.operator === true || flags.all === true)) as {
          message: { id: string; kind: string; fromAlias: string; toAlias: string; body: string; ts: number; corrId: string | null; conversationId: string | null };
          responses: { id: string; fromAlias: string; terminal: boolean }[];
        };
        // --json for pipelines: `inbox` is JSON but `show` was human-only, so a
        // `show | jq` silently emitted nothing. Same object shape as status.
        if (flags.json === true) {
          out(st);
          return 0;
        }
        const m = st.message;
        const nowS = Math.floor(Date.now() / 1000);
        out(`${m.id} · ${m.kind} · ${m.fromAlias} → ${m.toAlias} · ${humanAge(m.ts, nowS)} ago`);
        if (m.corrId) out(`answers ${m.corrId}`);
        if (m.conversationId) out(`conversation ${m.conversationId}`);
        out("");
        out(m.body || "(empty body)");
        if (st.responses.length) {
          out("");
          out(`${st.responses.length} repl${st.responses.length === 1 ? "y" : "ies"}: ${st.responses.map((r) => `${r.id} (${r.fromAlias}${r.terminal ? "" : ", partial"})`).join(", ")}`);
        }
        return 0;
      }
      case "owed": {
        // Everything this session still owes an answer to, across ALL its
        // aliases and its project mailboxes — the startup-poll gap both field
        // agents hit was exactly "inbox --project was empty while an
        // alias-addressed ask sat owed".
        const self = flags.as ? String(flags.as) : resolveSelfAlias();
        if (!self) {
          console.error("owed can't tell who you are — register this session, or pass --as <alias>");
          return 2;
        }
        const roster = ((await client.list()).peers ?? []) as { alias: string; sessionAliases?: string[] }[];
        const mine = roster.find((p) => p.alias === self)?.sessionAliases ?? [self];
        const nowS = Math.floor(Date.now() / 1000);
        const owedLines: string[] = [];
        for (const alias of mine) {
          try {
            const box = (await client.check(alias, false)) as { messages: { id: string; kind: string; fromAlias: string; body: string; ts: number }[] };
            for (const m of box.messages ?? []) {
              if (m.kind !== "query" && m.kind !== "request") continue;
              owedLines.push(
                `${alias} owes ${m.fromAlias} · ${m.kind} ${m.id} · ${humanAge(m.ts, nowS)} old · reply: claude-ipc reply ${m.id} --from ${alias} "<answer>"\n    ${m.body.slice(0, 100).replace(/\n/g, " ")}`,
              );
            }
          } catch {
            // an alias whose mailbox we can't read is not silently skipped
            owedLines.push(`${alias}: (mailbox unreadable)`);
          }
        }
        try {
          const proj = (await client.checkProject(process.cwd(), false, self)) as { messages: { id: string; kind: string; fromAlias: string; body: string; ts: number }[] };
          for (const m of proj.messages ?? []) {
            if (m.kind !== "query" && m.kind !== "request") continue;
            owedLines.push(
              `this project owes ${m.fromAlias} · ${m.kind} ${m.id} · ${humanAge(m.ts, nowS)} old · first to reply settles it`,
            );
          }
        } catch {
          // not a member here / broker degraded — alias boxes above still answered
        }
        out(owedLines.length ? owedLines.join("\n") : `nothing owed — all asks to ${mine.join(", ")} are settled`);
        return 0;
      }
      case "feedback": {
        // The standing intake: works with no maintainer session running (project
        // mail waits by design) and with the broker down (degraded write). The
        // default address is this machine's claude-ipc repo — set
        // CLAUDE_IPC_FEEDBACK_ADDR when the repo lives elsewhere.
        const ffrom = flags.from ? String(flags.from) : resolveSelfAlias();
        if (!ffrom) {
          console.error("feedback can't tell who's sending — register this session, or pass --from <alias>");
          return 2;
        }
        const fBody = bodyFromFile(flags["body-file"]);
        if (fBody === "bad") {
          console.error(`--body-file: can't read ${String(flags["body-file"])}`);
          return 2;
        }
        const text = fBody ?? positional.join(" ");
        if (!text.trim()) {
          console.error(`feedback needs a body:\n  claude-ipc feedback "<what's broken / what you wish existed>"`);
          return 2;
        }
        const res = await client.send({ from: ffrom, to: config.feedbackAddr, kind: "inform", body: `[feedback] ${text}` });
        out(res);
        console.error("feedback filed — the next maintainer session in the claude-ipc repo sees it at wake-up.");
        return 0;
      }
      case "accept": {
        const msgId = positional[0] ?? "";
        const as = String(flags.as ?? "");
        if (!msgId || !as) {
          console.error("accept <msg-id> --as <alias>");
          return 2;
        }
        out(await client.accept(as, msgId));
        return 0;
      }
      case "decline": {
        const msgId = positional[0] ?? "";
        const as = String(flags.as ?? "");
        if (!msgId || !as) {
          console.error("decline <msg-id> --as <alias> [--reason r]");
          return 2;
        }
        out(await client.decline(as, msgId, flags.reason ? String(flags.reason) : undefined));
        return 0;
      }
      case "snooze": {
        const msgId = positional[0] ?? "";
        const as = String(flags.as ?? "");
        if (!msgId || !as) {
          console.error("snooze <msg-id> --as <alias>");
          return 2;
        }
        out(await client.snooze(as, msgId));
        return 0;
      }
      case "cancel": {
        // Abandon an outstanding ask you sent — a later reply to it is dropped. The client,
        // router, and MCP tool all had this; the CLI simply never exposed the verb, so the
        // human had no way to take back a query they no longer cared about.
        const corrId = positional[0] ?? String(flags.corr ?? "");
        if (!corrId) {
          console.error("cancel <msg-id>   (the id of YOUR outstanding query/request)");
          return 2;
        }
        out(await client.cancel(corrId, resolveSelfAlias()));
        return 0;
      }
      case "serve": {
        // Run the broker in-process so the compiled CLI binary IS the broker.
        // launchd points here, eliminating the source-vs-dist drift where the
        // broker ran from src/ while the CLI shipped from dist/. Blocks forever;
        // main() installs the SIGTERM/SIGINT handlers that exit cleanly.
        const { main } = await import("./broker/server.ts");
        main();
        await new Promise<void>(() => {});
        return 0;
      }
      case "daemon": {
        const sub = positional[0] ?? "status";
        if (sub === "status") {
          try {
            await client.list();
            out("broker: up");
            return 0;
          } catch {
            out("broker: DOWN");
            return 1;
          }
        }
        if (sub === "start") {
          try {
            await client.list();
            out("broker already up");
            return 0;
          } catch {
            // down → start it
          }
          const { spawnBroker } = await import("./daemonCtl.ts");
          out(`broker starting (pid ${spawnBroker()})`);
          return 0;
        }
        if (sub === "stop") {
          try {
            const pid = Number(readFileSync(config.pidPath, "utf8").trim());
            process.kill(pid, "SIGTERM");
            out(`stopped broker (pid ${pid})`);
            // A SIGTERM only sticks if nothing is supervising the process. Under
            // launchd/systemd KeepAlive the broker respawns within seconds, so a bare
            // `daemon stop` looks like it worked and doesn't — say so, and name the
            // command that actually keeps it down.
            out(
              "note: if a service manager supervises the broker (launchd KeepAlive / systemd Restart), " +
                "it will respawn. To keep it down, stop it there — e.g. " +
                "launchctl bootout gui/$(id -u)/com.alcatraz.claude-ipc",
            );
            return 0;
          } catch {
            out("broker not running (no pidfile)");
            return 1;
          }
        }
        console.error(`daemon: unknown subcommand "${sub}" (status|start|stop)`);
        return 2;
      }
      case "compose": {
        // The sender is THIS session, not a literal "cli" — hardcoding that made every
        // compose die with not_registered under strict mode, after the whole prompt chain.
        const cfrom = flags.from ? String(flags.from) : resolveSelfAlias();
        if (!cfrom) {
          console.error(
            "compose can't tell who's sending — register this session first, or pass --from <alias>.",
          );
          return 2;
        }
        if (!process.stdin.isTTY) {
          console.error("compose is interactive and needs a terminal. Use: claude-ipc send --to <alias> \"<message>\"");
          return 2;
        }
        const peers = (await client.list()).peers as { alias: string; cwd: string; status: string }[];
        const live = peers.filter((p) => p.status !== "offline");
        if (live.length === 0) {
          out("no live peers to send to");
          return 0;
        }
        out("Live peers:");
        live.forEach((p, i) => out(`  [${i + 1}] ${p.alias}  (${p.cwd})`));
        const target = live[Number(prompt("target #: ")) - 1];
        if (!target) {
          console.error("invalid selection");
          return 2;
        }
        const kind = (prompt("kind [inform|query|request] (inform): ") || "inform") as
          | "inform"
          | "query"
          | "request";
        const body = prompt("notes: ") ?? "";
        out(await client.send({ from: cfrom, to: target.alias, kind, body }));
        return 0;
      }
      case "-i":
      case "interactive": {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.error("interactive mode needs a terminal. For scripts, use the plain verbs (peers, inbox, log).");
          return 2;
        }
        const { runDashboard } = await import("./tui/app.tsx");
        await runDashboard(client);
        return 0;
      }
      case "tail": {
        const opts = { operator: flags.operator === true || flags.all === true, asAlias: resolveSelfAlias() };
        if (flags.once === true || flags.once === "true") {
          out(await monitorSnapshot(client, opts));
          return 0;
        }
        for (;;) {
          process.stdout.write("\x1b[2J\x1b[H");
          out(await monitorSnapshot(client, opts));
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      default:
        out(USAGE);
        return cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    // not_registered gets its own exit code so watchers (ipc-await.sh) can tell
    // "your alias is gone, re-register" from a transient broker outage — an
    // error CLASS travels as a code, never as a string to grep (gate HIGH-2)
    if (e instanceof BrokerError && e.code === "not_registered") return 4;
    return 1;
  }
}

/** The last big stdout write's flush promise — the exit path must outlive it. */
let stdoutDrain: Promise<void> | null = null;

if (import.meta.main) {
  // exitCode + awaiting the big-write drain, never process.exit(): a hard exit
  // truncated piped output past ~64KB, and Bun's console channel can drop a
  // queued tail even at natural exit (nondeterministic — an earlier fix here
  // "verified" on one lucky run and was falsified on the next; see the pipe
  // drain test for the layer that actually proves it).
  run(Bun.argv.slice(2)).then(async (code) => {
    process.exitCode = code;
    if (stdoutDrain) await stdoutDrain;
  });
}
