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
import type { Message } from "../models.ts";
import { acceptMsg, declineMsg, replyTo, snoozeMsg } from "./actions.ts";
import { copyToClipboard } from "./clipboard.ts";
import { EMPTY_SNAPSHOT, fetchFabric, type FabricSnapshot } from "./data.ts";
import { actingCandidates, sessionIdentity, type Identity } from "./identity.ts";
import {
  actionsFor,
  copyFieldsForMessage,
  copyFieldsForPeer,
  filterRoster,
  groupRoster,
  lastMessageFor,
  lastOpenAskFrom,
  peerPreview,
  pendingStats,
  type CopyField,
  type RosterRow,
} from "./model.ts";
import { AskInput, CopyMenu, Help, IdentityPicker, QuitGuard } from "./modals.tsx";
import { theme } from "./theme.ts";
import { InboxList, MessagePane } from "./views/inbox.tsx";
import { HomeView, type Pane } from "./views/peers.tsx";

const VIEWS = ["peers", "inbox", "projects", "orphans", "log"] as const;
type View = (typeof VIEWS)[number];

type Modal =
  | { t: "quit" }
  | { t: "help" }
  | { t: "copy"; fields: CopyField[]; sel: number }
  | { t: "identity"; candidates: string[]; sel: number }
  | { t: "reply"; msg: Message; value: string }
  | { t: "decline"; msg: Message; value: string }
  | null;

interface Toast {
  text: string;
  kind: "ok" | "err";
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

/** Where each not-yet-built view lives meanwhile — honesty beats a blank pane. */
const PLACEHOLDER: Record<"projects" | "orphans" | "log", [phase: string, cli: string]> = {
  projects: ["phase 4", "claude-ipc projects"],
  orphans: ["phase 4", "claude-ipc orphans"],
  log: ["phase 4", "claude-ipc log"],
};

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

  const inFlight = useRef(false);
  type ScrollHandle = { scrollTo(y: number): void; getScrollTop(): number; getViewportHeight(): number };
  const scrollRef = useRef<ScrollHandle>(null);
  const inboxScrollRef = useRef<ScrollHandle>(null);

  async function refresh(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setSnapshot(await fetchFabric(client, identity?.alias));
    } finally {
      inFlight.current = false;
    }
  }

  useEffect(() => {
    void refresh();
    // identity changes what "my inbox" means — refetch under the new name
  }, [identity?.alias]);
  useInterval(() => void refresh(), 5000);
  useInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1000);

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
  const grouped = groupRoster(snapshot.peers, identity?.alias);
  const matched = filterRoster(grouped, filter);
  const visible = filter || offlineExpanded ? matched : matched.filter((r) => r.status !== "offline" || r.you);
  const offlineHidden = matched.length - visible.length;
  const selClamped = Math.min(sel, Math.max(0, visible.length - 1));
  const selected: RosterRow | undefined = visible[selClamped];

  const sessionCounts = (row: RosterRow) => {
    const aliases = [row.alias, ...row.also];
    const boxes = aliases.map((a) => snapshot.peerInboxes.get(a)).filter((b): b is Message[] => Array.isArray(b));
    if (boxes.length === 0) return null;
    return pendingStats(boxes.flat());
  };

  const preview = selected
    ? peerPreview(
        selected,
        nowS,
        sessionCounts(selected),
        lastMessageFor(snapshot.history, [selected.alias, ...selected.also]),
      )
    : null;

  const inbox = [...snapshot.myInbox].sort((a, b) => b.ts - a.ts);
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
      if (modal.t === "quit") {
        if (input === "y" || key.return) exit();
        else if (input === "n" || key.escape || input === "q") setModal(null);
        return;
      }
      if (modal.t === "help") {
        if (key.escape || input === "?" || input === "q") setModal(null);
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
    if (input === "q") return setModal({ t: "quit" });
    if (input === "@") return openIdentityPicker();
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
      if (input === "y") return openCopyMenu();
      if (input === "i" || key.rightArrow) return setFocusedPane("inbox");
      if (key.return) return setToast({ text: "compose arrives in phase 3", kind: "err" });
      if (key.escape) {
        if (filter) return setFilter("");
        return setModal({ t: "quit" });
      }
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
    { isActive: !filterEditing && modal?.t !== "reply" && modal?.t !== "decline" },
  );

  const refreshedAgo = snapshot.at ? Math.max(0, nowS - snapshot.at) : null;

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
          <Spacer />
          <Text dim>
            {identity ? (identity.mode === "acting-as" ? `acting as ${identity.alias}` : identity.alias) : "read-only"}
          </Text>
          <Text dim>{refreshedAgo === null ? "…" : `↻ ${refreshedAgo}s`}</Text>
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
            <Box flexDirection="column" width="55%">
              <InboxList
                messages={inbox}
                sel={inboxSelClamped}
                nowS={nowS}
                focused
                identityKnown={identity !== null}
                onSelect={setInboxSel}
                onFocus={() => {}}
                scrollRef={inboxScrollRef}
              />
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
              <MessagePane msg={selectedMsg} nowS={nowS} thread={threadFor} />
            </Box>
          </Box>
        ) : (
          <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
            <Text dim>{`${view.toUpperCase()} arrives in ${PLACEHOLDER[view][0]}`}</Text>
            <Text dim>{`meanwhile: ${PLACEHOLDER[view][1]}`}</Text>
          </Box>
        )}

        <Box paddingX={1}>
          <Text dim wrap="truncate-end">
            {modal
              ? " "
              : inboxFocused
                ? "↑↓ move · r reply · a accept · d decline · s snooze · y copy · esc back · q quit"
                : view === "peers"
                  ? "↑↓ move · y copy · / filter · o offline · i/→ inbox · tab views · ? help · q quit"
                  : "tab views · R refresh · ? help · q quit"}
          </Text>
          <Spacer />
          {toast && (
            <Text bold color={toast.kind === "ok" ? theme.ok : theme.err}>
              {toast.text}
            </Text>
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
