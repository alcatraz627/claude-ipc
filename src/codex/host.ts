import type { Message } from "../models.ts";
import { TRUST_RAIL } from "../hooks/shared.ts";

export interface DeliveryClient {
  heartbeat(alias: string): Promise<unknown>;
  lease(alias: string, leaseId: string, leaseS?: number): Promise<{ messages: Message[] }>;
  ackDelivery(alias: string, leaseId: string, msgIds: string[]): Promise<{ acknowledged: number }>;
  leaseProject(project: string, asAlias: string, leaseId: string, leaseS?: number): Promise<{ messages: Message[] }>;
  ackProject(project: string, asAlias: string, leaseId: string, msgIds: string[]): Promise<{ acknowledged: number }>;
}

export interface ThreadRpc {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexHostOptions {
  alias: string;
  threadId: string;
  cwd: string;
  leaseS?: number;
  persistenceTimeoutMs?: number;
  ensureRegistered?: () => Promise<void>;
  stillOwnsThread?: (threadId: string) => boolean;
  historyKnownEmpty?: boolean;
}

/**
 * The only claude-ipc consumer for one Codex thread. It leases first, asks App
 * Server to persist the messages as tool output, then acknowledges the lease.
 */
export class CodexIpcHost {
  private historyLoaded = false;
  private persistedIds = new Set<string>();

  constructor(
    private broker: DeliveryClient,
    private appServer: ThreadRpc,
    private options: CodexHostOptions,
  ) {
    this.historyLoaded = options.historyKnownEmpty ?? false;
  }

  async attach(): Promise<void> {
    await this.appServer.request("thread/resume", { threadId: this.options.threadId, excludeTurns: true });
  }

  switchThread(threadId: string, historyKnownEmpty = false): void {
    this.options.threadId = threadId;
    this.historyLoaded = historyKnownEmpty;
    this.persistedIds.clear();
  }

  async pumpOnce(): Promise<number> {
    const threadId = this.options.threadId;
    try {
      await this.broker.heartbeat(this.options.alias);
    } catch (error) {
      if (!this.options.ensureRegistered || !(error instanceof Error) || !error.message.startsWith("not_registered")) throw error;
      await this.options.ensureRegistered();
      await this.broker.heartbeat(this.options.alias);
    }
    const state = await this.appServer.request("thread/read", {
      threadId,
      includeTurns: false,
    }) as { thread?: { status?: { type?: string } } };
    if (state.thread?.status?.type === "active") return 0;
    this.requireCurrentThread(threadId);
    const leaseId = crypto.randomUUID();
    const leaseS = this.options.leaseS ?? 30;
    const [personal, project] = await Promise.all([
      this.broker.lease(this.options.alias, leaseId, leaseS),
      this.broker.leaseProject(this.options.cwd, this.options.alias, leaseId, leaseS),
    ]);
    const messages = [...new Map([...personal.messages, ...project.messages].map((message) => [message.id, message])).values()];
    if (messages.length === 0) return 0;
    this.requireCurrentThread(threadId);

    const persistenceTimeoutMs = this.options.persistenceTimeoutMs ?? Math.max(1000, (leaseS - 5) * 1000);
    const persistenceDeadline = Date.now() + persistenceTimeoutMs;

    // A connection can disappear after App Server persisted a turn but before
    // the host received its response. Read the durable thread first so a retry
    // acknowledges that turn instead of appending the same IPC mail twice.
    if (!this.historyLoaded) await this.refreshPersistedMessageIds(this.remainingMs(persistenceDeadline));
    const missing = messages.filter((message) => !this.persistedIds.has(message.id));

    if (missing.length > 0) {
      try {
        const asksSomething = missing.some((message) => message.kind === "query" || message.kind === "request");
        const started = await this.appServer.request("turn/start", {
          threadId,
          input: [],
          toolOutput: {
            namespace: "claude-ipc",
            name: "receive",
            output: JSON.stringify({
              messages: missing,
              ...(asksSomething ? { trustBoundary: TRUST_RAIL } : {}),
            }),
          },
          turnTrigger: "claude-ipc",
          clientUserMessageId: `claude-ipc:${missing.map((m) => m.id).join(",")}`,
        }, this.remainingMs(persistenceDeadline)) as { turn?: { id?: string } };
        const turnId = started.turn?.id;
        if (!turnId) throw new Error("Codex App Server started IPC delivery without returning a turn id");
        await this.waitUntilPersisted(missing.map((message) => message.id), turnId, persistenceDeadline);
      } catch (error) {
        // The request may have landed even when its response did not. Force the
        // next lease pass to reconcile against durable history before retrying.
        this.historyLoaded = false;
        this.persistedIds.clear();
        throw error;
      }
    }
    this.requireCurrentThread(threadId);

    const [personalAck, projectAck] = await Promise.all([
      this.broker.ackDelivery(this.options.alias, leaseId, personal.messages.map((message) => message.id)),
      this.broker.ackProject(this.options.cwd, this.options.alias, leaseId, project.messages.map((message) => message.id)),
    ]);
    const acknowledged = personalAck.acknowledged + projectAck.acknowledged;
    const expected = personal.messages.length + project.messages.length;
    if (acknowledged !== expected) {
      throw new Error(`delivery ack mismatch: expected ${expected}, got ${acknowledged}`);
    }
    return messages.length;
  }

  private async refreshPersistedMessageIds(timeoutMs?: number): Promise<{ turns: { id?: string; status?: string }[] }> {
    const turns: { id?: string; status?: string; items?: unknown[] }[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.appServer.request("thread/turns/list", {
        threadId: this.options.threadId,
        itemsView: "full",
        limit: 100,
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      }, timeoutMs) as {
        data?: { id?: string; status?: string; items?: unknown[] }[];
        nextCursor?: string | null;
      };
      turns.push(...(response.data ?? []));
      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    for (const turn of turns) {
      for (const raw of turn.items ?? []) {
        const item = raw as { type?: string; namespace?: string; name?: string; output?: unknown };
        if (item.type !== "functionCallOutput" || item.namespace !== "claude-ipc" || item.name !== "receive") continue;
        try {
          const value = typeof item.output === "string" ? JSON.parse(item.output) : item.output;
          const messages = (value as { messages?: { id?: unknown }[] } | null)?.messages;
          for (const message of messages ?? []) if (typeof message.id === "string") this.persistedIds.add(message.id);
        } catch {
          // An older or unrelated output is not evidence that this lease landed.
        }
      }
    }
    this.historyLoaded = true;
    return { turns };
  }

  private async waitUntilPersisted(messageIds: string[], turnId: string, deadline: number): Promise<void> {
    for (;;) {
      const { turns } = await this.refreshPersistedMessageIds(this.remainingMs(deadline));
      if (messageIds.every((id) => this.persistedIds.has(id))) return;
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (turn && ["completed", "failed", "interrupted", "cancelled"].includes(turn.status ?? "")) {
        throw new Error(`Codex App Server turn ${turnId} ended as ${turn.status} before IPC mail persisted`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Codex App Server did not persist IPC mail in turn ${turnId} before the delivery deadline`);
      }
      await Bun.sleep(25);
    }
  }

  private remainingMs(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Codex App Server delivery deadline expired");
    return remaining;
  }

  private requireCurrentThread(threadId: string): void {
    if (this.options.stillOwnsThread && !this.options.stillOwnsThread(threadId)) {
      this.historyLoaded = false;
      this.persistedIds.clear();
      throw new Error(`Codex TUI left thread ${threadId} during IPC delivery`);
    }
  }
}
