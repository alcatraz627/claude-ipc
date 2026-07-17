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
import { TRUST_RAIL } from "./hooks/shared.ts";
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

/** This session's own ipc alias, from the side-file the SessionStart hook writes
 *  (keyed by CLAUDE_CODE_SESSION_ID). Undefined if the session never registered.
 *  Lets `send`/`reply` infer --from so a session never has to name itself. */
function resolveSelfAlias(): string | undefined {
  return readAliasForSession(process.env.CLAUDE_CODE_SESSION_ID);
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
const BOOLEAN_FLAGS = new Set(["partial", "consume", "no-reply-expected", "operator", "all"]);

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

  register <alias>           (claim a mailbox from the shell)
  send   --to <b> | --to-project <dir|name> [--from <a>] [--kind inform|query|request] [--ttl N]
         [--reply-by 5m|90s|none] [--no-reply-expected] <body...>
                             (--reply-by: how long you'll wait before the ask is chased for you.
                              They get nudged at that mark; 10m later you're told nobody answered and
                              may act without one — the ask stays open and a late reply still reaches
                              you. Default 5m. Sending the LAST message in a chain? --no-reply-expected)
                             (--from auto-inferred from THIS session's alias; --kind defaults to inform;
                              project mail waits for ANY session working in that directory tree)
  reply  <corr-id> [--from <alias>] [--status error] [--partial] <body...>
                             (--from auto-inferred; --partial = interim ack/update, omit for the final reply)
  inbox  <alias> [--consume] | --project [dir]   (project peek is open; consume needs membership)
  peers
  projects                   (project mailboxes with pending mail)
  orphans [--project [dir]]  (dead sessions' waiting mail — successors peek with: inbox <alias>)
  count  <alias>             (pending count — cheap, for tab-title segments)
  log    [--peer <a>] [--since <epoch>]
  status <msg-id>            (a message's delivery + response lifecycle)
  show   <msg-id>            (one message, readable — headers, body, replies)
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
  register: ["as", "tty"],
  send: ["to", "to-project", "from", "kind", "ttl", "reply-by", "no-reply-expected", "body", "body-file"],
  reply: ["from", "corr", "status", "partial", "body", "body-file"],
  inbox: ["alias", "consume", "project"],
  count: ["alias", "project"],
  orphans: ["project"],
  prune: ["offline-for"],
  log: ["peer", "since", "operator", "all"],
  status: ["operator", "all"],
  show: ["operator", "all"],
  owed: ["as"],
  feedback: ["from", "body-file"],
  tail: ["once", "operator", "all"],
  accept: ["as"],
  decline: ["as", "reason"],
  snooze: ["as"],
  cancel: ["corr"],
  compose: ["from"],
  peers: [],
  projects: [],
  "-i": [],
  interactive: [],
};

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
        const sid = process.env.CLAUDE_CODE_SESSION_ID;
        if (!sid) {
          console.error(
            "register must run inside a Claude Code session (CLAUDE_CODE_SESSION_ID is unset).\n" +
              "It rebinds the current session's ipc alias; run it from that session's shell,\n" +
              "or set CLAUDE_IPC_ALIAS in that session's environment instead.",
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
          pid: process.ppid,
          tty: flags.tty ? String(flags.tty) : undefined,
        })) as { replaced?: boolean };
        writeAliasForSession(sid, alias);
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
            oldestTs: number | null;
          }[];
          const preds = list.filter((o) => o.alias !== alias && o.pending > 0);
          if (preds.length) {
            const shown = preds.slice(0, 5);
            const tail =
              preds.length > shown.length ? [`  … +${preds.length - shown.length} more (claude-ipc orphans --project)`] : [];
            out(
              [
                `predecessor mail in this project — dead sessions still hold unread messages (age is a staleness hint — old mail may have been superseded by a later correction):`,
                ...shown.map(
                  (o) =>
                    `  ${o.alias} holds ${o.pending}${ageHint(o.oldestTs)} — peek: claude-ipc inbox ${o.alias} · claim: claude-ipc inbox ${o.alias} --consume`,
                ),
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
            flags.body
              ? `the message body is positional, not a flag — put it after the flags:\n` +
                  `  claude-ipc send --to ${to} --from ${from} "${String(flags.body)}"`
              : `send needs a body — NOTHING WAS SENT:\n  claude-ipc send --to ${to} --from ${from} "<message>"`,
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
            const all = ((await client.list()).peers ?? []) as { alias: string; status: string }[];
            const live = all.filter((p) => p.status !== "offline").map((p) => p.alias);
            const offline = all.filter((p) => p.status === "offline").map((p) => p.alias);
            const lines = [`no peer named "${to}" is registered — NOTHING WAS SENT.`];
            if (live.length) lines.push(`  reachable now:  ${live.join(", ")}`);
            if (offline.length) {
              const shown = offline.slice(0, 8).join(", ");
              lines.push(`  known but offline (mail still reaches them):  ${shown}${offline.length > 8 ? ", …" : ""}`);
            }
            if (!live.length && !offline.length) lines.push(`  no peers are registered yet.`);
            lines.push(`  full roster:  claude-ipc peers`);
            console.error(lines.join("\n"));
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
          console.error("inbox needs an alias (or --project [dir])");
          return 2;
        }
        const box = await client.check(alias, consume);
        out(withReplyHints(box, alias));
        railIfPeerMail(box);
        return 0;
      }
      case "peers":
        out(await client.list());
        return 0;
      case "count": {
        if (flags.project) {
          const dir = await resolveProjectDir(flags.project, client);
          if (typeof dir !== "string") return 2;
          out(String((await client.countProject(dir)).count));
          return 0;
        }
        const alias = positional[0] ?? String(flags.alias ?? "");
        if (!alias) {
          console.error("count <alias> (or count --project [dir])");
          return 2;
        }
        out(String((await client.count(alias)).count));
        return 0;
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
        out(await client.orphans(dir ?? undefined));
        return 0;
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
