type RpcId = number;
export const DEFER_TO_OTHER_CLIENT = Symbol("defer-to-other-app-server-client");
type RequestHandler = (method: string, params: unknown) => Promise<unknown | typeof DEFER_TO_OTHER_CLIENT>;

export class AppServerWebSocketRpc {
  private nextId = 1;
  private pending = new Map<
    RpcId,
    { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }
  >();

  private constructor(
    private socket: WebSocket,
    private onRequest: RequestHandler,
    private onNotification: (method: string, params: unknown) => void,
    private requestTimeoutMs: number,
    private onClose: () => void,
  ) {
    socket.addEventListener("message", (event) => void this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      const error = new Error("Codex App Server WebSocket closed");
      for (const waiter of this.pending.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
      this.onClose();
    });
  }

  static connect(
    url: string,
    onRequest: RequestHandler,
    onNotification: (method: string, params: unknown) => void = () => {},
    requestTimeoutMs = 15_000,
    onClose: () => void = () => {},
  ): Promise<AppServerWebSocketRpc> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new AppServerWebSocketRpc(socket, onRequest, onNotification, requestTimeoutMs, onClose)), {
        once: true,
      });
      socket.addEventListener("error", () => reject(new Error(`could not connect to Codex App Server at ${url}`)), {
        once: true,
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "claude-ipc-codex-host", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  stop(): void {
    this.socket.close();
  }

  private async receive(raw: string): Promise<void> {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (waiter.timer) clearTimeout(waiter.timer);
      const error = message.error as { code: number; message: string } | undefined;
      if (error) waiter.reject(new Error(`${error.code}: ${error.message}`));
      else waiter.resolve(message.result);
      return;
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      try {
        const result = await this.onRequest(message.method, message.params);
        if (result === DEFER_TO_OTHER_CLIENT) return;
        this.socket.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        this.socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        );
      }
      return;
    }
    if (typeof message.method === "string") this.onNotification(message.method, message.params);
  }
}
