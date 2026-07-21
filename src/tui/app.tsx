/**
 * The `claude-ipc -i` dashboard: a full-screen, live, never-dead-end view of
 * the message fabric. This file owns all state and the single key dispatcher;
 * views and modals are pure render. Ordering in the dispatcher IS the keymap
 * contract: filter-edit swallows everything, then the open modal, then global
 * chrome keys, then the focused view.
 */

import { AlternateScreen, Box, render, Spacer, Text, useApp, useInput, useInterval } from "ink-terminal";
import { useEffect, useRef, useState } from "react";
import type { Client } from "../client.ts";
import { spawnBroker } from "../daemonCtl.ts";
import { BrokerError } from "../client.ts";
import type { Message } from "../models.ts";
import { acceptMsg, declineMsg, replyTo, snoozeMsg } from "./actions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { ComposePanel, KINDS, REPLY_BY_OPTIONS, type ComposeState, type ComposeStep } from "./compose.tsx";
import { EMPTY_SNAPSHOT, fetchFabric, type FabricSnapshot } from "./data.ts";
import { editInEditor } from "./editor.ts";
import { actingCandidates, sessionIdentity, type Identity } from "./identity.ts";
import {
  actionsFor,
  copyFieldsForMessage,
  copyFieldsForOrphan,
  copyFieldsForPeer,
  copyFieldsForProject,
  deliveryLines,
  fabricOverview,
  filterMessages,
  filterRoster,
  ROSTER_SORTS,
  sortRoster,
  groupRoster,
  lastMessageFor,
  lastOpenAskFrom,
  peerPreview,
  pendingStats,
  recipientOptions,
  type CopyField,
  type RosterRow,
} from "./model.ts";
import { LogView, OrphansView, ProjectsView } from "./views/browse.tsx";
import type { EditState } from "./widgets/textarea-ops.ts";
import { AskInput, CopyMenu, Help, IdentityPicker, Overview, QuitGuard } from "./modals.tsx";
import { theme } from "./theme.ts";
import { InboxList, MessagePane } from "./views/inbox.tsx";
import { HomeView, type Pane } from "./views/peers.tsx";

const VIEWS = ["peers", "inbox", "projects", "orphans", "log"] as const;
type View = (typeof VIEWS)[number];

/** Auto-refresh ladder, ms. `+`/`-` walk it (btop's timer keys); 5s is D6's default. */
const CADENCES = [1000, 2000, 3000, 5000, 10000, 15000, 30000] as const;
const DEFAULT_CADENCE = 3; // index of 5000

type Modal =
  | { t: "quit" }
  | { t: "help" }
  | { t: "overview" }
  | { t: "copy"; fields: CopyField[]; sel: number }
  | { t: "identity"; candidates: string[]; sel: number }
  | { t: "reply"; msg: Message; value: string }
  | { t: "decline"; msg: Message; value: string }
  | ComposeState
  | null;

interface Toast {
  text: string;
  kind: "ok" | "err";
}

/** The footer keybar: accented key, dim label — the same convention as the help overlay. */
function KeyHints({ pairs }: { pairs: [string, string][] }) {
  return (
    <Text dim wrap="truncate-end">
      {pairs.map(([k, label], i) => (
        <Text key={k}>
          {i > 0 ? " · " : ""}
          <Text bold color={theme.accent}>
            {k}
          </Text>
          {` ${label}`}
        </Text>
      ))}
    </Text>
  );
}

/** Scroll a list pane so its keyboard selection stays visible. */
function followSelection(
  sb: { scrollTo(y: number): void; getScrollTop(): number; getViewportHeight(): number } | null,
  sel: number,
): void {
  if (!sb) return;
  const top = sb.getScrollTop();
  const vh = sb.getViewportHeight();
  if (sel < top) sb.scrollTo(sel);
  else if (vh > 0 && sel >= top + vh) sb.scrollTo(sel - vh + 1);
}

function App({ client }: { client: Client }) {
  const { exit } = useApp();
  const [view, setView] = useState<View>("peers");
  const [modal, setModal] = useState<Modal>(null);
  const [snapshot, setSnapshot] = useState<FabricSnapshot>(EMPTY_SNAPSHOT);
  const [identity, setIdentity] = useState<Identity | null>(() => sessionIdentity());
  const [identitySettled, setIdentitySettled] = useState(() => sessionIdentity() !== null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState("");
  const [filterEditing, setFilterEditing] = useState(false);
  const [offlineExpanded, setOfflineExpanded] = useState(false);
  const [inboxSel, setInboxSel] = useState(0);
  const [focusedPane, setFocusedPane] = useState<Pane>("roster");
  const [thread, setThread] = useState<{ msgId: string; question: string | null; replies: number } | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const editorBusyRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [refreshIdx, setRefreshIdx] = useState(DEFAULT_CADENCE);
  const [owedOnly, setOwedOnly] = useState(false);
  const [seen] = useState(() => new Set<string>()); // session-local reading aid; never consumes
  const [seenTick, setSeenTick] = useState(0); // Set mutations need a render nudge
  const [sortIdx, setSortIdx] = useState(0);
  const [logQuery, setLogQuery] = useState("");
  const [logQueryEditing, setLogQueryEditing] = useState(false);
  const [projSel, setProjSel] = useState(0);
  const [orphSel, setOrphSel] = useState(0);
  const [logSel, setLogSel] = useState(0);
  const [logOperator, setLogOperator] = useState(false);
  const [peek, setPeek] = useState<{ key: string; messages: Message[] | null } | null>(null);

  const inFlight = useRef(false);
  const rerun = useRef(false);
  type ScrollHandle = { scrollTo(y: number): void; getScrollTop(): number; getViewportHeight(): number };
  const scrollRef = useRef<ScrollHandle>(null);
  const inboxScrollRef = useRef<ScrollHandle>(null);

  async function refresh(): Promise<void> {
    // A refresh requested mid-fetch runs AFTER the current one instead of being
    // dropped — the operator toggle and post-action refetches must always land.
    if (inFlight.current) {
      rerun.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const snap = await fetchFabric(client, identity?.alias, logOperator);
      // while $EDITOR owns the terminal, any render would scribble over it
      if (!editorBusyRef.current) setSnapshot(snap);
    } finally {
      inFlight.current = false;
      if (rerun.current) {
        rerun.current = false;
        void refreshRef.current();
      }
    }
  }
  // Latest-callback ref: the interval and the rerun chain must call the CURRENT
  // refresh (fresh identity/operator params), never the closure they were born in.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
    // identity changes what "my inbox" means; the operator toggle changes
    // which bodies history may show — both refetch
  }, [identity?.alias, logOperator]);
  useInterval(() => void refreshRef.current(), editorBusy || paused ? null : CADENCES[refreshIdx]!);
  useInterval(() => setNowS(Math.floor(Date.now() / 1000)), editorBusy ? null : 1000);

  // A bare shell has no session alias: once the roster is here, offer the
  // registered identities we hold tokens for. Esc = browse read-only.
  useEffect(() => {
    if (identitySettled || !snapshot.brokerUp || modal) return;
    const candidates = actingCandidates(snapshot.peers);
    if (candidates.length === 0) {
      setIdentitySettled(true);
      setToast({ text: "no identity to act as — read-only", kind: "err" });
      return;
    }
    setModal({ t: "identity", candidates, sel: 0 });
  }, [snapshot, identitySettled, modal]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- derived view-model (pure fns over the snapshot) ----
  const sessionCounts = (row: RosterRow) => {
    const aliases = [row.alias, ...row.also];
    const boxes = aliases.map((a) => snapshot.peerInboxes.get(a)).filter((b): b is Message[] => Array.isArray(b));
    if (boxes.length === 0) return null;
    return pendingStats(boxes.flat());
  };
  const grouped = groupRoster(snapshot.peers, identity?.alias);
  const matched = sortRoster(
    filterRoster(grouped, filter),
    ROSTER_SORTS[sortIdx]!,
    (row) => sessionCounts(row)?.owed ?? 0,
  );
  const visible = filter || offlineExpanded ? matched : matched.filter((r) => r.status !== "offline" || r.you);
  const offlineHidden = matched.length - visible.length;
  const selClamped = Math.min(sel, Math.max(0, visible.length - 1));
  const selected: RosterRow | undefined = visible[selClamped];

  const preview = selected
    ? peerPreview(
        selected,
        nowS,
        sessionCounts(selected),
        lastMessageFor(snapshot.history, [selected.alias, ...selected.also]),
        snapshot.at,
      )
    : null;

  const inboxAll = [...snapshot.myInbox].sort((a, b) => b.ts - a.ts);
  const inbox = owedOnly ? inboxAll.filter((m) => m.kind === "query" || m.kind === "request") : inboxAll;
  void seenTick; // the Set is mutated in place; this state only exists to re-render
  const inboxSelClamped = Math.min(inboxSel, Math.max(0, inbox.length - 1));
  const selectedMsg: Message | undefined = inbox[inboxSelClamped];

  // Keep each pane's keyboard selection inside its ScrollBox viewport.
  useEffect(() => followSelection(scrollRef.current, selClamped), [selClamped]);
  useEffect(() => followSelection(inboxScrollRef.current, inboxSelClamped), [inboxSelClamped]);

  // Thread context for the reading pane: what this message answers, and how
  // many replies its conversation carries. Best-effort; a refusal shows nothing.
  useEffect(() => {
    const m = selectedMsg;
    if (!m) return setThread(null);
    const target = m.corrId ?? m.id;
    let stale = false;
    client
      .status(target, identity?.alias)
      .then((r: { message?: Message; responses?: Message[] }) => {
        if (stale) return;
        setThread({
          msgId: m.id,
          question: m.corrId ? (r.message?.body ?? null) : null,
          replies: r.responses?.length ?? 0,
        });
      })
      .catch(() => !stale && setThread(null));
    return () => {
      stale = true;
    };
  }, [selectedMsg?.id, identity?.alias]);

  const threadFor = thread && thread.msgId === selectedMsg?.id ? thread : null;

  const [logDeliv, setLogDeliv] = useState<{ msgId: string; rows: string[] } | null>(null);

  const logSorted = filterMessages(
    [...snapshot.history].sort((a, b) => b.ts - a.ts),
    logQuery,
  );
  const projClamped = Math.min(projSel, Math.max(0, snapshot.projects.length - 1));
  const orphClamped = Math.min(orphSel, Math.max(0, snapshot.orphans.length - 1));
  const logClamped = Math.min(logSel, Math.max(0, logSorted.length - 1));

  // D1 in the LOG: when the selected flow message is one I sent, fetch its
  // per-recipient delivery lifecycle. Only my own sends — a delivery ledger for
  // someone else's message is not mine to display.
  const selectedLogMsg = view === "log" ? logSorted[logClamped] : undefined;
  useEffect(() => {
    const m = selectedLogMsg;
    const mine = grouped.find((r) => r.you);
    const myNames = mine ? [mine.alias, ...mine.also] : identity ? [identity.alias] : [];
    if (!m || !myNames.includes(m.fromAlias)) {
      setLogDeliv(null);
      return;
    }
    let stale = false;
    client
      .status(m.id, identity?.alias)
      .then(
        (r: { deliveries?: { toAlias: string; state: string }[] }) =>
          !stale && setLogDeliv({ msgId: m.id, rows: deliveryLines(r.deliveries ?? []) }),
      )
      .catch(() => !stale && setLogDeliv(null));
    return () => {
      stale = true;
    };
  }, [selectedLogMsg?.id, identity?.alias]);

  // Peek the selected project/orphan mailbox — read-only, never consuming.
  useEffect(() => {
    const target =
      view === "projects" && snapshot.projects[projClamped]
        ? { key: `proj:${snapshot.projects[projClamped]!.path}`, fetch: () => client.checkProject(snapshot.projects[projClamped]!.path, false, identity?.alias) }
        : view === "orphans" && snapshot.orphans[orphClamped]
          ? { key: `orph:${snapshot.orphans[orphClamped]!.alias}`, fetch: () => client.check(snapshot.orphans[orphClamped]!.alias, false) }
          : null;
    if (!target) return;
    let stale = false;
    target
      .fetch()
      .then((r: { messages: Message[] }) => !stale && setPeek({ key: target.key, messages: r.messages ?? [] }))
      .catch(() => !stale && setPeek({ key: target.key, messages: null }));
    return () => {
      stale = true;
    };
  }, [view, projClamped, orphClamped, snapshot.at]);

  const peekFor = (key: string): Message[] | null => (peek?.key === key ? peek.messages : []);

  function openCopyMenu(): void {
    if (!selected) return;
    const aliases = [selected.alias, ...selected.also];
    const fields = copyFieldsForPeer(
      selected,
      identity?.alias,
      lastMessageFor(snapshot.history, aliases),
      lastOpenAskFrom(snapshot.myInbox, aliases),
    );
    setModal({ t: "copy", fields, sel: 0 });
  }

  /** The inbox has focus (home lower pane, or the INBOX tab). */
  const inboxFocused = (view === "peers" && focusedPane === "inbox") || view === "inbox";

  function openCompose(prefillTo?: string): void {
    if (!requireIdentity()) return;
    const recipients = recipientOptions(grouped, process.cwd());
    if (recipients.length === 0) return setToast({ text: "nobody to send to yet", kind: "err" });
    setModal({
      t: "compose",
      step: prefillTo ? "kind" : "to",
      recipients,
      toSel: 0,
      to: prefillTo ?? null,
      kindSel: 0,
      kind: "inform",
      body: { text: "", cursor: 0 },
      replyBySel: 0,
    });
  }

  // Functional like every other incremental update: a fast key-run is one React
  // batch, and a patch computed from the closure would collapse it.
  const patchCompose = (patch: Partial<ComposeState> | ((m: ComposeState) => Partial<ComposeState>)) =>
    setModal((m) => (m?.t === "compose" ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m));

  /** Advance out of the body step; an empty body never proceeds toward send. */
  function bodyDone(c: ComposeState): void {
    if (!c.body.text.trim()) return setToast({ text: "the body is empty — nothing to send yet", kind: "err" });
    patchCompose({ step: c.kind === "inform" ? "confirm" : "replyBy" });
  }

  /** Swap the whole screen for $EDITOR, then take its text back into the body. */
  async function bodyEditor(c: ComposeState): Promise<void> {
    editorBusyRef.current = true;
    setEditorBusy(true);
    await new Promise((r) => setTimeout(r, 120)); // let the fallback frame flush before the editor claims the tty
    const edited = await editInEditor(c.body.text);
    editorBusyRef.current = false;
    setEditorBusy(false);
    if (edited === null) return setToast({ text: "$EDITOR aborted — body unchanged", kind: "err" });
    patchCompose({ body: { text: edited, cursor: edited.length } });
  }

  async function submitCompose(c: ComposeState): Promise<void> {
    const from = requireIdentity();
    if (!from || !c.to) return;
    if (!c.body.text.trim()) return setToast({ text: "the body is empty — nothing was sent", kind: "err" });
    try {
      const replyByS = c.kind === "inform" ? undefined : REPLY_BY_OPTIONS[c.replyBySel]!.value;
      const res = (await client.send({ from, to: c.to, kind: c.kind, body: c.body.text, replyByS })) as {
        msgId: string;
        replyByS: number | null;
      };
      setToast({
        text: `sent ${res.msgId} to ${c.to}${res.replyByS ? ` — they get nudged at ${Math.round(res.replyByS / 60)}m` : ""}`,
        kind: "ok",
      });
      setModal(null);
      void refresh();
    } catch (e) {
      const text = e instanceof BrokerError ? `refused (${e.code}): ${e.message.slice(0, 90)}` : String(e).slice(0, 90);
      setToast({ text, kind: "err" });
    }
  }

  /** One step back in the compose flow — the anti-dead-end contract. */
  function composeBack(c: ComposeState): void {
    const back: Record<ComposeStep, ComposeStep | null> = {
      to: null,
      kind: "to",
      body: "kind",
      replyBy: "body",
      confirm: c.kind === "inform" ? "body" : "replyBy",
    };
    const prev = back[c.step];
    if (prev === null) setModal(null);
    else patchCompose({ step: prev });
  }

  function requireIdentity(): string | null {
    if (identity) return identity.alias;
    setToast({ text: "read-only — @ to pick an identity", kind: "err" });
    return null;
  }

  function openAskModal(t: "reply" | "decline"): void {
    // never a silent no-op: a keypress that does nothing must say why
    if (!selectedMsg) return setToast({ text: "inbox is empty — nothing to act on", kind: "err" });
    if (!requireIdentity()) return;
    const acts = actionsFor(selectedMsg);
    if (t === "reply" && !acts.reply) return setToast({ text: "nothing is owed on this — reply targets an ask", kind: "err" });
    if (t === "decline" && !acts.decline) return setToast({ text: "only a request can be declined", kind: "err" });
    setModal({ t, msg: selectedMsg, value: "" });
  }

  async function runAction(kind: "accept" | "snooze"): Promise<void> {
    if (!selectedMsg) return setToast({ text: "inbox is empty — nothing to act on", kind: "err" });
    const alias = requireIdentity();
    if (!alias) return;
    const acts = actionsFor(selectedMsg);
    if (kind === "accept" && !acts.accept) return setToast({ text: "only a request can be accepted", kind: "err" });
    if (kind === "snooze" && !acts.snooze) return setToast({ text: "only an owed ask can be snoozed", kind: "err" });
    const out = kind === "accept" ? await acceptMsg(client, alias, selectedMsg.id) : await snoozeMsg(client, alias, selectedMsg.id);
    setToast({ text: out.text, kind: out.ok ? "ok" : "err" });
    if (out.ok) void refresh();
  }

  async function submitAskModal(m: Modal & ({ t: "reply" } | { t: "decline" })): Promise<void> {
    const alias = requireIdentity();
    if (!alias) return;
    if (m.t === "reply" && !m.value.trim()) {
      // the empty-reply guard lives at the UI too: never send zero bytes
      return setToast({ text: "a reply needs a body", kind: "err" });
    }
    const out =
      m.t === "reply"
        ? await replyTo(client, alias, m.msg.id, m.value)
        : await declineMsg(client, alias, m.msg.id, m.value.trim());
    setToast({ text: out.text, kind: out.ok ? "ok" : "err" });
    if (out.ok) {
      setModal(null);
      void refresh();
    }
  }

  async function copyField(fields: CopyField[], i: number): Promise<void> {
    const f = fields[i];
    if (!f) return;
    const ok = await copyToClipboard(f.value);
    setToast(ok ? { text: `copied ${f.label}`, kind: "ok" } : { text: "copy failed (pbcopy)", kind: "err" });
    setModal(null);
  }

  function startBroker(): void {
    const pid = spawnBroker();
    setToast({ text: `broker starting (pid ${pid})`, kind: "ok" });
    setTimeout(() => void refresh(), 800);
  }

  function openIdentityPicker(): void {
    const candidates = actingCandidates(snapshot.peers);
    if (candidates.length === 0) return setToast({ text: "no registered identities to act as", kind: "err" });
    setModal({ t: "identity", candidates, sel: 0 });
  }

  // Every incremental update is FUNCTIONAL: a burst of key-repeat events is
  // processed in one React batch, so `setSel(selClamped + 1)` would collapse
  // twenty moves into one. Same reason dispatchOne exists per character.
  const moveSel = (delta: number) =>
    setSel((s) => Math.max(0, Math.min(visible.length - 1, Math.min(s, visible.length - 1) + delta)));
  const moveModalSel = (delta: number, max: number) =>
    setModal((m) => (m && "sel" in m ? { ...m, sel: Math.max(0, Math.min(max, m.sel + delta)) } : m));

  type KeyFlags = Parameters<Parameters<typeof useInput>[0]>[1];
  const NO_FLAGS = {} as KeyFlags;

  function dispatchOne(input: string, key: KeyFlags): void {
    // -- modal level: an open modal owns every key --
    if (modal) {
      if (modal.t === "reply" || modal.t === "decline") return; // TextField owns these keys
      if (modal.t === "compose") {
        const c = modal;
        if (c.step === "body") return; // TextArea owns the body step's keys
        if (key.escape) return composeBack(c);
        if (c.step === "to") {
          if (key.upArrow || input === "k") return patchCompose((m) => ({ toSel: Math.max(0, m.toSel - 1) }));
          if (key.downArrow || input === "j")
            return patchCompose((m) => ({ toSel: Math.min(m.recipients.length - 1, m.toSel + 1) }));
          if (key.pageUp) return patchCompose((m) => ({ toSel: Math.max(0, m.toSel - 9) }));
          if (key.pageDown) return patchCompose((m) => ({ toSel: Math.min(m.recipients.length - 1, m.toSel + 9) }));
          if (key.return) return patchCompose((m) => ({ to: m.recipients[m.toSel]!.value, step: "kind" }));
          return;
        }
        if (c.step === "kind") {
          if (key.upArrow || input === "k") return patchCompose((m) => ({ kindSel: Math.max(0, m.kindSel - 1) }));
          if (key.downArrow || input === "j")
            return patchCompose((m) => ({ kindSel: Math.min(KINDS.length - 1, m.kindSel + 1) }));
          if (key.return) return patchCompose((m) => ({ kind: KINDS[m.kindSel]!, step: "body" }));
          return;
        }
        if (c.step === "replyBy") {
          if (key.upArrow || input === "k") return patchCompose((m) => ({ replyBySel: Math.max(0, m.replyBySel - 1) }));
          if (key.downArrow || input === "j")
            return patchCompose((m) => ({ replyBySel: Math.min(REPLY_BY_OPTIONS.length - 1, m.replyBySel + 1) }));
          if (key.return) return patchCompose({ step: "confirm" });
          return;
        }
        if (c.step === "confirm" && key.return) return void submitCompose(c);
        return;
      }
      if (modal.t === "quit") {
        if (input === "y" || key.return) exit();
        else if (input === "n" || key.escape || input === "q") setModal(null);
        return;
      }
      if (modal.t === "help") {
        if (key.escape || input === "?" || input === "q") setModal(null);
        return;
      }
      if (modal.t === "overview") {
        if (key.escape || input === "v" || input === "q") setModal(null);
        return;
      }
      if (modal.t === "copy") {
        if (key.escape) return setModal(null);
        if (key.upArrow || input === "k") return moveModalSel(-1, modal.fields.length - 1);
        if (key.downArrow || input === "j") return moveModalSel(1, modal.fields.length - 1);
        if (key.return || input === "y") return void copyField(modal.fields, modal.sel);
        const d = Number(input);
        if (Number.isInteger(d) && d >= 1 && d <= modal.fields.length) return void copyField(modal.fields, d - 1);
        return;
      }
      if (modal.t === "identity") {
        if (key.escape) {
          setIdentity(null);
          setIdentitySettled(true);
          setModal(null);
          setToast({ text: "read-only — press a to pick an identity", kind: "err" });
          return;
        }
        if (key.upArrow || input === "k") return moveModalSel(-1, modal.candidates.length - 1);
        if (key.downArrow || input === "j") return moveModalSel(1, modal.candidates.length - 1);
        if (key.pageUp) return moveModalSel(-10, modal.candidates.length - 1);
        if (key.pageDown) return moveModalSel(10, modal.candidates.length - 1);
        if (key.return) {
          const alias = modal.candidates[modal.sel]!;
          setIdentity({ alias, mode: "acting-as" });
          setIdentitySettled(true);
          setModal(null);
          setToast({ text: `acting as ${alias}`, kind: "ok" });
        }
        return;
      }
    }

    // -- global chrome --
    if (key.tab || input === "\t")
      return setView((v) => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length]!);
    const digit = Number(input);
    if (input !== "" && Number.isInteger(digit) && digit >= 1 && digit <= VIEWS.length)
      return setView(VIEWS[digit - 1]!);
    if (input === "?") return setModal({ t: "help" });
    if (input === "R") return void refresh();
    if (input === "u") {
      const next = !paused;
      setPaused(next);
      if (next) setToast({ text: "refresh paused — u resumes, R refreshes once", kind: "ok" });
      else void refresh();
      return;
    }
    if (input === "+" || input === "=") return setRefreshIdx((i) => Math.min(CADENCES.length - 1, i + 1));
    if (input === "-") return setRefreshIdx((i) => Math.max(0, i - 1));
    if (input === "v") return setModal({ t: "overview" });
    if (input === "q") return setModal({ t: "quit" });
    if (input === "@") return openIdentityPicker();
    if (input === "c") return openCompose();
    if (input === "d" && !snapshot.brokerUp) return startBroker();

    // -- inbox keys, wherever the inbox has focus (home lower pane or INBOX tab) --
    if (inboxFocused) {
      if (key.upArrow || input === "k") return setInboxSel((s) => Math.max(0, Math.min(s, inbox.length - 1) - 1));
      if (key.downArrow || input === "j") return setInboxSel((s) => Math.min(inbox.length - 1, s + 1));
      if (input === "g") return setInboxSel(0);
      if (input === "G") return setInboxSel(Math.max(0, inbox.length - 1));
      if (key.return || input === "r") return openAskModal("reply");
      if (input === "a") return void runAction("accept");
      if (input === "d") return openAskModal("decline");
      if (input === "s") return void runAction("snooze");
      if (input === "f") {
        setOwedOnly((v) => !v);
        setToast({ text: owedOnly ? "showing everything" : "showing only what's owed", kind: "ok" });
        return;
      }
      if (input === "m") {
        if (!selectedMsg) return setToast({ text: "inbox is empty — nothing to mark", kind: "err" });
        if (seen.has(selectedMsg.id)) seen.delete(selectedMsg.id);
        else seen.add(selectedMsg.id);
        setSeenTick((t) => t + 1);
        return;
      }
      if (input === "y" && selectedMsg)
        return setModal({ t: "copy", fields: copyFieldsForMessage(selectedMsg, identity?.alias), sel: 0 });
      if (key.escape) {
        // one level up: the home's primary pane, or the quit guard from the tab
        if (view === "peers") return setFocusedPane("roster");
        return setModal({ t: "quit" });
      }
      return;
    }

    // -- roster pane (home view, roster focused) --
    if (view === "peers") {
      if (key.upArrow || input === "k") return moveSel(-1);
      if (key.downArrow || input === "j") return moveSel(1);
      if (key.pageUp) return moveSel(-10);
      if (key.pageDown) return moveSel(10);
      if (input === "g") return setSel(0);
      if (input === "G") return setSel(Math.max(0, visible.length - 1));
      if (input === "/") return setFilterEditing(true);
      if (input === "o") return setOfflineExpanded((v) => !v);
      if (input === "<" || input === ">") {
        const delta = input === ">" ? 1 : -1;
        const next = (sortIdx + delta + ROSTER_SORTS.length) % ROSTER_SORTS.length;
        setSortIdx(next);
        setToast({ text: `sort: ${ROSTER_SORTS[next]}`, kind: "ok" });
        return;
      }
      if (input === "y") return openCopyMenu();
      if (input === "i" || key.rightArrow) return setFocusedPane("inbox");
      if (key.return) {
        if (!selected) return setToast({ text: "no peer selected", kind: "err" });
        if (selected.you) return setToast({ text: "that's you — the broker refuses self-sends", kind: "err" });
        return openCompose(selected.alias);
      }
      if (key.escape) {
        if (filter) return setFilter("");
        return setModal({ t: "quit" });
      }
      return;
    }

    // -- the read-only fabric views --
    if (view === "projects" || view === "orphans" || view === "log") {
      const [len, setSelFn] =
        view === "projects"
          ? ([snapshot.projects.length, setProjSel] as const)
          : view === "orphans"
            ? ([snapshot.orphans.length, setOrphSel] as const)
            : ([logSorted.length, setLogSel] as const);
      if (key.upArrow || input === "k") return setSelFn((s) => Math.max(0, Math.min(s, len - 1) - 1));
      if (key.downArrow || input === "j") return setSelFn((s) => Math.min(len - 1, s + 1));
      if (key.pageUp) return setSelFn((s) => Math.max(0, s - 10));
      if (key.pageDown) return setSelFn((s) => Math.min(len - 1, s + 10));
      if (input === "g") return setSelFn(0);
      if (input === "G") return setSelFn(Math.max(0, len - 1));
      if (input === "o" && view === "log") {
        setLogOperator((v) => !v);
        return setToast({ text: logOperator ? "bodies: party-scoped" : "bodies: OPERATOR — everything on this machine", kind: "ok" });
      }
      if (input === "/" && view === "log") return setLogQueryEditing(true);
      if (input === "y") {
        if (view === "projects" && snapshot.projects[projClamped])
          return setModal({ t: "copy", fields: copyFieldsForProject(snapshot.projects[projClamped]!), sel: 0 });
        if (view === "orphans" && snapshot.orphans[orphClamped])
          return setModal({ t: "copy", fields: copyFieldsForOrphan(snapshot.orphans[orphClamped]!), sel: 0 });
        if (view === "log" && logSorted[logClamped])
          return setModal({ t: "copy", fields: copyFieldsForMessage(logSorted[logClamped]!, identity?.alias), sel: 0 });
        return setToast({ text: "nothing selected", kind: "err" });
      }
      if (key.escape) return setModal({ t: "quit" });
      return;
    }
    if (key.escape) return setModal({ t: "quit" });
  }

  useInput(
    (input, key) => {
      // Key-repeat and fast typing coalesce into ONE event whose `input` is the
      // whole run ("jjjj", "\t\t") with no flags set — replay it per character
      // or held keys go dead (the parser only flags single keypresses).
      if (input.length > 1 && !key.return && !key.escape && !key.tab) {
        for (const ch of input) dispatchOne(ch, NO_FLAGS);
        return;
      }
      dispatchOne(input, key);
    },
    { isActive: !filterEditing && !logQueryEditing && modal?.t !== "reply" && modal?.t !== "decline" },
  );

  const refreshedAgo = snapshot.at ? Math.max(0, nowS - snapshot.at) : null;

  // Where the keyboard cursor sits in the focused list — the long-list
  // orientation cue (a ScrollBox draws no scrollbar of its own).
  const [posAt, posTotal] =
    view === "peers" && !inboxFocused
      ? [selClamped + 1, visible.length]
      : inboxFocused
        ? [inboxSelClamped + 1, inbox.length]
        : view === "projects"
          ? [projClamped + 1, snapshot.projects.length]
          : view === "orphans"
            ? [orphClamped + 1, snapshot.orphans.length]
            : [logClamped + 1, logSorted.length];

  // While $EDITOR owns the terminal, unmounting AlternateScreen is what exits
  // the alt screen and drains raw mode — the framework's own components do the
  // terminal-state bookkeeping; remounting repaints the whole dashboard.
  if (editorBusy) {
    return <Text dim>editing in $EDITOR — the dashboard returns when it exits…</Text>;
  }

  return (
    <AlternateScreen mouseTracking>
      <Box flexDirection="column" height="100%">
        <Box paddingX={1} gap={2}>
          <Text bold>claude-ipc</Text>
          <Box gap={1}>
            {VIEWS.map((v, i) => (
              <Box key={v} onClick={() => setView(v)}>
                {v === view ? (
                  <Text bold color={theme.accent}>{`${i + 1}:${v.toUpperCase()}`}</Text>
                ) : (
                  <Text dim>{`${i + 1}:${v.toUpperCase()}`}</Text>
                )}
              </Box>
            ))}
          </Box>
          {/* mode tokens: the two states that are otherwise invisible from the frame */}
          {paused && (
            <Text bold color={theme.warn}>
              paused
            </Text>
          )}
          {logOperator && (
            <Text bold color={theme.err}>
              operator-bodies
            </Text>
          )}
          <Spacer />
          <Text dim>
            {identity ? (identity.mode === "acting-as" ? `acting as ${identity.alias}` : identity.alias) : "read-only"}
          </Text>
          <Text dim>
            {paused ? "paused" : refreshedAgo === null ? "…" : `every ${CADENCES[refreshIdx]! / 1000}s · ${refreshedAgo}s`}
          </Text>
        </Box>

        {!snapshot.brokerUp && snapshot.at > 0 && (
          <Box paddingX={1}>
            <Text color={theme.err} bold>
              ⚠ broker down
            </Text>
            <Text dim> — press </Text>
            <Text bold color={theme.accent}>
              d
            </Text>
            <Text dim> to start the daemon</Text>
          </Box>
        )}

        {modal ? (
          modal.t === "quit" ? (
            <QuitGuard />
          ) : modal.t === "help" ? (
            <Help />
          ) : modal.t === "overview" ? (
            <Overview data={fabricOverview(snapshot, identity?.alias)} />
          ) : modal.t === "copy" ? (
            <CopyMenu fields={modal.fields} sel={modal.sel} onPick={(i) => void copyField(modal.fields, i)} />
          ) : modal.t === "reply" || modal.t === "decline" ? (
            <AskInput
              mode={modal.t}
              msg={modal.msg}
              value={modal.value}
              onChange={(v) => setModal((m) => (m && (m.t === "reply" || m.t === "decline") ? { ...m, value: v } : m))}
              onSubmit={() => void submitAskModal(modal)}
              onCancel={() => setModal(null)}
            />
          ) : modal.t === "compose" ? (
            <ComposePanel
              c={modal}
              onBodyChange={(e: EditState) => patchCompose({ body: e })}
              onBodyDone={() => bodyDone(modal)}
              onBodyCancel={() => composeBack(modal)}
              onBodyEditor={() => void bodyEditor(modal)}
              onPickRecipient={(i) => patchCompose({ toSel: i, to: modal.recipients[i]!.value, step: "kind" })}
            />
          ) : (
            <IdentityPicker candidates={modal.candidates} sel={modal.sel} />
          )
        ) : view === "peers" ? (
          <HomeView
            rows={visible}
            offlineHidden={offlineHidden}
            sel={selClamped}
            nowS={nowS}
            preview={preview}
            filter={filter}
            filterEditing={filterEditing}
            onFilterChange={setFilter}
            onFilterSubmit={() => setFilterEditing(false)}
            onFilterCancel={() => {
              setFilter("");
              setFilterEditing(false);
            }}
            onSelect={setSel}
            onExpandOffline={() => setOfflineExpanded(true)}
            scrollRef={scrollRef}
            inbox={inbox}
            inboxSel={inboxSelClamped}
            focusedPane={focusedPane}
            identityKnown={identity !== null}
            seen={seen}
            owedOnly={owedOnly}
            thread={threadFor}
            onInboxSelect={(i) => {
              setFocusedPane("inbox");
              setInboxSel(i);
            }}
            onFocusPane={setFocusedPane}
            inboxScrollRef={inboxScrollRef}
          />
        ) : view === "inbox" ? (
          <Box flexGrow={1} gap={1}>
            <Box flexDirection="column" width="55%" flexShrink={0}>
              <InboxList
                messages={inbox}
                sel={inboxSelClamped}
                nowS={nowS}
                focused
                identityKnown={identity !== null}
                seen={seen}
                owedOnly={owedOnly}
                onSelect={setInboxSel}
                onFocus={() => {}}
                scrollRef={inboxScrollRef}
              />
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
              <MessagePane msg={selectedMsg} nowS={nowS} thread={threadFor} />
            </Box>
          </Box>
        ) : view === "projects" ? (
          <ProjectsView
            projects={snapshot.projects}
            sel={projClamped}
            nowS={nowS}
            peeked={snapshot.projects[projClamped] ? peekFor(`proj:${snapshot.projects[projClamped]!.path}`) : []}
            onSelect={setProjSel}
          />
        ) : view === "orphans" ? (
          <OrphansView
            orphans={snapshot.orphans}
            sel={orphClamped}
            nowS={nowS}
            peeked={snapshot.orphans[orphClamped] ? peekFor(`orph:${snapshot.orphans[orphClamped]!.alias}`) : []}
            onSelect={setOrphSel}
          />
        ) : (
          <LogView
            history={logSorted}
            sel={logClamped}
            nowS={nowS}
            operator={logOperator}
            deliveries={logDeliv && logDeliv.msgId === logSorted[logClamped]?.id ? logDeliv.rows : null}
            query={logQuery}
            queryEditing={logQueryEditing}
            onQueryChange={setLogQuery}
            onQuerySubmit={() => setLogQueryEditing(false)}
            onQueryCancel={() => {
              setLogQuery("");
              setLogQueryEditing(false);
            }}
            onSelect={setLogSel}
          />
        )}

        <Box paddingX={1} gap={1}>
          {/* help+quit are pinned right so narrow terminals truncate hints, never the exits */}
          {!modal && posTotal > 0 && <Text dim>{`[${posAt}/${posTotal}]`}</Text>}
          {modal ? (
            <Text dim> </Text>
          ) : (
            <KeyHints
              pairs={
                inboxFocused
                  ? [["↑↓", "move"], ["r", "reply"], ["a", "accept"], ["d", "decline"], ["s", "snooze"], ["f", "owed"], ["m", "seen"], ["y", "copy"], ["esc", "back"]]
                  : view === "peers"
                    ? [["↑↓", "move"], ["enter", "compose"], ["y", "copy"], ["/", "filter"], ["<>", "sort"], ["o", "offline"], ["i/→", "inbox"]]
                    : view === "log"
                      ? [["↑↓", "move"], ["/", "search"], ["o", "operator bodies"], ["y", "copy"], ["tab", "views"]]
                      : [["↑↓", "move"], ["y", "copy"], ["tab", "views"], ["R", "refresh"]]
              }
            />
          )}
          <Spacer />
          {toast ? (
            <Text bold color={toast.kind === "ok" ? theme.ok : theme.err}>
              {toast.text}
            </Text>
          ) : (
            <KeyHints pairs={[["?", "help"], ["q", "quit"]]} />
          )}
        </Box>
      </Box>
    </AlternateScreen>
  );
}

/** Launch the dashboard and block until the human quits it. */
export async function runDashboard(client: Client): Promise<void> {
  const instance = await render(<App client={client} />);
  await instance.waitUntilExit();
}
